# Task: Git Change Markers

## 1. Task Metadata

- **Task name:** Git Change Markers
- **Slug:** git-change-markers
- **Status:** in-progress
- **Created:** 2026-07-05
- **Last updated:** 2026-07-05
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state:**
- The custom WYSIWYG editor opens normal file-backed markdown documents, so VS Code Git state updates correctly in Source Control.
- Native text editor dirty-diff affordances do not appear inside the custom webview surface.
- Users can inspect changes by opening the source editor or a diff view, but the WYSIWYG view has no edited/new/deleted line hints.

**Pain points:**
- **Lost orientation:** While writing in the custom editor, users cannot see which document areas changed.
- **Review friction:** Users must switch to the source editor to scan Git changes.
- **Parity gap:** VS Code's standard markdown editor shows change markers in the gutter, scrollbar, and minimap.

**Why it matters:**
- Git-aware writing is a core VS Code expectation.
- Lightweight markers preserve the reading/writing experience without forcing users back to monospace source.
- Visible change locations make long-document editing safer.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Modified lines show blue markers, added lines show green markers, and deleted ranges show red boundary markers in the custom editor.
- A slim overview rail shows the same change distribution across the full document height.
- Markers refresh after webview edits, external document changes, saves, and Git state changes.
- Non-Git files and clean files show no markers and do not surface errors.

**In scope:**
- Host-side dirty-diff calculation for file-backed Git documents.
- Webview-side rendering of line markers and an overview rail.
- Unit coverage for diff parsing and marker projection.

**Out of scope:**
- A full side-by-side WYSIWYG diff editor.
- Native VS Code minimap reuse; custom webviews cannot inherit the text editor minimap.
- Inline word-level diff highlighting.
- Staged/unstaged separation UI.

---

## 4. UX & Behavior

**Entry points:**
- Automatic when a markdown file is opened in Markdown for Humans inside a Git repository.

**User flows:**

### Flow 1: Editing a tracked file
1. User opens a tracked markdown file in the custom editor.
2. User edits existing prose.
3. Blue markers appear beside changed lines and in the overview rail.

### Flow 2: Adding new content
1. User adds new paragraphs or list items.
2. Green markers appear for the new rendered line range and in the overview rail.

### Flow 3: Deleting content
1. User deletes existing lines.
2. A red marker appears at the nearest surviving line boundary and in the overview rail.

**Behavior rules:**
- Markers are visual only and must not change document content or selection.
- When Git is unavailable, the file is outside a repository, or the file is clean, the webview receives an empty marker set.
- Marker refresh work is debounced so typing remains under the existing latency budget.

---

## 5. Technical Plan

**Surfaces:**
- Extension host: compute compact dirty-diff ranges for the active document.
- Webview: map source line ranges to rendered block positions and draw markers.

**Key changes:**
- `src/editor/gitChangeMarkers.ts` - New utility for Git repo detection, unified-diff parsing, and dirty range modeling.
- `src/editor/MarkdownEditorProvider.ts` - Send `gitChanges` payloads on updates and after edit/external/Git events.
- `src/webview/features/gitChangeMarkers.ts` - New webview renderer for gutter markers and overview rail.
- `src/webview/editor.ts` - Wire incoming marker messages to the renderer.
- `src/webview/editor.css` - Theme-aware marker styling using VS Code diff colors.
- `src/__tests__/editor/gitChangeMarkers.test.ts` - Host-side parsing and repository behavior tests.
- `src/__tests__/webview/gitChangeMarkers.test.ts` - DOM projection tests for marker rendering.

**Architecture notes:**
- Use `git diff HEAD --unified=0 --no-ext-diff -- <file>` so staged and unstaged changes are represented relative to HEAD.
- Treat untracked files as all-added.
- Keep the webview payload compact: source line ranges and types only.

**Performance considerations:**
- Debounce Git diff refresh after edits.
- Skip shell work for non-file documents or files without a Git root.
- Avoid per-keystroke DOM reconstruction when marker payloads are unchanged.

---

## 6. Work Breakdown

