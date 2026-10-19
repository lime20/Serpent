/**
 * AI endpoint helpers aligned with CC Switch `meta.apiFormat` wire protocols:
 * - openai_chat — OpenAI Chat Completions
 * - openai_responses — OpenAI Responses API
 * - anthropic — Anthropic Messages
 * - gemini_native — Google Gemini generateContent
 * - dashscope_native — Alibaba Cloud DashScope multimodal generation
 * - local_openai — Local OpenAI-compatible runtime (Ollama / LM Studio /
 *   llama.cpp / vLLM), typically served from the host or from WSL
 *
 * Base URL is a prefix (no trailing slash); paths are appended like CC Switch.
 * Every format but `local_openai` is BYOK; see `AI_KEYLESS_API_FORMATS`.
 */

import {
  DEFAULT_LOCAL_AI_BASE_URL,
  DEFAULT_LOCAL_AI_MODEL,
  localAiNativeTagsUrl,
  modelCapabilitiesDeclareVision,
  parseOllamaTagModelEntries,
  parseOpenAiStyleModelEntries,
} from './ai-local-endpoints';

export type AiApiFormat =
  | 'dashscope_native'
  | 'openai_chat'
  | 'openai_responses'
  | 'anthropic'
  | 'gemini_native'
  | 'local_openai';

/** Wire formats that speak `POST {base}/chat|responses` with OpenAI shapes. */
export type OpenAiCompatibleFormat =
  | 'openai_chat'
  | 'openai_responses'
  | 'local_openai';

/** @deprecated Legacy storage / UI values before apiFormat correction. */
export type LegacyAiProviderId = 'openai' | 'gemini' | 'anthropic';

export const AI_API_FORMATS: readonly AiApiFormat[] = [
  'dashscope_native',
  'openai_chat',
  'openai_responses',
  'anthropic',
  'gemini_native',
  'local_openai',
] as const;

export const AI_API_FORMAT_LABELS: Record<AiApiFormat, string> = {
  dashscope_native: 'DashScope Multimodal (native)',
  openai_chat: 'OpenAI Chat Completions',
  openai_responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini_native: 'Gemini Native',
  local_openai: 'Local model (WSL / OpenAI-compatible)',
};

export const DEFAULT_AI_BASE_URLS: Record<AiApiFormat, string> = {
  dashscope_native: 'https://dashscope.aliyuncs.com/api/v1',
  openai_chat: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini_native: 'https://generativelanguage.googleapis.com/v1beta',
  /** Ollama's OpenAI-compatible root. Reachable from Windows in WSL2. */
  local_openai: DEFAULT_LOCAL_AI_BASE_URL,
};

/**
 * Formats that authenticate with a user-supplied key. Local runtimes accept
 * (and usually ignore) the key, but they must never block configuration — a
 * fresh Ollama install has no credential to paste.
 */
export const AI_KEYLESS_API_FORMATS: readonly AiApiFormat[] = [
  'local_openai',
] as const;

export function aiApiFormatRequiresApiKey(apiFormat: AiApiFormat): boolean {
  return !AI_KEYLESS_API_FORMATS.includes(apiFormat);
}

/**
 * Single credential gate for Main / Renderer. A stored key satisfies every
 * format; a keyless format is satisfied by having nothing to store.
 */
export function aiConfigHasCredentials(input: {
  hasKey: boolean;
  apiFormat: AiApiFormat;
}): boolean {
  return input.hasKey || !aiApiFormatRequiresApiKey(input.apiFormat);
}

export function isOpenAiCompatibleFormat(
  apiFormat: AiApiFormat,
): apiFormat is OpenAiCompatibleFormat {
  return (
    apiFormat === 'openai_chat' ||
    apiFormat === 'openai_responses' ||
    apiFormat === 'local_openai'
  );
}

/**
 * Format used when nothing is stored yet (user decision 2026-09-13).
 *
 * Format and model are one pair: a fresh profile must not end up with the
 * Anthropic wire protocol and a DashScope model id, so both defaults live here
 * and every storage/probe fallback reads them from one place.
 */
export const DEFAULT_AI_API_FORMAT: AiApiFormat = 'anthropic';

