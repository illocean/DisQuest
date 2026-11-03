# DisQuest

Auto-complete Discord quests (videos, activities, achievements, game/stream spoofs) and surface status via `/disquest status`, `start`, `stop`.

A Vencord user plugin — fork of [Seramicx/discord-quest-autocompleter](https://github.com/Seramicx/discord-quest-autocompleter) with Vesktop support.

---

## Preview

```text
┌─ STATUS ───────────────────────────────
│ State     Running · up 2h 14m
│ Bridge    missing (desktop quests
│           skipped)
└────────────────────────────────────────

┌─ SESSION ──────────────────────────────
│ Done       12
│ Enrolled   14
└────────────────────────────────────────

┌─ QUEUE ────────────────────────────────
│ Total      3
│ Parked     1
│ Cooling    0
└────────────────────────────────────────

┌─ SETTINGS ─────────────────────────────
│ autoAccept  on
│ autoClaim   off
│ check       120m
└────────────────────────────────────────

┌─ ACTIVE ───────────────────────────────
│ ▸ Call of Duty: Modern Warfare 4
│   1200/1800
│
│ 1. 99 Nights in the Forest
│    not started
└────────────────────────────────────────

┌─ PARKED ───────────────────────────────
│ · VALORANT HUSH
└────────────────────────────────────────

```

`/disquest start` resumes automation; `/disquest stop` freezes all scans and queue processing until started again.

---

## Features

| Feature | What it does |
|---|---|
| **Auto-accept** | Enrolls every new completable quest automatically (setting `autoAcceptQuests`) |
| **Auto-complete** | Runs video, activity, achievement, and game/stream quests to completion |
| **Auto-claim** | Claims finished rewards via hCaptcha solver (setting `autoClaim`, needs a captcha key) |
| **Achievement bypass** | Auto-completes achievement quests (setting `achievementBypass`) |
| **Game spoofing** | Injects a fake process into RunningGameStore for PLAY_ON_DESKTOP quests (desktop only; Discord may still require proof a real game ran — see below) |
| **Stream spoofing** | Spoofs stream metadata for STREAM_ON_DESKTOP quests (needs 1+ person in a VC) |
| **Quest queue** | Sequential FIFO with per-quest cooldowns; cooling quests cycle to the back |
| **Heartbeat watchdog** | Detects a stalled quest (no heartbeat 150s) and rotates it to the back |
| **Manual heartbeat** | One direct `/quests/{id}/heartbeat` beat when native beats are rejected; quests Discord refuses are parked with the real reason (never hammered — avoids 429s) |
| **Vesktop support** | Detects `VesktopNative` as well as `DiscordNative` for game/stream quests |
| **Box-panel status** | `/disquest status` summarizes everything in one readable box |

### Settings

| Setting | Default | Description |
|---|---|---|
| `autoAcceptQuests` | off | Automatically accept all available quests |
| `fetchIntervalMinutes` | 120 | How often to ask Discord for new quests (min 30) |
| `logProgress` | on | Log progress to console |
| `achievementBypass` | on | Auto-complete achievement quests |
| `autoClaim` | off | Auto-claim rewards (requires a captcha solver key) |
| `captchaService` / `captchaApiKey` | — | hCaptcha solver (nopecha / capsolver / 2captcha) |
| `pauseBetweenQuestsSeconds` | 3 | Seconds to wait between accepting quests |
| `retryCooldownMinutes` | 10 | Minutes to wait before retrying a stalled quest |

---

## Install

DisQuest is a **Vencord user plugin**. You need a Vencord install (or Vesktop, which bundles Vencord).

1. **Install Vencord** (if you have not already): follow https://vencord.dev/download.
2. **Enable user plugins**: open Vencord settings → *Plugins* → enable **User Plugins** (or set `Vencord` to load `src/userplugins`).
3. **Copy the plugin** into your Vencord source:

   ```bash
   git clone <this-repo> disquest
   cp -r disquest/src/userplugins/disQuest <Vencord>/src/userplugins/
   ```

   Or, if you build from source, drop the `disQuest` folder into `<Vencord>/src/userplugins/`.

4. **Rebuild/patch Vencord** (source installs):

   ```bash
   pnpm install
   pnpm build
   pnpm inject      # or: pnpm watch for live reload
   ```

   For a packaged Vencord install (Vesktop), user plugins live in your Vencord config directory under `userplugins/` — copy the `disQuest` folder there and restart the app.

5. **Enable DisQuest**: Vencord settings → Plugins → search **DisQuest** → toggle on. The plugin starts a session automatically on connection.

---

## Usage

Drop these slash commands in any Discord text channel:

| Command | What it does |
|---|---|
| `/disquest status` | Show state, queue, session stats, and settings |
| `/disquest start` | Resume automation (unpauses scans and queue processing) |
| `/disquest stop` | Freeze all automation until `/disquest start` |

Typical first run:

1. Enable `autoAcceptQuests` in settings so new quests are enrolled automatically.
2. (Optional) Add a captcha solver key and enable `autoClaim` to collect rewards unattended.
3. Wait — the plugin scans every 60s and refreshes the quest list every `fetchIntervalMinutes`.
4. Run `/disquest status` anytime to see what is active, queued, or parked.

> **Game quests need a real game.**
> Discord now validates executable_path + executable_fingerprint on the heartbeat - proof a real game binary ran. Without it the endpoint answers 401 and DisQuest parks the quest telling you exactly that instead of retrying. Video, activity, and achievement quests work anywhere.

---

## How it works

- **Video quests** (`WATCH_VIDEO`) post `/quests/{id}/video-progress` in small steps, paced so it never gets more than ~10s ahead of real time.
- **Game quests** (`PLAY_ON_DESKTOP`) inject a fake running game into `RunningGameStore` and patch the accessor methods; Discord's own heartbeat sender then credits progress. If native beats are rejected, one direct heartbeat is tried - Discord now requires proof a real game executable ran, so without it the quest is parked with that reason.
- **Stream quests** (`STREAM_ON_DESKTOP`) spoof `ApplicationStreamingStore.getStreamerActiveStreamMetadata`; requires a voice channel with 1+ other person.
- **Activity quests** (`PLAY_ACTIVITY`) use the internal activity auth flow and send `/quests/{id}/heartbeat` every 20s.
- **Achievement quests** (`ACHIEVEMENT_IN_ACTIVITY`) run an OAuth flow against the quest's application to forge progress (toggle with `achievementBypass`).

---

## Fixed in this version

- `isCompletable()` is null-safe — a missing `quest.config` no longer crashes the enroll/queue loop.
- `doJob()` drops expired / non-completable quests instead of cycling them forever.
- `syncQueueFromStore()` prunes stale queue entries via `enrolledIds`.
- `startQuest()` drops quests with a missing/NaN `target` instead of looping forever.
- WATCH_VIDEO progress guards against NaN `secondsDone` / `enrolledAt`.
- New `pauseBetweenQuestsSeconds` and `retryCooldownMinutes` settings.
- Manual play takeover sends one heartbeat (no multi-variant probing) - the old burst earned HTTP 429s that starved the whole queue.
- HTTP 401 heartbeats park the quest with an honest reason: Discord requires proof a real game executable ran, so launch the actual game to finish those.

---

## Disclaimer

Automating Discord quests may violate Discord's Terms of Service and can result in quest-access or account restrictions. Use at your own risk.
