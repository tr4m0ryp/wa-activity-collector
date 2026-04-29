import { getDb } from './db.js';

export interface Account {
  id: number;
  name: string;
  phone_number: string | null;
  auth_dir: string;
  active: number;
  created_at_ms: number;
}

export interface Target {
  id: number;
  account_id: number;
  jid: string;
  display_name: string | null;
  added_at_ms: number;
  active: number;
}

export interface ProbeEvent {
  id: number;
  target_id: number;
  probe_msg_id: string;
  sent_at_ms: number;
  ack_at_ms: number | null;
  rtt_ms: number | null;
  ack_type: string | null;
  ack_jid: string | null;
  timed_out: number;
}

export interface AccountHealth {
  account_id: number;
  bucket_ms: number;
  probes_sent: number;
  acks_received: number;
  timeouts: number;
  ws_disconnects: number;
}

export const accounts = {
  list(): Account[] {
    return getDb().prepare('SELECT * FROM accounts ORDER BY id').all() as Account[];
  },
  get(id: number): Account | undefined {
    return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
  },
  getByName(name: string): Account | undefined {
    return getDb().prepare('SELECT * FROM accounts WHERE name = ?').get(name) as Account | undefined;
  },
  insert(name: string, phone_number: string | null, auth_dir: string): Account {
    return getDb()
      .prepare(
        'INSERT INTO accounts (name, phone_number, auth_dir, active, created_at_ms) VALUES (?, ?, ?, 1, ?) RETURNING *',
      )
      .get(name, phone_number, auth_dir, Date.now()) as Account;
  },
  setActive(id: number, active: boolean) {
    getDb().prepare('UPDATE accounts SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },
  delete(id: number) {
    getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
};

export const targets = {
  list(): Target[] {
    return getDb().prepare('SELECT * FROM targets ORDER BY id').all() as Target[];
  },
  listByAccount(account_id: number): Target[] {
    return getDb()
      .prepare('SELECT * FROM targets WHERE account_id = ? AND active = 1 ORDER BY id')
      .all(account_id) as Target[];
  },
  listActive(): Target[] {
    return getDb().prepare('SELECT * FROM targets WHERE active = 1 ORDER BY id').all() as Target[];
  },
  get(id: number): Target | undefined {
    return getDb().prepare('SELECT * FROM targets WHERE id = ?').get(id) as Target | undefined;
  },
  insert(account_id: number, jid: string, display_name: string | null): Target {
    return getDb()
      .prepare(
        'INSERT INTO targets (account_id, jid, display_name, added_at_ms, active) VALUES (?, ?, ?, ?, 1) RETURNING *',
      )
      .get(account_id, jid, display_name, Date.now()) as Target;
  },
  setActive(id: number, active: boolean) {
    getDb().prepare('UPDATE targets SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },
  delete(id: number) {
    getDb().prepare('DELETE FROM targets WHERE id = ?').run(id);
  },
};

export const probes = {
  insertSent(target_id: number, probe_msg_id: string, sent_at_ms: number) {
    getDb()
      .prepare('INSERT INTO probe_events (target_id, probe_msg_id, sent_at_ms) VALUES (?, ?, ?)')
      .run(target_id, probe_msg_id, sent_at_ms);
  },
  recordAck(probe_msg_id: string, ack_at_ms: number, rtt_ms: number, ack_type: string, ack_jid: string) {
    return getDb()
      .prepare(
        'UPDATE probe_events SET ack_at_ms = ?, rtt_ms = ?, ack_type = ?, ack_jid = ? WHERE probe_msg_id = ? AND ack_at_ms IS NULL',
      )
      .run(ack_at_ms, rtt_ms, ack_type, ack_jid, probe_msg_id);
  },
  markTimeout(probe_msg_id: string) {
    getDb()
      .prepare('UPDATE probe_events SET timed_out = 1 WHERE probe_msg_id = ? AND ack_at_ms IS NULL')
      .run(probe_msg_id);
  },
  recent(target_id: number, since_ms: number, limit = 1000): ProbeEvent[] {
    return getDb()
      .prepare(
        'SELECT * FROM probe_events WHERE target_id = ? AND sent_at_ms >= ? ORDER BY sent_at_ms DESC LIMIT ?',
      )
      .all(target_id, since_ms, limit) as ProbeEvent[];
  },
  accountWindowStats(account_id: number, since_ms: number) {
    return getDb()
      .prepare(
        `SELECT
          COUNT(*) as sent,
          SUM(CASE WHEN ack_at_ms IS NOT NULL THEN 1 ELSE 0 END) as acked,
          SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END) as timed_out,
          AVG(rtt_ms) as avg_rtt
         FROM probe_events p
         JOIN targets t ON p.target_id = t.id
         WHERE t.account_id = ? AND p.sent_at_ms >= ?`,
      )
      .get(account_id, since_ms) as { sent: number; acked: number; timed_out: number; avg_rtt: number | null };
  },
  targetWindowStats(target_id: number, since_ms: number) {
    return getDb()
      .prepare(
        `SELECT
          COUNT(*) as sent,
          SUM(CASE WHEN ack_at_ms IS NOT NULL THEN 1 ELSE 0 END) as acked,
          AVG(rtt_ms) as avg_rtt,
          MIN(rtt_ms) as min_rtt,
          MAX(rtt_ms) as max_rtt
         FROM probe_events
         WHERE target_id = ? AND sent_at_ms >= ?`,
      )
      .get(target_id, since_ms) as { sent: number; acked: number; avg_rtt: number | null; min_rtt: number | null; max_rtt: number | null };
  },
  lastSentAtForAccount(account_id: number): number | null {
    const row = getDb()
      .prepare(
        'SELECT MAX(p.sent_at_ms) as last_at FROM probe_events p JOIN targets t ON p.target_id = t.id WHERE t.account_id = ?',
      )
      .get(account_id) as { last_at: number | null } | undefined;
    return row?.last_at ?? null;
  },
};

export const presence = {
  insert(target_id: number, observed_jid: string, presence: string | null, observed_at_ms: number) {
    getDb()
      .prepare(
        'INSERT INTO presence_events (target_id, observed_jid, presence, observed_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run(target_id, observed_jid, presence, observed_at_ms);
  },
};

type HealthCol = 'probes_sent' | 'acks_received' | 'timeouts' | 'ws_disconnects';

function bumpHealth(account_id: number, column: HealthCol) {
  const bucket = Math.floor(Date.now() / 60000) * 60000;
  getDb()
    .prepare(
      `INSERT INTO account_health (account_id, bucket_ms, ${column}) VALUES (?, ?, 1)
       ON CONFLICT(account_id, bucket_ms) DO UPDATE SET ${column} = ${column} + 1`,
    )
    .run(account_id, bucket);
}

export const health = {
  bumpProbeSent: (id: number) => bumpHealth(id, 'probes_sent'),
  bumpAckReceived: (id: number) => bumpHealth(id, 'acks_received'),
  bumpTimeout: (id: number) => bumpHealth(id, 'timeouts'),
  bumpDisconnect: (id: number) => bumpHealth(id, 'ws_disconnects'),
  recent(account_id: number, since_ms: number): AccountHealth[] {
    return getDb()
      .prepare(
        'SELECT * FROM account_health WHERE account_id = ? AND bucket_ms >= ? ORDER BY bucket_ms',
      )
      .all(account_id, since_ms) as AccountHealth[];
  },
};
