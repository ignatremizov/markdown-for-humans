/** @jest-environment jsdom */

import {
  buildSourceBlockRanges,
  coerceGitChangeRanges,
  renderGitChangeMarkers,
} from '../../webview/features/gitChangeMarkers';

describe('coerceGitChangeRanges', () => {
  it('keeps valid change ranges and normalizes reversed line bounds', () => {
    expect(
      coerceGitChangeRanges([
        { type: 'added', startLine: 3, endLine: 1 },
        { type: 'modified', startLine: 4, endLine: 4 },
        { type: 'deleted', startLine: 5, endLine: 5, deletedLines: 2 },
      ])
    ).toEqual([
      { type: 'added', startLine: 1, endLine: 3 },
      { type: 'modified', startLine: 4, endLine: 4 },
      { type: 'deleted', startLine: 5, endLine: 5, deletedLines: 2 },
    ]);
  });

  it('drops invalid ranges from untrusted webview messages', () => {
    expect(
      coerceGitChangeRanges([
        null,
        { type: 'renamed', startLine: 1, endLine: 1 },
        { type: 'added', startLine: 0, endLine: 1 },
        { type: 'modified', startLine: 2, endLine: Number.NaN },
      ])
    ).toEqual([]);
  });
});

describe('buildSourceBlockRanges', () => {
  it('groups prose into rendered block ranges', () => {
    expect(
      buildSourceBlockRanges(
        [
          '# Title',
          '',
          'Paragraph line one',
          'paragraph line two',
          '',
          '```ts',
          'const x = 1;',
          '```',
        ].join('\n')
      )
    ).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 4 },
      { startLine: 6, endLine: 8 },
    ]);
  });

  it('keeps frontmatter as one source block', () => {
    expect(buildSourceBlockRanges('---\ntitle: Draft\n---\n\n# Body')).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 5, endLine: 5 },
    ]);
  });
});

describe('renderGitChangeMarkers', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<main id="editor"><div class="ProseMirror"></div></main>';
    root = document.getElementById('editor') as HTMLElement;
  });

  it('renders gutter and overview markers for added, modified, and deleted ranges', () => {
    renderGitChangeMarkers(root, {
      lineCount: 100,
      changes: [
        { type: 'added', startLine: 10, endLine: 12 },
        { type: 'modified', startLine: 50, endLine: 50 },
        { type: 'deleted', startLine: 80, endLine: 80, deletedLines: 3 },
      ],
    });

    expect(root.querySelectorAll('.git-change-gutter-marker')).toHaveLength(3);
    expect(root.querySelectorAll('.git-change-overview-marker')).toHaveLength(3);
    expect(root.querySelector('.git-change-gutter-marker.git-change-added')).not.toBeNull();
    expect(root.querySelector('.git-change-gutter-marker.git-change-modified')).not.toBeNull();
    expect(root.querySelector('.git-change-gutter-marker.git-change-deleted')).not.toBeNull();
  });

  it('clears existing markers when given no changes', () => {
    renderGitChangeMarkers(root, {
      lineCount: 10,
      changes: [{ type: 'added', startLine: 1, endLine: 1 }],
    });

    renderGitChangeMarkers(root, { lineCount: 10, changes: [] });

    expect(root.querySelector('.git-change-gutter')).toBeNull();
    expect(root.querySelector('.git-change-overview')).toBeNull();
  });

  it('clamps markers to the current line count', () => {
    renderGitChangeMarkers(root, {
      lineCount: 5,
      changes: [{ type: 'modified', startLine: 8, endLine: 12 }],
    });

    const marker = root.querySelector('.git-change-gutter-marker') as HTMLElement;
    expect(marker.dataset.startLine).toBe('5');
    expect(marker.dataset.endLine).toBe('5');
  });

  it('positions gutter markers from rendered blocks when source markdown is available', () => {
    const proseMirror = root.querySelector('.ProseMirror') as HTMLElement;
    proseMirror.innerHTML = '<h1>Title</h1><p>Paragraph</p>';
    const title = proseMirror.children[0] as HTMLElement;
    const paragraph = proseMirror.children[1] as HTMLElement;

    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(proseMirror, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(title, 'offsetTop', { configurable: true, value: 0 });
    Object.defineProperty(title, 'offsetHeight', { configurable: true, value: 24 });
    Object.defineProperty(paragraph, 'offsetTop', { configurable: true, value: 100 });
    Object.defineProperty(paragraph, 'offsetHeight', { configurable: true, value: 30 });

    renderGitChangeMarkers(root, {
      lineCount: 4,
      sourceMarkdown: '# Title\n\nParagraph',
      changes: [{ type: 'modified', startLine: 3, endLine: 3 }],
    });

    const marker = root.querySelector('.git-change-gutter-marker') as HTMLElement;
    expect(marker.style.top).toBe('50%');
    expect(marker.style.height).toBe('15%');
  });

  it('keeps marker geometry aligned when extra blank lines render empty paragraphs', () => {
    const proseMirror = root.querySelector('.ProseMirror') as HTMLElement;
    proseMirror.innerHTML = [
      '<p>Before</p>',
      '<p><br class="ProseMirror-trailingBreak"></p>',
      '<p>Section summary begins here.</p>',
      '<p><br class="ProseMirror-trailingBreak"></p>',
      '<ul><li><p>First checklist item</p></li><li><p>Second checklist item</p></li></ul>',
      '<p>After</p>',
    ].join('');
    const before = proseMirror.children[0] as HTMLElement;
    const blankBefore = proseMirror.children[1] as HTMLElement;
    const paragraph = proseMirror.children[2] as HTMLElement;
    const blankInside = proseMirror.children[3] as HTMLElement;
    const list = proseMirror.children[4] as HTMLElement;
    const after = proseMirror.children[5] as HTMLElement;

    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(proseMirror, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(before, 'offsetTop', { configurable: true, value: 0 });
    Object.defineProperty(before, 'offsetHeight', { configurable: true, value: 24 });
    Object.defineProperty(blankBefore, 'offsetTop', { configurable: true, value: 80 });
    Object.defineProperty(blankBefore, 'offsetHeight', { configurable: true, value: 40 });
    Object.defineProperty(paragraph, 'offsetTop', { configurable: true, value: 180 });
    Object.defineProperty(paragraph, 'offsetHeight', { configurable: true, value: 32 });
    Object.defineProperty(blankInside, 'offsetTop', { configurable: true, value: 230 });
    Object.defineProperty(blankInside, 'offsetHeight', { configurable: true, value: 40 });
    Object.defineProperty(list, 'offsetTop', { configurable: true, value: 300 });
    Object.defineProperty(list, 'offsetHeight', { configurable: true, value: 72 });
    Object.defineProperty(after, 'offsetTop', { configurable: true, value: 430 });
    Object.defineProperty(after, 'offsetHeight', { configurable: true, value: 30 });

    renderGitChangeMarkers(root, {
      lineCount: 9,
      sourceMarkdown: [
        'Before',
        '',
        '',
        'Section summary begins here.',
        '',
        '- First checklist item',
        '- Second checklist item',
        '',
        'After',
      ].join('\n'),
      changes: [{ type: 'added', startLine: 4, endLine: 7 }],
    });

    const marker = root.querySelector('.git-change-gutter-marker') as HTMLElement;
    expect(marker.style.top).toBe('36%');
    expect(marker.style.height).toBe('38.4%');
  });
});
