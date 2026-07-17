/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension, isNodeActive } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const softBreakPluginKey = new PluginKey('softBreakRendering');

type FlowingTextBlock = {
  node: ProseMirrorNode;
  position: number;
};

function isFlowingTextBlock(node: ProseMirrorNode): boolean {
  return node.type.name === 'paragraph' || node.type.name === 'heading';
}

function hasCollapsibleProseWhitespace(node: ProseMirrorNode): boolean {
  let found = false;
  let previousTextEndsWithSpace = false;
  node.forEach(child => {
    if (!child.isText || !child.text) {
      previousTextEndsWithSpace = false;
      return;
    }

    found ||= /[\t\n\f\r]| {2,}/.test(child.text);
    found ||= previousTextEndsWithSpace && child.text.startsWith(' ');
    previousTextEndsWithSpace = child.text.endsWith(' ');
  });
  return found;
}

function hasSourceSoftBreak(node: ProseMirrorNode): boolean {
  let found = false;
  node.forEach(child => {
    found ||= Boolean(child.isText && child.text?.includes('\n'));
  });
  return found;
}

function buildBlockDecorations(node: ProseMirrorNode, position: number): Decoration[] {
  if (!hasCollapsibleProseWhitespace(node)) return [];

  const attributes: Record<string, string> = {
    class: 'markdown-commonmark-whitespace-block',
    'data-commonmark-whitespace': 'true',
  };
  if (hasSourceSoftBreak(node)) {
    attributes['data-soft-breaks'] = 'true';
  }

  return [Decoration.node(position, position + node.nodeSize, attributes)];
}

function buildSoftBreakDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, position) => {
    if (!isFlowingTextBlock(node)) return true;
    decorations.push(...buildBlockDecorations(node, position));
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

function collectChangedRanges(transaction: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];

  transaction.mapping.maps.forEach((stepMap, mapIndex) => {
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const remainingMapping = transaction.mapping.slice(mapIndex + 1);
      const from = remainingMapping.map(newStart, -1);
      const to = remainingMapping.map(newEnd, 1);
      ranges.push({
        from: Math.min(from, to),
        to: Math.max(from, to),
      });
    });
  });

  return ranges;
}

function collectAffectedBlocks(
  doc: ProseMirrorNode,
  ranges: Array<{ from: number; to: number }>
): FlowingTextBlock[] {
  const blocks = new Map<number, FlowingTextBlock>();
  const documentEnd = doc.content.size;

  for (const range of ranges) {
    const from = Math.max(0, Math.min(documentEnd, range.from - 1));
    const to = Math.max(from, Math.min(documentEnd, range.to + 1));

    doc.nodesBetween(from, to, (node, position) => {
      if (!isFlowingTextBlock(node)) return true;
      blocks.set(position, { node, position });
      return false;
    });
  }

  return [...blocks.values()];
}

function updateSoftBreakDecorations(
  transaction: Transaction,
  decorations: DecorationSet
): DecorationSet {
  const mappedDecorations = decorations.map(transaction.mapping, transaction.doc);
  if (!transaction.docChanged) {
    return mappedDecorations;
  }

  const changedRanges = collectChangedRanges(transaction);
  const documentEnd = transaction.doc.content.size;
  const affectedBlocks = collectAffectedBlocks(transaction.doc, changedRanges);
  const staleDecorations = new Set<Decoration>();

  affectedBlocks.forEach(block => {
    const blockEnd = block.position + block.node.nodeSize;
    mappedDecorations
      .find(block.position, blockEnd)
      .filter(decoration => decoration.from === block.position && decoration.to === blockEnd)
      .forEach(decoration => staleDecorations.add(decoration));
  });

  changedRanges.forEach(range => {
    const from = Math.max(0, Math.min(documentEnd, range.from));
    const to = Math.max(from, Math.min(documentEnd, range.to));
    const searchFrom = from === to ? Math.max(0, from - 1) : from;
    const searchTo = from === to ? Math.min(documentEnd, to + 1) : to;
    mappedDecorations
      .find(searchFrom, searchTo)
      .filter(decoration =>
        from === to
          ? decoration.from < from && decoration.to > from
          : decoration.from < to && decoration.to > from
      )
      .forEach(decoration => staleDecorations.add(decoration));
  });

  const freshDecorations = affectedBlocks.flatMap(block =>
    buildBlockDecorations(block.node, block.position)
  );

  return mappedDecorations.remove([...staleDecorations]).add(transaction.doc, freshDecorations);
}

