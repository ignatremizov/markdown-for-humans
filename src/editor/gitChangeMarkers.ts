/**
 * @file gitChangeMarkers.ts - Dirty-diff model for the custom editor.
 * @description Produces compact Git change ranges that the webview can render
 *              as gutter and overview markers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type GitChangeType = 'added' | 'modified' | 'deleted';

export interface GitChangeRange {
  type: GitChangeType;
  /** 1-based line number in the current document. */
  startLine: number;
  /** 1-based line number in the current document. */
  endLine: number;
  /** Original-file line count for deletion-only hunks. */
  deletedLines?: number;
  /** 1-based line number where the hunk starts in HEAD. */
  oldStart?: number;
  /** Number of HEAD lines covered by the hunk. */
  oldLineCount?: number;
  /** 1-based line number where the hunk starts in the working tree. */
  newStart?: number;
  /** Number of working-tree lines covered by the hunk. */
  newLineCount?: number;
  /** HEAD lines for this hunk, excluding unified diff markers. */
  oldLines?: string[];
  /** Working-tree lines for this hunk, excluding unified diff markers. */
  newLines?: string[];
  /** Working-tree line immediately before a deleted hunk insertion point. */
  deletedAnchorBeforeLine?: string | null;
  /** Working-tree line immediately after a deleted hunk insertion point. */
  deletedAnchorAfterLine?: string | null;
}

export type GitFileStatus = 'clean' | 'tracked' | 'untracked';

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function buildGitChangeRange(
  type: GitChangeType,
  oldStart: number,
  oldLineCount: number,
  newStart: number,
  newLineCount: number,
  oldLines: string[],
  newLines: string[]
): GitChangeRange {
  if (type === 'added') {
    return {
      type,
      startLine: newStart,
      endLine: newStart + newLineCount - 1,
      oldStart,
      oldLineCount,
      newStart,
      newLineCount,
      oldLines,
      newLines,
    };
  }

  if (type === 'deleted') {
    const anchorLine = Math.max(1, newStart);
    return {
      type,
      startLine: anchorLine,
      endLine: anchorLine,
      deletedLines: oldLineCount,
      oldStart,
      oldLineCount,
      newStart,
      newLineCount,
      oldLines,
      newLines,
    };
  }

  return {
    type,
    startLine: newStart,
    endLine: newStart + newLineCount - 1,
    oldStart,
    oldLineCount,
    newStart,
    newLineCount,
    oldLines,
    newLines,
  };
}

function parseGitDiffBodyLines(diffLines: string[], startIndex: number) {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let index = startIndex;

  while (index < diffLines.length && !HUNK_HEADER_PATTERN.test(diffLines[index])) {
    const line = diffLines[index];

    if (line.startsWith('\\')) {
      index += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    }

    index += 1;
  }

  return { oldLines, newLines, nextIndex: index };
}

/**
 * Parse a zero-context unified Git diff into current-document hunk ranges.
 *
 * The host requests zero-context unified diffs, so hunk headers contain the
 * range information needed for VS Code-style dirty markers without scanning
 * unchanged source. The hunk body is retained so the webview can show a
 * localized diff and the extension host can apply hunk-level revert actions.
 */
export function parseGitDiffHunks(diffText: string): GitChangeRange[] {
  const changes: GitChangeRange[] = [];
  const diffLines = diffText.split(/\r?\n/);

  for (let index = 0; index < diffLines.length; index += 1) {
    const line = diffLines[index];
    const match = line.match(HUNK_HEADER_PATTERN);
    if (!match) continue;

    const oldStart = Number.parseInt(match[1], 10);
    const oldLineCount = match[2] ? Number.parseInt(match[2], 10) : 1;
    const newStart = Number.parseInt(match[3], 10);
    const newLineCount = match[4] ? Number.parseInt(match[4], 10) : 1;

    if (
      !Number.isFinite(oldStart) ||
      !Number.isFinite(oldLineCount) ||
      !Number.isFinite(newStart) ||
      !Number.isFinite(newLineCount)
    ) {
      continue;
    }

    const { oldLines, newLines, nextIndex } = parseGitDiffBodyLines(diffLines, index + 1);
    index = nextIndex - 1;

    if (oldLineCount === 0 && newLineCount > 0) {
      changes.push(
        buildGitChangeRange(
          'added',
          oldStart,
          oldLineCount,
          newStart,
          newLineCount,
          oldLines,
          newLines
        )
      );
      continue;
    }

    if (newLineCount === 0 && oldLineCount > 0) {
      changes.push(
        buildGitChangeRange(
          'deleted',
          oldStart,
          oldLineCount,
          newStart,
          newLineCount,
          oldLines,
          newLines
        )
      );
      continue;
    }

    if (newLineCount > 0) {
      changes.push(
        buildGitChangeRange(
          'modified',
          oldStart,
          oldLineCount,
          newStart,
          newLineCount,
          oldLines,
          newLines
        )
      );
    }
  }

  return changes;
}

