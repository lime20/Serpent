import { Icon } from "./Icons";
import { useT } from "./i18n";
import {
  VIEWER_IMAGE_BACKDROPS,
  isViewerImageBackdrop,
  mirageRevealBackdrop,
  type ViewerImageBackdrop,
} from "./mirage-texture";
import { VIEWER_CHROME_TAB_INDEX } from "./viewer-focus-policy";

/** Catalog keys for the matte options; exported so copy tests can pin them. */
export const BACKDROP_LABEL_KEYS: Readonly<
  Record<ViewerImageBackdrop, string>
> = {
  auto: "preview.backdropAuto",
  black: "preview.backdropBlack",
  white: "preview.backdropWhite",
  gray: "preview.backdropGray",
  checkerboard: "preview.backdropCheckerboard",
};

/**
 * Image-backdrop controls for the viewer zoom bar.
 *
 * `select` always picks the matte painted behind the bitmap; the hint above it
 * only appears when the decoded frame looks like a mirage-tank encoding and
 * offers the one action that matters there — swap the backdrop so the second
 * picture becomes visible.
 */
export function MirageBackdropControl({
  backdrop,
  onChange,
  suggestMirage,
}: {
  readonly backdrop: ViewerImageBackdrop;
  readonly onChange: (backdrop: ViewerImageBackdrop) => void;
  readonly suggestMirage: boolean;
}) {
  const t = useT();
  return (
    <>
      {suggestMirage ? (
        <div className="preview-mirage-hint" data-viewer-mirage-hint="true">
          <Icon name="contrast" size={14} />
          <span className="preview-mirage-hint-text" role="status">
            {t("preview.mirageDetected")}
          </span>
          <button
            onClick={() => onChange(mirageRevealBackdrop(backdrop))}
            tabIndex={VIEWER_CHROME_TAB_INDEX}
            type="button"
          >
            {t("preview.mirageReveal")}
          </button>
        </div>
      ) : null}
      <label className="preview-backdrop-control">
        <span>{t("preview.imageBackdrop")}</span>
        <select
          aria-label={t("preview.imageBackdrop")}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (isViewerImageBackdrop(next)) onChange(next);
          }}
          tabIndex={VIEWER_CHROME_TAB_INDEX}
          value={backdrop}
        >
          {VIEWER_IMAGE_BACKDROPS.map((option) => (
            <option key={option} value={option}>
              {t(BACKDROP_LABEL_KEYS[option])}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
