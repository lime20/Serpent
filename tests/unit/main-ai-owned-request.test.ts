import { expect, test, vi } from "vitest";

import { DEFAULT_AI_ANALYSIS_SETTINGS } from "../../src/shared/ai-analysis-settings";
import { DEFAULT_AI_RELIABILITY_SETTINGS } from "../../src/shared/ai-reliability";
import { parseRendererResult } from "../../src/shared/protocol/responses";
import {
  AiProfileStorageError,
  AiProfileValidationError,
} from "../../src/main/ai-profile-store";
import {
  tryHandleAiOwnedRequest,
  type AiOwnedConfig,
  type AiOwnedRequestRuntime,
} from "../../src/main/library-request/ai";

function config(overrides?: Partial<AiOwnedConfig>): AiOwnedConfig {
  return {
    hasKey: true,
    activeProfileId: "ai_000000000000000000000000",
    profiles: [{
      id: "ai_000000000000000000000000",
      name: "Test profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
      hasCredential: true,
    }],
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
    getDecryptedProfileApiKey: () => "sk-test",
    saveAiConfig: vi.fn(),
    saveConnectionProfile: vi.fn(() => "ai_000000000000000000000000"),
    activateConnectionProfile: vi.fn(),
    deleteConnectionProfile: vi.fn(),
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
    activeProfileId: "ai_000000000000000000000000",
    profiles: [{ id: "ai_000000000000000000000000", hasCredential: true }],
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
test("ai.config.set saves analysis preferences for a keyless local profile", async () => {
  const saveAiConfig = vi.fn();
  const saveConnectionProfile = vi.fn();

  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({
      loadAiConfig: () => config({
        apiFormat: "local_openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        hasKey: false,
      }),
      saveAiConfig,
      saveConnectionProfile,
    }),
  )).resolves.toMatchObject({ ok: true, type: "ai.config.saved" });

  expect(saveAiConfig).toHaveBeenCalledWith(expect.objectContaining({
    apiFormat: "local_openai",
    baseUrl: "http://127.0.0.1:11434/v1",
  }));
  expect(saveConnectionProfile).not.toHaveBeenCalled();
});

