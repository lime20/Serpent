/**
 * Local / WSL AI endpoint discovery.
 *
 * Serpent runs the model request itself, so "is there a local model server?"
 * is a Windows-to-WSL reachability question:
 *
 * - WSL2 forwards Windows `127.0.0.1:<port>` to services inside the
 *   distribution that listen on `0.0.0.0` (and always in mirrored networking
 *   mode), so loopback is tried first — it is also the address a base URL
 *   should keep, because the WSL address changes on every restart.
 * - A server bound to the distribution's own `127.0.0.1` is *not* forwarded,
 *   so the distribution address from `wsl hostname -I` is probed as well and
 *   offered as a fallback the user can pick explicitly.
 *
 * Nothing here throws: a discovery run that finds nothing returns an empty
 * list plus the WSL diagnostics the settings UI shows as guidance.
 */

import { spawn } from 'node:child_process';

import { resolveOpenAiModelsUrl } from '../shared/ai-endpoints';
import {
  decodeWslOutput,
  detectLocalRuntimeName,
  localAiNativeTagsUrl,
  localAiProbeTargets,
  modelCapabilitiesDeclareVision,
  parseOllamaTagModelEntries,
  parseOpenAiStyleModelEntries,
  parseWslDistroList,
  parseWslHostIps,
  type AiLocalEndpointDescriptor,
  type AiLocalEndpointDiscovery,
  type LocalAiModelEntry,
  type LocalAiProbeTarget,
} from '../shared/ai-local-endpoints';

export type DiscoveredLocalAiEndpoint = AiLocalEndpointDescriptor;
export type LocalAiDiscoveryResult = AiLocalEndpointDiscovery;

export interface LocalAiDiscoveryRuntime {
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  /** Injected in tests; defaults to `wsl.exe` via spawn. */
  runWslCommand?: (
    args: readonly string[],
  ) => Promise<{ stdout: string; failed: boolean }>;
  /** Per-request connect/response budget. */
  timeoutMs?: number;
  /** Budget for the `wsl.exe` inventory commands. */
  wslTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_WSL_TIMEOUT_MS = 3_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * `wsl.exe` writes UTF-16LE for `-l -q` and UTF-8 for most other subcommands,
 * so capture raw bytes and let the shared decoder decide.
 */
function spawnWslCommand(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; failed: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('wsl.exe', [...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve({ stdout: '', failed: true });
      return;
    }

    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    const finish = (result: { stdout: string; failed: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Process already gone.
      }
      finish({ stdout: '', failed: true });
    }, timeoutMs);

    /** A truncated inventory is worse than none, so cap the capture. */
    const overflowed = () => {
      try {
        child.kill();
      } catch {
        // Process already gone.
      }
      finish({ stdout: '', failed: true });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > 1_048_576) {
        overflowed();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on('error', () => finish({ stdout: '', failed: true }));
    child.on('close', (code) => {
      finish({
        stdout: decodeWslOutput(Buffer.concat(chunks)),
        failed: code !== 0,
      });
    });
  });
}

interface WslInventory {
  available: boolean;
  distros: string[];
  /** Distribution address(es), in `wsl hostname -I` order. */
  hostIps: string[];
  error?: string;
}

