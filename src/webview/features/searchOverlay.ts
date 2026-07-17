/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';

/**
 * Search Overlay - In-document search for Markdown for Humans
 *
 * Provides a search experience with:
 * - Real-time match highlighting
 * - Navigation between matches (next/previous)
 * - Visual match counter
 * - Keyboard shortcuts (Enter: next, Shift+Enter: previous, Escape: close)
 */

// Plugin key for search decorations
const searchPluginKey = new PluginKey('search-highlight');
const MAX_SEARCH_MATCHES = 10_000;
const SEARCH_REFRESH_DELAY_MS = 100;

// Search state
let searchOverlayElement: HTMLElement | null = null;
let searchOverlayEditor: Editor | null = null;
let isVisible = false;
let savedSelection: { from: number; to: number } | null = null;
let savedScrollPosition: { x: number; y: number } | null = null;
let currentQuery = '';
let currentMatches: Array<{ from: number; to: number }> = [];
let currentMatchIndex = -1;
let currentMatchOffset = 0;
let currentBatchHasMore = false;
let searchPlugin: Plugin | null = null;
let transactionListenerEditor: Editor | null = null;
let transactionListener: ((payload: { transaction: Transaction }) => void) | null = null;
let searchRefreshTimer: number | null = null;
let pendingActiveMatchPosition: number | null = null;
let focusRequestId = 0;
const SCROLL_CHANGE_EPSILON = 1;
const isOverlayInDom = () =>
  Boolean(searchOverlayElement && document.body.contains(searchOverlayElement));

function flowsSoftBreaks(parent: ProseMirrorNode | null): boolean {
  return parent?.type.name === 'paragraph' || parent?.type.name === 'heading';
}

function foldSearchText(text: string): string {
  return text.toLowerCase().replace(/\u03c2/g, '\u03c3');
}

const COLLAPSIBLE_PROSE_WHITESPACE_RUN = /[\t\n\f\r ]+/g;

type FoldCheckpoint = {
  foldedFrom: number;
  foldedTo: number;
  sourceFrom: number;
  sourceTo: number;
  deltaAfter: number;
};

type SearchSourceSegment = {
  sourceFrom: number;
  documentFrom: number;
};

type SearchMatch = { from: number; to: number };

export type SearchMatchBatch = {
  matches: SearchMatch[];
  hasMore: boolean;
  offset: number;
};

type SearchNavigationState = {
  currentIndex: number;
  currentOffset: number;
  currentBatchLength: number;
  currentBatchHasMore: boolean;
};

export type SearchNavigationTarget =
  | { kind: 'current'; index: number }
  | { kind: 'batch'; offset: number; index: number }
  | { kind: 'last' };

function foldVisibleSearchRun(
  sourceText: string,
  collapseWhitespace: boolean
): { foldedText: string; checkpoints: FoldCheckpoint[] } {
  const visibleText = collapseWhitespace
    ? sourceText.replace(COLLAPSIBLE_PROSE_WHITESPACE_RUN, ' ')
    : sourceText;
  const foldedText = foldSearchText(visibleText);
  const hasCollapsedRun = collapseWhitespace && /[\t\n\f\r ]{2,}/.test(sourceText);
  const hasExpandingFold = sourceText.includes('\u0130');
  if (!hasCollapsedRun && !hasExpandingFold) {
    return { foldedText, checkpoints: [] };
  }

  let cumulativeDelta = 0;
  const checkpoints: FoldCheckpoint[] = [];
  const collapsedRunPattern = /[\t\n\f\r ]{2,}/g;
  let collapsedRun = hasCollapsedRun ? collapsedRunPattern.exec(sourceText) : null;
  let expandingFoldOffset = hasExpandingFold ? sourceText.indexOf('\u0130') : -1;

  while (collapsedRun || expandingFoldOffset >= 0) {
    const collapsedRunOffset = collapsedRun?.index ?? Number.POSITIVE_INFINITY;
    if (collapsedRunOffset < expandingFoldOffset || expandingFoldOffset < 0) {
      const sourceLength = collapsedRun?.[0].length ?? 0;
      const foldedFrom = collapsedRunOffset + cumulativeDelta;
      cumulativeDelta += 1 - sourceLength;
      checkpoints.push({
        foldedFrom,
        foldedTo: foldedFrom + 1,
        sourceFrom: collapsedRunOffset,
        sourceTo: collapsedRunOffset + sourceLength,
        deltaAfter: cumulativeDelta,
      });
      collapsedRun = collapsedRunPattern.exec(sourceText);
      continue;
    }

    const foldedFrom = expandingFoldOffset + cumulativeDelta;
    cumulativeDelta += 1;
    checkpoints.push({
      foldedFrom,
      foldedTo: foldedFrom + 2,
      sourceFrom: expandingFoldOffset,
      sourceTo: expandingFoldOffset + 1,
      deltaAfter: cumulativeDelta,
    });
    expandingFoldOffset = sourceText.indexOf('\u0130', expandingFoldOffset + 1);
  }

  return { foldedText, checkpoints };
}

