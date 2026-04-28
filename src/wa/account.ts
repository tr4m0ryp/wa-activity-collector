import '@whiskeysockets/baileys';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';
import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import * as repos from '../db/repos.js';

const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

export type AccountStatus = 'idle' | 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out';

export class Account extends EventEmitter {
  public sock: WASocket | null = null;
  public status: AccountStatus = 'idle';
  public lastQr: string | null = null;
  private authDir: string;
  private shouldReconnect = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(public readonly account: repos.Account) {
    super();
    this.authDir = path.resolve(CONFIG.DATA_DIR, 'auth', account.auth_dir);
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  async start() {
    this.shouldReconnect = true;
    await this.connect();
  }

  async stop() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // ignore
      }
      this.sock = null;
    }
    this.setStatus('closed');
  }

  async logout() {
    this.shouldReconnect = false;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // ignore
      }
      this.sock = null;
    }
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.setStatus('logged_out');
  }

  async subscribePresence(jid: string) {
    if (this.sock && this.status === 'open') {
      try {
        await this.sock.presenceSubscribe(jid);
      } catch {
        // ignore
      }
    }
  }

  async resolveJid(rawNumber: string): Promise<string | null> {
    if (!this.sock || this.status !== 'open') return null;
    const cleanNumber = rawNumber.replace(/\D/g, '');
    if (cleanNumber.length < 8) return null;
    const candidateJid = `${cleanNumber}@s.whatsapp.net`;
    try {
      const results = await this.sock.onWhatsApp(candidateJid);
      const result = results?.[0];
      if (result?.exists && result.jid) return result.jid;
    } catch {
      // ignore
    }
    return null;
  }

  private async connect() {
    this.setStatus('connecting');
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    if (process.env.WA_DEBUG) console.log(`[acct ${this.account.name}] using WA version`, version);
    const sock = makeWASocket({
      auth: state,
      version,
      logger: baileysLogger,
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (process.env.WA_DEBUG) {
        console.log(`[acct ${this.account.name}] update:`, {
          connection,
          qr: qr ? '(qr present)' : null,
          err: lastDisconnect?.error?.message,
          statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode,
        });
      }
      if (qr) {
        this.lastQr = qr;
        this.setStatus('qr');
        this.emit('qr', qr);
      }
      if (connection === 'open') {
        this.lastQr = null;
        this.setStatus('open');
      }
      if (connection === 'close') {
        repos.health.bumpDisconnect(this.account.id);
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.setStatus('logged_out');
          return;
        }
        this.setStatus('closed');
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(() => {});
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      this.emit('messages_update', updates);
    });

    sock.ws.on('CB:receipt', (node: any) => {
      this.emit('receipt', node);
    });

    sock.ev.on('presence.update', (update) => {
      this.emit('presence', update);
    });
  }

  private setStatus(s: AccountStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }
}
