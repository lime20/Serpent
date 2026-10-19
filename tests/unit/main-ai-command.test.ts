import { expect, test } from "vitest";

import { DEFAULT_AI_ANALYSIS_SETTINGS } from "../../src/shared/ai-analysis-settings";
import { executeAiMainCommand } from "../../src/main/commands/ai";
import { parseWorkerRequest } from "../../src/shared/protocol/requests";

test("ai.config.get stays on the Main-owned config path", () => {
  expect(executeAiMainCommand(
    { type: "ai.config.get.request" },
    {
      loadAiConfig: () => { throw new Error("unused"); },
      getDecryptedApiKey: () => { throw new Error("unused"); },
    },
  )).toBeUndefined();
});

test("ai.test-connection prefers the request api key", () => {
  expect(executeAiMainCommand(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      apiKey: "sk-test",
    },
    {
      loadAiConfig: () => { throw new Error("unused"); },
      getDecryptedApiKey: () => { throw new Error("stored key"); },
    },
  )).toEqual({
    type: "ai.test-connection",
    apiFormat: "openai_chat",
    model: "gpt-4o",
    apiKey: "sk-test",
  });
});

test("asset.analyze maps stored config onto the worker command", () => {
  expect(executeAiMainCommand(
    {
      type: "asset.analyze.request",
      libraryId: "lib-1",
      assetId: "asset-1",
    },
    {
      loadAiConfig: () => ({
        hasKey: true,
        apiFormat: "openai_chat",
        model: "gpt-4o",
        baseUrl: "",
        descriptionEnabled: true,
        tagEnabled: false,
        ratingEnabled: false,
        analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
        languages: ["zh-CN"],
        maxAnalysisImageEdgePx: 2048,
      }),
      getDecryptedApiKey: () => "sk-stored",
    },
  )).toMatchObject({
    type: "asset.analyze",
    libraryId: "lib-1",
    assetId: "asset-1",
    apiFormat: "openai_chat",
    model: "gpt-4o",
    apiKey: "sk-stored",
    enabledFields: { description: true, tags: false, rating: false },
    languages: ["zh-CN"],
    maxAnalysisImageEdgePx: 2048,
  });
});

/**
 * The Worker validates every command with `parseWorkerRequest`, so a Main
 * command carrying a keyless local profile must survive that boundary — the
 * empty key is the whole point of `local_openai`.
 */
test("keyless local commands survive the Main→Worker schema", () => {
  const localConfig = {
    hasKey: false,
    apiFormat: "local_openai" as const,
    model: "qwen2.5vl:7b",
    baseUrl: "http://127.0.0.1:11434/v1",
    descriptionEnabled: true,
    tagEnabled: true,
    ratingEnabled: true,
    analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
    languages: ["zh-CN"] as Array<"zh-CN" | "en" | "ja" | "ko">,
    maxAnalysisImageEdgePx: 2048,
  };
  const runtime = {
    loadAiConfig: () => localConfig,
    getDecryptedApiKey: () => "",
  };

  const testCommand = executeAiMainCommand(
    {
      type: "ai.test-connection.request",
      apiFormat: "local_openai",
      model: "qwen2.5vl:7b",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    runtime,
  );
  expect(testCommand).toMatchObject({ apiKey: "" });
  expect(() => parseWorkerRequest({ requestId: "req-1", command: testCommand }))
    .not.toThrow();

  const analyzeCommand = executeAiMainCommand(
    { type: "asset.analyze.request", libraryId: "lib-1", assetId: "asset-1" },
    runtime,
  );
  expect(analyzeCommand).toMatchObject({
    type: "asset.analyze",
    apiFormat: "local_openai",
    apiKey: "",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  expect(() => parseWorkerRequest({ requestId: "req-2", command: analyzeCommand }))
    .not.toThrow();
});

test("a whitespace-only key stays invalid on the Worker channel", () => {
  expect(() => parseWorkerRequest({
    requestId: "req-3",
    command: {
      type: "ai.test-connection",
      apiFormat: "local_openai",
      model: "qwen2.5vl:7b",
      apiKey: "   ",
    },
  })).toThrow();
});

/**
 * The fallback `executeAiMainCommand` path (used when a request is not caught by
 * the Main-owned AI handler) must reach the same keyless decision: testing an
 * unsaved local draft is allowed with no stored credential, while a cloud draft
 * still needs a typed or stored key.
 */
test("a keyless local draft is testable through the fallback command path", () => {
  const command = executeAiMainCommand(
    {
      type: "ai.test-connection.request",
      apiFormat: "local_openai",
      model: "qwen2.5vl:7b",
      baseUrl: "http://127.0.0.1:8000/v1",
    },
    {
      loadAiConfig: () => { throw new Error("unused"); },
      // The stored profile is still a cloud format with no key file.
      getDecryptedApiKey: () => { throw new Error("no stored key"); },
    },
  );
  expect(command).toEqual({
    type: "ai.test-connection",
    apiFormat: "local_openai",
    model: "qwen2.5vl:7b",
    apiKey: "",
    baseUrl: "http://127.0.0.1:8000/v1",
  });
});

test("a cloud draft still fails the fallback command path without a key", () => {
  expect(executeAiMainCommand(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "gpt-4o",
    },
    {
      loadAiConfig: () => { throw new Error("unused"); },
      getDecryptedApiKey: () => { throw new Error("no stored key"); },
    },
  )).toBeUndefined();
});
