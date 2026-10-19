/**
 * Local (host / WSL) AI endpoint helpers.
 *
 * Serpent runs OpenAI-compatible analysis requests against a runtime the user
 * started themselves — Ollama, LM Studio, llama.cpp or vLLM — usually inside a
 * WSL distribution on Windows. Everything here is transport-agnostic and
 * environment-free so both Main (probing, `wsl.exe` decoding) and the Renderer
 * (presets, model hints) can share one definition.
 *
 * This module deliberately does not import `ai-endpoints.ts`: the endpoint
 * module imports the local default from here, and a cycle would make the
 * default base URL undefined at module-evaluation time.
 */

/** Ollama's loopback OpenAI-compatible root; also the `local_openai` default. */
export const DEFAULT_LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434/v1';

/** Vision-capable Ollama default. Text-only models cannot analyze images. */
export const DEFAULT_LOCAL_AI_MODEL = 'qwen2.5vl:7b';

/**
 * Ports Serpent probes for a local server. These are the stock listen ports;
 * a user who changed theirs can still type the base URL by hand.
 */
export interface LocalAiProviderPreset {
  id: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm';
  /**
   * Button label. Deliberately carries the stock port: these are port
   * shortcuts, not a claim about what is listening. A llama.cpp server can be
   * started on 8000, so the real name comes from the server itself (see
   * `detectLocalRuntimeName`) once one answers.
   */
  label: string;
  baseUrl: string;
  /** Vision-capable model that the runtime commonly serves under this name. */
  suggestedModel: string;
}

export const LOCAL_AI_PROVIDER_PRESETS: readonly LocalAiProviderPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (11434)',
    baseUrl: DEFAULT_LOCAL_AI_BASE_URL,
    suggestedModel: DEFAULT_LOCAL_AI_MODEL,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (1234)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    suggestedModel: 'qwen2.5-vl-7b-instruct',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp (8080)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    suggestedModel: 'local-model',
  },
  {
    id: 'vllm',
    label: 'vLLM (8000)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    suggestedModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
  },
] as const;

/**
 * `owned_by` values local runtimes publish, mapped to a display name.
 *
 * Ollama's OpenAI-compatible route reports `library`, which says nothing to a
 * user; llama.cpp reports `llamacpp`; vLLM reports `vllm`. Unlisted but
 * well-formed owners are shown verbatim rather than guessed at.
 */
const LOCAL_RUNTIME_DISPLAY_NAMES: Record<string, string> = {
  library: 'Ollama',
  ollama: 'Ollama',
  llamacpp: 'llama.cpp',
  'llama.cpp': 'llama.cpp',
  'llama-cpp': 'llama.cpp',
  ggml: 'llama.cpp',
  vllm: 'vLLM',
  lmstudio: 'LM Studio',
  'lm-studio': 'LM Studio',
  koboldcpp: 'koboldcpp',
  sglang: 'SGLang',
  xinference: 'Xinference',
  localai: 'LocalAI',
  'text-generation-webui': 'text-generation-webui',
  oobabooga: 'text-generation-webui',
  tabbyapi: 'TabbyAPI',
  aphrodite: 'Aphrodite',
  jan: 'Jan',
};

/**
 * Name the runtime that actually answered.
 *
 * Returns `undefined` when nothing identifies it: the settings panel then says
 * "OpenAI-compatible server" instead of repeating the port preset's brand,
 * which for a `llama-server --port 8000` would have claimed "vLLM".
 */
export function detectLocalRuntimeName(input: {
  owners?: readonly (string | undefined)[];
  /** True when Ollama's native `/api/tags` route answered; only Ollama has it. */
  ollamaNativeRouteAnswered?: boolean;
}): string | undefined {
  if (input.ollamaNativeRouteAnswered) return 'Ollama';
  for (const owner of input.owners ?? []) {
    const normalized = owner?.trim().toLowerCase();
    if (!normalized) continue;
    const known = LOCAL_RUNTIME_DISPLAY_NAMES[normalized];
    if (known) return known;
    if (/^[a-z0-9][a-z0-9 ._-]{0,31}$/u.test(normalized)) return normalized;
  }
  return undefined;
}

/**
 * Hosts probed inside one WSL/Windows network namespace. `127.0.0.1` covers
 * WSL2 localhost forwarding and mirrored networking; the distribution's own
 * address is appended by Main for NAT-mode distributions.
 */
export const LOCAL_AI_LOOPBACK_HOSTS: readonly string[] = [
  '127.0.0.1',
] as const;

