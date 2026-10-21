import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  extractPptxEmbeddedThumbnail,
  isPresentationThumbnailGenerator,
  PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES,
} from '../../src/worker/presentation-thumbnail';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function writePptx(entries: Array<{ name: string; bytes: Buffer }>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-presentation-thumbnail-'));
  temporaryRoots.push(root);
  const archive = new AdmZip();
  for (const entry of entries) archive.addFile(entry.name, entry.bytes);
  const filePath = path.join(root, 'sample.pptx');
  archive.writeZip(filePath);
  return filePath;
}

describe('extractPptxEmbeddedThumbnail', () => {
  it('reads a PNG thumbnail from the PPTX package', async () => {
    const filePath = writePptx([
      { name: 'docProps/thumbnail.png', bytes: PNG },
    ]);

    await expect(extractPptxEmbeddedThumbnail(filePath)).resolves.toEqual({
      bytes: PNG,
      mimeType: 'image/png',
      entryName: 'docProps/thumbnail.png',
    });
  });

  it('accepts case variations and prefers a valid thumbnail entry', async () => {
    const filePath = writePptx([
      { name: 'docProps/thumbnail.jpeg', bytes: Buffer.from('not-an-image') },
      { name: 'DOCProps/THUMBNAIL.PNG', bytes: PNG },
    ]);

    await expect(extractPptxEmbeddedThumbnail(filePath)).resolves.toEqual({
      bytes: PNG,
      mimeType: 'image/png',
      entryName: 'DOCProps/THUMBNAIL.PNG',
    });
  });

  it('returns null for missing, invalid, and oversized thumbnails', async () => {
    const missing = writePptx([{ name: 'ppt/slides/slide1.xml', bytes: Buffer.from('<p:sld/>') }]);
    await expect(extractPptxEmbeddedThumbnail(missing)).resolves.toBeNull();

    const invalid = writePptx([{ name: 'docProps/thumbnail.png', bytes: Buffer.from('not-an-image') }]);
    await expect(extractPptxEmbeddedThumbnail(invalid)).resolves.toBeNull();

    const oversized = writePptx([{
      name: 'docProps/thumbnail.png',
      bytes: Buffer.concat([PNG, Buffer.alloc(PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES)]),
    }]);
    await expect(extractPptxEmbeddedThumbnail(oversized)).resolves.toBeNull();
  });
});

describe('presentation thumbnail generator identity', () => {
  it('keeps embedded success/failure current and accepts historical converted caches', () => {
    expect(isPresentationThumbnailGenerator('pptx-embedded-thumbnail@1')).toBe(true);
    expect(isPresentationThumbnailGenerator('pptx-embedded-thumbnail@1;failed')).toBe(true);
    expect(isPresentationThumbnailGenerator('presentation-soffice-pdfjs@1')).toBe(true);
    expect(isPresentationThumbnailGenerator('presentation-soffice-pdfjs@1;failed')).toBe(true);
    expect(isPresentationThumbnailGenerator('pdfjs@6')).toBe(false);
  });
});
