// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../src/renderer/i18n";
import { loadViewerBackdropPreferences } from "../../src/renderer/viewer-backdrop-preferences";
import { ZoomableImage } from "../../src/renderer/zoomable-preview-image";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SIZE = 8;

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Mirage-tank encoding: `alpha = 1 − (white − black)`, `color = black / alpha`.
 * Over black the frame shows `blackTarget`, over white it shows `whiteTarget`.
 */
function mirageImageData(): ImageData {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const black = 40 + ((x + y) % 2) * 60;
      const white = 200 - ((x + y) % 2) * 60;
      const alpha = 1 - (white - black) / 255;
      const color = black / alpha;
      const index = (y * SIZE + x) * 4;
      data[index] = clampChannel(color);
      data[index + 1] = clampChannel(color);
      data[index + 2] = clampChannel(color);
      data[index + 3] = clampChannel(alpha * 255);
    }
  }
  return { width: SIZE, height: SIZE, data, colorSpace: "srgb" } as ImageData;
}

function opaqueImageData(): ImageData {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 120;
    data[index + 1] = 120;
    data[index + 2] = 120;
    data[index + 3] = 255;
  }
  return { width: SIZE, height: SIZE, data, colorSpace: "srgb" } as ImageData;
}

function markDecoded(image: HTMLImageElement): void {
  Object.defineProperty(image, "complete", { configurable: true, get: () => true });
  Object.defineProperty(image, "naturalWidth", {
    configurable: true,
    get: () => 64,
  });
  Object.defineProperty(image, "naturalHeight", {
    configurable: true,
    get: () => 64,
  });
  image.decode = () => Promise.resolve();
}

