import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

describe("Renderer development content security policy", () => {
  let server: ViteDevServer;
  let html: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: path.resolve(import.meta.dirname, "../../vite.renderer.config.ts"),
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    html = await server.transformIndexHtml(
      "/",
      readFileSync(path.resolve(import.meta.dirname, "../../index.html"), "utf8"),
    );
  });

  afterAll(async () => server?.close());

  it("keeps a policy with nonce-bearing Vite and React scripts", () => {
    const policy = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u)?.[1]?.replaceAll("&#39;", "'");
    expect(policy).toBeDefined();
    const nonce = server.config.html?.cspNonce;
    expect(nonce).toBeTruthy();
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy?.match(/script-src ([^;]+)/u)?.[1]).not.toContain("'unsafe-inline'");
    const scriptTags = html.match(/<script\b[^>]*>/gu) ?? [];
    expect(scriptTags.length).toBeGreaterThan(1);
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(html.indexOf("<script"));
    for (const tag of scriptTags) expect(tag).toContain(`nonce="${nonce}"`);
  });

  it("allows Vite blob workers and loopback HMR without broad network access", () => {
    const policy = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/u)?.[1]?.replaceAll("&#39;", "'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("ws://localhost:*");
    expect(policy).not.toContain("connect-src *");
  });
});
