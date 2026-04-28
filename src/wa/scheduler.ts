import { EventEmitter } from 'node:events';
import { Account } from './account.js';
import { Prober, AckResult } from './prober.js';
import { handleRawReceipt, handleMessagesUpdate } from './receipts.js';
import { CONFIG } from '../config.js';
import * as repos from '../db/repos.js';

interface TargetState {
  target: repos.Target;
  timer: NodeJS.Timeout | null;
  consecutiveTimeouts: number;
}

export class TargetScheduler extends EventEmitter {
  private prober: Prober;
  private states = new Map<number, TargetState>();
  private running = false;

  constructor(private accountObj: Account) {
    super();
    this.prober = new Prober(accountObj.account.id, () => accountObj.sock);
    this.wireListeners();
  }

  private wireListeners() {
    this.accountObj.on('receipt', (node: any) => {
      const ack = handleRawReceipt(node, this.prober);
      if (ack) this.handleAck(ack);
    });
    this.accountObj.on('messages_update', (updates: any[]) => {
      const acks = handleMessagesUpdate(updates, this.prober);
      for (const a of acks) this.handleAck(a);
    });
    this.accountObj.on('presence', (update: any) => {
      this.handlePresence(update);
    });
    this.accountObj.on('status', (s: string) => {
      if (s === 'open') this.start();
      else this.pause();
    });
  }

  private handleAck(ack: AckResult) {
    const state = this.states.get(ack.targetId);
    if (state) state.consecutiveTimeouts = 0;
    this.emit('probe', ack);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const targets = repos.targets.listByAccount(this.accountObj.account.id);
    for (const t of targets) this.startTarget(t);
  }

  pause() {
    this.running = false;
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
  }

  startTarget(target: repos.Target) {
    if (this.states.has(target.id)) return;
    const state: TargetState = { target, timer: null, consecutiveTimeouts: 0 };
    this.states.set(target.id, state);
    void this.accountObj.subscribePresence(target.jid);
    if (this.accountObj.status === 'open') {
      this.scheduleNext(state);
    }
  }

  stopTarget(targetId: number) {
    const state = this.states.get(targetId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.states.delete(targetId);
  }

  private scheduleNext(state: TargetState) {
    if (!this.running) return;
    let interval = CONFIG.PROBE_INTERVAL_MS;
    if (state.consecutiveTimeouts >= CONFIG.OFFLINE_MISS_THRESHOLD) {
      interval *= CONFIG.OFFLINE_BACKOFF_FACTOR;
    }
    const jitter = (Math.random() * 2 - 1) * CONFIG.PROBE_JITTER_MS;
    const delay = Math.max(50, Math.round(interval + jitter));

    state.timer = setTimeout(async () => {
      if (this.accountObj.status === 'open') {
        const ok = await this.prober.sendProbe(state.target);
        if (!ok) {
          state.consecutiveTimeouts += 1;
        }
      }
      // detect timeouts via prober's outstanding count + age
      const outstanding = this.prober.outstandingForTarget(state.target.id);
      if (outstanding > 3) {
        state.consecutiveTimeouts += 1;
      }
      this.scheduleNext(state);
    }, delay);
  }

  private handlePresence(update: any) {
    if (!update?.presences) return;
    const accountTargets = repos.targets.listByAccount(this.accountObj.account.id);
    const byBaseNum = new Map<string, repos.Target>();
    for (const t of accountTargets) {
      byBaseNum.set(baseNumber(t.jid), t);
    }
    for (const [jid, presenceData] of Object.entries(update.presences)) {
      if (!presenceData) continue;
      const target = byBaseNum.get(baseNumber(jid));
      if (!target) continue;
      const presence = (presenceData as any).lastKnownPresence ?? null;
      repos.presence.insert(target.id, jid, presence, Date.now());
      this.emit('presence', { targetId: target.id, jid, presence, observedAt: Date.now() });
    }
  }

  shutdown() {
    this.pause();
    this.states.clear();
    this.prober.shutdown();
  }
}

function baseNumber(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}
