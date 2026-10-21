import type { LibraryApiResult, SerpentLibraryApi } from "../shared/library-api";
import { MEDIA_JOB_LIST_PAGE_SIZE, type MediaJobListCursor } from "../shared/media-jobs";

/** Omitted IDs mean all failures; an explicit empty selection is a no-op. */
export async function retryMediaJobs({
  api,
  libraryId,
  jobIds,
  isCurrentLibrary,
}: {
  api: Pick<SerpentLibraryApi, "listMediaJobs" | "retryMediaJobs">;
  libraryId: string;
  jobIds?: string[];
  isCurrentLibrary: () => boolean;
}): Promise<LibraryApiResult<{ retriedCount: number }> | null> {
  if (!isCurrentLibrary()) return null;
  const selectedIds = new Set(jobIds);
  if (jobIds === undefined) {
    let cursor: MediaJobListCursor | undefined;
    const seenCursors = new Set<string>();
    let pagesRemaining: number | undefined;
    for (;;) {
      const result = await api.listMediaJobs({
        libraryId,
        limit: MEDIA_JOB_LIST_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (!isCurrentLibrary()) return null;
      if (!result.ok) return result;
      const page = result.value;
      // Every page must advance through at least one existing job. Bound the
      // scan to the first snapshot even if another caller keeps adding jobs.
      pagesRemaining ??= Math.max(1,
        page.queued + page.running + page.succeeded + page.failed + page.paused + page.cancelled,
      ) + 1;
      pagesRemaining -= 1;
      for (const job of page.jobs) {
        if (job.status === "failed") selectedIds.add(job.jobId);
      }
      if (page.hasMore !== true) break;
      const nextCursor = page.nextCursor;
      const cursorKey = nextCursor ? JSON.stringify(nextCursor) : null;
      if (!nextCursor || !cursorKey || seenCursors.has(cursorKey) || pagesRemaining <= 0) {
        throw new Error("Media job pagination did not advance.");
      }
      seenCursors.add(cursorKey);
      cursor = nextCursor;
    }
  }
  if (!isCurrentLibrary()) return null;
  if (selectedIds.size === 0) return { ok: true, value: { retriedCount: 0 } };
  // Collect every page before mutating so a failed scan cannot retry only a
  // partial selection. The Worker applies this request in one transaction.
  return api.retryMediaJobs({ libraryId, jobIds: [...selectedIds] });
}
