# Media Format Support Guide

This guide is for developers working on Serpent itself. Adding an extension to one list only makes one entry point recognize it; a format is supported only after import, thumbnails, the viewer, filters, and related protocols are checked.

## 1. Start with the shared registry

Inspect and update `src/shared/media-formats.ts`, and `src/shared/audio-media.ts` when applicable:

- Add images to the appropriate `IMAGE_EXTENSIONS` decoder set. Do not route RAW through an ordinary image decoder by accident.
- Add video, model, and document formats to their corresponding registries.
- Treat alias extensions for the same bitstream as one format. JFIF is a JPEG bitstream, so `.jfif` uses `image/jpeg`; it is not a new image codec.
- Extension matching must be case-insensitive, and registry helpers should accept both filenames and extension strings.

After changing the registry, do not create a second hard-coded extension list in the UI or Worker.

## 2. Check every consumer

Use `rg` to search for the old extensions, MIME strings, `endsWith`, `includes`, and format dispatch points. Check each applicable path:

| Path | Main locations | What to verify |
| --- | --- | --- |
| Import recognition | `src/worker/library-service.ts`, import strategies | Discovery, indexing, rescans, deletion, and clear handling of corrupt/unsupported files |
| Format filters | `src/renderer/format-filter-presets.ts` | Generated from the shared registry; add a regression test |
| Thumbnails | Worker thumbnail/media decoders | Decoder, bounds, animation/multi-frame, and corrupt-file behavior |
| Viewer | `src/shared/preview-policy.ts`, viewer components | Source passthrough vs. full-resolution derived image; never present a thumbnail as the original |
| MIME/protocol | `src/main/index.ts`, preload, shared protocol | Correct MIME for artifacts, remote assets, and plugin context with runtime validation |
| Sequences/color | sequence and image color-space modules | Only formats with the relevant capability enter these paths |
| External ecosystems | Eagle/Billfish, plugins, remote import | Candidate extensions, URL MIME, and saved preview behavior agree |

Chromium native rendering is an optimization, not sufficient proof of product support. Formats Chromium cannot render should use bounded thumbnails and a separate full-resolution decoder path.

### Transparency and "mirage-tank" textures

Images with alpha have two viewing semantics, and every newly added image format must be checked against both:

- **Ordinary transparent images**: the viewer keeps alpha and composites semi-transparent pixels over the stage color. Thumbnail/preview derivatives must keep alpha (the Worker emits WebP when `hasAlpha` is set, otherwise JPEG); flattening alpha onto an opaque color destroys the original.
- **Mirage-tank textures**: the same PNG shows two different pictures over white and black backgrounds (encoding: `alpha = 1 − (white target − black target)`, `color = black target / alpha`). The viewer offers an **Image background** selector in the toolbar and hints to switch backgrounds when the sampled frame matches that encoding. Detection and backdrop models live in `src/renderer/mirage-texture.ts`; they only heuristically inspect downsampled frames and never affect decode correctness.

Both the source passthrough and derived-image paths must therefore preserve alpha; a lossy or alpha-less container degrades a mirage-tank texture into an ordinary image.

### Pixel-sampling prerequisites (cross-origin)

The viewer needs to read media pixels: mirage detection and the previous/next button contrast both rely on `canvas.getImageData`. `serpent://` declares `corsEnabled` in `src/main/serpent-protocol-privileges.ts`, so every media response (the common headers in `artifact-response.ts`) must carry `Access-Control-Allow-Origin`, and viewer `<img>` elements must use `crossOrigin="anonymous"`. If either is missing, the canvas is cross-origin tainted and sampling silently returns nothing — the detection hint never appears and contrast stays at its default rather than raising an error. Keep both conditions in place when adding media response paths.

### Thumbnail storage and loading

Thumbnails use a cache first and are generated asynchronously when missing. Displaying a card does not decode the source file every time:

