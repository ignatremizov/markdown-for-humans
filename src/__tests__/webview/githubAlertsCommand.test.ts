/**
 * @jest-environment jsdom
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';

type EditorWithOptionalAlertCommand = Editor & {
  commands: Editor['commands'] & {
    removeGithubAlert?: () => boolean;
  };
};

function createEditor(content: Record<string, unknown>): EditorWithOptionalAlertCommand {
  const element = document.createElement('div');
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [StarterKit, GitHubAlerts],
    content,
  }) as EditorWithOptionalAlertCommand;
}

function selectInsideFirstTextNode(editor: Editor): void {
  let textPosition: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (node.isText) {
      textPosition = pos + 1;
      return false;
    }

    return true;
  });

  if (textPosition === null) {
    throw new Error('Expected test document to contain a text node');
  }

  editor.commands.setTextSelection(textPosition);
}

describe('GitHubAlerts remove command', () => {
  let editor: EditorWithOptionalAlertCommand | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.innerHTML = '';
  });

  it('converts the active GitHub alert to a normal blockquote without dropping content', () => {
    editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'githubAlert',
          attrs: { alertType: 'WARNING' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Keep this warning text' }],
            },
          ],
        },
      ],
    });

    selectInsideFirstTextNode(editor);

    expect(typeof editor.commands.removeGithubAlert).toBe('function');
    expect(editor.commands.removeGithubAlert?.()).toBe(true);

    const doc = editor.getJSON();

    expect(doc.content?.[0]).toEqual({
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Keep this warning text' }],
        },
      ],
    });
    expect(JSON.stringify(doc)).not.toContain('githubAlert');
  });

  it('does nothing when the selection is outside a GitHub alert', () => {
    editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Plain text' }],
        },
      ],
    });

    selectInsideFirstTextNode(editor);

    const before = editor.getJSON();

    expect(typeof editor.commands.removeGithubAlert).toBe('function');
    expect(editor.commands.removeGithubAlert?.()).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
});