function mapFoldedOffset(
  checkpoints: FoldCheckpoint[],
  foldedOffset: number,
  useEnd: boolean
): number {
  if (checkpoints.length === 0) {
    return foldedOffset + (useEnd ? 1 : 0);
  }

  let low = 0;
  let high = checkpoints.length - 1;
  let precedingCheckpoint: FoldCheckpoint | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const checkpoint = checkpoints[middle];
    if (checkpoint.foldedFrom <= foldedOffset) {
      precedingCheckpoint = checkpoint;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (
    precedingCheckpoint &&
    foldedOffset >= precedingCheckpoint.foldedFrom &&
    foldedOffset < precedingCheckpoint.foldedTo
  ) {
    return useEnd ? precedingCheckpoint.sourceTo : precedingCheckpoint.sourceFrom;
  }

  const delta = precedingCheckpoint?.deltaAfter ?? 0;
  return foldedOffset - delta + (useEnd ? 1 : 0);
}

function mapSourceOffset(segments: SearchSourceSegment[], sourceOffset: number): number {
  let low = 0;
  let high = segments.length - 1;
  let segment = segments[0];

  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].sourceFrom <= sourceOffset) {
      segment = segments[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return segment.documentFrom + sourceOffset - segment.sourceFrom;
}

function getVisibleTextBetween(doc: ProseMirrorNode, from: number, to: number): string | null {
  let text = '';
  let previousTextEnd: number | null = null;
  let collapseWhitespace: boolean | null = null;
  let crossesSearchRun = false;

  doc.descendants((node, position, parent) => {
    if (!node.isText || !node.text) return true;

    const selectedFrom = Math.max(from, position);
    const selectedTo = Math.min(to, position + node.text.length);
    if (selectedFrom >= selectedTo) return true;

    if (previousTextEnd !== null && selectedFrom > previousTextEnd) {
      crossesSearchRun = true;
    }

    const flowsWhitespace = flowsSoftBreaks(parent);
    if (collapseWhitespace !== null && collapseWhitespace !== flowsWhitespace) {
      crossesSearchRun = true;
    }
    collapseWhitespace = flowsWhitespace;

    const selectedText = node.text.slice(selectedFrom - position, selectedTo - position);
    if (!flowsWhitespace && selectedText.includes('\n')) {
      crossesSearchRun = true;
    }
    text += selectedText;
    previousTextEnd = selectedTo;
    return true;
  });

  if (crossesSearchRun) return null;
  return collapseWhitespace ? text.replace(COLLAPSIBLE_PROSE_WHITESPACE_RUN, ' ') : text;
}

function getWindowScrollPosition(): { x: number; y: number } {
  return {
    x: typeof window.scrollX === 'number' ? window.scrollX : window.pageXOffset || 0,
    y: typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset || 0,
  };
}

function hasScrolledSinceSearchOpened(): boolean {
  if (!savedScrollPosition) {
    return false;
  }

  const currentScrollPosition = getWindowScrollPosition();
  return (
    Math.abs(currentScrollPosition.x - savedScrollPosition.x) > SCROLL_CHANGE_EPSILON ||
    Math.abs(currentScrollPosition.y - savedScrollPosition.y) > SCROLL_CHANGE_EPSILON
  );
}

function focusEditor(editor: Editor, preventScroll: boolean) {
  if (preventScroll) {
    editor.commands.focus(undefined, { scrollIntoView: false });
    return;
  }

  editor.commands.focus();
}

/**
 * Create the search plugin for decorations
 */
function createSearchPlugin(): Plugin {
  return new Plugin({
    key: searchPluginKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldState) {
        // Check for search meta update
        const searchMeta = tr.getMeta(searchPluginKey);
        if (searchMeta !== undefined) {
          return searchMeta;
        }
        // Map decorations through document changes
        return oldState.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

function visitSearchMatches(
  editor: Editor,
  query: string,
  visitor: (match: SearchMatch, index: number) => boolean
): number {
  if (!query || query.length === 0) {
    return 0;
  }

  let matchCount = 0;
  let stopped = false;
  const doc = editor.state.doc;
  const foldedQuery = foldSearchText(query);
  let runSourceText = '';
  let runSourceSegments: SearchSourceSegment[] = [];
  let runCollapsesWhitespace = false;
  let expectedNextPosition: number | null = null;

  const flushRun = () => {
    const { foldedText, checkpoints } = foldVisibleSearchRun(runSourceText, runCollapsesWhitespace);
    if (foldedText.length < foldedQuery.length) {
      runSourceText = '';
      runSourceSegments = [];
      runCollapsesWhitespace = false;
      expectedNextPosition = null;
      return false;
    }

    let index = 0;
    while ((index = foldedText.indexOf(foldedQuery, index)) !== -1) {
      const finalIndex = index + foldedQuery.length - 1;
      const sourceFrom = mapFoldedOffset(checkpoints, index, false);
      const sourceTo = mapFoldedOffset(checkpoints, finalIndex, true);
      const match = {
        from: mapSourceOffset(runSourceSegments, sourceFrom),
        to: mapSourceOffset(runSourceSegments, sourceTo),
      };
      const shouldContinue = visitor(match, matchCount);
      matchCount += 1;
      if (!shouldContinue) {
        stopped = true;
        break;
      }
      index += 1;
    }

    runSourceText = '';
    runSourceSegments = [];
    runCollapsesWhitespace = false;
    expectedNextPosition = null;
    return stopped;
  };

  doc.descendants((node, pos, parent) => {
    if (stopped) return false;
    if (!node.isText || !node.text) {
      flushRun();
      return true;
    }

    const collapseWhitespace = flowsSoftBreaks(parent);
    if (
      expectedNextPosition !== null &&
      (pos !== expectedNextPosition || collapseWhitespace !== runCollapsesWhitespace)
    ) {
      flushRun();
      if (stopped) return false;
    }

    const text = node.text;
    if (runSourceText.length === 0) {
      runCollapsesWhitespace = collapseWhitespace;
    }
    runSourceSegments.push({
      sourceFrom: runSourceText.length,
      documentFrom: pos,
    });
    runSourceText += text;
    expectedNextPosition = pos + text.length;
    return true;
  });
  if (!stopped) {
    flushRun();
  }

  return matchCount;
}

/**
 * Find a bounded match batch beginning after a known number of matches.
 */
export function findMatchBatch(
  editor: Editor,
  query: string,
  skipMatches = 0,
  keepLastBatch = false
): SearchMatchBatch {
  let matches: SearchMatch[] = [];
  let totalMatches = 0;
  let hasMore = false;

  visitSearchMatches(editor, query, (match, index) => {
    totalMatches = index + 1;
    if (keepLastBatch) {
      if (matches.length < MAX_SEARCH_MATCHES) {
        matches.push(match);
      } else {
        matches[index % MAX_SEARCH_MATCHES] = match;
      }
      return true;
    }
    if (index < skipMatches) {
      return true;
    }
    if (matches.length >= MAX_SEARCH_MATCHES) {
      hasMore = true;
      return false;
    }
    matches.push(match);
    return true;
  });

  if (keepLastBatch && totalMatches > MAX_SEARCH_MATCHES) {
    const firstMatchIndex = totalMatches % MAX_SEARCH_MATCHES;
    matches = [...matches.slice(firstMatchIndex), ...matches.slice(0, firstMatchIndex)];
  }

  return {
    matches,
    hasMore: keepLastBatch ? false : hasMore,
    offset: keepLastBatch ? Math.max(0, totalMatches - matches.length) : skipMatches,
  };
}

function findMatchBatchNearPosition(
  editor: Editor,
  query: string,
  targetPosition: number
): { batch: SearchMatchBatch; activeIndex: number } {
  let nearestMatchIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;

  visitSearchMatches(editor, query, (match, index) => {
    const distance =
      targetPosition < match.from
        ? match.from - targetPosition
        : targetPosition > match.to
          ? targetPosition - match.to
          : 0;
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearestMatchIndex = index;
    }

    return match.from <= targetPosition || distance < nearestDistance;
  });

  if (nearestMatchIndex < 0) {
    return {
      batch: { matches: [], hasMore: false, offset: 0 },
      activeIndex: -1,
    };
  }

  const offset = Math.floor(nearestMatchIndex / MAX_SEARCH_MATCHES) * MAX_SEARCH_MATCHES;
  return {
    batch: findMatchBatch(editor, query, offset),
    activeIndex: nearestMatchIndex - offset,
  };
}

function findLastMatchBatch(editor: Editor, query: string): SearchMatchBatch {
  return findMatchBatch(editor, query, 0, true);
}

/**
 * Resolve next-match navigation without scanning or mutating editor state.
 */
export function resolveNextSearchNavigation(state: SearchNavigationState): SearchNavigationTarget {
  const { currentIndex, currentOffset, currentBatchLength, currentBatchHasMore } = state;

  if (currentIndex === currentBatchLength - 1 && currentBatchHasMore) {
    return {
      kind: 'batch',
      offset: currentOffset + currentBatchLength,
      index: 0,
    };
  }
  if (currentIndex === currentBatchLength - 1 && currentOffset > 0) {
    return { kind: 'batch', offset: 0, index: 0 };
  }
  return {
    kind: 'current',
    index: (currentIndex + 1) % currentBatchLength,
  };
}

/**
 * Resolve previous-match navigation across arbitrary bounded batch offsets.
 */
export function resolvePreviousSearchNavigation(
  state: SearchNavigationState
): SearchNavigationTarget {
  const { currentIndex, currentOffset, currentBatchLength, currentBatchHasMore } = state;

  if (currentIndex === 0 && currentOffset > 0) {
    const previousGlobalIndex = currentOffset - 1;
    const previousBatchOffset = Math.max(0, currentOffset - MAX_SEARCH_MATCHES);
    return {
      kind: 'batch',
      offset: previousBatchOffset,
      index: previousGlobalIndex - previousBatchOffset,
    };
  }
  if (currentIndex === 0 && currentBatchHasMore) {
    return { kind: 'last' };
  }
  return {
    kind: 'current',
    index: (currentIndex - 1 + currentBatchLength) % currentBatchLength,
  };
}

/**
 * Find the first bounded batch of matches in the document.
 */
export function findMatches(editor: Editor, query: string): Array<{ from: number; to: number }> {
  return findMatchBatch(editor, query).matches;
}

/**
 * Apply search highlighting decorations
 */
function applySearchDecorations(
  editor: Editor,
  matches: Array<{ from: number; to: number }>,
  activeIndex: number
) {
  try {
    const decorations: Decoration[] = [];

    matches.forEach((match, index) => {
      const isActive = index === activeIndex;
      decorations.push(
        Decoration.inline(match.from, match.to, {
          class: isActive ? 'search-match search-match-active' : 'search-match',
        })
      );
    });

    const decorationSet =
      decorations.length > 0
        ? DecorationSet.create(editor.state.doc, decorations)
        : DecorationSet.empty;

    // Dispatch transaction with search decorations
    const tr = editor.state.tr.setMeta(searchPluginKey, decorationSet);
    editor.view.dispatch(tr);
  } catch (error) {
    console.warn('[MD4H] Skipping search decorations:', error);
  }
}

/**
 * Clear search decorations
 */
function clearSearchDecorations(editor: Editor) {
  try {
    const tr = editor.state.tr.setMeta(searchPluginKey, DecorationSet.empty);
    editor.view.dispatch(tr);
  } catch {
    // Safe no-op in tests or when PM state isn't available
  }
}

function clearScheduledSearchRefresh() {
  if (searchRefreshTimer !== null) {
    window.clearTimeout(searchRefreshTimer);
    searchRefreshTimer = null;
  }
  pendingActiveMatchPosition = null;
}

function resetSearchMatches() {
  currentQuery = '';
  currentMatches = [];
  currentMatchIndex = -1;
  currentMatchOffset = 0;
  currentBatchHasMore = false;
}

function loadSearchBatch(editor: Editor, offset: number) {
  const batch = findMatchBatch(editor, currentQuery, offset);
  currentMatches = batch.matches;
  currentMatchOffset = batch.offset;
  currentBatchHasMore = batch.hasMore;
}

function loadLastSearchBatch(editor: Editor) {
  const batch = findLastMatchBatch(editor, currentQuery);
  currentMatches = batch.matches;
  currentMatchOffset = batch.offset;
  currentBatchHasMore = false;
}

function refreshSearchAfterDocumentChange(editor: Editor, mappedActivePosition: number | null) {
  if (!isVisible || currentQuery.length === 0 || searchOverlayEditor !== editor) return;

  if (mappedActivePosition === null) {
    loadSearchBatch(editor, currentMatchOffset);
    if (currentMatches.length === 0 && currentMatchOffset > 0) {
      loadSearchBatch(editor, 0);
    }
    currentMatchIndex = 0;
  } else {
    const anchoredMatch = findMatchBatchNearPosition(editor, currentQuery, mappedActivePosition);
    currentMatches = anchoredMatch.batch.matches;
    currentMatchOffset = anchoredMatch.batch.offset;
    currentBatchHasMore = anchoredMatch.batch.hasMore;
    currentMatchIndex = anchoredMatch.activeIndex;
  }

  if (currentMatches.length === 0) {
    currentMatchIndex = -1;
  }

  applySearchDecorations(editor, currentMatches, currentMatchIndex);
  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement | null;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }
}

function scheduleSearchRefresh(editor: Editor, transaction: Transaction) {
  if (!isVisible || currentQuery.length === 0 || !transaction.docChanged) return;

  const activeMatch = currentMatches[currentMatchIndex];
  const activePosition =
    searchRefreshTimer === null ? (activeMatch?.from ?? null) : pendingActiveMatchPosition;
  pendingActiveMatchPosition =
    activePosition === null ? null : transaction.mapping.map(activePosition, 1);

  if (searchRefreshTimer !== null) {
    window.clearTimeout(searchRefreshTimer);
  }
  searchRefreshTimer = window.setTimeout(() => {
    const mappedActivePosition = pendingActiveMatchPosition;
    searchRefreshTimer = null;
    pendingActiveMatchPosition = null;
    refreshSearchAfterDocumentChange(editor, mappedActivePosition);
  }, SEARCH_REFRESH_DELAY_MS);
}

/**
 * Ensure search plugin is registered
 */
function ensureSearchPlugin(editor: Editor) {
  // Check if plugin already exists
  const existingPlugin = editor.state.plugins.find(p => p.spec.key === searchPluginKey);
  if (!existingPlugin) {
    searchPlugin = createSearchPlugin();
    editor.registerPlugin(searchPlugin);
  }

  if (transactionListenerEditor !== editor) {
    if (transactionListenerEditor && transactionListener) {
      transactionListenerEditor.off('transaction', transactionListener);
    }
    clearScheduledSearchRefresh();
    transactionListener = payload => scheduleSearchRefresh(editor, payload.transaction);
    editor.on('transaction', transactionListener);
    transactionListenerEditor = editor;
  }
}

/**
 * Scroll to a match position
 */
function scrollToMatch(editor: Editor, match: { from: number; to: number }) {
  const shouldRefocusInput = isVisible;

  // Set selection to the match
  editor.commands.setTextSelection({ from: match.from, to: match.to });

  // Ensure the position is scrolled into view (ProseMirror + DOM fallback)
  try {
    editor.view.dispatch(editor.state.tr.scrollIntoView());
  } catch {
    // ignore
  }

  // Scroll match into view - try element.scrollIntoView first, fallback to window.scrollTo
  const coords = editor.view.coordsAtPos(match.from);
  if (coords) {
    const domAtPos = editor.view.domAtPos(match.from);
    const node = domAtPos?.node as Node | null;
    const element =
      (node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null)) ||
      null;

    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // Fallback when scrollIntoView is unavailable
      const y = coords.top + window.scrollY - window.innerHeight * 0.3;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  }

  // Return focus to the search input when the overlay is visible
  if (shouldRefocusInput) {
    focusSearchInput(false);
  }
}

/**
 * Update match counter display
 */
function updateMatchCounter(searchInput: HTMLInputElement) {
  const counter = searchOverlayElement?.querySelector('.search-overlay-counter') as HTMLElement;
  if (!counter) return;

  if (currentMatches.length === 0 && currentQuery.length > 0) {
    counter.textContent = 'No results';
    counter.classList.add('no-results');
    searchInput.classList.add('no-results');
  } else if (currentMatches.length > 0) {
    const ordinal = currentMatchOffset + currentMatchIndex + 1;
    const knownMatchCount = currentMatchOffset + currentMatches.length;
    counter.textContent = `${ordinal} of ${knownMatchCount}${currentBatchHasMore ? '+' : ''}`;
    counter.classList.remove('no-results');
    searchInput.classList.remove('no-results');
  } else {
    counter.textContent = '';
    counter.classList.remove('no-results');
    searchInput.classList.remove('no-results');
  }
}

/**
 * Perform search and update UI
 */
function performSearch(editor: Editor, query: string) {
  clearScheduledSearchRefresh();
  currentQuery = query;
  loadSearchBatch(editor, 0);
  currentMatchIndex = currentMatches.length > 0 ? 0 : -1;

  applySearchDecorations(editor, currentMatches, currentMatchIndex);

  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }

  // Scroll to first match
  if (currentMatches.length > 0 && currentMatchIndex >= 0) {
    scrollToMatch(editor, currentMatches[currentMatchIndex]);
  }
}

