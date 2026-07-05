/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file documentExport.ts - PDF and Word document export
 * @description Handles exporting markdown documents to PDF (via local Chrome) and Word (via docx).
 * Applies export theme settings and embeds Mermaid diagrams as high-quality images.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import * as cheerio from 'cheerio';
import { imageSize } from 'image-size';

const nodeRequire = createRequire(__filename);
const KATEX_CSS_MARKER = '/* node_modules/katex/dist/katex.min.css */';
let cachedKatexExportStyles: string | null = null;

/**
 * Strip active content from HTML before passing it to Chrome for PDF rendering.
 *
 * The PDF export pipeline takes the editor's HTML and renders it via headless
 * Chrome with no Content-Security-Policy. Combined with markdown's
 * permissive `html: true` parser, ANY active content authored in a markdown
 * file would otherwise execute during export — script tags, event handlers,
 * iframes pointing at file:// URIs, javascript: hrefs.
 *
 * Removing the Chrome flag `--allow-file-access-from-files` (done in this
 * change) blocks file:// fetches from the rendered page, but defense in
 * depth still requires us to strip active content so a malicious markdown
 * file cannot embed credential prompts, fetch external resources, or run
 * Chrome zero-days against the user during export.
 *
 * Implementation uses `cheerio` (already a runtime dep) for parser-level
 * sanitization. We allow nothing implicitly; instead we deny-list the
 * specific dangerous tags / attributes / URI schemes. Benign markup
 * (paragraphs, tables, code, images with relative or data: src, anchors,
 * class, safe style declarations) passes through untouched in strict mode.
 * The export flow may switch to styled mode to preserve sanitized raw CSS,
 * looseStyle mode to preserve authored CSS while keeping strict HTML
 * filtering, or loose mode to preserve authored HTML/CSS, based on export
 * settings configured by the user.
 *
 * See SECURITY review §H3.
 */
export type ExportSanitizeMode = 'strict' | 'styled' | 'looseStyle' | 'loose';

export interface ExportSanitizeOptions {
  mode?: ExportSanitizeMode;
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_match, escaped: string) => {
    const hexMatch = escaped.match(/^([0-9a-fA-F]{1,6})\s?$/);
    if (!hexMatch) {
      return escaped;
    }

    const codePoint = Number.parseInt(hexMatch[1], 16);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      return '';
    }

    return String.fromCodePoint(codePoint);
  });
}

