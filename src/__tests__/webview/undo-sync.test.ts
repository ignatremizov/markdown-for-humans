/**
 * Regression tests for webview undo/redo guards.
 *
 * We avoid initializing TipTap by mocking document.readyState as "loading"
 * so initializeEditor is never invoked during module import.
 */

// Mock TipTap and related heavy dependencies to avoid DOM requirements
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
  MathBlock: { configure: () => ({}) },
  MathInline: {},
  installMathMarkedExtensions: jest.fn(),
  setMathMarkedTokenizerEnabled: jest.fn(),
}));
jest.mock('./../../webview/BubbleMenuView', () => ({
  createFormattingToolbar: () => ({
    contains: jest.fn(() => false),
    remove: jest.fn(),
  }),
  createTableMenu: () => ({
    style: {},
    remove: jest.fn(),
  }),
  updateToolbarStates: jest.fn(),
}));
jest.mock('./../../webview/features/imageDragDrop', () => ({
  setupImageDragDrop: jest.fn(),
  hasPendingImageSaves: jest.fn(() => false),
  getPendingImageCount: jest.fn(() => 0),
}));
jest.mock('./../../webview/features/tocOverlay', () => ({ toggleTocOverlay: jest.fn() }));
jest.mock('./../../webview/features/searchOverlay', () => ({
  disposeSearchOverlay: jest.fn(),
  showSearchOverlay: jest.fn(),
}));
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

type TestingModule = {
  resetSyncState: () => void;
  setMockEditor: (editor: unknown) => void;
  trackSentContentForTests: (content: string) => void;
  updateEditorContentForTests: (content: string) => void;
  isCodeContextForPasteForTests: (event: ClipboardEvent) => boolean;
  insertRawCodeTextForTests: (text: string) => void;
  applyEditorSettingsForTests: (message: Record<string, unknown>) => void;
  getBlankLineModeForTests: () => 'preserve' | 'strip';
  isPlainFindShortcutForTests: (event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }) => boolean;
};

