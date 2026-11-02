# Vesktop + Vencord DisQuest — Setup Guide

**Date:** 2026-09-17 (updated: Vesktop patch + enroll guard)
**Plugin:** DisQuest (custom Vencord userplugin, GPL-3.0 — fork of Seramicx/discord-quest-autocompleter with Vesktop support, slash commands, and reliability patches; renamed from QuestAutocompleter, settings auto-migrate on first start)
**Client:** Vesktop (local Vencord build, not the bundled one)

## What was done

- Cloned a **fresh copy of Vencord** into `C:\Users\andador kim phillip\Documents\Vencord` (commit `59a54286`, branch `main`).
- Staged the plugin at `src/userplugins/disQuest/` (`index.tsx`, `native.ts`). Master copy lives at `D:\DisQuest\` — both are kept byte-identical. Note that Vencord's `.gitignore` excludes `src/userplugins/`, so the folder is currently ignored and normally survives upstream pulls — but Git does not back it up, and it is not committed.
- Built with `pnpm build` → output in `Documents\Vencord\dist` (custom `vencordDesktopRenderer.js` ~767 KB containing `DisQuest`; `vencordDesktopMain.js` contains the `discordsaysAuthorize` native helper).
- Wrote the 2-byte validity marker `dist\package.json` (`{}`). Vesktop checks for this file plus the 4 desktop bundles on every launch — without it, Vesktop silently re-downloads the official Vencord release over your custom build. **After every rebuild, re-create this file.**
- Wired Vesktop to this build via `vencordDir` in `%AppData%\vesktop\state.json` → `...\Documents\Vencord\dist`.
- Settings in Vesktop (`settings\settings.json`):

  | Option | Value | Meaning |
  |---|---|---|
  | enabled | `true` | Plugin active |
  | autoAcceptQuests | `true` | New quests are accepted automatically (your call 2026-09-17) |
  | fetchIntervalMinutes | `120` | Check for quests every 2 hours (minimum 30, enforced in code) |
  | logProgress | `true` | Progress visible in DevTools console |
  | achievementBypass | `true` | Achievement quests auto-complete via OAuth |
  | autoClaim | `false` | Rewards are **not** auto-claimed |
  | captchaService | `nopecha` | Solver used *only if* autoClaim is turned on |

  No captcha API key is stored — `captchaApiKey` is deliberately absent.

## Local patches (vs upstream repo)

1. **Vesktop app detection (experimental):** upstream checks only Discord Desktop's bridge (`window.DiscordNative`), which Vesktop never provides, so every game/stream quest was skipped. `isApp` now also accepts Vesktop's own bridge (`window.VesktopNative`). Browser behavior unchanged.
2. **Enroll concurrency guard:** upstream's 60 s scan spawns overlapping enroll loops that pile into rate-limit waits (2800 s+) and starve queue processing. `scan()` now runs one enroll loop at a time while queue processing runs every cycle.

3. **Never-stall hardening:** a 429 no longer sleeps the enroll loop — the quest is parked on a per-quest cooldown (`enrollCooldowns`) until Discord's retry window passes while everything else keeps moving, and `scan()` is wrapped so any stage failure is logged and retried next cycle instead of killing it.

4. **Rate-limit accommodation (escalating 429s):** any 429 now pauses ALL enroll attempts until Discord's window passes (`enrollBackoffUntil`), and each scan enrolls at most one quest — your log proved Discord escalates on bursts (188 s grew to 3407 s). Five remaining quests enroll over ~5 min instead of never.
5. **Fast-quest priority:** the queue sorts videos/activity/achievements ahead of stream/game spoofs, so a 15-min game spoof no longer starves quick watch quests queued behind it.
6. **Stuck-spoof watchdog:** a game/stream spoof that shows no completion within max(45 min, 2x quest time + 10 min) rotates to the back and retries later (server-side progress is kept). Video/activity loops drive themselves and always terminate, so only spoof branches are eligible.

7. **Game-spoof heartbeat fix:** the fake game now carries the full process shape (icon, executables, overlay flags) and is visible through every `RunningGameStore` accessor Discord's heartbeat sender may read (`getVisibleGame`, `getRunningDiscordApplicationIds`, `getCandidateGames`, ...), not just the two upstream patched. Both game and stream branches also subscribe to `QUESTS_SEND_HEARTBEAT_FAILURE` (previously a rejected heartbeat was totally invisible), and the watchdog now calls it after 150 s of total heartbeat silence or 5 consecutive failures — rotating to the back, skipping after 3 strikes. Absolute spoof timeout tightened to max(25 min, quest time + 10 min).

9. **Review micro-fixes:** stream branch now uses the FIFO cooldown (it was still passing the removed skip flag, which coerced to a 1 ms cooldown); claim failures reset each session instead of never retrying; one malformed quest can't abort the whole enroll loop anymore.

10. **Audit remediation:** `logError` now defined (scan error paths actually log instead of throwing ReferenceError); achievement bypass aborts if the OAuth-grant snapshot fails and only ever revokes the quest app's own new grants; dead enroll-retry loop simplified to the single attempt it always was; activity-quest failures requeue with cooldown like every other branch.

11. **Variant heartbeat probes:** when native beats are deterministically rejected, the manual takeover now probes two evidenced bodies in order — `{application_id, terminal}`, then `{application_id, stream_key: null, terminal}` (the internal QuestActions shape) — and drives progress with whichever is accepted; all rejected rotates as before.

12. **Quest parking:** deterministically-rejected play/stream quests park quietly until restart (fresh chance every session) instead of retrying every 30 min — videos, activity, achievements, and enroll keep running untouched.

All patches live in `index.tsx` in both copies; rebuild after any edit, re-create `dist\package.json`, restart Vesktop.

## Restart and verify

1. **Fully quit Vesktop** — tray icon → **Quit** (closing the window is not enough).
2. Reopen Vesktop.
3. **Settings → Vencord → Plugins → DisQuest** → ON (old QuestAutocompleter settings migrate automatically on first start — verify the values).
4. `Ctrl + Shift + I` → Console → filter `[DisQuest]`. First confirm the build line `DisQuest 2026-09-17q (audit fixes)` right after `Starting...` — if it's absent, the old code is still resident (window-close instead of tray-quit, or restart predated the build) and nothing below applies yet. Healthy sequence:
   ```
   [DisQuest] Session started (isApp = true, ...)
   [DisQuest] Checking for new quests...
   [DisQuest] Queued: <name>
   [DisQuest] Starting processing loop...
   [DisQuest] Spoofing video: <name>  →  Completed: <name>
   [DisQuest] Spoofed game: <name> – ~N min left  →  Progress: x/y
   ```
5. Game quests take their full play-time in real time (a 15-min quest takes 15 min). Progress lines accrue, then `Completed:`.

## Slash commands (local-only replies, visible just to you)

In any chat type: `disquest status` (state, queue with progress, session stats, settings), `disquest start` (resume automation), `disquest stop` (pause everything, keeps the queue). Names carry the `disquest` prefix on purpose — bare `/status` would collide with music bots in servers, and a name clash with another plugin would fail DisQuest startup (Vencord rejects duplicate command names).

## Know your quest types (what works where)

- `WATCH_VIDEO` trailers — spoofed, complete in about a minute. Proven working.
- `PLAY_ON_DESKTOP` — game spoof, takes full quest time. Works via the Vesktop patch (experimental, untested server-side long-term).
- `STREAM_ON_DESKTOP` — stream spoof; you must also sit in a voice channel.
- `PLAY_ACTIVITY` — heartbeat loop, needs no action.
- `ACHIEVEMENT_IN_ACTIVITY` — OAuth bypass, automatic.
- **Platform-gated quests** ("Select a platform to get started"): the plugin's enroll call carries no platform choice, so these never enroll — pick the platform and accept manually in Discord's UI; the plugin can then process the quest if its task type is supported.
- **`Completed:` ≠ claimed.** Completion only finishes progress; the reward still needs claiming in Discord's UI unless auto-claim + a captcha solver key is configured.

## Updating

```powershell
cd "C:\Users\andador kim phillip\Documents\Vencord"
git pull
pnpm install   # only if dependencies changed
pnpm build
# REQUIRED after every build: Vesktop validity marker, or it re-downloads stock Vencord over your build
[System.IO.File]::WriteAllText("dist\package.json", "{}", (New-Object System.Text.UTF8Encoding $false))
```

Then fully restart Vesktop. The `src/userplugins/` folder is gitignored, so it is currently ignored and normally survives upstream pulls — but Git does not back it up, so keep `D:\DisQuest\` as your master copy.

**Plugin updates:** copy the new `index.tsx` / `native.ts` into **both** places — the master copy at `D:\DisQuest\` **and** `src/userplugins\disQuest\` — then `pnpm build`, re-create `dist\package.json` (`{}`), and restart Vesktop.

## Troubleshooting

**Enroll rate-limit jam (many `Auto-accepting N quest(s)...` repeats, `waiting 2800s+` sleeps, no `Queued:` lines):** largely fixed by the concurrency guard — one enroll loop at a time now. If it still spirals, turn `autoAcceptQuests` OFF after the bulk enroll, manually accept new quests, and restart Vesktop to clear stuck loops.

**Play-quest heartbeats rejected (`Heartbeat failed: HTTP 401, code 40001`):** the spoof is visible (beats fire) but Discord's server refuses every spoofed play session — seen on all play quests, unaffected by the Activity Privacy toggle. Proven 2026-09-17 at every level testable from JS: Discord's own sender, manual `{application_id}`, and manual `{application_id, stream_key: null}` bodies are all refused identically (8/8 play quests) — the server demands native process telemetry Vesktop cannot provide, so spoofed play/stream cannot complete here; genuine playtime is the only path. Failed quests still rotate FIFO with cooldown while videos/activity/achievements (all green) run first. Decisive test: DevTools → Network → click a failed heartbeat POST → paste its Payload body, Response body, and whether `authorization` is present (redact the token), plus the same for a working enroll POST. The stack traces already prove the sender path is Discord's own code — the payload content is the missing piece.

**Plugin missing from Settings → Vencord → Plugins after restart:** Vesktop likely replaced the custom build with the official release (happens when `dist\package.json` is absent). Check without restarting: `dist\vencordDesktopRenderer.js` should be ~767 KB and contain `DisQuest`; the stock file is ~714 KB with zero matches. Fix: `pnpm build`, re-create `dist\package.json` with content `{}`, restart Vesktop.

## Rollback

1. **Disable the plugin:** Settings → Vencord → Plugins → DisQuest → OFF (or `/disquest stop` for a temporary pause that keeps the queue). No rebuild needed.
2. **Restore settings backup:** newest is `settings.json.bak-20260917-guardPatch` (older: `...-autoAcceptOff`, `...-preOrionRemoval`, `...20260917`) — quit Vesktop first, copy over `settings.json`.
3. **Restore the pre-plugin Vencord build:** `Documents\Vencord-dist-backup-20260917` holds the working `dist` from before this change. Point `vencordDir` (in `state.json`) at it, or copy its contents over `Documents\Vencord\dist`, then restart Vesktop.

## Disclaimer

This is a custom, third-party plugin, now with two local patches. Automating Discord quests is against **Discord's Terms of Service**. It is **not supported by Vencord** — do not report issues to the Vencord maintainers. If your account matters to you, keep the aggressive options off. **Use at your own risk.**
