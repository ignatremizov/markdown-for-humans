# 1. Task Metadata

- **Task name:** P1: Fix newline rendering in plain-text markdown blocks
- **Slug:** p1-email-markdown-newline-rendering
- **Status:** shipped
- **Created:** 2025-12-01
- **Last updated:** 2026-07-17
- **Shipped:** 2025-12-01

---

## Current Contract

The original 2025 implementation described below used `breaks: true`, which converted every source newline into a rendered hard break. That behavior has been superseded:

- A single newline inside prose is a CommonMark soft break. The source boundary is retained for editing and serialization, but it flows visually like a space.
- Two trailing spaces or a trailing backslash create an explicit hard break in prose blocks.
- Code blocks retain literal whitespace during opening, rendering, editing, saving, reopening, and export.
- Only when the user explicitly removes code-block formatting does conversion to prose preserve isolated internal line boundaries, canonicalize each run of internal blank code lines to one stable prose paragraph boundary, and trim leading and trailing blank code lines.
- Headings and inline code are single-line Markdown constructs in the editor. Converting into them, or inserting a hard break into a heading, normalizes the line boundary to a space because it cannot round-trip reliably.
- `SoftBreakRendering` applies one node decoration per affected prose block. Repeated spaces and tabs remain in serialized source but collapse visually under normal CommonMark prose flow; Find uses that same visible-text model.
- Find keeps a later-batch active result anchored by its mapped document position when edits add or remove earlier matches, then reloads the aligned bounded match batch and counter.
- The paste converter intentionally retains `breaks: true` because pasted plain text is normalized before it enters the editor document.

Regression coverage lives in
`src/__tests__/webview/softBreakRendering.test.ts`,
`src/__tests__/webview/inlineCodeBacktickShortcut.test.ts`, and
`src/__tests__/webview/searchOverlay.test.ts`.

---

## 2. Context & Problem (Historical)

- **Current state:**

  - Users often write multiple plain-text lines (one per line, not list items) for quick option sets like:

    ```plaintext
    Subject Option 1: Markdown is broken. I fixed it.
    Subject Option 2: Stop writing raw Markdown (seriously)
    Subject Option 3: Write Markdown like a human 🧠
    Subject Option 4: The VS Code extension you didn't know you needed
    Subject Option 5: Finally: A free WYSIWYG editor for VS Code
    ```

    When opened in the md-human WYSIWYG editor, those newline-separated lines are rendered as one flowing paragraph with inline spaces between them (as seen in the provided screenshot). It comes like this: 

    ![image](./images/image-1764580981207.png)

- **Pain points:**

  - Visually, all lines appear merged, which makes it harder to scan and compare or edit individual options.
  - The rendered view does not reflect the underlying markdown/newline structure.

- **Why it matters:**

  - The editor should be a trustworthy representation of the markdown document, especially when users depend on one-line-per-option flows.
  - Collapsing single newlines in these plain-text sections hurts readability and makes comparing options slower.

---

## 3. Desired Outcome & Scope

- **Success criteria:**
  - Soft-wrapped prose retains its source newline through editing and serialization.
  - Soft wraps flow at the configured content width instead of creating forced visual line breaks.
  - Explicit hard breaks remain visually distinct.
  - Existing behavior for proper markdown paragraphs and lists is preserved (no regressions).
  - Large soft-wrapped blocks remain within the editor performance budgets.
- **In scope:**
  - Parsing/rendering rules for how single newlines vs double newlines are treated in plain-text blocks.
  - Any TipTap/ProseMirror or markdown-to-doc conversions that currently collapse these newlines.
  - Minimal UX adjustments needed so source-wrapped prose remains trustworthy without forcing its visual width.
- **Out of scope:**
  - Broader typography changes or layout redesigns.
  - New formatting options for subject lines or other dedicated block types.
  - Import/export semantics beyond standard markdown behavior.

---

## 4. UX & Behavior

- **Entry points:**
  - Opening any markdown file in the md-human WYSIWYG editor where the user has authored newline-separated plain-text options (like the subject-option block above).
- **User flows:**
  - User opens prose that contains source wrapping.
  - User opens or switches to the WYSIWYG view.
  - The prose reflows to the available reading width while saving preserves the authored source boundaries.
- **Behavior rules:**
  - A single newline in prose is a source-preserving soft break.
  - Two trailing spaces or a trailing backslash creates a visible hard break.
  - Lists preserve continuation boundaries without forcing a visible break.
  - Code blocks preserve literal whitespace.
  - Headings and inline code normalize embedded soft newlines to spaces when formatting requires a single-line construct.

---

## 5. Technical Plan

- **Surfaces:**
  - Webview TipTap editor (rendering and serialization)
  - Extension side remains unchanged (TextDocument stays source of truth)
- **Key changes:**
  - `src/webview/utils/markedLexerNormalizer.ts` – Use CommonMark soft-break parsing in the editor.
  - `src/webview/extensions/softBreak.ts` – Mark affected prose blocks and keep decorations current across edits and block conversions.
  - `src/webview/extensions/inlineCodeBacktickShortcut.ts` – Normalize selected soft wraps before applying inline code.
  - `src/webview/features/searchOverlay.ts` – Search the visible text model across soft wraps and mark boundaries.
  - `src/webview/editor.css` – Collapse source soft wraps visually at the decorated block level.