/**
 * Navigate to next match
 */
function goToNextMatch(editor: Editor) {
  if (currentMatches.length === 0) return;

  const target = resolveNextSearchNavigation({
    currentIndex: currentMatchIndex,
    currentOffset: currentMatchOffset,
    currentBatchLength: currentMatches.length,
    currentBatchHasMore,
  });
  if (target.kind === 'batch') {
    loadSearchBatch(editor, target.offset);
  }
  currentMatchIndex = target.kind === 'last' ? currentMatches.length - 1 : target.index;
  if (currentMatchIndex < 0) return;
  applySearchDecorations(editor, currentMatches, currentMatchIndex);
  scrollToMatch(editor, currentMatches[currentMatchIndex]);

  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }
}

/**
 * Navigate to previous match
 */
function goToPreviousMatch(editor: Editor) {
  if (currentMatches.length === 0) return;

  const target = resolvePreviousSearchNavigation({
    currentIndex: currentMatchIndex,
    currentOffset: currentMatchOffset,
    currentBatchLength: currentMatches.length,
    currentBatchHasMore,
  });
  if (target.kind === 'batch') {
    loadSearchBatch(editor, target.offset);
  } else if (target.kind === 'last') {
    loadLastSearchBatch(editor);
  }
  currentMatchIndex = target.kind === 'last' ? currentMatches.length - 1 : target.index;
  applySearchDecorations(editor, currentMatches, currentMatchIndex);
  scrollToMatch(editor, currentMatches[currentMatchIndex]);

  const searchInput = searchOverlayElement?.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    updateMatchCounter(searchInput);
  }
}

