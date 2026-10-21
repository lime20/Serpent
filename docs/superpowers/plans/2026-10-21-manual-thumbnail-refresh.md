# Manual Thumbnail Refresh Implementation Plan

> **Historical note:** References below to LibreOffice and the previous presentation regression suite describe the validation at the time. [Remove Presentation Converter Fallback](2026-10-21-remove-libreoffice-fallback.md) supersedes that converter behavior: manual PPTX refresh only retries embedded-cover extraction, and PPT has no source-cover decoder. Cache, queue and menu behavior otherwise remain applicable.

> **For agentic workers:** Execute task-by-task with test-first coverage. Preserve existing encoding, line endings and unrelated working-tree changes. Leave changes uncommitted.

**Goal:** Document the current thumbnail cache and add a usable manual refresh action for single and multiple assets.

**Architecture:** Add an asset context-menu command using the existing thumbnail retry IPC and durable queue. Persist explicit refresh intent so source-direct optimization cannot discard a user request. Reuse current completion events and renderer state updates.

**Tech Stack:** TypeScript, React, SQLite media jobs, Vitest, Electron/Playwright.

---

### Task 1: Explicit thumbnail refresh in the Worker

**Files:** `src/worker/library-service.ts`, `src/worker/artifact-policy.ts`, related Worker regression tests.

- [x] Write tests proving `enqueueArtifactRetry({ libraryId, assetId, kind: 'thumbnail' })` actually generates a small source-direct image, replaces a ready/imported thumbnail, dedupes repeated requests and rejects read-only writes; verify automatic small images remain source-direct.
- [x] Run the relevant tests with `node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/manual-thumbnail-refresh.test.ts`; capture expected failures before implementation.
- [x] Add an explicit thumbnail marker to queued jobs, retain it on active-job promotion and recovery, exclude marked work from automatic source-direct pruning, and bypass source-direct claim rejection only for that marker. Guard the retry write with the existing writable-library assertion.
- [x] Re-run the new tests plus existing thumbnail and presentation regressions; run `npm run test:library-availability`.

### Task 2: Asset context-menu action

**Files:** `src/renderer/App.tsx`, existing asset menu command modules, `src/renderer/i18n/catalogs/{en,zh-CN}.ts`, related unit and E2E tests.

- [x] Add failing tests for ready/missing asset refresh, multi-selection filtering/deduplication, unavailable/deleted/read-only states and partial submission failure.
- [x] Add localized 「刷新缩略图」 / “Refresh thumbnail” single and multi-selection commands; submit eligible targets with `api.retryArtifact({ libraryId, assetId, kind: 'thumbnail' })` using bounded request concurrency and existing notice/error patterns.
- [x] Refresh relevant asset summaries after submission without reporting queue acceptance as completed generation; retain existing completion events to update finished thumbnails.
- [x] Add an Electron regression that clicks the real menu for an already-generated image and observes a different ready artifact ID. Exercise batch refresh as practical within that fixture.

### Task 3: Documentation and final validation

**Files:** `docs/developer/media-format-support.md`, `docs/developer/media-format-support.en.md`, this plan.

- [x] Document DB metadata versus disk image bytes, current revision cache lookup, async generation, invalidation/retry and the exact source-direct limits from `src/shared/preview-policy.ts`.
- [x] Document right-click single/batch refresh scope, queued feedback, explicit small-image generation and PPT/PPTX embedded-thumbnail limitations.
- [x] Run targeted unit/Worker/E2E tests, `npm run typecheck`, targeted ESLint and `git diff --check`; confirm original encoding/BOM/line endings.
- [x] Review spec coverage, final diff and verification limits. Record actual outcomes and retain all pre-existing changes.

## Verification results

- UI command coverage first failed in 5 expected cases; cross-page candidate coverage also failed before its implementation. The final targeted UI batch passed 128 tests.
- Initial Worker coverage failed in 9 of 11 expected cases. The final 14-case suite additionally exercises interrupted recovery, resource/lease requeue and failed explicit refresh followed by task-panel retry. The latter reproduced `SOURCE_DIRECT` cancellation before its fix.
- Final related Worker batch: 5 files, 139 tests passed, including thumbnails, presentation regressions, derived artifact repair and imported thumbnail normalization.
- Full unit suite: 649 files, 4573 tests passed, 10 skipped. Library availability suite: 9 files, 232 tests passed, 1 skipped.
- Windows Electron E2E: all 10 existing context-menu tests passed. The new test verifies single refresh of a ready image, batch refresh including a source-direct image, new artifact IDs and actual decoded card images. Its first run exposed the fixture's imported multi-selection; explicitly selecting the single target corrected the fixture, and the final run passed.
- TypeScript checks passed. Targeted ESLint passed with no errors; App retains two pre-existing React Hook dependency warnings. `git diff --check` passed; all 21 tracked modified files retain UTF-8, their original BOM state and newline style.
- Independent source review found the task-panel retry intent gap, which was repaired and retested; final integration review found no remaining substantive issues.

| Requirement | Implementation | Automated evidence | Runtime/platform evidence |
| --- | --- | --- | --- |
| Cache lifecycle documentation | Chinese and English `docs/developer/media-format-support` guides | Source checked against cache lookup, artifact persistence and preview policy | Windows Electron loaded generated thumbnail files |
| Single and batch refresh | Asset menu commands, `thumbnail-refresh.ts`, App refresh handler | UI command/helper tests and `manual-thumbnail-refresh.test.ts` E2E | Windows Electron menu actions passed; other platforms unverified |
| Small-image refresh and durable retry | `EXPLICIT_THUMBNAIL_REFRESH_MARKER`, retry enqueue, claim/pruning/recovery paths | 14 Worker regression cases with real Sharp output | Windows Electron source-direct image becomes a generated ready artifact |
| PPT/PPTX remains thumbnail-only | Existing presentation generators and shared registry | Existing 16 presentation regression cases passed | Real LibreOffice and platform packages remain unverified |

Changes remain uncommitted. Existing presentation work and unrelated untracked files are retained.
