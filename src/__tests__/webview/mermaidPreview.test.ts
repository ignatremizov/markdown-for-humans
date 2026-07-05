/**
 * @jest-environment jsdom
 */

describe('showMermaidPreview', () => {
  let showMermaidPreview: (svgMarkup: string) => void;

  beforeEach(async () => {
    jest.resetModules();
    document.body.innerHTML = '';
    showMermaidPreview = (await import('../../webview/features/mermaidPreview')).showMermaidPreview;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not open an overlay for empty markup', () => {
    showMermaidPreview('   ');

    expect(document.querySelector('.mermaid-fullscreen-overlay')).toBeNull();
  });

  it('opens rendered SVG in a full-screen overlay with controls', () => {
    showMermaidPreview('<svg viewBox="0 0 200 100"><text>Diagram</text></svg>');

    const overlay = document.querySelector('.mermaid-fullscreen-overlay');
    expect(overlay).toBeInstanceOf(HTMLElement);
    expect(overlay?.querySelector('svg')).toBeInstanceOf(SVGElement);
    expect(overlay?.querySelector('.mermaid-fullscreen-zoom-label')?.textContent).toMatch(/%$/);

    const buttons = Array.from(overlay?.querySelectorAll('button') ?? []).map(
      button => button.getAttribute('aria-label') || button.textContent
    );
    expect(buttons).toEqual(['Zoom out', 'Zoom in', 'Reset zoom', 'Close preview']);
  });

  it('closes the overlay from Escape and the close button', () => {
    showMermaidPreview('<svg viewBox="0 0 200 100"></svg>');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.querySelector('.mermaid-fullscreen-overlay')).toBeNull();

    showMermaidPreview('<svg viewBox="0 0 200 100"></svg>');
    const closeButton = document.querySelector<HTMLButtonElement>('.mermaid-fullscreen-close');
    closeButton?.click();

    expect(document.querySelector('.mermaid-fullscreen-overlay')).toBeNull();
  });

  it('zooms with buttons and reset refits the diagram', () => {
    showMermaidPreview('<svg viewBox="0 0 200 100"></svg>');

    const label = document.querySelector('.mermaid-fullscreen-zoom-label');
    const initialZoom = label?.textContent;
    const zoomIn = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');
    const reset = document.querySelector<HTMLButtonElement>('button[aria-label="Reset zoom"]');

    zoomIn?.click();
    expect(label?.textContent).not.toBe(initialZoom);

    reset?.click();
    expect(label?.textContent).toBe(initialZoom);
  });
});
