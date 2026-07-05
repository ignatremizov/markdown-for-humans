/** @jest-environment node */

import { MarkdownManager } from '@tiptap/markdown';
import { Document } from '@tiptap/extension-document';
import { Text } from '@tiptap/extension-text';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { BulletListMarkdownFix } from '../../webview/extensions/bulletListMarkdownFix';

function createManager() {
  return new MarkdownManager({
    markedOptions: { gfm: true, breaks: true },
    extensions: [
      Document,
      MarkdownParagraph,
      Text,
      ListKit.configure({ bulletList: false, orderedList: false }),
      BulletListMarkdownFix,
    ],
  });
}

describe('BulletListMarkdownFix', () => {
  it('preserves star bullet markers on round-trip', () => {
    const manager = createManager();
    const markdown = '* first\n* second';

    expect(manager.serialize(manager.parse(markdown))).toBe(markdown);
  });

  it('preserves plus bullet markers on round-trip', () => {
    const manager = createManager();
    const markdown = '+ first\n+ second';

    expect(manager.serialize(manager.parse(markdown))).toBe(markdown);
  });
});
