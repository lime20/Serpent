# Remove Presentation Converter Fallback

> **For agentic workers:** Apply the user's explicit scope with regression coverage, preserve original encoding/line endings and all unrelated pending work, and leave changes uncommitted.

**Goal:** Remove LibreOffice discovery, configuration and process conversion. A presentation without a decodable embedded thumbnail fails directly.

**Architecture:** Keep PPTX JPEG/PNG extraction and ordinary Sharp normalization. Persist `PRESENTATION_THUMBNAIL_UNAVAILABLE` as a terminal thumbnail failure using the embedded generator's failed version. PPT remains thumbnail-capable for imported covers but has no new binary-PPT thumbnail decoder. Preserve existing imported/ready caches and read-only compatibility with older generator/error strings without keeping an active converter.

## Tasks

- [x] Add regression expectations that missing, oversized, invalid or Sharp-undecodable embedded covers fail without spawning any process; valid covers and imported caches remain usable, cancellation leaves no failure, and ordinary enqueue does not repeat terminal work.
- [x] Remove converter methods, executable resolver, environment configuration and converter-specific runtime semaphore/temp-PDF plumbing. Keep the normal PDF thumbnail generator and its cancellation fixes.
- [x] Replace active converter-required status/copy with `PRESENTATION_THUMBNAIL_UNAVAILABLE` and clear embedded-cover failure text. Treat old stored statuses/generators as compatibility data only; never prompt users to install a converter.
- [x] Rewrite obsolete converter tests and the session-log E2E around embedded-only failure, explicit retry, menu controls and byte-range serving. Remove resolver-only tests with no remaining product function.
- [x] Update Chinese/English developer guides, presentation design and historical-plan annotations so the current supported behavior is unambiguous.
- [x] Run focused unit/Worker tests, full units, library availability, typecheck, targeted lint and Electron thumbnail/session/menu checks. Verify encoding/newlines and final runtime-reference scan.

## Boundaries

- Source presentations are not rewritten. No library database migration or thumbnail-cache purge is introduced.
- Existing usable thumbnails remain displayable. Legacy `presentation-soffice-pdfjs@1` or `LIBREOFFICE_REQUIRED` strings may remain only where needed to read historical data or describe superseded decisions.
- Installing/converting with another application is not part of this feature.

## Verification results

- Initial backend regressions exposed 7 failures in 25 cases, proving that the old implementation still called the converter or produced dependency failures. UI expectations likewise first failed for missing embedded-cover status/copy. These pass with the converter removed.
- The final Worker batch passed 108 tests in 2 files: 25 presentation regressions plus 83 thumbnail tests. Cases cover valid real Sharp output, missing/invalid/oversized/signed-corrupt covers, no process invocation, PPT failure, terminal deduplication, explicit retry, imported covers, historical ready/failed caches, cancellation and ordinary PDF cancellation.
- Independent review identified native resource pressure and persistence errors being classified as missing covers. Added failing ENOMEM, ENOSPC, EACCES and SQLite ready-insert fault injections, then separated decoding from persistence and propagated existing system/resource classifications. Failed output cleanup preserves the original error.
- Final full unit suite: 655 files, 4612 passed, 10 skipped, using `npm run test:unit -- --maxWorkers=4`. A concurrent heavy run had one unrelated QuickJS CPU-budget timing failure; the reduced-concurrency full rerun passed without changing that test or its source.
- Library availability: 9 files, 232 passed, 1 skipped. TypeScript checks passed. Targeted lint passed; preview-component Hook warnings are pre-existing.
- Electron application rebuilt from final source: 2 E2Es passed. They verify normal image manual refresh, readable embedded PPTX covers, missing-cover failure text, task-panel retry without invalid IPC/menu-key warnings, and 33 successful HTTP 206 source-range reads. No converter configuration is supplied.
- An earlier Worker assertion run completed successfully but the Electron process reported a Windows invalid-handle shutdown error; the final 108-test run exited normally with code 0.
- Runtime source scan found only legacy generator/error compatibility literals. There is no LibreOffice resolver, environment configuration, converter function, conversion semaphore, process launch or temporary-PDF presentation path.
- Current developer guides and presentation design were synchronized; earlier plans/specs explicitly mark the conversion design superseded. No source presentations or library databases were changed, and no thumbnail caches were purged. Encoding/BOM/newline and `git diff --check` verification passed.
- Changes remain uncommitted. macOS/Linux application and packaged-app validation were not performed; Windows Electron E2Es exercise the embedded-only path.
