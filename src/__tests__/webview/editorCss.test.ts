import * as fs from 'fs';
import * as path from 'path';

describe('editor layout CSS', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../webview/editor.css'), 'utf8');

  it('keeps Git change markers out of prose when side margins are collapsed', () => {
    expect(css).toContain('--md-marker-left-reserve: 24px;');
    expect(css).toContain('--md-marker-right-reserve: 16px;');
    expect(css).toContain('padding-left: var(--md-marker-left-reserve);');
    expect(css).toContain('padding-right: var(--md-marker-right-reserve);');
    expect(css).toContain('--md-left-layout-margin: calc(');
    expect(css).toContain('--md-right-layout-margin: calc(');
  });

  it('uses max content width to split extra space into dynamic side margins', () => {
    expect(css).toContain('--md-content-max-width-default: 999999px;');
    expect(css).toContain('--md-layout-extra-margin: max(');
    expect(css).toContain('var(--md-content-max-width, var(--md-content-max-width-default))');
    expect(css).toContain(
      'calc(var(--md-right-layout-margin) + (var(--md-layout-extra-margin) * 0.5))'
    );
    expect(css).toContain(
      'calc(var(--md-left-layout-margin) + (var(--md-layout-extra-margin) * 0.5))'
    );
  });

  it('does not shadow configured max content width on the editor element', () => {
    expect(css).not.toContain('--md-content-max-width: 999999px;');
  });
});
