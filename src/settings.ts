/**
 * Platform alias used in the Homebridge `platforms` config array and in
 * `config.schema.json` (`pluginAlias`).
 */
export const PLATFORM_NAME = 'OwnTone';

/**
 * Must match the `name` field of package.json.
 */
export const PLUGIN_NAME = 'homebridge-owntone';

/** Default OwnTone JSON API port. */
export const DEFAULT_PORT = 3689;

/** Default polling interval, in seconds. */
export const DEFAULT_POLLING_INTERVAL = 5;

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT = 5000;

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
