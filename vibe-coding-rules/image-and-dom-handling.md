# Image & DOM Handling Guidelines

**Purpose:** Consolidated patterns for working with images, Enter/newline behavior, and DOM manipulation in our TipTap/ProseMirror editor.

**Load this guide when:** Working on images, Enter key handling, NodeViews, or Markdown serialization.

**Last updated:** 2025-12-13

---

## TL;DR (Quick Reference)

| Topic | Pattern | Anti-pattern |
|-------|---------|--------------|
| **Images** | `inline: true` with atomic behavior | Block-level images create phantom gaps |
| **Enter handling** | Return `true` to stop propagation | Only `preventDefault()` without `return true` |
| **Empty paragraphs** | Filter at serialization time | Delete during typing (causes cursor jumps) |
| **Type checking** | Duck-typing + `instanceof` fallback | Only `instanceof` (fails in tests) |
| **Content modification** | `replaceWith()` for atomic changes | `delete()` for complex structures |
| **Position calculation** | `$pos.index()` for child indices | `$pos.end(0)` (returns absolute pos, can overflow) |

---

## 1. Image Configuration

### Current Setup (Stable)

```typescript
// src/webview/extensions/customImage.ts
export const CustomImage = Image.extend({
  inline: true,      // Images live inside paragraphs
  atom: true,        // Treated as single unit for selection
  selectable: true,  // Can be selected as NodeSelection
  group: 'inline',   // Belongs to inline content group
});
```

### Why Inline Images?

| Approach | Behavior | Issue |
|----------|----------|-------|
| `inline: false` (default) | Each image is a block node | Creates phantom gaps between consecutive images |
| `inline: true` | Images live inside paragraphs | No gaps, provides clean flow for consecutive images |

**Key insight:** Explicit trailing spaces (`![](img)  \n`) create hardBreaks between consecutive image lines even though ordinary soft-wrapped prose flows as one paragraph. With block-level images, these become editable gaps. With inline images, they remain inside the same paragraph.

### NodeView Structure

```typescript
addNodeView() {
  return ({ node }) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'image-wrapper';
    // ... image element ...
    return { dom: wrapper };
  };
}
```

**CSS requirements:**
```css
.markdown-image {
  margin: 0;              /* No margins on image itself */
  display: block;
}
.image-wrapper {
  display: inline-block;  /* Inline-block needed for proper image rendering behavior */
  margin: 0.25em 0;       /* Spacing between images */
}
```

---

## 2. Enter Key Handling

### Core Rules

1. **Return `true` to stop propagation** - `preventDefault()` alone doesn't stop ProseMirror handlers
2. **Scope handlers narrowly** - Don't break lists/structured blocks
3. **Check handler order** - Your extension must run before baseKeymap

### Correct Pattern

```typescript
addProseMirrorPlugins() {
  return [
    new Plugin({
      props: {
        handleKeyDown: (view, event) => {
          if (event.key !== 'Enter') return false;
          
          // Only handle specific context
          if (!shouldHandleEnter(view.state)) {
            return false;  // Let other handlers run
          }
          
          event.preventDefault();
          event.stopPropagation();
          
          // Do your thing
          performAction(view);
          
          return true;  // ← CRITICAL: stops other handlers
        },
      },
    }),
  ];
}
```

### What NOT to Do

```typescript
// ❌ WRONG: Only preventDefault, no return true
handleKeyDown: (view, event) => {
  event.preventDefault();
  // ... other handlers still run!
}

// ❌ WRONG: Global Enter override
Enter: () => {
  editor.commands.setHardBreak();
  return true;  // Breaks lists!
}
```

---

## 3. Empty Paragraph Handling

### The Problem

Pressing Enter after a heading creates an empty paragraph. When serialized:
```
heading → "\n\n" → empty paragraph → "\n\n" → content
```
Result: Triple blank lines.

### The Solution: Output-Time Policy

**Do NOT delete empty paragraphs during typing** - causes cursor jumps.

**DO apply the configured blank-line policy at serialization:**

```typescript
// src/webview/utils/markdownSerialization.ts
getEditorMarkdownForSync(editor, blankLineMode);
```

Default behavior preserves explicit middle blank paragraphs as extra Markdown
blank lines. The `strip` mode is available for users who want automatic
blank-line cleanup.

**Helper function:**
```typescript
function isMeaningfulInlineNode(node: JSONContent): boolean {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'hardBreak' || node.type === 'hard_break') return false;
  if (node.type === 'text') {
    return (node.text?.trim().length ?? 0) > 0;
  }
  return true;  // Images, links, etc. are meaningful
}
```

---

## 4. Position Calculation

### Safe Patterns

```typescript
// Get position immediately after current block
const insertPos = $from.after($from.depth);

// Get child index (not offset)
const indexInParent = $from.index();

// Calculate position after a specific block
function getPositionAfterBlock(state: EditorState, blockIndex: number): number {
  let pos = 1;  // After doc opening
  for (let i = 0; i <= blockIndex && i < state.doc.childCount; i++) {
    pos += state.doc.child(i).nodeSize;
  }
  return pos;
}
```

### Dangerous Patterns

