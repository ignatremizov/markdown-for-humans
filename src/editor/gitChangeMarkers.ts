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
}

export type GitFileStatus = 'clean' | 'tracked' | 'untracked';

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/**
 * Parse a zero-context unified Git diff into current-document line ranges.
 *
 * The host requests zero-context unified diffs, so hunk headers contain the
 * range information needed for VS Code-style dirty markers without scanning
 * unchanged source. Replacement hunks are marked modified as a single range;
 * pure insertions/deletions become added/deleted markers.
 */
export function parseGitDiffHunks(diffText: string): GitChangeRange[] {
  const changes: GitChangeRange[] = [];

  for (const line of diffText.split(/\r?\n/)) {
    const match = line.match(HUNK_HEADER_PATTERN);
    if (!match) continue;

    const oldStart = Number.parseInt(match[1], 10);
    const oldCount = match[2] ? Number.parseInt(match[2], 10) : 1;
    const newStart = Number.parseInt(match[3], 10);
    const newCount = match[4] ? Number.parseInt(match[4], 10) : 1;

    if (!Number.isFinite(oldStart) || !Number.isFinite(oldCount) || !Number.isFinite(newStart)) {
      continue;
    }

    if (oldCount === 0 && newCount > 0) {
      changes.push({ type: 'added', startLine: newStart, endLine: newStart + newCount - 1 });
      continue;
    }

    if (newCount === 0 && oldCount > 0) {
      const anchorLine = Math.max(1, newStart);
      changes.push({
        type: 'deleted',
        startLine: anchorLine,
        endLine: anchorLine,
        deletedLines: oldCount,
      });
      continue;
    }

    if (newCount > 0) {
      changes.push({
        type: 'modified',
        startLine: newStart,
        endLine: newStart + newCount - 1,
      });
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
  const withoutFinalNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (withoutFinalNewline.length === 0) return [];
  const lineCount = withoutFinalNewline.split(/\r?\n/).length;
  return [{ type: 'added', startLine: 1, endLine: lineCount }];
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
    return parseGitDiffHunks(diff);
  } catch (error) {
    console.warn('[MD4H] Failed to collect Git change markers:', error);
    return [];
  }
}
