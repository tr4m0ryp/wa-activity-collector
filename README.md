# wa-activity-collector

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![Baileys](https://img.shields.io/badge/baileys-7.x-blue.svg)](https://github.com/WhiskeySockets/Baileys)
[![Paper](https://img.shields.io/badge/paper-RAID%202025-red.svg)](https://arxiv.org/abs/2411.11194)
[![Status](https://img.shields.io/badge/status-research%2FPoC-orange.svg)]()

**Multi-account WhatsApp activity tracker via RTT delivery-receipt side-channel.** Sends silent delete-probes at 2Hz per target, records every probe and ack into SQLite, and provides a minimal management UI to add accounts (QR pairing) and target phone numbers. No classification, no inference — only raw timing data, so analysis stays in the analysis layer.

Reimplements the data-collection side of [Careless Whisper: Exploiting Silent Delivery Receipts to Monitor Users on Mobile Instant Messengers](https://arxiv.org/abs/2411.11194) (Gegenhuber et al., RAID 2025 Best Paper). For each tracked target, the collector sends a "delete" probe for a non-existent message ID at 2Hz; WhatsApp produces a delivery receipt from whichever of the target's linked devices is online; the round-trip time is what gets stored.

> **Heads up:** WhatsApp's anti-abuse systems weight datacenter ASNs heavily. Run from a residential connection if you care about your account, and only point this at people who have consented (research subjects, your own devices, etc.).

## What the data looks like

```
probe_events:
  id, target_id, probe_msg_id,
  sent_at_ms, ack_at_ms, rtt_ms,
  ack_type, ack_jid, timed_out
```

`ack_jid` is the multi-device ground truth: `31...@s.whatsapp.net` is the primary phone, `@lid` JIDs are the target's linked sessions (laptop, iPad, web). Useful when later analysis needs to separate "phone responded" from "any device responded".

## Setup

```sh
git clone <this repo>
cd wa-activity-collector
npm install
npm start
```

Open `http://localhost:3000`, click `+ account`, scan the QR with `WhatsApp → Linked Devices` on your phone, then add target phone numbers (with country code) inside the account card.

## Deploying

The collector is designed to run continuously on a server. Two patterns:

**Residential server (preferred for warm accounts).** Run on a Mac mini / Raspberry Pi / etc. on your home connection, expose only the management UI through a Cloudflare tunnel. WhatsApp's anti-abuse weights datacenter IPs heavily — running outbound traffic from a residential ASN is the safest pattern.

**Cloud VM with locally-paired session.** If you must use a cloud provider:

1. Pair Baileys locally first (residential IP)
2. Provision the VM (e.g. `gcloud compute instances create wa-collector --zone=europe-west4-a --machine-type=e2-small --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=20GB`)
3. Install Node 20+ and `npm install` on the VM
4. Stop local server and run `./scripts/sync-to-server.sh` to upload `data/`
5. Run as a systemd service; expose UI through SSH tunnel only

The pairing happens with a residential fingerprint; sustained probe traffic then runs from the VM. This mitigates the cold-pairing anomaly but the active session still originates from the cloud IP, which remains a residual risk.

## Configuration

`src/config.ts`:

| key | default | meaning |
|---|---|---|
| `PROBE_INTERVAL_MS` | `500` | base interval between probes per target (2Hz) |
| `PROBE_JITTER_MS` | `100` | uniform `±` jitter |
| `PROBE_TIMEOUT_MS` | `5000` | timeout for a single probe ack |
| `OFFLINE_BACKOFF_FACTOR` | `5` | multiply interval by this when the target appears offline |
| `OFFLINE_MISS_THRESHOLD` | `5` | consecutive timeouts before backoff kicks in |

Per the Careless Whisper paper, WhatsApp tolerates probe rates up to ~20Hz (50ms) without observable rate-limiting; 2Hz is a conservative default that leaves plenty of headroom for sustained 24/7 collection. Push higher only if you have a reason and watch the per-account ack rate as a canary.

## Schema and data export

SQLite at `data/activity.db`, WAL mode. Tables:

- `accounts(id, name, phone_number, auth_dir, active, created_at_ms)`
- `targets(id, account_id, jid, display_name, added_at_ms, active)`
- `probe_events(id, target_id, probe_msg_id, sent_at_ms, ack_at_ms, rtt_ms, ack_type, ack_jid, timed_out)`
- `presence_events(id, target_id, observed_jid, presence, observed_at_ms)`
- `account_health(account_id, bucket_ms, probes_sent, acks_received, timeouts, ws_disconnects)` — 1-minute buckets

For analysis, dump the relevant tables to Parquet/CSV and load wherever (DuckDB, pandas, the analyst Claude session of your choice). The schema is intentionally narrow so that aggregation choices stay in the analysis layer.

## Operational notes

- **Auth state is precious.** `data/auth/<account>/` contains the linked-device session keys. Lose this and you re-pair from scratch. Back it up.
- **Don't run two collectors against the same account.** Each Baileys session occupies one linked-device slot; a second concurrent session against the same account triggers `connectionReplaced` (one of them gets booted, you lose pairings).
- **Multi-device caveat.** A "fresh ack" means *some* linked device of the target was reachable, not necessarily their phone. The raw `ack_jid` per probe is the only honest source on which device responded.
- **Phone keep-alive.** Linked-device sessions die ~14 days after the primary phone goes unreachable. As long as the phone connects to WA every couple of weeks, server sessions stay valid.
- **Volume.** At 2Hz × 5 targets × 24h = ~864k events/day = ~70MB/day in SQLite. Years of collection comfortably fits without rotation.

## Status

Research/PoC. Not for production-grade adversary modelling, not for surveilling people without their consent.

## Stack

- Node.js 20+ / TypeScript / [Baileys 7](https://github.com/WhiskeySockets/Baileys)
- `better-sqlite3` (WAL)
- `express` + `socket.io` for the management UI
- Vanilla JS frontend, no build step
