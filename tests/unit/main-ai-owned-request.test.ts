import { expect, test, vi } from "vitest";

import { DEFAULT_AI_ANALYSIS_SETTINGS } from "../../src/shared/ai-analysis-settings";
import { DEFAULT_AI_RELIABILITY_SETTINGS } from "../../src/shared/ai-reliability";
import { parseRendererResult } from "../../src/shared/protocol/responses";
import {
  tryHandleAiOwnedRequest,
  type AiOwnedConfig,
  type AiOwnedRequestRuntime,
} from "../../src/main/library-request/ai";

function config(overrides?: Partial<AiOwnedConfig>): AiOwnedConfig {
  return {
    hasKey: true,
    apiFormat: "openai_chat",
    model: "gpt-4o",
    baseUrl: "",
    descriptionEnabled: true,
    tagEnabled: true,
    ratingEnabled: true,
    analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
    concurrencyLimit: 2,
    maxAnalysisImageEdgePx: 2048,
    reliabilitySettings: DEFAULT_AI_RELIABILITY_SETTINGS,
    languages: ["zh-CN", "en"],
    autoAnalyzeEnabled: false,
    disclaimerAccepted: true,
    ...overrides,
  };
}

function runtime(overrides?: Partial<AiOwnedRequestRuntime>): AiOwnedRequestRuntime {
  return {
    loadAiConfig: () => config(),
    getDecryptedApiKey: () => "sk-test",
    saveAiConfig: vi.fn(),
    saveEncryptedApiKey: vi.fn(),
    workerAvailable: () => true,
    requestWorker: vi.fn(async () => ({
      ok: false as const,
      error: { code: "INTERNAL_ERROR" as const, message: "unused" },
    })),
    processAiQueue: vi.fn(),
    discoverLocalEndpoints: vi.fn(async () => ({
      endpoints: [],
      wslAvailable: false,
      wslDistros: [],
    })),
    logInfo: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

test("unrelated renderer requests fall through", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "folder.list.request", libraryId: "lib-1" },
    runtime(),
  )).resolves.toBeUndefined();
});

test("assets.analyze returns not-configured when the key is missing", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "assets.analyze.request",
      libraryId: "lib-1",
      assetIds: ["asset-1"],
    },
    runtime({
      loadAiConfig: () => config({ hasKey: false }),
    }),
  )).resolves.toMatchObject({
    ok: false,
    error: { code: "AI_ANALYSIS_FAILED", reason: "AI_NOT_CONFIGURED" },
  });
});

test("asset.analyze falls through when enqueue does not create a job", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "asset.analyze.request",
      libraryId: "lib-1",
      assetId: "asset-1",
    },
    runtime({
      requestWorker: vi.fn(async () => ({
        ok: true as const,
        type: "ai.jobs.enqueued" as const,
        libraryId: "lib-1",
        jobIds: [],
        alreadyPendingJobIds: [],
        skippedAssetIds: ["asset-1"],
        enqueued: 0,
      })),
    }),
  )).resolves.toBeUndefined();
});

test("ai.config.get maps the stored config onto the renderer payload", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtime(),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.config.got",
    apiFormat: "openai_chat",
    model: "gpt-4o",
    hasKey: true,
    requiresApiKey: true,
  });
});

test("ai.config.get reports a keyless local profile", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtime({
      loadAiConfig: () => config({
        apiFormat: "local_openai",
        model: "qwen2.5vl:7b",
        hasKey: false,
      }),
    }),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.config.got",
    apiFormat: "local_openai",
    hasKey: false,
    requiresApiKey: false,
  });
});

/**
 * A local runtime has no credential to paste, so saving must not be blocked by
 * the missing key file that every cloud format requires.
 */
test("ai.config.set saves a keyless local profile without an API key", async () => {
  const saveAiConfig = vi.fn();
  const saveEncryptedApiKey = vi.fn();

  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      apiFormat: "local_openai",
      model: "qwen2.5vl:7b",
      baseUrl: "http://127.0.0.1:11434/v1",
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({
      loadAiConfig: () => config({ apiFormat: "local_openai", hasKey: false }),
      saveAiConfig,
      saveEncryptedApiKey,
    }),
  )).resolves.toMatchObject({ ok: true, type: "ai.config.saved" });

  expect(saveAiConfig).toHaveBeenCalledWith(expect.objectContaining({
    apiFormat: "local_openai",
    baseUrl: "http://127.0.0.1:11434/v1",
  }));
  expect(saveEncryptedApiKey).not.toHaveBeenCalled();
});

test("ai.config.set still refuses a keyless save for a cloud format", async () => {
  const saveAiConfig = vi.fn();
  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({
      loadAiConfig: () => config({ hasKey: false }),
      saveAiConfig,
    }),
  )).resolves.toMatchObject({
    ok: false,
    error: { code: "AI_SETTINGS_INCOMPLETE" },
  });
  expect(saveAiConfig).not.toHaveBeenCalled();
});

