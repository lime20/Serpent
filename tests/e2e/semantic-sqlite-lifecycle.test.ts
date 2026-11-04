import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { chooseStandardOption, resolveElectronExecutablePath } from './electron-test-helpers';

test.describe.configure({ timeout: 180_000 });

async function openSemanticSettings(window: Page): Promise<void> {
  await window.getByRole('button', { name: /主菜单|设置/ }).click();
  const settings = window.getByRole('menuitem', { name: '设置', exact: true });
  if (await settings.isVisible()) await settings.click();
  // The nav tab's accessible name includes the experimental badge.
  await window.getByRole('tab', { name: /语义搜索/ }).click();
  await window.getByRole('tab', { name: '自定义', exact: true }).click();
}

async function findImportedAssetCard(window: Page, fileName: string) {
  const assetId = await window.evaluate(async (name) => {
    const api = (globalThis as typeof globalThis & { serpent: { library: {
      listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
      listAssets(input: { libraryId: string; recursive: boolean }): Promise<{
        ok: boolean; value?: Array<{ assetId: string; relativeFilePath: string }>;
      }>;
    } } }).serpent.library;
    const opened = await api.listOpen();
    const libraryId = opened.value?.[0]?.libraryId;
    if (!opened.ok || !libraryId) throw new Error('The semantic fixture library is not open.');
    const listed = await api.listAssets({ libraryId, recursive: true });
    if (!listed.ok) throw new Error('Could not list semantic fixture assets.');
    return listed.value?.find((asset) => asset.relativeFilePath.endsWith(name))?.assetId ?? null;
  }, fileName);
  if (!assetId) throw new Error(`The semantic fixture asset ${fileName} is missing.`);
  return window.locator(`[data-asset-id="${assetId}"]`);
}

