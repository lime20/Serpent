import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import type Sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService, type LibraryServiceOptions } from '../../src/worker/library-service';
import { EXPLICIT_THUMBNAIL_REFRESH_MARKER } from '../../src/worker/artifact-policy';
import { IMPORTED_THUMBNAIL_NORMALIZATION_JOB } from '../../src/worker/imported-thumbnail-policy';
import { mediaResourceGuard, MediaResourceExhaustedError } from '../../src/worker/media-resource-guard';
import { importNoConflict } from './import-no-conflict';

const require = createRequire(import.meta.url);
const sharp = require('sharp') as typeof Sharp;
const roots: string[] = [];
const services: LibraryService[] = [];
const TestDatabase = BetterSqlite3 as new (filename: string) => {
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): void;
  };
  close(): void;
};

function newService(options: LibraryServiceOptions = {}) {
  const service = new LibraryService({ observerFactory: () => ({ close() {} }), ...options });
  services.push(service);
  return service;
}

async function fixture(options: LibraryServiceOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-manual-thumbnail-'));
  roots.push(root);
  const service = newService(options);
  const library = service.createLibrary({ displayName: 'Manual refresh', selectedParentPath: root });
  const imagePath = path.join(root, 'small.png');
  writeFileSync(imagePath, await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#4080c0' },
  }).png().toBuffer());
  importNoConflict(service, library.libraryId, imagePath);
  const asset = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!;
  return { root, service, library, asset };
}

function database(libraryPath: string) {
  return new TestDatabase(path.join(libraryPath, '.serpent', 'library.db'));
}

function seedJob(input: {
  libraryPath: string; libraryId: string; assetId: string; revisionId: string;
  status?: string; errorCode?: string | null; jobId?: string;
}) {
  const db = database(input.libraryPath);
  const now = new Date().toISOString();
  const jobId = input.jobId ?? 'existing-thumbnail';
  try {
    db.prepare(`INSERT INTO jobs
      (job_id, library_id, asset_id, revision_id, kind, status, priority, progress,
       attempt_count, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'generate_thumbnail', ?, 100, 0, 0, ?, ?, ?)`)
      .run(jobId, input.libraryId, input.assetId, input.revisionId,
        input.status ?? 'queued', input.errorCode ?? null, now, now);
  } finally {
    db.close();
  }
  return jobId;
}

function jobRow(libraryPath: string, jobId: string) {
  const db = database(libraryPath);
  try {
    return db.prepare('SELECT status, error_code, revision_id FROM jobs WHERE job_id = ?')
      .get(jobId);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  mediaResourceGuard.reset();
});

