/**
 * SDIGF Phase 06 — device authentication for the vision node.
 *
 * DELIBERATELY SEPARATE FROM auth.js. That module gates human users through
 * sessions and the role matrix (ADMIN / ENGINEER / FARMER). The camera is not
 * a user, has no role, and must never be able to reach anything auth.js gates —
 * it proves "which camera", nothing more. Folding this into auth.js would
 * blur a distinction the thesis needs to keep sharp: the CAM sits outside the
 * control and authorisation path by design (see ActivityPage.jsx's
 * CameraPage), and its credential should live somewhere that can't quietly
 * grow user-shaped capabilities over time.
 *
 * MECHANISM: a single static bearer token, set once in Dokploy's environment
 * tab (CAMERA_DEVICE_TOKEN), baked into the device's secrets.h the same way
 * WIFI_PASS is. One camera, one token — this is not a fleet-management system
 * and does not pretend to be one. If a second camera is ever added, this
 * becomes a per-device table; premature to build that now.
 *
 * WHAT THIS TOKEN CANNOT DO: it is checked ONLY on the two device-facing
 * routes (upload, pending). It grants no access to any /api/config, /api/
 * commands, or /api/estop route — those remain gated by auth.js's session and
 * role matrix, and this module imports nothing from there and exports nothing
 * to there.
 */

import { config } from './config.js';

export class DeviceAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

/**
 * Fastify preHandler. Requires header `x-device-token` to match the
 * configured value exactly.
 *
 * Constant-time comparison is not implemented here deliberately: this token
 * is not a password protecting a human account with reuse risk, it is a
 * single device secret with nothing behind it but image uploads. Timing
 * side-channels against a bearer token guarding a JPEG-upload endpoint are
 * not a threat this system is designed to resist; noting that explicitly
 * rather than adding complexity that implies a guarantee this doesn't make.
 */
export function requireDeviceToken(request, reply, done) {
  const token = request.headers['x-device-token'];
  if (!token || token !== config.camera.deviceToken) {
    reply.code(401).send({ error: 'device_unauthorized', message: 'Missing or invalid device token.' });
    return;
  }
  done();
}
