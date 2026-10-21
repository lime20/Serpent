import type { AssetSummary } from '../shared/asset-types';
import type { SerpentLibraryApi } from '../shared/library-api';
import { assetSupportsThumbnail } from '../shared/thumbnail-support';
import { LibraryOperationError } from './error-utils';

type ThumbnailRefreshAsset = Pick<AssetSummary, 'assetId' | 'displayName' | 'mediaType' | 'availability' | 'deletedAt'>;

export function supportsThumbnailRefresh(asset: Pick<AssetSummary, 'displayName' | 'mediaType'>): boolean {
  return asset.mediaType !== 'video'
    && asset.mediaType !== 'audio'
    && assetSupportsThumbnail(asset);
}

export function canRefreshThumbnail(asset: ThumbnailRefreshAsset): boolean {
  return asset.availability === 'available'
    && asset.deletedAt === null
    && supportsThumbnailRefresh(asset);
}

export function selectThumbnailRefreshAssetIds(
  assetIds: readonly string[],
  assets: readonly ThumbnailRefreshAsset[],
): string[] {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  return [...new Set(assetIds)].filter((assetId) => {
    const asset = byId.get(assetId);
    return asset !== undefined && canRefreshThumbnail(asset);
  });
}

/** Unloaded selections are resolved by the action before submitting any job. */
export function selectThumbnailRefreshCandidateIds(
  assetIds: readonly string[],
  assets: readonly ThumbnailRefreshAsset[],
): string[] {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  return [...new Set(assetIds)].filter((assetId) => {
    const asset = byId.get(assetId);
    return asset === undefined || canRefreshThumbnail(asset);
  });
}

/** Queue acceptance is reported here; decoder completion arrives on thumbnail events. */
export async function queueThumbnailRefresh({
  api,
  libraryId,
  assetIds,
  isCurrent = () => true,
}: {
  api: Pick<SerpentLibraryApi, 'retryArtifact'>;
  libraryId: string;
  assetIds: readonly string[];
  isCurrent?: () => boolean;
}): Promise<{ queuedAssetIds: string[]; failures: { assetId: string; error: unknown }[] }> {
  const queuedAssetIds: string[] = [];
  const failures: { assetId: string; error: unknown }[] = [];
  // Bound IPC/DB work to one request at a time even for large selections.
  for (const assetId of new Set(assetIds)) {
    if (!isCurrent()) break;
    try {
      const result = await api.retryArtifact({ libraryId, assetId, kind: 'thumbnail' });
      if (!result.ok) throw new LibraryOperationError(result.error);
      queuedAssetIds.push(assetId);
    } catch (error) {
      failures.push({ assetId, error });
    }
  }
  return { queuedAssetIds, failures };
}
