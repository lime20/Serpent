import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VIEWER_BACKDROP_PREFERENCES,
  loadViewerBackdropPreferences,
  parseViewerBackdropPreferences,
  saveViewerBackdropPreferences,
  setStoredViewerBackdrop,
  VIEWER_BACKDROP_PREFERENCES_KEY,
  VIEWER_BACKDROP_PREFERENCES_VERSION,
} from "../../src/renderer/viewer-backdrop-preferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("viewer backdrop preferences", () => {
  it("defaults to the pre-existing auto behavior", () => {
    expect(DEFAULT_VIEWER_BACKDROP_PREFERENCES).toEqual({
      version: VIEWER_BACKDROP_PREFERENCES_VERSION,
      backdrop: "auto",
    });
    expect(loadViewerBackdropPreferences(memoryStorage())).toEqual(
      DEFAULT_VIEWER_BACKDROP_PREFERENCES,
    );
  });

  it("falls back to auto for malformed or unknown payloads", () => {
    expect(parseViewerBackdropPreferences(null)).toEqual(
      DEFAULT_VIEWER_BACKDROP_PREFERENCES,
    );
    expect(parseViewerBackdropPreferences("{ not json")).toEqual(
      DEFAULT_VIEWER_BACKDROP_PREFERENCES,
    );
    expect(
      parseViewerBackdropPreferences(
        JSON.stringify({ version: 1, backdrop: "purple" }),
      ),
    ).toEqual(DEFAULT_VIEWER_BACKDROP_PREFERENCES);
    expect(
      parseViewerBackdropPreferences(
        JSON.stringify({ version: 99, backdrop: "black" }),
      ),
    ).toEqual(DEFAULT_VIEWER_BACKDROP_PREFERENCES);
    expect(
      parseViewerBackdropPreferences(
        JSON.stringify({ version: 1, backdrop: "black", extra: true }),
      ),
    ).toEqual(DEFAULT_VIEWER_BACKDROP_PREFERENCES);
  });

  it("round-trips a chosen backdrop", () => {
    const storage = memoryStorage();
    expect(
      saveViewerBackdropPreferences(
        { version: VIEWER_BACKDROP_PREFERENCES_VERSION, backdrop: "checkerboard" },
        storage,
      ),
    ).toBe(true);
    expect(loadViewerBackdropPreferences(storage).backdrop).toBe("checkerboard");
    expect(storage.values.get(VIEWER_BACKDROP_PREFERENCES_KEY)).toBe(
      JSON.stringify({ version: 1, backdrop: "checkerboard" }),
    );
  });

  it("stores a backdrop and ignores hostile storage", () => {
    const storage = memoryStorage();
    expect(setStoredViewerBackdrop("white", storage).backdrop).toBe("white");
    expect(loadViewerBackdropPreferences(storage).backdrop).toBe("white");

    const throwing = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    expect(loadViewerBackdropPreferences(throwing)).toEqual(
      DEFAULT_VIEWER_BACKDROP_PREFERENCES,
    );
    expect(
      saveViewerBackdropPreferences(
        { version: VIEWER_BACKDROP_PREFERENCES_VERSION, backdrop: "black" },
        throwing,
      ),
    ).toBe(false);
  });

  it("returns defaults without a storage implementation", () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      expect(loadViewerBackdropPreferences()).toEqual(
        DEFAULT_VIEWER_BACKDROP_PREFERENCES,
      );
      expect(
        saveViewerBackdropPreferences({
          version: VIEWER_BACKDROP_PREFERENCES_VERSION,
          backdrop: "black",
        }),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