async function readWslInventory(
  runWslCommand: (args: readonly string[]) => Promise<{ stdout: string; failed: boolean }>,
): Promise<WslInventory> {
  const list = await runWslCommand(['-l', '-q']);
  if (list.failed && !list.stdout.trim()) {
    return { available: false, distros: [], hostIps: [], error: 'WSL_UNAVAILABLE' };
  }
  const distros = parseWslDistroList(list.stdout);

  const address = await runWslCommand(['hostname', '-I']);
  const hostIps = address.failed ? [] : parseWslHostIps(address.stdout);

  return {
    available: true,
    distros,
    hostIps,
    ...(address.failed && hostIps.length === 0 ? { error: 'WSL_ADDRESS_UNAVAILABLE' } : {}),
  };
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One target answers with either its OpenAI-shaped `/models` list or, for
 * Ollama, its native `/api/tags` list. Entries keep the server-declared
 * capabilities so the settings panel can answer "does this model accept
 * images?" from the runtime itself rather than from its name.
 */
interface ProbedTarget {
  models: LocalAiModelEntry[];
  /** True when Ollama's native `/api/tags` route supplied the answer. */
  ollamaNativeRouteAnswered: boolean;
}

async function probeTarget(
  target: LocalAiProbeTarget,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ProbedTarget | undefined> {
  const listed = await fetchJson(
    fetchFn,
    resolveOpenAiModelsUrl('local_openai', target.baseUrl),
    timeoutMs,
  );
  const models = parseOpenAiStyleModelEntries(listed);
  if (models.length > 0) return { models, ollamaNativeRouteAnswered: false };

  if (target.presetId !== 'ollama') return undefined;
  const tagsUrl = localAiNativeTagsUrl(target.baseUrl);
  if (!tagsUrl) return undefined;
  const tags = await fetchJson(fetchFn, tagsUrl, timeoutMs);
  const nativeModels = parseOllamaTagModelEntries(tags);
  return nativeModels.length > 0
    ? { models: nativeModels, ollamaNativeRouteAnswered: true }
    : undefined;
}

/**
 * Probe stock local ports on loopback and on the WSL distribution address.
 * Loopback wins when both answer, because its base URL survives a WSL restart.
 */
export async function discoverLocalAiEndpoints(
  runtime: LocalAiDiscoveryRuntime = {},
): Promise<LocalAiDiscoveryResult> {
  const platform = runtime.platform ?? process.platform;
  const fetchFn = runtime.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const wslTimeoutMs = runtime.wslTimeoutMs ?? DEFAULT_WSL_TIMEOUT_MS;
  const runWslCommand =
    runtime.runWslCommand ??
    ((args: readonly string[]) => spawnWslCommand(args, wslTimeoutMs));

  const inventory: WslInventory =
    platform === 'win32'
      ? await readWslInventory(runWslCommand)
      : { available: false, distros: [], hostIps: [] };

  const loopbackHosts = ['127.0.0.1'];
  const wslHosts = inventory.hostIps.filter((host) => !isLoopbackHost(host));
  const targets = [
    ...localAiProbeTargets(loopbackHosts),
    ...localAiProbeTargets(wslHosts),
  ];

  const probes = await Promise.all(
    targets.map(async (target) => ({
      target,
      probed: await probeTarget(target, fetchFn, timeoutMs),
    })),
  );

  const endpoints: DiscoveredLocalAiEndpoint[] = [];
  const seenSlots = new Set<string>();
  // Loopback results are listed before WSL-address results, so a server that
  // answers on both is reported once with the durable base URL.
  for (const { target, probed } of probes) {
    if (!probed) continue;
    const { models } = probed;
    const slot = `${target.port}`;
    if (seenSlots.has(slot)) continue;
    seenSlots.add(slot);
    const capabilitiesReported = models.some(
      (entry) => entry.capabilities.length > 0,
    );
    // Name the server from its own answer, never from the port we probed.
    const runtimeName = detectLocalRuntimeName({
      owners: models.map((entry) => entry.owner),
      ollamaNativeRouteAnswered: probed.ollamaNativeRouteAnswered,
    });
    endpoints.push({
      presetId: target.presetId,
      label: target.label,
      baseUrl: target.baseUrl,
      host: target.host,
      port: target.port,
      source: isLoopbackHost(target.host) ? 'loopback' : 'wsl',
      // Sorted like `listAiModels`, so the picker order does not depend on
      // which route (discovery vs. model list) filled it.
      models: models.map((entry) => entry.id).sort((a, b) => a.localeCompare(b)),
      ...(capabilitiesReported
        ? {
            visionModels: models
              .filter((entry) => modelCapabilitiesDeclareVision(entry.capabilities))
              .map((entry) => entry.id),
            capabilitiesReported: true,
          }
        : {}),
      ...(runtimeName ? { runtime: runtimeName } : {}),
      ...(inventory.distros.length === 1 && !isLoopbackHost(target.host)
        ? { wslDistro: inventory.distros[0]! }
        : {}),
    });
  }

  return {
    endpoints,
    wslAvailable: inventory.available,
    wslDistros: inventory.distros,
    ...(inventory.error ? { wslError: inventory.error } : {}),
  };
}
