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
  RenderContext,
} from '@tiptap/core';
import { Table } from '@tiptap/extension-table';

type RenderMarkdownFn = (
  node: JSONContent,
  helpers: MarkdownRendererHelpers,
  ctx: RenderContext
) => string;

type MarkedTableToken = MarkdownToken & {
  header?: { tokens: MarkdownToken[] }[];
  rows?: { tokens: MarkdownToken[] }[][];
  align?: (string | null)[];
};

export type TablePipeStyle = 'padded' | 'compact';

/**
 * Runtime render options updated by the host whenever VS Code settings change.
 * TipTap calls renderMarkdown without extension instance state, so serialization
 * reads this shared option rather than rebuilding the extension.
 */
export const tableRenderOptions: { pipeStyle: TablePipeStyle } = {
  pipeStyle: 'padded',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectText(node: JSONContent): string {
  if (!node || typeof node !== 'object') {
    return '';
  }

  if (node.type === 'text') {
    return typeof node.text === 'string' ? node.text : '';
  }

  if (node.type === 'hardBreak' || node.type === 'hard_break') {
    return '\n';
  }

  if (!Array.isArray(node.content)) {
    return '';
  }

  return node.content.map(collectText).join('');
}

function renderTableCell(cell: JSONContent, tagName: 'th' | 'td'): string {
  const rawText = collectText(cell).trim();
  const escapedText = escapeHtml(rawText);
  return `<${tagName}>${escapedText}</${tagName}>`;
}

function makeSeparatorCell(width: number, align: string): string {
  if (align === 'center') return ':' + '-'.repeat(Math.max(1, width - 2)) + ':';
  if (align === 'left') return ':' + '-'.repeat(Math.max(2, width - 1));
  if (align === 'right') return '-'.repeat(Math.max(2, width - 1)) + ':';
  return '-'.repeat(Math.max(3, width));
}

function makeCompactSeparatorCell(width: number, align: string): string {
  if (align === 'center') return ':' + '-'.repeat(width) + ':';
  if (align === 'left') return ':' + '-'.repeat(width + 1);
  if (align === 'right') return '-'.repeat(width + 1) + ':';
  return '-'.repeat(width + 2);
}

function minSeparatorWidth(align: string): number {
  if (align === 'center') return 5;
  if (align === 'left' || align === 'right') return 4;
  return 3;
}

function padAligned(value: string, width: number, align: string): string {
  const padding = Math.max(0, width - value.length);

  if (padding === 0) {
    return value;
  }

  if (align === 'right') {
    return ' '.repeat(padding) + value;
  }

  if (align === 'center') {
    const leftPadding = Math.floor(padding / 2);
    return ' '.repeat(leftPadding) + value + ' '.repeat(padding - leftPadding);
  }

  return value + ' '.repeat(padding);
}

function escapeTablePipes(text: string): string {
  return text.replace(/(^|[^\\])\|/g, '$1\\|');
}

function renderGfmTableWithAlignment(node: JSONContent, h: MarkdownRendererHelpers): string {
  if (!node?.content?.length) return '';

  const rows: { text: string; isHeader: boolean }[][] = [];
  for (const rowNode of node.content) {
    const cells: { text: string; isHeader: boolean }[] = [];
    if (Array.isArray(rowNode.content)) {
      for (const cellNode of rowNode.content) {
        const content = cellNode.content ?? [];
        const raw =
          content.length > 1
            ? content.map((child: JSONContent) => h.renderChildren(child)).join('')
            : h.renderChildren(content);
        const text = escapeTablePipes((raw || '').replace(/\s+/g, ' ').trim());
        cells.push({ text, isHeader: cellNode.type === 'tableHeader' });
      }
    }
    rows.push(cells);
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) return '';

  const alignList = (typeof node.attrs?.align === 'string' ? node.attrs.align : '').split(',');
  const columnWidths = new Array<number>(columnCount).fill(3);
  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      columnWidths[i] = Math.max(columnWidths[i], row[i]?.text.length ?? 0);
    }
  }
  for (let i = 0; i < columnCount; i++) {
    columnWidths[i] = Math.max(columnWidths[i], minSeparatorWidth(alignList[i] ?? ''));
  }

  const headerRow = rows[0];
  const hasHeader = headerRow?.some(cell => cell.isHeader) ?? false;
  const headerTexts = new Array<string>(columnCount)
    .fill('')
    .map((_, i) => (hasHeader ? (headerRow[i]?.text ?? '') : ''));

  const headerLine = `| ${headerTexts
    .map((text, i) => padAligned(text, columnWidths[i], alignList[i] ?? ''))
    .join(' | ')} |`;
  const separatorLine =
    tableRenderOptions.pipeStyle === 'compact'
      ? `|${columnWidths
          .map((width, i) => makeCompactSeparatorCell(width, alignList[i] ?? ''))
          .join('|')}|`
      : `| ${columnWidths
          .map((width, i) => makeSeparatorCell(width, alignList[i] ?? ''))
          .join(' | ')} |`;

  let out = '\n';
  out += `${headerLine}\n`;
  out += `${separatorLine}\n`;

  const bodyRows = hasHeader ? rows.slice(1) : rows;
  for (const row of bodyRows) {
    out += `| ${new Array<number>(columnCount)
      .fill(0)
      .map((_, i) => padAligned(row[i]?.text ?? '', columnWidths[i], alignList[i] ?? ''))
      .join(' | ')} |\n`;
  }

  return out;
}

