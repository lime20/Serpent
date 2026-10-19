/**
 * Keyless local-endpoint integration test.
 *
 * The unit tests above stub `fetch`. This one starts a real HTTP server on an
 * ephemeral loopback port and drives the *production* code paths against it
 * with the real global fetch: model listing, the connection probe, and a full
 * analysis round trip. It is the regression guard for the two things that make
 * "local model" different from every cloud format — no Authorization header,
 * and a loopback base URL — plus the structured-output fallback that local
 * runtimes need when they reject OpenAI's `json_schema` envelope.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { listAiModels } from '../../src/shared/ai-endpoints';
import { DEFAULT_LOCAL_AI_BASE_URL } from '../../src/shared/ai-local-endpoints';
import { OpenAIVendorAdapter } from '../../src/worker/ai/openai-adapter';
import type { AiAnalysisRequest } from '../../src/worker/ai/protocol';

interface RecordedRequest {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

interface StubRuntime {
  /** OpenAI-compatible root, e.g. `http://127.0.0.1:53421/v1`. */
  baseUrl: string;
  requests: RecordedRequest[];
  /** Always answers `GET /v1/models` and `POST /v1/chat/completions`. */
  close: () => Promise<void>;
}

const ANALYSIS_JSON = {
  description: 'A neon city street at night.',
  tags: ['neon', 'city', 'night'],
  rating: 4,
};

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Emulates an Ollama-style local runtime. `rejectJsonSchema` models the many
 * runtimes that answer 400 to `response_format: {type: 'json_schema'}`.
 */
async function startLocalRuntime(options?: {
  models?: string[];
  rejectJsonSchema?: boolean;
}): Promise<StubRuntime> {
  const models = options?.models ?? ['qwen2.5vl:7b', 'llava:13b'];
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '/';
      const body = await readBody(request);
      requests.push({
        url,
        authorization: request.headers.authorization,
        body,
      });

      if (request.method === 'GET' && url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(jsonBody({ object: 'list', data: models.map((id) => ({ id })) }));
        return;
      }

      if (request.method === 'GET' && url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(jsonBody({ models: models.map((name) => ({ name })) }));
        return;
      }

      if (request.method === 'POST' && url === '/v1/chat/completions') {
        const format = body?.response_format as { type?: string } | undefined;
        if (options?.rejectJsonSchema && format?.type === 'json_schema') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(jsonBody({
            error: {
              message: 'response_format json_schema is not supported',
              type: 'invalid_request_error',
            },
          }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(jsonBody({
          id: 'local-1',
          model: 'qwen2.5vl:7b',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: jsonBody(ANALYSIS_JSON) },
            },
          ],
        }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(jsonBody({ error: { message: `no route for ${url}` } }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function analysisRequest(): AiAnalysisRequest {
  return {
    displayName: 'shot.png',
    filename: 'shot.png',
    mime: 'image/png',
    imageBase64: 'aW1hZ2VEYXRh',
    language: 'en',
    enabledFields: { description: true, tags: true, rating: true },
    existingTagNames: [],
  };
}

const runtimes: StubRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

async function runtime(options?: Parameters<typeof startLocalRuntime>[0]): Promise<StubRuntime> {
  const started = await startLocalRuntime(options);
  runtimes.push(started);
  return started;
}

describe('local model runtime over real HTTP', () => {
  it('lists models with no Authorization header', async () => {
    const local = await runtime();

    await expect(
      listAiModels({ apiFormat: 'local_openai', baseUrl: local.baseUrl }),
    ).resolves.toEqual({ ok: true, models: ['llava:13b', 'qwen2.5vl:7b'] });

    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]!.authorization).toBeUndefined();
  });

  it('probes the connection keyless', async () => {
    const local = await runtime();
    const adapter = new OpenAIVendorAdapter('', 'qwen2.5vl:7b', undefined, local.baseUrl);

    await expect(adapter.probeConnection()).resolves.toBeUndefined();

    expect(local.requests[0]!.url).toBe('/v1/chat/completions');
    expect(local.requests[0]!.authorization).toBeUndefined();
  });

  it('analyzes an image and parses the structured result', async () => {
    const local = await runtime();
    const adapter = new OpenAIVendorAdapter('', 'qwen2.5vl:7b', undefined, local.baseUrl);

    const result = await adapter.analyze(analysisRequest());

    expect(result.description).toBe(ANALYSIS_JSON.description);
    expect(result.tags).toEqual(ANALYSIS_JSON.tags);
    expect(result.rating).toBe(4);
    const posted = local.requests.find((entry) => entry.url === '/v1/chat/completions');
    expect(posted?.authorization).toBeUndefined();
  });

  /**
   * The content-integrity rules must survive the whole local path: they are
   * what stops a local model from answering "private content" instead of
   * naming what is on screen.
   */
  it('sends the content-integrity rules to the local runtime', async () => {
    const local = await runtime();
    const adapter = new OpenAIVendorAdapter('', 'qwen2.5vl:7b', undefined, local.baseUrl);

    await adapter.analyze(analysisRequest());

    const posted = local.requests.find((entry) => entry.url === '/v1/chat/completions');
    const messages = posted?.body?.messages as
      | Array<{ role: string; content: unknown }>
      | undefined;
    const system = messages?.find((message) => message.role === 'system');
    const systemText = typeof system?.content === 'string' ? system.content : '';
    expect(systemText).toContain('画面呈现什么就描述什么');
    expect(systemText).toContain('「隐私内容」「敏感图片」「不便描述」');
    expect(systemText).toContain('不因题材敏感而抬高或压低');
  });

  /**
   * The negotiation must survive a runtime that rejects `json_schema`, because
   * that is the default posture of most local servers.
   */
  it('falls back to a portable envelope when json_schema is rejected', async () => {
    const local = await runtime({ rejectJsonSchema: true });
    const adapter = new OpenAIVendorAdapter('', 'qwen2.5vl:7b', undefined, local.baseUrl);

    const result = await adapter.analyze(analysisRequest());

    expect(result.description).toBe(ANALYSIS_JSON.description);
    const attempts = local.requests.filter(
      (entry) => entry.url === '/v1/chat/completions',
    );
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.every((entry) => entry.authorization === undefined)).toBe(true);
  });

  it('still sends the stored key when a local runtime is behind an authenticating proxy', async () => {
    const local = await runtime();
    const adapter = new OpenAIVendorAdapter(
      'proxy-token',
      'qwen2.5vl:7b',
      undefined,
      local.baseUrl,
    );

    await adapter.probeConnection();

    expect(local.requests[0]!.authorization).toBe('Bearer proxy-token');
  });

  it('defaults to the Ollama loopback root when no base URL is given', () => {
    expect(DEFAULT_LOCAL_AI_BASE_URL).toBe('http://127.0.0.1:11434/v1');
  });
});