/** Model placeholder / default per format, shown when the user has none. */
export const DEFAULT_AI_MODELS: Record<AiApiFormat, string> = {
  dashscope_native: 'qwen3-vl-plus',
  openai_chat: 'gpt-4o-mini',
  openai_responses: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini_native: 'gemini-2.0-flash',
  /** A vision-capable Ollama default; text-only models cannot analyze images. */
  local_openai: DEFAULT_LOCAL_AI_MODEL,
};

export const AI_LANGUAGE_OPTIONS = [
  { id: 'zh-CN', labelZh: '中文', labelEn: 'Chinese' },
  { id: 'en', labelZh: 'English', labelEn: 'English' },
  { id: 'ja', labelZh: '日本語', labelEn: 'Japanese' },
  { id: 'ko', labelZh: '한국어', labelEn: 'Korean' },
] as const;

export type AiLanguageId = (typeof AI_LANGUAGE_OPTIONS)[number]['id'];

/** Product: AI analysis language is single-select (array length always 1). */
export const DEFAULT_AI_LANGUAGES: AiLanguageId[] = ['zh-CN'];

export function isAiApiFormat(value: unknown): value is AiApiFormat {
  return (
    typeof value === 'string' &&
    (AI_API_FORMATS as readonly string[]).includes(value)
  );
}

/** Map legacy provider brand id → CC Switch apiFormat. */
export function migrateLegacyProviderToApiFormat(
  value: unknown,
): AiApiFormat | undefined {
  if (isAiApiFormat(value)) return value;
  switch (value) {
    case 'openai':
      return 'openai_chat';
    case 'gemini':
      return 'gemini_native';
    case 'anthropic':
      return 'anthropic';
    default:
      return undefined;
  }
}

export function normalizeAiBaseUrl(
  baseUrl: string | null | undefined,
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/u, '');
}

export function effectiveAiBaseUrl(
  apiFormat: AiApiFormat,
  baseUrl?: string | null,
): string {
  return normalizeAiBaseUrl(baseUrl) ?? DEFAULT_AI_BASE_URLS[apiFormat];
}

/**
 * Base URL handed to a vendor adapter. Empty input keeps the adapter's own
 * official default for cloud formats, but a local endpoint has no cloud
 * default to fall back to — an empty local base URL would silently target
 * api.openai.com, so the loopback default is materialized here instead.
 */
export function effectiveAiRequestBaseUrl(
  apiFormat: AiApiFormat,
  baseUrl?: string | null,
): string | undefined {
  const normalized = normalizeAiBaseUrl(baseUrl);
  if (normalized) return normalized;
  if (apiFormat === 'local_openai') {
    return DEFAULT_AI_BASE_URLS.local_openai;
  }
  return undefined;
}

/**
 * Join base + path segments like CC Switch `build_url`: trim slashes and
 * collapse accidental `/v1/v1` (base and endpoint both carrying a version).
 */
export function joinAiApiUrl(baseUrl: string, ...pathParts: string[]): string {
  let url = pathParts.reduce((prefix, part) => {
    const left = prefix.replace(/\/+$/u, '');
    const right = part.replace(/^\/+/u, '');
    if (!right) return left;
    return `${left}/${right}`;
  }, baseUrl.replace(/\/+$/u, ''));
  while (url.includes('/v1/v1')) {
    url = url.replace('/v1/v1', '/v1');
  }
  while (url.includes('/v1beta/v1beta')) {
    url = url.replace('/v1beta/v1beta', '/v1beta');
  }
  return url;
}

/**
 * OpenAI-compatible roots: host-only bases need `/v1` (official shape).
 * Bases that already end with `/v1`/`/v1beta`, or already have a path prefix
 * (e.g. `https://relay/openai`), are left alone — mirrors common CC Switch
 * provider URLs such as `…/openai` + `/responses`.
 */
export function ensureOpenAiCompatibleRoot(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  if (/\/v1$/iu.test(base) || /\/v1beta$/iu.test(base)) return base;
  try {
    const parsed = new URL(base);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return `${base}/v1`;
    }
  } catch {
    // Non-URL test doubles: keep as-is.
  }
  return base;
}

function effectiveOpenAiCompatibleRoot(
  apiFormat: OpenAiCompatibleFormat,
  baseUrl?: string | null,
): string {
  return ensureOpenAiCompatibleRoot(effectiveAiBaseUrl(apiFormat, baseUrl));
}

