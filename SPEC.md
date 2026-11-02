# DisQuest - Specification

**Plugin name:** DisQuest (migrates from QuestAutocompleter via migratePluginSettings)
**Type:** Vencord userplugin, GPL-3.0-or-later, fork of Seramicx/discord-quest-autocompleter
**Files:** src/userplugins/disQuest/index.tsx (plugin logic), native.ts (VencordNative helper: discordsaysAuthorize)

## Purpose

Complete Discord quests automatically (videos, activities, achievements, game/stream spoofs) and expose state via local-only slash commands. Vesktop supported: VesktopNative counts as isApp alongside DiscordNative.

## Task types

| Task | Strategy |
|---|---|
| WATCH_VIDEO(_ON_MOBILE) | video-progress spoof, <= ~10 s ahead of real time; ~1 min |
| PLAY_ON_DESKTOP | fake game in RunningGameStore (full process shape, all accessors) |

| STREAM_ON_DESKTOP | spoofs getStreamerActiveStreamMetadata; must sit in a voice channel |
| PLAY_ACTIVITY | internal activity auth flow + heartbeat every 20 s |
| ACHIEVEMENT_IN_ACTIVITY | OAuth roundtrip via discordsaysAuthorize; snapshot-guarded, revokes only the quest app's own new grants |

Platform-gated quests never auto-enroll (no platform choice in the enroll call) - accept manually first.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| autoAcceptQuests | off | enroll one new completable quest per scan |

| fetchIntervalMinutes | 120 | quest-list fetch interval (min 30, enforced) |
| logProgress | on | console progress logs |
| achievementBypass | on | auto-complete achievement quests via OAuth |
| autoClaim | off | claim rewards (needs a captcha solver key) |

| retryCooldownMinutes | 10 | minutes before retrying a stalled quest |
| pauseBetweenQuestsSeconds | 3 | seconds between accepting quests |
| captchaService / captchaApiKey | nopecha / - | solver used only when autoClaim is on |

## Automation engine

- scan() every 60 s; one enroll loop at a time; queue processing runs every cycle.
- Any 429 pauses ALL enrolls until Discord's window passes (enrollBackoffUntil).

- FIFO queue with fast-quest priority (videos/activity/achievements before game/stream spoofs).
- Stuck-spoof watchdog: no beat for 150 s or 5 consecutive failures rotates the quest to the back; 3 strikes skips it.

- Deterministically-rejected play/stream quests park until restart; videos, activity, achievements and enroll keep running.

## Slash commands

Local-only replies, visible only to you: /disquest status (state, session stats, queue with progress, settings, active + parked quests), /disquest start, /disquest stop.

## Invariants / acceptance criteria

- One malformed quest must never abort the enroll loop or queue processing.
- Rotated quests must not corrupt the new active quest's watchdog counters or double-count completions.

- isCompletable is null-safe; quests with a missing/NaN target or expired config are dropped, not looped.
- syncQueueFromStore prunes queue entries no longer enrolled.

## Known limits

- Spoofed play/stream heartbeats can be refused server-side (HTTP 401, code 40001) under Vesktop; those quests park while video/activity/achievement quests keep running.

- Completed does not mean claimed: rewards are claimed via Discord's UI or autoClaim + captcha key.
- Automating quests is against Discord's ToS; not supported by Vencord maintainers; use at your own risk.

## Setup / install

See README.md (Install) and VESKTOP-SETUP.md for the local Vesktop + custom-Vencord-build setup, including the required dist/package.json validity marker and vencordDir wiring.
