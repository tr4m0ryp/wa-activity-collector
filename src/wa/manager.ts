import { EventEmitter } from 'node:events';
import { Account } from './account.js';
import { TargetScheduler } from './scheduler.js';
import * as repos from '../db/repos.js';

interface Runtime {
  account: Account;
  scheduler: TargetScheduler;
}

export class AccountManager extends EventEmitter {
  private runtimes = new Map<number, Runtime>();

  async startAll() {
    const all = repos.accounts.list().filter((a) => a.active === 1);
    for (const a of all) {
      await this.startAccount(a.id);
    }
  }

  async startAccount(id: number) {
    if (this.runtimes.has(id)) return;
    const row = repos.accounts.get(id);
    if (!row) throw new Error(`account ${id} not found`);
    const account = new Account(row);
    const scheduler = new TargetScheduler(account);
    this.runtimes.set(id, { account, scheduler });

    account.on('status', (s) => this.emit('account:status', { accountId: id, status: s }));
    account.on('qr', (qr) => this.emit('account:qr', { accountId: id, qr }));
    scheduler.on('probe', (ack) => this.emit('probe', { accountId: id, ...ack }));
    scheduler.on('presence', (p) => this.emit('presence', { accountId: id, ...p }));

    await account.start();
  }

  async stopAccount(id: number) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.scheduler.shutdown();
    await rt.account.stop();
    this.runtimes.delete(id);
  }

  async logoutAccount(id: number) {
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.scheduler.shutdown();
      await rt.account.logout();
      this.runtimes.delete(id);
    }
  }

  startTarget(accountId: number, target: repos.Target) {
    const rt = this.runtimes.get(accountId);
    if (!rt) return;
    rt.scheduler.startTarget(target);
  }

  stopTarget(accountId: number, targetId: number) {
    const rt = this.runtimes.get(accountId);
    if (!rt) return;
    rt.scheduler.stopTarget(targetId);
  }

  getStatus(accountId: number) {
    const rt = this.runtimes.get(accountId);
    if (!rt) return { status: 'idle', qr: null };
    return { status: rt.account.status, qr: rt.account.lastQr };
  }

  async resolveJid(accountId: number, rawNumber: string) {
    const rt = this.runtimes.get(accountId);
    if (!rt) return null;
    return rt.account.resolveJid(rawNumber);
  }

  async shutdown() {
    for (const rt of this.runtimes.values()) {
      rt.scheduler.shutdown();
      await rt.account.stop();
    }
    this.runtimes.clear();
  }
}
