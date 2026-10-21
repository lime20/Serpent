import * as yauzl from 'yauzl';

/** Maximum amount of package data accepted for an embedded presentation thumb. */
export const PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;
export const PRESENTATION_EMBEDDED_THUMBNAIL_GENERATOR = 'pptx-embedded-thumbnail@1';
// Read-only compatibility for ready/terminal artifacts produced by older builds.
const LEGACY_PRESENTATION_CONVERTER_GENERATOR = 'presentation-soffice-pdfjs@1';

const PRESENTATION_THUMBNAIL_ENTRY_NAMES = new Set([
  'docprops/thumbnail.jpeg',
  'docprops/thumbnail.jpg',
  'docprops/thumbnail.png',
]);
const COMPRESSION_RATIO_MIN_SIZE = 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PptxEmbeddedThumbnail = {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  entryName: string;
};

export function isPresentationThumbnailGenerator(generatorVersion: string): boolean {
  return generatorVersion === PRESENTATION_EMBEDDED_THUMBNAIL_GENERATOR
    || generatorVersion === `${PRESENTATION_EMBEDDED_THUMBNAIL_GENERATOR};failed`
    || generatorVersion === LEGACY_PRESENTATION_CONVERTER_GENERATOR
    || generatorVersion === `${LEGACY_PRESENTATION_CONVERTER_GENERATOR};failed`;
}

function thumbnailMimeType(entryName: string): PptxEmbeddedThumbnail['mimeType'] | null {
  const extension = entryName.slice(entryName.lastIndexOf('.')).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  return null;
}

function isValidImage(bytes: Buffer, mimeType: PptxEmbeddedThumbnail['mimeType']): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function refusesInflate(entry: yauzl.Entry): boolean {
  if (entry.isEncrypted() || !entry.canDecodeFileData()) return true;
  return entry.uncompressedSize >= COMPRESSION_RATIO_MIN_SIZE
    && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > MAX_COMPRESSION_RATIO;
}

async function readBoundedEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer | null> {
  if (
    refusesInflate(entry)
    || !Number.isSafeInteger(entry.uncompressedSize)
    || entry.uncompressedSize <= 0
    || entry.uncompressedSize > PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES
  ) {
    return null;
  }

  try {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES) {
        stream.destroy();
        return null;
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } catch {
    return null;
  }
}

/**
 * Read the optional package thumbnail from a PPTX without extracting the full
 * OOXML archive. Invalid entries are skipped so a later valid representation
 * can still be used; unsupported PPT/OLE files return null.
 */
export async function extractPptxEmbeddedThumbnail(
  filePath: string,
): Promise<PptxEmbeddedThumbnail | null> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(filePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch {
    return null;
  }

  try {
    for await (const entry of zip.eachEntry()) {
      let entryName: string;
      try {
        entryName = Buffer.from(entry.fileNameRaw).toString('utf8');
      } catch {
        continue;
      }
      const normalized = entryName.replaceAll('\\', '/').toLowerCase();
      if (!PRESENTATION_THUMBNAIL_ENTRY_NAMES.has(normalized)) continue;
      const mimeType = thumbnailMimeType(entryName);
      if (!mimeType) continue;
      const bytes = await readBoundedEntry(zip, entry);
      if (bytes && isValidImage(bytes, mimeType)) {
        return { bytes, mimeType, entryName };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    zip.close();
  }
}
