import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LibraryService, type LibraryServiceDiagnostic, type LibraryServiceOptions, type SharpModule } from '../../src/worker/library-service';
import { IMPORTED_THUMBNAIL_GENERATOR_PREFIX } from '../../src/worker/imported-thumbnail-policy';
import { PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES } from '../../src/worker/presentation-thumbnail';
import { importNoConflict } from './import-no-conflict';

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];
const TestDatabase = BetterSqlite3 as new (filename: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): void;
  };
  close(): void;
};
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);
const CORRUPT_PNG = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.from('broken image payload')]);
const PDF_BYTES = singlePagePdf();

function singlePagePdf(): Buffer {
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<<>>>>endobj\n',
    '4 0 obj<</Length 4>>stream\nq\nQ\nendstream endobj\n',
  ];
  let document = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(document, 'latin1'));
    document += object;
  }
  const xrefOffset = Buffer.byteLength(document, 'latin1');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'latin1');
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-presentation-regression-'));
  temporaryRoots.push(root);
  return root;
}

function newService(options: LibraryServiceOptions = {}): LibraryService {
  // An executable legacy override must have no effect on the embedded-only path.
  vi.stubEnv('SERPENT_LIBREOFFICE_PATH', process.execPath);
  const service = new LibraryService({ observerFactory: () => ({ close() {} }), ...options });
  services.push(service);
  return service;
}

function createPresentation(service: LibraryService, root: string, extension: 'ppt' | 'pptx' = 'ppt', embedded?: Buffer) {
  const library = service.createLibrary({ displayName: 'Presentation', selectedParentPath: root });
  const sourcePath = path.join(root, `cover.${extension}`);
  if (extension === 'pptx') {
    const archive = new AdmZip();
    archive.addFile(embedded ? 'docProps/thumbnail.png' : 'ppt/presentation.xml', embedded ?? Buffer.from('<presentation/>'));
    archive.writeZip(sourcePath);
  } else {
    writeFileSync(sourcePath, Buffer.from('legacy presentation fixture'));
  }
  importNoConflict(service, library.libraryId, sourcePath);
  const asset = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!;
  return { library, asset };
}

function currentThumbnailRows(libraryPath: string, revisionId: string) {
  const db = new TestDatabase(path.join(libraryPath, '.serpent', 'library.db'));
  try {
    return db.prepare(
      "SELECT status, error_code, generator_version FROM revision_artifacts WHERE revision_id = ? AND kind = 'thumbnail' AND invalidated_at IS NULL",
    ).all(revisionId) as Array<{ status: string; error_code: string | null; generator_version: string }>;
  } finally {
    db.close();
  }
}

