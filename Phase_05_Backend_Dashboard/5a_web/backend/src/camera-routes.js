/**
 * SDIGF Phase 06 — camera routes.
 *
 * SEPARATE FILE FROM routes.js, deliberately, mirroring db.js's two-pool split
 * for the same reason: this surface has a different trust boundary. Two of
 * these five routes are called by a DEVICE with a static bearer token
 * (device-auth.js), never a logged-in human; the other three are called by the
 * dashboard under the normal session and role matrix (auth.js). Keeping them
 * in one file risks the device-token routes drifting to reuse a
 * requireCap(...) check by copy-paste, which would be wrong — a camera has no
 * role.
 *
 * ROUTES:
 *   POST /api/camera/upload            device token  — receive a JPEG frame
 *   GET  /api/camera/pending           device token  — "is a snapshot wanted?"
 *   GET  /api/camera/latest            session, VIEW — metadata for the newest image
 *   GET  /api/camera/pending-status    session, VIEW — is a snapshot outstanding?
 *   GET  /api/camera/days              session, VIEW — full history grouped by day
 *   GET  /api/camera/image/:id         session, VIEW — stream the JPEG bytes
 *   POST /api/camera/request-snapshot  session, VIEW — set the pending flag
 *
 * request-snapshot and latest/image sit behind CAP.VIEW, the same capability
 * that gates readings and history — this is observation, available to every
 * role including FARMER, not a command.
 */

import { createReadStream } from 'node:fs';
import * as camera from './services/camera-service.js';
import { requireDeviceToken } from './device-auth.js';
import { CAP, requireCap, getActor } from './auth.js';
import { errorResponse } from './routes.js';
import { config } from './config.js';

/** Upper bound on an uploaded frame. Current SW-JPEG frames run ~7-30KB;
 *  this leaves headroom for a larger sensor or resolution change later
 *  without silently truncating an upload. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

export function registerCameraRoutes(app) {
  // Fastify has no built-in parser for image/jpeg — without this, the raw
  // bytes never reach request.body and every upload 415s.
  app.addContentTypeParser(
    'image/jpeg',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body)
  );

  app.post(
    '/api/camera/upload',
    { preHandler: requireDeviceToken, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      try {
        const capturedAt = request.headers['x-captured-at'] || undefined;
        const trigger = request.headers['x-trigger'] || 'schedule';
        const saved = await camera.saveImage({
          ghId: config.ghId,
          buffer: request.body,
          capturedAt,
          trigger,
        });
        return reply.code(201).send({ saved: true, image: saved });
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );

  app.get(
    '/api/camera/pending',
    { preHandler: requireDeviceToken },
    async (_request, reply) => {
      try {
        const pending = await camera.getPending(config.ghId);
        return pending;
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );

  app.get(
    '/api/camera/latest',
    { preHandler: requireCap(CAP.VIEW) },
    async (_request, reply) => {
      try {
        const latest = await camera.getLatest(config.ghId);
        return { image: latest };
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );

  // Full history grouped by day. Separate from /latest because the two answer
  // different questions: /latest is "what does the enclosure look like now",
  // this is "what has it looked like over time". The panel uses both.
  app.get(
    '/api/camera/days',
    { preHandler: requireCap(CAP.VIEW) },
    async (_request, reply) => {
      try {
        return { days: await camera.listByDay(config.ghId) };
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );

  app.get(
    '/api/camera/image/:id',
    { preHandler: requireCap(CAP.VIEW) },
    async (request, reply) => {
      try {
        const absPath = await camera.getImagePath(request.params.id, config.ghId);
        reply.header('Content-Type', 'image/jpeg');
        return reply.send(createReadStream(absPath));
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );

  // Session-gated read of the same flag the device polls. SEPARATE ROUTE from
  // GET /api/camera/pending on purpose: that one authenticates a device by
  // static token and this one authenticates a human by session. Same data,
  // two different callers, two different trust boundaries — sharing one route
  // would mean either handing the dashboard a device token or letting a device
  // token satisfy a user-facing route. Neither is acceptable.
  //
  // The dashboard needs this so the snapshot button can show "requested,
  // waiting for the camera" rather than pretending the image is on its way.
  app.get(
    '/api/camera/pending-status',
    { preHandler: requireCap(CAP.VIEW) },
    async (_request, reply) => {
      try {
        return await camera.getPending(config.ghId);
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );

  app.post(
    '/api/camera/request-snapshot',
    { preHandler: requireCap(CAP.VIEW) },
    async (request, reply) => {
      try {
        const actor = getActor(request);
        const result = await camera.requestSnapshot(config.ghId, actor?.id ?? null);
        return result;
      } catch (err) {
        return errorResponse(reply, err);
      }
    }
  );
}
