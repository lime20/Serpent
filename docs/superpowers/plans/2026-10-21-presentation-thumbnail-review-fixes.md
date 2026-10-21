# Presentation Thumbnail Review Fixes Implementation Plan

> **Historical note:** This plan records the earlier converter-based review fixes and their original test results. [Remove Presentation Converter Fallback](2026-10-21-remove-libreoffice-fallback.md) supersedes the converter/fallback portions: unavailable embedded covers now fail directly with `PRESENTATION_THUMBNAIL_UNAVAILABLE`, and no converter process is started. Imported-cache preservation and cancellation requirements remain applicable.

> **For agentic workers:** Execute this plan task-by-task with test-first regression coverage.

**Goal:** Fix all three verified thumbnail review findings without changing presentation viewer routing or source files.

**Architecture:** Keep PPT/PPTX as thumbnail-only `other` assets. Persist optional-converter failures through the existing terminal artifact policy, preserve imported generators before format-specific checks, and continue from corrupt embedded previews to LibreOffice while propagating cancellation.

**Tech Stack:** TypeScript, Electron UtilityProcess, SQLite artifacts/jobs, yauzl, Sharp, PDF.js, optional system LibreOffice, Vitest.

---

### Task 1: Establish failing regression coverage

**Files:** Create `tests/worker/presentation-thumbnail-regressions.test.ts`.

- [x] Test missing executable, nonzero exit and missing PDF through `processThumbnailQueue`; assert a failed artifact and no automatic re-enqueue.
- [x] Test explicit `enqueueArtifactRetry({ libraryId, assetId, kind: 'thumbnail' })` after a terminal failure.
- [x] Test real Eagle/Billfish imports of PPT/PPTX, including normalized thumbnail generators; assert the ready artifact survives automatic enqueue.
- [x] Test a corrupt PNG with a valid signature; assert LibreOffice fallback is reached and a generated PDF can produce the thumbnail.
- [x] Test cancellation leaves no failed artifact and propagates `AbortError`.
- [x] Run `node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/presentation-thumbnail-regressions.test.ts` and verify failures correspond to the review findings.

### Task 2: Apply the minimal fixes

**Files:** Modify `src/worker/library-service.ts` and the old fallback expectation in `tests/worker/thumbnails.test.ts`.

- [x] Keep imported generators current before presentation-specific generator checks:

```ts
if (generatorVersion.startsWith('plugin:')) return true;
if (isImportedThumbnailGenerator(generatorVersion)) return true;
if (isSupportedPresentationExtension(relativeFilePath)) {
  return isPresentationThumbnailGenerator(generatorVersion);
}
```

- [x] Propagate cancellation from embedded decoding; ordinary decode failures continue to the existing converter:

```ts
if (execution.signal?.aborted) execution.signal.throwIfAborted();
if (error instanceof DOMException && error.name === 'AbortError') throw error;
```

- [x] Generalize the existing failed-thumbnail writer for models and presentations. If conversion returns no PDF, write a failed `thumbnail` with `UNSUPPORTED_FORMAT` and generator `${PRESENTATION_SOFFICE_GENERATOR};failed`, then throw `LibraryServiceError('INTERNAL_ERROR', { reason: 'MEDIA_PROCESSING_FAILED' })` so the queue records failure.
- [x] Check cancellation before persisting failure; leave the existing explicit retry and source-revision behavior intact.
- [x] Update the old unavailable-converter test to expect rejection instead of a successful null result.
- [x] Re-run the regression file and the original PPTX/soffice tests until green.

### Task 3: Verify and document

**Files:** Update `docs/developer/media-format-support.md` and `docs/superpowers/specs/2026-10-20-presentation-thumbnail-support-design.md`.

- [x] Document terminal failure, explicit retry, imported-preview preservation, embedded decode fallback and actual validation limits.
- [x] Run related unit tests, the thumbnail/derived-artifact/foreign-library import Worker tests, `npm run typecheck`, and targeted ESLint.
- [x] Run `npm run test:library-availability` because Worker storage behavior changes.
- [x] Review the final diff, verify original encoding/line endings, and ensure unrelated untracked files remain untouched.
- [x] Report real LibreOffice and platform package rendering as unverified unless actually exercised. Keep changes uncommitted for user review.

### Verification results

- Added 16 regression cases. The original three findings produced 13 failures before their fixes; two additional PDF cancellation cases failed before the cancellation fix. All 16 now pass.
- PDF fallback now checks cancellation after Sharp and removes partial JPEG output before propagating cancellation; cancelled work writes neither a ready nor a failed artifact.
- Final combined thumbnail and regression run: 2 files, 99 tests passed, exit code 0. A preceding thumbnail-only run passed all 83 assertions but reported a Windows native handle error during process shutdown; the combined rerun exited normally.
- Related thumbnail/import/repair Worker batch: 5 files, 123 tests passed. Library availability suite: 9 files, 232 tests passed, 1 skipped.
- Full unit suite: 648 files, 4558 tests passed, 10 skipped. Final TypeScript checks and targeted ESLint passed.
- Tracked files edited for these fixes retain UTF-8 without BOM and LF line endings; `git diff --check` passed.
- Converter orchestration is tested with injected process results and actual PDF.js/Sharp rendering. Real LibreOffice rendering and Windows/macOS/Linux packages remain unverified.
