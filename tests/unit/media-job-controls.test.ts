import { describe, expect, it, vi } from "vitest";

import type { MediaJobStatus } from "../../src/shared/library-api";
import type { MediaJob } from "../../src/shared/protocol/responses";
import { retryMediaJobs } from "../../src/renderer/media-job-controls";

function job(jobId: string, status: MediaJob["status"]): MediaJob {
  return {
    jobId,
    assetId: `asset-${jobId}`,
    revisionId: null,
    kind: "generate_thumbnail",
    status,
    progress: 0,
    attemptCount: 1,
    errorCode: null,
    errorDetail: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

function page(jobs: MediaJob[], hasMore = false): { ok: true; value: MediaJobStatus } {
  return {
    ok: true,
    value: {
      queued: 100,
      running: 0,
      succeeded: 0,
      failed: 2,
      paused: 0,
      cancelled: 0,
      jobs,
      hasMore,
      nextCursor: hasMore && jobs.length > 0
        ? { createdAt: jobs.at(-1)!.createdAt, jobId: jobs.at(-1)!.jobId }
        : null,
    },
  };
}

describe("media job retry controls", () => {
  it("queries every current page before retrying failures outside the visible page", async () => {
    const listMediaJobs = vi.fn()
      .mockResolvedValueOnce(page([job("recent", "succeeded")], true))
      .mockResolvedValueOnce(page([job("failed-1", "failed")], true))
      .mockResolvedValueOnce(page([job("failed-1", "failed"), job("failed-2", "failed")]));
    const retry = vi.fn().mockResolvedValue({ ok: true, value: { retriedCount: 2 } });
    const result = await retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => true,
    });

    expect(listMediaJobs.mock.calls).toEqual([
      [{ libraryId: "library-1", limit: 100 }],
      [{ libraryId: "library-1", limit: 100, cursor: { createdAt: "2026-10-21T00:00:00.000Z", jobId: "recent" } }],
      [{ libraryId: "library-1", limit: 100, cursor: { createdAt: "2026-10-21T00:00:00.000Z", jobId: "failed-1" } }],
    ]);
    expect(retry).toHaveBeenCalledExactlyOnceWith({ libraryId: "library-1", jobIds: ["failed-1", "failed-2"] });
    expect(result).toEqual({ ok: true, value: { retriedCount: 2 } });
  });

  it("treats an explicit empty selection as no operation without fetching or sending IDs", async () => {
    const listMediaJobs = vi.fn();
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      jobIds: [],
      isCurrentLibrary: () => true,
    })).resolves.toEqual({ ok: true, value: { retriedCount: 0 } });
    expect(listMediaJobs).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("preserves an explicit selection without fetching the entire list", async () => {
    const listMediaJobs = vi.fn();
    const retry = vi.fn().mockResolvedValue({ ok: true, value: { retriedCount: 1 } });
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      jobIds: ["failed-1", "failed-1"],
      isCurrentLibrary: () => true,
    })).resolves.toEqual({ ok: true, value: { retriedCount: 1 } });
    expect(listMediaJobs).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledExactlyOnceWith({ libraryId: "library-1", jobIds: ["failed-1"] });
  });

  it("collects more than one thousand failed IDs before submitting one atomic retry", async () => {
    const jobs = Array.from({ length: 1_205 }, (_, index) =>
      job(`failed-${String(1_205 - index).padStart(4, "0")}`, "failed"),
    );
    const retry = vi.fn().mockResolvedValue({ ok: true, value: { retriedCount: jobs.length } });
    const listMediaJobs = vi.fn().mockImplementation(async ({ cursor, limit }) => {
      expect(retry).not.toHaveBeenCalled();
      const start = cursor ? jobs.findIndex((entry) => entry.jobId === cursor.jobId) + 1 : 0;
      const result = page(jobs.slice(start, start + limit), start + limit < jobs.length);
      result.value.queued = 0;
      result.value.failed = jobs.length;
      return result;
    });

    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => true,
    })).resolves.toEqual({ ok: true, value: { retriedCount: jobs.length } });

    expect(listMediaJobs).toHaveBeenCalledTimes(13);
    expect(retry).toHaveBeenCalledExactlyOnceWith({
      libraryId: "library-1",
      jobIds: jobs.map((entry) => entry.jobId),
    });
  });

  it("does not send an empty retry when summary failures have already recovered", async () => {
    const listMediaJobs = vi.fn().mockResolvedValue(page([]));
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => true,
    })).resolves.toEqual({ ok: true, value: { retriedCount: 0 } });
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not partially retry if a later page fails to load", async () => {
    const failure = { ok: false, error: { code: "INTERNAL_ERROR" } };
    const listMediaJobs = vi.fn()
      .mockResolvedValueOnce(page([job("failed-1", "failed")], true))
      .mockResolvedValueOnce(failure);
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => true,
    })).resolves.toEqual(failure);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not retry jobs after the current library changes while a page is loading", async () => {
    let current = true;
    const listMediaJobs = vi.fn().mockImplementation(async () => {
      current = false;
      return page([job("failed-1", "failed")], true);
    });
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => current,
    })).resolves.toBeNull();
    expect(listMediaJobs).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not call any API for a stale library even with explicit job IDs", async () => {
    const listMediaJobs = vi.fn();
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      jobIds: ["failed-1"],
      isCurrentLibrary: () => false,
    })).resolves.toBeNull();
    expect(listMediaJobs).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("stops repeated page cursors without submitting a partial retry", async () => {
    const listMediaJobs = vi.fn().mockResolvedValue(page([job("failed-1", "failed")], true));
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => true,
    })).rejects.toThrow("Media job pagination did not advance.");
    expect(listMediaJobs).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
  });

  it("bounds a continuously advancing scan to its initial job snapshot", async () => {
    const listMediaJobs = vi.fn().mockImplementation(async () => {
      const result = page([job(`failed-${listMediaJobs.mock.calls.length}`, "failed")], true);
      result.value.queued = 0;
      result.value.failed = 1;
      return result;
    });
    const retry = vi.fn();
    await expect(retryMediaJobs({
      api: { listMediaJobs, retryMediaJobs: retry },
      libraryId: "library-1",
      isCurrentLibrary: () => true,
    })).rejects.toThrow("Media job pagination did not advance.");
    expect(listMediaJobs).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
  });
});
