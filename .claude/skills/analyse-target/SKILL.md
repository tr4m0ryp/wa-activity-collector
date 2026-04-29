---
name: analyse-target
description: Analyse a single tracked target's WhatsApp probe data. Pulls live from the GCP server's SQLite (WAL-safe — does not interrupt collection), classifies the target's devices into phone/laptop by RTT signature, decomposes phone RTTs into behavioural states (foreground/screen-off/etc.), and emits a clean human-readable presence timeline in NL local time. Triggers include "analyze <name>", "show timeline for <name>", "what was <name> doing", "decompose <name>'s activity", "/analyse-target <name>".
argument-hint: <target_name_or_jid> [--since 24h|3d] [--mode timeline|devices|phone-states|all]
user-invocable: true
allowed-tools: Bash, Read, Write
---

# analyze-target

Project-scoped skill for inspecting one target's collected probe data and rendering a human-readable behavioural timeline.

## When to use

- The user asks "what's <name> been doing", "show me <name>'s timeline", "decompose <name>'s data", or types `/analyse-target <name>`
- Any time the user wants to look at a specific target rather than just account-level stats
- Anytime they ask for "device states" or "when was she online/mobile"

Do NOT use this for:
- Account-level health checks (use the `/api/stats` endpoint instead)
- Cross-target comparisons (this is single-target)
- Live monitoring (this is a one-shot snapshot; for live, point them at the UI)

## How it works

```
gcloud-ssh to wa-collector
   -> sqlite3 -csv probe_events for target_id
   -> Python analysis pipeline:
        1. classify_devices()  -- group ack_jid by RTT signature
                                  laptop kind: median < 800ms (tight, fast — desktop client)
                                  phone kind:  median > 1500ms (mobile push-wake shape)
        2. phone_state_breakdown()  -- map phone RTT to states
                                       baseline = phone p10
                                       foreground   = baseline + 0..200ms
                                       minimized    = baseline + 200..500ms
                                       screen-on-bg = baseline + 500..1500ms
                                       screen-off   = baseline + 1500..2500ms
                                       deep-sleep   = baseline + >2500ms
        3. per_minute_classify()    -- bucket each UTC minute as
                                       LAPTOP / PHONE / BOTH / OFFLINE / sparse
        4. smooth_and_coalesce()    -- absorb 1-2 min BOTH blips into surrounding state,
                                       merge contiguous same-state minutes into runs,
                                       count phone-touches inside laptop windows
        5. render_timeline()        -- per-day local-time output with totals
```

The analysis lives in `scripts/analyze.py`. Don't reimplement — call it.

## Invocation

```bash
# Default: timeline view, full available data, NL local time
python3 scripts/analyze.py <target>

# Last 24h only
python3 scripts/analyze.py <target> --since 24h

# Show device classification AND phone state distribution AND timeline
python3 scripts/analyze.py <target> --mode all

# Different timezone (e.g. UTC-5 for US East)
python3 scripts/analyze.py <target> --tz -5

# From a previously-exported CSV instead of live server
python3 scripts/analyze.py <target> --source file --file exports/foo.csv
```

`<target>` resolves against `display_name`, full `jid`, or phone number prefix (matches `<num>@%`). The script picks the first match.

## Interpretation guide (what the output means and what it doesn't)

The skill produces a behavioural-state timeline. Be careful with the inferences:

- **"at desk (laptop online)"** = the target's persistent WhatsApp Web / Desktop session is reachable. Does NOT prove the user is *at* the laptop — it proves the laptop is on with WA Web reachable. Useful as an environmental indicator.
- **"mobile (phone only)"** = phone responds, laptop does not. Strongest signal that the target is away from their usual desk setup.
- **"phone + laptop both online"** = phone briefly woke (notification, screen on, app foreground) while laptop was already up. These are usually short pulses — the *number of these pulses* during a long laptop window is a much better proxy for "she checked her phone" than the duration alone.
- **"fully off the grid"** = both devices unresponsive in the same minute. Rare (often <1% of time). Counts as evidence of a real network blackout / out-of-coverage moment, NOT proof she "went offline" in a behavioural sense.

The phone state breakdown (foreground / screen-off / etc.) is descriptive, not deterministic. A single low-RTT probe could be a network jitter coincidence; the script requires `>=2 low-RTT probes per minute` to call a minute "PHONE active". For confident "she had WA open" claims, look at clusters of multiple consecutive low-RTT phone acks within a minute.

## Caveats

- **Multi-device-only targets**: the @lid endpoints are linked devices, never the primary phone JID. Some targets may have only one linked device (then `phone_jid` or `laptop_jid` will be None and the timeline will be sparse).
- **Stalled-collection windows are invisible**: if collection itself stalled (e.g. WS disconnect bug), gaps in probe_events look identical to "target was off the grid". Cross-check against `account_health` table before drawing strong conclusions about long offline windows.
- **Timezone**: defaults to NL (UTC+2). Override with `--tz <hours>` for other targets.
- **3+ devices**: the device classifier currently labels by RTT signature only (laptop vs phone vs mid). Targets with 3+ linked devices may need manual inspection.

## Examples to follow when interpreting output

When the user asks "what was Mirthe-Lynn doing yesterday afternoon", the right shape of answer:

> "16:48-17:54 NL she was mobile (phone only — likely commuting). At 17:54 she arrived at her desk; the laptop came online and stayed up for the rest of the evening. She stepped away briefly twice (18:37 and 19:02) for ~10-15 min each, then settled in from 19:10 onwards for ~3 hours of sustained desk time, glancing at her phone roughly 22 times during that window."

Lead with the behavioural narrative, not the raw counts. The script's output contains the data; your job is to translate it into the user's question's frame.