export function sanitizeExportHtml(html: string, options: ExportSanitizeOptions = {}): string {
  if (!html) {
    return '';
  }

  if (options.mode === 'loose') {
    return html;
  }

  const mode = options.mode ?? 'strict';

  // Wrap in a sentinel so we can extract just the body fragment back out
  // without cheerio injecting <html><head><body> wrappers.
  const $ = cheerio.load(`<div data-md4h-sanitize-root>${html}</div>`);

  // 1) Remove dangerous tags entirely (including their contents).
  const removedTags = [
    'script',
    'iframe',
    'object',
    'embed',
    'link',
    'meta',
    'base',
    'form',
    'input',
    'button',
    'textarea',
    'frame',
    'frameset',
    'applet',
    'audio',
    'video',
    'source',
    'track',
    'portal',
  ];
  if (mode === 'strict') {
    removedTags.push('style');
  }
  $(removedTags.join(', ')).remove();

  // 2) Strip every on* event handler and any URL-bearing attribute whose
  //    value uses a script-bearing scheme.
  const URL_LIKE_ATTRS = new Set([
    'href',
    'src',
    'srcset',
    'action',
    'formaction',
    'background',
    'poster',
    'data',
    'cite',
    'longdesc',
    'usemap',
    'profile',
    'manifest',
    'codebase',
    'classid',
    'icon',
    'xlink:href',
  ]);
  // Match javascript:/file:/vbscript: (with optional whitespace before the colon,
  // since HTML parsers tolerate it) OR any data: URI that isn't an image.
  // Note: data: URIs don't have a second colon, so they must be handled as a
  // separate branch rather than grouped with the scheme-colon pattern.
  const DANGEROUS_SCHEME = /^\s*(?:(?:javascript|file|vbscript)\s*:|data:(?!image\/))/i;
  const DANGEROUS_CSS = /(?:url\s*\(|@import|expression\s*\()/i;

  const sanitizeStyle = (style: string): string => {
    const safeDeclarations = style
      .split(';')
      .map(part => part.trim())
      .filter(part => part.length > 0 && !DANGEROUS_CSS.test(decodeCssEscapes(part)));
    return safeDeclarations.join(';');
  };

  const containsDangerousCss = (css: string): boolean => DANGEROUS_CSS.test(decodeCssEscapes(css));

  const stripEmptyCssRules = (styleSheet: string): string => {
    let previous = styleSheet;
    let next = previous.replace(/[^{}]+\{\s*\}/g, '');
    while (next !== previous) {
      previous = next;
      next = previous.replace(/[^{}]+\{\s*\}/g, '');
    }
    return next.trim();
  };

  const sanitizeStyleSheet = (styleSheet: string): string => {
    const parts = styleSheet.split(/([;}])/);
    const sanitizedParts: string[] = [];
    for (let index = 0; index < parts.length; index += 2) {
      const body = parts[index] ?? '';
      const delimiter = parts[index + 1] ?? '';
      const fragment = `${body}${delimiter}`;
      if (!containsDangerousCss(fragment)) {
        sanitizedParts.push(fragment);
        continue;
      }

      const lastOpenBrace = body.lastIndexOf('{');
      const prefix = lastOpenBrace >= 0 ? body.slice(0, lastOpenBrace + 1) : '';
      const closingBrace = delimiter === '}' ? '}' : '';
      sanitizedParts.push(`${prefix}${closingBrace}`);
    }

    return stripEmptyCssRules(sanitizedParts.join(''));
  };

  if (mode === 'styled') {
    $('style').each((_, el) => {
      const sanitized = sanitizeStyleSheet($(el).html() ?? '');
      if (sanitized.length > 0) {
        $(el).text(sanitized);
      } else {
        $(el).remove();
      }
    });
  }

  $('*').each((_, el) => {
    const tagEl = el as { attribs?: Record<string, string> };
    if (!tagEl.attribs) {
      return;
    }
    for (const attrName of Object.keys(tagEl.attribs)) {
      const lower = attrName.toLowerCase();
      if (lower.startsWith('on')) {
        $(el).removeAttr(attrName);
        continue;
      }
      if (lower === 'style') {
        if (mode === 'looseStyle') {
          continue;
        }

        const value = tagEl.attribs[attrName];
        const sanitized = typeof value === 'string' ? sanitizeStyle(value) : '';
        if (sanitized.length > 0) {
          $(el).attr(attrName, sanitized);
        } else {
          $(el).removeAttr(attrName);
        }
        continue;
      }
      if (URL_LIKE_ATTRS.has(lower)) {
        const value = tagEl.attribs[attrName];
        if (typeof value === 'string' && DANGEROUS_SCHEME.test(value)) {
          $(el).removeAttr(attrName);
        }
      }
    }
  });

  return $('[data-md4h-sanitize-root]').html() || '';
}

export function strictExportSanitizationWouldRewriteHtml(html: string): boolean {
  if (!html) {
    return false;
  }

  return sanitizeExportHtml(html, { mode: 'strict' }) !== html;
}

/**
 * Build a file:// base href for Chrome's export HTML.
 *
 * `pathToFileURL` handles platform separators and percent-encodes reserved
 * characters. Raw `file://${path}/` interpolation breaks paths with spaces,
 * `#`, `?`, and Windows drive syntax.
 */
export function buildFileBaseHrefForExport(documentBasePath: string): string {
  const withTrailingSeparator = documentBasePath.endsWith(path.sep)
    ? documentBasePath
    : `${documentBasePath}${path.sep}`;
  return pathToFileURL(withTrailingSeparator).href;
}

/**
 * Inline Mermaid PNGs captured by the webview into the HTML fragment sent to
 * export backends. The current webview normally does this before sending HTML,
 * but applying the images here keeps the backend robust if a wrapper or stale
 * placeholder reaches the extension side.
 */
export function inlineMermaidImagesForExport(html: string, mermaidImages: MermaidImage[]): string {
  if (!html || mermaidImages.length === 0) {
    return html;
  }

  const $ = cheerio.load(`<div data-md4h-mermaid-root>${html}</div>`);
  const root = $('[data-md4h-mermaid-root]');

  const createImage = (image: MermaidImage, index: number) => {
    const img = $('<img>');
    img.attr('src', image.pngDataUrl);
    img.attr('alt', `Mermaid diagram ${index + 1}`);
    img.attr('class', 'mermaid-export-image');
    img.attr('data-mermaid-id', image.id);
    return img;
  };

  mermaidImages.forEach((image, index) => {
    const candidates = root.find('[data-mermaid-id]').filter((_, el) => {
      return $(el).attr('data-mermaid-id') === image.id;
    });

    if (candidates.length > 0) {
      candidates.each((_, el) => {
        const target = $(el);
        if (target.is('img')) {
          target.attr('src', image.pngDataUrl);
          target.attr('class', 'mermaid-export-image');
        } else {
          target.replaceWith(createImage(image, index));
        }
      });
      return;
    }

    const wrapper = root.find('.mermaid-wrapper').eq(index);
    if (wrapper.length > 0) {
      wrapper.replaceWith(createImage(image, index));
    }
  });

  return root.html() || '';
}

/**
 * Mermaid image data
 */
export interface MermaidImage {
  id: string;
  pngDataUrl: string;
  originalSvg: string;
}

export type ExportExternalLocalImageMode = 'strip' | 'include';

const PDF_EXPORT_SANITIZE_MODES: readonly ExportSanitizeMode[] = [
  'strict',
  'styled',
  'looseStyle',
  'loose',
];
const WORD_EXPORT_SANITIZE_MODES: readonly ExportSanitizeMode[] = ['strict', 'loose'];

function isAllowedExportSanitizeMode(
  value: unknown,
  allowedModes: readonly ExportSanitizeMode[]
): value is ExportSanitizeMode {
  return typeof value === 'string' && allowedModes.includes(value as ExportSanitizeMode);
}

export function getConfiguredExportSanitizeMode(format: string): ExportSanitizeMode {
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  const isPdf = format === 'pdf';
  const settingKey = isPdf ? 'export.pdfRawHtmlMode' : 'export.wordRawHtmlMode';
  const allowedModes = isPdf ? PDF_EXPORT_SANITIZE_MODES : WORD_EXPORT_SANITIZE_MODES;
  const configuredMode = config.get<string>(settingKey, 'strict');

  return isAllowedExportSanitizeMode(configuredMode, allowedModes) ? configuredMode : 'strict';
}

export function getConfiguredExternalLocalImageMode(): ExportExternalLocalImageMode {
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  const configuredMode = config.get<string>('export.externalLocalImages', 'strip');
  return configuredMode === 'include' ? 'include' : 'strip';
}

export function getConfiguredExportLimitationsWarningEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  return config.get<boolean>('export.showLimitationsWarning', true);
}

/**
 * Get the document directory for file-based documents, or workspace folder/home directory for untitled files
 * Returns home directory if document is untitled and has no workspace
 */
function getDocumentBasePath(document: vscode.TextDocument): string {
  if (document.uri.scheme === 'file') {
    return path.dirname(document.uri.fsPath);
  }
  // For untitled files, use workspace folder as fallback
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    return workspaceFolder.uri.fsPath;
  }
  // Fallback to home directory for untitled files without workspace
  return os.homedir();
}

function realpathIfExists(targetPath: string): string | null {
  try {
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function expandHomePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }

  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

function getTrustedWordImageRoots(document: vscode.TextDocument): string[] {
  const roots = new Set<string>();

  if (document.uri.scheme === 'file') {
    roots.add(path.dirname(document.uri.fsPath));
  }

  const documentWorkspace = vscode.workspace.getWorkspaceFolder(document.uri);
  if (documentWorkspace) {
    roots.add(documentWorkspace.uri.fsPath);
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    roots.add(workspaceFolder.uri.fsPath);
  }

  return Array.from(roots)
    .map(root => realpathIfExists(root))
    .filter((root): root is string => Boolean(root));
}

/**
 * Resolve a DOCX local image source only when it lives under a trusted root.
 *
 * Word export receives HTML from the webview, including raw HTML authored in a
 * markdown file. A standalone `<img src="/private/file.png">` must not let the
 * exporter read arbitrary local files, so absolute and relative paths are
 * checked against the source document directory and open workspace roots before
 * `fs.readFileSync` is allowed.
 */
export function resolveTrustedWordImagePath(
  imageSource: string,
  document: vscode.TextDocument,
  externalLocalImages: ExportExternalLocalImageMode = 'strip'
): string | null {
  const trimmed = imageSource.trim();
  if (!trimmed) {
    return null;
  }

  if (/^(?:data|https?|vscode-webview):/i.test(trimmed)) {
    return null;
  }

  let decodedSource: string;
  if (/^file:/i.test(trimmed)) {
    try {
      decodedSource = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      return null;
    }

    try {
      decodedSource = decodeURIComponent(trimmed);
    } catch {
      decodedSource = trimmed;
    }
    decodedSource = expandHomePath(decodedSource);
  }
  const candidatePath = path.isAbsolute(decodedSource)
    ? decodedSource
    : path.resolve(getDocumentBasePath(document), decodedSource);
  const realCandidate = realpathIfExists(candidatePath);
  if (!realCandidate) {
    return null;
  }

  if (externalLocalImages === 'include') {
    return realCandidate;
  }

  const trustedRoots = getTrustedWordImageRoots(document);
  if (trustedRoots.some(root => isPathInsideRoot(realCandidate, root))) {
    return realCandidate;
  }

  return null;
}

function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return mimeTypes[ext] || 'image/png';
}

