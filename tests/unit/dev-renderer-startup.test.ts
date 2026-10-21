// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run the startup functions without evaluating the Electron main entry's
// process-wide handlers, native modules, or application startup side effects.
const mainSource = readFileSync(path.resolve(import.meta.dirname, "../../src/main/index.ts"), "utf8");
const startupSource = mainSource.slice(
  mainSource.indexOf("const DEV_SERVER_WAIT_MS"),
  mainSource.indexOf("function attachRendererDiagnostics"),
);
const javascript = ts.transpileModule(startupSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
  let destroyed = false;
  let attempts = 0;
  const logger = { info: vi.fn(), error: vi.fn() };
  const document = {
    readyState: "complete",
    querySelector: () => attempts > 1 ? {} : null,
    getElementById: () => ({ childElementCount: 0 }),
  };
  const performance = {
    getEntriesByType: () => [{
      name: "http://localhost:5173/src/renderer/main.tsx",
      duration: 123,
      initiatorType: "script",
    }],
  };
  const window = {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async () => {
      if (destroyed) throw new Error("Window has been destroyed");
      attempts += 1;
    }),
    webContents: {
      isDestroyed: () => destroyed,
      executeJavaScript: vi.fn(async (script: string) => {
        if (destroyed) throw new Error("WebContents has been destroyed");
        return new Function("document", "performance", `return ${script}`)(document, performance);
      }),
    },
  };
  const fetch = vi.fn(async () => ({ ok: true }));
  const load = new Function("logger", "fetch", `${javascript}; return loadRendererDevUrl;`)(logger, fetch) as
    (target: typeof window, url: string) => Promise<void>;
  return { logger, window, load, close: () => { destroyed = true; } };
}

describe("Development renderer startup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records document and resource evidence when a mounted shell is missing", async () => {
    const context = fixture();
    const loading = context.load(context.window, "http://localhost:5173");
    await vi.runAllTimersAsync();
    await loading;

    expect(context.logger.info).toHaveBeenCalledWith(
      "main.window.mount-retry",
      expect.any(String),
      expect.objectContaining({
        attempt: 1,
        snapshot: expect.objectContaining({ mounted: false, readyState: "complete", rootChildCount: 0 }),
      }),
    );
    expect(context.window.loadURL).toHaveBeenCalledTimes(2);
  });

  it("ends startup when its window closes without reloading or reporting failure", async () => {
    const context = fixture();
    let failure: unknown;
    const loading = context.load(context.window, "http://localhost:5173").catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(1);
    context.close();
    await vi.runAllTimersAsync();
    await loading;

    expect(context.window.loadURL).toHaveBeenCalledTimes(1);
    expect(context.window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(context.logger.error).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
  });

  it("retains renderer probe failures in the timeout evidence", async () => {
    const context = fixture();
    context.window.webContents.executeJavaScript.mockRejectedValue(new Error("Renderer execution context unavailable"));
    let failure: unknown;
    const loading = context.load(context.window, "http://localhost:5173").catch(error => { failure = error; });
    await vi.runAllTimersAsync();
    await loading;

    expect(failure).toBeInstanceOf(Error);
    expect(context.logger.info).toHaveBeenCalledWith(
      "main.window.mount-retry",
      expect.any(String),
      expect.objectContaining({
        snapshot: expect.objectContaining({ mounted: false, probeError: "Renderer execution context unavailable" }),
      }),
    );
  });
});
