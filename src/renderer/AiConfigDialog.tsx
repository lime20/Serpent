import { useEffect, useRef, useState } from "react";
import { createShellPortal } from "./ui/ShellStyleScope";

import {
  AI_OUTPUT_STYLES,
  normalizeAiMaxDescriptionCharsZh,
  normalizeAiMaxDescriptionWordsEn,
  normalizeAiMaxTags,
  type AiAnalysisSettingsWire,
  type AiOutputStyle,
} from "../shared/ai-analysis-settings";
import { normalizeAiAnalysisImageEdgePx } from "../shared/ai-analysis-image";
import { normalizeAiAnalysisConcurrency } from "../shared/ai-concurrency";
import {
  AI_API_FORMATS,
  AI_API_FORMAT_LABELS,
  AI_LANGUAGE_OPTIONS,
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODELS,
  aiApiFormatRequiresApiKey,
  type AiApiFormat,
  type AiLanguageId,
} from "../shared/ai-endpoints";
import {
  LOCAL_AI_PROVIDER_PRESETS,
  localModelLikelySupportsVision,
  type AiLocalEndpointDescriptor,
  type AiLocalEndpointDiscovery,
  type LocalAiProviderPreset,
} from "../shared/ai-local-endpoints";
import { Icon } from "./Icons";
import { AiConfigNumberInput } from "./ai-config-number-input";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import { DialogShell } from "./ui/patterns";

export type AiConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface AiConfigDialogProps {
  open: boolean;
  /** Renders inside the settings center instead of a modal dialog. */
  variant?: "dialog" | "embedded";
  apiKey: string;
  apiFormat: AiApiFormat;
  model: string;
  baseUrl: string;
  languages: AiLanguageId[];
  concurrencyLimit: number;
  maxAnalysisImageEdgePx: number;
  hasKey: boolean;
  descriptionEnabled: boolean;
  tagsEnabled: boolean;
  ratingEnabled: boolean;
  forceExistingTags: boolean;
  analysisSettings: AiAnalysisSettingsWire;
  disclaimerAccepted: boolean;
  autoAnalyzeEnabled: boolean;
  connectionState: AiConnectionState;
  connectionReason?: string;
  /** Shown while save is waiting on a connection probe. */
  saveVerifying?: boolean;
  onApiKeyChange: (value: string) => void;
  onApiFormatChange: (value: AiApiFormat) => void;
  onModelChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onLanguagesChange: (value: AiLanguageId[]) => void;
  onConcurrencyLimitChange: (value: number) => void;
  onMaxAnalysisImageEdgePxChange: (value: number) => void;
  onDescriptionEnabledChange: (value: boolean) => void;
  onTagsEnabledChange: (value: boolean) => void;
  onRatingEnabledChange: (value: boolean) => void;
  onForceExistingTagsChange: (value: boolean) => void;
  onAnalysisSettingsChange: (value: AiAnalysisSettingsWire) => void;
  /** Blur-commit for advanced numeric fields: updates state and persists. */
  onCommitAnalysisSettingsPatch?: (
    patch: Partial<AiAnalysisSettingsWire>,
  ) => void;
  onDisclaimerAcceptedChange: (value: boolean) => void;
  onAutoAnalyzeEnabledChange: (value: boolean) => void;
  onClose: () => void;
  onSave: () => void;
  onTestConnection: () => Promise<{
    success: boolean;
    reason?: string;
  }>;
  onFetchModels: () => Promise<{
    models: string[];
    visionModels?: string[];
    capabilitiesReported?: boolean;
    reason?: string;
  }>;
  /** Probe loopback ports and WSL addresses for local OpenAI-compatible servers. */
  onDiscoverLocalEndpoints: () => Promise<AiLocalEndpointDiscovery & { reason?: string }>;
}

const OUTPUT_STYLE_LABEL_KEY: Record<
  AiOutputStyle,
  "aiConfig.styleNormal" | "aiConfig.styleConcise" | "aiConfig.styleRigorous"
> = {
  normal: "aiConfig.styleNormal",
  concise: "aiConfig.styleConcise",
  rigorous: "aiConfig.styleRigorous",
};

