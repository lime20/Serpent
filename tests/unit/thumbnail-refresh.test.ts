import { describe, expect, it, vi } from 'vitest';
import type { AssetSummary } from '../../src/shared/asset-types';
import type { SerpentLibraryApi } from '../../src/shared/library-api';
import * as thumbnailRefresh from '../../src/renderer/thumbnail-refresh';
import {
  canRefreshThumbnail,
  selectThumbnailRefreshAssetIds,
  queueThumbnailRefresh,
} from '../../src/renderer/thumbnail-refresh';

function asset(assetId: string, overrides: Partial<AssetSummary> = {}) {
  return {
    assetId,
    displayName: `${assetId}.png`,
    mediaType: 'image' as const,
    availability: 'available' as const,
    deletedAt: null,
    ...overrides,
  };
}

describe('manual thumbnail refresh targets', () => {
  it.each(['ready', 'pending', 'failed', null] as const)('includes %s and source-direct images', (thumbnailStatus) => {
    expect(canRefreshThumbnail(asset('image', { thumbnailStatus, previewKind: 'source' }))).toBe(true);
  });

  it('supports documents, models, fonts, PPT/PPTX but excludes unsupported types', () => {
    for (const mediaType of ['document', 'model', 'font'] as const) {
      expect(canRefreshThumbnail(asset(mediaType, { mediaType }))).toBe(true);
    }
    expect(canRefreshThumbnail(asset('deck', { mediaType: 'other', displayName: 'deck.PPTX' }))).toBe(true);
    expect(canRefreshThumbnail(asset('legacy', { mediaType: 'other', displayName: 'legacy.ppt' }))).toBe(true);
    for (const mediaType of ['audio', 'video', 'text', 'other'] as const) {
      expect(canRefreshThumbnail(asset(mediaType, { mediaType }))).toBe(false);
    }
  });

  it('filters missing/deleted sources, unselected and unloaded assets, and duplicate selection IDs', () => {
    const assets = [asset('ready'), asset('failed', { thumbnailStatus: 'failed' }),
      asset('missing', { availability: 'missing' }), asset('deleted', { deletedAt: '2026-10-21' }), asset('unselected')];
    expect(selectThumbnailRefreshAssetIds(['failed', 'missing', 'ready', 'ready', 'deleted', 'unloaded'], assets))
      .toEqual(['failed', 'ready']);
  });

  it('retains unloaded selections as candidates until the action resolves their metadata', () => {
    expect(thumbnailRefresh.selectThumbnailRefreshCandidateIds).toBeTypeOf('function');
    expect(thumbnailRefresh.selectThumbnailRefreshCandidateIds(
      ['unknown', 'ready', 'missing', 'video', 'unknown'],
      [asset('ready'), asset('missing', { availability: 'missing' }), asset('video', { mediaType: 'video' })],
    )).toEqual(['unknown', 'ready']);
  });
});

describe('manual thumbnail refresh submission', () => {
  it('queues each unique target sequentially and reports partial API and transport failures', async () => {
    let active = 0;
    let peak = 0;
    const retryArtifact = vi.fn<SerpentLibraryApi['retryArtifact']>(async ({ assetId }) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (assetId === 'readonly') return { ok: false, error: { code: 'LIBRARY_READ_ONLY', message: 'Library is read-only.' } };
      if (assetId === 'lost') throw new Error('connection lost');
      return { ok: true, value: { assetId, kind: 'thumbnail' } };
    });
    const result = await queueThumbnailRefresh({ api: { retryArtifact }, libraryId: 'library', assetIds: ['ready', 'ready', 'readonly', 'lost', 'missing'] });
    expect(peak).toBe(1);
    expect(retryArtifact.mock.calls.map(([input]) => input)).toEqual(
      ['ready', 'readonly', 'lost', 'missing'].map((assetId) => ({ libraryId: 'library', assetId, kind: 'thumbnail' })),
    );
    expect(result.queuedAssetIds).toEqual(['ready', 'missing']);
    expect(result.failures.map(({ assetId }) => assetId)).toEqual(['readonly', 'lost']);
  });

  it('stops submitting when the originating library view is no longer current', async () => {
    let current = true;
    const retryArtifact = vi.fn<SerpentLibraryApi['retryArtifact']>(async ({ assetId }) => {
      current = false;
      return { ok: true, value: { assetId, kind: 'thumbnail' } };
    });
    await queueThumbnailRefresh({ api: { retryArtifact }, libraryId: 'old-library', assetIds: ['first', 'second'], isCurrent: () => current });
    expect(retryArtifact).toHaveBeenCalledTimes(1);
  });
});
