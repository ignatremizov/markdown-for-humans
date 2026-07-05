import { WorkspaceEdit, Position, workspace, ExtensionContext, TextDocument } from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

// Helper to create a minimal mock TextDocument
function createDocument(content: string, uri = 'file://test.md') {
  return {
    getText: jest.fn(() => content),
    uri: {
      toString: () => uri,
    },
    positionAt: jest.fn((offset: number) => new Position(0, offset)),
  };
}

describe('MarkdownEditorProvider frontmatter rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wraps YAML frontmatter in a fenced code block when sending to webview', () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const content = [
      '---',
      'title: Example',
      'slug: example',
      '---',
      '',
      '# Heading',
      'body content',
    ].join('\n');

    const document = createDocument(content);
    const webview = { postMessage: jest.fn() };

    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as TextDocument, webview);

    expect(webview.postMessage).toHaveBeenCalledTimes(1);
    const payload = (webview.postMessage as jest.Mock).mock.calls[0][0];
    expect(payload.type).toBe('update');

    const wrapped = payload.content as string;
    expect(wrapped.startsWith('```yaml')).toBe(true);
    expect(wrapped).toContain('title: Example');
    expect(wrapped).toContain('slug: example');
    expect(wrapped).toContain('```');
    expect(wrapped.trimEnd()).toContain('# Heading');
  });

  it('restores YAML delimiters when saving an edited fenced block', async () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const original = ['---', 'title: Old', '---', '', '# Heading'].join('\n');
    const document = createDocument(original) as unknown as TextDocument;
    const webview = { postMessage: jest.fn() };

    // Seed any internal caches via updateWebview
    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document, webview);

    const editedFenced = ['```yaml', '---', 'title: New', '---', '```', '', '# Heading'].join('\n');

    let savedText = '';
    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces || [];
      if (replaces.length > 0) {
        savedText = replaces[0].text;
      }
      return true;
    });

    await (
      provider as unknown as { applyEdit: (content: string, doc: TextDocument) => Promise<void> }
    ).applyEdit(editedFenced, document);

    expect(savedText.startsWith('---\ntitle: New')).toBe(true);
    expect(savedText).toContain('\n---\n\n# Heading');
  });

  it('wraps frontmatter with a fence longer than embedded backtick runs', () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const content = [
      '---',
      'title: Example',
      'snippet: |',
      '  ```',
      '  code()',
      '  ```',
      'slug: example',
      '---',
      '',
      '# Heading',
    ].join('\n');

    const document = createDocument(content);
    const webview = { postMessage: jest.fn() };

    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as TextDocument, webview);

    const wrapped = (webview.postMessage as jest.Mock).mock.calls[0][0].content as string;
    expect(wrapped.split('\n')[0]).toBe('````yaml');
    expect(wrapped).toContain('slug: example');
  });

  it('restores YAML delimiters when saving a frontmatter block fenced with 4+ backticks', async () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const original = ['---', 'title: Old', 'slug: old', '---', '', '# Heading'].join('\n');
    const document = createDocument(original) as unknown as TextDocument;
    const webview = { postMessage: jest.fn() };

    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document, webview);

    const editedFenced = [
      '````yaml',
      '---',
      'title: New',
      'snippet: |',
      '  ```',
      '  code()',
      '  ```',
      'slug: new',
      '---',
      '````',
      '',
      '# Heading',
    ].join('\n');

    let savedText = '';
    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces || [];
      if (replaces.length > 0) {
        savedText = replaces[0].text;
      }
      return true;
    });

    await (
      provider as unknown as { applyEdit: (content: string, doc: TextDocument) => Promise<void> }
    ).applyEdit(editedFenced, document);

    expect(savedText.startsWith('---\ntitle: New')).toBe(true);
    expect(savedText).toContain('slug: new');
    expect(savedText).toContain('\n---\n\n# Heading');
    expect(savedText).not.toContain('````');
  });
});
