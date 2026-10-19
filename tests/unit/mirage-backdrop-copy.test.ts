import { describe, expect, it } from "vitest";

import { catalogs, lookupMessage, type AppLocale } from "../../src/renderer/i18n";
import { BACKDROP_LABEL_KEYS } from "../../src/renderer/MirageBackdropControl";

const LOCALES: readonly AppLocale[] = ["zh-CN", "en"];

const KEYS = [
  "preview.imageBackdrop",
  "preview.mirageDetected",
  "preview.mirageReveal",
  ...Object.values(BACKDROP_LABEL_KEYS),
];

describe("mirage backdrop copy", () => {
  it.each(LOCALES)("%s resolves every backdrop control string", (locale) => {
    for (const key of KEYS) {
      const message = lookupMessage(catalogs[locale], key);
      expect(message, `missing ${key}`).toBeTruthy();
      expect(message, `untranslated ${key}`).not.toBe(key);
    }
  });

  it("keeps the matte option labels distinct", () => {
    const labels = Object.values(BACKDROP_LABEL_KEYS).map((key) => {
      const message = lookupMessage(catalogs["zh-CN"], key);
      if (!message) throw new Error(`missing ${key}`);
      return message;
    });
    expect(new Set(labels).size).toBe(labels.length);
  });
});