function imageFileToDataUrl(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:${getImageMimeType(filePath)};base64,${buffer.toString('base64')}`;
}

function isPdfBrowserSafeResourceSource(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith('#') || /^(?:data:|https?:|vscode-webview:|blob:)/i.test(trimmed);
}

function rewriteCssUrlsForPdfExport(
  css: string,
  document: vscode.TextDocument,
  externalLocalImages: ExportExternalLocalImageMode
): string {
  return decodeCssEscapes(css).replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
    (
      match,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined
    ) => {
      const source = (doubleQuoted ?? singleQuoted ?? bare ?? '').trim();
      if (!source || isPdfBrowserSafeResourceSource(source)) {
        return match;
      }

      const trustedImagePath = resolveTrustedWordImagePath(source, document, externalLocalImages);
      if (!trustedImagePath) {
        return 'none';
      }

      try {
        return `url("${imageFileToDataUrl(trustedImagePath)}")`;
      } catch (error) {
        console.warn('[MD4H] PDF export: Failed to inline local CSS resource:', error);
        return 'none';
      }
    }
  );
}

/**
 * Resolve or remove browser-fetching local resources before Chrome renders PDF HTML.
 *
 * PDF exports add a file:// base URL so normal relative document links resolve.
 * Without this pass, Chrome can also resolve relative image URLs like
 * `../../private/secret.svg` against that base and embed renderable local files
 * in a PDF. Local image resources are therefore inlined only when they resolve
 * under the document directory or workspace roots; untrusted local resource
 * attributes are removed even when raw HTML/CSS sanitization is loose.
 */
export function preparePdfHtmlResourcesForExport(
  html: string,
  document: vscode.TextDocument,
  _mode: ExportSanitizeMode,
  externalLocalImages: ExportExternalLocalImageMode = 'strip'
): string {
  if (!html) {
    return html;
  }

  const $ = cheerio.load(`<div data-md4h-pdf-resource-root>${html}</div>`);

  const rewriteResourceAttr = (
    el: Parameters<typeof $>[0],
    attrName: string,
    sourceOverride?: string
  ): void => {
    const source = (sourceOverride ?? $(el).attr(attrName) ?? '').trim();
    if (!source || isPdfBrowserSafeResourceSource(source)) {
      if (sourceOverride && source) {
        $(el).attr(attrName, source);
      }
      return;
    }

    const trustedImagePath = resolveTrustedWordImagePath(source, document, externalLocalImages);
    if (!trustedImagePath) {
      $(el).removeAttr(attrName);
      return;
    }

    try {
      $(el).attr(attrName, imageFileToDataUrl(trustedImagePath));
    } catch (error) {
      console.warn('[MD4H] PDF export: Failed to inline local image resource:', error);
      $(el).removeAttr(attrName);
    }
  };

  const rewriteSrcsetAttr = (el: Parameters<typeof $>[0], attrName: string): void => {
    const srcset = ($(el).attr(attrName) ?? '').trim();
    if (!srcset) {
      return;
    }

    const rewrittenCandidates = srcset
      .split(',')
      .map(candidate => candidate.trim())
      .filter(Boolean)
      .map(candidate => {
        const parts = candidate.split(/\s+/);
        const source = parts.shift() ?? '';
        const descriptor = parts.join(' ');

        if (!source || isPdfBrowserSafeResourceSource(source)) {
          return candidate;
        }

        const trustedImagePath = resolveTrustedWordImagePath(source, document, externalLocalImages);
        if (!trustedImagePath) {
          return null;
        }

        try {
          const dataUrl = imageFileToDataUrl(trustedImagePath);
          return descriptor ? `${dataUrl} ${descriptor}` : dataUrl;
        } catch (error) {
          console.warn('[MD4H] PDF export: Failed to inline local srcset resource:', error);
          return null;
        }
      })
      .filter((candidate): candidate is string => Boolean(candidate));

    if (rewrittenCandidates.length > 0) {
      $(el).attr(attrName, rewrittenCandidates.join(', '));
    } else {
      $(el).removeAttr(attrName);
    }
  };

  $('img').each((_, el) => {
    const markdownSrc = $(el).attr('data-markdown-src');
    const src = $(el).attr('src');
    rewriteResourceAttr(el, 'src', markdownSrc || src);
    $(el).removeAttr('data-markdown-src');
    $(el).removeAttr('srcset');
  });

  $('source').each((_, el) => {
    rewriteResourceAttr(el, 'src');
    rewriteSrcsetAttr(el, 'srcset');
  });

  $('image, feImage, use').each((_, el) => {
    rewriteResourceAttr(el, 'href');
    rewriteResourceAttr(el, 'xlink:href');
  });

  $('[background]').each((_, el) => {
    rewriteResourceAttr(el, 'background');
  });

  $('[poster]').each((_, el) => {
    rewriteResourceAttr(el, 'poster');
  });

  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (style) {
      $(el).attr('style', rewriteCssUrlsForPdfExport(style, document, externalLocalImages));
    }
  });

  $('style').each((_, el) => {
    const styleSheet = $(el).html();
    if (styleSheet) {
      $(el).text(rewriteCssUrlsForPdfExport(styleSheet, document, externalLocalImages));
    }
  });

  return $('[data-md4h-pdf-resource-root]').html() || '';
}

/**
 * Show export warning dialog and wait for user confirmation
 *
 * @param format - Export format ('pdf' or 'docx')
 * @returns true if user confirmed, false if cancelled
 */
async function showExportWarning(format: string): Promise<boolean> {
  if (!getConfiguredExportLimitationsWarningEnabled()) {
    return true;
  }

  const formatName = format === 'pdf' ? 'PDF' : 'Word';
  const message = `Export to ${formatName} works best with simple markdown files.\n\nKnown limitations:\n• Images (especially remote URLs)\n• Mermaid diagrams\n• Complex markdown structures\n\nSome content may not render correctly in the exported document.`;

  const action = await vscode.window.showWarningMessage(message, { modal: true }, 'I Understand');

  return action === 'I Understand';
}

/**
 * Export document to PDF or Word format
 *
 * @param format - Export format ('pdf' or 'docx')
 * @param html - HTML content from editor
 * @param mermaidImages - Mermaid diagrams as PNG data URLs
 * @param title - Document title
 * @param document - Source VS Code document
 */
export async function exportDocument(
  format: string,
  html: string,
  mermaidImages: MermaidImage[],
  title: string,
  document: vscode.TextDocument
): Promise<void> {
  // Show warning dialog and wait for user confirmation
  const userConfirmed = await showExportWarning(format);
  if (!userConfirmed) {
    return; // User cancelled
  }

  const sanitizeMode = getConfiguredExportSanitizeMode(format);
  const externalLocalImages = getConfiguredExternalLocalImageMode();

  // Convert all images (local and remote) to data URLs for embedding
  // html = await convertImagesToDataUrls(html, document);

  // Export theme is always light
  const exportTheme = 'light';

  // Show file save dialog
  const defaultFilename = title.replace(/[<>:"/\\|?*]/g, '-') || 'document';
  const extension = format === 'pdf' ? 'pdf' : 'docx';
  const filters: Record<string, string[]> = {};
  filters[format === 'pdf' ? 'PDF Document' : 'Word Document'] = [extension];

  const docBasePath = getDocumentBasePath(document);
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(docBasePath, `${defaultFilename}.${extension}`)),
    filters,
  });

  if (!saveUri) {
    return; // User cancelled
  }

  const uri = saveUri;

  // Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting to ${format.toUpperCase()}...`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        let exportSucceeded = false;

        if (format === 'pdf') {
          exportSucceeded = await exportToPDF(
            html,
            mermaidImages,
            exportTheme,
            uri.fsPath,
            progress,
            document,
            token,
            sanitizeMode,
            externalLocalImages
          );
        } else if (format === 'docx') {
          exportSucceeded = await exportToWord(
            html,
            mermaidImages,
            exportTheme,
            uri.fsPath,
            progress,
            document,
            sanitizeMode,
            externalLocalImages
          );
        }

        // Only show success message if export actually completed
        if (exportSucceeded) {
          vscode.window.showInformationMessage(
            `Document exported successfully to ${path.basename(uri.fsPath)}`
          );

          // Auto-open PDF in default viewer (only for PDF format)
          if (format === 'pdf') {
            try {
              // Verify file exists before opening
              if (fs.existsSync(uri.fsPath)) {
                await vscode.env.openExternal(vscode.Uri.file(uri.fsPath));
              }
            } catch (error) {
              // Log error but don't fail export - opening is a convenience feature
              console.warn('[MD4H] Failed to open PDF:', error);
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Export failed: ${errorMessage}`);
        console.error('[MD4H] Export error:', error);
      }
    }
  );
}

/**
 * Chrome path validation result
 */
export interface ChromeValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Minimal modal flow: validate existing Chrome path, auto-detect, or prompt user to supply one.
 * Returns a validated executable path or null if the user cancels.
 */
async function ensureChromePath(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<string | null> {
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  const report = (message: string, increment?: number) => {
    if (token.isCancellationRequested) {
      return;
    }
    progress.report({ message, increment });
  };

  // 1) Use configured path if valid
  const configuredRaw = config.get<string>('chromePath');
  if (configuredRaw) {
    const configuredPath = resolveChromeExecutable(configuredRaw);
    report('Validating configured Chrome path…', 20);
    const validation = await validateChromePath(configuredPath);
    if (validation.valid) {
      return configuredPath;
    }
  }

  // 2) Auto-detect common paths
  report('Detecting Chrome on this system…', 20);
  const detected = await findChromeExecutable();
  if (detected.path) {
    const detectedPath = resolveChromeExecutable(detected.path);
    const validation = await validateChromePath(detectedPath);
    if (validation.valid) {
      // Save for future runs
      await config.update('chromePath', detectedPath, vscode.ConfigurationTarget.Global);
      return detectedPath;
    }
  }

  // 3) Inline resolver: ask user to provide a path and validate it
  return await promptForChromePathInlineResolver(progress, token);
}

/**
 * Normalize platform-specific Chrome paths (e.g. macOS .app bundles → inner executable)
 */
function resolveChromeExecutable(rawPath: string): string {
  if (process.platform === 'darwin' && rawPath.endsWith('.app')) {
    const candidate = path.join(rawPath, 'Contents', 'MacOS', 'Google Chrome');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const chromiumCandidate = path.join(rawPath, 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(chromiumCandidate)) {
      return chromiumCandidate;
    }
  }
  return rawPath;
}

/**
 * Validate that a path points to a valid Chrome/Chromium executable
 *
 * @param chromePath - Path to validate
 * @returns Validation result with error message if invalid
 */
export async function validateChromePath(chromePath: string): Promise<ChromeValidationResult> {
  const executablePath = resolveChromeExecutable(chromePath);

  // Check if file exists
  if (!fs.existsSync(executablePath)) {
    return { valid: false, error: 'Chrome executable not found at the specified path' };
  }

  // Try running Chrome with --version to verify it's actually Chrome/Chromium
  try {
    await new Promise<void>((resolve, reject) => {
      const chromeProcess = spawn(executablePath, ['--version'], { stdio: 'ignore' });

      chromeProcess.once('error', error => {
        reject(new Error(`Failed to execute Chrome: ${error.message}`));
      });

      chromeProcess.once('exit', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Chrome exited with code ${code}`));
        }
      });
    });

    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'The specified file is not a valid Chrome/Chromium executable',
    };
  }
}