```typescript
// ❌ WRONG: $pos.end(0) returns absolute position, can be huge
const docPos = $pos.end(0);  // Could be 12691 for large paragraphs!

// ❌ WRONG: Using parentOffset for index-based operations
const offset = $from.parentOffset;  // This is byte offset, not index
```

---

## 5. Content Modification

### For Complex Structures: Rebuild, Don't Delete

When modifying paragraphs with images (schema constraints apply):

```typescript
// ❌ WRONG: Direct deletion can cause schema errors
state.tr.delete(from, to);  // "Invalid content for node paragraph"

// ✅ CORRECT: Rebuild content atomically
const children: ProseMirrorNode[] = [];
parent.forEach((node, _offset, index) => {
  if (index !== imageIndexToDelete) {
    children.push(node);
  }
});

const newContent = Fragment.from(children);
state.tr.replaceWith(contentStart, contentEnd, newContent);
```

### For Simple Insertions

```typescript
// Insert at document level
const tr = state.tr.insert(insertPos, paragraphType.create());

// Set cursor after insert
tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
view.dispatch(tr.scrollIntoView());
```

---

## 6. Type Checking (Test Compatibility)

### Problem: `instanceof` Fails in Tests

Multiple ProseMirror module copies in test environment cause `instanceof` to fail.

### Solution: Duck-Typing Fallback

```typescript
function isImageNode(selection: unknown, imageTypeName: string): selection is NodeSelection {
  // Try instanceof first
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === imageTypeName;
  }
  // Duck-typing fallback
  const sel = selection as any;
  return sel?.node?.type?.name === imageTypeName;
}

function isGapCursorSelection(selection: unknown): selection is GapCursor {
  if (selection instanceof GapCursor) return true;
  const sel = selection as any;
  return sel?.constructor?.name === 'GapCursor' || sel?.type === 'gapcursor';
}

function isTextSelection(selection: unknown): selection is TextSelection {
  if (selection instanceof TextSelection) return true;
  const sel = selection as any;
  return (
    sel?.constructor?.name === 'TextSelection' ||
    (sel?.$from && sel?.$to && !sel?.node && sel?.empty !== undefined)
  );
}
```

---

## 7. Two-Step Delete Pattern

For destructive operations on images, use visual confirmation:

### Flow
1. **First press:** Select image, show red border (`image-pending-delete` class)
2. **Second press:** Delete the image
3. **Any other action:** Clear pending state

### Implementation

```typescript
// Plugin state tracks pending deletion
interface PluginState {
  pendingDeleteImagePos: number | null;
}

// First press: mark for deletion
if (pendingDeleteImagePos === null) {
  // Set pending state, add decoration
  return true;
}

// Second press: confirm delete
if (pendingDeleteImagePos === imagePos) {
  deleteImage(view, state, selection);
  return true;
}
```

### Clear State On

- Arrow keys, typing, Escape, Tab
- Mouse clicks, selection changes
- Any navigation

---

## 8. Common Pitfalls

### 1. Schema Validation Errors

**Symptom:** `Invalid content for node paragraph: <image>`

**Cause:** ProseMirror schema doesn't allow paragraphs with only images (in some configs).

**Fix:** Rebuild content atomically instead of using `split()`.

### 2. Cursor Jumping to Wrong Position

**Symptom:** After Enter, cursor ends up after a subsequent block (like GitHub alert).

**Cause:** Using document-level position calculation instead of relative.

**Fix:** Use `$from.after($from.depth)` for position immediately after current block.

### 3. Multiple Blank Lines in Output

**Symptom:** Extra newlines between blocks.

**Cause:** Empty paragraphs being serialized.

**Fix:** Filter empty paragraphs in `renderMarkdown` by returning `null`.

### 4. Tests Pass but Production Fails (or vice versa)

**Symptom:** `instanceof` checks behave differently.

**Cause:** Module bundling creates multiple copies of ProseMirror classes.

**Fix:** Use duck-typing fallback for all type checks.

---

## 9. Testing Guidelines

### Document Structure for Tests

Replicate real-world markdown with multiple images:

```typescript
// Create 4-image paragraph structure
const realWorldDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'image', attrs: { src: './1.png' } },
        { type: 'hardBreak' },
        { type: 'image', attrs: { src: './2.png' } },
        { type: 'hardBreak' },
        { type: 'image', attrs: { src: './3.png' } },
        { type: 'hardBreak' },
        { type: 'image', attrs: { src: './4.png' } },
      ],
    },
    { type: 'blockquote', content: [...] },
  ],
};
```

### Test Fixtures

Use `src/__tests__/fixtures/epicReaderFriendly.ts` as canonical fixture for image/Enter tests.

---

## 10. File Reference

| File | Purpose |
|------|---------|
| `src/webview/extensions/customImage.ts` | Image extension with inline config |
| `src/webview/extensions/imageEnterSpacing.ts` | Enter/Backspace/Delete handling |
| `src/webview/extensions/markdownParagraph.ts` | Empty paragraph filtering |
| `src/webview/utils/markdownSerialization.ts` | Pre-serialize JSON normalization |
| `src/webview/editor.css` | Image wrapper and pending-delete styles |
| `src/__tests__/webview/imageEnterSpacing.test.ts` | Comprehensive test suite |

---