- The `revision_artifacts` database table indexes artifact paths, status, generator versions, dimensions, and related metadata. Image bytes live under the library's `.serpent/artifacts` directory, rather than as image BLOBs in the database.
- Lookup follows the asset's `current_revision_id` and selects a current artifact that has not been invalidated. A usable `ready` artifact is read from disk; scrolling or reopening a library normally reuses that cache.
- Missing or invalidated thumbnails enter the Worker's background queue, with visible assets prioritized. The result is recorded and `asset.thumbnail.ready` updates the card. Successful enqueueing means the task was submitted, not that image generation has finished.
- A source revision change, an applicable generator version change, or a manual refresh can require regeneration. Automatic work preserves valid Eagle/Billfish imported covers rather than replacing them merely because their generator differs from the built-in one.

Some ordinary small images use their source directly as the card image, so automatic work does not need a separate thumbnail. `isSourceDirectPreview` in `src/shared/preview-policy.ts` owns this optimization: JPEG-family formats, PNG, WebP, AVIF, or GIF; a positive size no greater than 2 MiB; known positive integer dimensions; a longest edge no greater than 2048 pixels; and no more than 2,000,000 pixels in total. Larger images remain valid assets and use the thumbnail generation path.

### Manually refreshing thumbnails

Choose **Refresh thumbnail** in an asset's context menu to regenerate the cover for one or more images, documents, models, fonts, or PPT/PPTX files, including selections across pages. The action operates on available, undeleted, non-ignored assets that support refresh in the current writable library. Execution reads fresh summaries for the selected assets and skips unsupported or unavailable ones. The menu count includes candidates whose summaries have not loaded yet; result feedback counts the targets actually submitted successfully and reports partial request failures. Video and audio do not expose this action because their existing retry interface requests playback proxies.

The action reuses `retryArtifact({ kind: 'thumbnail' })` to submit or promote a durable task for the current revision at elevated priority. If generation or imported-cover normalization is already running for that revision, refresh joins that task without invalidating its cover or changing its claimed processing intent. Otherwise, refresh invalidates the current thumbnail and requests generation from the source; queued or paused imported-cover normalization is also promoted to an explicit source refresh. Explicit image refresh tasks bypass the automatic source-direct skip and create a separate thumbnail. Source files are unchanged; failures and cancellation follow the relevant generator's existing handling, and generation continues in the background.

Refreshing PPTX only extracts its embedded cover again. It cannot correct stale `docProps/thumbnail.*` content or render the actual first slide. A missing usable embedded cover fails directly, so repeated refreshes cannot create one. PPT has no source-cover decoder; an explicit refresh of an imported cover may therefore be unable to rebuild it from the source.

## 3. Implementation order

1. Decide whether the addition is a codec, container, or alias extension; record MIME, decoder, and fallback semantics.
2. Update the shared registry and its pure-function tests.
3. Correct import, Worker decoding, preview policy, filters, main-process protocol, and plugin/remote entry points one by one.
4. For animation, multi-frame, RAW, HDR, or 3D, define viewer semantics first: playback, first frame, frame controls, color space, missing materials, and so on.
5. Update this developer documentation and the human acceptance checklist. “The backend library can theoretically read it” is not evidence of support.

`.blend` is not in the product format table: there is no reliable public mesh parser for Blender 3–4.x, and Serpent does not bundle Blender. Files can still be imported and show as an unknown type. Export glTF or FBX from Blender when a 3D preview is needed. FBX / OBJ / glTF / GLB / STL still use the WebGL viewer.

### PPT/PPTX cover thumbnails

`.ppt` / `.pptx` currently support cover thumbnails only. They remain `other` assets and are not added to `DOCUMENT_EXTENSIONS`; source files do not enter the HTML/PDF viewer, while an available cover can be viewed as an image. The format filter offers PPT/PPTX options, which does not imply full presentation viewing support.

