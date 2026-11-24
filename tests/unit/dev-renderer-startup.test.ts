import { describe, expect, it, vi } from "vitest";

import { loadRendererDevUrl } from "../../src/main/dev-renderer-load";

const url = "http://localhost:5173";

function fixture() {
  let destroyed = false;
  let now = 0;
  const logger = { info: vi.fn(), error: vi.fn() };
  const document = {
    readyState: "complete",
    querySelector: (selector: string) => selector === "#root" ? { childElementCount: 0 } : null,
  };
  const performance = {
    getEntriesByType: () => [{ name: `${url}/src/renderer/main.tsx` }],
  };
  const window = {
    isDestroyed: () => destroyed,
    loadURL: vi.fn(async () => undefined),
    webContents: {
      isDestroyed: () => destroyed,
      executeJavaScript: vi.fn(async (script: string) => {
        if (destroyed) throw new Error("WebContents has been destroyed");
        if (script.startsWith("import(")) return undefined;
        return new Function("document", "performance", `return ${script}`)(document, performance);
      }),
    },
  };
  const fetchUrl = vi.fn(async () => ({ ok: true }));
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const options = { now: () => now, sleep, fetchUrl, pollMs: 10_000 };
  return { logger, window, options, close: () => { destroyed = true; } };
}

describe("Development renderer startup", () => {
  it("waits 120 seconds without reloading a blank page and records its resource state", async () => {
    const context = fixture();

    await expect(loadRendererDevUrl(context.window, url, context.logger, context.options))
      .rejects.toThrow("Renderer did not mount within 120000ms: document=complete, root=0, resources=1, mainModule=true, viteError=false");

    expect(context.window.loadURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(context.logger.error).toHaveBeenCalledWith(
      "main.window.mount-failed",
      expect.any(Error),
      expect.objectContaining({ state: expect.stringContaining("resources=1, mainModule=true") }),
    );
  });

  it("ends startup when its window closes without reloading or reporting failure", async () => {
    const context = fixture();
    context.options.sleep.mockImplementationOnce(async () => { context.close(); });

    await expect(loadRendererDevUrl(context.window, url, context.logger, context.options)).resolves.toBeUndefined();

    expect(context.window.loadURL).toHaveBeenCalledTimes(1);
    expect(context.window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(context.logger.error).not.toHaveBeenCalled();
  });

  it("stops waiting for the dev server when its window closes", async () => {
    const context = fixture();
    context.options.fetchUrl.mockResolvedValue({ ok: false });
    context.options.sleep.mockImplementationOnce(async () => { context.close(); });

    await expect(loadRendererDevUrl(context.window, url, context.logger, context.options)).resolves.toBeUndefined();

    expect(context.options.fetchUrl).toHaveBeenCalledTimes(1);
    expect(context.window.loadURL).not.toHaveBeenCalled();
    expect(context.logger.error).not.toHaveBeenCalled();
  });

  it("does not retry or report a failed navigation after the window closes", async () => {
    const context = fixture();
    context.window.loadURL.mockImplementationOnce(async () => {
      context.close();
      throw new Error("Window has been destroyed");
    });

    await expect(loadRendererDevUrl(context.window, url, context.logger, context.options)).resolves.toBeUndefined();

    expect(context.window.loadURL).toHaveBeenCalledTimes(1);
    expect(context.logger.error).not.toHaveBeenCalled();
  });

  it("does not start work when its web contents have already been destroyed", async () => {
    const context = fixture();
    context.window.webContents.isDestroyed = () => true;

    await expect(loadRendererDevUrl(context.window, url, context.logger, context.options)).resolves.toBeUndefined();

    expect(context.options.fetchUrl).not.toHaveBeenCalled();
    expect(context.window.loadURL).not.toHaveBeenCalled();
    expect(context.window.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(context.logger.error).not.toHaveBeenCalled();
  });
});
