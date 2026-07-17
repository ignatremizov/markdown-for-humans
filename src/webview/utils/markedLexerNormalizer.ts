/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Several marked block tokenizers (heading, lheading, table, code, hr, list,
 * blockquote, html) match trailing `\n+` greedily, swallowing any blank lines
 * that follow into their own raw field. As a result no separate "space" token
 * is emitted for those blank lines, and our BlankLinePreservation extension
 * cannot see them.
 *
 * `normalizeBlankLineGreedyTokens` walks a marked token stream and, for any
 * such block whose raw ends with two or more newlines, splits the trailing
 * newlines off into a synthetic "space" token. The block's raw is shortened
 * to the content (without trailing whitespace) and a `space` token with the
 * full run of newlines is inserted directly after — matching the shape marked
 * emits naturally for paragraphs.
 *
 * This makes `BlankLinePreservation` (which keys off "space" tokens) work
 * uniformly across all block types.
 *
 * The editor keeps Marked's CommonMark soft line endings inside text tokens
 * when `breaks` is disabled. A ProseMirror decoration renders those characters
 * as wrapping whitespace without changing their serialized source positions.
 */

import type { MarkedOptions } from 'marked';

type RawToken = { type?: string; raw?: string } & Record<string, unknown>;

export const EDITOR_MARKED_OPTIONS = {
  gfm: true,
  breaks: false,
} satisfies MarkedOptions;

/**
 * Detect link/image inline tokens whose VISIBLE text is empty.
 *
 * A `link` or `image` with empty visible content (no inner tokens, or all
 * inner tokens render to nothing) parses through the @tiptap/markdown
 * pipeline as an empty inline node; ProseMirror schema validation then drops
 * it, silently erasing the original markdown source from the document. This
 * happens regardless of where the empty inline sits — alone in a paragraph
 * (`[]()`), next to a soft break (`Even deeper.\n[]()`), in the middle of
 * other text (`foo []() bar`), or inside a list item / blockquote.
 *
 * We catch each empty link/image at the lexer layer and rewrite it to a
 * literal-text token carrying its own raw markdown. The text node round-trips
 * losslessly: on save it serialises back to its original raw form and
 * re-lexing routes through this same normaliser to keep the cycle stable.
 */
function isInlineRenderEmpty(tok: RawToken | undefined): boolean {
  if (!tok || typeof tok.type !== 'string') return true;
  if (tok.type === 'text' || tok.type === 'escape') {
    const text = typeof tok.text === 'string' ? tok.text : '';
    return text.trim().length === 0;
  }
  if (tok.type === 'image') {
    // An image with a valid src/href is visible regardless of alt text — `<img>`
    // does not need an alt to render. Only treat the token as render-empty when
    // BOTH alt and href are missing, so `![](url)` survives as a real image
    // node (and gets URL-checked by the audit) instead of being demoted to
    // literal text.
    const href =
      typeof (tok as { href?: string }).href === 'string'
        ? ((tok as { href?: string }).href as string)
        : '';
    if (href.trim().length > 0) return false;
    const text =
      typeof (tok as { text?: string }).text === 'string'
        ? ((tok as { text?: string }).text as string)
        : '';
    if (text.trim().length > 0) return false;
    const inner = Array.isArray((tok as { tokens?: RawToken[] }).tokens)
      ? ((tok as { tokens?: RawToken[] }).tokens as RawToken[])
      : [];
    return inner.every(isInlineRenderEmpty);
  }
  if (tok.type === 'link') {
    const text =
      typeof (tok as { text?: string }).text === 'string'
        ? ((tok as { text?: string }).text as string)
        : '';
    if (text.trim().length > 0) return false;
    const inner = Array.isArray((tok as { tokens?: RawToken[] }).tokens)
      ? ((tok as { tokens?: RawToken[] }).tokens as RawToken[])
      : [];
    return inner.every(isInlineRenderEmpty);
  }
  return false;
}

function isEmptyLinkLike(tok: RawToken): boolean {
  if (!tok || (tok.type !== 'link' && tok.type !== 'image')) return false;
  return isInlineRenderEmpty(tok);
}

/**
 * Walk a paragraph's inline-token array and replace every empty link/image,
 * raw HTML tag, or backslash-escape token with a literal-text token. Mutates
 * the array in place. Returns whether any rewrite happened.
 */
