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
