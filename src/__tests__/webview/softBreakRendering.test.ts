/** @jest-environment jsdom */

import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Marked, marked as defaultMarked } from 'marked';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { softBreakPluginKey, SoftBreakRendering } from '../../webview/extensions/softBreak';
import {
  EDITOR_MARKED_OPTIONS,
  installBlankLineLexerNormalizer,
} from '../../webview/utils/markedLexerNormalizer';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  const marked = new Marked();
  installBlankLineLexerNormalizer(marked);

  return new Editor({
    element,
    content: markdown,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({
        paragraph: false,
      }),
      MarkdownParagraph,
      SoftBreakRendering,
      Markdown.configure({
        marked: marked as unknown as typeof defaultMarked,
        markedOptions: EDITOR_MARKED_OPTIONS,
      }),
    ],
  });
}

function firstNode(editor: Editor): JSONContent {
  const node = editor.getJSON().content?.[0];
  if (!node) {
    throw new Error('Expected the parsed document to contain a block');
  }
  return node;
}

function findTextPosition(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result >= 0 || !node.isText || !node.text) return result < 0;
    const offset = node.text.indexOf(text);
    if (offset >= 0) {
      result = position + offset;
    }
    return result < 0;
  });
  return result;
}

function persistedDocumentJson(editor: Editor): JSONContent {
  const json = editor.getJSON();
  const content = [...(json.content ?? [])];
  while (
    content.at(-1)?.type === 'paragraph' &&
    (!content.at(-1)?.content || content.at(-1)?.content?.length === 0)
  ) {
    content.pop();
  }
  return { ...json, content };
}

function softBreakDecorationCount(editor: Editor): number {
  const decorations = softBreakPluginKey.getState(editor.state) as
    | { find(): unknown[] }
    | undefined;
  return decorations?.find().length ?? 0;
}

