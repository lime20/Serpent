/**
 * AI connection heartbeat (Serpent-rsbt).
 *
 * Reuses the existing `testAiConnection` / probe path on a ~60s cadence and
 * keeps one global connection state for the config title indicator and the
 * asset context-menu disconnect glyph.
 *
 * Both predicates take "credentials ready" rather than "a key is stored":
 * a keyless local runtime is configured with no key at all.
 */

export const AI_CONNECTION_HEARTBEAT_MS = 60_000;

export type AiHeartbeatConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/** Whether the context-menu AI analyze affordance should show link-off. */
export function aiAnalyzeShowsDisconnectGlyph(
  hasCredentials: boolean,
  connectionState: AiHeartbeatConnectionState,
): boolean {
  if (!hasCredentials) return true;
  return (
    connectionState === "disconnected" ||
    connectionState === "error" ||
    connectionState === "idle"
  );
}

/** Analyze is runnable only when credentials exist and the last probe succeeded. */
export function aiAnalyzeConnectionReady(
  hasCredentials: boolean,
  connectionState: AiHeartbeatConnectionState,
): boolean {
  return hasCredentials && connectionState === "connected";
}

/**
 * Heartbeat should run whenever the stored profile has usable credentials.
 * Dialog draft edits do not stop the stored-config probe; manual dialog tests
 * still write the same state.
 */
export function shouldRunAiConnectionHeartbeat(
  hasCredentials: boolean,
): boolean {
  return hasCredentials;
}
