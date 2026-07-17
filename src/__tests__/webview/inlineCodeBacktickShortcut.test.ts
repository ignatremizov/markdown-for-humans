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
import {
  InlineCodeBacktickShortcut,
  toggleInlineCodeForMarkdown,
} from '../../webview/extensions/inlineCodeBacktickShortcut';
import { SoftBreakRendering } from '../../webview/extensions/softBreak';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import {
  EDITOR_MARKED_OPTIONS,
  installBlankLineLexerNormalizer,
} from '../../webview/utils/markedLexerNormalizer';
import { createFormattingToolbar } from '../../webview/BubbleMenuView';

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
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      BlankLinePreservation,
      SoftBreakRendering,
      InlineCodeBacktickShortcut,
      Markdown.configure({
        marked: marked as unknown as typeof defaultMarked,
        markedOptions: EDITOR_MARKED_OPTIONS,
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

function createModEEvent(): KeyboardEvent & {
  preventDefault: jest.Mock;
  stopPropagation: jest.Mock;
} {
  return {
    key: 'e',
    ctrlKey: true,
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

  it('normalizes selected soft wraps before applying inline code', () => {
    const editor = createEditor('Alpha beta\ngamma delta.');
    const selection = findTextRange(editor, 'beta\ngamma');
    editor.commands.setTextSelection(selection);
    const event = createBacktickEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe('Alpha `beta gamma` delta.');

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe('Alpha beta\ngamma delta.');

    editor.commands.redo();
    const reopened = createEditor(getEditorMarkdownForSync(editor));
    expect(getEditorMarkdownForSync(reopened)).toBe('Alpha `beta gamma` delta.');

    reopened.destroy();
    editor.destroy();
  });

  it('normalizes a selected explicit hard break and round-trips it as one code span', () => {
    const markdown = 'Alpha  \nbeta.';
    const editor = createEditor(markdown);
    const firstRange = findTextRange(editor, 'Alpha');
    const lastRange = findTextRange(editor, 'beta');
    editor.commands.setTextSelection({ from: firstRange.from, to: lastRange.to });

    expect(toggleInlineCodeForMarkdown(editor)).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe('`Alpha beta`.');

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    editor.commands.redo();

    const reopened = createEditor(getEditorMarkdownForSync(editor));
    expect(getEditorMarkdownForSync(reopened)).toBe('`Alpha beta`.');

    reopened.destroy();
    editor.destroy();
  });

  it('does not collapse multiline code blocks when the toolbar helper cannot apply inline code', () => {
    const markdown = '```text\nfirst_value\nsecond_value\n```';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(findTextRange(editor, 'first_value\nsecond_value'));

    expect(toggleInlineCodeForMarkdown(editor)).toBe(false);
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('rejects mixed-block selections without changing prose or code-block newlines', () => {
    const markdown = 'Alpha soft\nwrap.\n\n```text\ncode_one\ncode_two\n```\n\nOmega soft\nwrap.';
    const editor = createEditor(markdown);
    const firstRange = findTextRange(editor, 'Alpha soft\nwrap');
    const lastRange = findTextRange(editor, 'Omega soft\nwrap');
    editor.commands.setTextSelection({ from: firstRange.from, to: lastRange.to });

    expect(toggleInlineCodeForMarkdown(editor)).toBe(false);
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('lets a backtick over a rejected mixed-block selection use normal text input', () => {
    const markdown = 'Alpha soft\nwrap.\n\n```text\ncode_one\ncode_two\n```\n\nOmega soft\nwrap.';
    const editor = createEditor(markdown);
    const firstRange = findTextRange(editor, 'Alpha soft\nwrap');
    const lastRange = findTextRange(editor, 'Omega soft\nwrap');
    editor.commands.setTextSelection({ from: firstRange.from, to: lastRange.to });
    const event = createBacktickEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBeFalsy();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('lets a backtick replace selected code-block text through normal text input', () => {
    const markdown = '```text\nfirst_value\nsecond_value\n```';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(findTextRange(editor, 'first_value'));
    const event = createBacktickEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBeFalsy();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('consumes Mod+E over a rejected mixed-block selection before StarterKit handles it', () => {
    const markdown = 'Alpha soft\nwrap.\n\n```text\ncode_one\ncode_two\n```\n\nOmega soft\nwrap.';
    const editor = createEditor(markdown);
    const firstRange = findTextRange(editor, 'Alpha soft\nwrap');
    const lastRange = findTextRange(editor, 'Omega soft\nwrap');
    editor.commands.setTextSelection({ from: firstRange.from, to: lastRange.to });
    const event = createModEEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('routes Mod+E through stable soft-wrap normalization', () => {
    const markdown = 'Alpha beta\ngamma delta.';
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(findTextRange(editor, 'beta\ngamma'));
    const event = createModEEvent();

    const handled = editor.view.someProp('handleKeyDown', handler => handler(editor.view, event));

    expect(handled).toBe(true);
    expect(getEditorMarkdownForSync(editor)).toBe('Alpha `beta gamma` delta.');

    editor.commands.undo();
    expect(getEditorMarkdownForSync(editor)).toBe(markdown);

    editor.destroy();
  });

  it('keeps caret-only inline-code toggling available from the toolbar', () => {
    const editor = createEditor('Alpha gamma.');
    editor.commands.setTextSelection(findTextRange(editor, 'gamma').from);
    const toolbar = createFormattingToolbar(editor);
    document.body.appendChild(toolbar);
    window.dispatchEvent(new CustomEvent('editorFocusChange', { detail: { focused: true } }));
    const inlineCodeButton = toolbar.querySelector(
      '.toolbar-button.code-icon'
    ) as HTMLButtonElement;

    inlineCodeButton.click();
    editor.commands.insertContent('beta');

    expect(getEditorMarkdownForSync(editor)).toBe('Alpha `beta`gamma.');

    editor.destroy();
  });

  it('batches dense soft-wrap normalization within the toolbar interaction budget', () => {
    const sourceLines = Array.from({ length: 10_000 }, (_, index) => `source line ${index}`);
    const markdown = sourceLines.join('\n');
    const editor = createEditor(markdown);
    editor.commands.setTextSelection(findTextRange(editor, markdown));
    const dispatchedStepCounts: number[] = [];
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) {
        dispatchedStepCounts.push(transaction.steps.length);
      }
    });
    const startedAt = performance.now();

    expect(toggleInlineCodeForMarkdown(editor)).toBe(true);

    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(Math.max(...dispatchedStepCounts)).toBeLessThanOrEqual(2);
    expect(getEditorMarkdownForSync(editor)).toBe(`\`${sourceLines.join(' ')}\``);

    editor.destroy();
  });
});
