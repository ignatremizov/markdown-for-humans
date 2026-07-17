/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
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

function isModEKey(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === 'e' &&
    (event.ctrlKey || event.metaKey) &&
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

  return (
    selection.$from.parent === selection.$to.parent &&
    selection.$from.parent.inlineContent &&
    selection.$to.parent.inlineContent
  );
}

function normalizeSelectedInlineContent(editor: Editor, from: number, to: number): Fragment | null {
  const normalizedNodes: ProseMirrorNode[] = [];
  let changed = false;

  editor.state.doc.slice(from, to).content.forEach(node => {
    if (node.type.name === 'hardBreak') {
      normalizedNodes.push(editor.state.schema.text(' ', node.marks));
      changed = true;
      return;
    }

    if (node.isText && node.text?.includes('\n')) {
      normalizedNodes.push(editor.state.schema.text(node.text.replace(/\n/g, ' '), node.marks));
      changed = true;
      return;
    }

    normalizedNodes.push(node);
  });

  return changed ? Fragment.fromArray(normalizedNodes) : null;
}

/**
 * Inline code cannot preserve CommonMark soft line endings: code spans
 * normalize them to spaces when reparsed. Replace the selected inline fragment
 * in one transaction step before toggling the mark so the first serialization
 * is round-trip stable without quadratic decoration remapping.
 */
export function toggleInlineCodeForMarkdown(editor: Editor): boolean {
  if (editor.state.selection.empty) {
    return editor.chain().focus().toggleCode().run();
  }
  if (!canToggleInlineCodeForSelection(editor) || !editor.can().toggleCode()) {
    return false;
  }

  const { from, to } = editor.state.selection;
  const normalizedContent = normalizeSelectedInlineContent(editor, from, to);

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      if (normalizedContent) {
        tr.replaceWith(from, to, normalizedContent);
      }
      return true;
    })
    .toggleCode()
    .run();
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
  priority: 1000,

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        props: {
          handleKeyDown(_view, event) {
            const isPlainBacktick = isPlainBacktickKey(event);
            const isModE = isModEKey(event);
            if (!isPlainBacktick && !isModE) {
              return false;
            }

            if (!canToggleInlineCodeForSelection(editor)) {
              if (editor.state.selection.empty || isPlainBacktick) {
                return false;
              }
              event.preventDefault();
              event.stopPropagation();
              return true;
            }

            const handled = toggleInlineCodeForMarkdown(editor);
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
