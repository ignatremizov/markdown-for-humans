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
});
