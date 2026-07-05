---
name: Config cleanup review
overview: Review all configuration options in package.json and identify which ones are unused in the codebase, then make recommendations on which to keep vs. remove.
todos:
  - id: review-configs
    content: Review all 7 configuration options and verify usage in codebase
    status: completed
  - id: identify-unused
    content: "Identify which configs are unused: enableMath, enableDiagrams, autoSave"
    status: completed
  - id: check-docs
    content: Check if removed configs are mentioned in README or other documentation
    status: completed
  - id: remove-enableDiagrams
    content: Remove markdownForHumans.enableDiagrams from package.json (lines 127-131)
    status: completed
  - id: remove-autoSave
    content: Remove markdownForHumans.autoSave from package.json (lines 132-136)
    status: completed
  - id: verify-changes
    content: Verify no code references removed configs and VS Code settings UI updates correctly
    status: completed
---

# Configuration Options Review & Cleanup Plan

## Current Configuration Status

### ✅ **USED Configurations** (Keep)

These are actively used in the codebase:

1. **`markdownForHumans.imagePath`** - Used in:

- `src/editor/MarkdownEditorProvider.ts` (lines 231, 294, 329, 1353)
- `src/webview/editor.ts` (lines 617-619, 641-643)
- `src/webview/features/imageDragDrop.ts`, `imageConfirmation.ts`
- Multiple test files

2. **`markdownForHumans.chromePath`** - Used in:

- `src/features/documentExport.ts` (lines 160, 178, 385, 414, 514)
- `src/__tests__/features/documentExport.test.ts`
- PDF export functionality

3. **`markdownForHumans.imageResize.skipWarning`** - Used in:

- `src/editor/MarkdownEditorProvider.ts` (lines 229, 292, 327, 1351)
- `src/webview/features/imageResizeModal.ts` (lines 600, 617)

4. **`markdownForHumans.imageFilename.includeDimensions`** - Used in:

- `src/editor/MarkdownEditorProvider.ts` (lines 230, 293, 328, 647, 1013, 1352)
- `src/webview/features/imageDragDrop.ts` (lines 918, 970)
- Multiple test files

### ❌ **UNUSED Configurations** (Review for removal)

1. **`markdownForHumans.enableMath`**

- **Status:** Not implemented
- **Evidence:** 
- Task file exists (`roadmap/pipeline/task-p1-katex-math.md`) but feature is not shipped
- No code reads this setting
- KaTeX library is in dependencies but not integrated
- **Recommendation:** **KEEP** (planned feature, task exists)

2. **`markdownForHumans.enableDiagrams`**

- **Status:** Always enabled, no conditional logic
- **Evidence:**
- Mermaid extension is always loaded in `src/webview/editor.ts:302`
- No code checks this setting
- No conditional logic to enable/disable Mermaid
- **Recommendation:** **REMOVE** (no implementation, always enabled)

3. **`markdownForHumans.autoSave`**

- **Status:** Not used, redundant
- **Evidence:**
- No code reads this setting
- VS Code handles auto-save natively via `files.autoSave` setting
- Only found in comment: "Auto-saves to configurable folder" (not related to this setting)
- **Recommendation:** **REMOVE** (redundant with VS Code's native auto-save)

## Implementation Plan

### Option A: Conservative (Keep planned features)

- Remove: `enableDiagrams`, `autoSave`
- Keep: `enableMath` (for future implementation)

### Option B: Aggressive (Remove all unused)

- Remove: `enableDiagrams`, `autoSave`, `enableMath`
- Re-add `enableMath` when implementing KaTeX support

## Recommended Action: Option A

**Rationale:**

- `enableMath` has a clear task file and is planned work
- Removing it now means re-adding it later when implementing KaTeX
- `enableDiagrams` and `autoSave` have no implementation and no plans

## Files to Modify

1. **`package.json`** (lines 122-136)

- Remove `markdownForHumans.enableDiagrams` (lines 127-131)
- Remove `markdownForHumans.autoSave` (lines 132-136)
- Keep `markdownForHumans.enableMath` (lines 122-126) for future use

## Verification Steps

1. Search codebase for any remaining references to removed configs
2. Check if any documentation mentions these settings
3. Verify VS Code settings UI no longer shows removed options
4. Confirm no tests reference removed configs

## Notes

- The `enableMath` config was restored in `task-user-chrome-path.md` (line 395) after being accidentally removed
- Mermaid diagrams are always enabled - there's no toggle functionality
- VS Code's native `files.autoSave` setting handles document auto-saving