test("ai.config.set saves analysis preferences independently of a missing cloud key", async () => {
  const saveAiConfig = vi.fn();
  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({
      loadAiConfig: () => config({ hasKey: false }),
      saveAiConfig,
    }),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.config.saved",
  });
  expect(saveAiConfig).toHaveBeenCalledOnce();
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
test("ai.test-connection does not inherit an active cloud credential for a keyless draft", async () => {
  const getDecryptedApiKey = vi.fn(() => "unrelated-cloud-secret");
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
      loadAiConfig: () => config({ apiFormat: "anthropic", hasKey: true }),
      getDecryptedApiKey,
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
  expect(getDecryptedApiKey).not.toHaveBeenCalled();
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

test("ai.list-models preserves local vision capabilities without reading a cloud key", async () => {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify({
      data: [{ id: "local-vision", capabilities: ["vision"] }],
    }), { status: 200 });
  });
  const getDecryptedApiKey = vi.fn(() => "unrelated-cloud-secret");
  vi.stubGlobal("fetch", fetchFn);
  try {
    const result = await tryHandleAiOwnedRequest(
      { type: "ai.list-models.request", apiFormat: "local_openai" },
      runtime({ getDecryptedApiKey }),
    );

    expect(result).toMatchObject({
      ok: true,
      type: "ai.list-models.result",
      models: ["local-vision"],
      visionModels: ["local-vision"],
      capabilitiesReported: true,
    });
    expect(() => parseRendererResult(result)).not.toThrow();
    expect(getDecryptedApiKey).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Content-Type": "application/json" },
    });
    expect(fetchFn.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each(["ai.test-connection.request", "ai.list-models.request"] as const)(
  "%s keeps local profile storage corruption visible",
  async (type) => {
    const requestWorker = vi.fn();
    const result = await tryHandleAiOwnedRequest({
      type,
      apiFormat: "local_openai",
      model: "local-model",
      profileId: "ai_000000000000000000000006",
    }, runtime({
      getDecryptedProfileApiKey: () => {
        throw new AiProfileStorageError(new Error("profile catalog is corrupt"));
      },
      requestWorker,
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "AI_PROFILE_STORAGE_FAILED" } });
    expect(requestWorker).not.toHaveBeenCalled();
  },
);

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

test("ai.config.get reports a profile storage failure instead of returning default settings", async () => {
  const logError = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtime({
      loadAiConfig: () => { throw new AiProfileStorageError(new Error("catalog is unreadable")); },
      logError,
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
  expect(logError).toHaveBeenCalledWith(
    "ai.profile-storage.read",
    expect.any(AiProfileStorageError),
    { operation: "ai.config.get.request" },
  );
});

test("analysis preference writes stop when the stored AI settings cannot be read", async () => {
  const saveAiConfig = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      enabledFields: { description: true, tags: true, rating: true },
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({
      loadAiConfig: () => { throw new Error("profile journal is corrupt"); },
      saveAiConfig,
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
  expect(saveAiConfig).not.toHaveBeenCalled();
});

test("analysis preferences save independently from connection profiles", async () => {
  const saveAiConfig = vi.fn();
  const saveConnectionProfile = vi.fn();
  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      enabledFields: { description: true, tags: false, rating: true },
      analysisSettings: {
        forceExistingTags: true,
        maxTags: 5,
        maxDescriptionCharsZh: 80,
        maxDescriptionWordsEn: 40,
        outputStyle: "concise",
        ratingRubric: "Use a five point scale.",
        customDescriptionPrompt: "",
        customTagPrompt: "",
      },
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({ saveAiConfig, saveConnectionProfile }),
  )).resolves.toMatchObject({ ok: true, type: "ai.config.saved" });
  expect(saveConnectionProfile).not.toHaveBeenCalled();
  expect(saveAiConfig).toHaveBeenCalledWith(expect.objectContaining({
    apiFormat: "openai_chat",
    model: "gpt-4o",
    analysisSettings: expect.objectContaining({ forceExistingTags: true }),
  }));
});

test.each([
  { apiFormat: "openai_chat" as const, apiKey: "active-profile-secret" },
  { apiFormat: "local_openai" as const, apiKey: "" },
])("AI search planning uses the active $apiFormat profile's connection", async ({ apiFormat, apiKey }) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            keywords: ["active-profile-keyword"],
            synonyms: [],
            exclusions: [],
            filters: [],
            sort: null,
          }),
        },
      }],
    }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  try {
    const activeConfig = config({
      activeProfileId: "ai_000000000000000000000006",
      profiles: [{
        id: "ai_000000000000000000000006",
        name: "Active profile",
        apiFormat,
        model: "active-search-model",
        baseUrl: "https://active.example.invalid/v1",
        hasCredential: !!apiKey,
      }],
      apiFormat,
      model: "active-search-model",
      baseUrl: "https://active.example.invalid/v1",
      hasKey: !!apiKey,
      disclaimerAccepted: true,
    });
    const getDecryptedApiKey = vi.fn(() => apiKey);
    const result = await tryHandleAiOwnedRequest(
      { type: "ai.search-plan.request", naturalQuery: "find active profile" },
      runtime({
        loadAiConfig: () => activeConfig,
        getDecryptedApiKey,
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://active.example.invalid/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1];
    if (!apiKey) expect(requestInit?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ model: "active-search-model" });
    expect(getDecryptedApiKey).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      type: "ai.search-plan.result",
      apiFormat,
      model: "active-search-model",
      plan: { keywords: ["active-profile-keyword"] },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("profile save response exposes only its id", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.profiles.save.request",
      name: "Private profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
      apiKey: "secret-token",
    },
    runtime({ saveConnectionProfile: vi.fn(() => "ai_000000000000000000000005") }),
  )).resolves.toEqual({
    ok: true,
    type: "ai.profiles.saved",
    id: "ai_000000000000000000000005",
  });
});

test("profile validation failures remain actionable settings errors", async () => {
  const logError = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.profiles.save.request",
      name: "Invalid profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
    },
    runtime({
      saveConnectionProfile: () => { throw new AiProfileValidationError("invalid profile"); },
      logError,
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_SETTINGS_INCOMPLETE" },
  });
  expect(logError).not.toHaveBeenCalled();
});