type TextReplacement = {
  from: number;
  to: number;
  marks: ProseMirrorNode['marks'];
  text: '' | ' ' | '\n';
};

type NodeReplacement = {
  from: number;
  to: number;
  nodes: ProseMirrorNode[];
};

function normalizeInlineBreakChildren(
  node: ProseMirrorNode,
  schema: Schema
): ProseMirrorNode[] | null {
  const normalizedChildren: ProseMirrorNode[] = [];
  let changed = false;

  node.forEach(child => {
    if (child.type.name === 'hardBreak') {
      normalizedChildren.push(schema.text(' ', child.marks));
      changed = true;
      return;
    }

    if (child.isText && child.text?.includes('\n')) {
      normalizedChildren.push(schema.text(child.text.replace(/\n/g, ' '), child.marks));
      changed = true;
      return;
    }

    normalizedChildren.push(child);
  });

  return changed ? normalizedChildren : null;
}

function collectHeadingSoftBreakReplacements(state: EditorState): NodeReplacement[] {
  const replacements: NodeReplacement[] = [];
  const documentEnd = state.doc.content.size;
  const from = Math.max(0, Math.min(documentEnd, state.selection.from - 1));
  const to = Math.max(from, Math.min(documentEnd, state.selection.to + 1));

  state.doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'heading') return true;

    const normalizedChildren = normalizeInlineBreakChildren(node, state.schema);
    if (normalizedChildren) {
      replacements.push({
        from: position + 1,
        to: position + node.nodeSize - 1,
        nodes: normalizedChildren,
      });
    }
    return false;
  });

  return replacements;
}

function collectSelectedTextblockBreakReplacements(state: EditorState): NodeReplacement[] {
  const replacements: NodeReplacement[] = [];
  const documentEnd = state.doc.content.size;
  const from = Math.max(0, Math.min(documentEnd, state.selection.from - 1));
  const to = Math.max(from, Math.min(documentEnd, state.selection.to + 1));

  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return true;

    const normalizedChildren = normalizeInlineBreakChildren(node, state.schema);
    if (normalizedChildren) {
      replacements.push({
        from: position + 1,
        to: position + node.nodeSize - 1,
        nodes: normalizedChildren,
      });
    }
    return false;
  });

  return replacements;
}

function normalizeConvertedParagraph(
  node: ProseMirrorNode,
  schema: Schema
): ProseMirrorNode[] | null {
  const children: ProseMirrorNode[] = [];
  node.forEach(child => children.push(child));
  if (!children.some(child => child.type.name === 'hardBreak')) return null;

  while (children[0]?.type.name === 'hardBreak') {
    children.shift();
  }
  while (children.at(-1)?.type.name === 'hardBreak') {
    children.pop();
  }

  const paragraphContents: ProseMirrorNode[][] = [[]];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type.name !== 'hardBreak') {
      paragraphContents[paragraphContents.length - 1].push(child);
      continue;
    }

    let breakCount = 1;
    while (children[index + breakCount]?.type.name === 'hardBreak') {
      breakCount += 1;
    }

    if (breakCount === 1) {
      paragraphContents[paragraphContents.length - 1].push(schema.text('\n', child.marks));
    } else {
      paragraphContents.push([]);
    }
    index += breakCount - 1;
  }

  return paragraphContents.map(content => node.type.create(node.attrs, content));
}

function mapPositionThroughTransactions(
  position: number,
  transactions: readonly Transaction[],
  assoc = 1
): number {
  return transactions.reduce(
    (mappedPosition, transaction) => transaction.mapping.map(mappedPosition, assoc),
    position
  );
}