/**
 * Create the search overlay element
 */
export function createSearchOverlay(editor: Editor): HTMLElement {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Find in document');
  overlay.setAttribute('aria-modal', 'false');

  // Create panel (positioned at top)
  const panel = document.createElement('div');
  panel.className = 'search-overlay-panel';

  // Create input wrapper
  const inputWrapper = document.createElement('div');
  inputWrapper.className = 'search-overlay-input-wrapper';

  // Search icon
  const searchIcon = document.createElement('span');
  searchIcon.className = 'search-overlay-icon codicon codicon-search';
  searchIcon.setAttribute('aria-hidden', 'true');

  // Search input
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'search-overlay-input';
  searchInput.placeholder = 'Find in document...';
  searchInput.setAttribute('aria-label', 'Search query');
  searchInput.spellcheck = false;

  // Match counter
  const counter = document.createElement('span');
  counter.className = 'search-overlay-counter';
  counter.setAttribute('aria-live', 'polite');

  inputWrapper.appendChild(searchIcon);
  inputWrapper.appendChild(searchInput);
  inputWrapper.appendChild(counter);

  // Create button wrapper
  const buttonWrapper = document.createElement('div');
  buttonWrapper.className = 'search-overlay-buttons';

  // Previous button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'search-overlay-btn';
  prevBtn.innerHTML = '<span class="codicon codicon-arrow-up"></span>';
  prevBtn.title = 'Previous match (Shift+Enter)';
  prevBtn.setAttribute('aria-label', 'Previous match');
  prevBtn.onclick = e => {
    e.preventDefault();
    goToPreviousMatch(editor);
    searchInput.focus();
  };

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'search-overlay-btn';
  nextBtn.innerHTML = '<span class="codicon codicon-arrow-down"></span>';
  nextBtn.title = 'Next match (Enter)';
  nextBtn.setAttribute('aria-label', 'Next match');
  nextBtn.onclick = e => {
    e.preventDefault();
    goToNextMatch(editor);
    searchInput.focus();
  };

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-overlay-btn search-overlay-close';
  closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
  closeBtn.title = 'Close (Escape)';
  closeBtn.setAttribute('aria-label', 'Close search');
  closeBtn.onclick = () => hideSearchOverlay(editor);

  buttonWrapper.appendChild(prevBtn);
  buttonWrapper.appendChild(nextBtn);
  buttonWrapper.appendChild(closeBtn);

  panel.appendChild(inputWrapper);
  panel.appendChild(buttonWrapper);
  overlay.appendChild(panel);

  // Handle input changes
  searchInput.addEventListener('input', () => {
    performSearch(editor, searchInput.value);
  });

  // Handle keyboard navigation
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;

    // Allow Cmd/Ctrl+A to select all text within the input
    if (isMod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      searchInput.select();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      hideSearchOverlay(editor);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPreviousMatch(editor);
      } else {
        goToNextMatch(editor);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      goToNextMatch(editor);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      goToPreviousMatch(editor);
    }
  });

  // Prevent keydown events from propagating to editor, but allow standard text shortcuts in the input
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    // Let the input handle its own shortcuts (Cmd/Ctrl+A etc.)
    if (document.activeElement === searchInput) {
      return;
    }
    // Allow Tab for accessibility
    if (e.key !== 'Tab') {
      e.stopPropagation();
    }
  });

  document.body.appendChild(overlay);
  searchOverlayElement = overlay;
  searchOverlayEditor = editor;

  return overlay;
}

