/**
 * Pure helpers for the editor theme override feature.
 *
 * Kept free of any `vscode` import so the toggle logic can be unit-tested in
 * isolation. The extension host passes in the raw `ColorThemeKind` numeric
 * value from `vscode.window.activeColorTheme.kind`.
 */

/** The value of the `markdownForHumans.display.editorTheme` setting. */
export type EditorThemeSetting = 'vscode' | 'defaultLight' | 'defaultDark';

/** A forced theme the toolbar toggle can write back to the setting. */
export type ForcedTheme = 'defaultLight' | 'defaultDark';

/** The light/dark appearance the editor actually renders. */
export type Appearance = 'light' | 'dark';

/**
 * VS Code `ColorThemeKind` numeric values (stable enum):
 * Light = 1, Dark = 2, HighContrast = 3 (a dark variant), HighContrastLight = 4.
 * High-contrast dark counts as dark; high-contrast light counts as light.
 */
export function appearanceFromKind(kind: number): Appearance {
  return kind === 2 || kind === 3 ? 'dark' : 'light';
}

/**
 * Resolves what the editor currently shows: the forced value when the setting
 * pins light/dark, otherwise whatever VS Code's active theme implies.
 */
export function effectiveAppearance(setting: EditorThemeSetting, vscodeKind: number): Appearance {
  if (setting === 'defaultLight') return 'light';
  if (setting === 'defaultDark') return 'dark';
  return appearanceFromKind(vscodeKind);
}

/**
 * The toolbar toggle writes the opposite of the currently effective appearance,
 * so a single click always flips the visible theme.
 */
export function resolveToggleTarget(setting: EditorThemeSetting, vscodeKind: number): ForcedTheme {
  return effectiveAppearance(setting, vscodeKind) === 'dark' ? 'defaultLight' : 'defaultDark';
}

/**
 * The body class the webview applies for a given setting, or `null` to follow
 * VS Code's own theme (no override). Depends only on the setting: when forcing
 * a palette the VS Code theme is irrelevant.
 */
export function forcedThemeClass(setting: EditorThemeSetting): string | null {
  if (setting === 'defaultLight') return 'mdfh-force-light';
  if (setting === 'defaultDark') return 'mdfh-force-dark';
  return null;
}
