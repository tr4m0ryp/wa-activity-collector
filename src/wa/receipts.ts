import { Prober, AckResult } from './prober.js';

export function handleRawReceipt(node: any, prober: Prober): AckResult | null {
  const attrs = node?.attrs;
  if (!attrs) return null;
  const probeMsgId: string | undefined = attrs.id;
  const fromJid: string | undefined = attrs.from;
  const type: string = attrs.type ?? 'delivery';
  if (!probeMsgId || !fromJid) return null;
  return prober.recordAck(probeMsgId, fromJid, type);
}

export function handleMessagesUpdate(updates: any[], prober: Prober): AckResult[] {
  const out: AckResult[] = [];
  for (const u of updates) {
    if (!u?.update) continue;
    if (u.update.status !== 3) continue; // CLIENT_ACK
    const probeMsgId: string | undefined = u.key?.id;
    const fromJid: string | undefined = u.key?.remoteJid;
    if (!probeMsgId || !fromJid) continue;
    const ack = prober.recordAck(probeMsgId, fromJid, 'client_ack');
    if (ack) out.push(ack);
  }
  return out;
}