/**
 * Prompt user to configure Chrome path
 * Shows different dialogs based on whether Chrome was auto-detected
 *
 * @param detectedPath - Auto-detected Chrome path, or null if not found
 * @returns User-selected Chrome path, or null if cancelled
 */
export async function promptForChromePath(detectedPath: string | null): Promise<string | null> {
  if (detectedPath) {
    // Chrome was detected - offer to use it or choose different
    const choice = await vscode.window.showInformationMessage(
      `Chrome detected at:\n${detectedPath}\n\nWould you like to use this for PDF export?`,
      { modal: true },
      'Use This Path',
      'Choose Different Path',
      'Cancel'
    );

    if (choice === 'Use This Path') {
      return detectedPath;
    } else if (choice === 'Choose Different Path') {
      return await showChromeFilePicker();
    } else {
      return null; // Cancelled
    }
  } else {
    // Chrome not detected - offer to choose path or download
    const choice = await vscode.window.showInformationMessage(
      'Chrome/Chromium is required for PDF export but was not found on your system.\n\nYou can download Chrome or select an existing installation.',
      { modal: true },
      'Download Chrome',
      'Choose Chrome Path',
      'Cancel'
    );

    if (choice === 'Download Chrome') {
      // Open Chrome download page
      await vscode.env.openExternal(vscode.Uri.parse('https://www.google.com/chrome/'));
      return null; // User needs to install and try again
    } else if (choice === 'Choose Chrome Path') {
      return await showChromeFilePicker();
    } else {
      return null; // Cancelled
    }
  }
}

