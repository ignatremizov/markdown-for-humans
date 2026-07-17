/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for Search Overlay - In-document Search Feature
 *
 * Tests the search functionality that allows users to find text
 * within the document with highlighting and navigation.
 *
 * Note: These tests focus on pure logic functions that can be tested
 * without a full DOM or editor instance. Integration testing would
 * require a more complete browser environment.
 */

/**
 * NOTE: The logic tests below are DOM-free. The UI tests use a lightweight mock
 * of the search overlay to validate focus/keyboard behavior without pulling in
 * the full TipTap editor.
 */

jest.mock('@tiptap/pm/view', () => {
  const Decoration = {
    inline: jest.fn(() => ({})),
  };
  type MockDecorationSet = { map: jest.Mock };
  const makeSet = (): MockDecorationSet => ({
    map: jest.fn(() => makeSet()),
  });
  const DecorationSet = {
    empty: makeSet(),
    create: jest.fn(() => makeSet()),
  };
  return { Decoration, DecorationSet };
});

jest.mock('@tiptap/pm/state', () => {
  class PluginKey {
    key: string;
    constructor(key: string) {
      this.key = key;
    }
  }
  class Plugin {
    key: string | undefined;
    props: Record<string, unknown>;
    spec: { props?: Record<string, unknown>; key?: string };
    constructor(spec: { props?: Record<string, unknown>; key?: string }) {
      this.spec = spec;
      this.props = spec.props || {};
      this.key = spec.key;
    }
  }
  return { PluginKey, Plugin };
});

import type { Editor } from '@tiptap/core';
import {
  disposeSearchOverlay,
  findMatchBatch,
  findMatches,
  showSearchOverlay,
  hideSearchOverlay,
  isSearchVisible,
  resolveNextSearchNavigation,
  resolvePreviousSearchNavigation,
} from '../../webview/features/searchOverlay';

type MockEditor = {
  view: {
    dispatch: jest.Mock;
    coordsAtPos: jest.Mock;
    domAtPos: jest.Mock;
  };
  commands: {
    setTextSelection: jest.Mock;
    focus: jest.Mock;
  };
  state: {
    tr: { scrollIntoView: jest.Mock };
    plugins: unknown[];
    selection: { from: number; to: number };
    doc: {
      descendants: jest.Mock;
      textBetween: jest.Mock;
    };
  };
  registerPlugin: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
};

// Minimal DOM + editor mocks for UI behavior tests
function createMockEditorWithView(text: string): MockEditor {
  const dispatch = jest.fn();
  const coordsAtPos = jest.fn().mockReturnValue({ left: 0, top: 100 });
  const domAtPos = jest.fn().mockReturnValue({
    node: (() => {
      const el = document.createElement('div');
      (el as unknown as { scrollIntoView?: jest.Mock }).scrollIntoView = jest.fn();
      return el;
    })(),
    offset: 0,
  });
  const view = { dispatch, coordsAtPos, domAtPos };

  const commands = {
    setTextSelection: jest.fn(),
    focus: jest.fn(),
  };

  const tr: {
    mapping: Record<string, unknown>;
    scrollIntoView: jest.Mock;
    setMeta: jest.Mock;
    getMeta: jest.Mock;
  } = {
    mapping: {},
    scrollIntoView: jest.fn(() => tr),
    setMeta: jest.fn(() => tr),
    getMeta: jest.fn(() => undefined),
  };

  const state = {
    tr,
    plugins: [] as Array<{ key?: string; props?: Record<string, unknown> }>,
    selection: { from: 0, to: text.length },
    doc: {
      descendants: jest.fn(
        (cb: (node: { isText: boolean; text: string }, pos: number) => boolean) => {
          cb({ isText: true, text }, 1);
          return true;
        }
      ),
      textBetween: jest.fn(() => text),
    },
  };

  return {
    view,
    commands,
    state,
    registerPlugin: jest.fn((plugin: { key?: string; props?: Record<string, unknown> }) => {
      state.plugins.push(plugin);
    }),
    on: jest.fn(),
    off: jest.fn(),
  };
}

