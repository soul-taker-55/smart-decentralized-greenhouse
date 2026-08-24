// Minimal levelled logger. No dependency, no transport, no rotation — the
// container runtime captures stdout and Dokploy surfaces it. Anything more
// would be infrastructure this phase does not need.

import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const emit = (level, scope, message, extra) => {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString();
  const tail = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  const line = `${stamp} [${level}] [${scope}] ${message}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const log = {
  error: (scope, message, extra) => emit('error', scope, message, extra),
  warn: (scope, message, extra) => emit('warn', scope, message, extra),
  info: (scope, message, extra) => emit('info', scope, message, extra),
  debug: (scope, message, extra) => emit('debug', scope, message, extra),
};