/**
 * Show file picker for selecting Chrome executable
 */
async function showChromeFilePicker(): Promise<string | null> {
  const platform = process.platform;
  const filters: Record<string, string[]> = {};

  if (platform === 'win32') {
    filters['Chrome/Chromium'] = ['exe'];
  } else if (platform === 'darwin') {
    filters['Chrome/Chromium'] = ['app'];
  } else {
    filters['Chrome/Chromium'] = ['*'];
  }

  const result = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: platform === 'darwin', // allow picking .app bundles
    canSelectMany: false,
    filters,
    title: 'Select Chrome/Chromium Executable',
  });

  if (result && result.length > 0) {
    return result[0].fsPath;
  }

  return null;
}

/**
 * Inline resolver used by the minimal modal flow.
 * Re-prompts until a valid Chrome path is provided or the user cancels.
 */
async function promptForChromePathInlineResolver(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<string | null> {
  let lastError: string | undefined;
  let lastValue: string | undefined;

  while (!token.isCancellationRequested) {
    const choice = await vscode.window.showInformationMessage(
      lastError
        ? `Chrome is required for PDF export.\nLast check failed: ${lastError}`
        : 'Chrome is required for PDF export. Provide a path to Chrome/Chromium.',
      { modal: true },
      'Browse…',
      'Enter Path',
      'Download Chrome',
      'Cancel'
    );

    if (!choice || choice === 'Cancel') {
      return null;
    }

    if (choice === 'Download Chrome') {
      await vscode.env.openExternal(vscode.Uri.parse('https://www.google.com/chrome/'));
      continue;
    }

    let candidate: string | null = null;

    if (choice === 'Browse…') {
      const picked = await showChromeFilePicker();
      candidate = picked ?? null;
    } else if (choice === 'Enter Path') {
      const input = await vscode.window.showInputBox({
        title: 'Enter Chrome/Chromium executable path',
        value: lastValue,
        prompt:
          'Examples:\n- /Applications/Google Chrome.app/Contents/MacOS/Google Chrome (macOS)\n- C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe (Windows)\n- /usr/bin/google-chrome (Linux)',
        ignoreFocusOut: true,
      });
      candidate = input ?? null;
      lastValue = input ?? lastValue;
    }

    if (!candidate) {
      lastError = 'No path selected';
      continue;
    }

    // Validate with progress feedback
    if (token.isCancellationRequested) {
      return null;
    }
    progress.report({ message: 'Validating Chrome path…' });
    const validation = await validateChromePath(candidate);
    if (validation.valid) {
      const resolved = resolveChromeExecutable(candidate);
      const config = vscode.workspace.getConfiguration('markdownForHumans');
      await config.update('chromePath', resolved, vscode.ConfigurationTarget.Global);
      return resolved;
    }

    lastError = validation.error || 'Invalid Chrome path';
    await vscode.window.showErrorMessage(
      `Chrome not ready: ${lastError}. Please choose a valid Chrome/Chromium executable.`
    );
  }

  return null;
}

/**
 * Export to PDF using the user's local Chrome/Chromium installation
 *
 * @returns true if export succeeded, false if user cancelled
 */
async function exportToPDF(
  html: string,
  mermaidImages: MermaidImage[],
  theme: string,
  outputPath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
  sanitizeMode: ExportSanitizeMode,
  externalLocalImages: ExportExternalLocalImageMode
): Promise<boolean> {
  progress.report({ message: 'Preparing PDF export…', increment: 20 });

  const chromePath = await ensureChromePath(progress, token);
  if (!chromePath) {
    return false;
  }

  // Build complete HTML document
  const exportHtml = preparePdfHtmlResourcesForExport(
    inlineMermaidImagesForExport(html, mermaidImages),
    document,
    sanitizeMode,
    externalLocalImages
  );
  const completeHtml = buildExportHTML(exportHtml, theme, 'pdf', { mode: sanitizeMode });

  // Set content with the document's directory as the base URL
  // This allows relative paths (src="./foo.png") to be resolved correctly by Chrome
  const docDir = getDocumentBasePath(document);

  // Inject base tag to ensure relative paths are resolved correctly
  const htmlWithBase = completeHtml.replace(
    '<head>',
    `<head><base href="${buildFileBaseHrefForExport(docDir)}">`
  );

  // Write the HTML to a temp file for Chrome to print
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'md4h-export-'));
  const tempHtmlPath = path.join(tempDir, 'export.html');

  try {
    await fs.promises.writeFile(tempHtmlPath, htmlWithBase, 'utf8');
  } catch (error) {
    throw new Error(`Failed to write temporary HTML for export: ${error}`);
  }

  try {
    progress.report({ message: 'Launching Chrome...', increment: 20 });

    // SECURITY: `--allow-file-access-from-files` was REMOVED here. Chromium
    // documents that flag as "intended for testing only — do not use it on
    // builds distributed to end users." Combined with markdown's `html: true`
    // parser, it allowed a hostile .md file to embed
    //   <script>fetch('file:///Users/<u>/.ssh/id_ed25519').then(...)</script>
    // and exfiltrate the contents into the PDF the user just saved.
    // See SECURITY review §H3.
    const chromeArgs = [
      '--headless=chrome',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage',
      '--print-to-pdf=' + outputPath,
      pathToFileURL(tempHtmlPath).href,
    ];

    progress.report({ message: 'Rendering PDF...', increment: 30 });
    await runChrome(chromePath, chromeArgs);
    progress.report({ increment: 20 });
    return true; // Export succeeded
  } catch (error) {
    // Surface a user-friendly error
    const errMessage =
      error instanceof Error ? error.message : 'Unknown error while exporting to PDF';
    throw new Error(errMessage);
  } finally {
    // Clean up temp files
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn('[MD4H] Failed to clean up temporary export directory:', cleanupError);
    }
  }
}

