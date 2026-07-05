/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview KaTeX-backed TipTap nodes for inline `$...$` and display
 * `$$...$$` math. The extension preserves markdown delimiters on save and
 * renders equations in the WYSIWYG surface.
 */

import { Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
  RenderContext,
} from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import katex from 'katex';
import type { KatexOptions } from 'katex';
import { preserveProseSpaces } from '../utils/preserveProseSpaces';

type MathToken = MarkdownToken & {
  text?: string;
};

type MarkedBlockExtension = {
  name: string;
  level: 'block';
  start: (src: string) => number;
  tokenizer: (src: string) => MathToken | undefined;
};

type MarkedInstanceWithUse = {
  use?: (options: { extensions: MarkedBlockExtension[] }) => void;
  __mdhMathExtensionsInstalled?: boolean;
  marked?: MarkedInstanceWithUse;
  instance?: MarkedInstanceWithUse;
};

type MathReplacement = {
  from: number;
  to: number;
  latex: string;
};

type MathBlockOptions = {
  render: boolean;
};

const MAX_INLINE_REPLACEMENTS_PER_TRANSACTION = 40;
const INLINE_MATH_RE = /\$([^\s$][^$\n]*[^\s$]|[^\s$])\$/g;

const KATEX_INLINE_OPTIONS: KatexOptions = {
  displayMode: false,
  throwOnError: true,
  trust: false,
};

const KATEX_DISPLAY_OPTIONS: KatexOptions = {
  displayMode: true,
  throwOnError: true,
  trust: false,
};

let mathMarkedTokenizerEnabled = true;

const mathBlockMarkedExtension: MarkedBlockExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src: string): number {
    if (!mathMarkedTokenizerEnabled) {
      return -1;
    }
    return src.indexOf('$$');
  },
  tokenizer(src: string): MathToken | undefined {
    if (!mathMarkedTokenizerEnabled) {
      return undefined;
    }

    const match = src.match(/^\$\$\n?([\s\S]*?)\$\$/);

    if (!match) {
      return undefined;
    }

    return {
      type: 'mathBlock',
      raw: match[0],
      text: match[1].trimEnd(),
    } as MathToken;
  },
};

export function setMathMarkedTokenizerEnabled(enabled: boolean): void {
  mathMarkedTokenizerEnabled = enabled;
}

function resolveMarkedInstance(candidate: unknown): MarkedInstanceWithUse | null {
  const direct = candidate as MarkedInstanceWithUse | null;

  if (direct && typeof direct.use === 'function') {
    return direct;
  }

  if (direct?.instance && typeof direct.instance.use === 'function') {
    return direct.instance;
  }

  if (direct?.marked && typeof direct.marked.use === 'function') {
    return direct.marked;
  }

  return null;
}

/**
 * Install the display-math marked tokenizer used by `@tiptap/markdown`.
 * The function is idempotent because the editor may be recreated or tested with
 * the same markdown manager instance.
 */
export function installMathMarkedExtensions(markdownManagerOrMarked: unknown): void {
  const markedInstance = resolveMarkedInstance(markdownManagerOrMarked);

  if (!markedInstance || markedInstance.__mdhMathExtensionsInstalled) {
    return;
  }

  markedInstance.use?.({ extensions: [mathBlockMarkedExtension] });
  markedInstance.__mdhMathExtensionsInstalled = true;
}

