import { contextBridge } from 'electron';

import { appUpdate } from './bridge/app-update';
import { automation } from './bridge/automation';
import {
  armE2eBrowseSessionDelay,
  library,
  type E2eBrowseSessionDelayTarget,
} from './bridge/library';
import { mcp } from './bridge/mcp';
import { plugins } from './bridge/plugins';
import { shell } from './bridge/shell';
import { shortcuts } from './bridge/shortcuts';
import { startup } from './bridge/startup';
import { getE2eRequestCount } from './transport';
import type { RendererRequest } from '../shared/protocol/requests';

const e2eEnabled = process.env.SERPENT_E2E === '1';

if (e2eEnabled) {
  // Preload globalThis is the isolated world. contextIsolation keeps that
  // assignment invisible to the renderer, so a non-zh-CN host follows the OS
  // language and Chinese E2E selectors time out. Copy the pin into the main
  // world before the page resolves system locale.
  const e2eLocale = process.env.SERPENT_E2E_LOCALE === 'en' ? 'en' : 'zh-CN';
  contextBridge.executeInMainWorld({
    func: (locale: string) => {
      (globalThis as { __SERPENT_E2E_LOCALE__?: string }).__SERPENT_E2E_LOCALE__ =
        locale;
    },
    args: [e2eLocale],
  });
}

const e2eDiagnostics = Object.freeze({
  useNativeAssetDrag: process.env.SERPENT_E2E_NATIVE_ASSET_DRAG === '1',
  getRequestCount(type: RendererRequest['type']): number {
    return getE2eRequestCount(type);
  },
  delayNextBrowseSession(
    target: E2eBrowseSessionDelayTarget,
    delayMs: number,
  ): void {
    if (
      !e2eEnabled ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 5_000 ||
      (target.folderId === undefined) ===
        (target.smartCollectionId === undefined)
    ) {
      throw new Error('Invalid E2E browse-session delay.');
    }
    armE2eBrowseSessionDelay(target, delayMs);
  },
});

contextBridge.exposeInMainWorld(
  'serpent',
  Object.freeze({
    library,
    shell,
    shortcuts,
    startup,
    appUpdate,
    automation,
    mcp,
    plugins,
    ...(e2eEnabled ? { e2e: e2eDiagnostics } : {}),
  }),
);
