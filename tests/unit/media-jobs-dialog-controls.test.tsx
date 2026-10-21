// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { MediaJobsDialog } from "../../src/renderer/MediaJobsDialog";
import { LocaleProvider } from "../../src/renderer/i18n";
import type { AiJobStatus } from "../../src/shared/library-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MediaJobsDialog controls", () => {
  it("retries all failed media jobs even when the current list has none of their IDs", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onControlMediaJobs = vi.fn();
    try {
      await act(async () => {
        root.render(createElement(LocaleProvider, {
          initialPreference: "en",
          children: createElement(MediaJobsDialog, {
            open: true,
            mediaJobsLoading: false,
            mediaJobs: {
              queued: 0,
              running: 0,
              succeeded: 0,
              failed: 3,
              paused: 0,
              cancelled: 0,
              jobs: [],
            },
            aiJobs: null,
            pluginJobs: null,
            onClose: () => undefined,
            onControlMediaJobs,
            onControlAiJobs: () => undefined,
          }),
        }));
      });
      const retryButton = [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry failed");
      expect(retryButton).toBeInstanceOf(HTMLButtonElement);
      expect(retryButton?.disabled).toBe(false);
      await act(async () => retryButton?.click());
      expect(onControlMediaJobs).toHaveBeenCalledExactlyOnceWith("retry");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each(["empty", "succeeded-only", "failed-and-succeeded"] as const)(
    "only retries loaded failed AI jobs when the current list is %s",
    async (list) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const onControlAiJobs = vi.fn();
      const succeeded: AiJobStatus["jobs"][number] = {
        jobId: "ai-succeeded",
        assetId: "asset-ai-succeeded",
        kind: "ai.image.analysis",
        status: "succeeded",
        errorCode: null,
        errorDetail: null,
        updatedAt: "2026-10-21T00:00:00.000Z",
      };
      const jobs: AiJobStatus["jobs"] = list === "empty" ? [] : [succeeded];
      if (list === "failed-and-succeeded") {
        jobs.push({ ...succeeded, jobId: "ai-failed", status: "failed" });
      }
      try {
        await act(async () => {
          root.render(createElement(LocaleProvider, {
            initialPreference: "en",
            children: createElement(MediaJobsDialog, {
              open: true,
              mediaJobsLoading: false,
              mediaJobs: {
                queued: 0, running: 0, succeeded: 0, failed: 0, paused: 0, cancelled: 0, jobs: [],
              },
              aiJobs: {
                queued: 0, running: 0, succeeded: 1, failed: 3, paused: 0, cancelled: 0, jobs,
              },
              pluginJobs: null,
              onClose: () => undefined,
              onControlMediaJobs: () => undefined,
              onControlAiJobs,
            }),
          }));
        });

        const retryButton = [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Retry failed AI jobs");
        expect(retryButton).toBeInstanceOf(HTMLButtonElement);
        expect(retryButton?.disabled).toBe(list !== "failed-and-succeeded");
        await act(async () => retryButton?.click());
        if (list === "failed-and-succeeded") {
          expect(onControlAiJobs).toHaveBeenCalledExactlyOnceWith("retry", ["ai-failed"]);
        } else {
          expect(onControlAiJobs).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    },
  );
});