function rewriteEmptyInlines(inlines: RawToken[]): boolean {
  let changed = false;
  for (let i = 0; i < inlines.length; i++) {
    const tok = inlines[i];
    if (!tok) continue;
    if (tok.type === 'escape') {
      const text = typeof tok.text === 'string' ? tok.text : '';
      const raw = typeof tok.raw === 'string' && tok.raw.length > 0 ? tok.raw : `\\${text}`;
      inlines[i] = { type: 'text', raw, text: raw } as RawToken;
      changed = true;
    } else if (isEmptyLinkLike(tok) || tok.type === 'html') {
      const raw = typeof tok.raw === 'string' ? tok.raw : '';
      if (raw.length > 0) {
        inlines[i] = { type: 'text', raw, text: raw } as RawToken;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Recursively walk the token tree, applying inline rewriting to every
 * paragraph/heading/text node we find — including those nested inside list
 * items, blockquotes and headings. Marked's tree shape:
 *   - `paragraph`, `heading`, `lheading`: inline tokens in `tokens`
 *   - `blockquote`: child blocks in `tokens`
 *   - `list`: child items in `items`
 *   - `list_item`: child blocks in `tokens`
 *   - `table`: cells in `header` and `rows`, each cell carrying inline tokens
 */
function normalizeEmptyInlinesDeep(tokens: RawToken[] | undefined): void {
  if (!Array.isArray(tokens)) return;
  for (const token of tokens) {
    if (!token || typeof token.type !== 'string') continue;
    // `paragraph`, `heading`, `lheading` and tight-list `text` blocks all
    // carry inline tokens in `.tokens`.
    if (
      token.type === 'paragraph' ||
      token.type === 'text' ||
      token.type === 'heading' ||
      token.type === 'lheading'
    ) {
      const inlines = (token as { tokens?: RawToken[] }).tokens;
      if (Array.isArray(inlines)) rewriteEmptyInlines(inlines);
      continue;
    }
    if (token.type === 'list') {
      normalizeEmptyInlinesDeep((token as { items?: RawToken[] }).items);
      continue;
    }
    if (token.type === 'list_item' || token.type === 'blockquote') {
      normalizeEmptyInlinesDeep((token as { tokens?: RawToken[] }).tokens);
      continue;
    }
    if (token.type === 'table') {
      const table = token as {
        header?: { tokens?: RawToken[] }[];
        rows?: { tokens?: RawToken[] }[][];
      };
      for (const cell of table.header ?? []) {
        if (Array.isArray(cell?.tokens)) rewriteEmptyInlines(cell.tokens);
      }
      for (const row of table.rows ?? []) {
        for (const cell of row ?? []) {
          if (Array.isArray(cell?.tokens)) rewriteEmptyInlines(cell.tokens);
        }
      }
      continue;
    }
  }
}

const GREEDY_BLOCK_TYPES = new Set([
  'heading',
  'table',
  'code',
  'hr',
  'lheading',
  'list',
  'blockquote',
  'html',
]);

function splitTrailingNewlines(token: RawToken): RawToken[] {
  const raw = typeof token.raw === 'string' ? token.raw : '';
  const match = raw.match(/\n+$/);
  if (!match || match[0].length < 2) {
    return [token];
  }

  const trailing = match[0];
  const trimmedRaw = raw.slice(0, raw.length - trailing.length);

  // Mutate raw on the original token. Other fields (text, depth, tokens, …)
  // were derived from a regex capture that doesn't include trailing
  // whitespace anyway, so they remain valid.
  token.raw = trimmedRaw;

  return [token, { type: 'space', raw: trailing } as RawToken];
}

/**
 * Walk a token array (as produced by `marked.lexer(src)`) and split blank-line
 * runs that were greedily absorbed by block tokens into synthetic space
 * tokens. Preserves the array's `links` property (marked attaches reference
 * link definitions to the tokens array as a non-index property).
 */
export function normalizeBlankLineGreedyTokens<T extends RawToken[]>(tokens: T): T {
  // Rewrite empty link/image inlines at every depth before the greedy-newline
  // split runs — that way both whole-empty paragraphs (`[]()`) and mixed
  // paragraphs (`Even deeper.\n[]()`) carry the original markdown forward as
  // literal text instead of letting the inline get stripped on parse.
  normalizeEmptyInlinesDeep(tokens);
  const out: RawToken[] = [];
  for (const token of tokens) {
    if (token && typeof token.type === 'string' && GREEDY_BLOCK_TYPES.has(token.type)) {
      out.push(...splitTrailingNewlines(token));
    } else {
      out.push(token);
    }
  }

  // Preserve the `links` side-channel that marked attaches to the tokens array.
  const links = (tokens as unknown as { links?: unknown }).links;
  if (links !== undefined) {
    (out as unknown as { links?: unknown }).links = links;
  }

  return out as T;
}

/**
 * Wrap a marked instance's `lexer` function so every parse pass routes
 * through `normalizeBlankLineGreedyTokens`. Idempotent: re-installing on the
 * same instance is a no-op.
 */
export function installBlankLineLexerNormalizer(managerOrMarked: unknown): void {
  type LexerLike = { lex?: (src: string) => RawToken[] };
  const inst = managerOrMarked as {
    instance?: unknown;
    lexer?: (src: string, options?: unknown) => RawToken[];
    createLexer?: () => LexerLike;
    encodeTextForMarkdown?: (text: string, node?: unknown, parentNode?: unknown) => string;
    __mdh_blankLineNormalizerInstalled?: boolean;
  };
  if (!inst) return;
  if (inst.__mdh_blankLineNormalizerInstalled) return;

  const markedInst = (inst.instance !== undefined ? inst.instance : inst) as typeof inst;

  if (typeof inst.createLexer === 'function') {
    const originalCreateLexer = inst.createLexer.bind(inst);
    inst.createLexer = function patchedCreateLexer(): LexerLike {
      const lexer = originalCreateLexer();
      if (typeof lexer.lex === 'function') {
        const originalLex = lexer.lex.bind(lexer);
        lexer.lex = function patchedLex(src: string): RawToken[] {
          return normalizeBlankLineGreedyTokens(originalLex(src));
        };
      }
      return lexer;
    };
  }

  if (typeof markedInst.lexer === 'function') {
    const original = markedInst.lexer.bind(markedInst);
    markedInst.lexer = function patchedLexer(src: string, options?: unknown): RawToken[] {
      const tokens = original(src, options);
      return normalizeBlankLineGreedyTokens(tokens);
    };
  }

  if (typeof inst.encodeTextForMarkdown === 'function') {
    inst.encodeTextForMarkdown = (text: string): string => text;
  }

  inst.__mdh_blankLineNormalizerInstalled = true;
}