export interface LocalAiProbeTarget {
  presetId: LocalAiProviderPreset['id'];
  label: string;
  baseUrl: string;
  host: string;
  port: number;
  suggestedModel: string;
}

/** One answering local server, as reported to the settings UI. */
export interface AiLocalEndpointDescriptor {
  presetId: LocalAiProviderPreset['id'];
  label: string;
  baseUrl: string;
  host: string;
  port: number;
  /** `loopback` reached via 127.0.0.1, `wsl` via a distribution address. */
  source: 'loopback' | 'wsl';
  models: string[];
  /** Models the runtime itself declared vision/multimodal. */
  visionModels?: string[];
  /** True when the runtime reported capabilities at all. */
  capabilitiesReported?: boolean;
  /** Runtime that answered, e.g. `llama.cpp`; absent when unidentified. */
  runtime?: string;
  wslDistro?: string;
}

export interface AiLocalEndpointDiscovery {
  endpoints: AiLocalEndpointDescriptor[];
  /** False on macOS/Linux and when `wsl.exe` is missing or not installed. */
  wslAvailable: boolean;
  wslDistros: string[];
  /** Stable code (`WSL_UNAVAILABLE`, `WSL_ADDRESS_UNAVAILABLE`). */
  wslError?: string;
}

function portFromBaseUrl(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

/** Presets × hosts, as concrete probe targets. */
export function localAiProbeTargets(
  hosts: readonly string[] = LOCAL_AI_LOOPBACK_HOSTS,
): LocalAiProbeTarget[] {
  const targets: LocalAiProbeTarget[] = [];
  for (const host of hosts) {
    const normalizedHost = host.trim();
    if (!normalizedHost) continue;
    for (const preset of LOCAL_AI_PROVIDER_PRESETS) {
      let baseUrl: string;
      try {
        const parsed = new URL(preset.baseUrl);
        parsed.hostname = normalizedHost;
        baseUrl = parsed.toString().replace(/\/+$/u, '');
      } catch {
        continue;
      }
      targets.push({
        presetId: preset.id,
        label: preset.label,
        baseUrl,
        host: normalizedHost,
        port: portFromBaseUrl(preset.baseUrl),
        suggestedModel: preset.suggestedModel,
      });
    }
  }
  return targets;
}

/**
 * Ollama's native tag list. Older builds answer `/api/tags` even when the
 * OpenAI-compatible `/v1/models` route is missing or incomplete, so a local
 * model picker falls back to it before giving up.
 */
export function localAiNativeTagsUrl(baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return undefined;
  }
  const path = parsed.pathname.replace(/\/+$/u, '').replace(/\/v1$/iu, '');
  parsed.pathname = `${path}/api/tags`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** One model as a local runtime describes it in its model list. */
export interface LocalAiModelEntry {
  id: string;
  /** Server-declared capabilities; empty when the runtime reports none. */
  capabilities: string[];
  /** `owned_by` from an OpenAI-shaped row, lower-cased. */
  owner?: string;
}

function capabilitiesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = nonEmptyString(item);
    if (text) result.push(text.toLowerCase());
  }
  return result;
}

/**
 * llama.cpp reports `capabilities: ["completion","multimodal"]` and Ollama
 * reports `["vision", …]`. Either is a direct answer to "can this model accept
 * the image analysis sends?", which beats any name heuristic.
 */
export function modelCapabilitiesDeclareVision(
  capabilities: readonly string[],
): boolean {
  return capabilities.some(
    (capability) =>
      capability === 'multimodal' ||
      capability === 'vision' ||
      capability === 'image' ||
      capability === 'image-input' ||
      capability === 'image_text_to_text',
  );
}

/** `{ models: [{ name, model, capabilities }] }` → unique entries. */
export function parseOllamaTagModelEntries(body: unknown): LocalAiModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const entries: LocalAiModelEntry[] = [];
  const seen = new Set<string>();
  for (const row of models) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { name?: unknown; model?: unknown; capabilities?: unknown };
    const id = nonEmptyString(record.name) ?? nonEmptyString(record.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, capabilities: capabilitiesFrom(record.capabilities) });
  }
  return entries;
}

/**
 * `{ data: [{ id, capabilities }] }` → unique entries (OpenAI-shaped).
 *
 * llama.cpp answers `/v1/models` with *both* an OpenAI `data` array and an
 * Ollama-style `models` array, and only the latter carries `capabilities`.
 * Capabilities are merged across the two shapes so a llama.cpp server's
 * multimodal declaration is still visible.
 */
