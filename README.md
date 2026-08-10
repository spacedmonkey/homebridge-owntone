<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# homebridge-owntone

[Homebridge](https://homebridge.io) dynamic platform plugin for [OwnTone](https://owntone.github.io/owntone-server/) (formerly forked-daapd / DAAPD).

This plugin exposes each configured OwnTone server as a HomeKit Television-style accessory where supported by Homebridge and Apple Home. Apple Home does not expose every media-player feature, so some OwnTone features may be mapped approximately or exposed through optional switch controls.

- Written in TypeScript, tested with Jest, linted with ESLint.
- Supports Homebridge **1.x** and **2.x**.
- Talks to the documented [OwnTone JSON API](https://owntone.github.io/owntone-server/json-api/) — no undocumented or invented endpoints.
- Configure any number of servers entirely from the Homebridge UI.

---

## What it does

For every OwnTone server you configure, the plugin creates one HomeKit accessory with:

| Service | Purpose |
| --- | --- |
| `AccessoryInformation` | Manufacturer, model, stable serial number, OwnTone version as firmware revision |
| `Television` | Power (play/pause), Apple Remote keys, input selection |
| `TelevisionSpeaker` | Volume up/down, absolute volume, mute |
| `InputSource` | One per OwnTone output (speaker), plus a generic "OwnTone" source |
| `Switch` *(optional)* | Next Track / Previous Track / Play-Pause / Mute, when `exposeTrackSwitches` is enabled |

If `enableMatter` is also on and Homebridge exposes its native Matter Plugin API (Homebridge 2.x+), the plugin additionally publishes those same four switches as separate Matter accessories, alongside the HomeKit ones above. Matter (as currently supported by Homebridge) has no device type for a TV/media-player, absolute volume or output selection, so the main Television/Speaker/InputSource accessory has no Matter counterpart and stays HomeKit-only. See [Matter support](#matter-support) below.

It polls each server every 5 seconds by default for playback state, now-playing metadata and the list of outputs — except while playback is stopped, when the extra now-playing/outputs requests are skipped since there's nothing new to report. If the server was built with [WebSocket push notification support](https://owntone.github.io/owntone-server/json-api/#push-notifications), the plugin also subscribes to it and reacts to changes immediately instead of waiting for the next poll; the polling interval then backs off to an infrequent safety-net check (every 5 minutes) rather than stopping outright, since a WebSocket can stay open while actually dead. Servers without WebSocket support are unaffected — they just keep polling at the configured interval as before.

If the push connection drops (server restart, network blip), it reconnects automatically with backoff (2s up to 60s between attempts); every connect, disconnect and retry is logged at `info` level with the reason, so this is visible without enabling debug mode. Since Homebridge can run for months, a connection that goes silently dead without ever firing a close/error — which the retry logic above can't detect on its own — is also guarded against: a healthy-looking connection is proactively cycled on a schedule (`pushReconnectInterval`, default 15 minutes) as a safety net, independent of the poll-based one. This only has an effect when push notifications are enabled and the server supports them.

---

## Installation

Install through the Homebridge UI by searching for **homebridge-owntone**, or from the command line:

```bash
npm install -g homebridge-owntone
```

Requirements:

- Node.js 20.18.1 or newer
- Homebridge 1.6.0 or newer (Homebridge 2.x is supported)
- An OwnTone server reachable over HTTP or HTTPS

### Installing a local build (not published to npm)

The Homebridge UI's **Install** button and `hb-service add` only accept the name of a package that exists on the npm registry. They reject a filesystem path with `✖ Invalid plugin name.` — so you cannot install an unpublished checkout that way.

To install a local build, build a tarball and install it into Homebridge's storage path (the **Storage Path** shown on the Homebridge UI status page — commonly `/var/lib/homebridge`, `~/.homebridge`, or `/homebridge` in Docker):

```bash
cd homebridge-owntone
npm install
npm run build
npm pack                       # → homebridge-owntone-1.0.0.tgz

npm --prefix /var/lib/homebridge install --legacy-peer-deps \
  "$PWD/homebridge-owntone-1.0.0.tgz"
```

Then restart Homebridge. `--legacy-peer-deps` stops npm from installing a second copy of Homebridge itself next to the plugin.

For iterative development, `npm link` the package and run Homebridge with `homebridge -D` instead.

---

## Pairing: each server is a separate accessory

**This is the most important thing to know before you start.**

HomeKit does not allow a bridge to expose `Television` services, so this plugin publishes each OwnTone accessory as an *external* (standalone) accessory. That means:

- The accessories will **not** appear automatically alongside your other bridged Homebridge accessories.
- Each one must be added to the Home app separately, using the setup code shown in the Homebridge log and in the Homebridge UI (**Accessories → the accessory's ⓘ / "Bridge" QR codes** section).
- Use the same PIN as your Homebridge bridge unless you have changed it.

Once paired, the accessory behaves like any other HomeKit TV: it appears in the Home app and in Control Center's Apple TV Remote.

---

## Configuration

### Homebridge UI

Open the plugin's settings and use **Add OwnTone Server** to add one entry per server. Only **Accessory Name** and **Host** are required.

Above the form, each server gets a **Test Connection** button once its host is filled in. It asks Homebridge (not your browser) to send `GET /api/config` to that server using the protocol, port and credentials currently entered, and reports whether it answered with HTTP 200.

### Manual configuration

```json
{
  "platform": "OwnTone",
  "name": "OwnTone",
  "servers": [
    {
      "name": "Living Room Music",
      "protocol": "http",
      "host": "192.168.1.50",
      "port": 3689,
      "pollingInterval": 5,
      "timeout": 5000
    },
    {
      "name": "Office Music",
      "protocol": "https",
      "host": "owntone-office.local",
      "port": 3689,
      "pollingInterval": 5,
      "timeout": 5000
    }
  ]
}
```

### Server options

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | — | Display name for the HomeKit accessory |
| `protocol` | `http` \| `https` | no | `http` | Transport used for the JSON API |
| `host` | string | yes | — | OwnTone hostname or IP address |
| `port` | number | no | `3689` | OwnTone JSON API port |
| `pollingInterval` | number | no | `5` | Polling interval in seconds (1–3600) |
| `timeout` | number | no | `5000` | Request timeout in milliseconds (500–120000) |
| `enableWebSocket` | boolean | no | `true` | Use push notifications when the server supports them, instead of polling only |
| `pushReconnectInterval` | number | no | `15` | Minutes between proactive reconnects of a healthy push connection (1–1440). Only has an effect when `enableWebSocket` is on and the server supports push notifications |
| `username` | string | no | — | Optional username for reverse-proxy / basic auth |
| `password` | string | no | — | Optional password for reverse-proxy / basic auth |
| `bearerToken` | string | no | — | Optional bearer token; takes precedence over basic auth |
| `ignoreCertificateErrors` | boolean | no | `false` | Accept self-signed certificates (HTTPS only) |
| `exposeTrackSwitches` | boolean | no | `false` | Expose next / previous / play-pause / mute as HomeKit switches |
| `enableMatter` | boolean | no | `false` | Also publish the switches above as native Matter accessories. Only takes effect together with `exposeTrackSwitches`. Requires Homebridge 2.x+; no effect on 1.x |

Authentication is **not** required. OwnTone itself does not authenticate the JSON API on the local network; the username/password and bearer token options exist for setups where OwnTone sits behind a reverse proxy.

Invalid entries (missing `name` or `host`, unknown protocol, out-of-range numbers) are logged and skipped or clamped — one bad entry never prevents the other servers from loading.

---

## Supported OwnTone features

Everything below maps onto a documented OwnTone JSON API endpoint.

| Feature | Endpoint |
| --- | --- |
| Playback state, volume, progress | `GET /api/player` |
| Now-playing metadata | `GET /api/queue?id=now_playing` |
| Server version | `GET /api/config` |
| Outputs (speakers) | `GET /api/outputs` |
| Play / Pause / Stop / Toggle | `PUT /api/player/{play,pause,stop,toggle}` |
| Next / Previous track | `PUT /api/player/{next,previous}` |
| Seek (relative) | `PUT /api/player/seek?seek_ms=…` |
| Absolute volume | `PUT /api/player/volume?volume=…` |
| Relative volume | `PUT /api/player/volume?step=…` |
| Select an output exclusively | `PUT /api/outputs/set` |
| Enable/disable a single output | `PUT /api/outputs/{id}` |
| Artwork | `artwork_url` from the queue item |

### Remote key mapping

| Apple Remote action | OwnTone command |
| --- | --- |
| Play/Pause | Toggle play/pause |
| Select | Toggle play/pause |
| Arrow Right / Next Track | Next track |
| Arrow Left / Previous Track | Previous track |
| Fast Forward | Seek forward 10 s |
| Rewind | Seek backward 10 s |
| Back / Exit / Info / Arrow Up / Arrow Down | No-op (logged at debug level) |

HAP has no separate `PLAY` and `PAUSE` remote keys — only `PLAY_PAUSE`. The plugin registers handlers for `PLAY` and `PAUSE` defensively, so if a future HAP version adds them they are picked up automatically.

### Input sources

Each OwnTone output (AirPlay speaker, Chromecast, ALSA device, …) is exposed as a HomeKit input source. **Selecting an input enables that output exclusively and disables the others** — that is the closest analogue to switching a TV input. Identifier 1 is a generic "OwnTone" source that does nothing when selected; the plugin falls back to it whenever zero or more than one output is enabled, because that state has no single-input equivalent in HomeKit.

If you routinely play to several speakers at once, leave the input alone and control outputs from the OwnTone web interface.

### Mute

**OwnTone's JSON API has no mute endpoint.** Mute is emulated: the plugin remembers the current master volume, sets it to 0, and restores the remembered value on unmute. If Homebridge restarts while muted, unmuting falls back to a low default volume. HomeKit reports the accessory as muted whenever the OwnTone volume is 0, however it got there.

---

## Apple Home / HomeKit limitations

These are limitations of HomeKit and the Home app, not of OwnTone or this plugin:

- **Television accessories cannot be bridged.** Each server must be paired separately (see [Pairing](#pairing-each-server-is-a-separate-accessory)).
- **No track title, artist or album characteristic exists.** HomeKit's TV services have nowhere to put now-playing text. The plugin fetches and logs this metadata at debug level but cannot show it in the Home app.
- **No progress or duration characteristic exists.** Elapsed time and track length are polled and logged only.
- **Absolute volume is not shown in the Home app** for `TelevisionSpeaker` in most iOS versions. The characteristic is exposed (so automations and the hardware volume buttons in the Apple Remote work), but you may not see a slider.
- **Remote key availability varies by iOS version.** The plugin only registers characteristics and enum values that exist in the running HAP version, and ignores keys it cannot map.
- **`PowerModeSelection` (the "Settings" button) is acknowledged and ignored** — OwnTone has no settings screen to open.
- **Shuffle, repeat and consume modes are not exposed.** OwnTone supports them, but HomeKit has no matching characteristic. Nothing is invented to work around this.

If the Apple Remote mapping is not enough for your automations, enable `exposeTrackSwitches` to get plain HomeKit switches for next track, previous track, play/pause and mute. Next track and previous track are momentary — they turn themselves back off after 500 ms, so they behave like buttons. Play/Pause and Mute are stateful instead: they reflect whether OwnTone is actually playing (on) or paused/stopped (off), and whether it's muted, updating on every poll — setting Play/Pause drives playback directly (`play()`/`pause()`) rather than toggling, and setting Mute is equivalent to the Television speaker's `Mute` characteristic (both stay in sync with each other).

## Artwork / thumbnail limitation

OwnTone artwork/thumbnail information is fetched when available, but Apple Home does not currently expose dynamic album artwork for HomeKit Television accessories. This plugin keeps the metadata internally for future compatibility and logging, but the Home app may not display it.

Concretely:

- The artwork URL from `artwork_url` is resolved against the server (with `maxwidth`/`maxheight` hints) and cached in memory.
- Artwork is downloaded at most **once per track**, not on every poll.
- A missing or broken artwork URL is not an error: OwnTone documents that an `artwork_url` "is not guaranteed to exist". Failures are logged at debug level and throttled.
- No non-standard HomeKit characteristic is created to carry the image.

## Matter support

Homebridge 2.x has a native Matter Plugin API (`api.matter`) that lets a plugin publish accessories directly to Matter, separately from the HomeKit ones above — it does not automatically bridge existing HomeKit services. Set `enableMatter` to opt in.

Matter (as currently implemented by Homebridge) has no device type for a TV/media-player, absolute volume, or output selection — so the main Television/Speaker/InputSource accessory can't be represented in Matter at all and stays HomeKit-only, no matter what. What *does* map cleanly is simple on/off state, using Matter's `OnOffSwitch` device type — so `enableMatter` publishes a Matter accessory for each of the same four switches `exposeTrackSwitches` already added to HomeKit. It's additive, not a replacement: **`enableMatter` only takes effect when `exposeTrackSwitches` is also on**, since Matter accessories are only ever published for buttons you've already opted into having in HomeKit, never introduced as Matter-only extras.

| Matter accessory | Behaviour |
| --- | --- |
| `<name> Mute` | Reflects and controls mute, same as the HomeKit Mute switch / Television speaker's `Mute` characteristic |
| `<name> Play/Pause` | Reflects and controls playback, same as the HomeKit Play/Pause switch |
| `<name> Next Track` / `<name> Previous Track` | Momentary — turns itself back off after 500 ms, same as the HomeKit switches |

Requirements and limitations:

- **Requires Homebridge 2.x.** On Homebridge 1.x, `enableMatter` logs a warning at startup and otherwise has no effect — there is nothing to fall back to, since the Matter Plugin API doesn't exist there.
- **Registration happens once, at startup**, before the first poll resolves — so each Matter accessory briefly starts at "off" and is corrected to the real state within one poll cycle (or immediately, if push notifications are connected).
- **No automatic cleanup.** If you later turn `enableMatter` or `exposeTrackSwitches` off, or remove a server from the config, its Matter accessories are not automatically unregistered. Remove them manually via Homebridge's Matter UI if this matters to you.

---

## Error handling

The plugin is built so that no OwnTone problem can take Homebridge down:

- Every request has a configurable timeout and is aborted when it expires.
- Connection refused, DNS failures, timeouts, malformed JSON, missing metadata and unsupported endpoints are all caught and turned into typed errors.
- Repeated identical errors are throttled to one log line per minute, with a count of suppressed messages.
- After 3 consecutive failed polls, the accessory is marked inactive. It recovers automatically — and logs that it did — as soon as the server answers again.
- Polls never overlap: if a poll is still running when the next tick fires, the tick is skipped.
- Each server is independent; one unreachable server does not affect the others.
- Failed HomeKit `set` operations reject with `SERVICE_COMMUNICATION_FAILURE` so the Home app can show the failure, instead of silently pretending to succeed.
- Passwords, bearer tokens and any credentials in URLs are never logged.

### Logging levels

| Level | Used for |
| --- | --- |
| `info` | Accessory published, server reachable/recovered, OwnTone version, poll-complete track summary (every poll), all push notification connect/disconnect/retry events, Matter accessories published |
| `warn` | Server unreachable, command failure, unsupported feature, invalid config, `enableMatter` on with no Matter Plugin API available |
| `error` | Unexpected setup failures (still non-fatal) |
| `debug` | Metadata changes, artwork caching, ignored remote keys, skipped polls, full stack trace alongside a push connection failure, Matter accessory state changes |

Enable debug logging with `homebridge -D` or the **Debug Mode** toggle in the Homebridge UI.

---

## Troubleshooting

**The accessory does not appear in the Home app.**
Television accessories are not bridged. Add it manually: Home app → **+** → **Add Accessory** → **More options…**, then pick the accessory and enter your Homebridge PIN. The setup code is also printed in the Homebridge log when the plugin starts.

**`OwnTone server at … is unreachable`.**
Check the host and port from the Homebridge machine:

```bash
curl http://192.168.1.50:3689/api/config
```

You should get JSON with a `version` field. If `.local` hostnames fail, use the IP address instead — mDNS resolution is often unavailable inside containers.

**`… did not recognise the OwnTone player API`.**
The host answered but returned HTTP 404 for `/api/player`. You are probably pointing at a different service, or at a reverse proxy that does not forward `/api/`.

**HTTPS fails with a certificate error.**
Enable **Ignore HTTPS Certificate Errors** for that server. This only relaxes verification for that one server's requests.

**Volume does not change.**
OwnTone's master volume only affects enabled outputs. Verify at least one output is enabled in the OwnTone web UI, or select one via the accessory's input source.

**Mute behaves oddly after a restart.**
Mute is emulated with volume 0 (OwnTone has no mute endpoint), and the pre-mute volume is only remembered in memory. After a Homebridge restart, unmuting restores a default volume instead.

**No accessories at all, with `No usable OwnTone servers configured`.**
Every entry in `servers` was rejected. The preceding `warn` lines say exactly why — usually a missing `name` or `host`.

---

## Development

```bash
git clone https://github.com/spacedmonkey/homebridge-owntone.git
cd homebridge-owntone
npm install
npm run build
```

| Script | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Recompile on change |
| `npm run lint` | ESLint over `src/` and `test/` |
| `npm run lint:fix` | ESLint with autofix |
| `npm test` | Run the Jest suite |
| `npm run test:coverage` | Run the suite with coverage |
| `npm run check` | Lint, build and test in one go |

To try it against a real Homebridge instance, link the built package:

```bash
npm link
homebridge -D -U ~/.homebridge
```

### Source layout

```
src/
  index.ts             Homebridge entry point — registers the platform
  settings.ts          Plugin/platform names and tuning constants
  platform.ts          DynamicPlatformPlugin: config validation, accessory lifecycle
  platformAccessory.ts HomeKit services, characteristic mapping, polling loop
  owntoneClient.ts     Typed OwnTone JSON API client
  owntonePushClient.ts Optional WebSocket push-notification client (falls back to polling)
  matterTypes.ts       Minimal local types for Homebridge's native Matter Plugin API
  errorThrottle.ts     Log-spam suppression
  types.ts             Config, raw API and normalised internal models
```

The client only ever returns *normalised* models (`PlayerSnapshot`, `TrackSnapshot`, `OutputSnapshot`), so the HomeKit mapping never depends on raw API response shapes.

## Testing

```bash
npm test
```

The suite is fully offline — no OwnTone server is needed. Network calls are injected via a `fetchImpl` option on the client, and the accessory tests run against the real `hap-nodejs` `Service`/`Characteristic` implementations so that characteristic behaviour matches Homebridge.

Covered areas:

- **Client** — base URL construction for HTTP/HTTPS and custom ports, default port, request timeouts, basic auth and bearer headers, JSON bodies, network/HTTP/404/malformed-JSON error mapping, response normalisation, missing metadata, every playback and volume command, mute emulation, artwork URL resolution.
- **Platform** — defaults and validation, invalid entries skipped, multiple servers, stable UUIDs, one accessory per server, duplicate detection, stale accessory removal, shutdown cleanup.
- **Accessory** — service and characteristic setup, state mapping, remote key mapping, volume and mute commands, input/output selection, optional track switches, polling cadence and overlap guard, unavailable-after-3-failures and recovery, warning throttling, artwork caching, push-notification connection and poll-cadence backoff.
- **Push client** — subscribe message, reconnect backoff and reset, idempotent dispose, default transport resolution.
- **Error throttling** — first log, suppression inside the window, re-log with suppressed count afterwards.

---

## Contributing

Issues and pull requests are welcome. Please run `npm run check` before opening a PR.

## License

Apache-2.0