describe('soft-wrapped Markdown rendering', () => {
  it('renders source-wrapped prose as flowing text without changing its source boundary', () => {
    const markdown = 'Alpha section continues\non the next source line.';
    const editor = createEditor(markdown);

    expect(firstNode(editor)).toEqual({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: markdown,
        },
      ],
    });
    const softBreakBlock = editor.view.dom.querySelector('[data-soft-breaks="true"]');
    expect(softBreakBlock?.classList.contains('markdown-commonmark-whitespace-block')).toBe(true);
    expect(softBreakBlock?.textContent).toBe(markdown);
    expect(editor.view.dom.querySelector('[data-soft-break="true"]')).toBeNull();
    expect(editor.getHTML()).not.toContain('<br');
    expect(editor.getMarkdown()).toBe(markdown);
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('round-trips repeated spaces and tabs inside CommonMark-flowing prose', () => {
    const markdown = 'Alpha  beta\tgamma\nnext source line.';
    const editor = createEditor(markdown);

    expect(editor.view.dom.querySelector('.markdown-preserved-whitespace')).toBeNull();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('marks repeated spaces and tabs for CommonMark flow without a source newline', () => {
    const markdown = 'Alpha  beta\tgamma.';
    const editor = createEditor(markdown);

    const whitespaceBlock = editor.view.dom.querySelector('[data-commonmark-whitespace="true"]');
    expect(whitespaceBlock?.classList.contains('markdown-commonmark-whitespace-block')).toBe(true);
    expect(whitespaceBlock?.hasAttribute('data-soft-breaks')).toBe(false);
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('marks collapsible spaces split across adjacent formatted text nodes', () => {
    const editor = createEditor('Initial text.');
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Alpha ' },
            { type: 'text', text: 'formatted ', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' continuation.' },
          ],
        },
      ],
    });

    expect(editor.view.dom.querySelector('[data-commonmark-whitespace="true"]')).not.toBeNull();

    editor.destroy();
  });

  it('keeps one block decoration after distant edits', () => {
    const editor = createEditor('Alpha  beta gamma delta\nnext source line.');
    const nextLinePosition = findTextPosition(editor, 'next source line.');

    expect(softBreakDecorationCount(editor)).toBe(1);

    editor.commands.insertContentAt(nextLinePosition, 'one ');
    editor.commands.insertContentAt(nextLinePosition, 'two ');
    editor.commands.insertContentAt(nextLinePosition, 'three ');

    expect(softBreakDecorationCount(editor)).toBe(1);

    editor.destroy();
  });

  it('removes the block decoration with the final soft break', () => {
    const editor = createEditor('Alpha beta\nnext source line.');
    const newlinePosition = findTextPosition(editor, '\n');

    expect(softBreakDecorationCount(editor)).toBe(1);
    editor.commands.deleteRange({ from: newlinePosition, to: newlinePosition + 1 });

    expect(softBreakDecorationCount(editor)).toBe(0);

    editor.destroy();
  });

  it('keeps an adjacent soft-wrapped paragraph decorated after editing its neighbor', () => {
    const editor = createEditor('first  spaces\nwrap\n\nsecond  spaces\nwrap');

    expect(softBreakDecorationCount(editor)).toBe(2);
    expect(editor.view.dom.querySelectorAll('[data-soft-breaks="true"]')).toHaveLength(2);

    editor.commands.insertContentAt(1, 'Updated ');

    expect(softBreakDecorationCount(editor)).toBe(2);
    expect(editor.view.dom.querySelectorAll('[data-soft-breaks="true"]')).toHaveLength(2);

    editor.destroy();
  });

  it('preserves a soft source boundary when editing text on either side', () => {
    const editor = createEditor('Alpha section continues\non the next source line.');
    let softBreakPosition = -1;

    editor.state.doc.descendants((node, position) => {
      const newlineIndex = node.isText ? (node.text?.indexOf('\n') ?? -1) : -1;
      if (newlineIndex >= 0) {
        softBreakPosition = position + newlineIndex;
        return false;
      }
      return true;
    });

    expect(softBreakPosition).toBeGreaterThan(0);

    editor.commands.insertContentAt(1, 'Updated ');
    editor.commands.insertContentAt(softBreakPosition + 'Updated '.length + 1, 'also ');

    expect(getEditorMarkdownForSync(editor)).toBe(
      'Updated Alpha section continues\nalso on the next source line.'
    );

    editor.destroy();
  });

  it('joins source lines when the preserved soft boundary is deleted', () => {
    const editor = createEditor('First source line\nsecond source line.');
    const textNode = firstNode(editor).content?.[0];
    const newlineOffset = textNode?.text?.indexOf('\n') ?? -1;

    expect(newlineOffset).toBeGreaterThan(0);

    editor.commands.deleteRange({
      from: 1 + newlineOffset,
      to: 1 + newlineOffset + 1,
    });

    expect(getEditorMarkdownForSync(editor)).toBe('First source linesecond source line.');

    editor.destroy();
  });

  it('preserves soft wraps when joining the following paragraph', () => {
    const markdown = 'alpha\nbeta\n\nplain';
    const editor = createEditor(markdown);
    const plainPosition = findTextPosition(editor, 'plain');
    editor.commands.setTextSelection(plainPosition);

    expect(editor.commands.joinBackward()).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe('alpha\nbetaplain');

    const reopened = createEditor(getEditorMarkdownForSync(editor));
    expect(persistedDocumentJson(reopened)).toEqual(persistedDocumentJson(editor));

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.commands.redo();
    expect(getEditorMarkdownForSync(editor)).toBe('alpha\nbetaplain');

    reopened.destroy();
    editor.destroy();
  });

  it.each([
    ['before', 1, 'a  \na\nbb'],
    ['after', 4, 'aa\nb  \nb'],
  ])('preserves a hard break inserted %s an existing soft wrap', (_case, offset, expected) => {
    const markdown = 'aa\nbb';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(1 + offset);

    expect(editor.commands.setHardBreak()).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.commands.redo();
    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    editor.destroy();
  });

  it.each([
    ['immediately before', 2],
    ['immediately after', 3],
  ])('upgrades a soft boundary when a hard break is inserted %s it', (_case, offset) => {
    const markdown = 'aa\nbb';
    const expected = 'aa  \nbb';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(1 + offset);

    expect(editor.commands.setHardBreak()).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    const reopened = createEditor(getEditorMarkdownForSync(editor));
    expect(persistedDocumentJson(reopened)).toEqual(persistedDocumentJson(editor));

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.commands.redo();
    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    reopened.destroy();
    editor.destroy();
  });

  it.each([
    ['exactly the soft boundary', { from: 3, to: 4 }, 'aa  \nbb'],
    ['text around the soft boundary', { from: 2, to: 5 }, 'a  \nb'],
  ])('preserves a hard break replacing %s', (_case, selection, expected) => {
    const markdown = 'aa\nbb';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(selection);

    expect(editor.commands.setHardBreak()).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    const reopened = createEditor(getEditorMarkdownForSync(editor));
    expect(persistedDocumentJson(reopened)).toEqual(persistedDocumentJson(editor));

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.commands.redo();
    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    reopened.destroy();
    editor.destroy();
  });

  it.each([
    ['before', 2],
    ['after', 3],
  ])('consumes a soft boundary when splitting %s it', (_case, offset) => {
    const markdown = 'aa\nbb';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(1 + offset);

    expect(editor.commands.splitBlock()).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe('aa\n\nbb');

    const reopened = createEditor(getEditorMarkdownForSync(editor));
    expect(persistedDocumentJson(reopened)).toEqual(persistedDocumentJson(editor));

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.commands.redo();
    expect(getEditorMarkdownForSync(editor)).toBe('aa\n\nbb');

    reopened.destroy();
    editor.destroy();
  });

  it('preserves an explicit two-space hard break', () => {
    const editor = createEditor('First visible line.  \nSecond visible line.');

    expect(firstNode(editor).content?.map(node => node.type)).toEqual([
      'text',
      'hardBreak',
      'text',
    ]);

    editor.destroy();
  });

  it('removes soft-wrap styling when a paragraph becomes a code block and restores it on undo', () => {
    const markdown = 'First source line\nsecond source line.';
    const editor = createEditor(markdown);

    expect(editor.view.dom.querySelector('p[data-soft-breaks="true"]')).not.toBeNull();

    editor.commands.setTextSelection(2);
    editor.commands.setCodeBlock();

    expect(editor.view.dom.querySelector('pre[data-soft-breaks="true"]')).toBeNull();
    expect(editor.view.dom.querySelector('pre [data-soft-breaks="true"]')).toBeNull();
    expect(editor.view.dom.querySelector('pre')?.textContent).toBe(markdown);

    editor.commands.undo();

    expect(editor.view.dom.querySelector('p[data-soft-breaks="true"]')).not.toBeNull();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('restores flowing soft wraps when a code block becomes a paragraph', () => {
    const editor = createEditor('```text\nfirst_value\nsecond_value\n```');

    editor.commands.setTextSelection(2);
    editor.commands.toggleCodeBlock();

    expect(editor.view.dom.querySelector('p[data-soft-breaks="true"]')).not.toBeNull();
    expect(getEditorMarkdownForSync(editor)).toBe('first_value\nsecond_value');

    editor.destroy();
  });

  it('preserves explicit hard breaks in existing paragraphs during a code-block conversion', () => {
    const markdown =
      '```text\nfirst_value\nsecond_value\n```\n\nParagraph first.  \nParagraph second.';
    const editor = createEditor(markdown);
    let codeStart = -1;
    let paragraphEnd = -1;

    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'codeBlock') {
        codeStart = position + 1;
      }
      if (node.type.name === 'paragraph' && node.textContent.includes('Paragraph first.')) {
        paragraphEnd = position + node.nodeSize - 1;
      }
      return true;
    });

    expect(codeStart).toBeGreaterThan(0);
    expect(paragraphEnd).toBeGreaterThan(codeStart);

    editor.commands.setTextSelection({ from: codeStart, to: paragraphEnd });
    editor.commands.setParagraph();

    expect(getEditorMarkdownForSync(editor)).toBe(
      'first_value\nsecond_value\n\nParagraph first.  \nParagraph second.'
    );

    editor.destroy();
  });

  it('round-trips code-block blank lines after conversion to prose', () => {
    const editor = createEditor('```text\nalpha\n\nbeta\n```');
    editor.commands.setTextSelection(2);
    editor.commands.toggleCodeBlock();

    const markdown = getEditorMarkdownForSync(editor);
    const reopened = createEditor(markdown);

    expect(persistedDocumentJson(reopened)).toEqual(persistedDocumentJson(editor));

    reopened.destroy();
    editor.destroy();
  });

  it.each([
    ['leading', '```text\n\nalpha\n```', 'alpha'],
    ['trailing', '```text\nalpha\n\n```', 'alpha'],
    ['edge and internal', '```text\n\nalpha\n\nbeta\n\n```', 'alpha\n\nbeta'],
    ['multiple internal', '```text\nalpha\n\n\nbeta\n```', 'alpha\n\nbeta'],
  ])('normalizes %s blank lines when converting code to prose', (_case, source, expected) => {
    const editor = createEditor(source);
    editor.commands.setTextSelection(2);
    editor.commands.toggleCodeBlock();

    expect(getEditorMarkdownForSync(editor)).toBe(expected);

    const reopened = createEditor(expected);
    expect(persistedDocumentJson(reopened)).toEqual(persistedDocumentJson(editor));
    expect(getEditorMarkdownForSync(reopened)).toBe(expected);

    const reopenedAgain = createEditor(getEditorMarkdownForSync(reopened));
    expect(getEditorMarkdownForSync(reopenedAgain)).toBe(expected);

    reopenedAgain.destroy();
    reopened.destroy();
    editor.destroy();
  });

  it('normalizes soft wraps when converting a paragraph to a heading and restores them on undo', () => {
    const markdown = 'First source line\nsecond source line.';
    const editor = createEditor(markdown);

    editor.commands.setTextSelection(2);
    editor.commands.toggleHeading({ level: 2 });

    expect(getEditorMarkdownForSync(editor)).toBe('## First source line second source line.');

    editor.commands.undo();

    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    expect(editor.view.dom.querySelector('p[data-soft-breaks="true"]')).not.toBeNull();

    editor.destroy();
  });

  it('batches dense heading normalization within the toolbar interaction budget', () => {
    const sourceLines = Array.from({ length: 10_000 }, (_, index) => `source line ${index}`);
    const markdown = sourceLines.join('\n');
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(2);
    const dispatchedStepCounts: number[] = [];
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) {
        dispatchedStepCounts.push(transaction.steps.length);
      }
    });
    const startedAt = performance.now();

    expect(editor.commands.toggleHeading({ level: 2 })).toBe(true);

    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(Math.max(...dispatchedStepCounts)).toBeLessThanOrEqual(2);
    expect(getEditorMarkdownForSync(editor)).toBe(`## ${sourceLines.join(' ')}`);

    editor.destroy();
  });

  it('normalizes explicit hard breaks inserted into single-line headings', () => {
    const editor = createEditor('# Heading');
    editor.commands.setTextSelection('# Heading'.length);
    editor.commands.setHardBreak();
    editor.commands.insertContent('continuation');

    expect(getEditorMarkdownForSync(editor)).toBe('# Heading continuation');

    editor.destroy();
  });

  it('uses one block marker for a large soft-wrapped paragraph', () => {
    const markdown = Array.from({ length: 1000 }, (_, index) => `source line ${index}`).join('\n');
    const editor = createEditor(markdown);

    expect(editor.view.dom.querySelectorAll('[data-soft-breaks="true"]')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('[data-soft-break="true"]')).toHaveLength(0);

    editor.commands.insertContentAt(1, 'Updated ');

    expect(editor.view.dom.querySelectorAll('[data-soft-breaks="true"]')).toHaveLength(1);

    editor.destroy();
  });

  it('meets initialization and typing budgets for a 10,000-line paragraph', () => {
    const markdown = Array.from({ length: 10_000 }, (_, index) => `source line ${index}`).join(
      '\n'
    );
    const initializationStart = performance.now();
    const editor = createEditor(markdown);
    const initializationDuration = performance.now() - initializationStart;

    expect(initializationDuration).toBeLessThan(500);
    expect(editor.view.dom.querySelectorAll('[data-soft-breaks="true"]')).toHaveLength(1);

    const editingStart = performance.now();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      editor.commands.insertContentAt(1, 'x');
      editor.commands.deleteRange({ from: 1, to: 2 });
    }
    const averageTransactionDuration = (performance.now() - editingStart) / 10;

    expect(averageTransactionDuration).toBeLessThan(16);

    editor.destroy();
  });

  it('meets performance budgets with dense repeated prose whitespace', () => {
    const markdown = Array.from({ length: 10_000 }, (_, index) => `source  line ${index}`).join(
      '\n'
    );
    const initializationStart = performance.now();
    const editor = createEditor(markdown);
    const initializationDuration = performance.now() - initializationStart;

    expect(initializationDuration).toBeLessThan(500);
    expect(softBreakDecorationCount(editor)).toBe(1);

    const editingStart = performance.now();
    editor.commands.insertContentAt(1, 'x');
    editor.commands.deleteRange({ from: 1, to: 2 });
    const averageTransactionDuration = (performance.now() - editingStart) / 2;

    expect(averageTransactionDuration).toBeLessThan(16);

    editor.destroy();
  });

  it('flows wrapped inline formatting and list continuations', () => {
    const markdown =
      '**Emphasized text starts\nand continues.**\n\n- List item starts\n  and continues.';
    const editor = createEditor(markdown);

    expect(getEditorMarkdownForSync(editor)).toBe(
      '**Emphasized text starts\nand continues.**\n\n- List item starts\nand continues.'
    );

    editor.destroy();
  });

  it('preserves newlines inside fenced code blocks', () => {
    const editor = createEditor('```text\nfirst_value\nsecond_value\n```');

    expect(firstNode(editor)).toMatchObject({
      type: 'codeBlock',
      content: [
        {
          type: 'text',
          text: 'first_value\nsecond_value',
        },
      ],
    });
    expect(editor.view.dom.querySelector('pre [data-soft-breaks="true"]')).toBeNull();

    editor.destroy();
  });
});