async function closeApplicationBounded(application: {
  close(): Promise<void>;
  process(): ChildProcess;
}): Promise<void> {
  const process = application.process();
  let exited = process.exitCode !== null || process.signalCode !== null;
  const exit = new Promise<void>((resolve) => {
    if (exited) resolve();
    else process.once('exit', () => { exited = true; resolve(); });
  });
  let closeTimer: NodeJS.Timeout | undefined;
  const closedGracefully = await Promise.race([
    application.close().then(() => true, () => false),
    new Promise<boolean>((resolve) => { closeTimer = setTimeout(() => resolve(false), 10_000); }),
  ]);
  if (closeTimer) clearTimeout(closeTimer);
  let exitedInTime = await Promise.race([
    exit.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exitedInTime) {
    process.kill('SIGTERM');
    exitedInTime = await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
  }
  if (!exitedInTime) {
    process.kill('SIGKILL');
    exitedInTime = await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
  }
  if (!exitedInTime) throw new Error('Electron child process did not exit after bounded cleanup.');
  if (!closedGracefully) throw new Error('Electron close exceeded its 10 second cleanup limit.');
}

test('persists Worker-owned vectors through full app restart and reuses them for search', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'serpent-semantic-sqlite-e2e-'));
  const corpusPath = path.join(temporaryRoot, 'semantic-corpus.txt');
  const otherPath = path.join(temporaryRoot, 'other-corpus.txt');
  const failedPath = path.join(temporaryRoot, 'semantic-failure.txt');
  const imagePath = path.join(temporaryRoot, 'unsupported-image.png');
  writeFileSync(corpusPath, 'semantic corpus seed alpha');
  writeFileSync(otherPath, 'semantic corpus seed beta');
  writeFileSync(failedPath, 'semantic corpus seed provider failure');
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let corpusRequests = 0;
  let queryRequests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    for (const input of inputs) {
      if (input.includes('semantic corpus seed')) corpusRequests += 1;
      else queryRequests += 1;
    }
    if (inputs.some((input) => input.includes('provider failure'))) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture provider failure.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: inputs.map((input, index) => ({
      index,
      embedding: input.includes('quarterly budget meeting') || input.includes('beta')
        ? [0, 1, ...new Array(766).fill(0)]
        : [1, 0, ...new Array(766).fill(0)],
    })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Embedding fixture server did not bind.');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;

  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const launch = () => electron.launch({
    timeout: 30_000,
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: {
      ...process.env,
      SERPENT_E2E: '1',
      SERPENT_E2E_HIDE_WINDOW: '1',
      SERPENT_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'user-data'),
      SERPENT_E2E_CREATE_PARENT_PATH: temporaryRoot,
      SERPENT_E2E_OPEN_LIBRARY_PATH: path.join(temporaryRoot, 'Semantic fixture'),
      SERPENT_E2E_IMPORT_FILES: [corpusPath, otherPath, failedPath, imagePath].join(path.delimiter),
    },
  });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    let window = await application.firstWindow();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole('textbox', { name: '名称', exact: true }).fill('Semantic fixture');
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await window.getByRole('button', { name: '导入文件', exact: true }).first().click();
    await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { serpent: { library: {
        listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
        importFiles(input: { libraryId: string }): Promise<{ ok: boolean }>;
      } } }).serpent.library;
      const opened = await api.listOpen();
      const libraryId = opened.value?.[0]?.libraryId;
      if (!opened.ok || !libraryId) throw new Error('The semantic fixture library is not open.');
      const imported = await api.importFiles({ libraryId });
      if (!imported.ok) throw new Error('Could not import semantic fixture assets.');
    });

    await openSemanticSettings(window);
    await expect(window.getByText(/可以用自然语言模糊查找内容.*内存占用会增加/u)).toBeVisible();
    await window.getByRole('button', { name: '添加服务', exact: true }).click();
    await window.locator('#embedding-service-name').fill('Local semantic fixture');
    await window.locator('#embedding-service-url').fill(endpoint);
    await window.locator('#embedding-service-model').fill('controlled-fixture-model');
    await window.locator('#embedding-service-dimensions').fill('768');
    await window.locator('.semantic-service-form').getByRole('button', { name: '保存', exact: true }).click();
    const serviceCard = window.locator('.semantic-model-card').filter({ hasText: 'Local semantic fixture' });
    await expect(serviceCard).toBeVisible();
    await serviceCard.getByRole('button').nth(1).click();
    await expect(serviceCard.getByRole('status')).toContainText('768');
    await window.getByRole('switch', { name: '开启语义搜索' }).click();
    await chooseStandardOption(window.getByRole('combobox', { name: '默认模型' }), { label: 'Local semantic fixture' });

    const readIndexState = () => window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { serpent: { library: {
        listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
        embeddingIndexStatus(input: { libraryId: string; modelId: string; run: boolean; restart: boolean }): Promise<{
          ok: boolean; value?: { phase: string; done: number; total: number; failedCount: number };
        }>;
        embeddingListServices(): Promise<{ ok: boolean; value?: Array<{ id: string; name: string }> }>;
      } } }).serpent.library;
      const opened = await api.listOpen();
      const services = await api.embeddingListServices();
      const libraryId = opened.value?.[0]?.libraryId;
      const service = services.value?.find((entry) => entry.name === 'Local semantic fixture');
      if (!libraryId || !service) throw new Error('Semantic service binding is unavailable.');
      const status = await api.embeddingIndexStatus({ libraryId, modelId: service.id, run: true, restart: false });
      return status.value;
    });
    await expect.poll(readIndexState, { timeout: 90_000 }).toMatchObject({
      phase: 'ready', done: 2, total: 3, failedCount: 1,
    });
    const indexedCorpusCalls = corpusRequests;
    expect(indexedCorpusCalls).toBe(3);

    await window.keyboard.press('Escape');
    const failedAssetCard = await findImportedAssetCard(window, 'semantic-failure.txt');
    await failedAssetCard.click();
    await failedAssetCard.click({ button: 'right' });
    const failedContextMenu = window.getByRole('menu');
    await expect(failedContextMenu.getByRole('menuitem', { name: '找相似', exact: true })).toBeVisible();
    await failedContextMenu.getByRole('menuitem', { name: '找相似', exact: true }).click();
    await expect(window.getByText('此资产未能完成向量编码，暂时无法查找相似内容。')).toBeVisible();
    await window.getByRole('button', { name: '更多工具', exact: true }).click();
    await window.getByRole('menuitem', { name: '后台任务', exact: true }).click();
    await expect(window.locator('.media-jobs-embedding-section'))
      .toContainText('有 1 个文本未能完成编码');
    await window.getByRole('button', { name: '关闭后台任务' }).click();

    await window.keyboard.press('Escape');
    const supportedTextCard = await findImportedAssetCard(window, 'semantic-corpus.txt');
    await supportedTextCard.click();
    await supportedTextCard.click({ button: 'right' });
    const textContextMenu = window.getByRole('menu');
    await expect(textContextMenu.getByRole('menuitem', { name: '找相似', exact: true })).toBeVisible();
    await window.keyboard.press('Escape');
    const unsupportedImageCard = await findImportedAssetCard(window, 'unsupported-image.png');
    await unsupportedImageCard.click();
    await unsupportedImageCard.click({ button: 'right' });
    const imageContextMenu = window.getByRole('menu');
    await expect(imageContextMenu).toBeVisible();
    await expect(imageContextMenu.getByRole('menuitem', { name: '找相似', exact: true })).toHaveCount(0);
    await window.keyboard.press('Escape');
    const search = window.getByRole('combobox', { name: '搜索资源库' });
    await search.fill('quarterly budget meeting');
    const queriesBeforeUi = queryRequests;
    await window.locator('.search-semantic-toggle').click();
    await expect(window.locator('.search-semantic-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => queryRequests, { message: 'UI semantic query was not submitted.' }).toBeGreaterThan(queriesBeforeUi);
    const corpusCards = window.getByRole('button', { name: /semantic corpus seed (alpha|beta) TXT/ });
    await expect(corpusCards).toHaveCount(2);
    await expect(corpusCards.nth(0)).toHaveAccessibleName(/semantic corpus seed beta TXT/);
    await window.screenshot({ path: path.join(process.cwd(), 'test-results', 'semantic-sqlite-lifecycle.png') });

    const ids = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { serpent: { library: {
        listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
        listAssets(input: { libraryId: string; query?: string; limit?: number }): Promise<{
          ok: boolean; value?: { assets: Array<{ assetId: string; relativeFilePath: string }> };
        }>;
        embeddingListServices(): Promise<{ ok: boolean; value?: Array<{ id: string; name: string }> }>;
        embeddingSearch(input: { libraryId: string; modelId: string; query: string; filters?: Array<{
          field: 'format'; values: string[]; exclude: boolean;
        }> }): Promise<{ ok: boolean; value?: { assetIds: string[] } }>;
        embeddingSimilar(input: { libraryId: string; modelId: string; assetId: string }): Promise<{
          ok: boolean; value?: { status: string; assetIds: string[] };
        }>;
      } } }).serpent.library;
      const opened = await api.listOpen();
      const libraryId = opened.value?.[0]?.libraryId;
      const services = await api.embeddingListServices();
      const serviceId = services.value?.find((entry) => entry.name === 'Local semantic fixture')?.id;
      if (!libraryId || !serviceId) throw new Error('Semantic fixture service is unavailable.');
      const filtered = await api.embeddingSearch({ libraryId, modelId: serviceId,
        query: 'semantic fixture filtered query', filters: [{ field: 'format', values: ['txt'], exclude: false }] });
      const sourceAssetId = filtered.value?.assetIds[0];
      if (!sourceAssetId) throw new Error('Semantic text fixture is missing.');
      const similar = await api.embeddingSimilar({ libraryId, modelId: serviceId, assetId: sourceAssetId });
      if (!filtered.ok || !filtered.value || !similar.ok || !similar.value) throw new Error('Semantic search API failed.');
      return { filtered: filtered.value.assetIds, similar: similar.value };
    });
    expect(ids.filtered).toHaveLength(2);
    expect(ids.similar.status).toBe('ready');
    expect(ids.similar.assetIds).toHaveLength(1);

    await closeApplicationBounded(application);
    application = undefined;
    application = await launch();
    window = await application.firstWindow();
    await window.getByRole('button', { name: '打开资源库', exact: true }).click();
    await expect(window.getByRole('button', { name: /当前资源库 Semantic fixture/ })).toBeVisible();
    await openSemanticSettings(window);
    await expect.poll(readIndexState, { timeout: 90_000 }).toMatchObject({
      phase: 'ready', done: 2, total: 3, failedCount: 1,
    });
    expect(corpusRequests).toBe(indexedCorpusCalls);
    await window.keyboard.press('Escape');
    const queriesBeforeRestartSearch = queryRequests;
    await window.getByRole('combobox', { name: '搜索资源库' }).fill('quarterly budget meeting');
    const toggle = window.locator('.search-semantic-toggle');
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    await expect.poll(() => queryRequests, { message: 'Post-restart semantic query was not submitted.' })
      .toBeGreaterThan(queriesBeforeRestartSearch);
    const reopenedCorpusCards = window.getByRole('button', { name: /semantic corpus seed (alpha|beta) TXT/ });
    await expect(reopenedCorpusCards).toHaveCount(2);
    await expect(reopenedCorpusCards.nth(0)).toHaveAccessibleName(/semantic corpus seed beta TXT/);
  } finally {
    if (application) await closeApplicationBounded(application);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
