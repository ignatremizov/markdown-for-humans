/** @jest-environment jsdom */

/**
 * Regression coverage for using a literal backtick as an inline-code shortcut
 * when text is selected in the WYSIWYG editor.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Marked, marked as defaultMarked } from 'marked';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { InlineCodeBacktickShortcut } from '../../webview/extensions/inlineCodeBacktickShortcut';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createEditor(initialMarkdown: string): Editor {
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
      InlineCodeBacktickShortcut,
      Markdown.configure({
        marked: marked as unknown as typeof defaultMarked,
        markedOptions: { gfm: true, breaks: true },
      }),
    ],
  });
}

function findTextRange(editor: Editor, selectedText: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return true;
    }

    const offset = node.text.indexOf(selectedText);
    if (offset === -1) {
      return true;
    }

    range = {
      from: pos + offset,
      to: pos + offset + selectedText.length,
    };
    return false;
  });

  if (!range) {
    throw new Error(`Could not find selected text: ${selectedText}`);
  }

  return range;
}

function createBacktickEvent(): KeyboardEvent & {
  preventDefault: jest.Mock;
  stopPropagation: jest.Mock;
} {
  return {
    key: '`',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  } as unknown as KeyboardEvent & {
    preventDefault: jest.Mock;
    stopPropagation: jest.Mock;
  };
}

describe('InlineCodeBacktickShortcut', () => {
  it('formats selected text as inline code instead of replacing it with a backtick', () => {
    const editor = createEditor('Alpha beta gamma.');
    const selection = findTextRange(editor, 'beta');
    editor.commands.setTextSelection(selection);
    const event = createBacktickEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(getEditorMarkdownForSync(editor)).toBe('Alpha `beta` gamma.');
    editor.destroy();
  });

  it('leaves empty selections alone so users can type literal backticks', () => {
    const editor = createEditor('Alpha beta gamma.');
    editor.commands.setTextSelection(findTextRange(editor, 'beta').from);
    const event = createBacktickEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBeFalsy();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(getEditorMarkdownForSync(editor)).toBe('Alpha beta gamma.');
    editor.destroy();
  });
});
