/** @jest-environment jsdom */

import {
  buildSourceBlockRanges,
  coerceGitChangeRanges,
  gitHunkScrollDurationMs,
  renderGitChangeMarkers,
  renderGitHunkDiffWidget,
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

  it('preserves hunk bodies for diff widgets and revert actions', () => {
    expect(
      coerceGitChangeRanges([
        {
          type: 'modified',
          startLine: 2,
          endLine: 2,
          oldStart: 2,
          oldLineCount: 1,
          newStart: 2,
          newLineCount: 1,
          oldLines: ['old text'],
          newLines: ['new text'],
          deletedAnchorBeforeLine: 'before',
          deletedAnchorAfterLine: null,
        },
      ])
    ).toEqual([
      {
        type: 'modified',
        startLine: 2,
        endLine: 2,
        oldStart: 2,
        oldLineCount: 1,
        newStart: 2,
        newLineCount: 1,
        oldLines: ['old text'],
        newLines: ['new text'],
        deletedAnchorBeforeLine: 'before',
        deletedAnchorAfterLine: null,
      },
    ]);
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
    expect(root.querySelector('.git-change-gutter-marker')?.tagName).toBe('BUTTON');
    expect(root.querySelector('.git-change-gutter')?.getAttribute('aria-hidden')).toBeNull();
    expect(root.querySelector('.git-change-overview')?.getAttribute('aria-hidden')).toBe('true');
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

  it('calls the marker click callback with the clicked hunk index', () => {
    const onMarkerClick = jest.fn();

    renderGitChangeMarkers(root, {
      lineCount: 10,
      changes: [
        {
          type: 'modified',
          startLine: 3,
          endLine: 3,
          oldLines: ['old'],
          newLines: ['new'],
        },
      ],
      onMarkerClick,
    });

    const marker = root.querySelector('.git-change-gutter-marker') as HTMLButtonElement;
    expect(marker.dataset.changeIndex).toBe('0');

    marker.click();

    expect(onMarkerClick).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'modified', oldLines: ['old'], newLines: ['new'] }),
      0
    );
  });

  it('splits mixed replacement-plus-insertion hunks into modified and added visual markers', () => {
    const onMarkerClick = jest.fn();

    renderGitChangeMarkers(root, {
      lineCount: 100,
      changes: [
        {
          type: 'modified',
          startLine: 20,
          endLine: 24,
          oldLineCount: 1,
          newLineCount: 5,
          oldLines: ['old sentence'],
          newLines: ['new sentence', '', 'inserted paragraph', '', 'another inserted paragraph'],
        },
      ],
      onMarkerClick,
    });

    const markers = Array.from(root.querySelectorAll('.git-change-gutter-marker'));

    expect(markers).toHaveLength(2);
    expect(markers[0].classList.contains('git-change-modified')).toBe(true);
    expect((markers[0] as HTMLElement).dataset.startLine).toBe('20');
    expect((markers[0] as HTMLElement).dataset.endLine).toBe('20');
    expect(markers[1].classList.contains('git-change-added')).toBe(true);
    expect((markers[1] as HTMLElement).dataset.startLine).toBe('21');
    expect((markers[1] as HTMLElement).dataset.endLine).toBe('24');
    expect(markers.map(marker => marker.getAttribute('data-change-index'))).toEqual(['0', '0']);

    (markers[1] as HTMLButtonElement).click();

    expect(onMarkerClick).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'modified',
        oldLines: ['old sentence'],
      }),
      0
    );
  });
});

