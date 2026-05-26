import {
  appearanceFromKind,
  effectiveAppearance,
  forcedThemeClass,
  resolveToggleTarget,
} from '../../shared/editorTheme';

// VS Code ColorThemeKind numeric values (stable API enum):
// Light = 1, Dark = 2, HighContrast = 3 (dark), HighContrastLight = 4
const LIGHT = 1;
const DARK = 2;
const HIGH_CONTRAST = 3;
const HIGH_CONTRAST_LIGHT = 4;

describe('appearanceFromKind', () => {
  it('maps the Light kind to light', () => {
    expect(appearanceFromKind(LIGHT)).toBe('light');
  });

  it('maps the Dark kind to dark', () => {
    expect(appearanceFromKind(DARK)).toBe('dark');
  });

  it('maps the HighContrast (dark) kind to dark', () => {
    expect(appearanceFromKind(HIGH_CONTRAST)).toBe('dark');
  });

  it('maps the HighContrastLight kind to light', () => {
    expect(appearanceFromKind(HIGH_CONTRAST_LIGHT)).toBe('light');
  });
});

describe('effectiveAppearance', () => {
  it('follows VS Code when the setting is "vscode"', () => {
    expect(effectiveAppearance('vscode', DARK)).toBe('dark');
    expect(effectiveAppearance('vscode', LIGHT)).toBe('light');
  });

  it('forces light regardless of VS Code when the setting is "defaultLight"', () => {
    expect(effectiveAppearance('defaultLight', DARK)).toBe('light');
  });

  it('forces dark regardless of VS Code when the setting is "defaultDark"', () => {
    expect(effectiveAppearance('defaultDark', LIGHT)).toBe('dark');
  });
});

describe('resolveToggleTarget', () => {
  it('writes light when the editor currently shows dark via VS Code', () => {
    expect(resolveToggleTarget('vscode', DARK)).toBe('defaultLight');
  });

  it('writes dark when the editor currently shows light via VS Code', () => {
    expect(resolveToggleTarget('vscode', LIGHT)).toBe('defaultDark');
  });

  it('writes light when the setting already forces dark', () => {
    expect(resolveToggleTarget('defaultDark', LIGHT)).toBe('defaultLight');
  });

  it('writes dark when the setting already forces light', () => {
    expect(resolveToggleTarget('defaultLight', DARK)).toBe('defaultDark');
  });

  it('treats HighContrast (dark) as dark and writes light', () => {
    expect(resolveToggleTarget('vscode', HIGH_CONTRAST)).toBe('defaultLight');
  });
});

describe('forcedThemeClass', () => {
  it('applies no override class when following VS Code', () => {
    expect(forcedThemeClass('vscode')).toBeNull();
  });

  it('applies the forced-light class when the setting is "defaultLight"', () => {
    expect(forcedThemeClass('defaultLight')).toBe('mdfh-force-light');
  });

  it('applies the forced-dark class when the setting is "defaultDark"', () => {
    expect(forcedThemeClass('defaultDark')).toBe('mdfh-force-dark');
  });
});