test("assets.analyze is allowed for a keyless local profile", async () => {
  const requestWorker = vi.fn(async () => ({
    ok: true as const,
    type: "ai.jobs.enqueued" as const,
    libraryId: "lib-1",
    jobIds: ["job-1"],
    alreadyPendingJobIds: [],
    skippedAssetIds: [],
    enqueued: 1,
  }));

  await expect(tryHandleAiOwnedRequest(
    { type: "assets.analyze.request", libraryId: "lib-1", assetIds: ["asset-1"] },
    runtime({
      loadAiConfig: () => config({ apiFormat: "local_openai", hasKey: false }),
      getDecryptedApiKey: () => "",
      requestWorker,
    }),
  )).resolves.toMatchObject({ ok: true, type: "assets.analyze-queued" });
});

/**
 * Regression: the settings panel tests the *draft* profile. Before the first
 * save the stored format is still a cloud one, so resolving the stored key
 * throws — which used to report "AI_ANALYSIS_FAILED" for a reachable local
 * server and made the feature look broken until the user saved blindly.
 */
test("ai.test-connection probes a keyless draft without any stored key", async () => {
  const requestWorker = vi.fn(async () => ({
    ok: true as const,
    type: "ai.test-connection.result" as const,
    success: true,
  }));

  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.test-connection.request",
      apiFormat: "local_openai",
      model: "/home/me/models/qwen.gguf",
      baseUrl: "http://127.0.0.1:8000/v1",
    },
    runtime({
      // Stored profile is still the untouched default.
      loadAiConfig: () => config({ apiFormat: "anthropic", hasKey: false }),
      getDecryptedApiKey: () => {
        throw new Error("no key stored");
      },
      requestWorker,
    }),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.test-connection.result",
    success: true,
  });

  expect(requestWorker).toHaveBeenCalledWith(expect.objectContaining({
    type: "ai.test-connection",
    apiFormat: "local_openai",
    apiKey: "",
    baseUrl: "http://127.0.0.1:8000/v1",
  }));
});

test("ai.test-connection still demands a key for a cloud draft", async () => {
  const requestWorker = vi.fn();

  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "gpt-4o",
    },
    runtime({
      loadAiConfig: () => config({ hasKey: false }),
      getDecryptedApiKey: () => {
        throw new Error("no key stored");
      },
      requestWorker,
    }),
  )).resolves.toMatchObject({
    ok: false,
    error: { code: "AI_ANALYSIS_FAILED", reason: "AI_NOT_CONFIGURED" },
  });
  expect(requestWorker).not.toHaveBeenCalled();
});

test("ai.list-models reports local discovery without a key", async () => {
  const result = await tryHandleAiOwnedRequest(
    { type: "ai.list-models.request", apiFormat: "local_openai" },
    runtime({
      loadAiConfig: () => config({ apiFormat: "local_openai", hasKey: false }),
      getDecryptedApiKey: () => {
        throw new Error("no key stored");
      },
    }),
  );

  // The keyless path must not surface the cloud "auth required" rejection.
  expect(result).toMatchObject({ ok: true, type: "ai.list-models.result" });
  expect((result as { errorKind?: string }).errorKind).not.toBe("auth");
});

/**
 * The preload re-validates every result against `rendererResultSchema`, so a
 * payload that only satisfies the TypeScript type would still break at runtime.
 */
test("the local-endpoints and config replies survive the preload's zod parse", async () => {
  const runtimeOverrides = runtime({
    loadAiConfig: () => config({
      apiFormat: "local_openai",
      model: "qwen2.5vl:7b",
      hasKey: false,
    }),
    discoverLocalEndpoints: vi.fn(async () => ({
      endpoints: [
        {
          presetId: "ollama" as const,
          label: "Ollama",
          baseUrl: "http://172.24.11.9:11434/v1",
          host: "172.24.11.9",
          port: 11434,
          source: "wsl" as const,
          models: ["qwen2.5vl:7b"],
          wslDistro: "Ubuntu-24.04",
        },
      ],
      wslAvailable: true,
      wslDistros: ["Ubuntu-24.04"],
      wslError: "WSL_ADDRESS_UNAVAILABLE",
    })),
  });

  const configResult = await tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtimeOverrides,
  );
  expect(() => parseRendererResult(configResult)).not.toThrow();

  const discoveryResult = await tryHandleAiOwnedRequest(
    { type: "ai.local-endpoints.request" },
    runtimeOverrides,
  );
  expect(() => parseRendererResult(discoveryResult)).not.toThrow();
});

test("ai.local-endpoints returns the probed servers", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "ai.local-endpoints.request" },
    runtime({
      discoverLocalEndpoints: vi.fn(async () => ({
        endpoints: [
          {
            presetId: "ollama" as const,
            label: "Ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            host: "127.0.0.1",
            port: 11434,
            source: "loopback" as const,
            models: ["qwen2.5vl:7b"],
          },
        ],
        wslAvailable: true,
        wslDistros: ["Ubuntu-24.04"],
      })),
    }),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.local-endpoints.result",
    wslAvailable: true,
    wslDistros: ["Ubuntu-24.04"],
    endpoints: [
      {
        presetId: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        source: "loopback",
        models: ["qwen2.5vl:7b"],
      },
    ],
  });
});
