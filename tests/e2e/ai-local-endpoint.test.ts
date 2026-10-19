import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import sharp from "sharp";

import { resolveElectronExecutablePath } from "./electron-test-helpers";

test.describe.configure({ timeout: 180_000 });

const PROBE_MARKER = "Reply with the single word OK";
const DESCRIPTION = "本地模型生成的验收描述";
const TAG = "本地模型标签";

interface RecordedRequest {
  url: string;
  authorization: string | undefined;
  body: string;
}

/**
 * Keyless local model end to end (REQ local / WSL support).
 *
 * The profile is seeded as `local_openai` with **no** API key file at all,
 * which is exactly how a user's Ollama setup looks. The test proves the whole
 * chain works without ever pasting a credential: startup treats the profile as
 * configured, the settings panel renders the local controls, the analysis
 * request reaches the endpoint, and — the point of the keyless path — no
 * Authorization header is ever sent.
 */
test("analyzes through a keyless local OpenAI-compatible endpoint", async () => {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });

      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "qwen2.5vl:7b" }, { id: "llama3.2:3b" }],
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/tags") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ models: [{ name: "qwen2.5vl:7b" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const content = body.includes(PROBE_MARKER)
          ? "OK"
          : JSON.stringify({ description: DESCRIPTION, tags: [TAG], rating: 5 });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: "qwen2.5vl:7b",
          choices: [{ message: { role: "assistant", content } }],
        }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `no route for ${request.url}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "serpent-ai-local-e2e-"));
  const libraryName = "本地模型验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const userDataPath = path.join(temporaryRoot, "user-data");

  // A keyless local profile: note the deliberate absence of any key file.
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, "ai-config.json"),
    JSON.stringify(
      {
        apiFormat: "local_openai",
        model: "qwen2.5vl:7b",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        descriptionEnabled: true,
        tagEnabled: true,
        ratingEnabled: true,
        analysisSettings: { forceExistingTags: false },
        concurrencyLimit: 2,
        maxAnalysisImageEdgePx: 2048,
        languages: ["zh-CN"],
        autoAnalyzeEnabled: false,
        disclaimerAccepted: true,
      },
      null,
      2,
    ),
  );

  const imagePath = path.join(temporaryRoot, "local-sample.png");
  await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 120, b: 200, g: 90 },
    },
  })
    .png()
    .toFile(imagePath);

  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: {
      ...process.env,
      SERPENT_E2E: "1",
      SERPENT_E2E_CREATE_PARENT_PATH: temporaryRoot,
      SERPENT_E2E_OPEN_LIBRARY_PATH: libraryPath,
      SERPENT_E2E_USER_DATA_PATH: userDataPath,
      SERPENT_E2E_IMPORT_FILES: imagePath,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    // The create/open transition must finish before importing: an import during
    // it is rejected with TRANSFER_IN_PROGRESS and the fatal alert it raises
    // then blocks later clicks behind its backdrop.
    await expect(
      window.getByText(libraryName, { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The startup heartbeat must probe the keyless profile on its own; no key
    // is ever entered. This is also what the connection indicator depends on.
    await expect
      .poll(
        () => requests.filter((entry) => entry.body.includes(PROBE_MARKER)).length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    // The env-driven import can land while the library transition is still
    // holding its lock, in which case the app raises a fatal "import failed"
    // alert. Dismiss it and retry the way a user would.
    const card = window.locator(".asset-card").filter({ hasText: "local-sample.png" });
    const importButton = window
      .getByRole("button", { name: "导入文件", exact: true })
      .first();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const alert = window.getByRole("alertdialog");
      if ((await alert.count()) > 0) {
        await alert.getByRole("button", { name: "知道了" }).click();
        await expect(alert).toBeHidden({ timeout: 10_000 });
      }
      if ((await card.count()) > 0) break;
      if ((await importButton.count()) > 0) {
        await importButton.click({ timeout: 10_000 }).catch(() => undefined);
      }
      await window.waitForTimeout(1_000);
    }
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The local controls must be reachable from the real settings surface.
    await window.getByRole("button", { name: "主菜单" }).click();
    await window.getByRole("menuitem", { name: "设置", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "通用设置" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "AI分析", exact: true }).click();
    await expect(dialog.locator("#ai-config-api-format")).toHaveValue("local_openai");
    await expect(
      dialog.getByRole("button", { name: "检测本地/WSL 服务" }),
    ).toBeVisible();
    // Presets are port shortcuts, so they carry the port in their label.
    await expect(
      dialog.getByRole("button", { name: "Ollama (11434)", exact: true }),
    ).toBeVisible();
    await dialog.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    await card.click();
    await card.click({ button: "right" });
    await window.getByRole("menuitem", { name: "AI 分析" }).click();

    await expect
      .poll(
        () =>
          requests.some(
            (entry) =>
              entry.url === "/v1/chat/completions" &&
              !entry.body.includes(PROBE_MARKER),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    // The regression that matters: a keyless local runtime must never receive
    // an Authorization header, and the analysis must land in the Inspector.
    expect(
      requests.filter((entry) => entry.authorization !== undefined),
    ).toEqual([]);

    const inspector = window.locator(".inspector-pane");
    await expect(inspector.getByText(TAG)).toBeVisible({ timeout: 20_000 });
    await expect(inspector.locator("#meta-desc")).toHaveValue(DESCRIPTION, {
      timeout: 20_000,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await application.close();
  }
});

/**
 * Regression (Serpent local-model setup): the settings panel tests the *draft*
 * profile, and before the first save the stored profile is still a cloud
 * format with no key. Resolving the stored key threw, so `Test connection`
 * reported a bare "AI_ANALYSIS_FAILED" — and the panel then showed the
 * "cannot reach the local service" hint — for a server that was reachable all
 * along. A user could only get past it by saving blindly.
 */
test("tests a hand-typed local endpoint before anything is saved", async () => {
  const probeRequests: Array<{ authorization: string | undefined }> = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        probeRequests.push({ authorization: request.headers.authorization });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: "local",
          choices: [{ message: { role: "assistant", content: "OK" } }],
        }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "serpent-ai-local-draft-"));
  const libraryName = "本地草稿验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const userDataPath = path.join(temporaryRoot, "user-data");
  // Deliberately no seeded ai-config.json: this is a first-time setup.
  mkdirSync(userDataPath, { recursive: true });

  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: {
      ...process.env,
      SERPENT_E2E: "1",
      SERPENT_E2E_CREATE_PARENT_PATH: temporaryRoot,
      SERPENT_E2E_OPEN_LIBRARY_PATH: libraryPath,
      SERPENT_E2E_USER_DATA_PATH: userDataPath,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await expect(
      window.getByText(libraryName, { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    await window.getByRole("button", { name: "主菜单" }).click();
    await window.getByRole("menuitem", { name: "设置", exact: true }).click();
    const dialog = window.getByRole("dialog", { name: "通用设置" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "AI分析", exact: true }).click();

    // A hand-typed endpoint on a non-stock port, exactly like a llama.cpp
    // server started with --port 8000.
    await dialog.locator("#ai-config-api-format").selectOption("local_openai");
    // Selecting the format kicks off an automatic stock-port probe that may
    // fill the fields. Let it settle before overriding them by hand, otherwise
    // this machine's own local server decides the outcome of the test.
    await expect
      .poll(
        async () => {
          const busy = await dialog
            .getByRole("button", { name: /检测中|aiConfig\.localDiscovering/ })
            .count();
          const endpoints = await dialog.locator(".ai-config-local-endpoint").count();
          const empty = await dialog.getByText(/未检测到本地模型服务/).count();
          return busy === 0 && (endpoints > 0 || empty > 0);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await dialog.locator("#ai-config-base-url").fill(`http://127.0.0.1:${port}/v1`);
    await dialog.locator("#ai-config-model").fill("/home/me/models/local.gguf");
    await expect(dialog.locator("#ai-config-base-url")).toHaveValue(
      `http://127.0.0.1:${port}/v1`,
    );

    await dialog
      .getByRole("button", { name: /测试连接|aiConfig\.testConnection/ })
      .click();
    const inline = dialog.locator(".ai-config-test-inline");
    await expect(inline).toHaveAttribute("data-ok", "true", { timeout: 60_000 });
    await expect(inline).toHaveText(/连接成功|aiConfig\.testOk/);
    // The misleading "cannot reach the local service" hint must not appear.
    await expect(dialog.locator(".ai-config-local-troubleshoot")).toHaveCount(0);
    // Every probe that reached the stub was keyless. The app may probe once
    // more after a success flips its connection state, so count is not fixed.
    expect(probeRequests.length).toBeGreaterThan(0);
    expect(
      probeRequests.filter((entry) => entry.authorization !== undefined),
    ).toEqual([]);

    // Nothing was saved yet, so the probe must have used the draft values.
    expect(existsSync(path.join(userDataPath, "ai-config.json"))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await application.close();
  }
});
