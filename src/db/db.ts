import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { CONFIG } from '../config.js';
import { runMigrations } from './migrations.js';

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  const dbPath = path.join(CONFIG.DATA_DIR, 'activity.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