/** Anthropic / Gemini: host-only custom bases get the vendor version segment. */
export function ensureVersionedApiRoot(
  baseUrl: string,
  versionSegment: 'v1' | 'v1beta',
): string {
  const base = baseUrl.replace(/\/+$/u, '');
  const versionPattern =
    versionSegment === 'v1beta' ? /\/v1beta$/iu : /\/v1$/iu;
  if (versionPattern.test(base)) return base;
  try {
    const parsed = new URL(base);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return `${base}/${versionSegment}`;
    }
  } catch {
    // keep
  }
  // Anthropic default helper historically always inserted /v1 when missing,
  // even for path prefixes like `/api` — keep that behavior for messages.
  if (versionSegment === 'v1' && !/\/v1(\/|$)/iu.test(base)) {
    return joinAiApiUrl(base, 'v1');
  }
  if (versionSegment === 'v1beta' && !/\/v1beta(\/|$)/iu.test(base)) {
    try {
      const parsed = new URL(base);
      if (parsed.pathname === '/' || parsed.pathname === '') {
        return `${base}/v1beta`;
      }
    } catch {
      // keep
    }
  }
  return base;
}

export function resolveOpenAiChatCompletionsUrl(
  baseUrl?: string | null,
  apiFormat: OpenAiCompatibleFormat = 'openai_chat',
): string {
  return joinAiApiUrl(
    effectiveOpenAiCompatibleRoot(apiFormat, baseUrl),
    'chat/completions',
  );
}

export function resolveOpenAiResponsesUrl(baseUrl?: string | null): string {
  return joinAiApiUrl(
    effectiveOpenAiCompatibleRoot('openai_responses', baseUrl),
    'responses',
  );
}

export function resolveOpenAiModelsUrl(
  apiFormat: OpenAiCompatibleFormat = 'openai_chat',
  baseUrl?: string | null,
): string {
  return joinAiApiUrl(
    effectiveOpenAiCompatibleRoot(apiFormat, baseUrl),
    'models',
  );
}

export function resolveAnthropicMessagesUrl(baseUrl?: string | null): string {
  const base = ensureVersionedApiRoot(
    effectiveAiBaseUrl('anthropic', baseUrl),
    'v1',
  );
  return joinAiApiUrl(base, 'messages');
}

export function resolveAnthropicModelsUrl(baseUrl?: string | null): string {
  const base = ensureVersionedApiRoot(
    effectiveAiBaseUrl('anthropic', baseUrl),
    'v1',
  );
  return joinAiApiUrl(base, 'models');
}

export function resolveGeminiGenerateContentUrl(
  model: string,
  baseUrl?: string | null,
  options?: { apiKeyQuery?: string },
): string {
  const root = ensureVersionedApiRoot(
    effectiveAiBaseUrl('gemini_native', baseUrl),
    'v1beta',
  );
  const path = joinAiApiUrl(
    root,
    `models/${encodeURIComponent(model)}:generateContent`,
  );
  if (options?.apiKeyQuery !== undefined) {
    return `${path}?key=${encodeURIComponent(options.apiKeyQuery)}`;
  }
  return path;
}

export function resolveGeminiModelsUrl(baseUrl?: string | null): string {
  const root = ensureVersionedApiRoot(
    effectiveAiBaseUrl('gemini_native', baseUrl),
    'v1beta',
  );
  return joinAiApiUrl(root, 'models');
}

/**
 * DashScope native calls use `/api/v1/services/...`, unlike Model Studio's
 * OpenAI-compatible `/compatible-mode/v1` prefix. Accepting the latter here
 * is intentional: it makes switching formats for one workspace safe and
 * avoids accidentally sending a native request through a compatibility relay.
 */
function effectiveDashScopeRoot(baseUrl?: string | null): string {
  const configured = effectiveAiBaseUrl('dashscope_native', baseUrl);
  const normalized = configured.replace(/\/compatible-mode\/v1$/iu, '/api/v1');
  if (/\/api\/v1$/iu.test(normalized)) return normalized;
  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return joinAiApiUrl(normalized, 'api/v1');
    }
  } catch {
    // Keep non-URL test doubles as provided.
  }
  return normalized;
}

export function resolveDashScopeMultimodalGenerationUrl(
  baseUrl?: string | null,
): string {
  return joinAiApiUrl(
    effectiveDashScopeRoot(baseUrl),
    'services/aigc/multimodal-generation/generation',
  );
}