export function AiConfigDialog({
  open,
  variant = "dialog",
  apiKey,
  apiFormat,
  model,
  baseUrl,
  languages,
  concurrencyLimit,
  maxAnalysisImageEdgePx,
  hasKey,
  descriptionEnabled,
  tagsEnabled,
  ratingEnabled,
  forceExistingTags,
  analysisSettings,
  disclaimerAccepted,
  autoAnalyzeEnabled,
  connectionState,
  connectionReason,
  saveVerifying = false,
  onApiKeyChange,
  onApiFormatChange,
  onModelChange,
  onBaseUrlChange,
  onLanguagesChange,
  onConcurrencyLimitChange,
  onMaxAnalysisImageEdgePxChange,
  onDescriptionEnabledChange,
  onTagsEnabledChange,
  onRatingEnabledChange,
  onForceExistingTagsChange,
  onAnalysisSettingsChange,
  onCommitAnalysisSettingsPatch,
  onDisclaimerAcceptedChange,
  onAutoAnalyzeEnabledChange,
  onClose,
  onSave,
  onTestConnection,
  onFetchModels,
  onDiscoverLocalEndpoints,
}: AiConfigDialogProps) {
  const t = useT();
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  /**
   * Vision capability as *reported by the endpoint* (llama.cpp and newer
   * Ollama list `capabilities`). When the server answers this question we must
   * not second-guess it with a name heuristic — that produced false "may not
   * accept images" warnings for perfectly multimodal GGUF models.
   */
  const [visionModels, setVisionModels] = useState<string[]>([]);
  const [capabilitiesReported, setCapabilitiesReported] = useState(false);
  const [busyAction, setBusyAction] = useState<"test" | "models" | "local" | null>(
    null,
  );
  const [modelsMessage, setModelsMessage] = useState<string | null>(null);
  const [localDiscovery, setLocalDiscovery] =
    useState<AiLocalEndpointDiscovery | null>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [testInline, setTestInline] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerMenuBox, setModelPickerMenuBox] = useState<{
    top: number;
    left: number;
    width: number;
    inModal: boolean;
  } | null>(null);
  const modelsFetchInFlightRef = useRef(false);
  const modelPickerWrapRef = useRef<HTMLDivElement>(null);
  const modelPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPickerMenuRef = useRef<HTMLUListElement>(null);
  const fetchedForRef = useRef<string | null>(null);

  const canUseKey = Boolean(apiKey.trim()) || hasKey;
  /**
   * A local runtime is keyless: the API key field stays optional and none of
   * the credential gates may block test / save / model listing.
   */
  const keylessFormat = !aiApiFormatRequiresApiKey(apiFormat);
  const canUseCredentials = canUseKey || keylessFormat;
  const language = languages[0] ?? "zh-CN";
  const modelsFetchKey = `${apiFormat}|${baseUrl.trim()}|${apiKey.trim() ? "typed" : hasKey ? "stored" : "none"}`;
  const localFailed =
    apiFormat === "local_openai" &&
    (testInline?.ok === false || connectionState === "error");

  /**
   * `vision` — the endpoint (or a known model family) accepts images.
   * `no-vision` — the endpoint reported capabilities and omitted vision.
   * `unknown` — nobody said anything; the name looks text-only.
   */
  function visionVerdict(modelId: string): "vision" | "no-vision" | "unknown" {
    if (visionModels.includes(modelId)) return "vision";
    if (capabilitiesReported) return "no-vision";
    return localModelLikelySupportsVision(modelId) ? "vision" : "unknown";
  }

  /** Warn only when there is a reason to: reported text-only, or an unknown name. */
  function showsVisionWarning(modelId: string): boolean {
    return visionVerdict(modelId) !== "vision";
  }

  function patchSettings(patch: Partial<AiAnalysisSettingsWire>) {
    onAnalysisSettingsChange({ ...analysisSettings, ...patch });
  }

  function commitNumericSettings(patch: Partial<AiAnalysisSettingsWire>) {
    if (onCommitAnalysisSettingsPatch) {
      onCommitAnalysisSettingsPatch(patch);
      return;
    }
    patchSettings(patch);
  }

  async function runTest() {
    setBusyAction("test");
    setTestInline(null);
    try {
      const result = await onTestConnection();
      setTestInline({
        ok: result.success,
        text: result.success
          ? t("aiConfig.testOk")
          : (result.reason ?? t("aiConfig.testFailed")),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function runFetchModels(options?: { quiet?: boolean }) {
    if (!canUseCredentials || modelsFetchInFlightRef.current) return;
    modelsFetchInFlightRef.current = true;
    setBusyAction("models");
    if (!options?.quiet) setModelsMessage(null);
    try {
      const result = await onFetchModels();
      fetchedForRef.current = modelsFetchKey;
      setVisionModels(result.visionModels ?? []);
      setCapabilitiesReported(result.capabilitiesReported === true);
      if (result.models.length > 0) {
        setModelOptions(result.models);
        setModelsMessage(
          options?.quiet
            ? null
            : t("aiConfig.fetchModelsOk").replace(
                "{count}",
                String(result.models.length),
              ),
        );
      } else {
        setModelOptions([]);
        setModelsMessage(result.reason ?? t("aiConfig.fetchModelsFailed"));
      }
    } finally {
      modelsFetchInFlightRef.current = false;
      setBusyAction(null);
    }
  }

  /**
   * Point the draft at a discovered server. Only a model that the endpoint
   * does not actually serve is replaced, so a deliberate choice survives.
   */
  function applyLocalEndpoint(endpoint: AiLocalEndpointDescriptor) {
    onBaseUrlChange(endpoint.baseUrl);
    const currentModel = model.trim();
    // Trust the runtime's own capability report for the model we auto-pick.
    const declaredVision = endpoint.visionModels ?? [];
    const capabilitiesKnown = endpoint.capabilitiesReported === true;
    setVisionModels(declaredVision);
    setCapabilitiesReported(capabilitiesKnown);
    if (!currentModel || !endpoint.models.includes(currentModel)) {
      const preferred =
        declaredVision[0] ??
        endpoint.models.find((id) => localModelLikelySupportsVision(id)) ??
        endpoint.models[0];
      if (preferred) onModelChange(preferred);
    }
    setModelOptions(endpoint.models);
    setModelsMessage(null);
    setTestInline(null);
    fetchedForRef.current = null;
  }

  function applyLocalPreset(preset: LocalAiProviderPreset) {
    onBaseUrlChange(preset.baseUrl);
    if (!model.trim()) onModelChange(preset.suggestedModel);
    setModelOptions([]);
    setModelsMessage(null);
    setTestInline(null);
    fetchedForRef.current = null;
  }

  async function runDiscoverLocalEndpoints(options?: {
    /** Fill the draft automatically when exactly one server answers. */
    autoApplySingle?: boolean;
  }) {
    setBusyAction("local");
    setLocalMessage(null);
    try {
      const result = await onDiscoverLocalEndpoints();
      setLocalDiscovery({
        endpoints: result.endpoints,
        wslAvailable: result.wslAvailable,
        wslDistros: result.wslDistros,
        ...(result.wslError ? { wslError: result.wslError } : {}),
      });
      if (result.reason) {
        setLocalMessage(result.reason);
      } else if (result.endpoints.length === 0) {
        setLocalMessage(
          result.wslAvailable
            ? t("aiConfig.localDiscoverEmptyWsl")
            : t("aiConfig.localDiscoverEmpty"),
        );
      } else {
        if (options?.autoApplySingle && result.endpoints.length === 1) {
          applyLocalEndpoint(result.endpoints[0]!);
        }
        setLocalMessage(
          t("aiConfig.localDiscoverOk").replace(
            "{count}",
            String(result.endpoints.length),
          ),
        );
      }
    } finally {
      setBusyAction(null);
    }
  }

  function syncModelPickerMenuBox() {
    const trigger = modelPickerTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 180);
    const maxHeight = Math.min(240, window.innerHeight * 0.4);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const openUpward = spaceBelow < Math.min(maxHeight, 120) && rect.top > spaceBelow;
    const top = openUpward
      ? Math.max(8, rect.top - maxHeight - 4)
      : rect.bottom + 4;
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - width - 8,
    );
    setModelPickerMenuBox({ top, left, width, inModal: trigger.closest('[role="dialog"]') !== null });
  }

  async function toggleModelPicker() {
    if (!canUseCredentials) return;
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      setModelPickerMenuBox(null);
      return;
    }
    setModelPickerOpen(true);
    syncModelPickerMenuBox();
    if (
      fetchedForRef.current !== modelsFetchKey ||
      modelOptions.length === 0
    ) {
      await runFetchModels();
      syncModelPickerMenuBox();
    }
  }

  function handleApiFormatChange(next: AiApiFormat) {
    const previousDefault = DEFAULT_AI_BASE_URLS[apiFormat];
    const current = baseUrl.trim();
    const usedDefaultEndpoint = !current || current === previousDefault;
    onApiFormatChange(next);
    if (usedDefaultEndpoint) {
      // A local endpoint has no cloud default to fall back to, so show the
      // stock Ollama root instead of an empty field.
      onBaseUrlChange(next === "local_openai" ? DEFAULT_AI_BASE_URLS[next] : "");
    }
    setModelOptions([]);
    setVisionModels([]);
    setCapabilitiesReported(false);
    setModelsMessage(null);
    setLocalDiscovery(null);
    setLocalMessage(null);
    setTestInline(null);
    setModelPickerOpen(false);
    setModelPickerMenuBox(null);
    fetchedForRef.current = null;
    if (next === "local_openai" && usedDefaultEndpoint) {
      // The stock default is Ollama's port. Rather than leave the user on an
      // endpoint that may not exist, probe once and fill in a single answer.
      void runDiscoverLocalEndpoints({ autoApplySingle: true });
    }
  }

  // Prefetch so the first dropdown open usually already has options.
  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setModelPickerOpen(false);
        setModelPickerMenuBox(null);
      });
      return;
    }
    if (!canUseCredentials) return;
    if (fetchedForRef.current === modelsFetchKey && modelOptions.length > 0) {
      return;
    }
    void runFetchModels({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint-driven
  }, [open, modelsFetchKey, canUseCredentials]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    syncModelPickerMenuBox();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modelPickerWrapRef.current?.contains(target)) return;
      if (modelPickerMenuRef.current?.contains(target)) return;
      setModelPickerOpen(false);
      setModelPickerMenuBox(null);
    };
    const onReposition = () => syncModelPickerMenuBox();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onReposition);
    // Dialog body scrolls clip absolute menus; keep fixed menu glued to trigger.
    document.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("scroll", onReposition, true);
    };
  }, [modelPickerOpen]);

  if (!open) return null;

  const busy = busyAction !== null || saveVerifying;
  const embedded = variant === "embedded";
  const pickerLabel =
    busyAction === "models"
      ? t("aiConfig.fetchingModels")
      : modelOptions.includes(model)
        ? model
        : modelOptions.length > 0
          ? t("aiConfig.modelPick")
          : t("aiConfig.modelPickEmpty");

  const showHeading =
    !embedded || connectionState !== "idle" || Boolean(connectionReason);

  const content = (
    <>
        {showHeading ? (
          <div className="dialog-heading">
            <div className="ai-config-heading-main">
              {!embedded ? <h2>{t("aiConfig.title")}</h2> : null}
              {connectionState !== "idle" ? (
                <div
                  className="ai-connection-indicator"
                  data-state={connectionState}
                  role="status"
                >
                  <span aria-hidden="true" className="ai-connection-dot" />
                  <span className="ai-connection-label">
                    {connectionState === "connecting"
                      ? t("aiConfig.connectionConnecting")
                      : connectionState === "connected"
                        ? t("aiConfig.connectionConnected")
                        : connectionState === "error"
                          ? t("aiConfig.connectionError")
                          : t("aiConfig.connectionDisconnected")}
                  </span>
                  {connectionReason ? (
                    <span
                      className="ai-connection-reason"
                      data-hover-tip={connectionReason}
                    >
                      {connectionReason}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {!embedded ? (
              <button
                className="dialog-close"
                onClick={onClose}
                type="button"
                {...iconActionAttrs(t("common.cancel"))}
              >
                <Icon name="close" size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="ai-config-dialog-body">
          <p className="ai-config-note">{t("aiConfig.note")}</p>
          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="ai-config-api-format">
              {t("aiConfig.apiFormat")}
            </label>
            <select
              className="text-field ai-config-input"
              id="ai-config-api-format"
              onChange={(e) =>
                handleApiFormatChange(e.target.value as AiApiFormat)
              }
              value={apiFormat}
            >
              {AI_API_FORMATS.map((id) => (
                <option key={id} value={id}>
                  {AI_API_FORMAT_LABELS[id]}
                </option>
              ))}
            </select>
            <p className="ai-config-hint">{t("aiConfig.apiFormatHint")}</p>
          </div>
          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="ai-config-base-url">
              {t("aiConfig.baseUrl")}
            </label>
            <input
              className="text-field ai-config-input"
              id="ai-config-base-url"
              maxLength={2048}
              onChange={(e) => {
                onBaseUrlChange(e.target.value);
                setTestInline(null);
              }}
              placeholder={DEFAULT_AI_BASE_URLS[apiFormat]}
              spellCheck={false}
              value={baseUrl}
            />
            <p className="ai-config-hint">
              {apiFormat === "dashscope_native"
                ? t("aiConfig.dashscopeBaseUrlHint")
                : apiFormat === "local_openai"
                  ? t("aiConfig.localBaseUrlHint")
                  : t("aiConfig.baseUrlHint")}
            </p>
          </div>
          {apiFormat === "local_openai" ? (
            <div className="ai-config-local">
              <p className="ai-config-hint ai-config-local-intro">
                {t("aiConfig.localIntro")}
              </p>
              <div className="ai-config-local-presets">
                {LOCAL_AI_PROVIDER_PRESETS.map((preset) => (
                  <button
                    className="secondary-button ai-config-local-preset"
                    key={preset.id}
                    onClick={() => applyLocalPreset(preset)}
                    type="button"
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  className="secondary-button ai-config-local-discover"
                  disabled={busy}
                  onClick={() => void runDiscoverLocalEndpoints()}
                  type="button"
                >
                  {busyAction === "local"
                    ? t("aiConfig.localDiscovering")
                    : t("aiConfig.localDiscover")}
                </button>
              </div>
              {localMessage ? (
                <p className="ai-config-hint" role="status">
                  {localMessage}
                </p>
              ) : null}
              {localDiscovery && localDiscovery.endpoints.length > 0 ? (
                <ul
                  aria-label={t("aiConfig.localDiscoveredLabel")}
                  className="ai-config-local-endpoints"
                >
                  {localDiscovery.endpoints.map((endpoint) => (
                    <li key={endpoint.baseUrl}>
                      <button
                        className="ai-config-local-endpoint"
                        onClick={() => applyLocalEndpoint(endpoint)}
                        type="button"
                      >
                        <span className="ai-config-local-endpoint-main">
                          {endpoint.runtime ??
                            t("aiConfig.localRuntimeUnknown")}{" "}
                          · {endpoint.baseUrl}
                        </span>
                        <span className="ai-config-local-endpoint-meta">
                          {endpoint.source === "wsl"
                            ? t("aiConfig.localSourceWsl")
                            : t("aiConfig.localSourceLoopback")}
                          {" · "}
                          {t("aiConfig.localModelCount").replace(
                            "{count}",
                            String(endpoint.models.length),
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {localFailed ? (
                <p className="ai-config-hint ai-config-local-troubleshoot">
                  {t("aiConfig.localTroubleshoot")}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="ai-config-api-key">
              {t("aiConfig.apiKey")}
            </label>
            <div className="field-with-visibility-toggle">
              <input
                className="text-field ai-config-input field-with-visibility-input"
                id="ai-config-api-key"
                maxLength={512}
                onChange={(e) => {
                  onApiKeyChange(e.target.value);
                  setTestInline(null);
                }}
                placeholder={
                  keylessFormat
                    ? t("aiConfig.localApiKeyPlaceholder")
                    : hasKey
                      ? t("aiConfig.apiKeyConfigured")
                      : "sk-…"
                }
                type={showApiKey ? "text" : "password"}
                value={apiKey}
              />
              <button
                className="visibility-toggle"
                onClick={() => setShowApiKey((prev) => !prev)}
                type="button"
                {...iconActionAttrs(
                  showApiKey
                    ? t("aiConfig.hideApiKey")
                    : t("aiConfig.showApiKey"),
                )}
              >
                <Icon name={showApiKey ? "eye-off" : "eye"} size={14} />
              </button>
            </div>
            {keylessFormat ? (
              <p className="ai-config-hint">{t("aiConfig.localApiKeyHint")}</p>
            ) : null}
          </div>
          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="ai-config-model">
              {t("aiConfig.model")}
            </label>
            <div className="ai-config-model-row">
              <input
                className="text-field ai-config-input"
                id="ai-config-model"
                maxLength={255}
                onChange={(e) => {
                  onModelChange(e.target.value);
                  setTestInline(null);
                }}
                placeholder={DEFAULT_AI_MODELS[apiFormat]}
                value={model}
              />
              <div
                className="ai-config-model-picker-wrap"
                ref={modelPickerWrapRef}
              >
                <button
                  aria-expanded={modelPickerOpen}
                  aria-haspopup="listbox"
                  aria-label={t("aiConfig.modelPick")}
                  className="text-field ai-config-input ai-config-model-picker-trigger"
                  disabled={!canUseCredentials}
                  onClick={() => void toggleModelPicker()}
                  ref={modelPickerTriggerRef}
                  data-hover-tip={
                    !canUseCredentials
                      ? t("aiConfig.modelPickEmpty")
                      : t("aiConfig.modelPick")
                  }
                  type="button"
                >
                  <span className="ai-config-model-picker-label">
                    {pickerLabel}
                  </span>
                  <Icon name="chevron" size={12} />
                </button>
                {modelPickerOpen && modelPickerMenuBox
                  ? createShellPortal(
                      <ul
                        aria-label={t("aiConfig.modelPick")}
                        className="ui-menu-surface ai-config-model-picker-menu is-portaled"
                        data-modal-popover={modelPickerMenuBox.inModal || undefined}
                        ref={modelPickerMenuRef}
                        role="listbox"
                        style={{
                          top: modelPickerMenuBox.top,
                          left: modelPickerMenuBox.left,
                          width: modelPickerMenuBox.width,
                        }}
                      >
                        {busyAction === "models" &&
                        modelOptions.length === 0 ? (
                          <li
                            className="ai-config-model-picker-empty"
                            role="option"
                          >
                            {t("aiConfig.fetchingModels")}
                          </li>
                        ) : modelOptions.length === 0 ? (
                          <li
                            className="ai-config-model-picker-empty"
                            role="option"
                          >
                            {modelsMessage ?? t("aiConfig.modelPickEmpty")}
                          </li>
                        ) : (
                          modelOptions.map((id) => (
                            <li key={id} role="presentation">
                              <button
                                aria-selected={id === model}
                                className={
                                  id === model
                                    ? "ai-config-model-picker-option is-selected"
                                    : "ai-config-model-picker-option"
                                }
                                onClick={() => {
                                  onModelChange(id);
                                  setTestInline(null);
                                  setModelPickerOpen(false);
                                  setModelPickerMenuBox(null);
                                }}
                                role="option"
                                type="button"
                              >
                                {id}
                                {apiFormat === "local_openai" &&
                                showsVisionWarning(id) ? (
                                  <span className="ai-config-model-picker-warning">
                                    {t("aiConfig.localTextOnlyModel")}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          ))
                        )}
                      </ul>,
                      document.body,
                    )
                  : null}
              </div>
            </div>
            {modelsMessage ? (
              <p className="ai-config-hint" role="status">
                {modelsMessage}
              </p>
            ) : null}
            {apiFormat === "local_openai" &&
            model.trim() &&
            showsVisionWarning(model.trim()) ? (
              <p className="ai-config-hint ai-config-local-warning" role="status">
                {t("aiConfig.localTextOnlyWarning")}
              </p>
            ) : null}
          </div>
          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="ai-config-language">
              {t("aiConfig.language")}
            </label>
            <select
              className="text-field ai-config-input"
              id="ai-config-language"
              onChange={(e) =>
                onLanguagesChange([e.target.value as AiLanguageId])
              }
              value={language}
            >
              {AI_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.labelZh === option.labelEn
                    ? option.labelEn
                    : `${option.labelZh} / ${option.labelEn}`}
                </option>
              ))}
            </select>
            <p className="ai-config-hint">{t("aiConfig.languageHint")}</p>
          </div>
          <div className="ai-config-switches">
            <span className="micro-label ai-config-switches-title">
              {t("aiConfig.fieldSwitches")}
            </span>
            <div className="ai-config-switches-row">
              {(
                [
                  {
                    key: "description",
                    label: t("aiConfig.description"),
                    state: descriptionEnabled,
                    setter: onDescriptionEnabledChange,
                  },
                  {
                    key: "tags",
                    label: t("aiConfig.tags"),
                    state: tagsEnabled,
                    setter: onTagsEnabledChange,
                  },
                  {
                    key: "rating",
                    label: t("aiConfig.rating"),
                    state: ratingEnabled,
                    setter: onRatingEnabledChange,
                  },
                  {
                    key: "forceTags",
                    label: t("aiConfig.forceExistingTags"),
                    state: forceExistingTags,
                    setter: onForceExistingTagsChange,
                  },
                ] as const
              ).map((field) => (
                <label className="ai-config-check-row" key={field.key}>
                  <input
                    checked={field.state}
                    onChange={(e) => field.setter(e.target.checked)}
                    type="checkbox"
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </div>
          <details className="ai-config-advanced">
            <summary className="ai-config-advanced-summary">
              {t("aiConfig.advanced")}
            </summary>
            <div className="ai-config-advanced-body">
              <div className="editor-field ai-config-field">
                <label className="micro-label" htmlFor="ai-config-concurrency-limit">
                  {t("aiConfig.concurrencyLimit")}
                </label>
                <AiConfigNumberInput
                  id="ai-config-concurrency-limit"
                  normalize={normalizeAiAnalysisConcurrency}
                  onCommit={onConcurrencyLimitChange}
                  value={concurrencyLimit}
                />
                <p className="ai-config-hint">{t("aiConfig.concurrencyLimitHint")}</p>
              </div>
              <div className="editor-field ai-config-field">
                <label className="micro-label" htmlFor="ai-config-max-image-edge">
                  {t("aiConfig.maxAnalysisImageEdge")}
                </label>
                <AiConfigNumberInput
                  id="ai-config-max-image-edge"
                  normalize={normalizeAiAnalysisImageEdgePx}
                  onCommit={onMaxAnalysisImageEdgePxChange}
                  value={maxAnalysisImageEdgePx}
                />
                <p className="ai-config-hint">{t("aiConfig.maxAnalysisImageEdgeHint")}</p>
              </div>
              <div
                className={`editor-field ai-config-field${tagsEnabled ? "" : " is-disabled"}`}
              >
                <label className="micro-label" htmlFor="ai-config-max-tags">
                  {t("aiConfig.maxTags")}
                </label>
                <AiConfigNumberInput
                  disabled={!tagsEnabled}
                  id="ai-config-max-tags"
                  normalize={normalizeAiMaxTags}
                  onCommit={(maxTags) => commitNumericSettings({ maxTags })}
                  value={analysisSettings.maxTags}
                />
              </div>
              <div
                className={`editor-field ai-config-field${tagsEnabled ? "" : " is-disabled"}`}
              >
                <label className="micro-label" htmlFor="ai-config-custom-tag-prompt">
                  {t("aiConfig.customTagPrompt")}
                </label>
                <textarea
                  className="text-field ai-config-input ai-config-textarea"
                  disabled={!tagsEnabled}
                  id="ai-config-custom-tag-prompt"
                  maxLength={4000}
                  onChange={(e) =>
                    patchSettings({ customTagPrompt: e.target.value })
                  }
                  rows={3}
                  value={analysisSettings.customTagPrompt}
                />
                <p className="ai-config-hint">
                  {t("aiConfig.customTagPromptHint")}
                </p>
              </div>
              <div
                className={`ai-config-advanced-row${descriptionEnabled ? "" : " is-disabled"}`}
              >
                <div className="editor-field ai-config-field">
                  <label
                    className="micro-label"
                    htmlFor="ai-config-max-desc-zh"
                  >
                    {t("aiConfig.maxDescriptionCharsZh")}
                  </label>
                  <AiConfigNumberInput
                    disabled={!descriptionEnabled}
                    id="ai-config-max-desc-zh"
                    normalize={normalizeAiMaxDescriptionCharsZh}
                    onCommit={(maxDescriptionCharsZh) =>
                      commitNumericSettings({ maxDescriptionCharsZh })
                    }
                    value={analysisSettings.maxDescriptionCharsZh}
                  />
                </div>
                <div className="editor-field ai-config-field">
                  <label
                    className="micro-label"
                    htmlFor="ai-config-max-desc-en"
                  >
                    {t("aiConfig.maxDescriptionWordsEn")}
                  </label>
                  <AiConfigNumberInput
                    disabled={!descriptionEnabled}
                    id="ai-config-max-desc-en"
                    normalize={normalizeAiMaxDescriptionWordsEn}
                    onCommit={(maxDescriptionWordsEn) =>
                      commitNumericSettings({ maxDescriptionWordsEn })
                    }
                    value={analysisSettings.maxDescriptionWordsEn}
                  />
                </div>
              </div>
              <div className="editor-field ai-config-field">
                <label className="micro-label" htmlFor="ai-config-output-style">
                  {t("aiConfig.outputStyle")}
                </label>
                <select
                  className="text-field ai-config-input"
                  id="ai-config-output-style"
                  onChange={(e) =>
                    patchSettings({
                      outputStyle: e.target.value as AiOutputStyle,
                    })
                  }
                  value={analysisSettings.outputStyle}
                >
                  {AI_OUTPUT_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {t(OUTPUT_STYLE_LABEL_KEY[style])}
                    </option>
                  ))}
                </select>
              </div>
              <div
                className={`editor-field ai-config-field${ratingEnabled ? "" : " is-disabled"}`}
              >
                <label className="micro-label" htmlFor="ai-config-rating-rubric">
                  {t("aiConfig.ratingRubric")}
                </label>
                <textarea
                  className="text-field ai-config-input ai-config-textarea"
                  disabled={!ratingEnabled}
                  id="ai-config-rating-rubric"
                  maxLength={4000}
                  onChange={(e) =>
                    patchSettings({ ratingRubric: e.target.value })
                  }
                  rows={3}
                  value={analysisSettings.ratingRubric}
                />
              </div>
              <div
                className={`editor-field ai-config-field${descriptionEnabled ? "" : " is-disabled"}`}
              >
                <label
                  className="micro-label"
                  htmlFor="ai-config-custom-desc-prompt"
                >
                  {t("aiConfig.customDescriptionPrompt")}
                </label>
                <textarea
                  className="text-field ai-config-input ai-config-textarea"
                  disabled={!descriptionEnabled}
                  id="ai-config-custom-desc-prompt"
                  maxLength={4000}
                  onChange={(e) =>
                    patchSettings({ customDescriptionPrompt: e.target.value })
                  }
                  rows={3}
                  value={analysisSettings.customDescriptionPrompt}
                />
                <p className="ai-config-hint">
                  {t("aiConfig.customDescriptionPromptHint")}
                </p>
              </div>
            </div>
          </details>
          <div className="ai-config-consent">
            <label className="ai-config-check-row ai-config-check-row-top">
              <input
                checked={disclaimerAccepted}
                onChange={(e) => {
                  onDisclaimerAcceptedChange(e.target.checked);
                  if (!e.target.checked) onAutoAnalyzeEnabledChange(false);
                }}
                type="checkbox"
              />
              <span>{t("aiConfig.disclaimer")}</span>
            </label>
            <label
              className="ai-config-check-row ai-config-check-row-indent"
              data-disabled={!disclaimerAccepted || undefined}
            >
              <input
                checked={autoAnalyzeEnabled}
                disabled={!disclaimerAccepted}
                onChange={(e) => onAutoAnalyzeEnabledChange(e.target.checked)}
                type="checkbox"
              />
              {t("aiConfig.autoAnalyze")}
            </label>
          </div>
        </div>
        <div className="dialog-actions ai-config-actions">
          <div className="ai-config-test-cluster">
            <button
              className="secondary-button"
              disabled={!canUseCredentials || !model.trim() || busy}
              onClick={() => void runTest()}
              type="button"
            >
              {busyAction === "test"
                ? t("aiConfig.testing")
                : t("aiConfig.testConnection")}
            </button>
            {testInline ? (
              <span
                className="ai-config-test-inline"
                data-ok={testInline.ok ? "true" : "false"}
                role="status"
              >
                {testInline.text}
              </span>
            ) : null}
          </div>
          <button
            className="primary-button"
            disabled={!canUseCredentials || !model.trim() || busy}
            onClick={() => void onSave()}
            type="button"
          >
            {saveVerifying ? t("aiConfig.savingVerifying") : t("aiConfig.save")}
          </button>
        </div>
        {saveVerifying ? (
          <p className="ai-config-save-wait" role="status">
            {t("aiConfig.saveVerifyingHint")}
          </p>
        ) : null}
    </>
  );

  if (embedded) {
    return (
      <div className="ai-config-embedded">
        <div>{content}</div>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <DialogShell
        className="create-dialog ai-config-dialog"
        contentClassName="ui-dialog-shell__content--flush"
        dialogId="ai-config-dialog"
        onRequestClose={onClose}
      >
        {content}
      </DialogShell>
    </div>
  );
}
