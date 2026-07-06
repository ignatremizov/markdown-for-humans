import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAllAddedChanges,
  collectGitChangeMarkers,
  parseGitDiffHunks,
  parseGitStatusPorcelain,
  revertGitChangeInContent,
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

    expect(parseGitDiffHunks(diff)).toEqual([
      {
        type: 'added',
        startLine: 4,
        endLine: 5,
        oldStart: 3,
        oldLineCount: 0,
        newStart: 4,
        newLineCount: 2,
        oldLines: [],
        newLines: ['new paragraph', 'another paragraph'],
      },
    ]);
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

    expect(parseGitDiffHunks(diff)).toEqual([
      {
        type: 'modified',
        startLine: 10,
        endLine: 12,
        oldStart: 10,
        oldLineCount: 2,
        newStart: 10,
        newLineCount: 3,
        oldLines: ['old line one', 'old line two'],
        newLines: ['new line one', 'new line two', 'new line three'],
      },
    ]);
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
      {
        type: 'deleted',
        startLine: 11,
        endLine: 11,
        deletedLines: 2,
        oldStart: 12,
        oldLineCount: 2,
        newStart: 11,
        newLineCount: 0,
        oldLines: ['removed one', 'removed two'],
        newLines: [],
      },
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
      {
        type: 'modified',
        startLine: 1,
        endLine: 1,
        oldStart: 1,
        oldLineCount: 1,
        newStart: 1,
        newLineCount: 1,
        oldLines: ['old title'],
        newLines: ['new title'],
      },
      {
        type: 'added',
        startLine: 9,
        endLine: 9,
        oldStart: 8,
        oldLineCount: 0,
        newStart: 9,
        newLineCount: 1,
        oldLines: [],
        newLines: ['inserted detail'],
      },
      {
        type: 'deleted',
        startLine: 20,
        endLine: 20,
        deletedLines: 1,
        oldStart: 20,
        oldLineCount: 1,
        newStart: 20,
        newLineCount: 0,
        oldLines: ['deleted detail'],
        newLines: [],
      },
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
      {
        type: 'added',
        startLine: 1,
        endLine: 3,
        oldStart: 0,
        oldLineCount: 0,
        newStart: 1,
        newLineCount: 3,
        oldLines: [],
        newLines: ['one', 'two', 'three'],
      },
    ]);
  });

  it('handles an empty untracked file without producing a marker', () => {
    expect(buildAllAddedChanges('')).toEqual([]);
  });

  it('does not count a single trailing newline as an extra added line', () => {
    expect(buildAllAddedChanges('one\ntwo\n')).toEqual([
      {
        type: 'added',
        startLine: 1,
        endLine: 2,
        oldStart: 0,
        oldLineCount: 0,
        newStart: 1,
        newLineCount: 2,
        oldLines: [],
        newLines: ['one', 'two'],
      },
    ]);
  });

  it('preserves CRLF file lines without leaking carriage returns into hunk bodies', () => {
    expect(buildAllAddedChanges('one\r\ntwo\r\n')).toEqual([
      expect.objectContaining({
        type: 'added',
        startLine: 1,
        endLine: 2,
        newLines: ['one', 'two'],
      }),
    ]);
  });
});

describe('revertGitChangeInContent', () => {
  it('replaces modified lines with the old hunk body', () => {
    expect(
      revertGitChangeInContent('one\nnew\nthree\n', {
        type: 'modified',
        startLine: 2,
        endLine: 2,
        oldLines: ['old'],
        newLines: ['new'],
      })
    ).toBe('one\nold\nthree\n');
  });

  it('removes inserted lines when reverting an added hunk', () => {
    expect(
      revertGitChangeInContent('one\nadded\nthree\n', {
        type: 'added',
        startLine: 2,
        endLine: 2,
        oldLines: [],
        newLines: ['added'],
      })
    ).toBe('one\nthree\n');
  });

  it('restores deleted lines at the surviving anchor line', () => {
    expect(
      revertGitChangeInContent('one\nthree\n', {
        type: 'deleted',
        startLine: 2,
        endLine: 2,
        deletedLines: 1,
        oldLines: ['two'],
        newLines: [],
      })
    ).toBe('one\ntwo\nthree\n');
  });

  it('uses parsed deletion hunk anchors to restore middle deletions after the preceding line', () => {
    const [change] = parseGitDiffHunks(
      [
        'diff --git a/story.md b/story.md',
        '--- a/story.md',
        '+++ b/story.md',
        '@@ -2 +1,0 @@',
        '-two',
      ].join('\n')
    );

    expect(change).toEqual(
      expect.objectContaining({
        type: 'deleted',
        startLine: 1,
        newStart: 1,
        oldLines: ['two'],
      })
    );
    expect(revertGitChangeInContent('one\nthree\n', change)).toBe('one\ntwo\nthree\n');
  });

  it('does not restore a stale deleted hunk when anchor lines no longer match', () => {
    expect(
      revertGitChangeInContent('zero\none\nthree\n', {
        type: 'deleted',
        startLine: 1,
        endLine: 1,
        deletedLines: 1,
        newStart: 1,
        oldLines: ['two'],
        newLines: [],
        deletedAnchorBeforeLine: 'one',
        deletedAnchorAfterLine: 'three',
      })
    ).toBe('zero\none\nthree\n');
  });

  it('leaves an empty buffer when reverting a whole-file added hunk', () => {
    expect(
      revertGitChangeInContent('one\ntwo\n', {
        type: 'added',
        startLine: 1,
        endLine: 2,
        oldLines: [],
        newLines: ['one', 'two'],
      })
    ).toBe('');
  });

  it('does not apply a stale modified hunk when current lines no longer match', () => {
    expect(
      revertGitChangeInContent('one\nuser edit\nthree\n', {
        type: 'modified',
        startLine: 2,
        endLine: 2,
        oldLines: ['old'],
        newLines: ['new'],
      })
    ).toBe('one\nuser edit\nthree\n');
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
      expect.objectContaining({
        type: 'modified',
        startLine: 2,
        endLine: 2,
        oldLines: ['two'],
        newLines: ['changed'],
      }),
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
      expect.objectContaining({
        type: 'added',
        startLine: 1,
        endLine: 2,
        oldLines: [],
        newLines: ['new', 'file'],
      }),
    ]);
  });

  it('attaches deleted hunk anchors from the live document buffer', async () => {
    const repoPath = createTempRepo();
    const filePath = path.join(repoPath, 'story.md');
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n', 'utf8');
    execFileSync('git', ['add', 'story.md'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'pipe' });

    await expect(collectGitChangeMarkers(filePath, 'one\nthree\n')).resolves.toEqual([
      expect.objectContaining({
        type: 'deleted',
        oldLines: ['two'],
        deletedAnchorBeforeLine: 'one',
        deletedAnchorAfterLine: 'three',
      }),
    ]);
  });
});
