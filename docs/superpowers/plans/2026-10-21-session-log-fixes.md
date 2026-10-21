# Session Log Fixes Implementation Plan

> **Historical note:** The converter discovery, dependency status, installation hints and related conversion checks below describe the implementation at the time of this log investigation. They are superseded by [Remove Presentation Converter Fallback](2026-10-21-remove-libreoffice-fallback.md): presentation source thumbnails now use embedded-cover extraction only and fail directly when unavailable. The other log/UI fixes remain applicable.

> **For agentic workers:** Apply focused test-first fixes. Preserve original encoding, line endings and all existing uncommitted work. Leave changes uncommitted.

**Goal:** Fix the actionable errors identified in `serpent-20261021T105710.log` and improve evidence for recovered startup and media-request behavior.

**Architecture:** Preserve the optional presentation conversion path and existing durable thumbnail queue. Resolve LibreOffice from configured/system locations, classify missing conversion capability explicitly, and log expected cooperative interruptions at info level. Keep strict nonempty job-ID protocol validation while resolving all failed jobs at the UI boundary. Give menu rows stable React identity in the shared MenuSurface.

**Tech Stack:** TypeScript, React, Electron, Vite, SQLite, Vitest and Playwright.

---

### Task 1: Optional converter capability and cancellation diagnostics

**Files:** `src/worker/binary-resolver.ts`, `src/worker/library-service.ts`, `src/worker/index.ts`, shared error/repair policy and focused tests.

- [x] Establish failing tests for missing executable, common system installation locations, configuration changes and correct terminal dependency status.
- [x] Detect optional LibreOffice without spawning an unavailable command for every asset. Preserve valid PPTX embedded covers, explicit retry recovery and automatic failure deduplication.
- [x] Report `LIBREOFFICE_REQUIRED` to the UI; suppress repeated missing-capability errors while retaining per-asset failure status. Log expected requeued cancellations at info level and real generation failures at error level.
- [x] Test real filesystem resolution and injected converter orchestration; retain the limitation that real LibreOffice rendering is not exercised unless available.

### Task 2: Failed-job controls and menu identity

**Files:** `src/renderer/MediaJobsDialog.tsx`, `src/renderer/App.tsx`, `src/preload/bridge/library.ts`, renderer retry helper/tests, `src/renderer/ui/patterns/menu.tsx`.

- [x] Reproduce the global-failure-count/current-page mismatch and empty job-ID request. Resolve all failed-job pages before retrying; deduplicate IDs, guard library changes and empty selections, and leave protocol validation strict.
- [x] Reproduce MenuSurface missing-key warnings and lost component identity on reorder using actual React rendering; wrap each resolved menu node in a Fragment keyed by `node.id`.
- [x] Add actionable localized converter-unavailable hints for preview and task failures.
- [x] Guard the analogous AI controls against empty selections in the dialog, App and preload. Keep AI retry scoped to its existing loaded list; do not introduce a new backend API.

### Task 3: Development startup, CSP and source-request evidence

**Files:** Relevant startup code in `src/main/index.ts`, Vite renderer configuration and focused tests as justified by runtime evidence.

- [x] Investigate recovered first-mount blank behavior with an isolated development server. Keep genuine load/render failures visible, and avoid speculative timeout-only changes.
- [x] Verify a bounded development CSP with the installed Vite client; retain strict production policy and validate development startup/HMR before changing it.
- [x] Keep expected source byte-range requests functional. Remove unconditional per-request log noise and preserve opt-in timing evidence with revision/range details; do not infer a decode loop from the old log alone.

### Task 4: Integration verification and documentation

**Files:** Chinese/English media developer guides and this plan.

- [x] Document converter discovery, dependency status and recovery; distinguish expected queue preemption from errors and describe diagnostic controls.
- [x] Run focused unit/Worker tests, `npm run test:unit`, `npm run typecheck`, targeted ESLint and `npm run test:library-availability`.
- [x] Run relevant Electron menu, thumbnail-refresh and failed-job controls E2E tests; record development CSP/startup evidence separately from packaged tests.
- [x] Inspect final diff, original encoding/BOM/newlines, temporary-fixture cleanup and remaining validation limits.

## Verification results

- This run reviewed and verified the existing uncommitted repair draft, then extended it for the analogous AI empty-selection defect. Six AI bridge/button regressions failed before that extension and passed after it. Related UI/menu/protocol verification passed 9 files and 163 tests, including a 1205-ID media retry scan, nonempty forwarding and strict empty-ID protocol rejection.
- Resolver/dependency tests passed 3 files and 19 tests, including real filesystem discovery, changed configuration and removed executable handling. Worker thumbnail/manual/presentation verification passed 3 files and 114 tests; the final presentation/repair-policy pair passed 24 tests. These batches overlap and should not be summed as distinct coverage.
- Final full unit suite: 656 files, 4619 passed, 10 skipped. TypeScript checks passed. Library availability suite: 9 files, 232 passed, 1 skipped.
- Electron E2E initial integration: 12 tests passed across context menus, manual refresh and session-log regressions. After the AI safety extension, the application was rebuilt and both manual-refresh/session-log E2Es passed again. The session-log test verifies two converter-unavailable assets, one info diagnostic, actionable task hints, successful retry submission, no invalid IPC or menu-key warnings, and 33 valid HTTP 206 source-range responses without default request-log noise.
- Targeted ESLint passed with no errors; App and AssetPreviewModal each retain two pre-existing Hook dependency warnings. `git diff --check` passed. All 33 tracked modified files retained valid UTF-8, the original BOM state and original newline style.

### Development runtime evidence

The independent runtime check built the current full Main, actual application preload and Worker into an isolated fixture and launched the real React application against a separate Vite 8.1.4 server on port 29371. No source-extracted runtime or API stubs were used. The window and userData were isolated, and no library was opened/imported.

- Two launches mounted the real app shell on their first attempt. Main logged elapsed times of 2.56 s and 23.61 s; these include module loading and are not the mount-poll timeout alone.
- Active nonce CSP was present; no CSP or page errors were observed. A disposable module received a real Vite WebSocket/HMR update.
- The historical first-load blank was not reproduced. The fix adds page/resource evidence and stops retries after window closure; its original root cause remains unproven. The 20-second mount timeout was not increased.
- Source timing logging remains opt-in; request counts alone are not treated as evidence of a decode loop.

### Cleanup and limitations

- The owned development Node/Electron processes exited; port 29371 had no remaining listener, and the repository-root HMR probe was removed.
- Automatic approval review rejected deletion of the verified fixture directory `E:\Serpent\node_modules\.cache\serpent-dev-verify-20261021-1130` with `blocked by policy`. It remains as an ignored build/cache/userData fixture. No alternate deletion path was attempted.
- Real LibreOffice rendering and macOS/Linux runtime or packaged-app validation remain unverified. Missing converters are handled explicitly; the application does not acquire a renderer through these source changes.
- Documentation was synchronized in Chinese and English. Changes remain uncommitted, with existing presentation/manual-refresh work and unrelated files preserved.