test.each([
  {
    scope: "ai.profile.save",
    request: {
      type: "ai.profiles.save.request" as const,
      name: "Private profile",
      apiFormat: "openai_chat" as const,
      model: "gpt-4o",
      baseUrl: "",
    },
    override: { saveConnectionProfile: () => { throw new Error("disk write failed"); } },
  },
  {
    scope: "ai.profile.activate",
    request: { type: "ai.profiles.activate.request" as const, id: "ai_000000000000000000000006" },
    override: { activateConnectionProfile: () => { throw new Error("safeStorage failed"); } },
  },
  {
    scope: "ai.profile.delete",
    request: { type: "ai.profiles.delete.request" as const, id: "ai_000000000000000000000006" },
    override: { deleteConnectionProfile: () => { throw new Error("credential delete failed"); } },
  },
])("profile storage failures are logged and returned as retryable errors: $scope", async ({ scope, request, override }) => {
  const logError = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    request,
    runtime({ ...override, logError }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
  expect(logError).toHaveBeenCalledWith(scope, expect.any(Error), expect.any(Object));
});

test("profile activation and deletion are owned by Main", async () => {
  const activateConnectionProfile = vi.fn();
  const deleteConnectionProfile = vi.fn();
  const activateResult = await tryHandleAiOwnedRequest(
    { type: "ai.profiles.activate.request", id: "ai_000000000000000000000006" },
    runtime({ activateConnectionProfile }),
  );
  const deleteResult = await tryHandleAiOwnedRequest(
    { type: "ai.profiles.delete.request", id: "ai_000000000000000000000006" },
    runtime({ deleteConnectionProfile }),
  );

  expect(activateConnectionProfile).toHaveBeenCalledWith("ai_000000000000000000000006");
  expect(deleteConnectionProfile).toHaveBeenCalledWith("ai_000000000000000000000006");
  expect(activateResult).toMatchObject({ ok: true, type: "ai.profiles.activated" });
  expect(deleteResult).toMatchObject({ ok: true, type: "ai.profiles.deleted" });
});

test("profile save can explicitly clear its saved credential", async () => {
  const saveConnectionProfile = vi.fn(() => "ai_000000000000000000000006");
  await tryHandleAiOwnedRequest(
    {
      type: "ai.profiles.save.request",
      id: "ai_000000000000000000000006",
      name: "Private profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
      clearCredential: true,
    },
    runtime({ saveConnectionProfile }),
  );

  expect(saveConnectionProfile).toHaveBeenCalledWith(expect.objectContaining({ clearCredential: true }));
});

test("stored connection probes keep their profile snapshot after the active profile changes", async () => {
  const getDecryptedProfileApiKey = vi.fn(() => "profile-secret");
  const getDecryptedApiKey = vi.fn(() => "new-active-profile-secret");
  const requestWorker = vi.fn(async () => ({
    ok: true as const,
    type: "ai.test-connection.result" as const,
    success: true,
  }));
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "wrong-renderer-model",
      baseUrl: "https://wrong.example.invalid",
      profileId: "ai_000000000000000000000006",
    },
    runtime({
      loadAiConfig: () => config({
        // Simulate a switch to profile 007 after the renderer captured profile 006.
        activeProfileId: "ai_000000000000000000000007",
        profiles: [{
          id: "ai_000000000000000000000006",
          name: "Target profile",
          apiFormat: "anthropic",
          model: "claude-test",
          baseUrl: "https://target.example.invalid",
          hasCredential: true,
        }, {
          id: "ai_000000000000000000000007",
          name: "New active profile",
          apiFormat: "anthropic",
          model: "claude-current",
          baseUrl: "https://current.example.invalid",
          hasCredential: true,
        }],
      }),
      getDecryptedProfileApiKey,
      getDecryptedApiKey,
      requestWorker,
    }),
  );

  expect(getDecryptedProfileApiKey).toHaveBeenCalledWith("ai_000000000000000000000006");
  expect(getDecryptedApiKey).not.toHaveBeenCalled();
  expect(requestWorker).toHaveBeenCalledWith(expect.objectContaining({
    apiFormat: "openai_chat",
    model: "wrong-renderer-model",
    baseUrl: "https://wrong.example.invalid",
    apiKey: "profile-secret",
  }));
  expect(JSON.stringify(result)).not.toContain("profile-secret");
});

test("connection probes report corrupt profile storage separately from a missing key", async () => {
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      profileId: "ai_000000000000000000000006",
    },
    runtime({
      getDecryptedProfileApiKey: () => {
        throw new AiProfileStorageError(new Error("profile catalog is corrupt"));
      },
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
});

test("listing models uses a saved profile credential with the current draft endpoint and format", async () => {
  const fetchFn = vi.fn(async () => new Response(
    JSON.stringify({ data: [{ id: "draft-model" }] }),
    { status: 200 },
  ));
  vi.stubGlobal("fetch", fetchFn);
  try {
    const getDecryptedProfileApiKey = vi.fn(() => "profile-secret");
    const result = await tryHandleAiOwnedRequest(
      {
        type: "ai.list-models.request",
        apiFormat: "openai_chat",
        baseUrl: "https://draft.example.invalid/v1",
        profileId: "ai_000000000000000000000006",
      },
      runtime({
        loadAiConfig: () => config({
          profiles: [{
            id: "ai_000000000000000000000006",
            name: "Saved profile with an older endpoint",
            apiFormat: "anthropic",
            model: "saved-model",
            baseUrl: "https://saved.example.invalid",
            hasCredential: true,
          }],
        }),
        getDecryptedProfileApiKey,
      }),
    );

    expect(getDecryptedProfileApiKey).toHaveBeenCalledWith("ai_000000000000000000000006");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://draft.example.invalid/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer profile-secret" }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      type: "ai.list-models.result",
      models: ["draft-model"],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