describe('renderGitHunkDiffWidget', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<main id="editor"><div class="ProseMirror"></div></main>';
    root = document.getElementById('editor') as HTMLElement;
  });

  it('renders old and new hunk lines near the selected gutter marker', () => {
    renderGitChangeMarkers(root, {
      lineCount: 10,
      changes: [{ type: 'modified', startLine: 4, endLine: 4 }],
    });

    const widget = renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          oldLineCount: 1,
          newStart: 4,
          newLineCount: 1,
          oldLines: ['old line'],
          newLines: ['new line'],
        },
      ],
      0
    );

    expect(widget).not.toBeNull();
    expect(root.querySelector('.git-hunk-diff-widget')).not.toBeNull();
    expect(root.querySelector('.git-change-gutter-marker.git-change-active')).not.toBeNull();
    expect(root.textContent).toContain('old line');
    expect(root.textContent).toContain('new line');
  });

  it('highlights changed tokens inside modified hunk lines', () => {
    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          newStart: 4,
          oldLines: ['alpha beta gamma'],
          newLines: ['alpha delta gamma'],
        },
      ],
      0
    );

    const oldHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-old .git-hunk-diff-token-changed')
    );
    const newHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-new .git-hunk-diff-token-changed')
    );

    expect(oldHighlights.map(element => element.textContent)).toEqual(['beta']);
    expect(newHighlights.map(element => element.textContent)).toEqual(['delta']);
  });

  it('keeps whitespace-only changes inside inline highlights', () => {
    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          newStart: 4,
          oldLines: ['alpha  beta'],
          newLines: ['alpha beta'],
        },
      ],
      0
    );

    const oldHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-old .git-hunk-diff-token-changed')
    );
    const newHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-new .git-hunk-diff-token-changed')
    );

    expect(oldHighlights.map(element => element.textContent)).toEqual(['  ']);
    expect(newHighlights.map(element => element.textContent)).toEqual([' ']);
  });

  it('does not leave gaps between adjacent changed words separated by spaces', () => {
    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          newStart: 4,
          oldLines: ['alpha beta gamma'],
          newLines: ['delta epsilon gamma'],
        },
      ],
      0
    );

    const oldHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-old .git-hunk-diff-token-changed')
    );
    const newHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-new .git-hunk-diff-token-changed')
    );

    expect(oldHighlights.map(element => element.textContent)).toEqual(['alpha beta']);
    expect(newHighlights.map(element => element.textContent)).toEqual(['delta epsilon']);
  });

  it('keeps separate highlights when unchanged words split independent changes', () => {
    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          newStart: 4,
          oldLines: ['Status marker shows red and slow response.'],
          newLines: ['Status marker shows blue and fast response.'],
        },
      ],
      0
    );

    const oldHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-old .git-hunk-diff-token-changed')
    );
    const newHighlights = Array.from(
      root.querySelectorAll('.git-hunk-diff-line-new .git-hunk-diff-token-changed')
    );

    expect(oldHighlights.map(element => element.textContent)).toEqual(['red', 'slow']);
    expect(newHighlights.map(element => element.textContent)).toEqual(['blue', 'fast']);
  });

  it('renders neutral source context around the selected hunk when source markdown is available', () => {
    const sourceMarkdown = [
      'line 1',
      'line 2',
      'line 3',
      'changed line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
    ].join('\n');

    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          newStart: 4,
          oldLines: ['old line 4'],
          newLines: ['changed line 4'],
        },
      ],
      0,
      { sourceMarkdown }
    );

    const contextLines = Array.from(root.querySelectorAll('.git-hunk-diff-line-context'));
    const contextText = contextLines.map(
      element => element.querySelector('.git-hunk-diff-line-content')?.textContent
    );

    expect(contextText).toEqual(['line 1', 'line 2', 'line 3', 'line 5', 'line 6', 'line 7']);
    expect(root.querySelector('.git-hunk-diff-body')?.textContent).toContain('old line 4');
    expect(root.querySelector('.git-hunk-diff-body')?.textContent).toContain('changed line 4');
  });

  it('includes nearby hunks in the same contextual review peek', () => {
    const sourceMarkdown = [
      'line 1',
      'line 2',
      'line 3',
      'changed line 4',
      'line 5',
      'line 6',
      'line 7',
      'nearby inserted line',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ].join('\n');

    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'modified',
          startLine: 4,
          endLine: 4,
          oldStart: 4,
          newStart: 4,
          oldLines: ['old line 4'],
          newLines: ['changed line 4'],
        },
        {
          type: 'added',
          startLine: 8,
          endLine: 8,
          oldStart: 7,
          newStart: 8,
          oldLines: [],
          newLines: ['nearby inserted line'],
        },
      ],
      0,
      { sourceMarkdown }
    );

    const body = root.querySelector('.git-hunk-diff-body') as HTMLElement;
    const addedLines = Array.from(body.querySelectorAll('.git-hunk-diff-line-new')).map(
      element => element.querySelector('.git-hunk-diff-line-content')?.textContent
    );

    expect(root.querySelector('.git-hunk-diff-widget')?.getAttribute('data-change-index')).toBe(
      '0'
    );
    expect(addedLines).toContain('changed line 4');
    expect(addedLines).toContain('nearby inserted line');
    expect(body.textContent).toContain('line 11');
  });

  it('scrolls the contextual peek body to the selected hunk within nearby changes', () => {
    const originalOffsetTop = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      'offsetTop'
    );
    Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        if (this instanceof HTMLElement && this.classList.contains('git-hunk-diff-line')) {
          return Array.from(this.parentElement?.children ?? []).indexOf(this) * 24;
        }
        return 0;
      },
    });

    try {
      renderGitHunkDiffWidget(
        root,
        [
          {
            type: 'modified',
            startLine: 4,
            endLine: 4,
            oldStart: 4,
            newStart: 4,
            oldLines: ['old line 4'],
            newLines: ['changed line 4'],
          },
          {
            type: 'added',
            startLine: 8,
            endLine: 8,
            oldStart: 7,
            newStart: 8,
            oldLines: [],
            newLines: ['nearby inserted line'],
          },
        ],
        1,
        {
          sourceMarkdown: [
            'line 1',
            'line 2',
            'line 3',
            'changed line 4',
            'line 5',
            'line 6',
            'line 7',
            'nearby inserted line',
            'line 9',
            'line 10',
            'line 11',
            'line 12',
          ].join('\n'),
        }
      );

      const body = root.querySelector('.git-hunk-diff-body') as HTMLElement;
      const selectedLine = body.querySelector('.git-hunk-diff-line-selected') as HTMLElement | null;

      expect(selectedLine?.textContent).toContain('nearby inserted line');
      expect(body.scrollTop).toBeGreaterThan(0);
    } finally {
      if (originalOffsetTop) {
        Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', originalOffsetTop);
      } else {
        delete (window.HTMLElement.prototype as unknown as { offsetTop?: number }).offsetTop;
      }
    }
  });

  it('routes widget actions to the provided callbacks', () => {
    const onClose = jest.fn();
    const onPrevious = jest.fn();
    const onNext = jest.fn();
    const onRevert = jest.fn();

    renderGitHunkDiffWidget(
      root,
      [
        {
          type: 'added',
          startLine: 1,
          endLine: 1,
          oldLines: [],
          newLines: ['added'],
        },
      ],
      0,
      { onClose, onPrevious, onNext, onRevert }
    );

    (root.querySelector('[data-action="previous"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="next"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="revert"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="close"]') as HTMLButtonElement).click();

    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onRevert).toHaveBeenCalledWith(expect.objectContaining({ type: 'added' }), 0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('scrolls the hunk widget into view when requested by navigation', () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalScrollTo = window.scrollTo;
    const originalScrollY = window.scrollY;
    const originalInnerHeight = window.innerHeight;
    const originalGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
    const requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback((window.performance?.now?.() ?? 0) + 500);
      return 1;
    });
    const scrollTo = jest.fn();
    window.requestAnimationFrame = requestAnimationFrame;
    window.scrollTo = scrollTo;
    window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this instanceof HTMLElement && this.classList.contains('git-hunk-diff-widget')) {
        return {
          x: 0,
          y: 1200,
          top: 1200,
          right: 400,
          bottom: 1280,
          left: 0,
          width: 400,
          height: 80,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    try {
      renderGitHunkDiffWidget(
        root,
        [
          {
            type: 'modified',
            startLine: 20,
            endLine: 20,
            oldLines: ['old'],
            newLines: ['new'],
          },
        ],
        0,
        { scrollIntoView: true }
      );

      expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number) });
      expect(requestAnimationFrame).toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.scrollTo = originalScrollTo;
      window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(window, 'scrollY', { configurable: true, value: originalScrollY });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('snaps the hunk widget into view when requested by settings', () => {
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalScrollTo = window.scrollTo;
    const originalScrollY = window.scrollY;
    const originalInnerHeight = window.innerHeight;
    const originalGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
    const requestAnimationFrame = jest.fn();
    const scrollTo = jest.fn();
    window.requestAnimationFrame = requestAnimationFrame;
    window.scrollTo = scrollTo;
    window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this instanceof HTMLElement && this.classList.contains('git-hunk-diff-widget')) {
        return {
          x: 0,
          y: 1200,
          top: 1200,
          right: 400,
          bottom: 1280,
          left: 0,
          width: 400,
          height: 80,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    try {
      renderGitHunkDiffWidget(
        root,
        [
          {
            type: 'modified',
            startLine: 20,
            endLine: 20,
            oldLines: ['old'],
            newLines: ['new'],
          },
        ],
        0,
        { scrollIntoView: true, scrollBehavior: 'snap' }
      );

      expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number) });
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.scrollTo = originalScrollTo;
      window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(window, 'scrollY', { configurable: true, value: originalScrollY });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('uses shorter relative duration for farther hunk scroll jumps', () => {
    const nearDistance = 200;
    const farDistance = 5000;
    const nearDuration = gitHunkScrollDurationMs(nearDistance);
    const farDuration = gitHunkScrollDurationMs(farDistance);

    expect(farDuration).toBeGreaterThan(nearDuration);
    expect(farDistance / farDuration).toBeGreaterThan(nearDistance / nearDuration);
    expect(farDuration).toBeLessThanOrEqual(360);
  });
});
