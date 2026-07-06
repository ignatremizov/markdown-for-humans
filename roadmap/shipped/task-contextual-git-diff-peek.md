# Task: Contextual Git Diff Peek

## 1. Task Metadata

- **Task name:** Contextual Git Diff Peek
- **Slug:** contextual-git-diff-peek
- **Status:** shipped
- **Created:** 2026-07-06
- **Last updated:** 2026-07-06
- **Shipped:** 2026-07-06

---

## 2. Context & Problem

The custom editor now opens a compact monospace hunk diff from Git gutter markers, but the peek only shows the selected hunk body. VS Code's built-in dirty diff peek shows nearby unchanged source lines and lets users scroll the peek to inspect adjacent changes without changing the active gutter marker.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- The hunk peek shows unchanged context lines above and below the selected hunk.
- Nearby hunks that fall within the context window render in the same scrollable peek.
- Opening a farther-down hunk inside a shared context window scrolls the peek body to that hunk.
- Opening a hunk from a gutter click scrolls the editor viewport to the peek widget, including tall hunks where the marker click happens near the bottom of the hunk.
- The peek spans the full editor viewport so Prev, Next, Revert, and Close stay at a consistent horizontal position across hunks.
- `markdownForHumans.git.diffPeekScrollBehavior` controls whether diff peek navigation uses smooth animated scrolling or snaps immediately.
- Previous/next still changes the active hunk and scrolls the widget into view.
- The peek remains source/monospace-only, not a second WYSIWYG renderer.

**In scope:**
- Build a contextual review row model in the webview from current source markdown and hunk metadata.
- Render context rows as neutral lines and changed rows as existing red/green rows.
- Keep the body internally scrollable for taller review windows.
- Add focused tests for context lines and nearby hunk inclusion.
- Add focused editor orchestration coverage for gutter-click peek opening.
- Keep the peek width independent of prose width and max-content settings.
- Add a VS Code setting for smooth versus snap diff peek navigation.

**Out of scope:**
- Full file diff panel.
- Stage hunk.
- WYSIWYG rendering inside the diff peek.

---

## 4. UX & Behavior

Clicking a gutter marker opens the same compact widget, now with a few unchanged source lines around the selected hunk. If nearby hunks are close enough to share context, they appear in the same scrollable body so the user can inspect local edits without repeatedly changing the active marker.

---

## 5. Technical Plan

- Add a source-backed contextual diff row builder in `src/webview/features/gitChangeMarkers.ts`.
- Use a small default context radius around the selected hunk and expand the window to include adjacent hunks that fall inside the context neighborhood.
- Pass current source markdown into `renderGitHunkDiffWidget` from `src/webview/editor.ts`.
- Add neutral context row styles to `src/webview/editor.css`.
- Add webview tests for context rendering and nearby hunk inclusion.
- Reuse the editor's computed margin variables to keep the peek action bar at a stable viewport width.
- Contribute and wire a `smooth`/`snap` setting through provider messages into the webview scroll behavior.

---

## 6. Work Breakdown

- [x] Add failing contextual peek tests.
- [x] Implement contextual row building.
- [x] Wire current source markdown into the hunk widget.
- [x] Style neutral context rows and scroll containment.
- [x] Request outer viewport scrolling when a gutter click opens the hunk peek.
- [x] Stabilize peek width across hunks by spanning the editor viewport.
- [x] Add a configurable smooth/snap scroll behavior for Git diff peeks.
- [x] Validate targeted tests, lint, full suite, package, and diff check.

---

## 7. Implementation Log

### 2026-07-06 - Contextual Peek Model

- **What:** Added source-backed context rows around the selected hunk and clustered nearby hunks into the same scrollable monospace peek.
- **What:** Kept the old hunk-only fallback for tests or messages that do not carry source markdown.
- **What:** Added a source-window cap so chained nearby hunks cannot render an unbounded slice of a large document.
- **What:** The peek body now scrolls to the selected hunk when the selected hunk appears lower in a shared context window.
- **What:** Gutter-click opened peeks now request the outer editor viewport scroll so tall hunks reveal the peek widget instead of opening above the visible window.
- **What:** The hunk peek now spans the editor viewport rather than the prose content width, keeping the action buttons in one stable position while reviewing changes.
- **What:** Added `markdownForHumans.git.diffPeekScrollBehavior` so users can choose smooth animated diff navigation or immediate snap navigation.
- **Tests:** `npm test -- src/__tests__/webview/editorCss.test.ts src/__tests__/webview/gitChangeMarkers.test.ts src/__tests__/webview/editorGitChanges.test.ts src/__tests__/features/packageConfiguration.test.ts src/__tests__/editor/undoSync.test.ts --runInBand`; `npm run lint`; `npm test -- --runInBand --silent`; `npm run package:release`; `git diff --check`
