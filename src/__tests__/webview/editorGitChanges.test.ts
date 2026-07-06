/** @jest-environment jsdom */

import type { GitChangeRange } from '../../webview/features/gitChangeMarkers';

jest.mock('@tiptap/core', () => ({
  Editor: jest.fn(),
  Extension: { create: (config: unknown) => config },
  Node: { create: (config: unknown) => config },
  mergeAttributes: (...attrs: Array<Record<string, unknown>>) => Object.assign({}, ...attrs),
}));
jest.mock('@tiptap/pm/state', () => ({
  Plugin: class {},
  PluginKey: class {},
}));
jest.mock('@tiptap/pm/view', () => ({
  Decoration: { inline: jest.fn() },
  DecorationSet: { create: jest.fn(), empty: {} },
}));
jest.mock('@tiptap/starter-kit', () => ({ __esModule: true, default: { configure: () => ({}) } }));
jest.mock('@tiptap/markdown', () => ({ Markdown: { configure: () => ({}) } }));
jest.mock('lowlight', () => ({ __esModule: true, lowlight: { registerLanguage: jest.fn() } }));
jest.mock('@tiptap/extension-table', () => ({
  __esModule: true,
  Table: { extend: () => ({ configure: () => ({}) }) },
  TableRow: {},
  TableHeader: {},
  TableCell: {},
}));
jest.mock('@tiptap/extension-list', () => ({
  __esModule: true,
  ListKit: { configure: () => ({}) },
  BulletList: { extend: (config: unknown) => config },
  OrderedList: { extend: (config: unknown) => config },
}));
jest.mock('@tiptap/extension-link', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}));
jest.mock('@tiptap/extension-code-block-lowlight', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/codeBlockWithCopy', () => ({
  CodeBlockWithCopy: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/customImage', () => ({
  CustomImage: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/mermaid', () => ({ Mermaid: {} }));
jest.mock('./../../webview/extensions/tabIndentation', () => ({ TabIndentation: {} }));
jest.mock('./../../webview/extensions/imageEnterSpacing', () => ({ ImageEnterSpacing: {} }));
jest.mock('./../../webview/extensions/markdownParagraph', () => ({ MarkdownParagraph: {} }));
jest.mock('./../../webview/extensions/blankLinePreservation', () => ({
  BlankLinePreservation: {},
}));
jest.mock('./../../webview/extensions/githubAlerts', () => ({ GitHubAlerts: {} }));
jest.mock('./../../webview/extensions/math', () => ({
  MathBlock: {},
  MathInline: {},
  installMathMarkedExtensions: jest.fn(),
  setMathMarkedTokenizerEnabled: jest.fn(),
}));
jest.mock('./../../webview/BubbleMenuView', () => ({
  createFormattingToolbar: () => ({}),
  createTableMenu: () => ({}),
  updateToolbarStates: jest.fn(),
}));
jest.mock('./../../webview/features/imageDragDrop', () => ({
  setupImageDragDrop: jest.fn(),
  hasPendingImageSaves: jest.fn(() => false),
  getPendingImageCount: jest.fn(() => 0),
}));
jest.mock('./../../webview/features/tocOverlay', () => ({ toggleTocOverlay: jest.fn() }));
jest.mock('./../../webview/features/searchOverlay', () => ({ showSearchOverlay: jest.fn() }));
jest.mock('./../../webview/utils/exportContent', () => ({
  collectExportContent: jest.fn(),
  getDocumentTitle: jest.fn(),
}));
jest.mock('./../../webview/utils/pasteHandler', () => ({
  processPasteContent: jest.fn(() => ({ isImage: false, wasConverted: false, content: '' })),
  parseFencedCode: jest.fn(() => null),
}));
jest.mock('./../../webview/utils/copyMarkdown', () => ({
  copySelectionAsMarkdown: jest.fn(),
  writeSelectionMarkdownToClipboard: jest.fn(),
}));
jest.mock('./../../webview/utils/outline', () => ({ buildOutlineFromEditor: jest.fn(() => []) }));
jest.mock('./../../webview/utils/scrollToHeading', () => ({
  scrollToHeading: jest.fn(),
  scrollToPos: jest.fn(),
}));

const renderGitChangeMarkers = jest.fn();
const renderGitHunkDiffWidget = jest.fn();
const clearGitHunkDiffWidget = jest.fn();

jest.mock('./../../webview/features/gitChangeMarkers', () => ({
  clearGitHunkDiffWidget: (...args: unknown[]) => clearGitHunkDiffWidget(...args),
  coerceGitChangeRanges: (changes: unknown) => (Array.isArray(changes) ? changes : []),
  renderGitChangeMarkers: (...args: unknown[]) => renderGitChangeMarkers(...args),
  renderGitHunkDiffWidget: (...args: unknown[]) => renderGitHunkDiffWidget(...args),
}));

type GitMarkerRenderOptions = {
  onMarkerClick?: (change: GitChangeRange, index: number) => void;
};

describe('webview Git change orchestration', () => {
  beforeEach(() => {
    jest.resetModules();
    renderGitChangeMarkers.mockReset();
    renderGitHunkDiffWidget.mockReset();
    clearGitHunkDiffWidget.mockReset();

    document.body.innerHTML = '<main id="editor"></main>';
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
    document.addEventListener = jest.fn();

    (global as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = jest.fn(() => ({
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    }));
  });

  it('requests outer scrolling when a gutter marker opens a hunk diff', async () => {
    const { __testing } = await import('../../webview/editor');
    const change: GitChangeRange = {
      type: 'modified',
      startLine: 40,
      endLine: 80,
      oldLines: ['old'],
      newLines: ['new'],
    };

    __testing.renderGitChangesFromMessageForTests({
      type: 'gitChangesUpdate',
      changes: [change],
    });

    const options = renderGitChangeMarkers.mock.calls[0]?.[1] as GitMarkerRenderOptions;
    options.onMarkerClick?.(change, 0);

    expect(renderGitHunkDiffWidget).toHaveBeenCalledWith(
      document.getElementById('editor'),
      [change],
      0,
      expect.objectContaining({ scrollIntoView: true })
    );
  });

  it('applies the configured Git diff peek scroll behavior to opened hunks', async () => {
    const { __testing } = await import('../../webview/editor');
    const change: GitChangeRange = {
      type: 'modified',
      startLine: 40,
      endLine: 80,
      oldLines: ['old'],
      newLines: ['new'],
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'settingsUpdate',
          gitDiffPeekScrollBehavior: 'snap',
        },
      })
    );

    __testing.renderGitChangesFromMessageForTests({
      type: 'gitChangesUpdate',
      changes: [change],
    });

    const options = renderGitChangeMarkers.mock.calls[0]?.[1] as GitMarkerRenderOptions;
    options.onMarkerClick?.(change, 0);

    expect(renderGitHunkDiffWidget).toHaveBeenCalledWith(
      document.getElementById('editor'),
      [change],
      0,
      expect.objectContaining({ scrollBehavior: 'snap' })
    );
  });

  it('updates marker projection source from Git change payloads', async () => {
    const { __testing } = await import('../../webview/editor');
    const change: GitChangeRange = {
      type: 'modified',
      startLine: 2,
      endLine: 2,
      oldLines: ['old'],
      newLines: ['new'],
    };

    __testing.renderGitChangesFromMessageForTests({
      type: 'gitChangesUpdate',
      changes: [change],
      sourceContentForMarkers: 'intro\nnew\noutro',
      sourceLineCount: 3,
    });

    expect(renderGitChangeMarkers).toHaveBeenCalledWith(
      document.getElementById('editor'),
      expect.objectContaining({
        changes: [change],
        lineCount: 3,
        sourceMarkdown: 'intro\nnew\noutro',
      })
    );
  });
});
