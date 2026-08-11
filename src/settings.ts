// Sourced from `../shared/settings` (plain CommonJS, not part of `src/`)
// rather than declared here directly, since `homebridge-ui/server.js` needs
// these same two values and must not depend on `dist/` — see that file's
// header comment. Re-exported so every other `import { DEFAULT_PORT } from
// './settings'` in this codebase stays unchanged.
import { DEFAULT_PORT, DEFAULT_TIMEOUT } from '../shared/settings';

export { DEFAULT_PORT, DEFAULT_TIMEOUT };

/**
 * Platform alias used in the Homebridge `platforms` config array and in
 * `config.schema.json` (`pluginAlias`).
 */
export const PLATFORM_NAME = 'OwnTone';

/**
 * Must match the `name` field of package.json.
 */
export const PLUGIN_NAME = 'homebridge-owntone';

/** Default polling interval, in seconds. */
export const DEFAULT_POLLING_INTERVAL = 5;

/** Volume step (percent) applied for relative volume changes. */
export const DEFAULT_VOLUME_STEP = 5;

/** Relative seek applied for the fast-forward / rewind remote keys, in ms. */
export const SEEK_STEP_MS = 10_000;

/** Consecutive poll failures tolerated before the accessory is marked unavailable. */
export const FAILURE_THRESHOLD = 3;

/** Minimum time between two identical throttled log messages, in milliseconds. */
export const LOG_THROTTLE_WINDOW = 60_000;

/** How long an optional track switch stays "on" before resetting itself, in ms. */
export const SWITCH_RESET_DELAY = 500;

/** Push-notification message previews longer than this are truncated with an ellipsis before being debug-logged. */
export const PUSH_MESSAGE_PREVIEW_MAX_LENGTH = 200;

/**
 * How often to poll as a reconciliation safety net while the push
 * notification WebSocket is connected and healthy, in ms. A WebSocket can
 * stay "open" while actually dead (a NAT/firewall dropping a long-idle
 * connection without a close frame, for example), so this bounds how stale
 * HomeKit state can ever get even if that happens.
 */
export const WEBSOCKET_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** Initial delay before retrying a dropped push-notification connection, in ms. */
export const WEBSOCKET_RECONNECT_MIN_DELAY_MS = 2000;

/** Cap on the reconnect backoff delay for the push-notification connection, in ms. */
export const WEBSOCKET_RECONNECT_MAX_DELAY_MS = 60_000;

/**
 * Default for the user-configurable `pushReconnectInterval` (minutes): how
 * often to force-cycle an apparently-healthy push-notification connection.
 * The reconciliation poll above bounds how stale *data* can get, but a
 * WebSocket stuck "open" while actually dead never fires close/error, so it
 * would otherwise sit there for the lifetime of the Homebridge process —
 * potentially months or years — silently losing the near-instant push
 * updates it exists for. Periodically forcing a fresh connection bounds
 * that too, at the cost of a brief, harmless reconnect.
 */
export const DEFAULT_PUSH_RECONNECT_INTERVAL_MINUTES = 15;

/** Bounds on the user-configurable `pushReconnectInterval`, in minutes. */
export const MIN_PUSH_RECONNECT_INTERVAL_MINUTES = 1;
export const MAX_PUSH_RECONNECT_INTERVAL_MINUTES = 1440;