- PPTX only reads `docProps/thumbnail.jpeg`, `docProps/thumbnail.jpg`, or `docProps/thumbnail.png`, normalizes it with Sharp, and stores an ordinary `thumbnail` artifact with generator `pptx-embedded-thumbnail@1`. The embedded cover can be missing or stale and is not guaranteed to match the current first slide. Arbitrary pictures under `ppt/media` are not used as a complete cover.
- Missing, corrupt, oversized, or undecodable embedded covers fail directly without starting a converter process. PPT has no new binary source-cover decoder and uses the same failure policy. This path needs no LibreOffice, external renderer, installation, or environment-variable configuration. Ordinary PDF files retain their separate PDF.js thumbnail path.
- The job and artifact record the permanent terminal code `PRESENTATION_THUMBNAIL_UNAVAILABLE` with failed generator `pptx-embedded-thumbnail@1;failed`. The UI explains that the file has no usable embedded cover. Background refill, reopening, and automatic failed-artifact repair do not repeatedly attempt the work. Cancellation does not write this terminal failure. Memory pressure and disk/database write errors retain their existing classification rather than becoming missing-cover failures. Explicit refresh or a manual retry in the task panel retries extraction, and a source revision change can require new generation; neither selects another rendering method.
- Automatic work preserves valid Eagle/Billfish covers and existing usable caches, including `ready` covers from the old converter path. Removing the converter does not purge them. Historical `presentation-soffice-pdfjs@1` / `LIBREOFFICE_REQUIRED` values remain readable only for compatibility and never trigger conversion or installation hints. Explicit manual refresh can invalidate and replace a cover, subject to the coalescing rule above for generation or normalization already running on the current revision.

Acceptance should cover valid, missing, corrupt, oversized, and Sharp-undecodable embedded covers; no external process on failure; direct failure for PPT; cancellation; explicit retry; no repeated background work after failure; and preservation of original/normalized Eagle/Billfish covers and old `ready` caches. Record packaged-app verification separately for Windows/macOS/Linux. This path does not render the actual first slide.

### Diagnostics and task controls

- A presentation with no usable embedded cover retains a per-asset `PRESENTATION_THUMBNAIL_UNAVAILABLE` failure record. Diagnostics no longer discover or suggest installing an external converter.
- Expected cancellation that yields resources to interactive work and returns a job to the queue is logged at info level. Normal Worker shutdown with `code: 0` is also informational.
- Source requests are not logged individually by default. Start with `SERPENT_VIEWER_TIMING_LOG=1` to inspect revision, HTTP method, Range and response timing for byte-range media reads. Request counts alone do not establish a generation loop.
- **Background Tasks → Retry failed** fetches every current-library media-task page, collects and deduplicates failed IDs, then submits the retry. It does not depend on the loaded UI page or send empty `jobIds`; the protocol still requires at least one ID. AI retry retains its loaded-list scope: the button is disabled when that list has no failures, and App/preload also prevent empty selections from reaching IPC.
- The development server retains CSP, using a random nonce for Vite/React scripts and permitting the required blob Worker; production policy remains intact. Mount timeouts capture page/resource diagnostics, and window closure stops retries. The original 20-second blank mount has not been reproduced; isolated cold-cache startup and HMR passed, which does not establish that the original cause is fixed.

## 4. Test matrix

Prepare fixtures in temporary directories; never commit personal absolute paths or real user data. Cover:

- valid content, upper/mixed-case extensions, non-ASCII paths, and long filenames;
- corrupt/truncated files and extension/content mismatches;
- format-specific capabilities such as transparency, animation, multiple frames, RAW, or HDR when applicable;
- decoded thumbnails and viewer originals; images must satisfy `complete && naturalWidth > 0`, and videos must expose metadata and non-zero dimensions;
- search and format filters, rescan, delete/restore, remote import, and plugin entry points when applicable;
- packaged apps on macOS and Windows; missing platform evidence must be recorded as “not verified”.

Minimum checks:

```bash
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit/<relevant-test>.test.ts
npm run test:unit
```

Any change to library opening, import, Worker, schema, or media storage paths must also run:

```bash
npm run test:library-availability
```

Changes crossing Renderer/preload/Main/Worker or custom media protocols require the relevant Electron E2E. After every test run, remove only temporary databases, media, screenshots, and exports created by that run and known to be safe to remove.

## 5. Definition of done

Record four columns in the development log and acceptance checklist: requirement, implementation location (`file:line`), automated test (`test:line`), and human/platform evidence. If any column is missing, report “partially complete” or “not verified”.

Related research: [Media format support research](research-media-format-support.md).