function collectMappedSoftBreaks(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState
): TextReplacement[] {
  const replacements: TextReplacement[] = [];
  const seenPositions = new Set<number>();
  let nearbyHardBreakExists = false;
  const newDocumentEnd = newState.doc.content.size;
  const newFrom = Math.max(0, Math.min(newDocumentEnd, newState.selection.from - 2));
  const newTo = Math.max(newFrom, Math.min(newDocumentEnd, newState.selection.to + 2));
  newState.doc.nodesBetween(newFrom, newTo, node => {
    if (!isFlowingTextBlock(node)) return true;
    node.forEach(child => {
      nearbyHardBreakExists ||= child.type.name === 'hardBreak';
    });
    return false;
  });
  if (!nearbyHardBreakExists) return replacements;

  const documentEnd = oldState.doc.content.size;
  const from = Math.max(0, Math.min(documentEnd, oldState.selection.from - 2));
  const to = Math.max(from, Math.min(documentEnd, oldState.selection.to + 2));
  const oldBlocks: FlowingTextBlock[] = [];

  oldState.doc.nodesBetween(from, to, (node, position) => {
    if (!isFlowingTextBlock(node)) return true;
    oldBlocks.push({ node, position });
    return false;
  });

  for (const oldBlock of oldBlocks) {
    const oldBreaks: Array<{
      kind: 'soft' | 'hard';
      marks: ProseMirrorNode['marks'];
      position: number;
    }> = [];
    oldBlock.node.forEach((child, offset) => {
      if (child.type.name === 'hardBreak') {
        oldBreaks.push({
          kind: 'hard',
          marks: child.marks,
          position: oldBlock.position + 1 + offset,
        });
        return;
      }
      if (!child.isText || !child.text) return;
      for (
        let index = child.text.indexOf('\n');
        index >= 0;
        index = child.text.indexOf('\n', index + 1)
      ) {
        oldBreaks.push({
          kind: 'soft',
          marks: child.marks,
          position: oldBlock.position + 1 + offset + index,
        });
      }
    });
    if (!oldBreaks.some(lineBreak => lineBreak.kind === 'soft')) continue;

    const mappedPositions = [
      mapPositionThroughTransactions(oldBlock.position, transactions, -1),
      mapPositionThroughTransactions(oldBlock.position, transactions, 1),
    ];
    const mappedPosition = mappedPositions.find(candidate =>
      isFlowingTextBlock(newState.doc.nodeAt(candidate) ?? newState.doc)
    );
    if (mappedPosition === undefined) continue;

    const newBlock = newState.doc.nodeAt(mappedPosition);
    if (!newBlock) continue;

    const newBreaks: Array<{ kind: 'soft' | 'hard'; position: number }> = [];
    newBlock.forEach((child, offset) => {
      if (child.type.name === 'hardBreak') {
        newBreaks.push({ kind: 'hard', position: mappedPosition + 1 + offset });
        return;
      }
      if (!child.isText || !child.text) return;
      for (
        let index = child.text.indexOf('\n');
        index >= 0;
        index = child.text.indexOf('\n', index + 1)
      ) {
        newBreaks.push({
          kind: 'soft',
          position: mappedPosition + 1 + offset + index,
        });
      }
    });

    const intentionalHardBreakIndexes = new Set<number>();
    if (!oldState.selection.empty) {
      oldBreaks.forEach((oldBreak, index) => {
        if (
          oldBreak.kind !== 'soft' ||
          oldBreak.position < oldState.selection.from ||
          oldBreak.position >= oldState.selection.to
        ) {
          return;
        }
        const mappedPositions = [
          mapPositionThroughTransactions(oldBreak.position, transactions, -1),
          mapPositionThroughTransactions(oldBreak.position, transactions, 1),
        ];
        if (
          newBreaks.some(
            newBreak => newBreak.kind === 'hard' && mappedPositions.includes(newBreak.position)
          )
        ) {
          intentionalHardBreakIndexes.add(index);
        }
      });
    }

    const consumedOldSoftBreakIndexes = new Set(intentionalHardBreakIndexes);
    const consumedNewHardBreakPositions = new Set<number>();
    let extraHardBreakCount =
      newBreaks.filter(lineBreak => lineBreak.kind === 'hard').length -
      oldBreaks.filter(lineBreak => lineBreak.kind === 'hard').length;
    for (let index = 0; index < newBreaks.length - 1 && extraHardBreakCount > 0; index += 1) {
      const firstBreak = newBreaks[index];
      const secondBreak = newBreaks[index + 1];
      if (
        firstBreak.kind === secondBreak.kind ||
        secondBreak.position !== firstBreak.position + 1
      ) {
        continue;
      }

      const softBreak = firstBreak.kind === 'soft' ? firstBreak : secondBreak;
      const hardBreak = firstBreak.kind === 'hard' ? firstBreak : secondBreak;
      if (consumedNewHardBreakPositions.has(hardBreak.position)) continue;

      const oldSoftBreakIndex = oldBreaks.findIndex((oldBreak, oldIndex) => {
        if (oldBreak.kind !== 'soft' || consumedOldSoftBreakIndexes.has(oldIndex)) {
          return false;
        }
        return [
          mapPositionThroughTransactions(oldBreak.position, transactions, -1),
          mapPositionThroughTransactions(oldBreak.position, transactions, 1),
        ].includes(softBreak.position);
      });
      if (oldSoftBreakIndex < 0) continue;

      consumedOldSoftBreakIndexes.add(oldSoftBreakIndex);
      consumedNewHardBreakPositions.add(hardBreak.position);
      seenPositions.add(softBreak.position);
      replacements.push({
        from: softBreak.position,
        to: softBreak.position + 1,
        marks: oldBreaks[oldSoftBreakIndex].marks,
        text: '',
      });
      extraHardBreakCount -= 1;
    }

    let remainingSoftBreaksToRepair =
      oldBreaks.filter(lineBreak => lineBreak.kind === 'soft').length -
      intentionalHardBreakIndexes.size -
      newBreaks.filter(lineBreak => lineBreak.kind === 'soft').length;
    if (remainingSoftBreaksToRepair <= 0) continue;

    const repairedOldBreakIndexes = new Set<number>();
    oldBreaks.forEach((oldBreak, index) => {
      if (
        oldBreak.kind !== 'soft' ||
        consumedOldSoftBreakIndexes.has(index) ||
        remainingSoftBreaksToRepair <= 0
      ) {
        return;
      }
      const exactMappedPositions = [
        mapPositionThroughTransactions(oldBreak.position, transactions, -1),
        mapPositionThroughTransactions(oldBreak.position, transactions, 1),
      ];
      const exactBreak = newBreaks.find(
        candidate => candidate.kind === 'hard' && exactMappedPositions.includes(candidate.position)
      );
      if (!exactBreak || seenPositions.has(exactBreak.position)) return;

      repairedOldBreakIndexes.add(index);
      seenPositions.add(exactBreak.position);
      replacements.push({
        from: exactBreak.position,
        to: exactBreak.position + 1,
        marks: oldBreak.marks,
        text: '\n',
      });
      remainingSoftBreaksToRepair -= 1;
    });

    if (newBlock.nodeSize <= oldBlock.node.nodeSize || remainingSoftBreaksToRepair <= 0) continue;

    oldBreaks.forEach((oldBreak, index) => {
      const newBreak = newBreaks[index];
      if (
        remainingSoftBreaksToRepair <= 0 ||
        oldBreak.kind !== 'soft' ||
        consumedOldSoftBreakIndexes.has(index) ||
        repairedOldBreakIndexes.has(index) ||
        newBreak?.kind !== 'hard' ||
        seenPositions.has(newBreak.position)
      ) {
        return;
      }

      seenPositions.add(newBreak.position);
      replacements.push({
        from: newBreak.position,
        to: newBreak.position + 1,
        marks: oldBreak.marks,
        text: '\n',
      });
      remainingSoftBreaksToRepair -= 1;
    });
  }

  return replacements;
}

