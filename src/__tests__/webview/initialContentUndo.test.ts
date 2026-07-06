/** @jest-environment jsdom */

/**
 * Regression coverage for opening a document in the custom editor and pressing
 * undo before making any edits.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Marked, marked as defaultMarked } from 'marked';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createProductionStyleEditor(initialMarkdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      BlankLinePreservation,
      Markdown.configure({
        markedOptions: { gfm: true, breaks: true },
      }),
    ],
  });

  const markdownStorage = editor as unknown as {
    markdown?: unknown;
    storage?: { markdown?: unknown };
  };
  installBlankLineLexerNormalizer(markdownStorage.markdown ?? markdownStorage.storage?.markdown);
  editor.commands.setContent(initialMarkdown, { contentType: 'markdown' });

  return editor;
}

function createConstructorSeededEditor(initialMarkdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const marked = new Marked();
  installBlankLineLexerNormalizer(marked);

  return new Editor({
    element,
    content: initialMarkdown,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      BlankLinePreservation,
      Markdown.configure({
        marked: marked as unknown as typeof defaultMarked,
        markedOptions: { gfm: true, breaks: true },
      }),
    ],
  });
}

describe('initial markdown content and undo history', () => {
  const initialMarkdown = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.';

  it('documents the previous post-init setContent failure mode', () => {
    const editor = createProductionStyleEditor(initialMarkdown);

    expect(getEditorMarkdownForSync(editor)).toBe(initialMarkdown);
    editor.commands.undo();

    expect(getEditorMarkdownForSync(editor)).not.toBe(initialMarkdown);
    expect(getEditorMarkdownForSync(editor)).toBe('');
    editor.destroy();
  });

  it('does not add the initial document load to undo history', () => {
    const editor = createConstructorSeededEditor(initialMarkdown);

    expect(getEditorMarkdownForSync(editor)).toBe(initialMarkdown);
    editor.commands.undo();

    expect(getEditorMarkdownForSync(editor)).toBe(initialMarkdown);
    editor.destroy();
  });
});