function focusSearchInput(selectText = true) {
  const requestId = ++focusRequestId;
  let attempts = 0;
  let initialValue: string | null = null;
  const maxAttempts = 6;

  const scheduleNextAttempt = () => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(applyFocus);
    } else {
      window.setTimeout(applyFocus, 16);
    }
  };

  const applyFocus = () => {
    if (!isVisible || !isOverlayInDom()) return;
    if (requestId !== focusRequestId) return;

    const searchInput = searchOverlayElement?.querySelector(
      '.search-overlay-input'
    ) as HTMLInputElement | null;
    if (!searchInput) return;
    if (initialValue === null) {
      initialValue = searchInput.value;
    }

    if (document.activeElement !== searchInput) {
      searchInput.focus({ preventScroll: true });
    }
    if (
      selectText &&
      searchInput.value === initialValue &&
      document.activeElement === searchInput
    ) {
      searchInput.select();
    }

    attempts += 1;
    if (document.activeElement !== searchInput && attempts < maxAttempts) {
      scheduleNextAttempt();
    }
  };

  applyFocus();
  // TipTap and Chromium can both settle focus after the keyboard event that opens find.
  // Verify on the next frame even when immediate focus initially succeeds.
  scheduleNextAttempt();
}

/**
 * Show the search overlay
 */