async function runChrome(executablePath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows, use CREATE_NO_WINDOW flag to prevent any window from showing
    const spawnOptions: {
      stdio: 'ignore';
      windowsHide?: boolean;
      detached?: boolean;
      shell?: boolean;
    } = {
      stdio: 'ignore',
    };

    if (process.platform === 'win32') {
      // Prevent any window from appearing on Windows
      spawnOptions.windowsHide = true;
      spawnOptions.detached = false;
      spawnOptions.shell = false;
    }

    const chromeProcess = spawn(executablePath, args, spawnOptions);

    chromeProcess.once('error', error => {
      reject(
        new Error(`Failed to launch Chrome: ${error instanceof Error ? error.message : error}`)
      );
    });

    chromeProcess.once('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Chrome exited with code ${code}. Install or point to a working Chrome/Chromium via "markdownForHumans.chromePath".`
          )
        );
      }
    });
  });
}

/**
 * Chrome detection result
 */
export interface ChromeDetectionResult {
  path: string | null;
  detected: boolean; // true if auto-detected, false if user-configured or not found
}

/**
 * Find Chrome executable path
 * Returns result object instead of throwing to allow graceful handling
 *
 * @returns Chrome path and whether it was auto-detected
 */
export async function findChromeExecutable(): Promise<ChromeDetectionResult> {
  // User-configured path takes precedence
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  const customChromePathRaw = config.get<string>('chromePath');
  const customChromePath = customChromePathRaw
    ? resolveChromeExecutable(customChromePathRaw)
    : undefined;
  if (customChromePath && fs.existsSync(customChromePath)) {
    return { path: customChromePath, detected: false };
  }

  // Common environment variable hints
  const envCandidates = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH].filter(
    Boolean
  ) as string[];
  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, detected: true };
    }
  }

  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Chromium\\Application\\chrome.exe'
    );
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }

  // Add PATH-based lookup for common binary names
  const pathExecutables =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const binary of pathExecutables) {
      candidates.push(path.join(dir, binary));
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, detected: true };
    }
  }

  return { path: null, detected: false };
}

/**
 * Export to Word using docx library
 *
 * @returns true if export succeeded
 */
async function exportToWord(
  html: string,
  mermaidImages: MermaidImage[],
  theme: string,
  outputPath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  document: vscode.TextDocument,
  sanitizeMode: ExportSanitizeMode,
  externalLocalImages: ExportExternalLocalImageMode
): Promise<boolean> {
  progress.report({ message: 'Converting to Word format...', increment: 30 });

  try {
    const docxModule = await import('docx');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docx = (docxModule as any).default ?? docxModule;

    progress.report({ message: 'Building document...', increment: 30 });

    // Parse HTML and convert to docx elements
    const exportHtml = sanitizeExportHtml(inlineMermaidImagesForExport(html, mermaidImages), {
      mode: sanitizeMode,
    });
    const children = await htmlToDocx(exportHtml, docx, theme, document, externalLocalImages);

    const doc = new docx.Document({
      sections: [
        {
          properties: {},
          children,
        },
      ],
    });

    progress.report({ message: 'Saving Word document...', increment: 20 });

    // Generate buffer and write to file
    const buffer = await docx.Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    progress.report({ increment: 20 });
    return true; // Export succeeded
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (error && (error as any).code === 'MODULE_NOT_FOUND') {
      throw new Error('Word export requires docx library. Install with: npm install docx');
    }
    throw error;
  }
}

/**
 * Build complete HTML document for PDF export with styling
 */
