/** @jest-environment node */

import { MarkdownManager } from '@tiptap/markdown';
import { Document } from '@tiptap/extension-document';
import { Text } from '@tiptap/extension-text';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { RawHtmlBlock } from '../../webview/extensions/rawHtmlBlock';

function createManager() {
  return new MarkdownManager({
    markedOptions: { gfm: true, breaks: true },
    extensions: [Document, MarkdownParagraph, Text, RawHtmlBlock],
  });
}

describe('RawHtmlBlock', () => {
  it('round-trips block-level raw HTML unchanged', () => {
    const manager = createManager();
    const markdown = ['<details>', '<summary>More</summary>', '<p>Hidden</p>', '</details>'].join(
      '\n'
    );

    expect(manager.serialize(manager.parse(markdown))).toBe(markdown);
  });
});