function renderKatex(latex: string, displayMode: boolean): { html: string; error?: string } {
  try {
    const displayLatex = preserveProseSpaces(latex);
    return {
      html: katex.renderToString(
        displayLatex,
        displayMode ? KATEX_DISPLAY_OPTIONS : KATEX_INLINE_OPTIONS
      ),
    };
  } catch (error) {
    return {
      html: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

function renderMathBlock(latex: string, renderedElement: HTMLElement): void {
  if (!latex.trim()) {
    renderedElement.innerHTML = '<div class="math-placeholder">Enter LaTeX formula</div>';
    renderedElement.classList.remove('rendered', 'katex-error', 'literal');
    return;
  }

  const { html, error } = renderKatex(latex, true);

  if (error) {
    renderedElement.innerHTML = `<div class="math-error-icon">!</div><div class="math-error-msg">${escapeHtml(error)}</div>`;
    renderedElement.classList.add('katex-error');
    renderedElement.classList.remove('rendered', 'literal');
    return;
  }

  renderedElement.innerHTML = html;
  renderedElement.classList.add('rendered');
  renderedElement.classList.remove('katex-error', 'literal');
}

function renderMathBlockLiteral(latex: string, renderedElement: HTMLElement): void {
  renderedElement.textContent = `$$\n${latex}\n$$`;
  renderedElement.classList.add('literal');
  renderedElement.classList.remove('rendered', 'katex-error');
}

function renderInlineMath(latex: string, renderedElement: HTMLElement): void {
  if (!latex.trim()) {
    renderedElement.textContent = '';
    return;
  }

  const { html, error } = renderKatex(latex, false);

  if (error) {
    renderedElement.innerHTML = `<span class="math-inline-error" title="${escapeAttribute(error)}">!</span>`;
    return;
  }

  renderedElement.innerHTML = html;
}

function extractMathText(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  return helpers.renderChildren(node.content || [], '\n').trimEnd();
}

export const MathBlock = TiptapNode.create<MathBlockOptions>({
  name: 'mathBlock',

  addOptions() {
    return {
      render: true,
    };
  },

  group: 'block',

  content: 'text*',

  marks: '',

  code: true,

  defining: true,

  isolating: true,

  addAttributes() {
    return {
      language: {
        default: 'latex',
        parseHTML: element => element.getAttribute('data-language'),
        renderHTML: attributes => ({
          'data-language': attributes.language,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="mathBlock"]',
        preserveWhitespace: 'full',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'mathBlock',
        class: 'math-block',
      }),
      ['code', {}, 0],
    ];
  },

  markdownTokenName: 'mathBlock',

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    if (token.type !== 'mathBlock') {
      return [];
    }

    const text = (token as MathToken).text ?? '';
    const content = text ? [helpers.createTextNode(text)] : [];

    return helpers.createNode('mathBlock', { language: 'latex' }, content);
  },

  renderMarkdown: ((
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    _context: RenderContext
  ) => {
    return `$$\n${extractMathText(node, helpers)}\n$$`;
  }) as unknown as (
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,

  addNodeView() {
    const shouldRenderMath = this.options.render;

    return ({ node, getPos, editor }) => {
      const container = document.createElement('div');
      container.className = 'math-block-container';

      const renderedElement = document.createElement('div');
      renderedElement.className = 'math-block-rendered';

      const tooltip = document.createElement('div');
      tooltip.className = 'math-block-tooltip';
      tooltip.textContent = 'Double-click to edit';
      tooltip.style.display = 'none';
      tooltip.setAttribute('role', 'tooltip');

      let currentNode = node;
      let source = currentNode.textContent || '';
      let highlighted = false;

      container.setAttribute('data-latex', source);
      if (shouldRenderMath) {
        renderMathBlock(source, renderedElement);
      } else {
        renderMathBlockLiteral(source, renderedElement);
      }
      container.append(renderedElement, tooltip);

      const selectNode = () => {
        if (typeof getPos !== 'function') {
          return;
        }

        const pos = getPos();

        if (typeof pos !== 'number') {
          return;
        }

        try {
          editor.chain().setNodeSelection(pos).run();
        } catch {
          // Selection can fail if the node moved during an async UI event.
        }
      };

      container.addEventListener('mousedown', selectNode);
      container.addEventListener('click', () => {
        selectNode();

        if (!highlighted) {
          container.classList.add('highlighted');
          tooltip.style.display = 'block';
          highlighted = true;
        }
      });

      container.addEventListener('dblclick', () => {
        highlighted = false;
        container.classList.remove('highlighted');
        tooltip.style.display = 'none';
        renderedElement.style.display = 'none';

        const textarea = document.createElement('textarea');
        textarea.className = 'math-block-editor';
        textarea.value = source;
        textarea.rows = Math.min(10, Math.max(2, source.split('\n').length));
        textarea.spellcheck = false;

        container.insertBefore(textarea, tooltip);
        textarea.focus();
        textarea.select();

        const finish = (save: boolean) => {
          const nextSource = save ? textarea.value : source;
          textarea.remove();
          renderedElement.style.display = '';

          if (!save || nextSource === source || typeof getPos !== 'function') {
            return;
          }

          const pos = getPos();

          if (typeof pos !== 'number') {
            return;
          }

          const content = nextSource ? editor.schema.text(nextSource) : undefined;
          const nextNode = currentNode.type.create(currentNode.attrs, content);
          editor.view.dispatch(
            editor.state.tr.replaceWith(pos, pos + currentNode.nodeSize, nextNode)
          );
        };

        textarea.addEventListener('blur', () => finish(true));
        textarea.addEventListener('keydown', event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          }

          if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            finish(true);
          }
        });
      });

      const handleDocumentClick = (event: MouseEvent) => {
        if (!container.contains(event.target as globalThis.Node | null) && highlighted) {
          container.classList.remove('highlighted');
          tooltip.style.display = 'none';
          highlighted = false;
        }
      };

      document.addEventListener('click', handleDocumentClick);

      return {
        dom: container,
        update: (updatedNode: ProseMirrorNode) => {
          if (updatedNode.type.name !== 'mathBlock') {
            return false;
          }

          currentNode = updatedNode;
          const nextSource = updatedNode.textContent || '';

          if (nextSource !== source) {
            source = nextSource;
            container.setAttribute('data-latex', source);
            if (shouldRenderMath) {
              renderMathBlock(source, renderedElement);
            } else {
              renderMathBlockLiteral(source, renderedElement);
            }
          }

          return true;
        },
        destroy: () => {
          document.removeEventListener('click', handleDocumentClick);
        },
      };
    };
  },
});

