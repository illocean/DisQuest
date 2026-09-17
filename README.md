# DisQuest

A custom [Vencord](https://github.com/Vendicated/Vencord) userplugin that automatically
completes Discord quests — videos, activities, achievements, and game/stream quests
where Discord allows — with first-class [Vesktop](https://github.com/Vencord/vesktop) support.

Fork of [Seramicx/discord-quest-autocompleter](https://github.com/Seramicx/discord-quest-autocompleter),
hardened with reliability patches. Licensed GPL-3.0 (see source headers).

> [!WARNING]
> Automating Discord quests is against **Discord's Terms of Service**. This is a
> third-party plugin, **not supported by Vencord** — do not report issues to the
> Vencord maintainers. If your account matters to you, keep the aggressive options
> off. **Use at your own risk.**

## Core features

- **Auto-accept** new quests as Discord lists them (one enroll per scan — Discord
  escalates on bursts, so no burst enrolling).
- **Video quests** (`WATCH_VIDEO`) spoofed, done in about a minute.
- **Activity quests** (`PLAY_ACTIVITY`) driven via heartbeat loop, no action needed.
- **Achievement quests** (`ACHIEVEMENT_IN_ACTIVITY`) auto-completed via an OAuth
  roundtrip that only ever touches the quest app's own grants (snapshot-guarded,
  revoked afterwards).
- **Game/stream quests** (`PLAY_ON_DESKTOP`, `STREAM_ON_DESKTOP`) spoofed where
  Discord allows — includes the **Vesktop patch** (upstream only detects the
  official desktop bridge, so every game/stream quest was skipped under Vesktop).
- **Optional auto-claim** of rewards with a captcha solver key
  (NopeCHA / CapSolver / 2Captcha). Off by default.
- **Never-stall engine:** per-quest 429 cooldowns, global enroll backoff, a
  stuck-spoof watchdog that rotates dead quests to the back, FIFO queue with
  fast-quest priority, and deterministic rejects parked quietly until restart.
- **Stale-loop guards:** rotated quests can never corrupt the new active quest's
  watchdog counters or double-count completions.

## Slash commands

Local-only replies (visible just to you). `/disquest status` renders fixed-width
panels — queue included, so there is no separate queue command:

```txt
┌─ STATUS ───────────────────────────────
│ State     Running · up 2m
│ Bridge    detected
└────────────────────────────────────────

┌─ SESSION ──────────────────────────────
│ Done       0
│ Enrolled   0
└────────────────────────────────────────

┌─ QUEUE ────────────────────────────────
│ Total      3
│ Parked     2
│ Cooling    0
└────────────────────────────────────────

┌─ SETTINGS ─────────────────────────────
│ autoAccept  on
│ autoClaim   off
│ check       60m
└────────────────────────────────────────

┌─ ACTIVE ───────────────────────────────
│ ▸ Where Winds Meet 2.2 — Wuxia New Era
│   progress unknown
│
│ 1. RIVALS
│    progress unknown
└────────────────────────────────────────

┌─ PARKED ───────────────────────────────
│ · Dragonheir: Chaos Revelry
│ · Marvel Rivals S10
└────────────────────────────────────────
```

| Command | What it does |
|---|---|
| `/disquest status` | Full state: status, session stats, queue with progress, settings, active + parked quests. Empty sections are omitted. |
| `/disquest start` | Resume automation (STATUS + QUEUE confirmation). |
| `/disquest stop` | Pause everything, keeps the queue (STATUS + QUEUE confirmation). |

Names carry the `disquest` prefix on purpose — bare `/status` would collide with
music bots, and a duplicate command name fails plugin startup.

## Setup / install

Prerequisites: [Node.js LTS](https://nodejs.org), [pnpm](https://pnpm.io),
[Git](https://git-scm.com), and Vesktop (or a local Vencord desktop build).

```powershell
# 1. Clone Vencord and install dependencies
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install

# 2. Drop this plugin in as a userplugin
mkdir src\userplugins\disQuest
Copy-Item \\path\\to\\DisQuest\\index.tsx  src\userplugins\disQuest\
Copy-Item \\path\\to\\DisQuest\\native.ts  src\userplugins\disQuest\

# 3. Build
pnpm build

# 4. REQUIRED: Vesktop validity marker, or it re-downloads stock Vencord over your build
[System.IO.File]::WriteAllText("dist\package.json", "{}",
    (New-Object System.Text.UTF8Encoding $false))
```

Then point Vesktop at your build: set `vencordDir` in `%AppData%\vesktop\state.json`
to your `...\Vencord\dist` folder (or use Vesktop's Vencord-location setting if
available). **Fully quit Vesktop** (tray icon → Quit — closing the window is not
enough), reopen, and enable **Settings → Vencord → Plugins → DisQuest**.

Verify: `Ctrl + Shift + I` → Console → filter `[DisQuest]`. You should see the
build line right after `Starting...`:

```
[DisQuest] DisQuest 2026-09-17q (audit fixes)
[DisQuest] Session started (isApp = true, ...)
[DisQuest] Checking for new quests...
```

> [!NOTE]
> `src/userplugins/` is gitignored in Vencord, so the folder survives upstream
> pulls but Git does not back it up — keep this repo as the master copy and
> copy both files over on updates.

Default settings are conservative: progress logging on, achievement bypass on,
auto-accept off, auto-claim off (no captcha key stored).

| Option | Default | Meaning |
|---|---|---|
| `autoAcceptQuests` | off | Accept new quests automatically |
| `fetchIntervalMinutes` | 120 | How often to ask Discord for new quests (min 30, enforced) |
| `logProgress` | on | Console progress logs |
| `achievementBypass` | on | Auto-complete achievement quests via OAuth |
| `autoClaim` | off | Claim rewards (needs a captcha solver key) |
| `captchaService` / `captchaApiKey` | NopeCHA / — | Solver used only when auto-claim is on |

## Updating

```powershell
cd Vencord
git pull
pnpm install      # only if dependencies changed
pnpm build
[System.IO.File]::WriteAllText("dist\package.json", "{}",
    (New-Object System.Text.UTF8Encoding $false))
```

Then copy the new `index.tsx` / `native.ts` from here into `src/userplugins\disQuest\`
first if the plugin changed, rebuild, re-create the marker, restart Vesktop.

## Know your quest types

- `WATCH_VIDEO` trailers — spoofed, ~1 min. Proven working.
- `PLAY_ACTIVITY` — heartbeat loop, needs no action.
- `ACHIEVEMENT_IN_ACTIVITY` — OAuth bypass, automatic.
- `PLAY_ON_DESKTOP` — game spoof, takes full quest time (experimental under Vesktop).
- `STREAM_ON_DESKTOP` — stream spoof; you must also sit in a voice channel.
- **Platform-gated quests** ("Select a platform to get started") never auto-enroll —
  pick the platform and accept manually; the plugin can then process the quest.
- **`Completed:` ≠ claimed.** Completion only finishes progress; claim the reward in
  Discord's UI unless auto-claim + captcha key is configured.

## Troubleshooting

- **Plugin missing after restart:** Vesktop replaced the custom build (missing
  `dist\package.json`). `dist\vencordDesktopRenderer.js` should contain `DisQuest`;
  the stock file doesn't. Rebuild, re-create the marker, restart.
- **Enroll rate-limit jam:** turn `autoAcceptQuests` off after the bulk enroll and
  accept manually; restart Vesktop to clear stuck loops.
- **Play-quest heartbeats rejected (HTTP 401):** Discord's server refuses spoofed
  play sessions here — those quests park until restart while videos/activity keep
  running. Genuine playtime is the only path for them.
- **Pause anytime:** `/disquest stop` (keeps the queue) or toggle the plugin off —
  no rebuild needed.

## Credits

- Upstream: [Seramicx/discord-quest-autocompleter](https://github.com/Seramicx/discord-quest-autocompleter)
- Maintained by [illocean](https://github.com/illocean), with `0.ninetynine` as contributor
- See [VESKTOP-SETUP.md](./VESKTOP-SETUP.md) for detailed local setup/backup notes.
