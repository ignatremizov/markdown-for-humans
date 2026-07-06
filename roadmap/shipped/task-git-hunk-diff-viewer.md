# Task: Git Hunk Diff Viewer

## 1. Task Metadata

- **Task name:** Git Hunk Diff Viewer
- **Slug:** git-hunk-diff-viewer
- **Status:** shipped
- **Created:** 2026-07-05
- **Last updated:** 2026-07-06
- **Shipped:** 2026-07-05

---

## 2. Context & Problem

The custom editor shows VS Code-style Git dirty markers in the gutter and overview rail, but the gutter markers are decorative only. In the default VS Code text editor, clicking a dirty marker opens a localized hunk diff with controls for moving between hunks, closing the peek, and applying hunk-level actions. The WYSIWYG editor needs the same inspection path so writers do not have to switch to the source editor just to inspect a change.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Clicking a Git gutter marker opens a localized hunk diff widget in the custom editor.
- The widget shows old and new lines for the clicked hunk.
- The widget supports previous hunk, next hunk, close, and revert hunk.
- Existing non-click marker rendering remains intact.

**In scope:**
- Extend the Git hunk model with old/new hunk lines.
- Make gutter markers interactive in the webview.
- Render a compact localized diff widget.
- Revert a hunk by replacing the affected document line range.
- Add targeted tests for host hunk parsing/revert and webview marker/widget behavior.

**Out of scope:**
- Stage hunk from the custom editor.
- Full source-control review experience or SCM view replacement.

---

## 4. UX & Behavior

Users click the colored Git gutter marker beside changed content. A compact diff widget appears near the hunk with removed lines, added lines, and toolbar buttons for previous, next, revert, and close. Revert applies to the live VS Code text document and refreshes Git markers through the existing document-change path.

---

## 5. Technical Plan

- Extend `GitChangeRange` with optional `oldStart`, `oldLineCount`, `newStart`, `newLineCount`, `oldLines`, and `newLines`.
- Parse zero-context diff hunk bodies in `src/editor/gitChangeMarkers.ts`.
- Add a pure helper for reverting one hunk in a markdown string.
- Preserve hunk line arrays through webview message coercion.
- Render gutter markers as clickable buttons with change indexes.
- Add a hunk diff widget renderer in `src/webview/features/gitChangeMarkers.ts`.
- Wire marker clicks and revert messages in `src/webview/editor.ts` and `MarkdownEditorProvider`.

---

## 6. Work Breakdown

- [x] Add tests.
- [x] Extend host hunk model and revert helper.
- [x] Add interactive marker and diff widget rendering.
- [x] Wire webview/provider messages.
- [x] Validate targeted tests, lint, full suite, package, and diff check.

---

## 7. Implementation Log

### 2026-07-05 - Started

- **What:** Created plan and started TDD coverage for clickable Git hunk diff viewing.
- **Files:** `roadmap/pipeline/task-git-hunk-diff-viewer.md`

### 2026-07-05 - Shipped

- **What:** Added clickable Git gutter markers, a localized hunk diff widget, previous/next/close controls, and hunk revert.
- **Files:** `src/editor/gitChangeMarkers.ts`, `src/editor/MarkdownEditorProvider.ts`, `src/webview/features/gitChangeMarkers.ts`, `src/webview/editor.ts`, `src/webview/editor.css`
- **Tests:** `npm test -- gitChangeMarkers.test.ts --runInBand`; `npm test -- src/__tests__/editor/undoSync.test.ts gitChangeMarkers.test.ts --runInBand`; `npm run lint`; `npm test -- --runInBand --silent`; `npm run package:release`; `git diff --check`

### 2026-07-05 - Review Hardening

- **What:** Fixed reviewer-found edge cases for deletion-only hunk insertion, whole-file added hunk revert, stale hunk overwrite prevention, and accessible gutter buttons.
- **Tests:** `npm test -- src/__tests__/editor/gitChangeMarkers.test.ts src/__tests__/webview/gitChangeMarkers.test.ts --runInBand`; `npm run lint`; `npm test -- --runInBand --silent`; `npm run package:release`; `git diff --check`

### 2026-07-06 - Navigation Scroll Follow-Up

- **What:** Previous/next hunk navigation now scrolls the newly selected hunk diff widget into view after it re-renders.
- **Tests:** `npm test -- src/__tests__/webview/gitChangeMarkers.test.ts --runInBand`

### 2026-07-06 - Inline Diff Highlight Follow-Up

- **What:** Modified hunk lines now use stronger inline token highlights, including whitespace-only changes, while preserving line-level red/green backgrounds.
- **What:** Deleted hunk reverts now carry and validate before/after anchor lines to avoid restoring stale deletions into the wrong location.
- **Tests:** `npm test -- src/__tests__/editor/gitChangeMarkers.test.ts src/__tests__/webview/gitChangeMarkers.test.ts --runInBand`

### 2026-07-06 - Diff Navigation Polish

- **What:** Previous/next hunk navigation now uses distance-aware animated scrolling so distant hunks move faster while still respecting reduced-motion preferences.
- **What:** Adjacent changed tokens separated only by punctuation or whitespace are grouped into one inline highlight, while unchanged words still split independent changes.
- **Tests:** `npm test -- src/__tests__/webview/gitChangeMarkers.test.ts src/__tests__/editor/gitChangeMarkers.test.ts --runInBand`; `npm run lint`; `npm test -- --runInBand --silent`

### 2026-07-06 - Mixed Hunk Marker Polish

- **What:** Mixed replacement-plus-insertion hunks now render the replaced line segment as modified and the inserted tail as added in the gutter and overview, while both segments still open the original hunk diff.
- **Tests:** `npm test -- src/__tests__/webview/gitChangeMarkers.test.ts --runInBand`; `npm run lint`
