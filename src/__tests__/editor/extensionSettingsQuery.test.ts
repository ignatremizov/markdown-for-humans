import { formatExtensionSettingsQuery } from '../../editor/MarkdownEditorProvider';

describe('formatExtensionSettingsQuery', () => {
  it('uses the active extension id when VS Code provides one', () => {
    expect(formatExtensionSettingsQuery('fork.publisher-id')).toBe('@ext:fork.publisher-id');
  });

  it('falls back to the published extension id when the active id is unavailable', () => {
    expect(formatExtensionSettingsQuery(undefined)).toBe('@ext:concretio.markdown-for-humans');
    expect(formatExtensionSettingsQuery('')).toBe('@ext:concretio.markdown-for-humans');
  });
});
