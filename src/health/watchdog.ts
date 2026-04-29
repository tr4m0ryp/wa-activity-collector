import { AccountManager } from '../wa/manager.js';
import * as repos from '../db/repos.js';

const TICK_MS = 30_000;
const STALL_THRESHOLD_MS = 60_000;
const RESTART_DEBOUNCE_MS = 90_000;

export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  private lastRestart = new Map<number, number>();

  constructor(private manager: AccountManager) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[watchdog] tick error:', err));
    }, TICK_MS);
    console.log(
      `[watchdog] started (tick=${TICK_MS / 1000}s, stall=${STALL_THRESHOLD_MS / 1000}s, debounce=${RESTART_DEBOUNCE_MS / 1000}s)`,
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    const accounts = repos.accounts.list().filter((a) => a.active === 1);
    for (const account of accounts) {
      const status = this.manager.getStatus(account.id);
      if (status.status !== 'open') continue;

      const targets = repos.targets.listByAccount(account.id);
      if (targets.length === 0) continue;

      const lastSent = repos.probes.lastSentAtForAccount(account.id);
      const stallMs = lastSent == null ? Infinity : Date.now() - lastSent;
      if (stallMs < STALL_THRESHOLD_MS) continue;

      const lastRestart = this.lastRestart.get(account.id) ?? 0;
      if (Date.now() - lastRestart < RESTART_DEBOUNCE_MS) continue;

      console.warn(
        `[watchdog] account ${account.id} (${account.name}) stalled: status=open, ${Math.round(stallMs / 1000)}s since last probe across ${targets.length} target(s). Restarting.`,
      );
      this.lastRestart.set(account.id, Date.now());

      try {
        await this.manager.stopAccount(account.id);
        await this.manager.startAccount(account.id);
        console.warn(`[watchdog] account ${account.id} (${account.name}) restart issued`);
      } catch (err) {
        console.error(`[watchdog] restart failed for account ${account.id}:`, err);
      }
    }
  }
}
