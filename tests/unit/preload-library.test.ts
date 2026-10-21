import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: {
    getPathForFile: vi.fn(),
  },
}));

vi.mock('../../src/preload/transport', () => ({
  request: vi.fn(),
  failure: vi.fn((result: { error: unknown }) => ({ ok: false, error: result.error })),
  importRequest: vi.fn(),
}));

import { failure, request } from '../../src/preload/transport';
import { library } from '../../src/preload/bridge/library';

test('library.retryMediaJobs keeps an explicit empty selection out of IPC', async () => {
  vi.mocked(request).mockClear();
  vi.mocked(request).mockResolvedValue({ ok: true, type: 'media.jobs.retried', retriedCount: 0 } as never);
  await expect(library.retryMediaJobs({ libraryId: 'lib-1', jobIds: [] })).resolves.toEqual({
    ok: true,
    value: { retriedCount: 0 },
  });
  expect(request).not.toHaveBeenCalled();
});

test('library.retryMediaJobs forwards a nonempty selection through IPC', async () => {
  vi.mocked(request).mockClear();
  vi.mocked(request).mockResolvedValue({ ok: true, type: 'media.jobs.retried', retriedCount: 2 } as never);
  await expect(library.retryMediaJobs({ libraryId: 'lib-1', jobIds: ['job-1', 'job-2'] })).resolves.toEqual({
    ok: true,
    value: { retriedCount: 2 },
  });
  expect(request).toHaveBeenCalledExactlyOnceWith({
    type: 'media.retry-jobs.request',
    libraryId: 'lib-1',
    jobIds: ['job-1', 'job-2'],
  });
});

test('library.retryAiJobs keeps an explicit empty selection out of IPC', async () => {
  vi.mocked(request).mockClear();
  vi.mocked(request).mockResolvedValue({ ok: true, type: 'ai.jobs.retried', retriedCount: 0 } as never);
  await expect(library.retryAiJobs({ libraryId: 'lib-1', jobIds: [] })).resolves.toEqual({
    ok: true,
    value: { retriedCount: 0 },
  });
  expect(request).not.toHaveBeenCalled();
});

test.each([
  ['pauseMediaJobs', 'pausedCount', 'media.jobs.paused'],
  ['resumeMediaJobs', 'resumedCount', 'media.jobs.resumed'],
  ['cancelMediaJobs', 'cancelledCount', 'media.jobs.cancelled'],
  ['pauseAiJobs', 'pausedCount', 'ai.jobs.paused'],
  ['resumeAiJobs', 'resumedCount', 'ai.jobs.resumed'],
  ['cancelAiJobs', 'cancelledCount', 'ai.jobs.cancelled'],
] as const)('library.%s does not treat an empty selection as all jobs', async (method, countKey, type) => {
  vi.mocked(request).mockClear();
  vi.mocked(request).mockResolvedValue({ ok: true, type, [countKey]: 0 } as never);
  await expect(library[method]({ libraryId: 'lib-1', jobIds: [] })).resolves.toEqual({
    ok: true,
    value: { [countKey]: 0 },
  });
  expect(request).not.toHaveBeenCalled();
});

test('library.create sends the owned create request through transport', async () => {
  const opened = {
    ok: true as const,
    type: 'library.opened' as const,
    library: { libraryId: 'lib-1', displayName: 'Studio' },
  };
  vi.mocked(request).mockResolvedValue(opened as never);
  await expect(library.create({ displayName: 'Studio' })).resolves.toEqual({
    ok: true,
    value: opened.library,
  });
  expect(request).toHaveBeenCalledWith({
    type: 'library.create.request',
    displayName: 'Studio',
  });
});

test('library.create maps a failed transport result through failure()', async () => {
  const failed = { ok: false as const, error: { code: 'LIBRARY_CREATE_FAILED' } };
  vi.mocked(request).mockResolvedValue(failed as never);
  await expect(library.create({ displayName: 'Studio' })).resolves.toEqual({
    ok: false,
    error: failed.error,
  });
  expect(failure).toHaveBeenCalledWith(failed);
});

test('library.embeddingSearch preserves raw per-asset scores from transport', async () => {
  const response = {
    ok: true as const,
    type: 'embedding.search' as const,
    phase: 'ready' as const,
    done: 2,
    total: 2,
    failedCount: 0,
    assetIds: ['zero', 'negative'],
    scores: [
      { assetId: 'zero', score: 0 },
      { assetId: 'negative', score: -0.25 },
    ],
  };
  vi.mocked(request).mockResolvedValue(response as never);

  await expect(library.embeddingSearch({
    libraryId: 'lib-1',
    modelId: 'embeddinggemma-2-compact',
    query: 'reflection',
  })).resolves.toEqual({
    ok: true,
    value: {
      phase: 'ready',
      done: 2,
      total: 2,
      failedCount: 0,
      assetIds: ['zero', 'negative'],
      scores: [
        { assetId: 'zero', score: 0 },
        { assetId: 'negative', score: -0.25 },
      ],
    },
  });
  expect(request).toHaveBeenCalledWith({
    type: 'embedding.search.request',
    libraryId: 'lib-1',
    modelId: 'embeddinggemma-2-compact',
    query: 'reflection',
  });
});
