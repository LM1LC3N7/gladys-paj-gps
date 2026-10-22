// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle --------------------------------------------
  gladys.onScanRequest(() => app.publishDiscovery());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // --- Read only: every command is refused with a clear message -------------------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- Configuration screen button --------------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // --- Configuration saved by the user: only a real change restarts -----------------
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // --- Connection lifecycle: the status and Discovery are sent again at every
  // connection; the same configuration resumes as it was (no reading before
  // its time, pauses and refusals kept). A configuration that cannot be read
  // falls back on the last one received.
  gladys.on('connected', async () => {
    try {
      let config;
      try {
        config = await gladys.getConfig();
      } catch (err) {
        logger?.warn(`Configuration not read from Gladys: ${err.message}`);
        const kept = gladys.config;
        // null: resume with the configuration already running (or retry).
        config = kept && typeof kept === 'object' && Object.keys(kept).length > 0 ? kept : null;
      }
      await app.connected(config);
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
  gladys.on('disconnected', () => app.disconnected());
}
