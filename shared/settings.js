// Plain CommonJS, deliberately outside `src/`/`dist/`: this is the single
// source of truth for constants needed by both the TypeScript plugin
// (`src/settings.ts`) and `homebridge-ui/server.js`, which — being spawned
// independently of how (or whether) the main plugin's `dist/` was built at
// a given install path — must not require anything from `../dist`.

/** Default OwnTone JSON API port. */
const DEFAULT_PORT = 3689;

/** Default per-request timeout, in milliseconds. */
const DEFAULT_TIMEOUT = 5000;

module.exports = { DEFAULT_PORT, DEFAULT_TIMEOUT };