/**
 * Interpret `git status --porcelain -- <file>` output for one file.
 */
export function parseGitStatusPorcelain(statusText: string): GitFileStatus {
  const firstLine = statusText
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .find(line => line.length > 0);

  if (!firstLine) return 'clean';
  if (firstLine.startsWith('??')) return 'untracked';
  return 'tracked';
}

export function isAddedStatus(statusText: string): boolean {
  const firstLine = statusText
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .find(line => line.length > 0);
  if (!firstLine || firstLine.startsWith('??')) return false;
  return firstLine.slice(0, 2).includes('A');
}

/**
 * Build a single added range for an untracked file.
 */
export function buildAllAddedChanges(content: string): GitChangeRange[] {
  if (content.length === 0) return [];
  const withoutFinalNewline = content.replace(/\r?\n$/, '');
  if (withoutFinalNewline.length === 0) return [];
  const lines = withoutFinalNewline.split(/\r?\n/);
  return [
    {
      type: 'added',
      startLine: 1,
      endLine: lines.length,
      oldStart: 0,
      oldLineCount: 0,
      newStart: 1,
      newLineCount: lines.length,
      oldLines: [],
      newLines: lines,
    },
  ];
}

function splitDocumentLines(content: string): {
  lines: string[];
  newline: string;
  hasTrailingNewline: boolean;
} {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = /\r?\n$/.test(content);
  const withoutFinalNewline = content.replace(/\r?\n$/, '');
  return {
    lines: withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/),
    newline,
    hasTrailingNewline,
  };
}

function contentLines(content: string): string[] {
  if (content.length === 0) return [];
  const withoutFinalNewline = content.replace(/\r?\n$/, '');
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/);
}

function deletionInsertIndex(lines: string[], change: GitChangeRange): number {
  const rawInsertIndex =
    typeof change.newStart === 'number' && Number.isFinite(change.newStart)
      ? Math.floor(change.newStart)
      : change.startLine - 1;
  return Math.max(0, Math.min(lines.length, rawInsertIndex));
}

function joinDocumentLines(lines: string[], newline: string, hasTrailingNewline: boolean): string {
  const joined = lines.join(newline);
  if (joined.length === 0) {
    return '';
  }
  return hasTrailingNewline ? `${joined}${newline}` : joined;
}

function lineRangeMatches(
  lines: string[],
  startIndex: number,
  endIndexExclusive: number,
  expectedLines: string[] | undefined
): boolean {
  if (!expectedLines) return true;
  if (expectedLines.length !== endIndexExclusive - startIndex) return false;

  for (let index = 0; index < expectedLines.length; index += 1) {
    if (lines[startIndex + index] !== expectedLines[index]) return false;
  }

  return true;
}

function hasOwnProperty(value: object, key: keyof GitChangeRange): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deletedAnchorsMatch(
  lines: string[],
  insertIndex: number,
  change: GitChangeRange
): boolean {
  const hasBeforeAnchor = hasOwnProperty(change, 'deletedAnchorBeforeLine');
  const hasAfterAnchor = hasOwnProperty(change, 'deletedAnchorAfterLine');
  if (!hasBeforeAnchor && !hasAfterAnchor) return true;

  if (hasBeforeAnchor) {
    if (change.deletedAnchorBeforeLine === null) {
      if (insertIndex !== 0) return false;
    } else if (lines[insertIndex - 1] !== change.deletedAnchorBeforeLine) {
      return false;
    }
  }

  if (hasAfterAnchor) {
    if (change.deletedAnchorAfterLine === null) {
      if (insertIndex !== lines.length) return false;
    } else if (lines[insertIndex] !== change.deletedAnchorAfterLine) {
      return false;
    }
  }

  return true;
}

function attachDeletedHunkAnchors(changes: GitChangeRange[], content: string): GitChangeRange[] {
  const lines = contentLines(content);

  return changes.map(change => {
    if (change.type !== 'deleted') return change;

    const insertIndex = deletionInsertIndex(lines, change);
    return {
      ...change,
      deletedAnchorBeforeLine: insertIndex > 0 ? lines[insertIndex - 1] : null,
      deletedAnchorAfterLine: insertIndex < lines.length ? lines[insertIndex] : null,
    };
  });
}

