import { describe, expect, it } from 'vitest';

import { parseRendererRequest } from '../../src/shared/protocol/requests';
import { parseRendererResult } from '../../src/shared/protocol/responses';

import {
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODELS,
  aiApiFormatRequiresApiKey,
  aiConfigHasCredentials,
  apiFormatLimiterKey,
  effectiveAiRequestBaseUrl,
  listAiModels,
  resolveOpenAiChatCompletionsUrl,
  resolveOpenAiModelsUrl,
} from '../../src/shared/ai-endpoints';
import {
  DEFAULT_LOCAL_AI_BASE_URL,
  DEFAULT_LOCAL_AI_MODEL,
  LOCAL_AI_PROVIDER_PRESETS,
  decodeWslOutput,
  detectLocalRuntimeName,
  isLocalNetworkHost,
  localAiBaseUrlOrigin,
  localAiNativeTagsUrl,
  localAiProbeTargets,
  localModelLikelySupportsVision,
  modelCapabilitiesDeclareVision,
  parseOllamaTagsModelIds,
  parseOpenAiStyleModelEntries,
  parseWslDistroList,
  parseWslHostIps,
} from '../../src/shared/ai-local-endpoints';

describe('local_openai api format', () => {
  it('defaults base URL and model to the Ollama loopback root', () => {
    expect(DEFAULT_AI_BASE_URLS.local_openai).toBe(DEFAULT_LOCAL_AI_BASE_URL);
    expect(DEFAULT_AI_MODELS.local_openai).toBe(DEFAULT_LOCAL_AI_MODEL);
    expect(DEFAULT_LOCAL_AI_BASE_URL).toContain('127.0.0.1');
  });

  it('is keyless while every cloud format still requires a key', () => {
    expect(aiApiFormatRequiresApiKey('local_openai')).toBe(false);
    expect(aiApiFormatRequiresApiKey('openai_chat')).toBe(true);
    expect(aiApiFormatRequiresApiKey('anthropic')).toBe(true);

    expect(aiConfigHasCredentials({ hasKey: false, apiFormat: 'local_openai' })).toBe(true);
    expect(aiConfigHasCredentials({ hasKey: false, apiFormat: 'openai_chat' })).toBe(false);
    expect(aiConfigHasCredentials({ hasKey: true, apiFormat: 'openai_chat' })).toBe(true);
  });

  it('shares the OpenAI limiter so local runs cannot bypass the cap', () => {
    expect(apiFormatLimiterKey('local_openai')).toBe('openai');
  });

  /**
   * An empty local base URL must never fall back to api.openai.com: the
   * adapter default is only correct for cloud formats.
   */
  it('materializes a loopback base URL only for the local format', () => {
    expect(effectiveAiRequestBaseUrl('local_openai', '')).toBe(DEFAULT_LOCAL_AI_BASE_URL);
    expect(effectiveAiRequestBaseUrl('local_openai', 'http://127.0.0.1:9999/v1/')).toBe(
      'http://127.0.0.1:9999/v1',
    );
    expect(effectiveAiRequestBaseUrl('openai_chat', '')).toBeUndefined();
    expect(effectiveAiRequestBaseUrl('anthropic', '   ')).toBeUndefined();
  });

  it('resolves local URLs against the loopback default and keeps /v1', () => {
    expect(resolveOpenAiChatCompletionsUrl(undefined, 'local_openai')).toBe(
      `${DEFAULT_LOCAL_AI_BASE_URL}/chat/completions`,
    );
    expect(resolveOpenAiModelsUrl('local_openai', undefined)).toBe(
      `${DEFAULT_LOCAL_AI_BASE_URL}/models`,
    );
    // A host-only local base still gains the OpenAI version segment.
    expect(resolveOpenAiChatCompletionsUrl('http://127.0.0.1:11434', 'local_openai')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
  });
});

describe('localAiProbeTargets', () => {
  it('builds a target per preset per host with the stock port', () => {
    const targets = localAiProbeTargets(['127.0.0.1', '172.24.0.5']);
    expect(targets).toHaveLength(LOCAL_AI_PROVIDER_PRESETS.length * 2);
    const ollama = targets.find(
      (target) => target.presetId === 'ollama' && target.host === '172.24.0.5',
    );
    expect(ollama).toMatchObject({
      baseUrl: 'http://172.24.0.5:11434/v1',
      port: 11434,
      suggestedModel: DEFAULT_LOCAL_AI_MODEL,
    });
    expect(targets.every((target) => target.port > 0)).toBe(true);
  });

  it('skips blank hosts and keeps distinct per-preset ports', () => {
    const targets = localAiProbeTargets(['  ', '127.0.0.1']);
    expect(targets).toHaveLength(LOCAL_AI_PROVIDER_PRESETS.length);
    expect(new Set(targets.map((target) => target.port)).size).toBe(
      LOCAL_AI_PROVIDER_PRESETS.length,
    );
  });
});

describe('Ollama native tag fallback', () => {
  it('rewrites the OpenAI root to /api/tags', () => {
    expect(localAiNativeTagsUrl('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
    expect(localAiNativeTagsUrl('http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
    expect(localAiNativeTagsUrl('not a url')).toBeUndefined();
  });

  it('parses both name and model fields, deduplicated', () => {
    expect(parseOllamaTagsModelIds({
      models: [
        { name: 'llava:13b' },
        { model: 'qwen2.5vl:7b' },
        { name: 'llava:13b' },
        { name: '   ' },
        { name: 42 },
      ],
    })).toEqual(['llava:13b', 'qwen2.5vl:7b']);
    expect(parseOllamaTagsModelIds(null)).toEqual([]);
    expect(parseOllamaTagsModelIds({ models: 'nope' })).toEqual([]);
  });

  it('falls back to the native tag route when /v1/models is unavailable', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ models: [{ name: 'llava:13b' }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(
      listAiModels({
        apiFormat: 'local_openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        fetchFn,
      }),
    ).resolves.toEqual({ ok: true, models: ['llava:13b'] });
    expect(calls).toEqual([
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:11434/api/tags',
    ]);
  });

  it('reports the OpenAI-shaped failure when neither route answers', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(
      listAiModels({ apiFormat: 'local_openai', fetchFn }),
    ).resolves.toMatchObject({ ok: false, errorKind: 'invalid_response' });
  });

  it('lists models without an Authorization header', async () => {
    let authorization: string | undefined = 'unset';
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization') ?? undefined;
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(
      listAiModels({ apiFormat: 'local_openai', fetchFn }),
    ).resolves.toEqual({ ok: true, models: ['qwen2.5vl:7b'] });
    expect(authorization).toBeUndefined();
  });
});

describe('detectLocalRuntimeName', () => {
  /**
   * The port a server listens on says nothing about what it is: this machine
   * runs `llama-server --port 8000`, and the presets label 8000 "vLLM".
   * The name must come from the server's own `owned_by`.
   */
  it('names the runtime from its own owned_by value', () => {
    expect(detectLocalRuntimeName({ owners: ['llamacpp'] })).toBe('llama.cpp');
    expect(detectLocalRuntimeName({ owners: ['llama.cpp'] })).toBe('llama.cpp');
    expect(detectLocalRuntimeName({ owners: ['vllm'] })).toBe('vLLM');
    expect(detectLocalRuntimeName({ owners: ['lmstudio'] })).toBe('LM Studio');
    // Ollama's OpenAI-compatible route reports the opaque `library`.
    expect(detectLocalRuntimeName({ owners: ['library'] })).toBe('Ollama');
    expect(detectLocalRuntimeName({ owners: ['OLLAMA'] })).toBe('Ollama');
  });

  it('reports the native /api/tags route as Ollama', () => {
    expect(
      detectLocalRuntimeName({ owners: [], ollamaNativeRouteAnswered: true }),
    ).toBe('Ollama');
  });

  it('shows an unrecognized but well-formed owner verbatim', () => {
    expect(detectLocalRuntimeName({ owners: ['my-custom-build'] })).toBe(
      'my-custom-build',
    );
    // Nothing usable must stay unknown instead of inventing a brand.
    expect(detectLocalRuntimeName({ owners: [''] })).toBeUndefined();
    expect(detectLocalRuntimeName({ owners: [undefined] })).toBeUndefined();
    expect(detectLocalRuntimeName({ owners: [] })).toBeUndefined();
    expect(detectLocalRuntimeName({})).toBeUndefined();
    // Reject values that are not a display name at all.
    expect(
      detectLocalRuntimeName({ owners: ['http://10.0.0.1:8000/v1'] }),
    ).toBeUndefined();
  });

  it('reads owned_by off the OpenAI rows', () => {
    expect(parseOpenAiStyleModelEntries({
      data: [{ id: 'qwen.gguf', owned_by: 'llamacpp' }],
    })).toEqual([{ id: 'qwen.gguf', capabilities: [], owner: 'llamacpp' }]);
  });
});

describe('server-declared vision capabilities', () => {
  /**
   * llama.cpp answers `/v1/models` with both an OpenAI `data` array and an
   * Ollama-style `models` array, and only the latter carries `capabilities`.
   * Reading just `data` silently loses the runtime's multimodal declaration.
   */
  it("merges llama.cpp's Ollama-style capabilities into the OpenAI rows", () => {
    const body = {
      models: [
        { name: '/m/qwen3.gguf', capabilities: ['completion', 'multimodal'] },
        { name: '/m/text.gguf', capabilities: ['completion'] },
      ],
      object: 'list',
      data: [{ id: '/m/qwen3.gguf' }, { id: '/m/text.gguf' }],
    };

    expect(parseOpenAiStyleModelEntries(body)).toEqual([
      { id: '/m/qwen3.gguf', capabilities: ['completion', 'multimodal'] },
      { id: '/m/text.gguf', capabilities: ['completion'] },
    ]);
  });

  it('prefers capabilities on the OpenAI row when both shapes carry them', () => {
    expect(parseOpenAiStyleModelEntries({
      models: [{ name: 'm', capabilities: ['completion'] }],
      data: [{ id: 'm', capabilities: ['completion', 'vision'] }],
    })).toEqual([{ id: 'm', capabilities: ['completion', 'vision'] }]);
  });

  it('recognizes vision/multimodal vocabulary', () => {
    expect(modelCapabilitiesDeclareVision(['completion', 'multimodal'])).toBe(true);
    expect(modelCapabilitiesDeclareVision(['completion', 'vision'])).toBe(true);
    expect(modelCapabilitiesDeclareVision(['COMPLETION'])).toBe(false);
    expect(modelCapabilitiesDeclareVision([])).toBe(false);
  });

  it('reports visionModels only when the endpoint answered the question', async () => {
    const withCapabilities = (async () =>
      new Response(JSON.stringify({
        models: [{ name: 'qwen.gguf', capabilities: ['completion', 'multimodal'] }],
        data: [{ id: 'qwen.gguf' }],
      }), { status: 200 })) as unknown as typeof fetch;

    await expect(
      listAiModels({ apiFormat: 'local_openai', fetchFn: withCapabilities }),
    ).resolves.toEqual({
      ok: true,
      models: ['qwen.gguf'],
      visionModels: ['qwen.gguf'],
      capabilitiesReported: true,
    });

    const withoutCapabilities = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'qwen.gguf' }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    // No claim either way: the caller must fall back to its name heuristic
    // instead of treating the model as text-only.
    await expect(
      listAiModels({ apiFormat: 'local_openai', fetchFn: withoutCapabilities }),
    ).resolves.toEqual({ ok: true, models: ['qwen.gguf'] });
  });
});

describe('localModelLikelySupportsVision', () => {
  it('recognizes the common local vision families', () => {
    for (const id of [
      'llava:13b',
      'bakllava',
      'llama3.2-vision:11b',
      'minicpm-v:8b',
      'moondream:latest',
      'qwen2.5vl:7b',
      'qwen2.5-vl-7b-instruct',
      'qwen2vl:7b',
      'qwen3-vl:8b',
      'internvl2:8b',
      'pixtral:12b',
      'gemma3:4b',
      'granite3.2-vision:2b',
      'smolvlm:2b',
      'phi-3.5-vision',
      'glm-4v',
      'llama4:scout',
      'deepseek-vl2:16b',
      'Qwen/Qwen2.5-VL-7B-Instruct',
    ]) {
      expect(localModelLikelySupportsVision(id), id).toBe(true);
    }
  });

  it('flags text-only ids so the UI can warn before an image request', () => {
    for (const id of [
      'llama3.2:3b',
      'qwen2.5-coder:7b',
      'mistral:7b',
      'deepseek-r1:8b',
      'gemma2:9b',
      'nomic-embed-text',
      '',
    ]) {
      expect(localModelLikelySupportsVision(id), id).toBe(false);
    }
  });
});

describe('WSL output decoding', () => {
  it('decodes the UTF-16LE that `wsl -l -q` emits', () => {
    const text = 'Ubuntu-24.04\r\ndocker-desktop\r\n';
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index * 2] = text.charCodeAt(index);
    }
    expect(decodeWslOutput(bytes)).toBe(text);
  });

  it('decodes plain UTF-8 and tolerates empty input', () => {
    const bytes = new TextEncoder().encode('172.24.11.9  fe80::1\n');
    expect(decodeWslOutput(bytes)).toBe('172.24.11.9  fe80::1\n');
    expect(decodeWslOutput(new Uint8Array())).toBe('');
  });

  it('parses the distribution list, dropping blanks and duplicates', () => {
    expect(parseWslDistroList('Ubuntu-24.04\r\n\r\ndocker-desktop\r\nUbuntu-24.04\r\n'))
      .toEqual(['Ubuntu-24.04', 'docker-desktop']);
    expect(parseWslDistroList('')).toEqual([]);
  });

  it('parses host addresses with IPv4 first', () => {
    expect(parseWslHostIps('fe80::215:5dff:fe00:1 172.24.11.9\n')).toEqual([
      '172.24.11.9',
      'fe80::215:5dff:fe00:1',
    ]);
    expect(parseWslHostIps('')).toEqual([]);
  });
});

describe('local endpoint wire protocol', () => {
  it('parses the discovery request', () => {
    expect(parseRendererRequest({ type: 'ai.local-endpoints.request' })).toEqual({
      type: 'ai.local-endpoints.request',
    });
  });

  /**
   * The preload validates every library result against this schema, so a
   * payload the UI can render but zod rejects would fail at runtime only.
   */
  it('parses the discovery result exactly as the handler builds it', () => {
    expect(parseRendererResult({
      ok: true,
      type: 'ai.local-endpoints.result',
      endpoints: [
        {
          presetId: 'ollama',
          label: 'Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          host: '127.0.0.1',
          port: 11434,
          source: 'loopback',
          models: ['qwen2.5vl:7b'],
        },
        {
          presetId: 'lmstudio',
          label: 'LM Studio',
          baseUrl: 'http://172.24.11.9:1234/v1',
          host: '172.24.11.9',
          port: 1234,
          source: 'wsl',
          models: [],
          wslDistro: 'Ubuntu-24.04',
        },
      ],
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
    })).toMatchObject({ ok: true, type: 'ai.local-endpoints.result' });
  });

  it('rejects an unknown preset id and an unknown source on the wire', () => {
    const base = {
      ok: true,
      type: 'ai.local-endpoints.result',
      wslAvailable: false,
      wslDistros: [],
    };
    expect(() => parseRendererResult({
      ...base,
      endpoints: [{
        presetId: 'text-generation-webui', label: 'x', baseUrl: 'http://127.0.0.1:1/v1',
        host: '127.0.0.1', port: 1, source: 'loopback', models: [],
      }],
    })).toThrow();
    expect(() => parseRendererResult({
      ...base,
      endpoints: [{
        presetId: 'ollama', label: 'x', baseUrl: 'http://127.0.0.1:1/v1',
        host: '127.0.0.1', port: 1, source: 'remote', models: [],
      }],
    })).toThrow();
  });
});

describe('local host classification', () => {
  it('treats loopback, private and link-local ranges as local', () => {
    for (const host of [
      '127.0.0.1',
      'localhost',
      '::1',
      '10.0.0.4',
      '192.168.1.20',
      '172.24.11.9',
      '169.254.10.1',
      'fd00::1',
      '[::1]',
    ]) {
      expect(isLocalNetworkHost(host), host).toBe(true);
    }
  });

  it('rejects public hosts', () => {
    for (const host of ['api.openai.com', '8.8.8.8', '172.32.0.1', '']) {
      expect(isLocalNetworkHost(host), host).toBe(false);
    }
  });

  it('exposes the origin for a WSL reachability hint', () => {
    expect(localAiBaseUrlOrigin('http://172.24.11.9:11434/v1')).toBe(
      'http://172.24.11.9:11434',
    );
    expect(localAiBaseUrlOrigin('nope')).toBeUndefined();
  });
});
