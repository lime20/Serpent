import { describe, expect, it } from "vitest";

import {
  analyzeMirageTexture,
  imageFormatMayCarryAlpha,
  isViewerImageBackdrop,
  mirageRevealBackdrop,
  MIRAGE_DETECTION_SAMPLE_EDGE,
  VIEWER_IMAGE_BACKDROPS,
  viewerImageBackdropClass,
  type MirageRgbaImage,
} from "../../src/renderer/mirage-texture";

const SIZE = 24;

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function imageFrom(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): MirageRgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = clampChannel(r);
      data[index + 1] = clampChannel(g);
      data[index + 2] = clampChannel(b);
      data[index + 3] = clampChannel(a);
    }
  }
  return { width, height, data };
}

/**
 * Real mirage-tank encoding: `alpha = 1 − (white − black)` and
 * `color = black / alpha`, so the file renders `blackTarget` over a black
 * backdrop and `whiteTarget` over a white one.
 */
function encodeMirage(
  width: number,
  height: number,
  blackTarget: (x: number, y: number) => number,
  whiteTarget: (x: number, y: number) => number,
): MirageRgbaImage {
  return imageFrom(width, height, (x, y) => {
    const black = Math.min(255, Math.max(0, blackTarget(x, y)));
    const white = Math.min(255, Math.max(0, whiteTarget(x, y)));
    const alpha = 1 - (white - black) / 255;
    if (alpha <= 0.01) return [black, black, black, 255];
    const color = black / alpha;
    return [color, color, color, alpha * 255];
  });
}

function deterministicNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

describe("analyzeMirageTexture", () => {
  it("reports no alpha for an opaque frame", () => {
    const opaque = imageFrom(SIZE, SIZE, (x, y) => [
      (x * 11) % 256,
      (y * 7) % 256,
      128,
      255,
    ]);
    const analysis = analyzeMirageTexture(opaque);
    expect(analysis.hasAlpha).toBe(false);
    expect(analysis.isMirage).toBe(false);
    expect(analysis.alphaCoverage).toBe(0);
    expect(analysis.score).toBe(0);
  });

  it("ignores ordinary transparent assets whose partial alpha is only edges", () => {
    // A 60%-area opaque logo on a transparent canvas: partial alpha covers the
    // antialiased rim only, not the frame.
    const logo = imageFrom(SIZE, SIZE, (x, y) => {
      const inside = x > 4 && x < 20 && y > 4 && y < 20;
      const edge = x === 4 || x === 20 || y === 4 || y === 20;
      if (inside) return [220, 60, 60, 255];
      if (edge) return [220, 60, 60, 128];
      return [0, 0, 0, 0];
    });
    const analysis = analyzeMirageTexture(logo);
    expect(analysis.hasAlpha).toBe(true);
    expect(analysis.isMirage).toBe(false);
    expect(analysis.partialAlphaCoverage).toBeLessThan(0.2);
  });

  it("rejects a flat half-transparent fill with no picture in it", () => {
    const flat = imageFrom(SIZE, SIZE, () => [128, 128, 128, 128]);
    const analysis = analyzeMirageTexture(flat);
    expect(analysis.hasAlpha).toBe(true);
    expect(analysis.partialAlphaCoverage).toBeGreaterThan(0.9);
    expect(analysis.structure).toBeLessThan(0.05);
    expect(analysis.isMirage).toBe(false);
  });

  it("rejects a single picture composited at constant partial alpha", () => {
    // One picture at 50% opacity: the white backdrop just adds a constant 0.5,
    // so both backdrops show the same picture (correlation ≈ 1).
    const picture = (x: number, y: number) => 20 + ((x * 9 + y * 5) % 100);
    const fade = encodeMirage(
      SIZE,
      SIZE,
      (x, y) => picture(x, y),
      (x, y) => picture(x, y) + 127.5,
    );
    const analysis = analyzeMirageTexture(fade);
    expect(analysis.partialAlphaCoverage).toBeGreaterThan(0.9);
    expect(analysis.backdropCorrelation).toBeGreaterThan(0.95);
    expect(analysis.isMirage).toBe(false);
  });

  it("detects two unrelated pictures encoded into one frame", () => {
    const noise = deterministicNoise(7);
    const blackPicture = Array.from({ length: SIZE * SIZE }, () => noise());
    const whitePicture = Array.from({ length: SIZE * SIZE }, () => noise());
    const mirage = encodeMirage(
      SIZE,
      SIZE,
      (x, y) => 30 + blackPicture[y * SIZE + x]! * 90,
      (x, y) => 160 + whitePicture[y * SIZE + x]! * 80,
    );
    const analysis = analyzeMirageTexture(mirage);
    expect(analysis.partialAlphaCoverage).toBeGreaterThan(0.9);
    expect(analysis.alphaCoverage).toBeGreaterThan(0.99);
    expect(analysis.structure).toBeGreaterThan(0.05);
    expect(Math.abs(analysis.backdropCorrelation)).toBeLessThan(0.2);
    expect(analysis.isMirage).toBe(true);
    expect(analysis.score).toBeGreaterThan(0.3);
    expect(analysis.revealStrength).toBeGreaterThan(0.3);
  });

  it("detects an anti-correlated pair (dark picture over black, bright over white)", () => {
    const mirage = encodeMirage(
      SIZE,
      SIZE,
      (x, y) => 40 + ((x + y) % 2) * 60,
      (x, y) => 200 - ((x + y) % 2) * 60,
    );
    const analysis = analyzeMirageTexture(mirage);
    expect(analysis.backdropCorrelation).toBeLessThan(0);
    expect(analysis.isMirage).toBe(true);
  });

  it("returns an empty analysis for missing or malformed pixels", () => {
    expect(analyzeMirageTexture(null).isMirage).toBe(false);
    expect(analyzeMirageTexture(undefined).hasAlpha).toBe(false);
    expect(analyzeMirageTexture({ width: 0, height: 10, data: [] }).sampledPixels).toBe(0);
    expect(
      analyzeMirageTexture({ width: 4, height: 4, data: new Uint8ClampedArray(8) })
        .sampledPixels,
    ).toBe(0);
  });

  it("samples the viewer at a bounded resolution", () => {
    expect(MIRAGE_DETECTION_SAMPLE_EDGE).toBeGreaterThan(0);
    expect(MIRAGE_DETECTION_SAMPLE_EDGE).toBeLessThanOrEqual(128);
  });
});