/**
 * Revert one Git hunk in a markdown document using the hunk lines from HEAD.
 *
 * @param content - Current markdown text from the VS Code document
 * @param change - Hunk range containing the HEAD and working-tree line bodies
 * @returns Markdown content with the hunk reverted
 */
export function revertGitChangeInContent(content: string, change: GitChangeRange): string {
  const oldLines = Array.isArray(change.oldLines) ? change.oldLines : [];
  const newLines = Array.isArray(change.newLines) ? change.newLines : undefined;
  const { lines, newline, hasTrailingNewline } = splitDocumentLines(content);

  if (change.type === 'deleted') {
    const insertIndex = deletionInsertIndex(lines, change);
    if (!deletedAnchorsMatch(lines, insertIndex, change)) {
      return content;
    }

    lines.splice(insertIndex, 0, ...oldLines);
    return joinDocumentLines(lines, newline, hasTrailingNewline);
  }

  const startIndex = Math.max(0, Math.min(lines.length, change.startLine - 1));
  const endIndexExclusive = Math.max(startIndex, Math.min(lines.length, change.endLine));
  if (!lineRangeMatches(lines, startIndex, endIndexExclusive, newLines)) {
    return content;
  }

  lines.splice(startIndex, endIndexExclusive - startIndex, ...oldLines);
  return joinDocumentLines(lines, newline, hasTrailingNewline);
}

/**
 * Find the nearest Git repository root for a file path by walking upward.
 */
export function findGitRoot(startPath: string): string | null {
  let current = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);

  while (true) {
    const dotGit = path.join(current, '.git');
    if (fs.existsSync(dotGit)) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function toGitObjectPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function stdoutFromDiffError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; stdout?: unknown };
  if (candidate.code === 1 && typeof candidate.stdout === 'string') {
    return candidate.stdout;
  }
  return null;
}

function normalizeDiffText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function readHeadBlob(gitRoot: string, gitPath: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['show', `HEAD:${gitPath}`], {
      cwd: gitRoot,
      maxBuffer: 1024 * 1024 * 10,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

async function diffTextAgainstHead(baseText: string, content: string): Promise<string> {
  const normalizedBaseText = normalizeDiffText(baseText);
  const normalizedContent = normalizeDiffText(content);
  if (normalizedBaseText === normalizedContent) return '';

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'md4h-git-markers-'));
  const basePath = path.join(tempDir, 'head.md');
  const contentPath = path.join(tempDir, 'buffer.md');

  try {
    await fs.promises.writeFile(basePath, normalizedBaseText, 'utf8');
    await fs.promises.writeFile(contentPath, normalizedContent, 'utf8');

    try {
      const result = await execFileAsync(
        'git',
        ['diff', '--no-index', '--unified=0', '--no-ext-diff', '--', basePath, contentPath],
        { maxBuffer: 1024 * 1024 * 10 }
      );
      return result.stdout;
    } catch (error) {
      const diffStdout = stdoutFromDiffError(error);
      if (diffStdout !== null) return diffStdout;
      throw error;
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Collect dirty-diff marker ranges for a file-backed Git document.
 *
 * Failures are intentionally converted to an empty marker set. Git markers are
 * helpful chrome, not document-critical state, and should never interrupt
 * editing.
 */
export async function collectGitChangeMarkers(
  filePath: string,
  content: string
): Promise<GitChangeRange[]> {
  try {
    if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) return [];

    const gitRoot = findGitRoot(filePath);
    if (!gitRoot) return [];

    const relativePath = path.relative(gitRoot, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return [];

    const status = await execFileAsync('git', ['status', '--porcelain', '--', relativePath], {
      cwd: gitRoot,
    });
    const fileStatus = parseGitStatusPorcelain(status.stdout);

    if (fileStatus === 'untracked') return buildAllAddedChanges(content);

    const gitPath = toGitObjectPath(relativePath);
    const headBlob = await readHeadBlob(gitRoot, gitPath);
    if (headBlob === null) {
      return fileStatus === 'tracked' || isAddedStatus(status.stdout)
        ? buildAllAddedChanges(content)
        : [];
    }

    const diff = await diffTextAgainstHead(headBlob, content);
    return attachDeletedHunkAnchors(parseGitDiffHunks(diff), content);
  } catch (error) {
    console.warn('[MD4H] Failed to collect Git change markers:', error);
    return [];
  }
}