export function resolveDashScopeTextGenerationUrl(
  baseUrl?: string | null,
): string {
  return joinAiApiUrl(
    effectiveDashScopeRoot(baseUrl),
    'services/aigc/text-generation/generation',
  );
}

/** Concurrency / limiter key shared by wire formats of the same vendor family. */
export function apiFormatLimiterKey(
  apiFormat: AiApiFormat,
): 'dashscope' | 'openai' | 'gemini' | 'anthropic' {
  switch (apiFormat) {
    case 'dashscope_native':
      return 'dashscope';
    case 'openai_chat':
    case 'openai_responses':
    case 'local_openai':
      return 'openai';
    case 'gemini_native':
      return 'gemini';
    case 'anthropic':
      return 'anthropic';
  }
}

export function normalizeAiLanguages(value: unknown): AiLanguageId[] {
  const allowed = new Set(
    AI_LANGUAGE_OPTIONS.map((option) => option.id as string),
  );
  let picked: AiLanguageId | null = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (allowed.has(id)) {
        picked = id as AiLanguageId;
        break;
      }
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && trimmed !== 'auto') {
      const parts = trimmed
        .split(/[,+/|]/u)
        .map((part) => part.trim())
        .filter((part) => allowed.has(part)) as AiLanguageId[];
      picked = parts[0] ?? (allowed.has(trimmed) ? (trimmed as AiLanguageId) : null);
    }
  }
  return [picked ?? DEFAULT_AI_LANGUAGES[0]!];
}

export function formatAiLanguagesForPrompt(languages: readonly string[]): string {
  const labels = languages.map((id) => {
    const option = AI_LANGUAGE_OPTIONS.find((row) => row.id === id);
    return option ? `${option.labelEn} (${option.id})` : id;
  });
  if (labels.length === 0) {
    return 'Chinese (zh-CN) and English (en)';
  }
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export type ListAiModelsResult =
  | {
      ok: true;
      models: string[];
      /**
       * Models the endpoint explicitly declared vision/multimodal. Only present
       * when the runtime reported capabilities at all (see
       * `capabilitiesReported`), so callers can trust it over a name heuristic.
       */
      visionModels?: string[];
      /** True when at least one model row carried a non-empty capability list. */
      capabilitiesReported?: boolean;
    }
  | {
      ok: false;
      errorKind: 'auth' | 'permission' | 'network' | 'invalid_response';
      reason: string;
    };

function httpStatusToListError(
  status: number,
): Extract<ListAiModelsResult, { ok: false }>['errorKind'] {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status >= 500) return 'network';
  return 'invalid_response';
}

/**
 * DashScope does not expose an OpenAI-style `/models` endpoint for this
 * transport. Keep the picker useful without making a brittle undocumented
 * network call; manual model entry remains available for eligible models.
 */
export const DASHSCOPE_MULTIMODAL_PRESET_MODELS = [
  'qwen3-vl-flash',
  'qwen3-vl-plus',
] as const;

function parseOpenAiStyleModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return ids;
}

function parseGeminiModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const row of models) {
    if (!row || typeof row !== 'object') continue;
    const name = (row as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.trim()) continue;
    ids.push(name.replace(/^models\//u, '').trim());
  }
  return ids;
}

/**
 * One `/models` attempt. Split out so the local format can retry against
 * Ollama's native tag route before reporting the OpenAI-shaped failure.
 */
async function fetchOpenAiStyleModels(input: {
  apiFormat: OpenAiCompatibleFormat;
  apiKey: string;
  baseUrl?: string | null;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<ListAiModelsResult> {
  let response: Response;
  try {
    response = await input.fetchFn(
      resolveOpenAiModelsUrl(input.apiFormat, input.baseUrl),
      {
        method: 'GET',
        headers: {
          ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        signal: input.signal,
      },
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, errorKind: 'network', reason: 'Request timed out.' };
    }
    return {
      ok: false,
      errorKind: 'network',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text.trim()) reason = text.slice(0, 240);
    } catch {
      // keep status reason
    }
    return {
      ok: false,
      errorKind: httpStatusToListError(response.status),
      reason,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      errorKind: 'invalid_response',
      reason: 'Model list response was not JSON.',
    };
  }

  const entries = parseOpenAiStyleModelEntries(body);
  const visionModels = entries
    .filter((entry) => modelCapabilitiesDeclareVision(entry.capabilities))
    .map((entry) => entry.id);
  const capabilitiesReported = entries.some(
    (entry) => entry.capabilities.length > 0,
  );
  const models = entries.map((entry) => entry.id);
  if (models.length === 0) {
    return {
      ok: false,
      errorKind: 'invalid_response',
      reason: 'No models returned by the endpoint.',
    };
  }
  return {
    ok: true,
    models: [...new Set(models)].sort((a, b) => a.localeCompare(b)),
    ...(capabilitiesReported
      ? { visionModels: [...new Set(visionModels)], capabilitiesReported: true }
      : {}),
  };
}

/**
 * Ollama fallback for local runtimes whose OpenAI-compatible `/v1/models`
 * route is missing (older builds) or disabled. Best-effort: the caller keeps
 * the original OpenAI-shaped failure when this also fails, because that error
 * describes the endpoint the user actually configured.
 */
async function fetchOllamaNativeModels(input: {
  baseUrl?: string | null;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<ListAiModelsResult | undefined> {
  const tagsUrl = localAiNativeTagsUrl(
    effectiveAiRequestBaseUrl('local_openai', input.baseUrl) ?? '',
  );
  if (!tagsUrl) return undefined;
  try {
    const response = await input.fetchFn(tagsUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: input.signal,
    });
    if (!response.ok) return undefined;
    const entries = parseOllamaTagModelEntries(await response.json());
    if (entries.length === 0) return undefined;
    const visionModels = entries
      .filter((entry) => modelCapabilitiesDeclareVision(entry.capabilities))
      .map((entry) => entry.id);
    const capabilitiesReported = entries.some(
      (entry) => entry.capabilities.length > 0,
    );
    return {
      ok: true,
      models: [...new Set(entries.map((entry) => entry.id))].sort((a, b) =>
        a.localeCompare(b),
      ),
      ...(capabilitiesReported
        ? { visionModels: [...new Set(visionModels)], capabilitiesReported: true }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Fetch available model IDs from a compatible provider endpoint.
 */
export async function listAiModels(input: {
  apiFormat: AiApiFormat;
  /** Omit for keyless local runtimes. */
  apiKey?: string;
  baseUrl?: string | null;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ListAiModelsResult> {
  if (input.apiFormat === 'dashscope_native') {
    return { ok: true, models: [...DASHSCOPE_MULTIMODAL_PRESET_MODELS] };
  }
  const fetchFn = input.fetchFn ?? globalThis.fetch.bind(globalThis);
  const apiKey = input.apiKey?.trim() ?? '';
  try {
    if (isOpenAiCompatibleFormat(input.apiFormat)) {
      const listed = await fetchOpenAiStyleModels({
        apiFormat: input.apiFormat,
        apiKey,
        baseUrl: input.baseUrl,
        fetchFn,
        signal: input.signal,
      });
      if (listed.ok || input.apiFormat !== 'local_openai') return listed;
      const native = await fetchOllamaNativeModels({
        baseUrl: input.baseUrl,
        fetchFn,
        signal: input.signal,
      });
      return native ?? listed;
    }

    let response: Response;
    if (input.apiFormat === 'anthropic') {
      response = await fetchFn(resolveAnthropicModelsUrl(input.baseUrl), {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        signal: input.signal,
      });
    } else {
      const url = `${resolveGeminiModelsUrl(input.baseUrl)}?key=${encodeURIComponent(apiKey)}`;
      response = await fetchFn(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: input.signal,
      });
    }

    if (!response.ok) {
      let reason = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        if (text.trim()) reason = text.slice(0, 240);
      } catch {
        // keep status reason
      }
      return {
        ok: false,
        errorKind: httpStatusToListError(response.status),
        reason,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        errorKind: 'invalid_response',
        reason: 'Model list response was not JSON.',
      };
    }

    const models =
      input.apiFormat === 'gemini_native'
        ? parseGeminiModelIds(body)
        : parseOpenAiStyleModelIds(body);

    if (models.length === 0) {
      return {
        ok: false,
        errorKind: 'invalid_response',
        reason: 'No models returned by the endpoint.',
      };
    }

    return {
      ok: true,
      models: [...new Set(models)].sort((a, b) => a.localeCompare(b)),
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, errorKind: 'network', reason: 'Request timed out.' };
    }
    return {
      ok: false,
      errorKind: 'network',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
