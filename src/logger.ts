// F1 Oracle v4.1 — Logger

import pino, { type DestinationStream } from 'pino';

const isDev = process.env.NODE_ENV !== 'production' && process.env.LOG_FORMAT !== 'json';

const transport = isDev
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } })
  : undefined;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { pid: false },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  (transport ?? process.stdout) as DestinationStream,
);
