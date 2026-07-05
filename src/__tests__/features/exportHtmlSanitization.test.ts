/**
 * PDF/HTML Export Sanitization Tests
 *
 * The PDF export pipeline takes the editor's HTML and renders it via Chrome.
 * Combined with `--allow-file-access-from-files` (now removed) and the lack
 * of a CSP on the exported page, ANY active content (script, on* handler,
 * javascript: URI, foreign iframe/object/embed) in attacker-supplied
 * markdown was a vector to exfiltrate local files into the user's PDF.
 *
 * See SECURITY review §H3.
 *
 * Contract:
 *   sanitizeExportHtml(html: string, { mode }): string
 *     - strict/default removes <script>, <style>, <iframe>, <object>, <embed>, <link>, <meta>
 *     - styled keeps <style> blocks after stripping resource-loading CSS
 *     - looseStyle keeps authored CSS while still stripping active HTML
 *     - loose preserves authored raw HTML/CSS for trusted documents
 *     - removes every on* event handler attribute
 *     - rewrites href / src / xlink:href / data attributes whose value is a
 *       javascript: or data:text/html: scheme to an empty string
 *     - preserves benign markup: paragraphs, lists, tables, code blocks,
 *       images, anchors, span/div with class/style/data-* attrs
 */

import { pathToFileURL } from 'url';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildExportHTML,
  buildFileBaseHrefForExport,
  getConfiguredExportSanitizeMode,
  getConfiguredExportLimitationsWarningEnabled,
  getConfiguredExternalLocalImageMode,
  htmlToDocx,
  inlineMermaidImagesForExport,
  preparePdfHtmlResourcesForExport,
  resolveTrustedWordImagePath,
  sanitizeExportHtml,
  strictExportSanitizationWouldRewriteHtml,
} from '../../features/documentExport';

