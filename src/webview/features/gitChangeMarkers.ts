/**
 * @file gitChangeMarkers.ts - Webview dirty-diff marker rendering.
 * @description Draws VS Code-style Git change markers in the custom editor
 *              gutter and overview rail from compact host-provided source line
 *              ranges.
 */

export type GitChangeType = 'added' | 'modified' | 'deleted';

export interface GitChangeRange {
  type: GitChangeType;
  startLine: number;
  endLine: number;
  deletedLines?: number;
}

interface RenderGitChangeMarkersOptions {
  lineCount: number;
  sourceMarkdown?: string;
  changes: GitChangeRange[];
}

export interface SourceBlockRange {
  startLine: number;
  endLine: number;
}

interface MarkerGeometry {
  startLine: number;
  endLine: number;
  topPercent: number;
  heightPercent: number;
}

const GUTTER_CLASS = 'git-change-gutter';
const OVERVIEW_CLASS = 'git-change-overview';

function isGitChangeType(value: unknown): value is GitChangeType {
  return value === 'added' || value === 'modified' || value === 'deleted';
}

function isFinitePositiveLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

/**
 * Validate and normalize marker payloads received through webview messages.
 */
export function coerceGitChangeRanges(value: unknown): GitChangeRange[] {
  if (!Array.isArray(value)) return [];

  const ranges: GitChangeRange[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (!isGitChangeType(candidate.type)) continue;
    if (!isFinitePositiveLine(candidate.startLine) || !isFinitePositiveLine(candidate.endLine)) {
      continue;
    }

    const startLine = Math.min(candidate.startLine, candidate.endLine);
    const endLine = Math.max(candidate.startLine, candidate.endLine);
    const deletedLines =
      typeof candidate.deletedLines === 'number' &&
      Number.isFinite(candidate.deletedLines) &&
      candidate.deletedLines > 0
        ? Math.floor(candidate.deletedLines)
        : undefined;

    ranges.push({
      type: candidate.type,
      startLine,
      endLine,
      ...(deletedLines ? { deletedLines } : {}),
    });
  }

  return ranges;
}

export function clearGitChangeMarkers(root: HTMLElement): void {
  root.querySelector(`.${GUTTER_CLASS}`)?.remove();
  root.querySelector(`.${OVERVIEW_CLASS}`)?.remove();
  root.classList.remove('git-change-marker-host');
}

function markdownLines(markdown: string): string[] {
  if (markdown.length === 0) return [];
  const normalized = markdown.endsWith('\n') ? markdown.slice(0, -1) : markdown;
  if (normalized.length === 0) return [];
  return normalized.split(/\r?\n/);
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function openingFence(line: string): string | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return match?.[1] ?? null;
}

function closesFence(line: string, fence: string): boolean {
  const marker = fence[0].repeat(fence.length);
  const indent = line.match(/^ */)?.[0].length ?? 0;
  return indent <= 3 && line.trimStart().startsWith(marker);
}

function isFrontmatterDelimiter(line: string): boolean {
  return /^---\s*$/.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^ {0,3}#{1,6}\s+/.test(line);
}

function isThematicBreakLine(line: string): boolean {
  const trimmed = line.trim();
  return /^([-*_])(?:\s*\1){2,}$/.test(trimmed);
}

