import { Router } from 'express';
import QRCode from 'qrcode';
import * as repos from '../db/repos.js';
import { AccountManager } from '../wa/manager.js';
import { CONFIG } from '../config.js';

export function buildApiRouter(manager: AccountManager) {
  const r = Router();

  r.get('/stats', (_req, res) => {
    const since = Date.now() - 60 * 60 * 1000;
    const allAccounts = repos.accounts.list();
    const allTargets = repos.targets.listActive();
    const totals = allAccounts.map((a) => repos.probes.accountWindowStats(a.id, since));
    const sent = totals.reduce((acc, t) => acc + (t?.sent ?? 0), 0);
    const acked = totals.reduce((acc, t) => acc + (t?.acked ?? 0), 0);
    res.json({
      accountCount: allAccounts.length,
      targetCount: allTargets.length,
      probesLastHour: sent,
      acksLastHour: acked,
      ackRate: sent > 0 ? acked / sent : null,
    });
  });

  r.get('/accounts', (_req, res) => {
    const list = repos.accounts.list().map((a) => {
      const rt = manager.getStatus(a.id);
      const since = Date.now() - CONFIG.CANARY_WINDOW_MS;
      const stats = repos.probes.accountWindowStats(a.id, since);
      return {
        ...a,
        status: rt.status,
        qr: rt.qr,
        targetCount: repos.targets.listByAccount(a.id).length,
        windowStats: stats,
      };
    });
    res.json(list);
  });

  r.post('/accounts', async (req, res) => {
    const { name, phone_number } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const existing = repos.accounts.getByName(name);
    if (existing) {
      res.status(409).json({ error: 'account name already exists' });
      return;
    }
    const authDir = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const created = repos.accounts.insert(name, phone_number ?? null, authDir);
    try {
      await manager.startAccount(created.id);
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
    res.json(created);
  });

  r.post('/accounts/:id/restart', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await manager.stopAccount(id);
    await manager.startAccount(id);
    res.json({ ok: true });
  });

  r.delete('/accounts/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await manager.logoutAccount(id);
    repos.accounts.delete(id);
    res.json({ ok: true });
  });

  r.get('/accounts/:id/qr', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const status = manager.getStatus(id);
    let qrDataUrl: string | null = null;
    if (status.qr) {
      qrDataUrl = await QRCode.toDataURL(status.qr, { margin: 1, width: 320 });
    }
    res.json({ status: status.status, qr: status.qr, qrDataUrl });
  });

  r.get('/accounts/:id/health', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    res.json(repos.health.recent(id, since));
  });

  r.get('/targets', (_req, res) => {
    const since = Date.now() - CONFIG.CANARY_WINDOW_MS;
    const list = repos.targets.listActive().map((t) => {
      const stats = repos.probes.targetWindowStats(t.id, since);
      return { ...t, windowStats: stats };
    });
    res.json(list);
  });

  r.post('/targets', async (req, res) => {
    const { account_id, raw_number, display_name } = req.body ?? {};
    const accId = parseInt(account_id, 10);
    if (!accId || !raw_number) {
      res.status(400).json({ error: 'account_id and raw_number required' });
      return;
    }
    const account = repos.accounts.get(accId);
    if (!account) {
      res.status(404).json({ error: 'account not found' });
      return;
    }
    const jid = await manager.resolveJid(accId, raw_number);
    if (!jid) {
      res.status(400).json({ error: 'number not on whatsapp or account not connected' });
      return;
    }
    let target: repos.Target;
    try {
      target = repos.targets.insert(accId, jid, display_name ?? null);
    } catch (err: any) {
      if (String(err?.message).includes('UNIQUE')) {
        res.status(409).json({ error: 'target already exists for this account' });
        return;
      }
      throw err;
    }
    manager.startTarget(accId, target);
    res.json(target);
  });

  r.delete('/targets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = repos.targets.get(id);
    if (!target) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    manager.stopTarget(target.account_id, id);
    repos.targets.delete(id);
    res.json({ ok: true });
  });

  r.get('/targets/:id/probes', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const since = parseInt((req.query.since as string) ?? '0', 10) || Date.now() - 60 * 60 * 1000;
    const limit = Math.min(5000, parseInt((req.query.limit as string) ?? '500', 10));
    res.json(repos.probes.recent(id, since, limit));
  });

  return r;
}
