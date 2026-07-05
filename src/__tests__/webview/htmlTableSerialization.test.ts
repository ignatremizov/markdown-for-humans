/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import {
  HtmlPreservingTable,
  tableRenderOptions,
} from '../../webview/extensions/htmlPreservingTable';

function createTableEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: false,
      }),
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: true,
        },
      }),
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
    ],
  });
}

describe('HTML table markdown serialization', () => {
  beforeEach(() => {
    tableRenderOptions.pipeStyle = 'padded';
  });

  afterEach(() => {
    tableRenderOptions.pipeStyle = 'padded';
  });

  it('preserves HTML tables with class attributes on save', () => {
    const editor = createTableEditor();

    const htmlTableMarkdown = [
      '<table class="sq-table">',
      '  <tr><th>Column A</th><th>Column B</th></tr>',
      '  <tr><td>Value 1</td><td>Value 2</td></tr>',
      '</table>',
    ].join('\n');

    try {
      editor.commands.setContent(htmlTableMarkdown, { contentType: 'markdown' });

      const serialized = editor.getMarkdown();
      expect(serialized).toContain('<table class="sq-table">');
      expect(serialized).toContain('<th>Column A</th>');
      expect(serialized).toContain('<td>Value 1</td>');
      expect(serialized).not.toContain('| Column A |');
    } finally {
      editor.destroy();
    }
  });

  it('preserves GFM table column alignment markers', () => {
    const editor = createTableEditor();

    try {
      editor.commands.setContent(
        '| Version | Amount | Status |\n|:-------:|-------:|:-------|\n| 1.0 | 100 | ok |',
        { contentType: 'markdown' }
      );

      const separator = editor.getMarkdown().trim().split('\n')[1];
      const cells = separator
        .split('|')
        .filter(Boolean)
        .map(cell => cell.trim());
      expect(cells[0]).toMatch(/^:-+:$/);
      expect(cells[1]).toMatch(/-+:$/);
      expect(cells[1]).not.toMatch(/^:/);
      expect(cells[2]).toMatch(/^:-+$/);
      expect(cells[2]).not.toMatch(/:$/);
    } finally {
      editor.destroy();
    }
  });

  it('keeps separator pipes aligned with header and body rows in padded mode', () => {
    const editor = createTableEditor();

    const pipePositions = (line: string) =>
      Array.from(line).reduce<number[]>((positions, char, index) => {
        if (char === '|') {
          positions.push(index);
        }
        return positions;
      }, []);

    try {
      editor.commands.setContent(
        [
          '| Version | Date | Approved by Top Management | Score |',
          '|:-------:|------|----------------------------:|------:|',
          '| 1.0 | 2025-01-01 | Yes | 42 |',
        ].join('\n'),
        { contentType: 'markdown' }
      );

      const lines = editor.getMarkdown().trim().split('\n');
      expect(pipePositions(lines[1])).toEqual(pipePositions(lines[0]));
      expect(pipePositions(lines[2])).toEqual(pipePositions(lines[0]));
    } finally {
      editor.destroy();
    }
  });

  it('supports compact separator rows without changing header or body rows', () => {
    const editor = createTableEditor();

    try {
      editor.commands.setContent('| Name | Score |\n|:-----|------:|\n| Alice | 100 |', {
        contentType: 'markdown',
      });

      tableRenderOptions.pipeStyle = 'padded';
      const paddedLines = editor.getMarkdown().trim().split('\n');

      tableRenderOptions.pipeStyle = 'compact';
      const compactLines = editor.getMarkdown().trim().split('\n');

      expect(compactLines[0]).toBe(paddedLines[0]);
      expect(compactLines[2]).toBe(paddedLines[2]);
      expect(compactLines[1]).not.toBe(paddedLines[1]);
      expect(compactLines[1]).not.toContain('| ');
      expect(compactLines[1]).not.toContain(' |');
    } finally {
      editor.destroy();
    }
  });

  it('escapes literal pipes inside GFM table cells', () => {
    const editor = createTableEditor();

    try {
      editor.commands.setContent('| h1 | h2 |\n| --- | --- |\n| x \\| y | value |', {
        contentType: 'markdown',
      });

      expect(editor.getMarkdown()).toContain('x \\| y');
    } finally {
      editor.destroy();
    }
  });
});
