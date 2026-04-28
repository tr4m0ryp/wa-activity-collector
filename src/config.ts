export const CONFIG = {
  PROBE_INTERVAL_MS: 500,
  PROBE_JITTER_MS: 100,
  PROBE_TIMEOUT_MS: 5000,
  OFFLINE_BACKOFF_FACTOR: 5,
  OFFLINE_MISS_THRESHOLD: 5,
  CANARY_WINDOW_MS: 5 * 60 * 1000,
  HEALTH_TICK_MS: 60 * 1000,
  HTTP_PORT: parseInt(process.env.PORT ?? '3000', 10),
  DATA_DIR: process.env.DATA_DIR ?? './data',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
} as const;

export const ACK_RATE_ALERT_THRESHOLD = 0.7;
export const DISCONNECT_ALERT_PER_HOUR = 3;