describe("viewer image backdrops", () => {
  it("matches the class contract for every backdrop", () => {
    expect(VIEWER_IMAGE_BACKDROPS).toEqual([
      "auto",
      "black",
      "white",
      "gray",
      "checkerboard",
    ]);
    expect(viewerImageBackdropClass("auto")).toBeNull();
    expect(viewerImageBackdropClass("black")).toBe("is-backdrop-black");
    expect(viewerImageBackdropClass("white")).toBe("is-backdrop-white");
    expect(viewerImageBackdropClass("gray")).toBe("is-backdrop-gray");
    expect(viewerImageBackdropClass("checkerboard")).toBe(
      "is-backdrop-checkerboard",
    );
  });

  it("validates stored backdrop values", () => {
    expect(isViewerImageBackdrop("checkerboard")).toBe(true);
    expect(isViewerImageBackdrop("auto")).toBe(true);
    expect(isViewerImageBackdrop("purple")).toBe(false);
    expect(isViewerImageBackdrop(null)).toBe(false);
    expect(isViewerImageBackdrop(7)).toBe(false);
  });

  it("flips to the other encoded picture", () => {
    expect(mirageRevealBackdrop("auto")).toBe("white");
    expect(mirageRevealBackdrop("black")).toBe("white");
    expect(mirageRevealBackdrop("checkerboard")).toBe("white");
    expect(mirageRevealBackdrop("white")).toBe("black");
  });
});

describe("imageFormatMayCarryAlpha", () => {
  it("accepts MIME types and filenames of alpha-capable containers", () => {
    expect(imageFormatMayCarryAlpha("image/png")).toBe(true);
    expect(imageFormatMayCarryAlpha("image/webp")).toBe(true);
    expect(imageFormatMayCarryAlpha("image/avif")).toBe(true);
    expect(imageFormatMayCarryAlpha("image/svg+xml")).toBe(true);
    expect(imageFormatMayCarryAlpha("texture.PNG")).toBe(true);
    expect(imageFormatMayCarryAlpha("sticker.WebP")).toBe(true);
    expect(imageFormatMayCarryAlpha("scan.tiff")).toBe(true);
    expect(imageFormatMayCarryAlpha("icon.ico")).toBe(true);
  });

  it("rejects formats that cannot store alpha", () => {
    expect(imageFormatMayCarryAlpha("image/jpeg")).toBe(false);
    expect(imageFormatMayCarryAlpha("photo.jpg")).toBe(false);
    expect(imageFormatMayCarryAlpha("photo.jpeg")).toBe(false);
    expect(imageFormatMayCarryAlpha("scan.bmp")).toBe(false);
    expect(imageFormatMayCarryAlpha("notes.txt")).toBe(false);
    expect(imageFormatMayCarryAlpha("no-extension")).toBe(false);
    expect(imageFormatMayCarryAlpha("")).toBe(false);
    expect(imageFormatMayCarryAlpha(null)).toBe(false);
    expect(imageFormatMayCarryAlpha(undefined)).toBe(false);
  });
});