// Mock TipTap editor for testing
function createMockEditor(content: string) {
  // Simulate document structure: paragraphs with text nodes
  const textNodes: Array<{ text: string; pos: number }> = [];
  let pos = 1; // ProseMirror positions start at 1

  // Split content by newlines to simulate paragraphs
  const paragraphs = content.split('\n');
  paragraphs.forEach(para => {
    if (para.length > 0) {
      textNodes.push({ text: para, pos });
    }
    pos += para.length + 2; // +2 for paragraph node overhead
  });

  return {
    state: {
      doc: {
        descendants: (
          callback: (node: { isText: boolean; text: string }, pos: number) => boolean
        ) => {
          textNodes.forEach(({ text, pos }) => {
            callback({ isText: true, text }, pos);
          });
          return true;
        },
      },
    },
  };
}

function setWindowScrollPosition(x: number, y: number) {
  Object.defineProperty(window, 'scrollX', { configurable: true, value: x });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  Object.defineProperty(window, 'pageXOffset', { configurable: true, value: x });
  Object.defineProperty(window, 'pageYOffset', { configurable: true, value: y });
}

describe('Search Overlay', () => {
  describe('findMatches', () => {
    it('should return empty array for empty query', () => {
      const editor = createMockEditor('Hello world');
      const result = findMatches(editor as unknown as Editor, '');
      expect(result).toEqual([]);
    });

    it('should find single match', () => {
      const editor = createMockEditor('Hello world');
      const result = findMatches(editor as unknown as Editor, 'world');

      expect(result).toHaveLength(1);
      expect(result[0].to - result[0].from).toBe(5); // 'world' length
    });

    it('should find multiple matches', () => {
      const editor = createMockEditor('Hello world, wonderful world');
      const result = findMatches(editor as unknown as Editor, 'world');

      expect(result).toHaveLength(2);
    });

    it('should be case-insensitive', () => {
      const editor = createMockEditor('Hello WORLD, World, world');
      const result = findMatches(editor as unknown as Editor, 'world');

      expect(result).toHaveLength(3);
    });

    it('should find overlapping matches', () => {
      const editor = createMockEditor('aaaa');
      const result = findMatches(editor as any, 'aa');

      // Should find matches at positions 0, 1, 2
      expect(result).toHaveLength(3);
    });

    it('should return empty array when no matches found', () => {
      const editor = createMockEditor('Hello world');
      const result = findMatches(editor as any, 'xyz');

      expect(result).toEqual([]);
    });

    it('should handle single character search', () => {
      const editor = createMockEditor('aaa');
      const result = findMatches(editor as any, 'a');

      expect(result).toHaveLength(3);
    });

    it('should handle special characters in search', () => {
      const editor = createMockEditor('Hello (world)');
      const result = findMatches(editor as any, '(world)');

      expect(result).toHaveLength(1);
    });

    it('should handle whitespace in query', () => {
      const editor = createMockEditor('Hello world');
      const result = findMatches(editor as any, 'lo wo');

      expect(result).toHaveLength(1);
    });

    it('should match a visible space across a preserved soft source wrap', () => {
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) =>
              callback({ isText: true, text: 'Alpha\nbeta' }, 1, {
                type: { name: 'paragraph' },
              }),
          },
        },
      };

      expect(findMatches(editor as unknown as Editor, 'alpha beta')).toEqual([{ from: 1, to: 11 }]);
    });

    it('matches CommonMark-collapsed prose whitespace and maps it to the full source run', () => {
      const text = 'Alpha  beta\tgamma\nnext';
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) =>
              callback({ isText: true, text }, 1, {
                type: { name: 'paragraph' },
              }),
          },
        },
      };

      expect(findMatches(editor as unknown as Editor, 'alpha beta gamma next')).toEqual([
        { from: 1, to: text.length + 1 },
      ]);
      expect(findMatches(editor as unknown as Editor, 'alpha  beta')).toEqual([]);
    });

    it('preserves literal code-block newlines in the search text model', () => {
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) =>
              callback({ isText: true, text: 'foo\nbar' }, 1, {
                type: { name: 'codeBlock' },
              }),
          },
        },
      };

      expect(findMatches(editor as unknown as Editor, 'foo bar')).toEqual([]);
      expect(findMatches(editor as unknown as Editor, 'foo\nbar')).toEqual([{ from: 1, to: 8 }]);
    });

    it('should match visible text across contiguous marked text nodes', () => {
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (node: { isText: boolean; text: string }, pos: number) => boolean
            ) => {
              callback({ isText: true, text: 'Alpha ' }, 1);
              callback({ isText: true, text: 'beta' }, 7);
              return true;
            },
          },
        },
      };

      expect(findMatches(editor as unknown as Editor, 'alpha beta')).toEqual([{ from: 1, to: 11 }]);
    });

    it('collapses a whitespace run split across contiguous marked text nodes', () => {
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) => {
              const parent = { type: { name: 'paragraph' } };
              callback({ isText: true, text: 'Alpha ' }, 1, parent);
              callback({ isText: true, text: ' beta' }, 7, parent);
              return true;
            },
          },
        },
      };

      expect(findMatches(editor as unknown as Editor, 'alpha beta')).toEqual([{ from: 1, to: 12 }]);
    });

    it('should handle unicode characters', () => {
      const editor = createMockEditor('Hello 世界');
      const result = findMatches(editor as any, '世界');

      expect(result).toHaveLength(1);
    });

    it('maps expanding Unicode case folds back to one source character', () => {
      const editor = createMockEditor('İstanbul');

      expect(findMatches(editor as unknown as Editor, 'İ')).toEqual([{ from: 1, to: 2 }]);
    });

    it('applies context-sensitive Unicode case folding across the complete text run', () => {
      const editor = createMockEditor('ΟΣ');

      expect(findMatches(editor as unknown as Editor, 'ος')).toEqual([{ from: 1, to: 3 }]);
      expect(findMatches(editor as unknown as Editor, 'ΟΣ')).toEqual([{ from: 1, to: 3 }]);
    });

    it('treats medial and final Greek sigma as the same case-folded character', () => {
      const wordEditor = createMockEditor('ΟΣ');
      const letterEditor = createMockEditor('Σ');

      expect(findMatches(wordEditor as unknown as Editor, 'οσ')).toEqual([{ from: 1, to: 3 }]);
      expect(findMatches(letterEditor as unknown as Editor, 'ς')).toEqual([{ from: 1, to: 2 }]);
    });

    it('should handle emoji in text', () => {
      const editor = createMockEditor('Hello 🎉 world');
      const result = findMatches(editor as any, '🎉');

      expect(result).toHaveLength(1);
    });
  });

  describe('match positions', () => {
    it('should return correct from/to positions', () => {
      const editor = createMockEditor('Hello world');
      const result = findMatches(editor as unknown as Editor, 'world');

      expect(result).toHaveLength(1);
      // The exact position depends on the mock structure
      // but to - from should always equal query length
      expect(result[0].to - result[0].from).toBe(5);
    });

    it('should track position across multiple text nodes', () => {
      const editor = createMockEditor('First line\nSecond line');
      const result = findMatches(editor as any, 'line');

      // Should find 'line' in both paragraphs
      expect(result).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('should handle empty document', () => {
      const editor = createMockEditor('');
      const result = findMatches(editor as any, 'test');

      expect(result).toEqual([]);
    });

    it('should handle query longer than document', () => {
      const editor = createMockEditor('Hi');
      const result = findMatches(editor as any, 'This is a very long query');

      expect(result).toEqual([]);
    });

    it('should handle very long document', () => {
      const longContent = 'test '.repeat(1000);
      const editor = createMockEditor(longContent);
      const result = findMatches(editor as any, 'test');

      expect(result).toHaveLength(1000);
    });

    it('searches a 10,000-line prose block within the interaction budget', () => {
      const text = Array.from({ length: 10_000 }, () => 'a'.repeat(79)).join('\n');
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) => callback({ isText: true, text }, 1, { type: { name: 'paragraph' } }),
          },
        },
      };
      const startedAt = performance.now();

      expect(findMatches(editor as unknown as Editor, 'not-present')).toEqual([]);
      expect(performance.now() - startedAt).toBeLessThan(50);
    });

    it('keeps a rare expanding fold sparse in a 10,000-line prose block', () => {
      const text = `${'İ'}${Array.from({ length: 10_000 }, () => 'a'.repeat(79)).join('\n')}`;
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) => callback({ isText: true, text }, 1, { type: { name: 'paragraph' } }),
          },
        },
      };
      const startedAt = performance.now();

      expect(findMatches(editor as unknown as Editor, 'not-present')).toEqual([]);
      expect(performance.now() - startedAt).toBeLessThan(50);
    });

    it('searches dense collapsed whitespace within the interaction budget', () => {
      const text = Array.from({ length: 10_000 }, () => 'alpha  beta').join('\n');
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) => callback({ isText: true, text }, 1, { type: { name: 'paragraph' } }),
          },
        },
      };
      const startedAt = performance.now();

      expect(findMatches(editor as unknown as Editor, 'not-present')).toEqual([]);
      expect(performance.now() - startedAt).toBeLessThan(50);
    });

    it('searches many contiguous marked segments and matches within the interaction budget', () => {
      const segmentCount = 10_000;
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) => {
              for (let index = 0; index < segmentCount; index += 1) {
                callback({ isText: true, text: 'a' }, index + 1, {
                  type: { name: 'paragraph' },
                });
              }
              return true;
            },
          },
        },
      };
      const startedAt = performance.now();

      expect(findMatches(editor as unknown as Editor, 'a')).toHaveLength(segmentCount);
      expect(performance.now() - startedAt).toBeLessThan(50);
    });

    it('caps a common query before it can allocate unbounded matches', () => {
      const editor = {
        state: {
          doc: {
            descendants: (
              callback: (
                node: { isText: boolean; text: string },
                pos: number,
                parent: { type: { name: string } }
              ) => boolean
            ) =>
              callback({ isText: true, text: 'a'.repeat(100_000) }, 1, {
                type: { name: 'paragraph' },
              }),
          },
        },
      };
      const startedAt = performance.now();

      expect(findMatches(editor as unknown as Editor, 'a')).toHaveLength(10_000);
      expect(performance.now() - startedAt).toBeLessThan(50);
    });

    it('should handle special regex characters safely', () => {
      const editor = createMockEditor('Hello [world] (test) {foo}');

      // These should not throw errors (no regex interpretation)
      expect(() => findMatches(editor as unknown as Editor, '[world]')).not.toThrow();
      expect(() => findMatches(editor as unknown as Editor, '(test)')).not.toThrow();
      expect(() => findMatches(editor as unknown as Editor, '{foo}')).not.toThrow();
      expect(() => findMatches(editor as unknown as Editor, '.*')).not.toThrow();
    });

    it('should handle backslash in query', () => {
      const editor = createMockEditor('path\\to\\file');
      const result = findMatches(editor as unknown as Editor, '\\');

      expect(result).toHaveLength(2);
    });
  });
});