function collectEdgeSoftBreaks(state: EditorState): TextReplacement[] {
  const replacements: TextReplacement[] = [];
  const documentEnd = state.doc.content.size;
  const from = Math.max(0, Math.min(documentEnd, state.selection.from - 2));
  const to = Math.max(from, Math.min(documentEnd, state.selection.to + 2));

  state.doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'paragraph') return true;

    const firstChild = node.firstChild;
    if (firstChild?.isText && firstChild.text) {
      const leadingBreaks = firstChild.text.match(/^\n+/)?.[0].length ?? 0;
      if (leadingBreaks > 0) {
        replacements.push({
          from: position + 1,
          to: position + 1 + leadingBreaks,
          marks: firstChild.marks,
          text: '',
        });
      }
    }

    const lastChild = node.lastChild;
    if (lastChild?.isText && lastChild.text) {
      const trailingBreaks = lastChild.text.match(/\n+$/)?.[0].length ?? 0;
      if (trailingBreaks > 0) {
        replacements.push({
          from: position + node.nodeSize - 1 - trailingBreaks,
          to: position + node.nodeSize - 1,
          marks: lastChild.marks,
          text: '',
        });
      }
    }
    return false;
  });

  return replacements;
}

function collectConvertedCodeBlockReplacements(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState
): NodeReplacement[] {
  const replacements: NodeReplacement[] = [];
  const { from, to } = oldState.selection;

  oldState.doc.descendants((node, position) => {
    if (node.type.name !== 'codeBlock') return true;

    const blockEnd = position + node.nodeSize;
    if (blockEnd < from || position > to) return false;

    const mappedPosition = mapPositionThroughTransactions(position, transactions);
    const convertedNode = newState.doc.nodeAt(mappedPosition);
    if (convertedNode?.type.name === 'paragraph') {
      const normalizedParagraphs = normalizeConvertedParagraph(convertedNode, newState.schema);
      if (normalizedParagraphs) {
        replacements.push({
          from: mappedPosition,
          to: mappedPosition + convertedNode.nodeSize,
          nodes: normalizedParagraphs,
        });
      }
    }
    return false;
  });

  return replacements;
}

