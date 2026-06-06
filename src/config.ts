const num = (v: string | undefined, d: number) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

export const CONFIG = {
  // Probe cadence is env-tunable so the deployed rate can be changed without a
  // code edit (set in the systemd EnvironmentFile). Defaults stay conservative
  // at 2Hz; the scheduler floors any interval at 50ms (the paper's ~20Hz ceiling).
  PROBE_INTERVAL_MS: num(process.env.PROBE_INTERVAL_MS, 500),
  PROBE_JITTER_MS: num(process.env.PROBE_JITTER_MS, 100),
  PROBE_TIMEOUT_MS: num(process.env.PROBE_TIMEOUT_MS, 5000),
  OFFLINE_BACKOFF_FACTOR: num(process.env.OFFLINE_BACKOFF_FACTOR, 5),
  OFFLINE_MISS_THRESHOLD: num(process.env.OFFLINE_MISS_THRESHOLD, 5),
  CANARY_WINDOW_MS: 5 * 60 * 1000,
  HEALTH_TICK_MS: 60 * 1000,
  HTTP_PORT: parseInt(process.env.PORT ?? '3000', 10),
  DATA_DIR: process.env.DATA_DIR ?? './data',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
} as const;

export const ACK_RATE_ALERT_THRESHOLD = 0.7;
export const DISCONNECT_ALERT_PER_HOUR = 3;