function writeImportedLibrary(root: string, source: 'eagle' | 'billfish', extension: 'ppt' | 'pptx'): string {
  const sourceRootPath = path.join(root, source === 'eagle' ? 'Source.library' : 'Source Billfish');
  if (source === 'eagle') {
    const infoPath = path.join(sourceRootPath, 'images', 'cover.info');
    mkdirSync(infoPath, { recursive: true });
    writeFileSync(path.join(sourceRootPath, 'metadata.json'), JSON.stringify({ folders: [] }));
    writeFileSync(path.join(infoPath, 'metadata.json'), JSON.stringify({ id: 'cover', name: 'cover', ext: extension, width: 1, height: 1 }));
    writeFileSync(path.join(infoPath, `cover.${extension}`), Buffer.from('presentation fixture'));
    writeFileSync(path.join(infoPath, 'cover_thumbnail.png'), PNG_BYTES);
  } else {
    mkdirSync(path.join(sourceRootPath, '.bf'), { recursive: true });
    mkdirSync(path.join(sourceRootPath, 'References'), { recursive: true });
    writeFileSync(path.join(sourceRootPath, 'References', `cover.${extension}`), Buffer.from('presentation fixture'));
    writeFileSync(path.join(sourceRootPath, '.bf', 'cover-thumb.png'), PNG_BYTES);
    const db = new TestDatabase(path.join(sourceRootPath, '.bf', 'billfish.db'));
    try {
      db.exec('CREATE TABLE assets (path TEXT NOT NULL, thumbnail TEXT)');
      db.prepare('INSERT INTO assets (path, thumbnail) VALUES (?, ?)')
        .run(`References/cover.${extension}`, '.bf/cover-thumb.png');
    } finally {
      db.close();
    }
  }
  return sourceRootPath;
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

describe('presentation thumbnail failure lifecycle', () => {
  it.each([
    ['legacy PPT', 'ppt', undefined],
    ['missing cover', 'pptx', undefined],
    ['invalid signature', 'pptx', Buffer.from('not an image')],
    ['oversized cover', 'pptx', Buffer.concat([PNG_BYTES, Buffer.alloc(PRESENTATION_EMBEDDED_THUMBNAIL_MAX_BYTES)])],
    ['undecodable signed cover', 'pptx', CORRUPT_PNG],
  ] as const)('fails %s directly without spawning and keeps the failure terminal', async (_label, extension, embedded) => {
    let processCalls = 0;
    const diagnostics: LibraryServiceDiagnostic[] = [];
    const service = newService({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      spawnFn: async () => {
        processCalls += 1;
        throw new Error('Presentation thumbnails must never launch a process');
      },
    });
    const { library, asset } = createPresentation(service, temporaryRoot(), extension, embedded);
    expect(service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId], skipStaleRepair: true })).toBe(1);
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'] });
    const expectedFailure = {
      status: 'failed', error_code: 'PRESENTATION_THUMBNAIL_UNAVAILABLE', generator_version: 'pptx-embedded-thumbnail@1;failed',
    };
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([expectedFailure]);
    expect(service.getPreviewArtifact(library.libraryId, asset.assetId)).toMatchObject({
      status: 'failed', errorCode: 'PRESENTATION_THUMBNAIL_UNAVAILABLE',
    });
    expect(service.listMediaJobs(library.libraryId).jobs.find((job) => job.kind === 'generate_thumbnail'))
      .toMatchObject({ status: 'failed', errorCode: 'PRESENTATION_THUMBNAIL_UNAVAILABLE', errorDetail: expect.stringContaining('embedded cover') });
    expect(service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId] })).toBe(0);
    const db = new TestDatabase(path.join(library.libraryPath, '.serpent', 'library.db'));
    try {
      db.prepare("UPDATE revision_artifacts SET generated_at = ? WHERE revision_id = ? AND kind = 'thumbnail'")
        .run(new Date(Date.now() - 86_400_000).toISOString(), asset.currentRevisionId);
    } finally {
      db.close();
    }
    expect(service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId], retryFailed: true })).toBe(0);
    expect(service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' })).toBeTruthy();
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'] });
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([expectedFailure]);
    expect(processCalls).toBe(0);
    expect(diagnostics.filter((diagnostic) => diagnostic.scope === 'media-job.failed')).toEqual([]);
  });

  it('retains historical terminal failures without automatically retrying a removed converter', async () => {
    const service = newService();
    const { library, asset } = createPresentation(service, temporaryRoot());
    const db = new TestDatabase(path.join(library.libraryPath, '.serpent', 'library.db'));
    try {
      db.prepare(`INSERT INTO revision_artifacts
        (artifact_id, revision_id, kind, mime_type, byte_size, file_path, generator_version, status, error_code, generated_at)
        VALUES ('legacy', ?, 'thumbnail', 'image/png', 0, 'legacy.png', 'presentation-soffice-pdfjs@1;failed', 'failed', 'LIBREOFFICE_REQUIRED', ?)`)
        .run(asset.currentRevisionId, new Date(Date.now() - 86_400_000).toISOString());
    } finally {
      db.close();
    }
    expect(service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId], retryFailed: true })).toBe(0);
    expect(service.getPreviewArtifact(library.libraryId, asset.assetId)).toMatchObject({ status: 'failed', errorCode: 'LIBREOFFICE_REQUIRED' });
    expect(service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' })).toBeTruthy();
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'] });
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([
      expect.objectContaining({ error_code: 'PRESENTATION_THUMBNAIL_UNAVAILABLE', generator_version: 'pptx-embedded-thumbnail@1;failed' }),
    ]);
  });
});

