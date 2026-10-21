import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Page } from '@playwright/test';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

import type { SerpentLibraryApi } from '../../src/shared/library-api';
import { assetCard, resolveElectronExecutablePath, resolveSessionLogPath } from './electron-test-helpers';

test.describe.configure({ timeout: 120_000 });

async function failedPresentationJobs(page: Page) {
  return page.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { serpent: { library: SerpentLibraryApi } }).serpent.library;
    const libraries = await api.listOpen();
    if (!libraries.ok || !libraries.value[0]) throw new Error('No open library');
    const jobs = await api.listMediaJobs({ libraryId: libraries.value[0].libraryId, limit: 200 });
    if (!jobs.ok) throw new Error('Could not load media jobs');
    return jobs.value.jobs.filter((job) => job.errorCode === 'PRESENTATION_THUMBNAIL_UNAVAILABLE');
  });
}

test('missing embedded presentation covers fail directly and retries preserve valid IPC and source ranges', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'serpent-log-regressions-'));
  if (path.dirname(temporaryRoot) !== path.resolve(tmpdir())) throw new Error('Unexpected fixture path');
  const userDataPath = path.join(temporaryRoot, 'user-data');
  const sources = ['first.pptx', 'second.pptx'].map((name) => path.join(temporaryRoot, name));
  const imagePath = path.join(temporaryRoot, 'range-source.png');
  const coveredPath = path.join(temporaryRoot, 'covered.pptx');
  const libraryName = 'Session Log Regression';
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    for (const source of sources) {
      const archive = new AdmZip();
      archive.addFile('ppt/presentation.xml', Buffer.from(`<presentation name="${path.basename(source)}"/>`));
      archive.writeZip(source);
    }
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#387ba0' } }).png().toFile(imagePath);
    const covered = new AdmZip();
    covered.addFile('docProps/thumbnail.png', readFileSync(imagePath));
    covered.writeZip(coveredPath);
    const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
    application = await electron.launch({
      args: [applicationDirectory],
      cwd: applicationDirectory,
      executablePath: resolveElectronExecutablePath(),
      env: {
        ...process.env,
        SERPENT_E2E: '1',
        SERPENT_E2E_CREATE_PARENT_PATH: temporaryRoot,
        SERPENT_E2E_USER_DATA_PATH: userDataPath,
        SERPENT_E2E_IMPORT_FILES: [...sources, coveredPath, imagePath].join(path.delimiter),
        SERPENT_VIEWER_TIMING_LOG: '0',
      },
    });
    const page = await application.firstWindow();
    const keyErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /unique.*key|same key/i.test(message.text())) keyErrors.push(message.text());
    });
    await page.getByRole('button', { name: '创建资源库' }).click();
    await page.getByRole('textbox', { name: '名称' }).fill(libraryName);
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('button', { name: '导入文件', exact: true }).first().click();
    await expect(assetCard(page, 'first.pptx')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await failedPresentationJobs(page)).length, { timeout: 30_000 }).toBe(2);
    const coveredImage = assetCard(page, 'covered.pptx').locator('img.asset-thumbnail').first();
    await expect.poll(() => coveredImage.evaluate((image) =>
      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
    ), { timeout: 15_000 }).toBe(true);

    const beforeRetry = new Map((await failedPresentationJobs(page)).map((job) => [job.jobId, job.updatedAt]));
    await page.getByRole('button', { name: '更多工具' }).click();
    await page.getByRole('menuitem', { name: '后台任务' }).click();
    const jobsDialog = page.getByRole('dialog', { name: '后台媒体任务' });
    await expect(jobsDialog.getByText(/没有可用的内嵌封面/).first()).toBeVisible();
    await jobsDialog.getByRole('button', { name: '重试失败项', exact: true }).click();
    await expect.poll(async () => {
      const jobs = await failedPresentationJobs(page);
      return jobs.length === 2 && jobs.every((job) => job.updatedAt > (beforeRetry.get(job.jobId) ?? job.updatedAt));
    }, { timeout: 30_000 }).toBe(true);
    await jobsDialog.getByRole('button', { name: '关闭后台任务' }).click();

    const responses = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { serpent: { library: SerpentLibraryApi } }).serpent.library;
      const libraries = await api.listOpen();
      if (!libraries.ok || !libraries.value[0]) throw new Error('No library');
      const libraryId = libraries.value[0].libraryId;
      const assets = await api.listAssets({ libraryId, recursive: true });
      if (!assets.ok) throw new Error('No assets');
      const source = assets.value.find((asset) => asset.displayName === 'range-source.png');
      if (!source?.currentRevisionId) throw new Error('No source revision');
      const url = `serpent://source/${libraryId}/${source.assetId}?revision=${source.currentRevisionId}`;
      return Promise.all(Array.from({ length: 33 }, async () => {
        const response = await fetch(url, { headers: { range: 'bytes=0-15' }, cache: 'no-store' });
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
      }));
    });
    expect(responses).toHaveLength(33);
    expect(responses.every((response) => response.status === 206 && response.bytes === 16)).toBe(true);
    const logPath = resolveSessionLogPath(path.join(userDataPath, 'logs'));
    const logs = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as {
      scope: string; level: string; error?: { name?: string };
    });
    expect(logs.filter((entry) => entry.scope === 'worker.presentation-thumbnail.dependency-unavailable'))
      .toHaveLength(0);
    expect(logs.filter((entry) => entry.scope === 'serpent-protocol.source-request')).toHaveLength(0);
    expect(logs.filter((entry) => entry.scope === 'worker.presentation-thumbnail.soffice')).toHaveLength(0);
    expect(logs.filter((entry) => entry.error?.name === 'ZodError')).toHaveLength(0);
    expect(keyErrors).toEqual([]);
  } finally {
    if (application) {
      const child = application.process();
      if (child.exitCode === null) {
        await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
        await Promise.race([once(child, 'exit'), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
      await application.close().catch(() => undefined);
    }
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