describe('sanitizeExportHtml', () => {
  describe('strips active content', () => {
    it('removes <script> tags entirely (including contents)', () => {
      const out = sanitizeExportHtml(
        '<p>before</p><script>fetch("file:///etc/passwd")</script><p>after</p>'
      );
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/file:\/\/\/etc\/passwd/);
      expect(out).toContain('before');
      expect(out).toContain('after');
    });

    it('removes <iframe>', () => {
      const out = sanitizeExportHtml('<p>hi</p><iframe src="file:///etc/passwd"></iframe>');
      expect(out).not.toMatch(/<iframe/i);
    });

    it('removes <object> and <embed>', () => {
      const out = sanitizeExportHtml(
        '<object data="file:///etc/passwd"></object><embed src="file:///etc/passwd">'
      );
      expect(out).not.toMatch(/<object/i);
      expect(out).not.toMatch(/<embed/i);
    });

    it('removes <link> and <meta> (could redirect or refresh)', () => {
      const out = sanitizeExportHtml(
        '<meta http-equiv="refresh" content="0;url=file:///etc/passwd"><link rel="import" href="file:///etc/passwd">'
      );
      expect(out).not.toMatch(/<meta/i);
      expect(out).not.toMatch(/<link/i);
    });

    it('removes <style> blocks in strict mode', () => {
      const out = sanitizeExportHtml(
        '<p>safe</p><style>@import url(https://evil.example/pixel); body{background:url(file:///etc/passwd)}</style>'
      );

      expect(out).toContain('safe');
      expect(out).not.toMatch(/<style/i);
      expect(out).not.toContain('evil.example');
      expect(out).not.toContain('file:///etc/passwd');
    });

    it('keeps safe <style> rules in styled mode and removes resource-loading CSS', () => {
      const out = sanitizeExportHtml(
        [
          '<p>safe</p>',
          '<style>',
          '@import url(https://evil.example/pixel);',
          'body{background:url(file:///etc/passwd);color:red;font-weight:bold}',
          '.reader{font-family:Georgia,serif}',
          '</style>',
        ].join(''),
        { mode: 'styled' }
      );

      expect(out).toContain('safe');
      expect(out).toMatch(/<style/i);
      expect(out).toContain('color:red');
      expect(out).toContain('font-weight:bold');
      expect(out).toContain('font-family:Georgia,serif');
      expect(out).not.toContain('@import');
      expect(out).not.toMatch(/url\s*\(/i);
      expect(out).not.toContain('evil.example');
      expect(out).not.toContain('file:///etc/passwd');
    });

    it('removes CSS-escaped resource fetches from styled mode style blocks', () => {
      const out = sanitizeExportHtml(
        '<style>body{background:u\\72l(https://evil.example/pixel);color:red}</style>',
        { mode: 'styled' }
      );

      expect(out).toMatch(/<style/i);
      expect(out).toContain('color:red');
      expect(out).not.toMatch(/u\\72l/i);
      expect(out).not.toContain('evil.example');
    });

    it('preserves raw CSS in looseStyle mode while stripping active HTML', () => {
      const out = sanitizeExportHtml(
        [
          '<style>@import url(https://styles.example/fonts.css); body{background:url(file:///etc/passwd);color:red}</style>',
          '<script>alert(1)</script>',
          '<p onclick="evil()" style="background:url(https://styles.example/pixel);color:red">',
          '<a href="javascript:alert(1)">x</a>',
          '</p>',
        ].join(''),
        { mode: 'looseStyle' }
      );

      expect(out).toMatch(/<style/i);
      expect(out).toContain('@import url(https://styles.example/fonts.css)');
      expect(out).toContain('background:url(file:///etc/passwd)');
      expect(out).toContain('background:url(https://styles.example/pixel)');
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/onclick/i);
      expect(out).not.toMatch(/javascript:/i);
    });

    it('preserves raw authored HTML and CSS in loose mode', () => {
      const html =
        '<style>@import url(https://evil.example/pixel)</style><script>alert(1)</script><p onclick="evil()">x</p>';

      expect(sanitizeExportHtml(html, { mode: 'loose' })).toBe(html);
    });
  });

  describe('strips inline event handlers', () => {
    it('removes onerror on <img>', () => {
      const out = sanitizeExportHtml(
        '<img src="x" onerror="fetch(\'file:///etc/passwd\').then(r=>r.text()).then(t=>document.title=t)">'
      );
      expect(out).not.toMatch(/onerror/i);
      expect(out).not.toMatch(/file:\/\/\/etc\/passwd/);
      // benign attributes remain
      expect(out).toMatch(/<img\s/i);
      expect(out).toMatch(/src="x"/);
    });

    it('removes onload on <body> / <svg>', () => {
      const out = sanitizeExportHtml('<svg onload="alert(1)"><circle r="10"/></svg>');
      expect(out).not.toMatch(/onload/i);
    });

    it('removes onclick on <a>', () => {
      const out = sanitizeExportHtml('<a href="#" onclick="evil()">click</a>');
      expect(out).not.toMatch(/onclick/i);
    });

    it('strips uppercase / mixed-case ON* handlers (HTML attrs are case-insensitive)', () => {
      const out = sanitizeExportHtml('<img src="x" OnError="alert(1)">');
      expect(out).not.toMatch(/onerror/i);
    });
  });

  describe('strips dangerous URI schemes', () => {
    it('strips javascript: from <a href>', () => {
      const out = sanitizeExportHtml('<a href="javascript:alert(1)">x</a>');
      expect(out).not.toMatch(/javascript:/i);
    });

    it('strips javascript: from <img src>', () => {
      const out = sanitizeExportHtml('<img src="javascript:alert(1)">');
      expect(out).not.toMatch(/javascript:/i);
    });

    it('strips file: from <a href>', () => {
      const out = sanitizeExportHtml('<a href="file:///etc/passwd">click</a>');
      expect(out).not.toMatch(/file:\/\/\//i);
    });

    it('preserves https: and mailto: URIs', () => {
      const out = sanitizeExportHtml(
        '<a href="https://example.com">x</a><a href="mailto:a@b.c">y</a>'
      );
      expect(out).toContain('https://example.com');
      expect(out).toContain('mailto:a@b.c');
    });

    it('preserves data: image URIs (used for inlined PNGs)', () => {
      const out = sanitizeExportHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
      expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
    });

    it('strips data:text/javascript from <img src>', () => {
      const out = sanitizeExportHtml('<img src="data:text/javascript,alert(1)">');
      expect(out).not.toMatch(/data:text\/javascript/i);
    });

    it('strips data:application/javascript from <a href>', () => {
      const out = sanitizeExportHtml('<a href="data:application/javascript,alert(1)">x</a>');
      expect(out).not.toMatch(/data:application\/javascript/i);
    });

    it('strips data:text/html (active content disguised as data URI)', () => {
      const out = sanitizeExportHtml(
        '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>'
      );
      expect(out).not.toMatch(/<iframe/i);
      // Even if the iframe-strip didn't catch it, the data:text/html scheme
      // must not survive on any element.
      expect(out).not.toMatch(/data:text\/html/i);
    });

    it('strips CSS url() fetches from style attributes', () => {
      const out = sanitizeExportHtml(
        '<p style="color:red;background-image:url(https://evil.example/pixel);font-weight:bold">x</p>'
      );

      expect(out).not.toMatch(/url\s*\(/i);
      expect(out).not.toContain('evil.example');
      expect(out).toContain('color:red');
      expect(out).toContain('font-weight:bold');
    });

    it('strips CSS url() fetches when function names use CSS escapes', () => {
      const out = sanitizeExportHtml(
        '<p style="color:red;background-image:u\\72l(https://evil.example/pixel);font-weight:bold">x</p>'
      );

      expect(out).not.toMatch(/u\\72l/i);
      expect(out).not.toContain('evil.example');
      expect(out).toContain('color:red');
      expect(out).toContain('font-weight:bold');
    });
  });

  describe('preserves benign markup', () => {
    it('keeps headings, paragraphs, code, tables, lists', () => {
      const html = `
        <h1>Title</h1>
        <p>Body with <strong>bold</strong> and <em>italic</em>.</p>
        <pre><code class="language-ts">const x = 1;</code></pre>
        <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
        <ul><li>one</li><li>two</li></ul>
      `;
      const out = sanitizeExportHtml(html);
      expect(out).toContain('<h1>');
      expect(out).toContain('<strong>');
      expect(out).toContain('<em>');
      expect(out).toContain('language-ts');
      expect(out).toContain('<table>');
      expect(out).toContain('<th>');
      expect(out).toContain('<td>');
      expect(out).toContain('<li>');
    });

    it('keeps relative image paths and alt text', () => {
      const out = sanitizeExportHtml('<img src="./images/cat.png" alt="A cat">');
      expect(out).toContain('./images/cat.png');
      expect(out).toContain('A cat');
    });

    it('keeps class and style attributes (used by themes / Mermaid SVG)', () => {
      const out = sanitizeExportHtml('<div class="mermaid" style="color:red">x</div>');
      expect(out).toContain('class="mermaid"');
      expect(out).toContain('style="color:red"');
    });
  });

  describe('robustness', () => {
    it('returns empty string for empty input', () => {
      expect(sanitizeExportHtml('')).toBe('');
    });

    it('does not throw on malformed HTML', () => {
      expect(() =>
        sanitizeExportHtml('<p>unclosed <strong>nested <a href="x">stuff')
      ).not.toThrow();
    });
  });
});

describe('strictExportSanitizationWouldRewriteHtml', () => {
  it('does not rewrite safe markdown-derived HTML', () => {
    expect(strictExportSanitizationWouldRewriteHtml('<p style="color:red">safe</p>')).toBe(false);
  });

  it('rewrites raw style blocks', () => {
    expect(
      strictExportSanitizationWouldRewriteHtml('<style>body{color:red}</style><p>safe</p>')
    ).toBe(true);
  });

  it('rewrites active HTML', () => {
    expect(strictExportSanitizationWouldRewriteHtml('<p onclick="evil()">x</p>')).toBe(true);
  });
});

describe('export settings', () => {
  afterEach(() => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReset();
  });

  it('reads the PDF raw HTML/CSS mode from settings', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === 'export.pdfRawHtmlMode' ? 'looseStyle' : defaultValue
      ),
    });

    expect(getConfiguredExportSanitizeMode('pdf')).toBe('looseStyle');
  });

  it('falls back to strict when a Word setting requests a CSS-only mode', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === 'export.wordRawHtmlMode' ? 'styled' : defaultValue
      ),
    });

    expect(getConfiguredExportSanitizeMode('docx')).toBe('strict');
  });

  it('reads the external local image policy from settings', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === 'export.externalLocalImages' ? 'include' : defaultValue
      ),
    });

    expect(getConfiguredExternalLocalImageMode()).toBe('include');
  });

  it('reads whether the generic export limitations warning is enabled', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key: string, defaultValue: unknown) =>
        key === 'export.showLimitationsWarning' ? false : defaultValue
      ),
    });

    expect(getConfiguredExportLimitationsWarningEnabled()).toBe(false);
  });
});

