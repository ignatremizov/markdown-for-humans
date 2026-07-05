import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAllAddedChanges,
  collectGitChangeMarkers,
  parseGitDiffHunks,
  parseGitStatusPorcelain,
} from '../../editor/gitChangeMarkers';

describe('parseGitDiffHunks', () => {
  it('returns no changes for an empty diff', () => {
    expect(parseGitDiffHunks('')).toEqual([]);
  });

  it('parses added lines from insertion-only hunks', () => {
    const diff = [
      'diff --git a/story.md b/story.md',
      '--- a/story.md',
      '+++ b/story.md',
      '@@ -3,0 +4,2 @@',
      '+new paragraph',
      '+another paragraph',
    ].join('\n');

    expect(parseGitDiffHunks(diff)).toEqual([{ type: 'added', startLine: 4, endLine: 5 }]);
  });

  it('parses modified ranges from replacement hunks', () => {
    const diff = [
      'diff --git a/story.md b/story.md',
      '--- a/story.md',
      '+++ b/story.md',
      '@@ -10,2 +10,3 @@',
      '-old line one',
      '-old line two',
      '+new line one',
      '+new line two',
      '+new line three',
    ].join('\n');

    expect(parseGitDiffHunks(diff)).toEqual([{ type: 'modified', startLine: 10, endLine: 12 }]);
  });

  it('anchors deleted ranges to the nearest surviving new-file line', () => {
    const diff = [
      'diff --git a/story.md b/story.md',
      '--- a/story.md',
      '+++ b/story.md',
      '@@ -12,2 +11,0 @@',
      '-removed one',
      '-removed two',
    ].join('\n');

    expect(parseGitDiffHunks(diff)).toEqual([
      { type: 'deleted', startLine: 11, endLine: 11, deletedLines: 2 },
    ]);
  });

  it('parses multiple hunks in order', () => {
    const diff = [
      'diff --git a/story.md b/story.md',
      '--- a/story.md',
      '+++ b/story.md',
      '@@ -1 +1 @@',
      '-old title',
      '+new title',
      '@@ -8,0 +9 @@',
      '+inserted detail',
      '@@ -20 +20,0 @@',
      '-deleted detail',
    ].join('\n');

    expect(parseGitDiffHunks(diff)).toEqual([
      { type: 'modified', startLine: 1, endLine: 1 },
      { type: 'added', startLine: 9, endLine: 9 },
      { type: 'deleted', startLine: 20, endLine: 20, deletedLines: 1 },
    ]);
  });
});

describe('parseGitStatusPorcelain', () => {
  it('detects untracked files', () => {
    expect(parseGitStatusPorcelain('?? docs/story.md\n')).toBe('untracked');
  });

  it('detects tracked dirty files', () => {
    expect(parseGitStatusPorcelain(' M docs/story.md\n')).toBe('tracked');
  });

  it('detects clean files', () => {
    expect(parseGitStatusPorcelain('')).toBe('clean');
  });
});

describe('buildAllAddedChanges', () => {
  it('marks every non-empty source line as added for untracked files', () => {
    expect(buildAllAddedChanges('one\ntwo\nthree')).toEqual([
      { type: 'added', startLine: 1, endLine: 3 },
    ]);
  });

  it('handles an empty untracked file without producing a marker', () => {
    expect(buildAllAddedChanges('')).toEqual([]);
  });

  it('does not count a single trailing newline as an extra added line', () => {
    expect(buildAllAddedChanges('one\ntwo\n')).toEqual([
      { type: 'added', startLine: 1, endLine: 2 },
    ]);
  });
});

describe('collectGitChangeMarkers', () => {
  const tempDirs: string[] = [];

  function createTempRepo(): string {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'md4h-git-markers-test-'));
    tempDirs.push(repoPath);
    execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'pipe' });
    return repoPath;
  }

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('compares HEAD with the live document buffer instead of the saved file', async () => {
    const repoPath = createTempRepo();
    const filePath = path.join(repoPath, 'story.md');
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n', 'utf8');
    execFileSync('git', ['add', 'story.md'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'pipe' });

    await expect(collectGitChangeMarkers(filePath, 'one\nchanged\nthree\n')).resolves.toEqual([
      { type: 'modified', startLine: 2, endLine: 2 },
    ]);
  });

  it('does not mark every line changed when a clean live buffer uses CRLF endings', async () => {
    const repoPath = createTempRepo();
    const filePath = path.join(repoPath, 'story.md');
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n', 'utf8');
    execFileSync('git', ['add', 'story.md'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'pipe' });

    await expect(collectGitChangeMarkers(filePath, 'one\r\ntwo\r\nthree\r\n')).resolves.toEqual([]);
  });

  it('marks staged files as added when a repository has no HEAD yet', async () => {
    const repoPath = createTempRepo();
    const filePath = path.join(repoPath, 'draft.md');
    fs.writeFileSync(filePath, 'new\nfile\n', 'utf8');
    execFileSync('git', ['add', 'draft.md'], { cwd: repoPath, stdio: 'pipe' });

    await expect(collectGitChangeMarkers(filePath, 'new\nfile\n')).resolves.toEqual([
      { type: 'added', startLine: 1, endLine: 2 },
    ]);
  });
});
