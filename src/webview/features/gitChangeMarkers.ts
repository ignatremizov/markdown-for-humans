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
  oldStart?: number;
  oldLineCount?: number;
  newStart?: number;
  newLineCount?: number;
  oldLines?: string[];
  newLines?: string[];
  deletedAnchorBeforeLine?: string | null;
  deletedAnchorAfterLine?: string | null;
}

interface RenderGitChangeMarkersOptions {
  lineCount: number;
  sourceMarkdown?: string;
  changes: GitChangeRange[];
  activeChangeIndex?: number | null;
  onMarkerClick?: (change: GitChangeRange, index: number) => void;
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
const HUNK_DIFF_WIDGET_CLASS = 'git-hunk-diff-widget';
const HUNK_SCROLL_MIN_DURATION_MS = 110;
const HUNK_SCROLL_MAX_DURATION_MS = 360;
const HUNK_SCROLL_CENTER_PADDING_PX = 24;

function isGitChangeType(value: unknown): value is GitChangeType {
  return value === 'added' || value === 'modified' || value === 'deleted';
}

function isFinitePositiveLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value.filter((line): line is string => typeof line === 'string');
  return lines.length === value.length ? lines : undefined;
}

function optionalAnchorLine(value: unknown): string | null | undefined {
  if (typeof value === 'string' || value === null) return value;
  return undefined;
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
    const oldStart = optionalNonNegativeInteger(candidate.oldStart);
    const oldLineCount = optionalNonNegativeInteger(candidate.oldLineCount);
    const newStart = optionalNonNegativeInteger(candidate.newStart);
    const newLineCount = optionalNonNegativeInteger(candidate.newLineCount);
    const oldLines = optionalStringArray(candidate.oldLines);
    const newLines = optionalStringArray(candidate.newLines);
    const deletedAnchorBeforeLine = optionalAnchorLine(candidate.deletedAnchorBeforeLine);
    const deletedAnchorAfterLine = optionalAnchorLine(candidate.deletedAnchorAfterLine);

    ranges.push({
      type: candidate.type,
      startLine,
      endLine,
      ...(deletedLines ? { deletedLines } : {}),
      ...(oldStart !== undefined ? { oldStart } : {}),
      ...(oldLineCount !== undefined ? { oldLineCount } : {}),
      ...(newStart !== undefined ? { newStart } : {}),
      ...(newLineCount !== undefined ? { newLineCount } : {}),
      ...(oldLines ? { oldLines } : {}),
      ...(newLines ? { newLines } : {}),
      ...(deletedAnchorBeforeLine !== undefined ? { deletedAnchorBeforeLine } : {}),
      ...(deletedAnchorAfterLine !== undefined ? { deletedAnchorAfterLine } : {}),
    });
  }

  return ranges;
}

export function clearGitChangeMarkers(root: HTMLElement): void {
  root.querySelector(`.${GUTTER_CLASS}`)?.remove();
  root.querySelector(`.${OVERVIEW_CLASS}`)?.remove();
  root.classList.remove('git-change-marker-host');
}

export function clearGitHunkDiffWidget(root: HTMLElement | null): void {
  if (!root) return;
  root.querySelector(`.${HUNK_DIFF_WIDGET_CLASS}`)?.remove();
  root.querySelectorAll('.git-change-gutter-marker.git-change-active').forEach(marker => {
    marker.classList.remove('git-change-active');
  });
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

function optionalLineCount(value: number | undefined, fallback: string[] | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback?.length ?? 0;
}

function visualMarkerRanges(range: GitChangeRange): GitChangeRange[] {
  if (range.type !== 'modified') return [range];

  const oldLineCount = optionalLineCount(range.oldLineCount, range.oldLines);
  const newLineCount = optionalLineCount(range.newLineCount, range.newLines);
  const modifiedLineCount = Math.min(oldLineCount, newLineCount);
  if (modifiedLineCount <= 0 || newLineCount <= modifiedLineCount) return [range];

  const modifiedEndLine = Math.min(range.endLine, range.startLine + modifiedLineCount - 1);
  const addedStartLine = modifiedEndLine + 1;
  const addedEndLine = Math.min(range.endLine, range.startLine + newLineCount - 1);
  if (addedStartLine > addedEndLine) return [range];

  return [
    {
      ...range,
      startLine: range.startLine,
      endLine: modifiedEndLine,
    },
    {
      ...range,
      type: 'added',
      startLine: addedStartLine,
      endLine: addedEndLine,
      deletedLines: undefined,
    },
  ];
}

function createMarker(
  displayRange: GitChangeRange,
  sourceRange: GitChangeRange,
  geometry: MarkerGeometry,
  variant: 'gutter' | 'overview',
  index: number,
  activeChangeIndex?: number | null,
  onMarkerClick?: (change: GitChangeRange, index: number) => void
) {
  const marker =
    variant === 'gutter' ? document.createElement('button') : document.createElement('div');

  marker.className = [
    variant === 'gutter' ? 'git-change-gutter-marker' : 'git-change-overview-marker',
    `git-change-${displayRange.type}`,
    activeChangeIndex === index && variant === 'gutter' ? 'git-change-active' : '',
  ].join(' ');
  marker.style.top = `${geometry.topPercent}%`;
  marker.style.height = `${geometry.heightPercent}%`;
  marker.dataset.startLine = String(geometry.startLine);
  marker.dataset.endLine = String(geometry.endLine);
  marker.dataset.changeIndex = String(index);

  if (displayRange.deletedLines) {
    marker.dataset.deletedLines = String(displayRange.deletedLines);
  }

  if (variant === 'gutter') {
    const button = marker as HTMLButtonElement;
    button.type = 'button';
    marker.title = `Show ${displayRange.type} change`;
    marker.setAttribute(
      'aria-label',
      `Show ${displayRange.type} change at line ${geometry.startLine}`
    );
    marker.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onMarkerClick?.(sourceRange, index);
    });
  } else {
    marker.setAttribute('aria-hidden', 'true');
  }

  return marker;
}

