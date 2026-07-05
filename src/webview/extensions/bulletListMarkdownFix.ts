/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from '@tiptap/core';
import { BulletList } from '@tiptap/extension-list';

type BulletListToken = MarkdownToken & {
  type: 'list';
  ordered?: boolean;
  items?: MarkdownToken[];
};

function renderListItemContent(
  listItem: JSONContent,
  marker: string,
  helpers: MarkdownRendererHelpers
): string {
  const blocks = listItem.content ?? [];
  if (blocks.length === 0) return `${marker} `;

  const [firstBlock, ...rest] = blocks;
  const parts = [`${marker} ${helpers.renderChildren([firstBlock])}`];
  for (const block of rest) {
    const childContent = helpers.renderChildren([block]);
    if (!childContent) continue;
    parts.push(
      childContent
        .split('\n')
        .map(line => (line ? helpers.indent(line) : ''))
        .join('\n')
    );
  }

  return parts.join('\n');
}

export function parseBulletList(
  token: MarkdownToken,
  helpers: MarkdownParseHelpers
): JSONContent | JSONContent[] {
  const listToken = token as BulletListToken;
  if (listToken.type !== 'list' || listToken.ordered) return [];

  const items = Array.isArray(listToken.items) ? listToken.items : [];
  const firstRaw = (items[0] as { raw?: string } | undefined)?.raw ?? '';
  const markerChar = firstRaw.trimStart().charAt(0);
  const marker = ['-', '*', '+'].includes(markerChar) ? markerChar : '-';

  return {
    type: 'bulletList',
    attrs: { marker },
    content: items.length > 0 ? helpers.parseChildren(items) : [],
  };
}

export function renderBulletList(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  const marker = (node.attrs?.marker as string) ?? '-';
  if (!node.content?.length) return '';
  return node.content.map(item => renderListItemContent(item, marker, helpers)).join('\n');
}

export const BulletListMarkdownFix = BulletList.extend({
  addAttributes() {
    return {
      marker: { default: '-' },
    };
  },

  parseMarkdown: parseBulletList,

  renderMarkdown: renderBulletList,
});