export function showSearchOverlay(editor: Editor): void {
  if (searchOverlayEditor && searchOverlayEditor !== editor) {
    clearScheduledSearchRefresh();
    clearSearchDecorations(searchOverlayEditor);
    searchOverlayElement?.remove();
    searchOverlayElement = null;
    searchOverlayEditor = null;
    isVisible = false;
    resetSearchMatches();
    savedSelection = null;
    savedScrollPosition = null;
  }

  // Ensure search plugin is registered
  ensureSearchPlugin(editor);
  const wasVisible = isVisible && isOverlayInDom();

  if (!isOverlayInDom()) {
    searchOverlayElement = null;
    createSearchOverlay(editor);
  }

  if (!searchOverlayElement) return;

  // Save current selection
  const { from, to } = editor.state.selection;
  savedSelection = { from, to };
  savedScrollPosition = getWindowScrollPosition();

  // Get selected text as initial query
  const selectedText = getVisibleTextBetween(editor.state.doc, from, to);

  // Show overlay
  searchOverlayElement.classList.add('visible');
  isVisible = true;

  if (wasVisible) {
    focusSearchInput();
    return;
  }

  // Focus input and set selected text
  const searchInput = searchOverlayElement.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    if (selectedText && selectedText.length > 0 && selectedText.length < 100) {
      searchInput.value = selectedText;
      performSearch(editor, selectedText);
    }
  }

  // Always focus the input when opening (even if already visible)
  focusSearchInput();
}