describe('buildFileBaseHrefForExport', () => {
  it('encodes a local directory as a file URL with a trailing slash', () => {
    const dir = '/tmp/Markdown Docs/#draft?one';
    const href = buildFileBaseHrefForExport(dir);

    expect(href).toBe(pathToFileURL(`${dir}/`).href);
    expect(href).toContain('Markdown%20Docs');
    expect(href).toContain('%23draft%3Fone');
    expect(href.endsWith('/')).toBe(true);
  });
});

describe('buildExportHTML', () => {
  it('includes self-contained KaTeX styles for PDF math rendering', () => {
    const html = buildExportHTML('<p><span class="katex">x</span></p>', 'light', 'pdf');

    expect(html).toContain('@font-face');
    expect(html).toContain('.katex');
    expect(html).toContain('data:font/woff2;base64,');
  });
});

describe('htmlToDocx math export', () => {
  it('converts math containers from LaTeX source instead of rendered KaTeX text', async () => {
    const textRuns: Array<{ text?: string }> = [];
    const fakeDocx = {
      TextRun: jest.fn((options: { text?: string }) => {
        textRuns.push(options);
        return { type: 'TextRun', options };
      }),
      Paragraph: jest.fn((options: { children?: unknown[]; text?: string }) => ({
        type: 'Paragraph',
        options,
      })),
      ImageRun: jest.fn((options: unknown) => ({ type: 'ImageRun', options })),
      HeadingLevel: {
        HEADING_1: 'heading1',
        HEADING_2: 'heading2',
        HEADING_3: 'heading3',
        HEADING_4: 'heading4',
        HEADING_5: 'heading5',
        HEADING_6: 'heading6',
      },
    };
    const document = {
      uri: vscode.Uri.file('/tmp/doc.md'),
    } as vscode.TextDocument;

    await htmlToDocx(
      [
        '<div class="math-block-container" data-latex="E=mc^2">',
        '<div class="math-block-rendered"><span class="katex">DUPLICATE BLOCK</span></div>',
        '</div>',
        '<p>Area ',
        '<span class="math-inline-container" data-latex="\\pi r^2"><span class="katex">DUPLICATE INLINE</span></span>',
        '</p>',
      ].join(''),
      fakeDocx,
      'light',
      document,
      'strip'
    );

    const exportedText = textRuns.map(run => run.text).join('\n');
    expect(exportedText).toContain('$$\nE=mc^2\n$$');
    expect(exportedText).toContain('$\\pi r^2$');
    expect(exportedText).not.toContain('DUPLICATE');
  });
});

