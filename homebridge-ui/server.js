const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const { OwnToneClient, OwnToneApiError, OwnToneNetworkError, UnsupportedFeatureError } = require('../dist/owntoneClient');
const { DEFAULT_PORT, DEFAULT_TIMEOUT } = require('../dist/settings');

class OwnTonePluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/testConnection', this.testConnection.bind(this));
    this.ready();
  }

  /**
   * Hits `GET /api/config` on the target OwnTone server and reports whether
   * it answered with HTTP 200. Runs server-side (not in the browser) so it
   * can reach LAN hosts regardless of CORS/mixed-content restrictions and
   * reuse the same auth/timeout handling as the platform itself.
   */
  async testConnection(payload = {}) {
    const host = typeof payload.host === 'string' ? payload.host.trim() : '';
    if (!host) {
      return { ok: false, message: 'Host is required.' };
    }

    const client = new OwnToneClient({
      protocol: payload.protocol === 'https' ? 'https' : 'http',
      host,
      port: Number.isInteger(payload.port) ? payload.port : DEFAULT_PORT,
      timeout: Number.isInteger(payload.timeout) ? payload.timeout : DEFAULT_TIMEOUT,
      username: payload.username || undefined,
      password: payload.password || undefined,
      bearerToken: payload.bearerToken || undefined,
      ignoreCertificateErrors: !!payload.ignoreCertificateErrors,
    });

    try {
      const config = await client.getConfig();
      return {
        ok: true,
        message: config?.version ? `Connected — OwnTone ${config.version}` : 'Connected.',
      };
    } catch (error) {
      if (error instanceof OwnToneApiError) {
        return { ok: false, message: `Server responded with HTTP ${error.status}.` };
      }
      if (error instanceof UnsupportedFeatureError) {
        return { ok: false, message: 'Server responded, but /api/config was not found (HTTP 404).' };
      }
      if (error instanceof OwnToneNetworkError) {
        return { ok: false, message: error.message };
      }
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

(() => new OwnTonePluginUiServer())();
