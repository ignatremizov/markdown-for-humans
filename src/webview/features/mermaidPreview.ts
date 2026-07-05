/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;

interface DiagramSize {
  width: number;
  height: number;
}

/**
 * Opens an already-rendered Mermaid SVG in a full-screen pan/zoom preview.
 */
export function showMermaidPreview(svgMarkup: string): void {
  if (!svgMarkup.trim()) return;

  const overlay = document.createElement('div');
  overlay.className = 'mermaid-fullscreen-overlay';

  const viewport = document.createElement('div');
  viewport.className = 'mermaid-fullscreen-viewport';

  const content = document.createElement('div');
  content.className = 'mermaid-fullscreen-content';
  content.innerHTML = svgMarkup;

  const svg = content.querySelector('svg') as SVGSVGElement | null;
  const naturalSize = svg ? getSvgNaturalSize(svg) : { width: 1, height: 1 };

  if (svg) {
    svg.style.maxWidth = 'none';
    svg.removeAttribute('width');
    svg.removeAttribute('height');
  }

  viewport.appendChild(content);

  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-fullscreen-toolbar';

  const zoomOutBtn = makeButton('-', 'Zoom out');
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'mermaid-fullscreen-zoom-label';
  const zoomInBtn = makeButton('+', 'Zoom in');
  const resetBtn = makeButton('Reset', 'Reset zoom');
  const closeBtn = makeButton('', 'Close preview');
  closeBtn.classList.add('mermaid-fullscreen-close');
  closeBtn.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';

  toolbar.append(zoomOutBtn, zoomLabel, zoomInBtn, resetBtn, closeBtn);
  overlay.append(viewport, toolbar);
  document.body.appendChild(overlay);

  let scale = 1;
  let translateX = 0;
  let translateY = 0;

  const applyTransform = () => {
    if (svg) {
      svg.style.width = `${naturalSize.width * scale}px`;
      svg.style.height = `${naturalSize.height * scale}px`;
    }
    content.style.transform = `translate(${translateX}px, ${translateY}px)`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  const fitToViewport = () => {
    const viewportRect = viewport.getBoundingClientRect();
    const fitScale = Math.min(
      (viewportRect.width * 0.92) / naturalSize.width,
      (viewportRect.height * 0.92) / naturalSize.height,
      1
    );

    scale = clamp(fitScale, MIN_SCALE, MAX_SCALE);
    translateX = (viewportRect.width - naturalSize.width * scale) / 2;
    translateY = (viewportRect.height - naturalSize.height * scale) / 2;
    applyTransform();
  };

  const zoomAt = (factor: number, originX: number, originY: number) => {
    const nextScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    const ratio = nextScale / scale;
    translateX = originX - (originX - translateX) * ratio;
    translateY = originY - (originY - translateY) * ratio;
    scale = nextScale;
    applyTransform();
  };

  const zoomCentered = (factor: number) => {
    const viewportRect = viewport.getBoundingClientRect();
    zoomAt(factor, viewportRect.width / 2, viewportRect.height / 2);
  };

  const close = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };

  viewport.addEventListener(
    'wheel',
    event => {
      event.preventDefault();
      const viewportRect = viewport.getBoundingClientRect();
      const originX = event.clientX - viewportRect.left;
      const originY = event.clientY - viewportRect.top;
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, originX, originY);
    },
    { passive: false }
  );

  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;
  let moved = false;

  viewport.addEventListener('mousedown', event => {
    isPanning = true;
    moved = false;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panOriginX = translateX;
    panOriginY = translateY;
    viewport.classList.add('panning');
    event.preventDefault();
  });

  function onMouseMove(event: MouseEvent) {
    if (!isPanning) return;

    if (Math.abs(event.clientX - panStartX) > 3 || Math.abs(event.clientY - panStartY) > 3) {
      moved = true;
    }

    translateX = panOriginX + event.clientX - panStartX;
    translateY = panOriginY + event.clientY - panStartY;
    applyTransform();
  }

  function onMouseUp(event: MouseEvent) {
    if (!isPanning) return;

    isPanning = false;
    viewport.classList.remove('panning');
    if (!moved && event.target === viewport) {
      close();
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key === '+' || event.key === '=') {
      zoomCentered(ZOOM_STEP);
      return;
    }

    if (event.key === '-' || event.key === '_') {
      zoomCentered(1 / ZOOM_STEP);
      return;
    }

    if (event.key === '0') {
      fitToViewport();
    }
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);

  zoomInBtn.addEventListener('click', () => zoomCentered(ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => zoomCentered(1 / ZOOM_STEP));
  resetBtn.addEventListener('click', fitToViewport);
  closeBtn.addEventListener('click', close);

  fitToViewport();
}

function getSvgNaturalSize(svg: SVGSVGElement): DiagramSize {
  const viewBox = svg.getAttribute('viewBox');
  const viewBoxParts =
    viewBox
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (viewBoxParts.length === 4 && viewBoxParts[2] > 0 && viewBoxParts[3] > 0) {
    return { width: viewBoxParts[2], height: viewBoxParts[3] };
  }

  const width = parseFloat(svg.getAttribute('width') ?? '');
  const height = parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }

  const rect = svg.getBoundingClientRect();
  return {
    width: rect.width || 1,
    height: rect.height || 1,
  };
}

function makeButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'mermaid-fullscreen-button';
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
