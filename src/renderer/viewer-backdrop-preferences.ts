import { z } from "zod";

import { VIEWER_IMAGE_BACKDROPS, type ViewerImageBackdrop } from "./mirage-texture";

export const VIEWER_BACKDROP_PREFERENCES_KEY =
  "serpent.viewer-backdrop-preferences.v1";
export const VIEWER_BACKDROP_PREFERENCES_VERSION = 1;

export const viewerBackdropPreferencesSchema = z.strictObject({
  version: z.literal(VIEWER_BACKDROP_PREFERENCES_VERSION),
  backdrop: z.enum(VIEWER_IMAGE_BACKDROPS),
});

export type ViewerBackdropPreferences = z.infer<
  typeof viewerBackdropPreferencesSchema
>;
export type ViewerBackdropPreferencesStorage = Pick<
  Storage,
  "getItem" | "setItem"
>;

/**
 * `auto` is the pre-existing behavior: partial-alpha viewer pixels composite
 * over the stage/wallpaper. A non-auto backdrop is a viewer-wide display
 * preference (like volume), not a per-asset edit.
 */
export const DEFAULT_VIEWER_BACKDROP_PREFERENCES: ViewerBackdropPreferences = {
  version: VIEWER_BACKDROP_PREFERENCES_VERSION,
  backdrop: "auto",
};

function storageOrUndefined(
  storage?: ViewerBackdropPreferencesStorage,
): ViewerBackdropPreferencesStorage | undefined {
  if (storage) return storage;
  return (globalThis as { localStorage?: ViewerBackdropPreferencesStorage })
    .localStorage;
}

export function parseViewerBackdropPreferences(
  raw: string | null,
): ViewerBackdropPreferences {
  if (!raw) return DEFAULT_VIEWER_BACKDROP_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = viewerBackdropPreferencesSchema.safeParse(parsed);
    return result.success ? result.data : DEFAULT_VIEWER_BACKDROP_PREFERENCES;
  } catch {
    return DEFAULT_VIEWER_BACKDROP_PREFERENCES;
  }
}

export function loadViewerBackdropPreferences(
  storage?: ViewerBackdropPreferencesStorage,
): ViewerBackdropPreferences {
  const source = storageOrUndefined(storage);
  if (!source) return DEFAULT_VIEWER_BACKDROP_PREFERENCES;
  try {
    return parseViewerBackdropPreferences(
      source.getItem(VIEWER_BACKDROP_PREFERENCES_KEY),
    );
  } catch {
    return DEFAULT_VIEWER_BACKDROP_PREFERENCES;
  }
}

export function saveViewerBackdropPreferences(
  preferences: ViewerBackdropPreferences,
  storage?: ViewerBackdropPreferencesStorage,
): boolean {
  const source = storageOrUndefined(storage);
  if (!source) return false;
  try {
    source.setItem(
      VIEWER_BACKDROP_PREFERENCES_KEY,
      JSON.stringify({
        version: VIEWER_BACKDROP_PREFERENCES_VERSION,
        backdrop: preferences.backdrop,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function setStoredViewerBackdrop(
  backdrop: ViewerImageBackdrop,
  storage?: ViewerBackdropPreferencesStorage,
): ViewerBackdropPreferences {
  const next: ViewerBackdropPreferences = {
    version: VIEWER_BACKDROP_PREFERENCES_VERSION,
    backdrop,
  };
  saveViewerBackdropPreferences(next, storage);
  return next;
}