- **Architecture notes:**
  - Entirely webview-scoped; no new extension messages. Keep transformations symmetrical so serialization does not re-collapse lines.
  - Scope the behavior to bare text blocks; guard lists, headings, blockquotes, and normal paragraphs from unintended splits.
- **Performance considerations:**
  - Prefer configuration or a small extension over heavy post-processing; keep render-time work minimal to stay within the <16ms interaction budget and existing 500ms sync debounce.
  - Normalize all selected soft wraps for inline-code formatting with one fragment replacement, not one transaction step per newline.

---

## 6. Work Breakdown

| Status | Task | Notes |
|--------|------|-------|
| `done` | Inspect current Markdown parser/serializer behavior for single newlines in plain-text blocks | Confirmed the editor can retain source newlines without rendering hard breaks |
| `done` | Implement source-preserving soft wraps | Added block-level soft-wrap rendering and conversion normalization |
| `done` | Add CSS rendering rule | Affected prose blocks use normal whitespace flow |
| `done` | **Write unit tests** | Added parsing, editing, conversion, search, inline-code, and 10,000-line performance coverage |
| `done` | Manual verification in WYSIWYG | Verified by user with `email-newsletter.md` ✅ |

### How to Verify

**Inspect current behavior:**
1. Open `src/webview/editor.ts` and markdown parser/serializer utilities.
2. Trace how single `\n` is transformed markdown → doc → markdown.
3. Confirm where collapsing occurs.

**Implement newline preservation:**
1. Apply code changes to parser/serializer or a new TipTap extension.
2. Reload the extension and open a sample with the subject-option block.
3. Expect the prose to reflow while serialization retains each source newline.

**CSS spacing (if used):**
1. Verify a soft source newline occupies the same visual space as an ordinary space.
2. Ensure no layout shift for other block types.

**Unit tests:**
1. Run `npm test`.
2. Tests assert soft wraps survive serialization, flow visually, and remain responsive in a 10,000-line block.
3. Tests pass.

**Manual verification:**
1. Open the WYSIWYG view for `email-newsletter.md` (or a similar sample block).
2. Resize the editor and confirm the prose reflows at the reading width.
3. Save and confirm source wraps, lists, explicit hard breaks, and code blocks remain correct.

---

## 7. Implementation Log (Historical)

### 2025-12-01 – Task refined

- **What:** Technical plan and work breakdown added
- **Ready for:** Implementation
- **First task:** Inspect current Markdown parser/serializer behavior for single newlines in plain-text blocks

### 2025-12-01 – Bug fixed

- **What:** Changed `breaks: false` to `breaks: true` in markdown config
- **Files:**
  - `src/webview/editor.ts:208` – TipTap Markdown extension config
  - `src/webview/utils/pasteHandler.ts:112` – markdown-it instance for paste handling
- **Root cause:** CommonMark spec treats single newlines as spaces when `breaks: false`. Setting `breaks: true` converts single `\n` to `<br>` tags, preserving visual line separation.
- **Tests:** Added 5 regression tests in `src/__tests__/webview/pasteHandler.test.ts`:
  - `should convert single newlines to <br> in plain text blocks`
  - `should preserve newlines in email subject options (real-world example)`
  - `should still create paragraph breaks for double newlines`
  - `should not affect list rendering`
  - `should not affect heading rendering`
- **Result:** All 166 tests pass, no regressions

### 2026-07-17 – CommonMark behavior restored

- **What:** Replaced editor-wide hard wrapping with source-preserving soft wraps.
- **Why:** Source line wrapping is an authoring boundary, not a forced visual line break. Rendering it as a hard break prevented prose from adapting to the configured reading width.
- **Implementation:** The parser retains literal soft-break characters and a block-level TipTap decoration collapses them visually. Search and inline-code formatting use the same visible-text semantics.
- **Performance:** One decoration is created per affected prose block. Dense repeated whitespace and a 10,000-line paragraph do not increase decoration count per newline or whitespace run. Formatting a selected 10,000-line prose block as inline code batches newline normalization into one replacement and remains within the 300ms toolbar-action budget. Heading conversion likewise combines one fragment replacement with the block-type change in one transaction so no multiline heading is rendered as an intermediate state.

---

## 8. Decisions & Tradeoffs

- **CommonMark semantics:** The editor uses `breaks: false`; source wraps flow visually while explicit Markdown hard breaks remain visible.
- **Block-level decoration:** A node decoration avoids per-newline DOM and transaction overhead while retaining exact source serialization.
- **Single-line constructs:** Heading and inline-code conversions normalize a selected soft wrap to a space so subsequent parse/serialize cycles are stable.
- **Paste remains separate:** Paste normalization keeps its existing hard-wrap interpretation because it handles imported plain text before document parsing.

---

## 9. Follow-up & Future Work

- `[Future enhancements TBD once core behavior is fixed]`