describe('manual thumbnail refresh', () => {
  it.each([false, true])('generates a small source-direct image with scoped pump %s', async (scoped) => {
    const { service, library, asset } = await fixture();
    const jobId = service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    expect(service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' })).toBe(jobId);
    await service.processThumbnailQueue(library.libraryId, {
      maxJobs: 1, jobKinds: ['generate_thumbnail'], ...(scoped ? { assetIds: [asset.assetId] } : {}),
    });
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'succeeded' });
    const thumbnail = service.getThumbnailArtifact(library.libraryId, asset.assetId);
    expect(thumbnail).not.toBeNull();
    const metadata = await sharp(readFileSync(path.join(library.libraryPath, '.serpent', 'artifacts', thumbnail!.filePath))).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 16, height: 16 });
  });

  it('keeps automatic small-image browsing source-direct', async () => {
    const { service, library, asset } = await fixture();
    service.enqueueThumbnailJobs(library.libraryId, { assetIds: [asset.assetId] });
    expect(service.listMediaJobs(library.libraryId).jobs.filter((job) => job.kind === 'generate_thumbnail')).toEqual([]);
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)).toBeNull();
  });

  it.each(['sharp', 'eagle-thumbnail@1'])('replaces a ready %s thumbnail from the source', async (generator) => {
    const { service, library, asset } = await fixture();
    const old = await service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId });
    expect(old).not.toBeNull();
    if (generator !== 'sharp') {
      const db = database(library.libraryPath);
      try { db.prepare('UPDATE revision_artifacts SET generator_version = ? WHERE artifact_id = ?').run(generator, old!.artifactId); }
      finally { db.close(); }
    }
    service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)).toBeNull();
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    const current = service.getCurrentArtifact(library.libraryId, asset.assetId, 'thumbnail');
    expect(current).toMatchObject({ status: 'ready' });
    expect(current!.artifactId).not.toBe(old!.artifactId);
    expect(current!.generatorVersion).toContain('sharp@');
  });

  it.each(['queued', 'paused'])('promotes an existing %s normalization job to source refresh', async (status) => {
    const { service, library, asset } = await fixture();
    await service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId });
    const jobId = seedJob({ libraryPath: library.libraryPath, libraryId: library.libraryId,
      assetId: asset.assetId, revisionId: asset.currentRevisionId, status, errorCode: IMPORTED_THUMBNAIL_NORMALIZATION_JOB });
    expect(service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' })).toBe(jobId);
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'queued', error_code: EXPLICIT_THUMBNAIL_REFRESH_MARKER });
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)).toBeNull();
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'succeeded' });
  });

  it('coalesces a running normalization without changing its intent or current cover', async () => {
    const { service, library, asset } = await fixture();
    const old = await service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId });
    const jobId = seedJob({ libraryPath: library.libraryPath, libraryId: library.libraryId,
      assetId: asset.assetId, revisionId: asset.currentRevisionId, status: 'running', errorCode: IMPORTED_THUMBNAIL_NORMALIZATION_JOB });
    expect(service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' })).toBe(jobId);
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'running', error_code: IMPORTED_THUMBNAIL_NORMALIZATION_JOB });
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)?.artifactId).toBe(old!.artifactId);
  });

  it('does not reuse a stale-revision job for a current refresh', async () => {
    const { root, service, library, asset } = await fixture();
    const otherPath = path.join(root, 'other.png');
    writeFileSync(otherPath, await sharp({ create: { width: 17, height: 17, channels: 3, background: '#123456' } }).png().toBuffer());
    importNoConflict(service, library.libraryId, otherPath);
    const other = service.listAssets({ libraryId: library.libraryId, recursive: true }).find((item) => item.assetId !== asset.assetId)!;
    seedJob({ libraryPath: library.libraryPath, libraryId: library.libraryId,
      assetId: asset.assetId, revisionId: other.currentRevisionId, jobId: 'stale-revision' });
    const jobId = service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    expect(jobId).not.toBe('stale-revision');
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ revision_id: asset.currentRevisionId, error_code: EXPLICIT_THUMBNAIL_REFRESH_MARKER });
  });

  it('preserves explicit intent when recovering an interrupted refresh', async () => {
    const { service, library, asset } = await fixture();
    const jobId = service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    const db = database(library.libraryPath);
    try { db.prepare("UPDATE jobs SET status = 'running' WHERE job_id = ?").run(jobId); }
    finally { db.close(); }
    service.closeAll();
    const reopened = newService();
    reopened.openLibrary(library.libraryPath);
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'queued', error_code: EXPLICIT_THUMBNAIL_REFRESH_MARKER });
    await reopened.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(reopened.getThumbnailArtifact(library.libraryId, asset.assetId)).not.toBeNull();
  });

  it('preserves explicit intent while another worker holds the job lease', async () => {
    const { service, library, asset } = await fixture();
    const jobId = service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    const lease = await service.acquireJobLease(library.libraryId, jobId, { timeoutMs: 0 });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25);
    try {
      await service.processThumbnailQueue(library.libraryId, {
        maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId], signal: controller.signal,
      });
      expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'queued', error_code: EXPLICIT_THUMBNAIL_REFRESH_MARKER });
    } finally {
      clearTimeout(abortTimer);
      lease.release();
    }
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)).not.toBeNull();
  });

  it('retries a failed small-image refresh from the task panel instead of cancelling it as source-direct', async () => {
    let failDecode = true;
    let attempts = 0;
    const { service, library, asset } = await fixture({
      sharpFn: ((...args: Parameters<typeof sharp>) => {
        attempts += 1;
        if (failDecode) throw new Error('Unsupported fixture decode');
        return sharp(...args);
      }) as NonNullable<LibraryServiceOptions['sharpFn']>,
    });
    const jobId = service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'failed' });
    expect(service.getCurrentArtifact(library.libraryId, asset.assetId, 'thumbnail')).toMatchObject({ status: 'failed' });
    failDecode = false;
    expect(service.retryMediaJobs(library.libraryId, [jobId])).toEqual({ retriedCount: 1 });
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'succeeded' });
    expect(attempts).toBeGreaterThan(1);
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)).not.toBeNull();
  });

  it('preserves explicit intent after native memory pressure requeues the work', async () => {
    let failDecode = true;
    const { service, library, asset } = await fixture({
      sharpFn: ((...args: Parameters<typeof sharp>) => {
        if (failDecode) throw new MediaResourceExhaustedError('Cannot allocate memory', 'thumbnail');
        return sharp(...args);
      }) as NonNullable<LibraryServiceOptions['sharpFn']>,
    });
    const jobId = service.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' });
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(jobRow(library.libraryPath, jobId)).toMatchObject({ status: 'queued', error_code: EXPLICIT_THUMBNAIL_REFRESH_MARKER });
    expect(service.getCurrentArtifact(library.libraryId, asset.assetId, 'thumbnail')).toBeNull();
    failDecode = false;
    mediaResourceGuard.reset();
    await service.processThumbnailQueue(library.libraryId, { maxJobs: 1, jobKinds: ['generate_thumbnail'], assetIds: [asset.assetId] });
    expect(service.getThumbnailArtifact(library.libraryId, asset.assetId)).not.toBeNull();
  });

  it('rejects a read-only refresh with the public read-only error before mutation', async () => {
    const { service, library, asset } = await fixture();
    const old = await service.generateThumbnail({ libraryId: library.libraryId, assetId: asset.assetId });
    service.closeAll();
    const readonly = newService();
    readonly.openLibraryReadOnly(library.libraryPath);
    expect(() => readonly.enqueueArtifactRetry({ libraryId: library.libraryId, assetId: asset.assetId, kind: 'thumbnail' }))
      .toThrow('LIBRARY_READ_ONLY');
    expect(readonly.getThumbnailArtifact(library.libraryId, asset.assetId)?.artifactId).toBe(old!.artifactId);
  });
});