describe('resolveTrustedWordImagePath', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let docDir: string;
  let privateDir: string;
  let document: vscode.TextDocument;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md4h-word-images-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    docDir = path.join(workspaceRoot, 'docs');
    privateDir = path.join(tempDir, 'private');
    fs.mkdirSync(path.join(docDir, 'images'), { recursive: true });
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, 'images', 'trusted.png'), 'trusted');
    fs.writeFileSync(path.join(docDir, 'images', 'test%ZZ.png'), 'literal percent');
    fs.writeFileSync(path.join(privateDir, 'secret.png'), 'secret');

    document = {
      uri: vscode.Uri.file(path.join(docDir, 'note.md')),
    } as vscode.TextDocument;

    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
      uri: vscode.Uri.file(workspaceRoot),
      name: 'workspace',
      index: 0,
    });
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = [
      {
        uri: vscode.Uri.file(workspaceRoot),
        name: 'workspace',
        index: 0,
      },
    ];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReset();
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  });

  it('resolves relative image paths under the document directory', () => {
    expect(resolveTrustedWordImagePath('images/trusted.png', document)).toBe(
      path.join(docDir, 'images', 'trusted.png')
    );
  });

  it('rejects absolute image paths outside the document workspace roots', () => {
    expect(resolveTrustedWordImagePath(path.join(privateDir, 'secret.png'), document)).toBeNull();
  });

  it('resolves literal local paths with malformed percent escapes', () => {
    expect(resolveTrustedWordImagePath('images/test%ZZ.png', document)).toBe(
      path.join(docDir, 'images', 'test%ZZ.png')
    );
  });
});