function createDiffActionButton(
  action: string,
  label: string,
  title: string,
  onClick?: () => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'git-hunk-diff-action';
  button.dataset.action = action;
  button.title = title;
  button.textContent = label;
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.();
  });
  return button;
}

interface InlineDiffPart {
  text: string;
  changed: boolean;
}

const MAX_INLINE_DIFF_TOKENS = 400;

function tokenizeInlineDiffText(text: string): string[] {
  return text.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];
}

function compactInlineDiffParts(tokens: string[], changedTokens: boolean[]): InlineDiffPart[] {
  const parts: InlineDiffPart[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const changed = changedTokens[index] ?? false;
    const previous = parts[parts.length - 1];
    if (previous && previous.changed === changed) {
      previous.text += tokens[index];
    } else {
      parts.push({ text: tokens[index], changed });
    }
  }

  return parts;
}

function expandChangedSeparators(tokens: string[], changedTokens: boolean[]): boolean[] {
  const expanded = [...changedTokens];

  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^[\s,.;:!?()[\]{}'"`-]+$/.test(tokens[index])) continue;
    if (changedTokens[index]) continue;

    let previousIndex = index - 1;
    while (previousIndex >= 0 && /^[\s,.;:!?()[\]{}'"`-]+$/.test(tokens[previousIndex])) {
      previousIndex -= 1;
    }

    let nextIndex = index + 1;
    while (nextIndex < tokens.length && /^[\s,.;:!?()[\]{}'"`-]+$/.test(tokens[nextIndex])) {
      nextIndex += 1;
    }

    if (previousIndex >= 0 && nextIndex < tokens.length) {
      expanded[index] = changedTokens[previousIndex] && changedTokens[nextIndex];
    }
  }

  return expanded;
}

function fallbackInlineDiffParts(oldText: string, newText: string) {
  let prefixLength = 0;
  while (
    prefixLength < oldText.length &&
    prefixLength < newText.length &&
    oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength + prefixLength < oldText.length &&
    suffixLength + prefixLength < newText.length &&
    oldText[oldText.length - suffixLength - 1] === newText[newText.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const oldParts = [
    { text: oldText.slice(0, prefixLength), changed: false },
    { text: oldText.slice(prefixLength, oldText.length - suffixLength), changed: true },
    { text: oldText.slice(oldText.length - suffixLength), changed: false },
  ].filter(part => part.text.length > 0);

  const newParts = [
    { text: newText.slice(0, prefixLength), changed: false },
    { text: newText.slice(prefixLength, newText.length - suffixLength), changed: true },
    { text: newText.slice(newText.length - suffixLength), changed: false },
  ].filter(part => part.text.length > 0);

  return { oldParts, newParts };
}

function computeInlineDiffParts(oldText: string, newText: string) {
  if (oldText === newText) {
    return {
      oldParts: oldText.length > 0 ? [{ text: oldText, changed: false }] : [],
      newParts: newText.length > 0 ? [{ text: newText, changed: false }] : [],
    };
  }

  const oldTokens = tokenizeInlineDiffText(oldText);
  const newTokens = tokenizeInlineDiffText(newText);
  if (
    oldTokens.length === 0 ||
    newTokens.length === 0 ||
    oldTokens.length > MAX_INLINE_DIFF_TOKENS ||
    newTokens.length > MAX_INLINE_DIFF_TOKENS
  ) {
    return fallbackInlineDiffParts(oldText, newText);
  }

  const table = Array.from(
    { length: oldTokens.length + 1 },
    () => new Uint16Array(newTokens.length + 1)
  );

  for (let oldIndex = 1; oldIndex <= oldTokens.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newTokens.length; newIndex += 1) {
      table[oldIndex][newIndex] =
        oldTokens[oldIndex - 1] === newTokens[newIndex - 1]
          ? table[oldIndex - 1][newIndex - 1] + 1
          : Math.max(table[oldIndex - 1][newIndex], table[oldIndex][newIndex - 1]);
    }
  }

  const oldChangedTokens = new Array<boolean>(oldTokens.length).fill(false);
  const newChangedTokens = new Array<boolean>(newTokens.length).fill(false);
  let oldIndex = oldTokens.length;
  let newIndex = newTokens.length;

  while (oldIndex > 0 || newIndex > 0) {
    if (oldIndex > 0 && newIndex > 0 && oldTokens[oldIndex - 1] === newTokens[newIndex - 1]) {
      oldIndex -= 1;
      newIndex -= 1;
    } else if (
      newIndex > 0 &&
      (oldIndex === 0 || table[oldIndex][newIndex - 1] >= table[oldIndex - 1][newIndex])
    ) {
      newChangedTokens[newIndex - 1] = true;
      newIndex -= 1;
    } else {
      oldChangedTokens[oldIndex - 1] = true;
      oldIndex -= 1;
    }
  }

  return {
    oldParts: compactInlineDiffParts(
      oldTokens,
      expandChangedSeparators(oldTokens, oldChangedTokens)
    ),
    newParts: compactInlineDiffParts(
      newTokens,
      expandChangedSeparators(newTokens, newChangedTokens)
    ),
  };
}

function computeInlineDiffs(oldLines: string[], newLines: string[]) {
  const oldParts = oldLines.map(line => [{ text: line, changed: false }]);
  const newParts = newLines.map(line => [{ text: line, changed: false }]);
  const sharedLineCount = Math.min(oldLines.length, newLines.length);

  for (let index = 0; index < sharedLineCount; index += 1) {
    const parts = computeInlineDiffParts(oldLines[index], newLines[index]);
    oldParts[index] = parts.oldParts;
    newParts[index] = parts.newParts;
  }

  for (let index = sharedLineCount; index < oldLines.length; index += 1) {
    oldParts[index] = oldLines[index].length > 0 ? [{ text: oldLines[index], changed: true }] : [];
  }
  for (let index = sharedLineCount; index < newLines.length; index += 1) {
    newParts[index] = newLines[index].length > 0 ? [{ text: newLines[index], changed: true }] : [];
  }

  return { oldParts, newParts };
}

function appendDiffLine(
  container: HTMLElement,
  type: 'old' | 'new',
  lineNumber: number | null,
  text: string,
  parts?: InlineDiffPart[]
): void {
  const row = document.createElement('div');
  row.className = `git-hunk-diff-line git-hunk-diff-line-${type}`;

  const number = document.createElement('span');
  number.className = 'git-hunk-diff-line-number';
  number.textContent = lineNumber === null ? '' : String(lineNumber);

  const prefix = document.createElement('span');
  prefix.className = 'git-hunk-diff-line-prefix';
  prefix.textContent = type === 'old' ? '-' : '+';

  const content = document.createElement('span');
  content.className = 'git-hunk-diff-line-content';
  const inlineParts = parts ?? (text.length > 0 ? [{ text, changed: false }] : []);
  if (inlineParts.length === 0) {
    content.textContent = ' ';
  } else {
    for (const part of inlineParts) {
      if (part.changed) {
        const span = document.createElement('span');
        span.className = 'git-hunk-diff-token-changed';
        span.textContent = part.text;
        content.appendChild(span);
      } else {
        content.appendChild(document.createTextNode(part.text));
      }
    }
  }

  row.append(number, prefix, content);
  container.appendChild(row);
}

function appendEmptyDiffLine(container: HTMLElement): void {
  const row = document.createElement('div');
  row.className = 'git-hunk-diff-line git-hunk-diff-line-empty';
  row.textContent = 'No line content in this hunk.';
  container.appendChild(row);
}

export function gitHunkScrollDurationMs(distancePx: number): number {
  const distance = Math.abs(distancePx);
  if (!Number.isFinite(distance) || distance < 1) return 0;
  return Math.min(
    HUNK_SCROLL_MAX_DURATION_MS,
    Math.max(HUNK_SCROLL_MIN_DURATION_MS, 80 + Math.sqrt(distance) * 4)
  );
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function scrollGitHunkWidgetIntoView(widget: HTMLElement): void {
  const rect = widget.getBoundingClientRect();
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 0;
  const currentTop =
    window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  const centeredTop =
    currentTop +
    rect.top -
    Math.max(HUNK_SCROLL_CENTER_PADDING_PX, (viewportHeight - rect.height) / 2);
  const maxTop = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
  const targetTop = Math.max(0, Math.min(maxTop || centeredTop, centeredTop));
  const distance = targetTop - currentTop;
  const duration = gitHunkScrollDurationMs(distance);

  if (duration === 0) return;
  if (prefersReducedMotion() || typeof window.requestAnimationFrame !== 'function') {
    window.scrollTo({ top: targetTop });
    return;
  }

  const startTime = window.performance?.now?.() ?? Date.now();

  const step = (timestamp: number): void => {
    const elapsed = Math.max(0, timestamp - startTime);
    const progress = Math.min(1, elapsed / duration);
    window.scrollTo({ top: currentTop + distance * easeOutCubic(progress) });
    if (progress < 1) {
      window.requestAnimationFrame(step);
    }
  };

  window.requestAnimationFrame(step);
}

export interface GitHunkDiffWidgetActions {
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onRevert?: (change: GitChangeRange, index: number) => void;
  scrollIntoView?: boolean;
}

/**
 * Render a compact hunk diff widget near the selected Git gutter marker.
 */
export function renderGitHunkDiffWidget(
  root: HTMLElement | null,
  changes: GitChangeRange[],
  selectedIndex: number,
  actions: GitHunkDiffWidgetActions = {}
): HTMLElement | null {
  if (!root) return null;

  const normalizedChanges = coerceGitChangeRanges(changes);
  if (selectedIndex < 0 || selectedIndex >= normalizedChanges.length) {
    clearGitHunkDiffWidget(root);
    return null;
  }

  const change = normalizedChanges[selectedIndex];
  clearGitHunkDiffWidget(root);

  const markers = Array.from(
    root.querySelectorAll(`.git-change-gutter-marker[data-change-index="${selectedIndex}"]`)
  ).filter((element): element is HTMLElement => element instanceof HTMLElement);
  const marker = markers[0] ?? null;
  markers.forEach(gutterMarker => {
    gutterMarker.classList.add('git-change-active');
  });

  const widget = document.createElement('section');
  widget.className = HUNK_DIFF_WIDGET_CLASS;
  widget.dataset.changeIndex = String(selectedIndex);
  widget.setAttribute('role', 'region');
  widget.setAttribute('aria-label', `Git ${change.type} change diff`);
  if (marker?.style.top) {
    widget.style.top = marker.style.top;
  }

  const header = document.createElement('div');
  header.className = 'git-hunk-diff-header';

  const title = document.createElement('div');
  title.className = 'git-hunk-diff-title';
  title.textContent = `${change.type} lines ${change.startLine}-${change.endLine}`;

  const toolbar = document.createElement('div');
  toolbar.className = 'git-hunk-diff-toolbar';
  toolbar.append(
    createDiffActionButton('previous', 'Prev', 'Previous change', actions.onPrevious),
    createDiffActionButton('next', 'Next', 'Next change', actions.onNext),
    createDiffActionButton('revert', 'Revert', 'Revert this change', () =>
      actions.onRevert?.(change, selectedIndex)
    ),
    createDiffActionButton('close', 'Close', 'Close change diff', actions.onClose)
  );

  header.append(title, toolbar);

  const body = document.createElement('div');
  body.className = 'git-hunk-diff-body';
  const oldLines = change.oldLines ?? [];
  const newLines = change.newLines ?? [];
  const inlineDiffs = computeInlineDiffs(oldLines, newLines);

  for (let index = 0; index < oldLines.length; index += 1) {
    const lineNumber = typeof change.oldStart === 'number' ? change.oldStart + index : null;
    appendDiffLine(body, 'old', lineNumber, oldLines[index], inlineDiffs.oldParts[index]);
  }

  for (let index = 0; index < newLines.length; index += 1) {
    const lineNumber = typeof change.newStart === 'number' ? change.newStart + index : null;
    appendDiffLine(body, 'new', lineNumber, newLines[index], inlineDiffs.newParts[index]);
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    appendEmptyDiffLine(body);
  }

  widget.append(header, body);
  root.appendChild(widget);
  if (actions.scrollIntoView) {
    scrollGitHunkWidgetIntoView(widget);
  }
  return widget;
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

  const overview = document.createElement('div');
  overview.className = OVERVIEW_CLASS;
  overview.setAttribute('aria-hidden', 'true');

  for (const [index, range] of changes.entries()) {
    for (const displayRange of visualMarkerRanges(range)) {
      const geometry = markerGeometry(root, displayRange, lineCount, options.sourceMarkdown);
      gutter.appendChild(
        createMarker(
          displayRange,
          range,
          geometry,
          'gutter',
          index,
          options.activeChangeIndex,
          options.onMarkerClick
        )
      );
      overview.appendChild(createMarker(displayRange, range, geometry, 'overview', index));
    }
  }

  root.appendChild(gutter);
  root.appendChild(overview);
}
