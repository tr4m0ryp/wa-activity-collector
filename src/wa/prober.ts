import { WASocket } from '@whiskeysockets/baileys';
import { CONFIG } from '../config.js';
import * as repos from '../db/repos.js';

const PROBE_PREFIXES = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];

interface PendingProbe {
  probeMsgId: string;
  targetId: number;
  accountId: number;
  sentAt: number;
  timeout: NodeJS.Timeout;
}

export interface AckResult {
  probeMsgId: string;
  targetId: number;
  rttMs: number;
  ackJid: string;
  ackType: string;
  ackAt: number;
  sentAt: number;
}

export class Prober {
  private pending = new Map<string, PendingProbe>();

  constructor(
    private accountId: number,
    private getSock: () => WASocket | null,
  ) {}

  async sendProbe(target: repos.Target): Promise<boolean> {
    const sock = this.getSock();
    if (!sock) return false;
    const probeMsgId = generateProbeId();
    const sentAt = Date.now();
    try {
      const result = await sock.sendMessage(target.jid, {
        delete: { remoteJid: target.jid, fromMe: true, id: probeMsgId },
      });
      const id = result?.key?.id;
      if (!id) return false;
      repos.probes.insertSent(target.id, id, sentAt);
      repos.health.bumpProbeSent(this.accountId);
      const timeout = setTimeout(() => this.handleTimeout(id), CONFIG.PROBE_TIMEOUT_MS);
      this.pending.set(id, {
        probeMsgId: id,
        targetId: target.id,
        accountId: this.accountId,
        sentAt,
        timeout,
      });
      return true;
    } catch {
      return false;
    }
  }

  recordAck(probeMsgId: string, ackJid: string, ackType: string): AckResult | null {
    const pending = this.pending.get(probeMsgId);
    if (!pending) return null;
    clearTimeout(pending.timeout);
    this.pending.delete(probeMsgId);
    const ackAt = Date.now();
    const rttMs = ackAt - pending.sentAt;
    repos.probes.recordAck(probeMsgId, ackAt, rttMs, ackType, ackJid);
    repos.health.bumpAckReceived(pending.accountId);
    return {
      probeMsgId,
      targetId: pending.targetId,
      rttMs,
      ackJid,
      ackType,
      ackAt,
      sentAt: pending.sentAt,
    };
  }

  outstandingForTarget(targetId: number): number {
    let n = 0;
    for (const p of this.pending.values()) {
      if (p.targetId === targetId) n += 1;
    }
    return n;
  }

  private handleTimeout(probeMsgId: string) {
    const pending = this.pending.get(probeMsgId);
    if (!pending) return;
    this.pending.delete(probeMsgId);
    repos.probes.markTimeout(probeMsgId);
    repos.health.bumpTimeout(pending.accountId);
  }

  shutdown() {
    for (const p of this.pending.values()) clearTimeout(p.timeout);
    this.pending.clear();
  }
}

function generateProbeId(): string {
  const prefix = PROBE_PREFIXES[Math.floor(Math.random() * PROBE_PREFIXES.length)];
  const suffix = Math.random().toString(36).substring(2, 10).toUpperCase();
  return prefix + suffix;
}