describe('imported presentation covers', () => {
  for (const source of ['eagle', 'billfish'] as const) {
    for (const extension of ['ppt', 'pptx'] as const) {
      it.each([false, true])(`preserves the ${source} ${extension} cover after enqueue (normalized=%s)`, async (normalized) => {
        let processCalls = 0;
        const service = newService({ spawnFn: async () => { processCalls += 1; throw new Error('unexpected process'); } });
        const root = temporaryRoot();
        const library = service.createLibrary({ displayName: 'Imported', selectedParentPath: root });
        const sourceRootPath = writeImportedLibrary(root, source, extension);
        const result = source === 'eagle'
          ? await service.importEagleLibrary({ libraryId: library.libraryId, sourceRootPath })
          : await service.importBillfishLibrary({ libraryId: library.libraryId, sourceRootPath });
        expect(result.importedCount).toBe(1);
        const asset = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!;
        if (normalized) {
          await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'] });
        }
        const before = service.getCurrentArtifact(library.libraryId, asset.assetId, 'thumbnail')!;
        expect(before).toMatchObject({ status: 'ready' });
        expect(before.generatorVersion).toContain(normalized ? IMPORTED_THUMBNAIL_GENERATOR_PREFIX : `${source}-thumbnail@1`);
        const artifactPath = service.getArtifactAbsolutePath(library.libraryId, before.artifactId, 'preview');
        const bytesBefore = readFileSync(artifactPath);

        service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId] });

        expect(service.getCurrentArtifact(library.libraryId, asset.assetId, 'thumbnail')).toMatchObject({
          status: 'ready',
          artifactId: before.artifactId,
        });
        expect(existsSync(artifactPath)).toBe(true);
        expect(readFileSync(artifactPath)).toEqual(bytesBefore);
        expect(processCalls).toBe(0);
      });
    }
  }
});

