# Task: Configurable Editor Layout Width

## 1. Task Metadata

- **Task name:** Configurable Editor Layout Width
- **Slug:** layout-width
- **Status:** shipped
- **Created:** 2026-07-05
- **Last updated:** 2026-07-05
- **Shipped:** 2026-07-05

---

## 2. Context & Problem

The custom editor currently hardcodes the reading surface side margins as `30px` in `src/webview/editor.css` and lets prose stretch to the full editor width. That default works as a baseline, but users writing on different monitor sizes, asymmetric sidebars, or split-pane layouts need both configurable minimum gutters and a maximum prose width that grows side margins dynamically on wider panes.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- VS Code settings control the editor's left and right side margins independently.
- A VS Code setting controls the editor content's maximum reading width, with `0` preserving the current unbounded layout.
- The defaults preserve the current 30px side layout and full-width content.
- Setting changes apply to existing webviews through the existing settings update path.

**In scope:**
- Add numeric configuration contributions for both side margins.
- Add a numeric configuration contribution for maximum content width.
- Pass the value through `MarkdownEditorProvider` update/settings messages.
- Apply the value as a CSS custom property in the webview.
- Add targeted tests for manifest, provider payload, and webview setting application.

**Out of scope:**
- Per-document margin persistence.
- PDF export page margins.

---

## 4. UX & Behavior

Users configure `markdownForHumans.layout.leftMargin` and `markdownForHumans.layout.rightMargin` as minimum side gutters in Settings. Values are pixels. `30` matches the current default, smaller values maximize screen space, and larger values create a wider reading gutter on the chosen side.

Users configure `markdownForHumans.layout.maxContentWidth` as the maximum prose column width in pixels. `0` disables the cap for the current full-width behavior. Positive values, such as `900`, center the content once the available pane is wider than the configured cap plus the minimum side gutters.

---

## 5. Technical Plan

- Add `markdownForHumans.layout.leftMargin` and `markdownForHumans.layout.rightMargin` to `package.json`.
- Add `markdownForHumans.layout.maxContentWidth` to `package.json`.
- Read them in the provider alongside paragraph spacing and zoom.
- Include them in initial `update`, `ready` settings, and configuration-change settings messages.
- Replace the hardcoded side margins with CSS custom properties that preserve minimum gutters and split extra width into dynamic margins when the max content width is active.
- Apply incoming values to `--md-left-margin`, `--md-right-margin`, and `--md-content-max-width` from `src/webview/editor.ts`.

---

## 6. Work Breakdown

- [x] Add tests for independent side margins.
- [x] Add tests for maximum content width.
- [x] Implement side-margin setting contributions and payload wiring.
- [x] Implement max-width setting contribution and payload wiring.
- [x] Implement dynamic margin CSS.
- [x] Validate targeted tests, lint, full suite, package, and diff check.

---

## 7. Implementation Log

### 2026-07-05 - Started

- **What:** Created plan and started TDD coverage for independently configurable editor side margins.
- **Files:** `roadmap/shipped/task-layout-side-margins.md`

### 2026-07-05 - Shipped

- **What:** Added independent left/right margin settings, provider payload wiring, CSS custom properties, documentation, marker-safe collapsed-margin handling, and regression tests.
- **Validation:** `npm test -- editorCss.test.ts packageConfiguration.test.ts undoSync.test.ts undo-sync.test.ts --runInBand`; `npm run lint`; `npm test -- --runInBand --silent`; `npm run package:release`; `git diff --check`.

### 2026-07-05 - Added Dynamic Max Width

- **What:** Added `markdownForHumans.layout.maxContentWidth`, preserved `0` as unbounded, and split extra pane width into dynamic side margins while keeping left/right settings as minimum gutters.
- **Validation:** `npm test -- editorCss.test.ts packageConfiguration.test.ts undoSync.test.ts undo-sync.test.ts --runInBand`; `npm run lint`; `npm test -- --runInBand --silent`; `npm run package:release`; `git diff --check`.
