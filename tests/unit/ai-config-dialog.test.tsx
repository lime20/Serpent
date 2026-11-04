// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AI_ANALYSIS_SETTINGS, toWireAiAnalysisSettings } from "../../src/shared/ai-analysis-settings";
import { AiConfigDialog, type AiConfigDialogProps } from "../../src/renderer/AiConfigDialog";
import { LocaleProvider } from "../../src/renderer/i18n";

function makeProps(overrides: Partial<AiConfigDialogProps> = {}): AiConfigDialogProps {
  return {
    open: true,
    variant: "embedded",
    apiKey: "",
    profiles: [{ id: "local", name: "Local", apiFormat: "local_openai", model: "opaque-model", baseUrl: "http://127.0.0.1:8080/v1", hasCredential: false }],
    activeProfileId: null,
    profileDraftId: "local",
    profileName: "Local",
    apiFormat: "local_openai",
    model: "opaque-model",
    baseUrl: "http://127.0.0.1:8080/v1",
    languages: ["en"],
    concurrencyLimit: 2,
    maxAnalysisImageEdgePx: 2048,
    hasKey: false,
    descriptionEnabled: true,
    tagsEnabled: true,
    ratingEnabled: true,
    forceExistingTags: false,
    analysisSettings: toWireAiAnalysisSettings(DEFAULT_AI_ANALYSIS_SETTINGS),
    disclaimerAccepted: false,
    autoAnalyzeEnabled: false,
    connectionState: "idle",
    onApiKeyChange: vi.fn(),
    onProfileNameChange: vi.fn(),
    onNewProfile: vi.fn(),
    onSelectProfile: vi.fn(),
    onActivateProfile: vi.fn(),
    onDeleteProfile: vi.fn(),
    onClearCredential: vi.fn(),
    onApiFormatChange: vi.fn(),
    onModelChange: vi.fn(),
    onBaseUrlChange: vi.fn(),
    onLanguagesChange: vi.fn(),
    onConcurrencyLimitChange: vi.fn(),
    onMaxAnalysisImageEdgePxChange: vi.fn(),
    onDescriptionEnabledChange: vi.fn(),
    onTagsEnabledChange: vi.fn(),
    onRatingEnabledChange: vi.fn(),
    onForceExistingTagsChange: vi.fn(),
    onAnalysisSettingsChange: vi.fn(),
    onDisclaimerAcceptedChange: vi.fn(),
    onAutoAnalyzeEnabledChange: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn(),
    onTestConnection: vi.fn(async () => ({ success: true })),
    onFetchModels: vi.fn(async () => ({ models: ["opaque-model"], visionModels: ["opaque-model"], capabilitiesReported: true })),
    onDiscoverLocalEndpoints: vi.fn(async () => ({ endpoints: [], wslAvailable: false, wslDistros: [] })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AI configuration profiles and local endpoints", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  async function render(props: AiConfigDialogProps) {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(createElement(LocaleProvider, { children: null, initialPreference: "en" }, createElement(AiConfigDialog, props)));
    });
  }

  function button(label: string) {
    const result = [...container!.querySelectorAll("button")].find((entry) => entry.textContent === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it("can save, test, fetch models and activate a local profile without a key", async () => {
    const props = makeProps();
    await render(props);
    expect(props.onFetchModels).toHaveBeenCalledOnce();
    expect(button("Save configuration").disabled).toBe(false);
    expect(button("Test connection").disabled).toBe(false);
    expect(button("Set as current").disabled).toBe(false);
    expect(container!.textContent).not.toContain("Save an API key before");
    expect(container!.textContent).toContain("configured local model server");
    expect(container!.querySelector(".ai-config-local-warning")).toBeNull();
    await act(async () => {
      button("Set as current").click();
      button("Save configuration").click();
      button("Test connection").click();
    });
    expect(props.onActivateProfile).toHaveBeenCalledWith("local");
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onTestConnection).toHaveBeenCalledOnce();
  });

  it("keeps cloud profiles without credentials as savable drafts", async () => {
    const props = makeProps({
      apiFormat: "openai_chat",
      profiles: [{ id: "local", name: "Local", apiFormat: "openai_chat", model: "opaque-model", baseUrl: "http://127.0.0.1:8080/v1", hasCredential: false }],
    });
    await render(props);
    expect(props.onFetchModels).not.toHaveBeenCalled();
    expect(button("Save configuration").disabled).toBe(false);
    expect(button("Test connection").disabled).toBe(true);
    expect(button("Set as current").disabled).toBe(true);
    expect(container!.textContent).toContain("Save an API key before");
  });

  it("discards a previous profile's late model list and capability report", async () => {
    type Result = Awaited<ReturnType<AiConfigDialogProps["onFetchModels"]>>;
    const first = deferred<Result>();
    const second = deferred<Result>();
    const onFetchModels = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstProps = makeProps({ onFetchModels });
    await render(firstProps);
    const secondProps = makeProps({
      onFetchModels,
      profileDraftId: "other",
      profileName: "Other",
      baseUrl: "http://127.0.0.1:1234/v1",
      profiles: [{ id: "other", name: "Other", apiFormat: "local_openai", model: "opaque-model", baseUrl: "http://127.0.0.1:1234/v1", hasCredential: false }],
    });
    await render(secondProps);
    await act(async () => {
      first.resolve({ models: ["obsolete-model"], visionModels: ["opaque-model"], capabilitiesReported: true });
    });
    expect(onFetchModels).toHaveBeenCalledTimes(2);
    expect(container!.querySelector(".ai-config-local-warning")).not.toBeNull();
    expect(container!.textContent).not.toContain("Loaded 1 models");
    await act(async () => {
      second.resolve({ models: ["opaque-model"], visionModels: ["opaque-model"], capabilitiesReported: true });
    });
    expect(container!.querySelector(".ai-config-local-warning")).toBeNull();
    await act(async () => {
      container!.querySelector<HTMLButtonElement>(".ai-config-model-picker-trigger")!.click();
    });
    expect(document.querySelector(".ai-config-model-picker-menu")?.textContent).toContain("opaque-model");
    expect(document.querySelector(".ai-config-model-picker-menu")?.textContent).not.toContain("obsolete-model");
  });

  it("honors explicit text-only capabilities even for a model with a vision-like name", async () => {
    await render(makeProps({
      model: "qwen2.5vl:7b",
      onFetchModels: vi.fn(async () => ({ models: ["qwen2.5vl:7b"], visionModels: [], capabilitiesReported: true })),
    }));
    expect(container!.querySelector(".ai-config-local-warning")).not.toBeNull();
  });

  it("does not apply local discovery after the user selects another profile", async () => {
    const result = deferred<Awaited<ReturnType<AiConfigDialogProps["onDiscoverLocalEndpoints"]>>>();
    const onBaseUrlChange = vi.fn();
    const props = makeProps({ onBaseUrlChange, onDiscoverLocalEndpoints: vi.fn(() => result.promise) });
    await render(props);
    await act(async () => { button("Detect local / WSL servers").click(); });
    await render({ ...props, profileDraftId: "other", baseUrl: "http://127.0.0.1:1234/v1" });
    await act(async () => {
      result.resolve({
        endpoints: [{ presetId: "llamacpp", label: "llama.cpp", host: "127.0.0.1", port: 8080, source: "loopback", baseUrl: "http://127.0.0.1:8080/v1", models: ["discovered"] }],
        wslAvailable: false,
        wslDistros: [],
      });
    });
    expect(onBaseUrlChange).not.toHaveBeenCalled();
    expect(container!.querySelector(".ai-config-local-endpoint")).toBeNull();
  });

  it.each(["", "served-choice"])("applies automatic discovery while preserving a new model choice: %s", async (model) => {
    const result = deferred<Awaited<ReturnType<AiConfigDialogProps["onDiscoverLocalEndpoints"]>>>();
    const onBaseUrlChange = vi.fn();
    const props = makeProps({
      apiFormat: "openai_chat", baseUrl: "", model: "", profiles: [], profileDraftId: null,
      onBaseUrlChange, onDiscoverLocalEndpoints: vi.fn(() => result.promise),
    });
    await render(props);
    await act(async () => {
      container!.querySelector<HTMLButtonElement>("#ai-config-api-format")!.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="option"][data-value="local_openai"]')!.click();
    });
    await render({ ...props, apiFormat: "local_openai", baseUrl: "http://127.0.0.1:11434/v1", model });
    await act(async () => {
      result.resolve({
        endpoints: [{ presetId: "llamacpp", label: "llama.cpp", host: "127.0.0.1", port: 8080, source: "loopback", baseUrl: "http://127.0.0.1:8080/v1", models: ["opaque-model", "served-choice"], visionModels: ["opaque-model", "served-choice"], capabilitiesReported: true }],
        wslAvailable: false,
        wslDistros: [],
      });
    });
    expect(onBaseUrlChange).toHaveBeenLastCalledWith("http://127.0.0.1:8080/v1");
    if (model) expect(props.onModelChange).not.toHaveBeenCalled();
    else expect(props.onModelChange).toHaveBeenCalledWith("opaque-model");
  });
});