export function buildExportHTML(
  contentHtml: string,
  theme: string,
  _format: 'pdf' | 'html',
  sanitizeOptions: ExportSanitizeOptions = {}
): string {
  const styles = getExportStyles(theme);
  // SECURITY: strip script tags, on* handlers, and javascript:/file: URIs
  // before rendering with Chrome. See sanitizeExportHtml() docstring above
  // and SECURITY review §H3.
  const safeContent = sanitizeExportHtml(contentHtml, sanitizeOptions);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        ${styles}
      </style>
    </head>
    <body>
      <div class="content">
        ${safeContent}
      </div>
    </body>
    </html>
  `;
}

/**
 * Get CSS styles for exported documents
 */
function getExportStyles(theme: string): string {
  const baseStyles = `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Charter', 'Georgia', 'Cambria', 'Times New Roman', serif;
      font-size: 16px;
      line-height: 1.6;
      color: ${theme === 'light' ? '#1a1a1a' : '#e0e0e0'};
      background: ${theme === 'light' ? '#ffffff' : '#1e1e1e'};
    }

    .content {
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
    }

    h1, h2, h3, h4, h5, h6 {
      font-weight: 600;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }

    h1 { font-size: 2.5em; margin-top: 0; }
    h2 { font-size: 2em; }
    h3 { font-size: 1.5em; }
    h4 { font-size: 1.25em; }
    h5 { font-size: 1.1em; }
    h6 { font-size: 1em; }

    p {
      margin-bottom: 1em;
    }

    code {
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      background: ${theme === 'light' ? '#f5f5f5' : '#2d2d2d'};
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }

    pre {
      background: ${theme === 'light' ? '#f5f5f5' : '#2d2d2d'};
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin-bottom: 1em;
    }

    pre code {
      background: none;
      padding: 0;
    }

    blockquote {
      border-left: 4px solid ${theme === 'light' ? '#ddd' : '#444'};
      padding-left: 16px;
      margin: 1em 0;
      color: ${theme === 'light' ? '#666' : '#aaa'};
    }

    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }

    th, td {
      border: 1px solid ${theme === 'light' ? '#ddd' : '#444'};
      padding: 8px 12px;
      text-align: left;
    }

    th {
      background: ${theme === 'light' ? '#f5f5f5' : '#2d2d2d'};
      font-weight: 600;
    }

    ul, ol {
      margin-left: 2em;
      margin-bottom: 1em;
    }

    li {
      margin-bottom: 0.5em;
    }

    img, .mermaid-export-image {
      max-width: 100%;
      height: auto;
      margin: 1em 0;
    }

    a {
      color: ${theme === 'light' ? '#0066cc' : '#4dabf7'};
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }
  `;

  return `
    ${baseStyles}
    ${getKatexExportStyles()}

    .math-block-container {
      margin: 1em 0;
    }

    .math-block-rendered {
      text-align: center;
    }

    .math-inline-container {
      display: inline;
    }

    .math-block-tooltip,
    .math-block-editor,
    .math-inline-editor {
      display: none !important;
    }
  `;
}

function getKatexExportStyles(): string {
  if (cachedKatexExportStyles !== null) {
    return cachedKatexExportStyles;
  }

  const cssSource = readKatexCssSource();
  if (!cssSource) {
    cachedKatexExportStyles = '';
    return cachedKatexExportStyles;
  }

  cachedKatexExportStyles = inlineKatexFontUrls(cssSource.css, cssSource.baseDir);
  return cachedKatexExportStyles;
}

function readKatexCssSource(): { css: string; baseDir: string } | null {
  const bundledCssPath = path.join(__dirname, 'webview.css');
  try {
    if (fs.existsSync(bundledCssPath)) {
      const bundledCss = fs.readFileSync(bundledCssPath, 'utf8');
      const markerIndex = bundledCss.indexOf(KATEX_CSS_MARKER);
      if (markerIndex >= 0) {
        return { css: bundledCss.slice(markerIndex), baseDir: __dirname };
      }
    }
  } catch (error) {
    console.warn('[MD4H] PDF export: Failed to read bundled KaTeX CSS:', error);
  }

  const workspaceKatexCssPath = path.join(
    process.cwd(),
    'node_modules',
    'katex',
    'dist',
    'katex.min.css'
  );
  try {
    if (fs.existsSync(workspaceKatexCssPath)) {
      return {
        css: fs.readFileSync(workspaceKatexCssPath, 'utf8'),
        baseDir: path.dirname(workspaceKatexCssPath),
      };
    }
  } catch (error) {
    console.warn('[MD4H] PDF export: Failed to read workspace KaTeX CSS:', error);
  }

  try {
    const katexCssPath = nodeRequire.resolve('katex/dist/katex.min.css');
    const css = fs.readFileSync(katexCssPath, 'utf8');
    if (css.includes('@font-face') && css.includes('.katex')) {
      return {
        css,
        baseDir: path.dirname(katexCssPath),
      };
    }
  } catch (error) {
    console.warn('[MD4H] PDF export: Failed to read KaTeX CSS:', error);
  }

  return null;
}

function inlineKatexFontUrls(css: string, baseDir: string): string {
  return css.replace(/url\((["']?)([^)"']+\.(?:woff2?|ttf))\1\)/g, (match, _quote, urlPath) => {
    const fontPath = path.resolve(baseDir, urlPath.replace(/^\.\//, ''));
    try {
      const buffer = fs.readFileSync(fontPath);
      const mimeType = getFontMimeType(fontPath);
      return `url("data:${mimeType};base64,${buffer.toString('base64')}")`;
    } catch {
      return match;
    }
  });
}

function getFontMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.woff2') {
    return 'font/woff2';
  }
  if (ext === '.woff') {
    return 'font/woff';
  }
  if (ext === '.ttf') {
    return 'font/ttf';
  }
  return 'application/octet-stream';
}

/**
 * Convert HTML to docx elements using Cheerio for reliable parsing
 * Handles headings, paragraphs, lists, tables, and images with nested tags
 */
interface ExportCheerioSelection {
  attr(name: string): string | undefined;
  hasClass(name: string): boolean;
  find(selector: string): ExportCheerioSelection;
  first(): ExportCheerioSelection;
  text(): string;
}

interface ExportCheerioStatic {
  (node: unknown): ExportCheerioSelection;
}

function isMathBlockElement($el: ExportCheerioSelection, tagName: string): boolean {
  return (
    tagName === 'div' &&
    ($el.hasClass('math-block-container') ||
      $el.hasClass('math-block') ||
      $el.attr('data-type') === 'mathBlock')
  );
}

function isInlineMathElement($: ExportCheerioStatic, node: unknown, tagName: string): boolean {
  if (tagName === 'math-inline') {
    return true;
  }

  const $node = $(node);
  return (
    tagName === 'span' &&
    ($node.hasClass('math-inline-container') || $node.attr('data-type') === 'mathInline')
  );
}

function extractMathLatex($el: ExportCheerioSelection): string {
  return (
    $el.attr('data-latex') ??
    $el.find('[data-latex]').first().attr('data-latex') ??
    $el.find('code').first().text() ??
    ''
  ).trim();
}

export async function htmlToDocx(
  html: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docx: any,
  theme: string,
  document: vscode.TextDocument,
  externalLocalImages: ExportExternalLocalImageMode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = [];

  // Parse HTML with Cheerio (proper DOM parser, handles nested tags)
  // Lazy-load to keep module init and test transforms lightweight.
  const cheerioModule = await import('cheerio');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cheerio = (cheerioModule as any).default ?? cheerioModule;
  const $ = cheerio.load(html);

  // Select all block-level elements we care about, maintaining document order
  // Cheerio traverses in document order automatically
  // Select all block-level elements we care about
  // We need to use a loop that supports await
  const elements = $(
    'h1, h2, h3, h4, h5, h6, p, li, blockquote, table, img, .math-block-container, div[data-type="mathBlock"]'
  ).toArray();

  for (const element of elements) {
    const $el = $(element);
    const tagName = element.tagName.toLowerCase();

    // Skip elements inside other processed elements (e.g. p inside blockquote handled by blockquote)
    if ($el.parents('blockquote, li').length > 0) {
      continue;
    }

    if (isMathBlockElement($el, tagName)) {
      const latex = extractMathLatex($el);
      if (latex) {
        children.push(
          new docx.Paragraph({
            children: [
              new docx.TextRun({
                text: `$$\n${latex}\n$$`,
                font: 'Courier New',
              }),
            ],
            spacing: { before: 200, after: 200 },
          })
        );
      }
    } else if (tagName.match(/^h[1-6]$/)) {
      // Heading
      const textContent = $el.text().trim();
      if (textContent) {
        children.push(
          new docx.Paragraph({
            text: textContent,
            heading: getHeadingLevel(tagName, docx),
            spacing: { before: 400, after: 200 },
          })
        );
      }
    } else if (tagName === 'p') {
      // Paragraph - handle mixed content (text, images, links)
      const paragraphChildren = await parseParagraphChildren(
        $,
        element,
        docx,
        document,
        externalLocalImages
      );
      if (paragraphChildren.length > 0) {
        children.push(
          new docx.Paragraph({
            children: paragraphChildren,
            spacing: { after: 200 },
          })
        );
      }
    } else if (tagName === 'li') {
      // List item
      const paragraphChildren = await parseParagraphChildren(
        $,
        element,
        docx,
        document,
        externalLocalImages
      );
      if (paragraphChildren.length > 0) {
        children.push(
          new docx.Paragraph({
            children: paragraphChildren,
            bullet: { level: 0 },
            spacing: { after: 100 },
          })
        );
      }
    } else if (tagName === 'blockquote') {
      // Blockquote
      const textContent = $el.text().trim();
      if (textContent) {
        children.push(
          new docx.Paragraph({
            text: textContent,
            italics: true,
            spacing: { before: 200, after: 200, left: 400 },
            border: {
              left: {
                color: theme === 'editor' ? '444444' : 'DDDDDD',
                space: 1,
                value: 'single',
                size: 24,
              },
            },
          })
        );
      }
    } else if (tagName === 'img') {
      if ($el.parents('p, li, blockquote, table').length > 0) {
        continue;
      }

      const wrapper = $('<p></p>');
      wrapper.append($el.clone());
      const paragraphChildren = await parseParagraphChildren(
        $,
        wrapper.get(0),
        docx,
        document,
        externalLocalImages
      );
      if (paragraphChildren.length > 0) {
        children.push(
          new docx.Paragraph({
            children: paragraphChildren,
            spacing: { after: 200 },
          })
        );
      }
    }
  }

  return children;
}

/**
 * Helper to get heading level
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHeadingLevel(tagName: string, docx: any): any {
  switch (tagName) {
    case 'h1':
      return docx.HeadingLevel.HEADING_1;
    case 'h2':
      return docx.HeadingLevel.HEADING_2;
    case 'h3':
      return docx.HeadingLevel.HEADING_3;
    case 'h4':
      return docx.HeadingLevel.HEADING_4;
    case 'h5':
      return docx.HeadingLevel.HEADING_5;
    case 'h6':
      return docx.HeadingLevel.HEADING_6;
    default:
      return docx.HeadingLevel.HEADING_1;
  }
}

/**
 * Parse children of a paragraph-like element (p, li) into docx Runs
 */
async function parseParagraphChildren(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  element: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docx: any,
  document: vscode.TextDocument,
  externalLocalImages: ExportExternalLocalImageMode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runs: any[] = [];
  const contents = $(element).contents();

  // Process nodes sequentially to handle async image loading
  for (let i = 0; i < contents.length; i++) {
    const node = contents[i];

    if (node.type === 'text') {
      // Text node
      const text = $(node).text();
      if (text) {
        runs.push(new docx.TextRun({ text }));
      }
    } else if (node.type === 'tag') {
      const tagName = $(node).prop('tagName').toLowerCase();
      if (isInlineMathElement($, node, tagName)) {
        const latex = extractMathLatex($(node));
        if (latex) {
          runs.push(
            new docx.TextRun({
              text: `$${latex}$`,
              font: 'Courier New',
            })
          );
        }
      } else if (tagName === 'img') {
        // Image
        const src = $(node).attr('src');
        const markdownSrc = $(node).attr('data-markdown-src');
        const resolvableSrc = markdownSrc || src;

        if (resolvableSrc) {
          try {
            let buffer: Buffer | undefined;

            if (resolvableSrc.startsWith('data:')) {
              // Data URL
              const matches = resolvableSrc.match(/^data:([A-Za-z+/-]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                buffer = Buffer.from(matches[2], 'base64');
              }
            } else if (
              resolvableSrc.startsWith('http://') ||
              resolvableSrc.startsWith('https://')
            ) {
              // KNOWN LIMITATION: Remote images (HTTP/HTTPS URLs) are not embedded in Word exports.
              // This is intentional to avoid network dependencies during export and potential
              // security concerns with fetching arbitrary remote resources.
              // Workaround: Download images locally before exporting to Word.
              // TODO: Consider adding a user-facing warning when document contains remote images.
              console.warn(`[MD4H] Word export: Skipping remote image: ${resolvableSrc}`);
            } else {
              const trustedImagePath = resolveTrustedWordImagePath(
                resolvableSrc,
                document,
                externalLocalImages
              );
              if (trustedImagePath) {
                buffer = fs.readFileSync(trustedImagePath);
              }
            }

            if (buffer) {
              // Get dimensions
              let width = 400;
              let height = 300;

              try {
                const dimensions = imageSize(buffer);
                if (dimensions.width && dimensions.height) {
                  // Scale down if too large (e.g. max width 600px)
                  const maxWidth = 600;
                  if (dimensions.width > maxWidth) {
                    const ratio = maxWidth / dimensions.width;
                    width = maxWidth;
                    height = Math.round(dimensions.height * ratio);
                  } else {
                    width = dimensions.width;
                    height = dimensions.height;
                  }
                }
              } catch (e) {
                console.warn('[MD4H] Failed to get image dimensions:', e);
              }

              runs.push(
                new docx.ImageRun({
                  data: buffer,
                  transformation: { width, height },
                })
              );
            }
          } catch (e) {
            console.error('[MD4H] Failed to process image in paragraph:', e);
          }
        }
      } else if (tagName === 'strong' || tagName === 'b') {
        // Bold
        runs.push(
          new docx.TextRun({
            text: $(node).text(),
            bold: true,
          })
        );
      } else if (tagName === 'em' || tagName === 'i') {
        // Italic
        runs.push(
          new docx.TextRun({
            text: $(node).text(),
            italics: true,
          })
        );
      } else if (tagName === 'code') {
        // Inline code
        runs.push(
          new docx.TextRun({
            text: $(node).text(),
            font: 'Courier New',
            color: 'C7254E', // Red-ish color for code
          })
        );
      } else {
        // Other tags - just treat as text for now
        runs.push(new docx.TextRun({ text: $(node).text() }));
      }
    }
  }

  return runs;
}
