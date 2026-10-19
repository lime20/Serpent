import { describe, expect, it } from "vitest";
import type sharpFactory from "sharp";

import { analyzeMirageTexture } from "../../src/renderer/mirage-texture";

/**
 * Real-file evidence for the mirage detector.
 *
 * The synthetic-pixel tests in `mirage-texture.test.ts` prove the heuristic;
 * this one proves the encoding survives an actual PNG encode/decode and the
 * viewer's 96px sampling budget, using the same real pictures-through-a-file
 * shape a user would import. The downscale here uses sharp instead of the
 * viewer's canvas `drawImage`, so it is a close approximation, not the exact
 * decode path.
 */

const SIZE = 512;
const SAMPLE_EDGE = 96;

// Sharp is a native dependency; its absence means this environment cannot build
// the fixture at all, so the case is skipped rather than failed.
let sharp: typeof sharpFactory | null = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  sharp = null;
}

function clamp(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Two unrelated pictures (a smooth wave field and a coarse checkerboard)
 * encoded into one RGBA frame: `alpha = 1 − (white − black)`,
 * `color = black / alpha`.
 */
function encodeMirageFrame(): Buffer {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const black = 30 + 90 * ((Math.sin(x / 23) + Math.sin(y / 17) + 2) / 4);
      const white = 150 + 90 * (((x >> 4) + (y >> 4)) % 2 === 0 ? 0.2 : 1);
      const alpha = 1 - (white - black) / 255;
      const color = black / alpha;
      const index = (y * SIZE + x) * 4;
      rgba[index] = clamp(color);
      rgba[index + 1] = clamp(color);
      rgba[index + 2] = clamp(color);
      rgba[index + 3] = clamp(alpha * 255);
    }
  }
  return rgba;
}

async function decode(
  png: Buffer,
  edge?: number,
): Promise<{ width: number; height: number; data: Buffer }> {
  const pipeline = sharp!(png);
  const resized = edge
    ? pipeline.resize(edge, edge, { fit: "inside" })
    : pipeline;
  const result = await resized.ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  return {
    width: result.info.width,
    height: result.info.height,
    data: result.data,
  };
}

describe.skipIf(!sharp)("mirage texture in a real PNG", () => {
  it("detects both encoded pictures after encode, decode and 96px sampling", async () => {
    const png = await sharp!(encodeMirageFrame(), {
      raw: { width: SIZE, height: SIZE, channels: 4 },
    })
      .png()
      .toBuffer();

    const full = await decode(png);
    const fullAnalysis = analyzeMirageTexture(full);
    expect(fullAnalysis.sampledPixels).toBe(SIZE * SIZE);
    expect(fullAnalysis.isMirage).toBe(true);
    expect(Math.abs(fullAnalysis.backdropCorrelation)).toBeLessThan(0.2);

    const sampled = await decode(png, SAMPLE_EDGE);
    const sampledAnalysis = analyzeMirageTexture(sampled);
    expect(sampledAnalysis.sampledPixels).toBeLessThanOrEqual(
      SAMPLE_EDGE * SAMPLE_EDGE,
    );
    // Downsampling must not flatten the two pictures into one.
    expect(sampledAnalysis.isMirage).toBe(true);
    expect(sampledAnalysis.revealStrength).toBeGreaterThan(0.3);
  });

  it("keeps an ordinary opaque PNG off the mirage path", async () => {
    const png = await sharp!({
      create: { width: 128, height: 128, channels: 4, background: "#3a6ea5" },
    })
      .png()
      .toBuffer();
    const analysis = analyzeMirageTexture(await decode(png));
    expect(analysis.hasAlpha).toBe(false);
    expect(analysis.isMirage).toBe(false);
  });

  it("keeps a normal transparent logo off the mirage path", async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
         <circle cx="128" cy="128" r="110" fill="#e0596b" />
         <text x="128" y="150" font-size="96" text-anchor="middle" fill="#fff">A</text>
       </svg>`,
    );
    const png = await sharp!(svg).png().toBuffer();
    const analysis = analyzeMirageTexture(await decode(png));
    expect(analysis.hasAlpha).toBe(true);
    expect(analysis.isMirage).toBe(false);
  });
});
