/**
 * "Mirage tank" (幻影坦克) texture support for the image viewer.
 *
 * A mirage-tank PNG stores two pictures in one file. The encoder picks, per
 * pixel, `alpha = 1 - (whiteTarget - blackTarget)` and
 * `color = blackTarget / alpha`, so compositing the same bytes over a white
 * backdrop renders the first picture and compositing them over black renders a
 * second, unrelated picture. Chromium already composites `<img>` alpha
 * correctly — the viewer only has to place a *known* matte behind the bitmap.
 *
 * This module owns the pure halves of that feature:
 * - `analyzeMirageTexture` classifies sampled pixels so the viewer can tell a
 *   mirage texture apart from an ordinary transparent asset and hint the user,
 * - `viewerImageBackdropClass` maps the chosen matte to the class that paints
 *   it (`styles.css`), keeping the DOM free of hardcoded colors.
 *
 * Detection is a heuristic over a downsampled frame, never a decode of the
 * original. It only drives an affordance: a false negative costs a hint, and a
 * false positive costs a hidden-backdrop suggestion the user can ignore.
 */

/** Backdrops painted behind a viewer image. `auto` keeps the stage as-is. */
export const VIEWER_IMAGE_BACKDROPS = [
  "auto",
  "black",
  "white",
  "gray",
  "checkerboard",
] as const;

export type ViewerImageBackdrop = (typeof VIEWER_IMAGE_BACKDROPS)[number];

export function isViewerImageBackdrop(
  value: unknown,
): value is ViewerImageBackdrop {
  return (
    typeof value === "string" &&
    (VIEWER_IMAGE_BACKDROPS as readonly string[]).includes(value)
  );
}

/**
 * Class for the matte painted on the image box. `null` for `auto`: partial-alpha
 * pixels keep compositing over the stage exactly as they did before this
 * feature existed.
 */
export function viewerImageBackdropClass(
  backdrop: ViewerImageBackdrop,
): string | null {
  return backdrop === "auto" ? null : `is-backdrop-${backdrop}`;
}

/**
 * The backdrop that reveals the *other* encoded picture. Everything except
 * white flips to white, so the first press always swaps the visible picture.
 */
export function mirageRevealBackdrop(
  current: ViewerImageBackdrop,
): ViewerImageBackdrop {
  return current === "white" ? "black" : "white";
}

/** Image containers that can store an alpha channel. */
const ALPHA_CAPABLE_EXTENSIONS = [
  ".png",
  ".webp",
  ".avif",
  ".gif",
  ".tif",
  ".tiff",
  ".ico",
  ".psd",
  ".exr",
  ".tga",
  ".svg",
] as const;

const ALPHA_CAPABLE_MIME_TYPES = [
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/tiff",
  "image/x-icon",
  "image/vnd.adobe.photoshop",
  "image/x-exr",
  "image/x-tga",
  "image/svg+xml",
] as const;

/**
 * Whether the *format* can carry alpha, independent of the pixels in this file.
 *
 * Accepts a MIME type or a filename. Used as a fallback when the viewer cannot
 * sample pixels at all (a tainted canvas, a format Chromium serves as an opaque
 * document), so the matte selector never disappears entirely just because the
 * detector could not run.
 */
export function imageFormatMayCarryAlpha(
  mimeOrFilename: string | null | undefined,
): boolean {
  if (!mimeOrFilename) return false;
  const normalized = mimeOrFilename.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("/")) {
    return (ALPHA_CAPABLE_MIME_TYPES as readonly string[]).includes(
      normalized.split(";")[0]?.trim() ?? normalized,
    );
  }
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot < 0) return false;
  return (ALPHA_CAPABLE_EXTENSIONS as readonly string[]).includes(
    normalized.slice(lastDot),
  );
}

/** Long edge of the frame the detector samples, in pixels. */
export const MIRAGE_DETECTION_SAMPLE_EDGE = 96;

/** Alpha at or below this counts as fully transparent. */
const TRANSPARENT_ALPHA = 16;
/** Alpha at or above this counts as fully opaque. */
const OPAQUE_ALPHA = 239;
/**
 * A mirage encoding rewrites most of the frame into partial alpha. Ordinary
 * transparent assets (logos, cut-outs, soft masks) keep partial alpha on their
 * edges only, well below this share.
 */
const MIN_PARTIAL_ALPHA_COVERAGE = 0.2;
/** The encoding spans the frame, so at least half of it must be non-opaque. */
const MIN_ALPHA_COVERAGE = 0.5;
/** Minimum luminance spread on a backdrop before we call it a picture. */
const MIN_STRUCTURE = 0.05;
/** Pearson ceiling between the two composites; higher means the same picture. */
const MAX_BACKDROP_CORRELATION = 0.5;
/** Luminance spread at which the structure factor of the score saturates. */
const STRUCTURE_FULL_SCORE = 0.12;
/** Alpha coverage above which the asset is treated as alpha-bearing at all. */
const HAS_ALPHA_COVERAGE = 0.005;

/** Minimal structural view of decoded RGBA pixels (DOM-free for tests). */
export interface MirageRgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, four per pixel, row-major (`ImageData`, `Buffer`, array…). */
  readonly data: ArrayLike<number>;
}

