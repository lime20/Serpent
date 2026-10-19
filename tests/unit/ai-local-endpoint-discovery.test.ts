import { describe, expect, it, vi } from 'vitest';

import { discoverLocalAiEndpoints } from '../../src/main/ai-local-endpoint-probe';

/** Fake fetch that answers only the URLs a test registers. */
function stubFetch(routes: Record<string, unknown | number>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const match = Object.keys(routes).find((route) => url === route);
    if (match === undefined) return new Response('not found', { status: 404 });
    const value = routes[match];
    if (typeof value === 'number') return new Response('', { status: value });
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
}

function wslCommand(answers: Record<string, { stdout: string; failed?: boolean }>) {
  return vi.fn(async (args: readonly string[]) => {
    const key = args.join(' ');
    const answer = answers[key];
    if (!answer) return { stdout: '', failed: true };
    return { stdout: answer.stdout, failed: answer.failed ?? false };
  });
}

const OLLAMA_MODELS = {
  object: 'list',
  data: [{ id: 'qwen2.5vl:7b' }, { id: 'llava:13b' }],
};

describe('discoverLocalAiEndpoints', () => {
  it('finds a loopback Ollama server through the OpenAI-compatible route', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'linux',
      fetchFn: stubFetch({ 'http://127.0.0.1:11434/v1/models': OLLAMA_MODELS }),
    });

    expect(result.endpoints).toEqual([
      {
        presetId: 'ollama',
        label: 'Ollama (11434)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        host: '127.0.0.1',
        port: 11434,
        source: 'loopback',
        models: ['llava:13b', 'qwen2.5vl:7b'],
      },
    ]);
    expect(result.wslAvailable).toBe(false);
    expect(result.wslDistros).toEqual([]);
  });

  it('falls back to the Ollama native tag route', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'darwin',
      fetchFn: stubFetch({
        'http://127.0.0.1:11434/api/tags': { models: [{ name: 'minicpm-v:8b' }] },
      }),
    });

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      presetId: 'ollama',
      source: 'loopback',
      models: ['minicpm-v:8b'],
    });
  });

  it('probes the WSL distribution address and reports its distro', async () => {
    const runWslCommand = wslCommand({
      '-l -q': { stdout: 'Ubuntu-24.04\r\n' },
      'hostname -I': { stdout: '172.24.11.9 \n' },
    });

    const result = await discoverLocalAiEndpoints({
      platform: 'win32',
      runWslCommand,
      fetchFn: stubFetch({ 'http://172.24.11.9:11434/v1/models': OLLAMA_MODELS }),
    });

    expect(runWslCommand).toHaveBeenCalledWith(['-l', '-q']);
    expect(runWslCommand).toHaveBeenCalledWith(['hostname', '-I']);
    expect(result.wslAvailable).toBe(true);
    expect(result.wslDistros).toEqual(['Ubuntu-24.04']);
    expect(result.endpoints).toEqual([
      {
        presetId: 'ollama',
        label: 'Ollama (11434)',
        baseUrl: 'http://172.24.11.9:11434/v1',
        host: '172.24.11.9',
        port: 11434,
        source: 'wsl',
        models: ['llava:13b', 'qwen2.5vl:7b'],
        wslDistro: 'Ubuntu-24.04',
      },
    ]);
  });

  /**
   * Windows and WSL can both answer for the same server. The loopback entry is
   * the one worth keeping: a WSL address changes on every restart.
   */
  it('prefers the durable loopback entry when WSL answers too', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'win32',
      runWslCommand: wslCommand({
        '-l -q': { stdout: 'Ubuntu-24.04\n' },
        'hostname -I': { stdout: '172.24.11.9\n' },
      }),
      fetchFn: stubFetch({
        'http://127.0.0.1:11434/v1/models': OLLAMA_MODELS,
        'http://172.24.11.9:11434/v1/models': OLLAMA_MODELS,
      }),
    });

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      host: '127.0.0.1',
      source: 'loopback',
    });
  });

  it('reports WSL as unavailable when wsl.exe cannot list distributions', async () => {
    const runWslCommand = vi.fn(async () => ({ stdout: '', failed: true }));
    const result = await discoverLocalAiEndpoints({
      platform: 'win32',
      runWslCommand,
      fetchFn: stubFetch({}),
    });

    expect(result).toEqual({
      endpoints: [],
      wslAvailable: false,
      wslDistros: [],
      wslError: 'WSL_UNAVAILABLE',
    });
    // The address command is skipped once the list command fails.
    expect(runWslCommand).toHaveBeenCalledTimes(1);
  });

  it('flags an unreadable distribution address on an installed WSL', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'win32',
      runWslCommand: wslCommand({ '-l -q': { stdout: 'Ubuntu\n' } }),
      fetchFn: stubFetch({}),
    });

    expect(result).toEqual({
      endpoints: [],
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      wslError: 'WSL_ADDRESS_UNAVAILABLE',
    });
  });

  it('never invokes wsl.exe off Windows', async () => {
    const runWslCommand = vi.fn(async () => ({ stdout: 'Ubuntu\n', failed: false }));
    const result = await discoverLocalAiEndpoints({
      platform: 'darwin',
      runWslCommand,
      fetchFn: stubFetch({}),
    });

    expect(runWslCommand).not.toHaveBeenCalled();
    expect(result.wslAvailable).toBe(false);
  });

  it('discovers several runtimes at once, one entry per port', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'linux',
      fetchFn: stubFetch({
        'http://127.0.0.1:11434/v1/models': OLLAMA_MODELS,
        'http://127.0.0.1:1234/v1/models': { data: [{ id: 'qwen2.5-vl-7b-instruct' }] },
      }),
    });

    expect(result.endpoints.map((endpoint) => endpoint.presetId).sort()).toEqual([
      'lmstudio',
      'ollama',
    ]);
  });

  /**
   * The settings panel must be able to answer "does this model accept images?"
   * from the runtime itself the moment an endpoint is picked, without waiting
   * for a second model-list round trip.
   */
  it('carries the runtime-declared vision capability on the endpoint', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'linux',
      fetchFn: stubFetch({
        'http://127.0.0.1:8000/v1/models': {
          models: [
            { name: '/m/qwen3.gguf', capabilities: ['completion', 'multimodal'] },
            { name: '/m/text.gguf', capabilities: ['completion'] },
          ],
          object: 'list',
          data: [{ id: '/m/qwen3.gguf' }, { id: '/m/text.gguf' }],
        },
      }),
    });

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:8000/v1',
      models: ['/m/qwen3.gguf', '/m/text.gguf'],
      visionModels: ['/m/qwen3.gguf'],
      capabilitiesReported: true,
    });
  });

  it('omits capability fields when the runtime reports none', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'linux',
      fetchFn: stubFetch({ 'http://127.0.0.1:11434/v1/models': OLLAMA_MODELS }),
    });

    expect(result.endpoints[0]?.capabilitiesReported).toBeUndefined();
    expect(result.endpoints[0]?.visionModels).toBeUndefined();
    expect(result.endpoints[0]?.runtime).toBeUndefined();
  });

  /**
   * Regression: the reported name used to be the port preset's brand, so a
   * `llama-server --port 8000` was announced as "vLLM".
   */
  it('names the answering runtime instead of the port preset', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'linux',
      fetchFn: stubFetch({
        'http://127.0.0.1:8000/v1/models': {
          object: 'list',
          data: [{ id: '/m/qwen3.gguf', owned_by: 'llamacpp' }],
        },
      }),
    });

    expect(result.endpoints[0]).toMatchObject({
      presetId: 'vllm',
      label: 'vLLM (8000)',
      runtime: 'llama.cpp',
    });
  });

  it('names Ollama from its native tag route', async () => {
    const result = await discoverLocalAiEndpoints({
      platform: 'linux',
      fetchFn: stubFetch({
        'http://127.0.0.1:11434/api/tags': { models: [{ name: 'llava:13b' }] },
      }),
    });

    expect(result.endpoints[0]).toMatchObject({
      presetId: 'ollama',
      runtime: 'Ollama',
    });
  });
});