export const MathInline = TiptapNode.create({
  name: 'mathInline',

  group: 'inline',

  inline: true,

  atom: true,

  selectable: true,

  marks: '',

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: element => element.getAttribute('data-latex') || element.textContent || '',
        renderHTML: attributes => ({
          'data-latex': attributes.latex,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'math-inline' }, { tag: 'span[data-type="mathInline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'mathInline',
        class: 'math-inline-container',
      }),
      0,
    ];
  },

  renderMarkdown: ((
    node: JSONContent,
    _helpers: MarkdownRendererHelpers,
    _context: RenderContext
  ) => {
    const latex = String(node.attrs?.latex || node.content?.[0]?.text || '');
    return `$${latex}$`;
  }) as unknown as (
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const container = document.createElement('span');
      container.className = 'math-inline-container';

      const renderedElement = document.createElement('span');
      renderedElement.className = 'math-inline-rendered';

      let currentNode = node;
      let source = (currentNode.attrs.latex as string) || currentNode.textContent || '';

      renderInlineMath(source, renderedElement);
      container.appendChild(renderedElement);

      container.addEventListener('dblclick', () => {
        const currentSource = source;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'math-inline-editor';
        input.value = currentSource;
        input.spellcheck = false;

        renderedElement.style.display = 'none';
        container.appendChild(input);
        input.focus();
        input.select();

        const finish = (save: boolean) => {
          const nextSource = save ? input.value : currentSource;
          input.remove();
          renderedElement.style.display = '';

          if (!save || nextSource === currentSource || typeof getPos !== 'function') {
            return;
          }

          const pos = getPos();

          if (typeof pos !== 'number') {
            return;
          }

          const nextNode = currentNode.type.create({ latex: nextSource });
          editor.view.dispatch(
            editor.state.tr.replaceWith(pos, pos + currentNode.nodeSize, nextNode)
          );
        };

        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          }

          if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          }
        });
      });

      return {
        dom: container,
        update: (updatedNode: ProseMirrorNode) => {
          if (updatedNode.type.name !== 'mathInline') {
            return false;
          }

          currentNode = updatedNode;
          const nextSource = (updatedNode.attrs.latex as string) || updatedNode.textContent || '';

          if (nextSource !== source) {
            source = nextSource;
            renderInlineMath(source, renderedElement);
          }

          return true;
        },
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mathInlineDetection'),
        appendTransaction: (_transactions, _oldState, newState) => {
          try {
            const { doc, schema } = newState;
            const mathInlineType = schema.nodes.mathInline;

            if (!mathInlineType) {
              return null;
            }

            const replacements: MathReplacement[] = [];

            doc.descendants((child, pos) => {
              if (replacements.length >= MAX_INLINE_REPLACEMENTS_PER_TRANSACTION) {
                return false;
              }

              if (!child.isText) {
                return true;
              }

              const text = child.text || '';

              if (!text.includes('$') || child.marks.length > 0) {
                return true;
              }

              const parent = doc.resolve(pos).parent;
              const parentType = parent.type.name;

              if (
                parentType === 'codeBlock' ||
                parentType === 'mathBlock' ||
                parentType === 'mathInline'
              ) {
                return true;
              }

              INLINE_MATH_RE.lastIndex = 0;

              let match = INLINE_MATH_RE.exec(text);
              while (match !== null) {
                if (replacements.length >= MAX_INLINE_REPLACEMENTS_PER_TRANSACTION) {
                  break;
                }

                if (match.index === 0 || text[match.index - 1] !== '\\') {
                  replacements.push({
                    from: pos + match.index,
                    to: pos + match.index + match[0].length,
                    latex: match[1],
                  });
                }

                match = INLINE_MATH_RE.exec(text);
              }

              return true;
            });

            if (replacements.length === 0) {
              return null;
            }

            const tr = newState.tr;

            for (let i = replacements.length - 1; i >= 0; i -= 1) {
              const replacement = replacements[i];

              try {
                if (
                  replacement.from < 0 ||
                  replacement.to > tr.doc.content.size ||
                  replacement.from >= replacement.to
                ) {
                  continue;
                }

                const mathNode = mathInlineType.create({ latex: replacement.latex });
                tr.replaceWith(replacement.from, replacement.to, mathNode);
              } catch {
                // Skip one invalid replacement; remaining literal text can be
                // retried on the next user edit without breaking the editor.
              }
            }

            return tr;
          } catch (error) {
            console.warn('[MD4H] Math inline detection skipped:', error);
            return null;
          }
        },
      }),
    ];
  },
});
