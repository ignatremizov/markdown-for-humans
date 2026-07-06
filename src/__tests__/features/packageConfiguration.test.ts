import packageJson from '../../../package.json';

describe('package configuration contributions', () => {
  const properties = packageJson.contributes.configuration.properties as Record<
    string,
    Record<string, unknown>
  >;

  it('exposes table pipe style in user and workspace settings', () => {
    const setting = properties['markdownForHumans.table.pipeStyle'];

    expect(setting).toMatchObject({
      type: 'string',
      enum: ['padded', 'compact'],
      default: 'padded',
      enumDescriptions: [
        'Separator row uses spaces: | :---: | --- |',
        'Separator row omits spaces: |:-----:|-----|',
      ],
    });
    expect(setting.scope).toBeUndefined();
  });

  it('exposes math rendering as a user and workspace setting', () => {
    const setting = properties['markdownForHumans.enableMath'];

    expect(setting).toMatchObject({
      type: 'boolean',
      default: true,
      description: 'Render LaTeX math expressions with KaTeX.',
    });
    expect(setting.scope).toBeUndefined();
  });

  it('exposes editor side margins as application settings', () => {
    const leftMargin = properties['markdownForHumans.layout.leftMargin'];
    const rightMargin = properties['markdownForHumans.layout.rightMargin'];
    const maxContentWidth = properties['markdownForHumans.layout.maxContentWidth'];

    expect(leftMargin).toMatchObject({
      type: 'number',
      default: 30,
      minimum: 0,
      maximum: 240,
      description: 'Left side margin for the editor in pixels. Default: 30px',
    });
    expect(leftMargin.scope).toBe('application');
    expect(rightMargin).toMatchObject({
      type: 'number',
      default: 30,
      minimum: 0,
      maximum: 240,
      description: 'Right side margin for the editor in pixels. Default: 30px',
    });
    expect(rightMargin.scope).toBe('application');
    expect(maxContentWidth).toMatchObject({
      type: 'number',
      default: 0,
      minimum: 0,
      maximum: 2400,
      description:
        'Maximum width of the editor content column in pixels. Set to 0 for no maximum. Default: 0',
    });
    expect(maxContentWidth.scope).toBe('application');
  });

  it('exposes Git diff peek scroll behavior as an application setting', () => {
    const setting = properties['markdownForHumans.git.diffPeekScrollBehavior'];

    expect(setting).toMatchObject({
      type: 'string',
      enum: ['smooth', 'snap'],
      enumDescriptions: [
        'Animate the editor viewport when opening or navigating between Git diff peeks.',
        'Jump immediately when opening or navigating between Git diff peeks.',
      ],
      default: 'smooth',
      description:
        'Controls whether Git diff peek navigation scrolls smoothly or snaps immediately.',
    });
    expect(setting.scope).toBe('application');
  });

  it('exposes PDF raw HTML/CSS export policy as a setting', () => {
    const setting = properties['markdownForHumans.export.pdfRawHtmlMode'];

    expect(setting).toMatchObject({
      type: 'string',
      enum: ['strict', 'styled', 'looseStyle', 'loose'],
      default: 'strict',
    });
    expect(setting.scope).toBe('application');
  });

  it('exposes Word raw HTML export policy as a setting', () => {
    const setting = properties['markdownForHumans.export.wordRawHtmlMode'];

    expect(setting).toMatchObject({
      type: 'string',
      enum: ['strict', 'loose'],
      default: 'strict',
    });
    expect(setting.scope).toBe('application');
  });

  it('exposes external local image export policy as a setting', () => {
    const setting = properties['markdownForHumans.export.externalLocalImages'];

    expect(setting).toMatchObject({
      type: 'string',
      enum: ['strip', 'include'],
      default: 'strip',
    });
    expect(setting.scope).toBe('application');
  });

  it('exposes export limitations warning as a setting', () => {
    const setting = properties['markdownForHumans.export.showLimitationsWarning'];

    expect(setting).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(setting.scope).toBe('application');
  });

  it('exposes Chrome executable path as an application setting', () => {
    const setting = properties['markdownForHumans.chromePath'];

    expect(setting).toMatchObject({
      type: 'string',
      default: '',
    });
    expect(setting.scope).toBe('application');
  });
});
