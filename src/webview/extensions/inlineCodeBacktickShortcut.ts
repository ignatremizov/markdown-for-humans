/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from 'prosemirror-state';

function isPlainBacktickKey(event: KeyboardEvent): boolean {
  return (
    event.key === '`' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}

function canToggleInlineCodeForSelection(editor: Editor): boolean {
  const { selection } = editor.state;
  const nodeSelection = selection as typeof selection & { node?: unknown };

  if (selection.empty || nodeSelection.node || editor.isActive('codeBlock')) {
    return false;
  }

  return selection.$from.parent.inlineContent && selection.$to.parent.inlineContent;
}

/**
 * Treat a plain backtick over selected prose as the Markdown inline-code gesture.
 *
 * Without this, the browser replaces the selected text with a literal "`", which
 * is surprising in a Markdown-first editor where users expect the source to gain
 * backtick delimiters around the selection.
 */
export const InlineCodeBacktickShortcut = Extension.create({
  name: 'inlineCodeBacktickShortcut',

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            if (!isPlainBacktickKey(event) || !canToggleInlineCodeForSelection(editor)) {
              return false;
            }

            const handled = editor.chain().focus().toggleCode().run();
            if (!handled) {
              return false;
            }

            event.preventDefault();
            event.stopPropagation();
            return true;
          },
        },
      }),
    ];
  },
});