export function parseOpenAiStyleModelEntries(body: unknown): LocalAiModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const capabilityById = new Map(
    parseOllamaTagModelEntries(body).map((entry) => [entry.id, entry.capabilities]),
  );
  const entries: LocalAiModelEntry[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { id?: unknown; capabilities?: unknown; owned_by?: unknown };
    const id = nonEmptyString(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const own = capabilitiesFrom(record.capabilities);
    const owner = nonEmptyString(record.owned_by)?.toLowerCase();
    entries.push({
      id,
      capabilities: own.length > 0 ? own : (capabilityById.get(id) ?? []),
      ...(owner ? { owner } : {}),
    });
  }
  return entries;
}

/** `{ models: [{ name, model }] }` → unique model names. */
export function parseOllamaTagsModelIds(body: unknown): string[] {
  return parseOllamaTagModelEntries(body).map((entry) => entry.id);
}

const VISION_MODEL_PATTERN =
  /(?:^|[/:_-])(?:llava|bakllava|llama3\.2-vision|llama-?3\.2-?vision|minicpm-?v|moondream|qwen2\.5-?vl|qwen2-?vl|qwen3-?vl|qwen-?vl|internvl|pixtral|gemma-?3|granite3\.2-vision|smolvlm|phi-3\.5-vision|phi-4-multimodal|glm-4\.?[15]?v|llama-?4|mistral-small3|deepseek-?vl|janus|ovis|vision|multimodal|vl)\d*(?:[/:_-]|$)/iu;

/**
 * Best-effort vision-capability hint for a local model id.
 *
 * Analysis always sends an image, so a text-only model is the single most
 * common local setup mistake. This is a naming heuristic, not a capability
 * probe: it only ever drives a *warning* label, never a hard block, so a false
 * "may not accept images" verdict is recoverable by running the connection
 * test.
 */
export function localModelLikelySupportsVision(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  return VISION_MODEL_PATTERN.test(id.replace(/\s+/gu, '-'));
}

/**
 * `wsl.exe -l -q` writes UTF-16LE while most other WSL tooling writes UTF-8.
 * Detect rather than assume, so both shapes decode.
 */
export function decodeWslOutput(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const sampled = Math.min(bytes.length, 4096);
  let zeroAtOdd = 0;
  let zeroAtEven = 0;
  for (let index = 0; index < sampled; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 1) zeroAtOdd += 1;
    else zeroAtEven += 1;
  }
  // ASCII text encoded as UTF-16LE has a NUL in every high byte.
  const isUtf16Le = zeroAtOdd > 0 && zeroAtOdd >= zeroAtEven * 4;
  const decoder = new TextDecoder(isUtf16Le ? 'utf-16le' : 'utf-8');
  return decoder.decode(bytes).replaceAll('\u0000', '');
}

export function parseWslDistroList(raw: string): string[] {
  const names = raw
    .split(/\r?\n/u)
    .map((line) => line.replaceAll('\u0000', '').trim())
    .filter((line) => line.length > 0 && !/^windows subsystem/iu.test(line));
  return [...new Set(names)];
}

/** `wsl hostname -I` prints space-separated addresses; IPv4 first. */
export function parseWslHostIps(raw: string): string[] {
  const tokens = raw
    .replaceAll('\u0000', '')
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const ipv4: string[] = [];
  const rest: string[] = [];
  for (const token of tokens) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(token)) ipv4.push(token);
    else if (/^[0-9a-f:]+$/iu.test(token) && token.includes(':')) rest.push(token);
  }
  return [...new Set([...ipv4, ...rest])];
}

/** True for loopback / link-local / RFC1918 hosts (a "local" server address). */
export function isLocalNetworkHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  if (!value) return false;
  if (value === 'localhost' || value === '::1') return true;
  if (/^127\./u.test(value)) return true;
  if (/^10\./u.test(value)) return true;
  if (/^192\.168\./u.test(value)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./u.test(value)) return true;
  if (/^169\.254\./u.test(value)) return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(value)) return true;
  if (/^fe80:/u.test(value)) return true;
  return false;
}

/**
 * Strip the OpenAI version segment so a local base URL can also be shown as
 * the plain origin (used for copy/diagnostics and WSL reachability hints).
 */
export function localAiBaseUrlOrigin(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl.trim());
    return parsed.origin;
  } catch {
    return undefined;
  }
}
