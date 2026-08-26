# SDIGF Phase 05a — backend + dashboard, one image.
#
# The dashboard is a static bundle served by the backend on the same origin.
# One container rather than two because there is nothing to gain from a second:
# no CORS surface, no separate TLS certificate, no second thing to keep running.
#
# Build context is 5a_web/ (the parent of frontend/ and backend/), because
# vite.config.js writes its output into ../backend/public and that relative
# path has to resolve inside the image the same way it does on a workstation.

# ---------------------------------------------------------------------------
# Stage 1 — build the dashboard
# ---------------------------------------------------------------------------
FROM node:20-alpine AS dashboard

WORKDIR /build

# Dependencies first so this layer survives source changes.
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci

COPY frontend ./frontend
# backend/ must exist as the build target: vite writes to ../backend/public.
RUN mkdir -p backend
RUN cd frontend && npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

# Production dependencies only. The test suite needs no extra packages —
# everything it uses is a Node built-in — so nothing is lost by omitting dev.
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

COPY backend/src ./src
COPY --from=dashboard /build/backend/public ./public

# Fail the container rather than serve a broken dashboard: if the bundle did
# not make it across, that is a build fault and should surface at image build
# time, not as a blank page in production.
RUN test -f ./public/index.html || (echo "dashboard bundle missing" && exit 1)

USER node

EXPOSE 3000

# The service already verifies its own canonicalizer and both databases at
# startup; this only confirms it is still answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