describe('preparePdfHtmlResourcesForExport', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let docDir: string;
  let privateDir: string;
  let document: vscode.TextDocument;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md4h-pdf-images-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    docDir = path.join(workspaceRoot, 'docs');
    privateDir = path.join(tempDir, 'private');
    fs.mkdirSync(path.join(docDir, 'images'), { recursive: true });
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, 'images', 'trusted.svg'), '<svg>trusted</svg>');
    fs.writeFileSync(path.join(docDir, 'images', 'test%ZZ.svg'), '<svg>malformed</svg>');
    fs.writeFileSync(path.join(privateDir, 'secret.svg'), '<svg>secret</svg>');

    document = {
      uri: vscode.Uri.file(path.join(docDir, 'note.md')),
    } as vscode.TextDocument;

    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
      uri: vscode.Uri.file(workspaceRoot),
      name: 'workspace',
      index: 0,
    });
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = [
      {
        uri: vscode.Uri.file(workspaceRoot),
        name: 'workspace',
        index: 0,
      },
    ];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReset();
    (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  });

  it('inlines trusted local image sources before PDF rendering', () => {
    const out = preparePdfHtmlResourcesForExport(
      '<p><img src="vscode-webview://image" data-markdown-src="./images/trusted.svg" srcset="../../private/secret.svg 2x" alt="Trusted"></p>',
      document,
      'strict'
    );

    expect(out).toContain('src="data:image/svg+xml;base64,PHN2Zz50cnVzdGVkPC9zdmc+"');
    expect(out).toContain('alt="Trusted"');
    expect(out).not.toContain('vscode-webview://image');
    expect(out).not.toContain('data-markdown-src');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('secret.svg');
  });

  it('strips local image sources outside trusted roots in strict PDF HTML', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<p><img src="${secretRelativePath}" alt="Secret"></p>`,
      document,
      'strict'
    );

    expect(out).toContain('<img');
    expect(out).toContain('alt="Secret"');
    expect(out).not.toContain('secret.svg');
    expect(out).not.toMatch(/\ssrc=/i);
  });

  it('strips external local image sources in loose PDF HTML by default', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<style>p{color:red}</style><script>alert(1)</script><p><img src="${secretRelativePath}" alt="Secret"></p>`,
      document,
      'loose'
    );

    expect(out).toContain('<style>p{color:red}</style>');
    expect(out).toContain('<script>alert(1)</script>');
    expect(out).toContain('<img');
    expect(out).toContain('alt="Secret"');
    expect(out).not.toContain('secret.svg');
    expect(out).not.toMatch(/\ssrc=/i);
  });

  it('inlines external local image sources when export settings allow them', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<p><img src="${secretRelativePath}" alt="External"></p>`,
      document,
      'strict',
      'include'
    );

    expect(out).toContain('src="data:image/svg+xml;base64,PHN2Zz5zZWNyZXQ8L3N2Zz4="');
    expect(out).toContain('alt="External"');
    expect(out).not.toContain('secret.svg');
  });

  it('inlines external local image sources in loose PDF HTML when export settings allow them', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<p><img src="${secretRelativePath}" alt="External"></p>`,
      document,
      'loose',
      'include'
    );

    expect(out).toContain('src="data:image/svg+xml;base64,PHN2Zz5zZWNyZXQ8L3N2Zz4="');
    expect(out).toContain('alt="External"');
    expect(out).not.toContain('secret.svg');
  });

  it('strips external local CSS urls in looseStyle PDF HTML by default', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      [
        '<style>',
        `.cover{background-image:url("${secretRelativePath}");color:red}`,
        '</style>',
        `<p style="background:url('${secretRelativePath}');font-weight:bold">Styled</p>`,
      ].join(''),
      document,
      'looseStyle'
    );

    expect(out).toContain('<style>');
    expect(out).toContain('color:red');
    expect(out).toContain('font-weight:bold');
    expect(out).not.toContain('secret.svg');
  });

  it('strips external local CSS urls when url() is CSS-escaped', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<p style="background:u\\72l('${secretRelativePath}');font-weight:bold">Styled</p>`,
      document,
      'looseStyle'
    );

    expect(out).toContain('font-weight:bold');
    expect(out).not.toContain('u\\72l');
    expect(out).not.toContain('secret.svg');
  });

  it('inlines trusted local CSS urls before PDF rendering', () => {
    const out = preparePdfHtmlResourcesForExport(
      '<style>.cover{background-image:url("./images/trusted.svg")}</style>',
      document,
      'looseStyle'
    );

    expect(out).toContain(
      'background-image:url("data:image/svg+xml;base64,PHN2Zz50cnVzdGVkPC9zdmc+")'
    );
    expect(out).not.toContain('./images/trusted.svg');
  });

  it('strips external local source srcset candidates in loose PDF HTML by default', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<picture><source srcset="./images/trusted.svg 1x, ${secretRelativePath} 2x"><img src="./images/trusted.svg" alt="Trusted"></picture>`,
      document,
      'loose'
    );

    expect(out).toContain('srcset="data:image/svg+xml;base64,PHN2Zz50cnVzdGVkPC9zdmc+ 1x"');
    expect(out).not.toContain('secret.svg');
  });

  it('strips external local srcset candidates when commas have no following space', () => {
    const secretRelativePath = path.relative(docDir, path.join(privateDir, 'secret.svg'));
    const out = preparePdfHtmlResourcesForExport(
      `<picture><source srcset="./images/trusted.svg 1x,${secretRelativePath} 2x"><img src="./images/trusted.svg" alt="Trusted"></picture>`,
      document,
      'loose'
    );

    expect(out).toContain('srcset="data:image/svg+xml;base64,PHN2Zz50cnVzdGVkPC9zdmc+ 1x"');
    expect(out).not.toContain('secret.svg');
  });

  it('inlines paths with malformed percent escapes before PDF rendering', () => {
    const out = preparePdfHtmlResourcesForExport(
      '<p><img src="./images/test%ZZ.svg" alt="Literal percent"></p>',
      document,
      'strict'
    );

    expect(out).toContain('src="data:image/svg+xml;base64,PHN2Zz5tYWxmb3JtZWQ8L3N2Zz4="');
    expect(out).not.toContain('test%ZZ.svg');
  });
});

describe('inlineMermaidImagesForExport', () => {
  it('replaces a Mermaid wrapper with the PNG captured by the webview', () => {
    const out = inlineMermaidImagesForExport(
      '<p>before</p><div class="mermaid-wrapper" data-mermaid-id="mermaid-0"><svg><text>Graph</text></svg></div><p>after</p>',
      [
        {
          id: 'mermaid-0',
          pngDataUrl: 'data:image/png;base64,abc123',
          originalSvg: '<svg><text>Graph</text></svg>',
        },
      ]
    );

    expect(out).toContain('<p>before</p>');
    expect(out).toContain('<p>after</p>');
    expect(out).toContain('<img');
    expect(out).toContain('src="data:image/png;base64,abc123"');
    expect(out).toContain('class="mermaid-export-image"');
    expect(out).not.toContain('mermaid-wrapper');
    expect(out).not.toContain('<svg');
  });
});