export interface MirageTextureAnalysis {
  readonly sampledPixels: number;
  /** Pixels that are not fully opaque (any alpha < 240), 0..1. */
  readonly alphaCoverage: number;
  /** Pixels whose alpha sits between transparent and opaque, 0..1. */
  readonly partialAlphaCoverage: number;
  /** Mean per-pixel separation of the white and black composites, 0..1. */
  readonly revealStrength: number;
  /** Luminance spread of the strongest composite, 0..1. */
  readonly structure: number;
  /**
   * Pearson correlation of the black- and white-backdrop luminance, -1..1.
   * A single picture over varying opacity stays near 1; two unrelated pictures
   * are near 0. Degenerate frames report 1 (no second picture to find).
   */
  readonly backdropCorrelation: number;
  /** Soft 0..1 confidence used for diagnostics, not for gating the UI. */
  readonly score: number;
  /** Whether the sampled frame carries any transparency at all. */
  readonly hasAlpha: boolean;
  /** Whether the frame looks like a mirage-tank encoding. */
  readonly isMirage: boolean;
}

function emptyAnalysis(sampledPixels = 0): MirageTextureAnalysis {
  return {
    sampledPixels,
    alphaCoverage: 0,
    partialAlphaCoverage: 0,
    revealStrength: 0,
    structure: 0,
    backdropCorrelation: 1,
    score: 0,
    hasAlpha: false,
    isMirage: false,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Encoded (sRGB) luma in 0..1, Rec. 709 weights over the stored channel values.
 *
 * Compositing happens on encoded channel values, so
 * `out = color × alpha + backdrop × (1 − alpha)` holds exactly for this metric
 * (the weights sum to 1). Linearizing the channels first — WCAG relative
 * luminance — would bend the very difference the detector measures and make two
 * unrelated pictures look correlated.
 */
function encodedLuma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Classify sampled RGBA pixels. Only `width`, `height` and `data` are read, so
 * unit tests can pass a plain object instead of a real `ImageData`.
 */
export function analyzeMirageTexture(
  image: MirageRgbaImage | null | undefined,
): MirageTextureAnalysis {
  if (!image || image.width <= 0 || image.height <= 0) return emptyAnalysis();
  const pixelCount = Math.floor(image.width) * Math.floor(image.height);
  const data = image.data;
  if (pixelCount <= 0 || data.length < pixelCount * 4) return emptyAnalysis();

  let participants = 0;
  let partialAlphaPixels = 0;
  let nonOpaquePixels = 0;
  let sumAlpha = 0;
  let sumBlack = 0;
  let sumBlackSquares = 0;
  let sumWhite = 0;
  let sumWhiteSquares = 0;
  let sumCross = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const index = pixel * 4;
    const alphaByte = data[index + 3] ?? 0;
    if (alphaByte <= OPAQUE_ALPHA) nonOpaquePixels += 1;
    if (alphaByte < TRANSPARENT_ALPHA) continue;
    const alpha = alphaByte / 255;
    participants += 1;
    if (alphaByte <= OPAQUE_ALPHA) partialAlphaPixels += 1;
    sumAlpha += alpha;

    const luminance = encodedLuma(
      data[index] ?? 0,
      data[index + 1] ?? 0,
      data[index + 2] ?? 0,
    );
    // Composite luminance over black (`color × alpha`) and over white
    // (`+ 1 - alpha`). Their difference is exactly the reveal strength.
    const black = luminance * alpha;
    const white = black + (1 - alpha);
    sumBlack += black;
    sumBlackSquares += black * black;
    sumWhite += white;
    sumWhiteSquares += white * white;
    sumCross += black * white;
  }

  if (participants === 0) return emptyAnalysis(pixelCount);

  const meanBlack = sumBlack / participants;
  const meanWhite = sumWhite / participants;
  const varianceBlack = Math.max(
    0,
    sumBlackSquares / participants - meanBlack * meanBlack,
  );
  const varianceWhite = Math.max(
    0,
    sumWhiteSquares / participants - meanWhite * meanWhite,
  );
  const covariance = sumCross / participants - meanBlack * meanWhite;
  const deviationProduct = Math.sqrt(varianceBlack * varianceWhite);
  const backdropCorrelation =
    deviationProduct > 1e-9
      ? Math.min(1, Math.max(-1, covariance / deviationProduct))
      : 1;

  const alphaCoverage = nonOpaquePixels / pixelCount;
  const partialAlphaCoverage = partialAlphaPixels / pixelCount;
  const revealStrength = 1 - sumAlpha / participants;
  const structure = Math.max(
    Math.sqrt(varianceBlack),
    Math.sqrt(varianceWhite),
  );
  const score =
    clamp01(partialAlphaCoverage) *
    clamp01(structure / STRUCTURE_FULL_SCORE) *
    clamp01((1 - backdropCorrelation) / 2);

  return {
    sampledPixels: pixelCount,
    alphaCoverage,
    partialAlphaCoverage,
    revealStrength,
    structure,
    backdropCorrelation,
    score,
    hasAlpha: alphaCoverage > HAS_ALPHA_COVERAGE,
    isMirage:
      alphaCoverage >= MIN_ALPHA_COVERAGE &&
      partialAlphaCoverage >= MIN_PARTIAL_ALPHA_COVERAGE &&
      structure >= MIN_STRUCTURE &&
      backdropCorrelation <= MAX_BACKDROP_CORRELATION,
  };
}
