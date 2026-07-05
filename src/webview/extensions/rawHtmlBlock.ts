/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from '@tiptap/core';

/**
 * Preserve block-level raw HTML as editable literal markdown.
 */
export function parseRawHtmlBlock(
  token: MarkdownToken,
  helpers: MarkdownParseHelpers
): JSONContent[] {
  if (token.type !== 'html') return [];

  const raw = typeof token.raw === 'string' ? token.raw : '';
  const content = raw.replace(/\n+$/, '');
  if (!content) return [];

  return [helpers.createNode('rawHtmlBlock', {}, [helpers.createTextNode(content)])];
}

export function renderRawHtmlBlock(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  return helpers.renderChildren(node.content ?? []);
}

export const RawHtmlBlock = Node.create({
  name: 'rawHtmlBlock',

  group: 'block',

  content: 'text*',

  marks: '',

  code: true,

  defining: true,

  isolating: true,

  parseHTML() {
    return [{ tag: 'pre[data-raw-html-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-raw-html-block': '',
        class: 'raw-html-block',
      }),
      ['code', { class: 'language-html' }, 0],
    ];
  },

  markdownTokenName: 'html',

  parseMarkdown: parseRawHtmlBlock,

  renderMarkdown: renderRawHtmlBlock,
});
