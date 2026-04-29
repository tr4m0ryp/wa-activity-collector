---
name: analyse-target
description: Analyse a single tracked target's WhatsApp probe data. Pulls live from the GCP server's SQLite (WAL-safe — does not interrupt collection), separates target-side acks (delivery type) from our own collector account's echo acks (sender type), classifies the target's actual physical devices into fast/phone bands by RTT signature, decomposes phone RTTs into behavioural states (foreground/screen-off/etc.), and emits a clean human-readable presence timeline in NL local time. Triggers include "analyse <name>", "show timeline for <name>", "what was <name> doing", "decompose <name>'s activity", "/analyse-target <name>".
argument-hint: <target_name_or_jid> [--since 24h|3d] [--mode timeline|devices|phone-states|all]
user-invocable: true
allowed-tools: Bash, Read, Write
---

# analyse-target

Project-scoped skill for inspecting one target's collected probe data and rendering a human-readable behavioural timeline. The single most important methodological point is in the section below — read it before invoking.

## The ack_type distinction (load-bearing methodology)

A WhatsApp delete-probe receipt comes back from two distinct sources:

- **`ack_type=sender`** — from OUR collector account's other linked devices (typically the warm laptop where you scanned the original QR code). When we send a delete, WhatsApp's multi-device sync notifies our other devices so they can mirror the deletion; they ack as 'sender'. **This receipt happens regardless of whether the target's phone is on, off, or anywhere.** It is signal about us, not them.
- **`ack_type=delivery`** — from the target's actual physical device(s). This is the only ack that tells us anything about the target.

The same `@lid` JID will appear in EVERY target's data with `ack_type=sender` because every probe we send is mirrored back to our own laptop. An earlier version of this analysis treated those as if they were the target's "always-on laptop" — a mistake that produced believable but completely wrong narratives ("they were at their desk for 4h" actually meaning "we had our laptop on for 4h"). **Don't repeat it.** The current `analyze.py` filters by ack_type; if you reimplement any logic, do the same.

## When to use

- The user asks "what's <name> been doing", "show me <name>'s timeline", "decompose <name>'s activity", or types `/analyse-target <name>`
- Any time the user wants to look at a specific target rather than account-level stats

Do NOT use for:
- Account-level health (use `/api/stats`)
- Cross-target comparisons (this is single-target)
- Live monitoring (one-shot snapshot; for live, point them at the UI tunnel)

## How it works

```
gcloud-ssh to wa-collector
   -> sqlite3 -csv probe_events for target_id
   -> Python analysis pipeline:
        1. classify_devices()       -- segregate by ack_type:
                                       delivery -> target's actual physical devices
                                       sender   -> our own account's linked devices (IGNORED)
                                     Within target devices, by RTT signature:
                                       fast  : median < 800ms   (rare phone-foreground or
                                                                 primary-JID device session)
                                       phone : median > 1500ms  (typical mobile push-wake)
        2. phone_state_breakdown()  -- map delivery-acked phone RTT to states
                                       baseline = phone p10
                                       foreground   = baseline + 0..200ms
                                       minimized    = baseline + 200..500ms
                                       screen-on-bg = baseline + 500..1500ms
                                       screen-off   = baseline + 1500..2500ms
                                       deep-sleep   = baseline + >2500ms
        3. per_minute_classify()    -- bucket each UTC minute (sender acks ignored):
                                       PHONE_ACTIVE     -- >=2 fast delivery acks
                                       PHONE_REACHABLE  -- >=2 slow phone delivery acks
                                       SILENT           -- 0 delivery acks despite probes
        4. smooth_and_coalesce()    -- absorb 1-2 min flips, merge contiguous runs
        5. render_timeline()        -- per-day local-time output with totals
```

The implementation lives in `scripts/analyze.py`. Don't reimplement — call it.

## Invocation

```bash
python3 scripts/analyze.py <target>                       # default: timeline, NL local
python3 scripts/analyze.py <target> --since 24h           # last 24h only
python3 scripts/analyze.py <target> --mode all            # devices + phone-states + timeline
python3 scripts/analyze.py <target> --tz -5               # different TZ
python3 scripts/analyze.py <target> --source file --file exports/foo.csv  # offline CSV
```

`<target>` resolves against `display_name`, full `jid`, or phone-number prefix.

## Interpretation guide (what the output means and what it doesn't)

The timeline emits three states, all derived from delivery-type acks only:

- **"phone active"** — multiple low-RTT delivery acks in one minute. Strong evidence that the target's phone is in screen-on / WA-foregrounded state. Likely WhatsApp open or notification just consumed.
- **"phone reachable"** — slow but consistent delivery acks. Phone is on the network, but in screen-off / push-wake state. Reachable, not in active use.
- **"phone silent"** — probes were sent but no delivery acks came back. Phone is powered off, in airplane mode, in deep sleep beyond push reach, or out of cellular coverage. **Cannot distinguish "off" from "in poor signal".**

What the timeline can NOT tell you:
- **Location**. Phone reachability is decoupled from physical location (especially with wifi-roaming). Never claim "she was at home/at her desk/outside" from this signal alone.
- **Sleep vs awake**. Without multi-day diurnal patterns, "phone silent overnight" looks identical to "phone in basement".
- **App-specific use**. The target may be using a non-WhatsApp app while phone is foreground-active; our delete-probe RTT only drops if WhatsApp itself is foregrounded.
- **Whose laptop is on**. The 'fast'-RTT @lid you see in `ack_type=sender` is OUR laptop. The target's laptop, if any, doesn't show up in delete-probe traffic.

For confident "they were actively in WhatsApp" claims, look for runs of 3+ consecutive `phone active` minutes. Single isolated `phone active` minutes are likely individual notification glances, not sustained engagement.

## Caveats

- **Stalled-collection windows are invisible**. If our collector stalled (e.g. WS disconnect bug), gaps in probe_events look identical to "target was silent". Always cross-check `account_health` for `ws_disconnects` and probe-rate dips before claiming long silences are real.
- **Timezone**: defaults to NL (UTC+2 CEST). Override with `--tz <hours>`.
- **Multiple target devices**: a target may have several `ack_type=delivery` JIDs (e.g. primary phone JID `<num>:<sess>@s.whatsapp.net` plus an `@lid`). The script treats faster-RTT delivery JIDs as the "fast" path (correlating with PHONE_ACTIVE) and slower-RTT JIDs as the "phone" path (correlating with PHONE_REACHABLE).
- **A `:N@s.whatsapp.net` JID with N>0 IS a primary-number device session**, not just a multi-device endpoint. These sometimes ack faster than the target's `@lid` and are more diagnostic of "phone is at its most awake".
- **Don't read 'silent' as 'asleep'**. Phone silent over a minute means probes did not produce delivery acks; it does not mean the person is asleep, off the grid, or anything specific about their state — only that the device wasn't reachable enough to ack.

## Example narrative shape

When the user asks "what was X doing this afternoon", lead with what the data shows, not what you'd like it to show:

> "From 16:48-17:55 NL her phone was reachable but in background state — on the network, not in active use. 17:55-18:37 her phone went silent; could be off, in DND, or in poor signal — can't say which. Two short reachable bursts at 18:37 and 18:59 suggest the phone was pulled out briefly. From 19:10-21:07 the phone was completely silent for nearly 2 hours — the strongest signal in her timeline. Total 'actively in WhatsApp' time today: 14 minutes, all between 23:01-23:15 yesterday evening."

Never claim location, posture, or social context — the most you can say is what the phone's network behaviour shows.