describe('Search Overlay UI behaviors', () => {
  let editor: MockEditor;

  beforeEach(() => {
    // Clean DOM between tests
    document.body.innerHTML = '';
    // Mock window.scrollTo (not implemented in jsdom)
    window.scrollTo = jest.fn();
    setWindowScrollPosition(0, 0);
    editor = createMockEditorWithView('hello hello');
  });

  afterEach(() => {
    hideSearchOverlay(editor as unknown as Editor, false);
  });

  it('focuses the search input when shown', () => {
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('uses collapsed visible whitespace when seeding Find from selected prose', () => {
    const text = 'Beta  gamma\tdelta\nnext';
    editor.state.selection = { from: 1, to: text.length + 1 };
    editor.state.doc.descendants.mockImplementation(callback =>
      callback({ isText: true, text }, 1, {
        type: { name: 'paragraph' },
      })
    );

    showSearchOverlay(editor as unknown as Editor);

    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    expect(input.value).toBe('Beta gamma delta next');
    expect(editor.commands.setTextSelection).toHaveBeenCalledWith({
      from: 1,
      to: text.length + 1,
    });
  });

  it.each([
    [
      'paragraphs',
      [
        { text: 'Alpha', pos: 1, parent: 'paragraph' },
        { text: 'Beta', pos: 8, parent: 'paragraph' },
      ],
    ],
    [
      'an explicit hard break',
      [
        { text: 'Alpha', pos: 1, parent: 'paragraph' },
        { text: 'Beta', pos: 7, parent: 'paragraph' },
      ],
    ],
    ['multiline code', [{ text: 'Alpha\nBeta', pos: 1, parent: 'codeBlock' }]],
  ])('does not seed a Find query across %s', (_case, textNodes) => {
    editor.state.selection = { from: 1, to: 12 };
    editor.state.doc.descendants.mockImplementation(callback => {
      textNodes.forEach(({ text, pos, parent }) => {
        callback({ isText: true, text }, pos, { type: { name: parent } });
      });
      return true;
    });

    showSearchOverlay(editor as unknown as Editor);

    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(editor.commands.setTextSelection).not.toHaveBeenCalled();
  });

  it('seeds a Find query across contiguous marked text nodes', () => {
    editor.state.selection = { from: 1, to: 11 };
    editor.state.doc.descendants.mockImplementation(callback => {
      callback({ isText: true, text: 'Alpha ' }, 1, { type: { name: 'paragraph' } });
      callback({ isText: true, text: 'Beta' }, 7, { type: { name: 'paragraph' } });
      return true;
    });

    showSearchOverlay(editor as unknown as Editor);

    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    expect(input.value).toBe('Alpha Beta');
    expect(editor.commands.setTextSelection).toHaveBeenCalledWith({ from: 1, to: 11 });
  });

  it('keeps the search overlay open and refocuses the input when shown again', () => {
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);
    outsideButton.focus();

    expect(document.activeElement).toBe(outsideButton);

    showSearchOverlay(editor as unknown as Editor);

    expect(isSearchVisible()).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('preserves the existing query when refocusing an already open overlay', () => {
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange(1, 1);

    showSearchOverlay(editor as unknown as Editor);

    expect(isSearchVisible()).toBe(true);
    expect(input.value).toBe('zzz');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('retries focus when the first focus attempt is ignored', () => {
    jest.useFakeTimers();
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const originalFocus = HTMLInputElement.prototype.focus;
    let attempts = 0;
    const focusSpy = jest.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(function (
      this: HTMLInputElement,
      options?: FocusOptions
    ) {
      attempts += 1;
      if (attempts >= 3) {
        originalFocus.call(this, options);
      }
    });

    try {
      showSearchOverlay(editor as unknown as Editor);
      const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
      expect(document.activeElement).not.toBe(input);

      jest.runAllTimers();

      expect(document.activeElement).toBe(input);
      expect(focusSpy).toHaveBeenCalledTimes(3);
    } finally {
      focusSpy.mockRestore();
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      jest.useRealTimers();
    }
  });

  it('Cmd/Ctrl+A selects all text within the search input', () => {
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'hello world';
    input.setSelectionRange(5, 5);

    const evt = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true });
    Object.defineProperty(evt, 'preventDefault', { value: jest.fn(), writable: true });
    Object.defineProperty(evt, 'stopPropagation', { value: jest.fn(), writable: true });
    input.dispatchEvent(evt);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('Enter cycles to next match and keeps input focused', () => {
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // First match selected on initial search
    const firstSelection = editor.commands.setTextSelection.mock.calls.at(-1)?.[0];
    expect(firstSelection?.from).toBeDefined();

    // Press Enter to go to next match
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    input.dispatchEvent(enter);

    const secondSelection = editor.commands.setTextSelection.mock.calls.at(-1)?.[0];
    expect(secondSelection?.from).toBeGreaterThan(firstSelection.from);
    expect(document.activeElement).toBe(input);
  });

  it('recomputes visible matches after the document changes without scrolling', () => {
    editor.state.selection = { from: 0, to: 0 };
    editor.state.doc.textBetween.mockReturnValue('');
    editor.state.doc.descendants.mockImplementation(callback =>
      callback({ isText: true, text: 'foo' }, 1, {
        type: { name: 'paragraph' },
      })
    );
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'foo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('1 of 1');

    editor.commands.setTextSelection.mockClear();
    editor.state.doc.descendants.mockImplementation(callback =>
      callback({ isText: true, text: 'foo bar foo' }, 1, {
        type: { name: 'paragraph' },
      })
    );
    const transactionListener = editor.on.mock.calls.find(
      ([event]) => event === 'transaction'
    )?.[1];
    expect(transactionListener).toBeDefined();

    jest.useFakeTimers();
    try {
      transactionListener({
        transaction: {
          docChanged: true,
          mapping: { map: (position: number) => position },
        },
      });

      expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('1 of 1');
      expect(editor.commands.setTextSelection).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();

      expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('1 of 2');
      expect(editor.commands.setTextSelection).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a later-batch active match anchored when earlier matches are inserted', () => {
    editor.state.selection = { from: 0, to: 0 };
    editor.state.doc.textBetween.mockReturnValue('');
    editor.state.doc.descendants.mockImplementation(callback =>
      callback({ isText: true, text: 'a'.repeat(20_001) }, 1, {
        type: { name: 'paragraph' },
      })
    );
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const previous = document.querySelector(
      '.search-overlay-btn[title^="Previous"]'
    ) as HTMLButtonElement;
    previous.click();

    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('20001 of 20001');
    expect(editor.commands.setTextSelection).toHaveBeenLastCalledWith({
      from: 20_001,
      to: 20_002,
    });

    editor.commands.setTextSelection.mockClear();
    editor.state.doc.descendants.mockImplementation(callback =>
      callback({ isText: true, text: 'a'.repeat(25_001) }, 1, {
        type: { name: 'paragraph' },
      })
    );
    const transactionListener = editor.on.mock.calls.find(
      ([event]) => event === 'transaction'
    )?.[1];
    expect(transactionListener).toBeDefined();

    jest.useFakeTimers();
    try {
      transactionListener({
        transaction: {
          docChanged: true,
          mapping: { map: (position: number) => position + 5_000 },
        },
      });
      jest.runOnlyPendingTimers();

      expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('25001 of 25001');
      expect(editor.commands.setTextSelection).not.toHaveBeenCalled();

      const next = document.querySelector(
        '.search-overlay-btn[title^="Next"]'
      ) as HTMLButtonElement;
      next.click();
      expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('1 of 10000+');
      expect(editor.commands.setTextSelection).toHaveBeenLastCalledWith({
        from: 1,
        to: 2,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rebinds overlay controls when the editor instance is recreated', () => {
    editor.state.selection = { from: 0, to: 0 };
    editor.state.doc.textBetween.mockReturnValue('');
    showSearchOverlay(editor as unknown as Editor);

    const replacementEditor = createMockEditorWithView('replacement replacement');
    replacementEditor.state.selection = { from: 0, to: 0 };
    replacementEditor.state.doc.textBetween.mockReturnValue('');
    editor.commands.setTextSelection.mockClear();

    showSearchOverlay(replacementEditor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'replacement';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(editor.off).toHaveBeenCalledWith('transaction', expect.any(Function));
    expect(editor.commands.setTextSelection).not.toHaveBeenCalled();
    expect(replacementEditor.commands.setTextSelection).toHaveBeenCalledWith({
      from: 1,
      to: 12,
    });

    hideSearchOverlay(replacementEditor as unknown as Editor, false);
  });

  it('disposes overlay controls and transaction listeners with the editor', () => {
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    disposeSearchOverlay(editor as unknown as Editor);

    expect(document.querySelector('.search-overlay')).toBeNull();
    expect(isSearchVisible()).toBe(false);
    expect(editor.off).toHaveBeenCalledWith('transaction', expect.any(Function));
  });

  it('reports bounded batches honestly and navigates across them in both directions', () => {
    const text = 'a'.repeat(10_001);
    editor.state.selection = { from: 0, to: 0 };
    editor.state.doc.textBetween.mockReturnValue('');
    editor.state.doc.descendants.mockImplementation(callback =>
      callback({ isText: true, text }, 1, {
        type: { name: 'paragraph' },
      })
    );
    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('1 of 10000+');

    const previous = document.querySelector(
      '.search-overlay-btn[title^="Previous"]'
    ) as HTMLButtonElement;
    const next = document.querySelector('.search-overlay-btn[title^="Next"]') as HTMLButtonElement;
    previous.click();
    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('10001 of 10001');
    expect(editor.commands.setTextSelection).toHaveBeenLastCalledWith({
      from: 10_001,
      to: 10_002,
    });

    previous.click();
    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('10000 of 10001');

    next.click();

    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('10001 of 10001');
    expect(editor.commands.setTextSelection).toHaveBeenLastCalledWith({
      from: 10_001,
      to: 10_002,
    });

    next.click();
    expect(document.querySelector('.search-overlay-counter')?.textContent).toBe('1 of 10000+');
  });

  it('resolves non-aligned navigation boundaries across more than two match batches', () => {
    const text = 'a'.repeat(25_003);
    const denseEditor = createMockEditorWithView(text);
    const firstBatch = findMatchBatch(denseEditor as unknown as Editor, 'a');
    const middleBatch = findMatchBatch(denseEditor as unknown as Editor, 'a', 5_003);
    const lastBatch = findMatchBatch(denseEditor as unknown as Editor, 'a', 15_003);

    expect(firstBatch.matches[0]).toEqual({ from: 1, to: 2 });
    expect(firstBatch.hasMore).toBe(true);
    expect(middleBatch.matches[0]).toEqual({ from: 5_004, to: 5_005 });
    expect(middleBatch.matches.at(-1)).toEqual({ from: 15_003, to: 15_004 });
    expect(middleBatch.hasMore).toBe(true);
    expect(lastBatch.matches[0]).toEqual({ from: 15_004, to: 15_005 });
    expect(lastBatch.matches.at(-1)).toEqual({ from: 25_003, to: 25_004 });
    expect(lastBatch.hasMore).toBe(false);

    expect(
      resolvePreviousSearchNavigation({
        currentIndex: 0,
        currentOffset: 15_003,
        currentBatchLength: 10_000,
        currentBatchHasMore: false,
      })
    ).toEqual({ kind: 'batch', offset: 5_003, index: 9_999 });
    expect(
      resolvePreviousSearchNavigation({
        currentIndex: 0,
        currentOffset: 5_003,
        currentBatchLength: 10_000,
        currentBatchHasMore: true,
      })
    ).toEqual({ kind: 'batch', offset: 0, index: 5_002 });

    expect(
      resolveNextSearchNavigation({
        currentIndex: 9_999,
        currentOffset: 5_003,
        currentBatchLength: 10_000,
        currentBatchHasMore: true,
      })
    ).toEqual({ kind: 'batch', offset: 15_003, index: 0 });
    expect(
      resolveNextSearchNavigation({
        currentIndex: 9_999,
        currentOffset: 15_003,
        currentBatchLength: 10_000,
        currentBatchHasMore: false,
      })
    ).toEqual({ kind: 'batch', offset: 0, index: 0 });
  });

  it('keeps the current match selected when closing after a search', () => {
    editor.state.selection = { from: 0, to: 0 };
    editor.state.doc.textBetween.mockReturnValue('');

    showSearchOverlay(editor as unknown as Editor);
    const input = document.querySelector('.search-overlay-input') as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const matchSelection = editor.commands.setTextSelection.mock.calls.at(-1)?.[0];
    expect(matchSelection).toEqual({ from: 1, to: 6 });

    hideSearchOverlay(editor as unknown as Editor);

    expect(editor.commands.setTextSelection).not.toHaveBeenLastCalledWith({ from: 0, to: 0 });
    expect(editor.commands.setTextSelection).toHaveBeenLastCalledWith(matchSelection);
  });

  it('restores cursor position when closed without navigation or manual scrolling', () => {
    editor.state.selection = { from: 3, to: 3 };
    editor.state.doc.textBetween.mockReturnValue('');
    setWindowScrollPosition(0, 120);

    showSearchOverlay(editor as unknown as Editor);
    editor.commands.setTextSelection.mockClear();
    editor.commands.focus.mockClear();

    hideSearchOverlay(editor as unknown as Editor);

    expect(editor.commands.setTextSelection).toHaveBeenCalledWith({ from: 3, to: 3 });
    expect(editor.commands.focus).toHaveBeenCalledWith();
  });

  it('does not jump back to the open position when closing after manual scrolling', () => {
    editor.state.selection = { from: 4, to: 4 };
    editor.state.doc.textBetween.mockReturnValue('');
    setWindowScrollPosition(0, 100);

    showSearchOverlay(editor as unknown as Editor);
    editor.commands.setTextSelection.mockClear();
    editor.commands.focus.mockClear();

    setWindowScrollPosition(0, 900);
    hideSearchOverlay(editor as unknown as Editor);

    expect(editor.commands.setTextSelection).not.toHaveBeenCalled();
    expect(editor.commands.focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
  });
});

describe('Search Overlay UI behavior (future tests)', () => {
  // Placeholder for additional integration tests that require a full editor environment
  describe('integration tests requiring full TipTap', () => {
    it.todo('should highlight all matches with ProseMirror decorations');
    it.todo('should wrap around from last to first match');
  });
});