- [x] **Phase 1: Host dirty-diff model**
  - [x] Write failing tests for unified diff parsing.
  - [x] Implement range parser and untracked-file handling.
  - [x] Add safe Git root detection.
- [x] **Phase 2: Provider wiring**
  - [x] Post marker updates on initial load and document changes.
  - [x] Debounce marker refresh after webview edits.
  - [x] Clear markers on errors/non-Git documents.
- [x] **Phase 3: Webview rendering**
  - [x] Write failing DOM tests for gutter and overview marker rendering.
  - [x] Implement line-range projection for the custom editor surface.
  - [x] Style markers with VS Code diff tokens.
- [ ] **Testing**
  - [x] Run targeted tests.
  - [x] Run full test suite.
  - [ ] Manually verify tracked modified/added/deleted lines in VS Code.

---

## 7. Implementation Log

### 2026-07-05 - Started

- **What:** Created the plan after roadmap pipeline cleanup.
- **Files:** `roadmap/pipeline/task-git-change-markers.md`
- **Notes:** Native minimap/gutter decorations do not cross into custom webviews; this feature implements equivalent lightweight webview markers.

### 2026-07-05 - Host and webview implementation

- **What:** Added Git diff range parsing, provider refresh wiring, and webview gutter/overview markers.
- **Files:** `src/editor/gitChangeMarkers.ts`, `src/editor/MarkdownEditorProvider.ts`, `src/webview/features/gitChangeMarkers.ts`, `src/webview/editor.ts`, `src/webview/editor.css`, `src/__tests__/editor/gitChangeMarkers.test.ts`, `src/__tests__/webview/gitChangeMarkers.test.ts`
- **Notes:** Marker placement is line-range based, not word-diff based. The provider sends a separate `gitChangesUpdate` message so content sync remains unchanged.

### 2026-07-05 - Review hardening

- **What:** Hardened marker refresh against webview readiness, stale async results, unsaved buffer edits, and repositories without `HEAD`.
- **Files:** `src/editor/gitChangeMarkers.ts`, `src/editor/MarkdownEditorProvider.ts`, `src/webview/features/gitChangeMarkers.ts`, `src/webview/editor.ts`, `src/__tests__/editor/gitChangeMarkers.test.ts`, `src/__tests__/editor/undoSync.test.ts`, `src/__tests__/webview/gitChangeMarkers.test.ts`
- **Notes:** The ready handler now force-sends content so a pre-ready update cannot leave the editor blank. Marker projection now prefers rendered ProseMirror block geometry when raw source markdown is available, with raw line percentages as a fallback.
- **Validation:** `npm test -- gitChangeMarkers.test.ts undoSync.test.ts --runInBand`, `npm run lint`, `npm test -- --runInBand --silent`, `npm run package:release`, `git diff --check`.

### 2026-07-05 - Reviewer follow-up

- **What:** Closed reviewer findings for CRLF-only false positives and stale markers after ref-only Git baseline changes.
- **Files:** `src/editor/gitChangeMarkers.ts`, `src/editor/MarkdownEditorProvider.ts`, `src/__tests__/editor/gitChangeMarkers.test.ts`, `src/__tests__/editor/undoSync.test.ts`
- **Notes:** Dirty-diff temp files normalize line endings before comparison, and Git watcher coverage now includes branch refs plus `packed-refs` in addition to `index` and `HEAD`.
- **Validation:** `npm test -- gitChangeMarkers.test.ts undoSync.test.ts --runInBand`, `npm run lint`, `git diff --check`.

---

## 8. Decisions & Tradeoffs

- **Custom overview rail instead of native minimap:** VS Code's minimap belongs to the native text editor. A custom webview must draw its own overview markers.
- **Git CLI instead of internal Git extension API:** The CLI gives deterministic unified diff output and avoids relying on undocumented Git extension internals.
- **Line-range markers before word-level diffs:** Line markers match the user's immediate need and keep rendering cheap for long prose documents.

---

## 9. Follow-up & Future Work

- Optional setting to hide/show change markers.
- Clickable overview markers that scroll to the changed block.
- Full WYSIWYG diff editor if upstream maintainers want that mode later.