function normalizeBlockSoftBreaks(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState
): Transaction | null {
  if (!transactions.some(transaction => transaction.docChanged)) return null;
  // ProseMirror history replays the original transaction together with this
  // plugin's appended normalization. Re-normalizing that replay can undo the
  // stored final state, such as converting an upgraded hard break back to soft.
  if (transactions.some(transaction => transaction.getMeta('history$'))) return null;

  const textReplacements = [
    ...collectMappedSoftBreaks(transactions, oldState, newState),
    ...collectEdgeSoftBreaks(newState),
  ];
  const nodeReplacements = [
    ...collectHeadingSoftBreakReplacements(newState),
    ...collectConvertedCodeBlockReplacements(transactions, oldState, newState),
  ];
  if (textReplacements.length === 0 && nodeReplacements.length === 0) return null;

  const transaction = newState.tr;
  const operations = [
    ...textReplacements.map(replacement => ({ kind: 'text' as const, replacement })),
    ...nodeReplacements.map(replacement => ({ kind: 'node' as const, replacement })),
  ].sort((left, right) => right.replacement.from - left.replacement.from);

  for (const operation of operations) {
    if (operation.kind === 'node') {
      transaction.replaceWith(
        operation.replacement.from,
        operation.replacement.to,
        Fragment.fromArray(operation.replacement.nodes)
      );
    } else {
      if (operation.replacement.text === '') {
        transaction.delete(operation.replacement.from, operation.replacement.to);
      } else {
        transaction.replaceWith(
          operation.replacement.from,
          operation.replacement.to,
          newState.schema.text(operation.replacement.text, operation.replacement.marks)
        );
      }
    }
  }
  return transaction;
}

/**
 * Displays CommonMark prose whitespace as ordinary wrapping spaces without
 * changing the text stored in the ProseMirror document. Keeping source
 * newlines, tabs, and repeated spaces intact preserves serialization while
 * retaining native caret, deletion, undo, and mark behavior.
 */
export const SoftBreakRendering = Extension.create({
  name: 'softBreakRendering',

  addCommands() {
    return {
      toggleHeading:
        (attributes: { level: 1 | 2 | 3 | 4 | 5 | 6 }) =>
        ({ state, dispatch }) => {
          const headingType = state.schema.nodes.heading;
          const paragraphType = state.schema.nodes.paragraph;
          if (!headingType || !paragraphType) return false;

          const headingIsActive = isNodeActive(state, headingType, attributes);
          const transaction = state.tr;
          if (!headingIsActive) {
            const replacements = collectSelectedTextblockBreakReplacements(state).sort(
              (left, right) => right.from - left.from
            );
            for (const replacement of replacements) {
              transaction.replaceWith(
                replacement.from,
                replacement.to,
                Fragment.fromArray(replacement.nodes)
              );
            }
          }

          transaction.setBlockType(
            state.selection.from,
            state.selection.to,
            headingIsActive ? paragraphType : headingType,
            headingIsActive ? null : attributes
          );
          if (!transaction.docChanged) return false;
          dispatch?.(transaction);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: softBreakPluginKey,
        appendTransaction: normalizeBlockSoftBreaks,
        state: {
          init: (_, state) => buildSoftBreakDecorations(state.doc),
          apply: updateSoftBreakDecorations,
        },
        props: {
          decorations(state) {
            return softBreakPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