/**
 * Hide the search overlay
 */
export function hideSearchOverlay(editor: Editor, restorePosition = true): void {
  if (!searchOverlayElement) return;

  const activeEditor = searchOverlayEditor ?? editor;
  const hadActiveMatch = currentMatches.length > 0 && currentMatchIndex >= 0;
  const shouldPreventFocusScroll = restorePosition && hasScrolledSinceSearchOpened();

  searchOverlayElement.classList.remove('visible');
  isVisible = false;

  // Clear search state
  clearScheduledSearchRefresh();
  resetSearchMatches();

  // Clear decorations
  clearSearchDecorations(activeEditor);

  // Clear input
  const searchInput = searchOverlayElement.querySelector(
    '.search-overlay-input'
  ) as HTMLInputElement;
  if (searchInput) {
    searchInput.value = '';
  }

  // Clear counter
  const counter = searchOverlayElement.querySelector('.search-overlay-counter') as HTMLElement;
  if (counter) {
    counter.textContent = '';
    counter.classList.remove('no-results');
  }
  if (searchInput) {
    searchInput.classList.remove('no-results');
  }

  // Restore previous position only when search did not navigate to a match.
  // When a match is active, leaving the match selected avoids snapping scroll
  // back to the stale cursor location from before find opened.
  if (restorePosition && !hadActiveMatch && !shouldPreventFocusScroll && savedSelection) {
    try {
      activeEditor.commands.setTextSelection(savedSelection);
    } catch {
      // Ignore errors restoring position
    }
  }

  focusEditor(activeEditor, shouldPreventFocusScroll);
  savedSelection = null;
  savedScrollPosition = null;
}

