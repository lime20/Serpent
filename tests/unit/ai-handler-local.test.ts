/**
 * Worker routing for the keyless local format.
 *
 * `executeAiWorkerCommand` builds a vendor adapter per `apiFormat`. An
 * unrouted value silently falls into the "Unsupported apiFormat" branch, so
 * this pins the routing against a real HTTP server rather than trusting the
 * switch statement to stay exhaustive.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect, test, vi } from 'vitest';

import type { WorkerRequest } from '../../src/shared/protocol/requests';
import { DEFAULT_AI_ANALYSIS_SETTINGS } from '../../src/shared/ai-analysis-settings';
import { DEFAULT_AI_RELIABILITY_SETTINGS } from '../../src/shared/ai-reliability';
import {
  tryHandleAiOwnedRequest,
  type AiOwnedRequestRuntime,
} from '../../src/main/library-request/ai';
import { AiJobAbortRegistry } from '../../src/worker/ai/job-abort-registry';
import { ProviderConcurrencyLimiter } from '../../src/worker/ai/provider-concurrency-limiter';
import { executeAiWorkerCommand, type AiRuntime } from '../../src/worker/handlers/ai';
import type { LibraryService } from '../../src/worker/library-service';

function aiRequest(command: WorkerRequest['command']): WorkerRequest {
  return { requestId: 'req-local-1', command };
}

function aiRuntime(): AiRuntime {
  return {
    analysisControls: new Map(),
    publishAiProgress: vi.fn(),
    aiJobAbortRegistry: new AiJobAbortRegistry(),
    providerConcurrencyLimiter: new ProviderConcurrencyLimiter(2),
    aiProcessBatchAbortControllers: new Map(),
    parentPort: undefined,
    runWithoutAdmission: async (_requestId, work) => work(),
  };
}

interface StubServer {
  baseUrl: string;
  authorizationHeaders: Array<string | undefined>;
  close: () => Promise<void>;
}

const servers: StubServer[] = [];

async function startServer(): Promise<StubServer> {
  const authorizationHeaders: Array<string | undefined> = [];
  const server: Server = createServer((request, response) => {
    authorizationHeaders.push(request.headers.authorization);
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: 'local', choices: [{ message: { content: 'OK' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const stub: StubServer = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    authorizationHeaders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(stub);
  return stub;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((stub) => stub.close()));
});

function libraryServiceStub(): LibraryService {
  return { reportDiagnostic: vi.fn() } as unknown as LibraryService;
}

test('ai.test-connection routes local_openai to the Chat Completions adapter', async () => {
  const stub = await startServer();

  const result = await executeAiWorkerCommand(
    libraryServiceStub(),
    aiRequest({
      type: 'ai.test-connection',
      apiFormat: 'local_openai',
      model: 'qwen2.5vl:7b',
      apiKey: '',
      baseUrl: stub.baseUrl,
    }),
    aiRuntime(),
  );

  expect(result).toEqual({
    ok: true,
    type: 'ai.test-connection.result',
    success: true,
  });
  // Keyless: nothing credential-shaped may reach the local runtime.
  expect(stub.authorizationHeaders).toEqual([undefined]);
});

test('ai.test-connection falls back to the loopback default for local_openai', async () => {
  // No base URL: the adapter must not silently target api.openai.com. The
  // request URL is captured with a fetch stub so the assertion holds whether
  // or not the machine happens to run Ollama.
  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calledUrls.push(String(input));
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  let result: Awaited<ReturnType<typeof executeAiWorkerCommand>>;
  try {
    result = await executeAiWorkerCommand(
      libraryServiceStub(),
      aiRequest({
        type: 'ai.test-connection',
        apiFormat: 'local_openai',
        model: 'qwen2.5vl:7b',
        apiKey: '',
      }),
      aiRuntime(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(result).toMatchObject({
    ok: true,
    type: 'ai.test-connection.result',
    success: false,
  });
  expect((result as { reason?: string }).reason).not.toContain('Unsupported apiFormat');
  expect(calledUrls).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);
});

test('openai_chat keeps sending its key to the same endpoint shape', async () => {
  const stub = await startServer();

  const result = await executeAiWorkerCommand(
    libraryServiceStub(),
    aiRequest({
      type: 'ai.test-connection',
      apiFormat: 'openai_chat',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: stub.baseUrl,
    }),
    aiRuntime(),
  );

  expect(result).toMatchObject({ ok: true, success: true });
  expect(stub.authorizationHeaders).toEqual(['Bearer sk-test']);
});

/**
 * Whole chain for a saved keyless profile: Main resolves credentials, builds
 * the Worker command, and the Worker reaches a real HTTP endpoint. This is the
 * composition the unit tests above only cover one hop at a time.
 */
test('a saved keyless local profile completes Main → Worker → HTTP', async () => {
  const stub = await startServer();
  const localConfig = {
    hasKey: false,
    apiFormat: 'local_openai' as const,
    model: 'qwen2.5vl:7b',
    baseUrl: stub.baseUrl,
    descriptionEnabled: true,
    tagEnabled: true,
    ratingEnabled: true,
    analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
    concurrencyLimit: 2,
    maxAnalysisImageEdgePx: 2048,
    reliabilitySettings: DEFAULT_AI_RELIABILITY_SETTINGS,
    languages: ['zh-CN'] as Array<'zh-CN' | 'en' | 'ja' | 'ko'>,
    autoAnalyzeEnabled: false,
    disclaimerAccepted: true,
  };

  const runtime: AiOwnedRequestRuntime = {
    loadAiConfig: () => localConfig,
    // No key file exists for a keyless profile; Main returns an empty key
    // rather than throwing AI_NOT_CONFIGURED.
    getDecryptedApiKey: () => '',
    saveAiConfig: vi.fn(),
    saveEncryptedApiKey: vi.fn(),
    workerAvailable: () => true,
    requestWorker: (command) =>
      executeAiWorkerCommand(
        libraryServiceStub(),
        { requestId: 'req-chain-1', command },
        aiRuntime(),
      ) as ReturnType<AiOwnedRequestRuntime['requestWorker']>,
    processAiQueue: vi.fn(),
    discoverLocalEndpoints: vi.fn(async () => ({
      endpoints: [],
      wslAvailable: false,
      wslDistros: [],
    })),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };

  await expect(tryHandleAiOwnedRequest(
    {
      type: 'ai.test-connection.request',
      apiFormat: 'local_openai',
      model: 'qwen2.5vl:7b',
      baseUrl: stub.baseUrl,
    },
    runtime,
  )).resolves.toEqual({
    ok: true,
    type: 'ai.test-connection.result',
    success: true,
  });

  expect(stub.authorizationHeaders).toEqual([undefined]);
});