describe('embedded presentation thumbnails', () => {
  it('propagates ready-artifact database persistence failure without recording a missing-cover failure', async () => {
    const service = newService();
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);
    const db = new TestDatabase(path.join(library.libraryPath, '.serpent', 'library.db'));
    try {
      db.exec(`CREATE TRIGGER reject_ready_thumbnail BEFORE INSERT ON revision_artifacts
        WHEN NEW.kind = 'thumbnail' AND NEW.status = 'ready'
        BEGIN SELECT RAISE(ABORT, 'ready artifact persistence rejected'); END`);
    } finally {
      db.close();
    }
    await expect(service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId }))
      .rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([]);
    expect(readdirSync(path.join(library.libraryPath, '.serpent', 'artifacts')).filter((file) => file.endsWith('.jpg'))).toEqual([]);
  });

  it.each(['ENOSPC', 'EACCES'])('propagates thumbnail output %s without recording a missing-cover failure', async (code) => {
    const productionSharp = createRequire(import.meta.url)('sharp') as SharpModule;
    let outputJpeg: string | undefined;
    const service = newService({
      sharpFn: (input, options) => {
        const instance = productionSharp(input, options);
        instance.toFile = async (output) => {
          outputJpeg = output;
          writeFileSync(output, Buffer.from('partial output'));
          throw Object.assign(new Error('thumbnail output failed'), { code });
        };
        return instance;
      },
    });
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);
    await expect(service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId }))
      .rejects.toMatchObject({ code });
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([]);
    expect(outputJpeg).toBeTruthy();
    expect(existsSync(outputJpeg!)).toBe(false);
  });

  it('does not turn temporary native memory pressure into a permanent missing-cover failure', async () => {
    const service = newService({
      sharpFn: (() => ({
        async metadata() {
          throw Object.assign(new Error('cannot allocate memory'), { code: 'ENOMEM' });
        },
      })) as unknown as SharpModule,
    });
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);
    await expect(service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId }))
      .rejects.toMatchObject({ code: 'MEDIA_RESOURCE_EXHAUSTED' });
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([]);
  });

  it('uses a valid embedded cover without launching a process', async () => {
    let processCalls = 0;
    const service = newService({
      spawnFn: async () => {
        processCalls += 1;
        throw new Error('unexpected process');
      },
    });
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);

    await service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId });

    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([
      expect.objectContaining({ status: 'ready', generator_version: 'pptx-embedded-thumbnail@1' }),
    ]);
    expect(processCalls).toBe(0);
  });

  it('preserves a ready thumbnail generated by a historical converter', async () => {
    const service = newService();
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);
    const result = await service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId });
    const db = new TestDatabase(path.join(library.libraryPath, '.serpent', 'library.db'));
    try {
      db.prepare("UPDATE revision_artifacts SET generator_version = 'presentation-soffice-pdfjs@1' WHERE artifact_id = ?")
        .run(result!.artifactId);
    } finally {
      db.close();
    }
    expect(service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId] })).toBe(0);
    expect(service.getCurrentArtifact(library.libraryId, asset.assetId, 'thumbnail'))
      .toMatchObject({ status: 'ready', artifactId: result!.artifactId });
  });

  it.each(['reject', 'resolve'] as const)('does not record an embedded artifact when final JPEG generation is cancelled (%s)', async (outcome) => {
    const controller = new AbortController();
    const productionSharp = createRequire(import.meta.url)('sharp') as SharpModule;
    let outputJpeg: string | undefined;
    let renderedToJpeg = false;
    const service = newService({
      sharpFn: (input, options) => {
        const instance = productionSharp(input, options);
        const originalToFile = instance.toFile;
        instance.toFile = async (output) => {
          outputJpeg = output;
          const result = await originalToFile.call(instance, output);
          renderedToJpeg = true;
          controller.abort();
          if (outcome === 'reject') {
            throw new DOMException('cancelled after cover decoding', 'AbortError');
          }
          return result;
        };
        return instance;
      },
    });
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);
    await expect(service.generateThumbnail(
      { libraryId: library.libraryId, assetId: asset.assetId },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(renderedToJpeg).toBe(true);
    expect(outputJpeg).toBeTruthy();
    expect(existsSync(outputJpeg!)).toBe(false);
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([]);
  });

  it('propagates embedded decode cancellation without launching a process or recording failure', async () => {
    const controller = new AbortController();
    let conversions = 0;
    const service = newService({
      sharpFn: (() => ({
        async metadata() {
          controller.abort();
          throw new DOMException('cancelled', 'AbortError');
        },
      })) as unknown as SharpModule,
      spawnFn: async () => {
        conversions += 1;
        return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
      },
    });
    const { library, asset } = createPresentation(service, temporaryRoot(), 'pptx', PNG_BYTES);
    await expect(service.generateThumbnail(
      { libraryId: library.libraryId, assetId: asset.assetId },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(conversions).toBe(0);
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([]);
  });
});

describe('ordinary PDF cancellation', () => {
  it.each(['reject', 'resolve'] as const)('keeps PDF JPEG cancellation correct after removing presentation conversion (%s)', async (outcome) => {
    const controller = new AbortController();
    const productionSharp = createRequire(import.meta.url)('sharp') as SharpModule;
    let outputJpeg: string | undefined;
    const service = newService({
      sharpFn: (input, options) => {
        const instance = productionSharp(input, options);
        const originalToFile = instance.toFile;
        instance.toFile = async (output) => {
          outputJpeg = output;
          const result = await originalToFile.call(instance, output);
          controller.abort();
          if (outcome === 'reject') throw new DOMException('cancelled after rendering', 'AbortError');
          return result;
        };
        return instance;
      },
    });
    const root = temporaryRoot();
    const library = service.createLibrary({ displayName: 'PDF', selectedParentPath: root });
    const sourcePath = path.join(root, 'page.pdf');
    writeFileSync(sourcePath, PDF_BYTES);
    importNoConflict(service, library.libraryId, sourcePath);
    const asset = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!;
    await expect(service.generateThumbnail(
      { libraryId: library.libraryId, assetId: asset.assetId },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(outputJpeg).toBeTruthy();
    expect(existsSync(outputJpeg!)).toBe(false);
    expect(currentThumbnailRows(library.libraryPath, asset.currentRevisionId)).toEqual([]);
  });
});
