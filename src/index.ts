import type { API } from 'homebridge';

import { OwnTonePlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

/** Homebridge entry point. */
export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OwnTonePlatform);
};