function isListLine(line: string): boolean {
  return /^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isListContinuationLine(line: string): boolean {
  return /^ {2,}\S/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^ {0,3}>\s?/.test(line);
}

function isTableLine(line: string): boolean {
  return line.includes('|') && !isBlankLine(line);
}

function startsStandaloneBlock(line: string): boolean {
  return (
    Boolean(openingFence(line)) ||
    isHeadingLine(line) ||
    isThematicBreakLine(line) ||
    isListLine(line) ||
    isBlockquoteLine(line) ||
    isTableLine(line)
  );
}

/**
 * Approximate Markdown source blocks so source-line changes can be projected
 * onto rendered ProseMirror block nodes instead of raw line percentages.
 */
export function buildSourceBlockRanges(markdown: string): SourceBlockRange[] {
  const lines = markdownLines(markdown);
  const ranges: SourceBlockRange[] = [];
  let index = 0;

  while (index < lines.length) {
    if (isBlankLine(lines[index])) {
      index += 1;
      continue;
    }

    const start = index;

    if (start === 0 && isFrontmatterDelimiter(lines[index])) {
      index += 1;
      while (index < lines.length && !isFrontmatterDelimiter(lines[index])) {
        index += 1;
      }
      if (index < lines.length) index += 1;
      ranges.push({ startLine: start + 1, endLine: index });
      continue;
    }

    const fence = openingFence(lines[index]);
    if (fence) {
      index += 1;
      while (index < lines.length && !closesFence(lines[index], fence)) {
        index += 1;
      }
      if (index < lines.length) index += 1;
      ranges.push({ startLine: start + 1, endLine: index });
      continue;
    }

    if (isHeadingLine(lines[index]) || isThematicBreakLine(lines[index])) {
      index += 1;
      ranges.push({ startLine: start + 1, endLine: index });
      continue;
    }

    if (isListLine(lines[index])) {
      index += 1;
      while (
        index < lines.length &&
        !isBlankLine(lines[index]) &&
        (isListLine(lines[index]) || isListContinuationLine(lines[index]))
      ) {
        index += 1;
      }
      ranges.push({ startLine: start + 1, endLine: index });
      continue;
    }

    if (isBlockquoteLine(lines[index])) {
      index += 1;
      while (index < lines.length && isBlockquoteLine(lines[index])) {
        index += 1;
      }
      ranges.push({ startLine: start + 1, endLine: index });
      continue;
    }

    if (isTableLine(lines[index])) {
      index += 1;
      while (index < lines.length && isTableLine(lines[index])) {
        index += 1;
      }
      ranges.push({ startLine: start + 1, endLine: index });
      continue;
    }

    index += 1;
    while (
      index < lines.length &&
      !isBlankLine(lines[index]) &&
      !startsStandaloneBlock(lines[index])
    ) {
      index += 1;
    }
    ranges.push({ startLine: start + 1, endLine: index });
  }

  return ranges;
}

function clampLineRange(
  range: GitChangeRange,
  lineCount: number
): Pick<MarkerGeometry, 'startLine' | 'endLine'> {
  const startLine = Math.min(Math.max(1, range.startLine), lineCount);
  const endLine = Math.min(Math.max(startLine, range.endLine), lineCount);
  return { startLine, endLine };
}

function fallbackGeometry(range: GitChangeRange, lineCount: number): MarkerGeometry {
  const { startLine, endLine } = clampLineRange(range, lineCount);
  const lineSpan = range.type === 'deleted' ? 1 : endLine - startLine + 1;

  return {
    startLine,
    endLine,
    topPercent: ((startLine - 1) / lineCount) * 100,
    heightPercent: (lineSpan / lineCount) * 100,
  };
}

function getVerticalBounds(
  element: HTMLElement,
  root: HTMLElement
): { top: number; bottom: number } | null {
  const offsetTop = element.offsetTop;
  const offsetHeight = element.offsetHeight;
  if (
    Number.isFinite(offsetTop) &&
    Number.isFinite(offsetHeight) &&
    (offsetTop !== 0 || offsetHeight !== 0)
  ) {
    return { top: offsetTop, bottom: offsetTop + offsetHeight };
  }

  const rect = element.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) {
    return null;
  }

  const top = rect.top - rootRect.top + root.scrollTop;
  return { top, bottom: top + rect.height };
}

function isRenderedBlankParagraphBlock(element: HTMLElement): boolean {
  if (element.tagName.toLowerCase() !== 'p') return false;
  if ((element.textContent ?? '').trim().length > 0) return false;

  return !element.querySelector('img, video, audio, canvas, iframe, svg, math');
}

