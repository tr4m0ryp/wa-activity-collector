import type { Database } from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        phone_number TEXT,
        auth_dir TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE targets (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        jid TEXT NOT NULL,
        display_name TEXT,
        added_at_ms INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(account_id, jid)
      );

      CREATE INDEX ix_targets_account ON targets(account_id, active);

      CREATE TABLE probe_events (
        id INTEGER PRIMARY KEY,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        probe_msg_id TEXT NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        ack_at_ms INTEGER,
        rtt_ms INTEGER,
        ack_type TEXT,
        ack_jid TEXT,
        timed_out INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX ix_probe_target_time ON probe_events(target_id, sent_at_ms);
      CREATE INDEX ix_probe_msg_id ON probe_events(probe_msg_id);

      CREATE TABLE presence_events (
        id INTEGER PRIMARY KEY,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        observed_jid TEXT NOT NULL,
        presence TEXT,
        observed_at_ms INTEGER NOT NULL
      );

      CREATE INDEX ix_presence_target_time ON presence_events(target_id, observed_at_ms);

      CREATE TABLE account_health (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        bucket_ms INTEGER NOT NULL,
        probes_sent INTEGER NOT NULL DEFAULT 0,
        acks_received INTEGER NOT NULL DEFAULT 0,
        timeouts INTEGER NOT NULL DEFAULT 0,
        ws_disconnects INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, bucket_ms)
      );
    `,
  },
];

export function runMigrations(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = row?.v ?? 0;
  for (const m of migrations) {
    if (m.version <= currentVersion) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at_ms) VALUES (?, ?, ?)')
        .run(m.version, m.name, Date.now());
    });
    tx();
  }
}
