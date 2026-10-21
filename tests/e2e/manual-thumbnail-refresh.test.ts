import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import type { SerpentLibraryApi } from "../../src/shared/library-api";
import { assetCard, resolveElectronExecutablePath } from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

async function thumbnailSnapshot(page: Page) {
  return page.evaluate(async () => {
    const api = (globalThis as typeof globalThis & {
      serpent: { library: SerpentLibraryApi };
    }).serpent.library;
    const libraries = await api.listOpen();
    if (!libraries.ok || !libraries.value[0]) throw new Error("No open library");
    const assets = await api.listAssets({
      libraryId: libraries.value[0].libraryId,
      recursive: true,
    });
    if (!assets.ok) throw new Error("Could not read thumbnail state");
    return assets.value.map((asset) => ({
      assetId: asset.assetId,
      displayName: asset.displayName,
      artifactId: asset.thumbnailArtifactId,
      status: asset.thumbnailStatus,
      previewKind: asset.previewKind,
    }));
  });
}

test("context menu refresh replaces a ready thumbnail and batch refresh generates a source-direct image", async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "serpent-manual-thumbnail-"));
  if (path.dirname(temporaryRoot) !== path.resolve(tmpdir())) {
    throw new Error("Unexpected temporary fixture path");
  }
  const libraryName = "Thumbnail Refresh";
  const largePath = path.join(temporaryRoot, "large-cover.png");
  const smallPath = path.join(temporaryRoot, "small-cover.png");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: "#3481b0" },
    }).png().toFile(largePath);
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#b06634" },
    }).png().toFile(smallPath);

    const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
    application = await electron.launch({
      args: [applicationDirectory],
      cwd: applicationDirectory,
      executablePath: resolveElectronExecutablePath(),
      env: {
        ...process.env,
        SERPENT_E2E: "1",
        SERPENT_E2E_CREATE_PARENT_PATH: temporaryRoot,
        SERPENT_E2E_OPEN_LIBRARY_PATH: path.join(temporaryRoot, libraryName),
        SERPENT_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
        SERPENT_E2E_IMPORT_FILES: [largePath, smallPath].join(path.delimiter),
      },
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "创建资源库" }).click();
    await page.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: "导入文件", exact: true }).first().click();

    const largeCard = assetCard(page, "large-cover.png");
    const smallCard = assetCard(page, "small-cover.png");
    await expect(largeCard).toBeVisible({ timeout: 15_000 });
    await expect(smallCard).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () =>
      (await thumbnailSnapshot(page)).find((asset) => asset.displayName === "large-cover.png")?.status,
    { timeout: 30_000 }).toBe("ready");
    const initial = await thumbnailSnapshot(page);
    const originalArtifactId = initial.find((asset) => asset.displayName === "large-cover.png")?.artifactId;
    expect(originalArtifactId).toBeTruthy();
    expect(initial.find((asset) => asset.displayName === "small-cover.png")).toMatchObject({
      artifactId: null,
      previewKind: "source",
    });

    // Import selects the imported group; explicitly choose the single target.
    await largeCard.click();
    await largeCard.click({ button: "right" });
    await expect(page.getByRole("menu").getByText("已选择 1 项", { exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "刷新缩略图", exact: true }).click();
    await expect.poll(async () => {
      const large = (await thumbnailSnapshot(page)).find((asset) => asset.displayName === "large-cover.png");
      return large?.status === "ready" && Boolean(large.artifactId) && large.artifactId !== originalArtifactId;
    }, { timeout: 30_000 }).toBe(true);
    const refreshedArtifactId = (await thumbnailSnapshot(page))
      .find((asset) => asset.displayName === "large-cover.png")!.artifactId!;
    await expect(largeCard.locator("img.asset-thumbnail").first())
      .toHaveAttribute("src", new RegExp(refreshedArtifactId));

    await largeCard.click();
    await smallCard.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await smallCard.click({ button: "right" });
    await page.getByRole("menuitem", { name: "刷新缩略图（2 项）", exact: true }).click();
    await expect.poll(async () => {
      const assets = await thumbnailSnapshot(page);
      const large = assets.find((asset) => asset.displayName === "large-cover.png");
      const small = assets.find((asset) => asset.displayName === "small-cover.png");
      return large?.status === "ready" && large.artifactId !== refreshedArtifactId
        && small?.status === "ready" && Boolean(small.artifactId);
    }, { timeout: 30_000 }).toBe(true);
    const final = await thumbnailSnapshot(page);
    for (const [card, name] of [[largeCard, "large-cover.png"], [smallCard, "small-cover.png"]] as const) {
      const artifactId = final.find((asset) => asset.displayName === name)!.artifactId!;
      const image = card.locator("img.asset-thumbnail").first();
      await expect(image).toHaveAttribute("src", new RegExp(artifactId));
      await expect.poll(() => image.evaluate((element) =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
      )).toBe(true);
    }
  } finally {
    if (application) {
      const child = application.process();
      if (child.exitCode === null) {
        await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
        await Promise.race([
          once(child, "exit"),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
      if (child.exitCode === null) child.kill("SIGKILL");
      await application.close().catch(() => undefined);
    }
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
