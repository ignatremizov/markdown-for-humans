/**
 * @jest-environment jsdom
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  MathBlock,
  MathInline,
  installMathMarkedExtensions,
  setMathMarkedTokenizerEnabled,
} from '../../webview/extensions/math';

function createMathEditor(
  options: { renderMath?: boolean; includeInlineMath?: boolean } = {}
): Editor {
  const renderMath = options.renderMath ?? true;
  const includeInlineMath = options.includeInlineMath ?? true;
  const element = document.createElement('div');
  document.body.appendChild(element);

  const mathExtensions = [MathBlock.configure({ render: renderMath })];
  if (includeInlineMath) {
    mathExtensions.push(MathInline);
  }

  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: true,
        },
      }),
      ...mathExtensions,
    ],
  });

  const markdownStorage = editor as unknown as {
    markdown?: unknown;
    storage?: { markdown?: unknown };
  };
  const markdownManager = markdownStorage.markdown ?? markdownStorage.storage?.markdown;
  installMathMarkedExtensions(markdownManager);

  return editor;
}

function countNodes(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants(node => {
    if (node.type.name === typeName) {
      count += 1;
    }
    return true;
  });
  return count;
}

describe('KaTeX math extension markdown integration', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.innerHTML = '';
    setMathMarkedTokenizerEnabled(true);
  });

  it('parses and serializes display math blocks', () => {
    editor = createMathEditor();

    editor.commands.setContent('Before\n\n$$\nE = mc^2\n$$\n\nAfter', {
      contentType: 'markdown',
    });

    expect(countNodes(editor, 'mathBlock')).toBe(1);
    expect(editor.getMarkdown()).toContain('$$\nE = mc^2\n$$');
  });

  it('preserves multiline display math content', () => {
    editor = createMathEditor();
    const latex = '\\begin{aligned}\nx &= y \\\\\nz &= w\n\\end{aligned}';

    editor.commands.setContent(`$$\n${latex}\n$$`, { contentType: 'markdown' });

    expect(editor.getMarkdown()).toContain(latex);
  });

  it('converts inline math to mathInline nodes and round-trips delimiters', () => {
    editor = createMathEditor();

    editor.commands.setContent('Einstein wrote $E=mc^2$ in text.', {
      contentType: 'markdown',
    });

    expect(countNodes(editor, 'mathInline')).toBe(1);
    expect(editor.getMarkdown()).toContain('$E=mc^2$');
  });

  it('accepts numeric inline math but leaves unclosed dollar amounts alone', () => {
    editor = createMathEditor();

    editor.commands.setContent('Valid: $12345$. Price: $100 today.', {
      contentType: 'markdown',
    });

    expect(countNodes(editor, 'mathInline')).toBe(1);
    expect(editor.getMarkdown()).toContain('$12345$');
    expect(editor.getMarkdown()).toContain('$100 today');
  });

  it('does not convert escaped dollar-delimited text into inline math', () => {
    editor = createMathEditor();

    editor.commands.setContent('Literal: \\$x$', { contentType: 'markdown' });

    expect(countNodes(editor, 'mathInline')).toBe(0);
  });

  it('shows the custom error UI for invalid display math', () => {
    editor = createMathEditor();

    editor.commands.setContent('$$\n\\frac{1}{0\n$$', { contentType: 'markdown' });

    const rendered = document.querySelector('.math-block-rendered');
    const errorMessage = document.querySelector('.math-error-msg');
    expect(rendered?.classList.contains('katex-error')).toBe(true);
    expect(errorMessage?.textContent).toBeTruthy();
  });

  it('uses the current math block node when saving repeated edits', () => {
    editor = createMathEditor();
    editor.commands.setContent('$$\nE\n$$\n\nAfter', { contentType: 'markdown' });

    editDisplayMath('E = mc^2 + \\alpha + \\beta');
    expect(editor.getMarkdown()).toContain('E = mc^2 + \\alpha + \\beta');

    editDisplayMath('\\gamma');
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('$$\n\\gamma\n$$');
    expect(markdown).not.toContain('E = mc^2 + \\alpha + \\beta');
    expect(markdown).toContain('After');
  });

  it('opens inline math editing with the latest rendered source', () => {
    editor = createMathEditor();
    editor.commands.setContent('Value $E$ here.', { contentType: 'markdown' });

    editInlineMath('E=mc^2');

    const inlineMath = document.querySelector('.math-inline-container');
    inlineMath?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const input = document.querySelector('.math-inline-editor') as HTMLInputElement | null;
    expect(input?.value).toBe('E=mc^2');
  });

  it('stores inline math source on the node view for export', () => {
    editor = createMathEditor();
    editor.commands.setContent('Value $E$ here.', { contentType: 'markdown' });

    let inlineMath = document.querySelector('.math-inline-container');
    expect(inlineMath?.getAttribute('data-latex')).toBe('E');

    editInlineMath('E=mc^2');

    inlineMath = document.querySelector('.math-inline-container');
    expect(inlineMath?.getAttribute('data-latex')).toBe('E=mc^2');
  });

  it('shows display math as literal fenced source when math rendering is disabled', () => {
    editor = createMathEditor({ renderMath: false, includeInlineMath: false });

    editor.commands.setContent('Before\n\n$$\nE = mc^2\n$$\n\nAfter', {
      contentType: 'markdown',
    });

    const rendered = document.querySelector('.math-block-rendered');
    expect(countNodes(editor, 'mathBlock')).toBe(1);
    expect(rendered?.textContent).toBe('$$\nE = mc^2\n$$');
    expect(rendered?.innerHTML).not.toContain('katex');
    expect(editor.getMarkdown()).toContain('$$\nE = mc^2\n$$');
  });
});

describe('installMathMarkedExtensions', () => {
  afterEach(() => {
    setMathMarkedTokenizerEnabled(true);
  });

  it('installs the marked extension only once', () => {
    const markedInstance = {
      use: jest.fn(),
    };

    installMathMarkedExtensions(markedInstance);
    installMathMarkedExtensions(markedInstance);

    expect(markedInstance.use).toHaveBeenCalledTimes(1);
  });

  it('can disable the display math tokenizer after installation', () => {
    const markedInstance = {
      use: jest.fn(),
    };

    installMathMarkedExtensions(markedInstance);
    const extension = markedInstance.use.mock.calls[0][0].extensions[0] as {
      start: (src: string) => number;
      tokenizer: (src: string) => unknown;
    };

    setMathMarkedTokenizerEnabled(false);

    expect(extension.start('$$\nE = mc^2\n$$')).toBe(-1);
    expect(extension.tokenizer('$$\nE = mc^2\n$$')).toBeUndefined();
  });
});

function editDisplayMath(nextSource: string): void {
  const container = document.querySelector('.math-block-container');
  container?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

  const textarea = document.querySelector('.math-block-editor') as HTMLTextAreaElement | null;
  if (!textarea) {
    throw new Error('Expected math block textarea to be present');
  }

  textarea.value = nextSource;
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function editInlineMath(nextSource: string): void {
  const container = document.querySelector('.math-inline-container');
  container?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

  const input = document.querySelector('.math-inline-editor') as HTMLInputElement | null;
  if (!input) {
    throw new Error('Expected inline math input to be present');
  }

  input.value = nextSource;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