/**
 * Release overlay state owned by an editor before its TipTap view is destroyed.
 */
export function disposeSearchOverlay(editor: Editor): void {
  clearScheduledSearchRefresh();
  focusRequestId += 1;

  if (transactionListenerEditor === editor && transactionListener) {
    transactionListenerEditor.off('transaction', transactionListener);
    transactionListenerEditor = null;
    transactionListener = null;
  }

  if (searchOverlayEditor !== editor) return;

  clearSearchDecorations(editor);
  searchOverlayElement?.remove();
  searchOverlayElement = null;
  searchOverlayEditor = null;
  isVisible = false;
  resetSearchMatches();
  savedSelection = null;
  savedScrollPosition = null;
}

/**
 * Toggle the search overlay
 */
export function toggleSearchOverlay(editor: Editor): void {
  if (isVisible) {
    hideSearchOverlay(editor);
  } else {
    showSearchOverlay(editor);
  }
}

/**
 * Check if search overlay is visible
 */
export function isSearchVisible(): boolean {
  return isVisible;
}

/**
 * Get current search matches (for testing)
 */
export function getCurrentMatches(): Array<{ from: number; to: number }> {
  return currentMatches;
}

/**
 * Get current match index (for testing)
 */
export function getCurrentMatchIndex(): number {
  return currentMatchIndex;
}