describe("ZoomableImage mirage-tank backdrop", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let sampled: ImageData | null = null;

  beforeEach(() => {
    sampled = null;
    window.localStorage.clear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    // The zoom/pan hook re-fits on resize; that path is not what this test
    // covers, and happy-dom's observer fires outside the act scope.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          drawImage: () => undefined,
          getImageData: () => sampled,
        }) as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(async () => {
    // React 19 flags a root update outside act; unmounting the viewer is one.
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderViewer(
    src: string,
    alphaCapable = false,
  ): Promise<HTMLImageElement> {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        createElement(LocaleProvider, {
          initialPreference: "zh-CN",
          children: createElement(ZoomableImage, {
            src,
            alt: "asset",
            alphaCapable,
          }),
        }),
      );
    });
    const image = container.querySelector<HTMLImageElement>("img.preview-image");
    if (!image) throw new Error("viewer image missing");
    return image;
  }

  async function decode(image: HTMLImageElement): Promise<void> {
    // Dispatch and flush inside one act scope: the promotion chain awaits
    // `decode()` and a rAF, and its continuations must resume while act still
    // wraps the update queue.
    await act(async () => {
      markDecoded(image);
      image.dispatchEvent(new Event("load"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function imageClasses(): string {
    return (
      container?.querySelector<HTMLImageElement>("img.preview-image")?.className ??
      ""
    );
  }

  it("detects a mirage texture and offers the backdrop switch", async () => {
    sampled = mirageImageData();
    const image = await renderViewer("serpent://source/mirage.png");
    expect(
      container!.querySelector("[data-viewer-mirage-hint]"),
    ).toBeNull();

    await decode(image);

    expect(container!.querySelector("[data-viewer-mirage-hint]")).not.toBeNull();
    const select = container!.querySelector<HTMLSelectElement>(
      ".preview-backdrop-control select",
    );
    expect(select?.value).toBe("auto");
    expect(
      Array.from(select?.options ?? []).map((option) => option.value),
    ).toEqual(["auto", "black", "white", "gray", "checkerboard"]);
    // `auto` keeps the stage as-is: no matte class on the bitmap.
    expect(imageClasses()).not.toContain("is-backdrop-");
  });

  it("applies the chosen matte and persists it", async () => {
    sampled = mirageImageData();
    const image = await renderViewer("serpent://source/mirage.png");
    await decode(image);

    const select = container!.querySelector<HTMLSelectElement>(
      ".preview-backdrop-control select",
    );
    await act(async () => {
      select!.value = "white";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(imageClasses()).toContain("is-backdrop-white");
    expect(
      container!
        .querySelector(".preview-image-viewport")
        ?.getAttribute("data-viewer-backdrop"),
    ).toBe("white");
    expect(loadViewerBackdropPreferences().backdrop).toBe("white");
  });

  it("reveals the other picture from the hint button", async () => {
    sampled = mirageImageData();
    const image = await renderViewer("serpent://source/mirage.png");
    await decode(image);

    const reveal = Array.from(
      container!.querySelectorAll<HTMLButtonElement>(
        "[data-viewer-mirage-hint] button",
      ),
    )[0];
    await act(async () => {
      reveal?.click();
    });

    // Anything other than white flips to white, so the second picture shows.
    expect(imageClasses()).toContain("is-backdrop-white");
    expect(loadViewerBackdropPreferences().backdrop).toBe("white");
  });

  it("keeps ordinary images on the default stage", async () => {
    sampled = opaqueImageData();
    const image = await renderViewer("serpent://source/photo.jpg");
    await decode(image);

    expect(container!.querySelector("[data-viewer-mirage-hint]")).toBeNull();
    expect(
      container!.querySelector(".preview-backdrop-control"),
    ).toBeNull();
    expect(imageClasses()).not.toContain("is-backdrop-");
  });

  it("keeps a stored matte reachable for images without alpha", async () => {
    window.localStorage.setItem(
      "serpent.viewer-backdrop-preferences.v1",
      JSON.stringify({ version: 1, backdrop: "black" }),
    );
    sampled = opaqueImageData();
    const image = await renderViewer("serpent://source/photo.jpg");
    await decode(image);

    const select = container!.querySelector<HTMLSelectElement>(
      ".preview-backdrop-control select",
    );
    expect(select?.value).toBe("black");
    expect(imageClasses()).toContain("is-backdrop-black");
  });

  it("requests viewer images in CORS mode so pixel sampling can read them", async () => {
    sampled = opaqueImageData();
    const image = await renderViewer("serpent://source/photo.png", true);

    // Without this attribute Chromium taints the canvas for `serpent://`
    // responses and both the detector and the chrome-contrast sampler silently
    // fall back to "no data".
    expect(image.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("falls back to the source format when pixels cannot be sampled", async () => {
    sampled = null;
    const image = await renderViewer("serpent://source/texture.png", true);
    await decode(image);

    expect(
      container!.querySelector(".preview-backdrop-control"),
    ).not.toBeNull();
    // Capability is not detection: no hint without sampled pixels.
    expect(container!.querySelector("[data-viewer-mirage-hint]")).toBeNull();
  });

  it("keeps an opaque PNG on the default stage once pixels are readable", async () => {
    sampled = opaqueImageData();
    const image = await renderViewer("serpent://source/opaque.png", true);
    await decode(image);

    expect(
      container!.querySelector(".preview-backdrop-control"),
    ).toBeNull();
    expect(imageClasses()).not.toContain("is-backdrop-");
  });

  it("hides the backdrop controls when the surface opts out", async () => {
    sampled = mirageImageData();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(LocaleProvider, {
          initialPreference: "zh-CN",
          children: createElement(ZoomableImage, {
            src: "serpent://source/mirage.png",
            alt: "asset",
            imageBackdropControls: false,
          }),
        }),
      );
    });
    const image = container.querySelector<HTMLImageElement>("img.preview-image")!;
    await decode(image);

    expect(container.querySelector(".preview-backdrop-control")).toBeNull();
    expect(container.querySelector("[data-viewer-mirage-hint]")).toBeNull();
  });

  it("keeps the matte on both layers of a thumbnail → full-source upgrade", async () => {
    // 0.3.1 viewer: the ready thumbnail paints first, the full source swaps in
    // after decode (viewer-mip-upgrade). The matte must cover whichever layer
    // is visible, and both layers must request CORS mode so the full source
    // can be re-sampled after the upgrade.
    sampled = mirageImageData();
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        createElement(LocaleProvider, {
          initialPreference: "zh-CN",
          children: createElement(ZoomableImage, {
            alt: "asset",
            placeholderSrc: "serpent://preview/mirage-thumbnail",
            src: "serpent://source/mirage.png",
          }),
        }),
      );
    });
    const placeholder = container.querySelector<HTMLImageElement>(
      "img.preview-image-placeholder",
    )!;
    const full = container.querySelector<HTMLImageElement>(
      "img.preview-image-full",
    )!;
    expect(placeholder).not.toBeNull();
    expect(full).not.toBeNull();
    expect(placeholder.getAttribute("crossorigin")).toBe("anonymous");
    expect(full.getAttribute("crossorigin")).toBe("anonymous");

    // The thumbnail alone already looks like a mirage texture.
    await decode(placeholder);
    expect(container.querySelector("[data-viewer-mirage-hint]")).not.toBeNull();

    await act(async () => {
      const select = container!.querySelector<HTMLSelectElement>(
        ".preview-backdrop-control select",
      );
      select!.value = "white";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(placeholder.className).toContain("is-backdrop-white");
    expect(full.className).toContain("is-backdrop-white");

    // Upgrading to the decoded full source must keep the matte and re-sample.
    await decode(full);
    expect(container.querySelector("[data-viewer-mirage-hint]")).not.toBeNull();
    expect(
      container.querySelector("img.preview-image-placeholder")?.className,
    ).toContain("is-backdrop-white");
    expect(
      container.querySelector("img.preview-image-full")?.className,
    ).toContain("is-backdrop-white");
  });
});