function renderedBlockGeometry(
  root: HTMLElement,
  range: GitChangeRange,
  lineCount: number,
  sourceMarkdown?: string
): MarkerGeometry | null {
  if (!sourceMarkdown) return null;

  const sourceBlocks = buildSourceBlockRanges(sourceMarkdown);
  if (sourceBlocks.length === 0) return null;

  const proseMirror = root.querySelector('.ProseMirror') as HTMLElement | null;
  if (!proseMirror) return null;

  const renderedBlocks = Array.from(proseMirror.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !isRenderedBlankParagraphBlock(child)
  );
  if (renderedBlocks.length === 0) return null;

  const { startLine, endLine } = clampLineRange(range, lineCount);
  let firstBlockIndex = sourceBlocks.findIndex(block => block.endLine >= startLine);
  if (firstBlockIndex === -1) firstBlockIndex = sourceBlocks.length - 1;

  let lastBlockIndex = firstBlockIndex;
  while (
    lastBlockIndex + 1 < sourceBlocks.length &&
    sourceBlocks[lastBlockIndex + 1].startLine <= endLine
  ) {
    lastBlockIndex += 1;
  }

  if (firstBlockIndex >= renderedBlocks.length || lastBlockIndex >= renderedBlocks.length) {
    return null;
  }

  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let index = firstBlockIndex; index <= lastBlockIndex; index += 1) {
    const bounds = getVerticalBounds(renderedBlocks[index], root);
    if (!bounds) return null;
    top = Math.min(top, bounds.top);
    bottom = Math.max(bottom, bounds.bottom);
  }

  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top) return null;

  const totalHeight = Math.max(proseMirror.scrollHeight, root.scrollHeight, bottom, 1);
  return {
    startLine,
    endLine,
    topPercent: (top / totalHeight) * 100,
    heightPercent: (Math.max(1, bottom - top) / totalHeight) * 100,
  };
}

function markerGeometry(
  root: HTMLElement,
  range: GitChangeRange,
  lineCount: number,
  sourceMarkdown?: string
): MarkerGeometry {
  return (
    renderedBlockGeometry(root, range, lineCount, sourceMarkdown) ??
    fallbackGeometry(range, lineCount)
  );
}

function createMarker(
  range: GitChangeRange,
  geometry: MarkerGeometry,
  variant: 'gutter' | 'overview'
) {
  const marker = document.createElement('div');

  marker.className = [
    variant === 'gutter' ? 'git-change-gutter-marker' : 'git-change-overview-marker',
    `git-change-${range.type}`,
  ].join(' ');
  marker.style.top = `${geometry.topPercent}%`;
  marker.style.height = `${geometry.heightPercent}%`;
  marker.dataset.startLine = String(geometry.startLine);
  marker.dataset.endLine = String(geometry.endLine);
  marker.setAttribute('aria-hidden', 'true');

  if (range.deletedLines) {
    marker.dataset.deletedLines = String(range.deletedLines);
  }

  return marker;
}

/**
 * Render decorative Git change markers for the current source line ranges.
 */
export function renderGitChangeMarkers(
  root: HTMLElement | null,
  options: RenderGitChangeMarkersOptions
): void {
  if (!root) return;

  const rawLineCount =
    typeof options.lineCount === 'number' && Number.isFinite(options.lineCount)
      ? Math.floor(options.lineCount)
      : 1;
  const lineCount = Math.max(1, rawLineCount);
  const changes = coerceGitChangeRanges(options.changes);

  clearGitChangeMarkers(root);
  if (changes.length === 0) return;

  root.classList.add('git-change-marker-host');

  const gutter = document.createElement('div');
  gutter.className = GUTTER_CLASS;
  gutter.setAttribute('aria-hidden', 'true');

  const overview = document.createElement('div');
  overview.className = OVERVIEW_CLASS;
  overview.setAttribute('aria-hidden', 'true');

  for (const range of changes) {
    const geometry = markerGeometry(root, range, lineCount, options.sourceMarkdown);
    gutter.appendChild(createMarker(range, geometry, 'gutter'));
    overview.appendChild(createMarker(range, geometry, 'overview'));
  }

  root.appendChild(gutter);
  root.appendChild(overview);
}