describe('webview undo/redo guards', () => {
  let testing: TestingModule;

  const setupModule = async (
    options: { readyState?: 'loading' | 'complete'; editorMock?: unknown } = {}
  ) => {
    jest.resetModules();
    const readyState = options.readyState ?? 'loading';
    const cssProperties = new Map<string, string>();
    const classNames = new Set<string>();
    const documentElement = {
      style: {
        setProperty: jest.fn((name: string, value: string) => {
          cssProperties.set(name, value);
        }),
        getPropertyValue: jest.fn((name: string) => cssProperties.get(name) ?? ''),
        removeProperty: jest.fn((name: string) => {
          cssProperties.delete(name);
        }),
      },
      classList: {
        contains: jest.fn((name: string) => classNames.has(name)),
        toggle: jest.fn((name: string, force?: boolean) => {
          if (force) classNames.add(name);
          else classNames.delete(name);
        }),
      },
    } as unknown as HTMLElement;
    const body = {
      classList: documentElement.classList,
    } as unknown as HTMLElement;
    const editorElement = {
      parentElement: {
        insertBefore: jest.fn(),
      },
      innerHTML: '',
      querySelector: jest.fn(() => null),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as HTMLElement;

    // Minimal globals to satisfy editor.ts on import without creating the editor
    (
      global as unknown as {
        document: {
          readyState: string;
          addEventListener: jest.Mock;
          removeEventListener: jest.Mock;
          documentElement: HTMLElement;
          body: HTMLElement;
          activeElement: HTMLElement | null;
          querySelector: jest.Mock;
          querySelectorAll: jest.Mock;
          getElementById: jest.Mock;
        };
      }
    ).document = {
      readyState,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      documentElement,
      body,
      activeElement: null,
      querySelector: jest.fn((selector: string) => (selector === '#editor' ? editorElement : null)),
      querySelectorAll: jest.fn(() => []),
      getElementById: jest.fn((id: string) => (id === 'editor' ? editorElement : null)),
    };
    (
      global as unknown as {
        window: {
          setTimeout: typeof setTimeout;
          clearTimeout: typeof clearTimeout;
          addEventListener: jest.Mock;
          dispatchEvent: jest.Mock;
        };
      }
    ).window = {
      setTimeout,
      clearTimeout,
      addEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    };
    (
      global as unknown as {
        acquireVsCodeApi: () => {
          postMessage: jest.Mock;
          getState: jest.Mock;
          setState: jest.Mock;
        };
      }
    ).acquireVsCodeApi = jest.fn(() => ({
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = {
      now: () => 0,
    };

    const tiptapCore = jest.requireMock('@tiptap/core') as { Editor: jest.Mock };
    tiptapCore.Editor.mockReset();
    if (options.editorMock) {
      tiptapCore.Editor.mockImplementation(() => options.editorMock);
    }

    try {
      const mod = await import('../../webview/editor');
      testing = mod.__testing;
    } catch (error) {
      throw new Error(
        `Failed to import webview editor test module: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`
      );
    }
  };

  beforeEach(async () => {
    await setupModule();
    testing.resetSyncState();
  });

  it('skips update when content matches recently sent hash', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('old'),
      state: { selection: { from: 0, to: 0 }, doc: { content: { size: 0 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };

    testing.setMockEditor(mockEditor);
    // Track content we "sent" - this should cause the update to be skipped
    testing.trackSentContentForTests('new');

    testing.updateEditorContentForTests('new');

    expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
  });

  it('skips update when content is unchanged', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('same'),
      state: { selection: { from: 1, to: 1 }, doc: { content: { size: 10 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };

    testing.setMockEditor(mockEditor);

    testing.updateEditorContentForTests('same');

    expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
  });

  it('applies update when content changes', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('old'),
      state: { selection: { from: 2, to: 4 }, doc: { content: { size: 5 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };

    testing.setMockEditor(mockEditor);

    testing.updateEditorContentForTests('new content');

    // @tiptap/markdown v3 requires contentType option
    expect(mockEditor.commands.setContent).toHaveBeenCalledWith('new content', {
      contentType: 'markdown',
    });
    expect(mockEditor.commands.setTextSelection).toHaveBeenCalledWith({ from: 2, to: 4 });
  });

  it('detects code context paste when selection is a codeBlock node', () => {
    const mockEditor = {
      isActive: jest.fn(() => false),
      state: {
        selection: {
          node: { type: { name: 'codeBlock' } },
        },
      },
    };

    testing.setMockEditor(mockEditor);

    const fakeEvent = { target: null } as unknown as ClipboardEvent;
    expect(testing.isCodeContextForPasteForTests(fakeEvent)).toBe(true);
  });

  it('inserts pasted code as plain text node (no HTML parsing)', () => {
    const insertContent = jest.fn();
    const mockEditor = {
      commands: {
        insertContent,
      },
    };

    testing.setMockEditor(mockEditor);

    testing.insertRawCodeTextForTests('<table class="sq-table"><tr><td>Alice</td></tr></table>');

    expect(insertContent).toHaveBeenCalledWith({
      type: 'text',
      text: '<table class="sq-table"><tr><td>Alice</td></tr></table>',
    });
  });

  it('handles only the plain find shortcut inside the webview', () => {
    expect(testing.isPlainFindShortcutForTests({ key: 'f', ctrlKey: true })).toBe(true);
    expect(testing.isPlainFindShortcutForTests({ key: 'F', metaKey: true })).toBe(true);
    expect(testing.isPlainFindShortcutForTests({ key: 'F', ctrlKey: true, shiftKey: true })).toBe(
      false
    );
    expect(testing.isPlainFindShortcutForTests({ key: 'f', ctrlKey: true, altKey: true })).toBe(
      false
    );
  });

  it('preserves explicit blank lines before host settings arrive', () => {
    expect(testing.getBlankLineModeForTests()).toBe('preserve');
  });

  it('seeds the initial update content through the Editor constructor', async () => {
    const initialMarkdown = '# Heading\n\nFirst paragraph.';
    const setContent = jest.fn();
    const editorDom = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      querySelectorAll: jest.fn(() => []),
    };
    const editorMock = {
      commands: {
        setContent,
        setTextSelection: jest.fn(),
        insertContent: jest.fn(),
      },
      state: {
        selection: { from: 1, to: 1, empty: true },
        doc: { content: { size: initialMarkdown.length } },
      },
      view: { dom: editorDom },
      on: jest.fn(),
      isActive: jest.fn(() => false),
    };

    await setupModule({ readyState: 'complete', editorMock });
    const messageHandler = (window.addEventListener as jest.Mock).mock.calls.find(
      ([eventName]) => eventName === 'message'
    )?.[1] as ((event: MessageEvent) => void) | undefined;
    expect(messageHandler).toBeDefined();

    messageHandler?.({ data: { type: 'update', content: initialMarkdown } } as MessageEvent);

    const { Editor } = jest.requireMock('@tiptap/core') as { Editor: jest.Mock };
    expect(Editor).toHaveBeenCalledTimes(1);
    expect(Editor.mock.calls[0][0]).toMatchObject({
      content: initialMarkdown,
      contentType: 'markdown',
    });
    expect(setContent).not.toHaveBeenCalled();
  });

  it('applies layout width settings as editor CSS variables', () => {
    testing.applyEditorSettingsForTests({ leftMargin: 64, rightMargin: 96, maxContentWidth: 900 });

    expect(document.documentElement.style.getPropertyValue('--md-left-margin')).toBe('64px');
    expect(document.documentElement.style.getPropertyValue('--md-right-margin')).toBe('96px');
    expect(document.documentElement.style.getPropertyValue('--md-content-max-width')).toBe('900px');
  });

  it('uses an unbounded content width when max content width is disabled', () => {
    testing.applyEditorSettingsForTests({ maxContentWidth: 0 });

    expect(document.documentElement.style.getPropertyValue('--md-content-max-width')).toBe(
      '999999px'
    );
  });
});