export const HtmlPreservingTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      htmlClass: {
        default: null,
        rendered: false,
        parseHTML: element => element.getAttribute('class'),
      },
      htmlOrigin: {
        default: false,
        rendered: false,
        parseHTML: () => true,
      },
      align: {
        default: '',
        rendered: false,
      },
    };
  },

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent | JSONContent[] {
    const tableToken = token as MarkedTableToken;
    if (tableToken.type !== 'table') {
      return [];
    }

    const rows: JSONContent[] = [];
    if (Array.isArray(tableToken.header)) {
      rows.push(
        helpers.createNode(
          'tableRow',
          {},
          tableToken.header.map(cell =>
            helpers.createNode('tableHeader', {}, [
              { type: 'paragraph', content: helpers.parseInline(cell.tokens) },
            ])
          )
        )
      );
    }

    if (Array.isArray(tableToken.rows)) {
      for (const row of tableToken.rows) {
        rows.push(
          helpers.createNode(
            'tableRow',
            {},
            row.map(cell =>
              helpers.createNode('tableCell', {}, [
                { type: 'paragraph', content: helpers.parseInline(cell.tokens) },
              ])
            )
          )
        );
      }
    }

    const align = Array.isArray(tableToken.align)
      ? tableToken.align.map(value => value ?? '').join(',')
      : '';
    return helpers.createNode('table', { align }, rows);
  },

  // Must be a regular function (not an arrow function) so that TipTap's
  // getExtensionField correctly binds `this.parent` to the base Table extension's
  // GFM renderMarkdown. Arrow functions ignore .bind(), so this.parent would be
  // undefined and GFM tables would be silently dropped on serialization.
  renderMarkdown: function (
    this: { parent: RenderMarkdownFn | null },
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    _context: RenderContext
  ): string {
    const htmlOrigin = Boolean(node.attrs?.htmlOrigin);
    if (!htmlOrigin) {
      return renderGfmTableWithAlignment(node, helpers);
    }

    const className =
      typeof node.attrs?.htmlClass === 'string' && node.attrs.htmlClass.trim().length > 0
        ? node.attrs.htmlClass.trim()
        : null;

    const rows = Array.isArray(node.content) ? node.content : [];
    const rowHtml = rows
      .map(row => {
        const cells = Array.isArray(row.content) ? row.content : [];
        const cellsHtml = cells
          .map(cell => renderTableCell(cell, cell.type === 'tableHeader' ? 'th' : 'td'))
          .join('');
        return `  <tr>${cellsHtml}</tr>`;
      })
      .join('\n');

    const tableOpenTag = className ? `<table class="${escapeHtml(className)}">` : '<table>';

    return `${tableOpenTag}\n${rowHtml}\n</table>`;
  },
});
