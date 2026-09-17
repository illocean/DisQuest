/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { Link } from "@components/Link";
import { PluginNative } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import { find, findByCodeLazy } from "@webpack";
import { ApplicationStreamingStore, AuthenticationStore, ChannelStore, FluxDispatcher, Forms, GuildChannelStore, RestAPI, RunningGameStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.DisQuest as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    autoAcceptQuests: {
        type: OptionType.BOOLEAN,
        description: "Automatically accept all available quests",
        default: false,
        restartNeeded: false
    },
    fetchIntervalMinutes: {
        type: OptionType.SLIDER,
        description: "How often to ask Discord for new quests, in minutes (minimum 30)",
        markers: [30, 60, 120, 240, 360],
        stickToMarkers: false,
        default: 120,
        restartNeeded: false
    },
    logProgress: {
        type: OptionType.BOOLEAN,
        description: "Log quest completion progress to console",
        default: true,
        restartNeeded: false
    },
    achievementBypass: {
        type: OptionType.BOOLEAN,
        description: "Automatically complete achievement quests (the ones where you earn badges in an activity)",
        default: true,
        restartNeeded: false
    },
    autoClaim: {
        type: OptionType.BOOLEAN,
        description: "Automatically claim rewards after a quest completes. Requires a captcha solver key below",
        default: false,
        restartNeeded: false
    },
    captchaService: {
        type: OptionType.SELECT,
        description: "Captcha solver service used for claiming",
        options: [
            { label: "NopeCHA", value: "nopecha", default: true },
            { label: "CapSolver", value: "capsolver" },
            { label: "2Captcha", value: "twocaptcha" }
        ],
        disabled: () => !settings.store.autoClaim,
        restartNeeded: false
    },
    captchaApiKey: {
        type: OptionType.STRING,
        description: "API key for the captcha solver service",
        disabled: () => !settings.store.autoClaim,
        restartNeeded: false
    }
});

// pre-rename settings key migration (official helper: moves the whole object once)
migratePluginSettings("DisQuest", "QuestAutocompleter");

const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE", "ACHIEVEMENT_IN_ACTIVITY"];

const MIN_FETCH_MINUTES = 30;
const SCAN_INTERVAL_MS = 60_000;

const fetchQuests = findByCodeLazy("QUESTS_FETCH_CURRENT_QUESTS_BEGIN") as () => Promise<unknown>;

// displayName doesn't survive minification, so match on shape instead
let questsStore: any = null;
function getQuestsStore() {
    questsStore ??= find((m: any) => m?.quests instanceof Map && typeof m.getQuest === "function", { isIndirect: true });
    return questsStore;
}

let isApp: boolean;

let processingQuests = false;
// scan() fires every 60s; a slow enroll loop (rate-limit backoffs can sleep ~1h)
// must not let new loops pile up behind it - one enroll loop at a time, while
// queue processing below always runs every cycle
let acceptingQuests = false;
// global enroll backoff: any 429 pauses ALL enroll attempts until Discord's window passes
let enrollBackoffUntil = 0;
// watchdog: wall-clock start + timeout of the active quest; rotates a stuck spoof to the back
let activeStartedAt = 0;
let activeTimeoutMs = 25 * 60_000;
let activeBeatAt = 0;
let activeConsecFails = 0;
let manualPlay = false;
// quest id -> stall count (attempt number, for logging the FIFO rounds)
const stallCounts = new Map<string, number>();
const HEARTBEAT_SILENCE_MS = 150_000;
const MAX_HEARTBEAT_FAILS = 5;
const RETRY_COOLDOWN_FAIL = 30 * 60_000;
const RETRY_COOLDOWN_ROTATE = 10 * 60_000;
// quest id -> earliest retry timestamp; failed quests wait here while others run first
const retryAfter = new Map<string, number>();
let lastIdleLog = 0;
// deterministically-rejected play/stream quests wait here quietly until restart
const parkedQuests = new Set<string>();
// pause switch + session counters for the slash commands
let paused = false;
let completedCount = 0;
let enrolledCount = 0;
let sessionStartedAt = 0;
const BUILD_ID = "2026-09-17q (audit fixes)";
let questQueue: any[] = [];
let activeQuestId: string | null = null;
let activeCleanup: (() => void) | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let fetchInterval: ReturnType<typeof setInterval> | null = null;
let fluxUnsubs: (() => void)[] = [];

// async loops capture this and bail once it moves, otherwise they keep hitting the API after stop()
let generation = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function log(...args: any[]) {
    if (settings.store.logProgress) {
        console.log("[DisQuest]", ...args);
    }
}

// errors always surface, even with logProgress off - silent failures are worse than noise
function logError(...args: any[]) {
    console.error("[DisQuest]", ...args);
}

function getTaskConfig(quest: any) {
    return quest.config.taskConfig ?? quest.config.taskConfigV2;
}

function isCompletable(quest: any): boolean {
    if (new Date(quest.config.expiresAt).getTime() <= Date.now()) return false;
    const tasks = getTaskConfig(quest)?.tasks;
    if (!tasks) return false;
    return SUPPORTED_TASKS.some(t => tasks[t] != null);
}

function isEnrolled(quest: any): boolean {
    return !!quest.userStatus?.enrolledAt;
}

function isCompleted(quest: any): boolean {
    return !!quest.userStatus?.completedAt;
}

// queued entries go stale while a long quest runs, so re-read before use
function refreshQuest(quest: any) {
    return getQuestsStore()?.quests?.get(quest.id) ?? quest;
}

// Per-quest enroll cooldowns (quest id -> resume timestamp ms). A 429 parks only
// that quest until Discord's retry window passes instead of sleeping the loop.
const enrollCooldowns = new Map<string, number>();

// single attempt per call by design: per-quest cooldowns + the 60s scan cycle
// already provide the retry semantics, and in-loop sleeping caused the old pile-ups
async function enrollQuest(quest: any): Promise<boolean> {
    const name = quest.config.messages.questName;
    const cooledUntil = enrollCooldowns.get(quest.id);
    if (cooledUntil && cooledUntil > Date.now())
        return false; // still cooling down - retried automatically next cycle
    try {
        const res = await RestAPI.post({
            url: `/quests/${quest.id}/enroll`,
            body: {
                location: 11,
                is_targeted: false,
                metadata_raw: null,
                metadata_sealed: null,
                traffic_metadata_raw: null
            }
        });
        if (res?.status === 429) {
            const waitMs = ((res.body?.retry_after ?? 5) + 1) * 1000;
            enrollCooldowns.set(quest.id, Date.now() + waitMs);
            enrollBackoffUntil = Math.max(enrollBackoffUntil, Date.now() + waitMs);
            log(`Rate limited on "${name}" - cooling down ${Math.ceil(waitMs / 1000)}s, moving on...`);
            return false;
        }
        enrollCooldowns.delete(quest.id);
        enrolledCount++;
        log(`Auto-accepted: ${name}`);
        return true;
    } catch (e: any) {
        const status: number = e?.status ?? e?.res?.status ?? 0;
        const body: any      = e?.body   ?? e?.res?.body   ?? {};
        if (status === 429) {
            const waitMs = ((body?.retry_after ?? 5) + 1) * 1000;
            enrollCooldowns.set(quest.id, Date.now() + waitMs);
            enrollBackoffUntil = Math.max(enrollBackoffUntil, Date.now() + waitMs);
            log(`Rate limited on "${name}" - cooling down ${Math.ceil(waitMs / 1000)}s, moving on...`);
            return false;
        }
        log(`Failed to accept "${name}" (status ${status}):`, body?.message ?? e);
        return false;
    }
}

async function autoAcceptAvailableQuests(): Promise<boolean> {
    if (!settings.store.autoAcceptQuests) return false;
    if (Date.now() < enrollBackoffUntil) return false; // global 429 backoff - silent, retried next cycle
    const store = getQuestsStore();
    if (!store?.quests) return false;

    const unaccepted = [...store.quests.values()].filter((q: any) =>
        !isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );

    if (unaccepted.length === 0) return false;

    log(`Auto-accepting ${unaccepted.length} quest(s)...`);
    let enrolledAny = false;

    for (const q of unaccepted) {
        if (Date.now() < enrollBackoffUntil) break; // a 429 this loop paused the rest
        try {
            const ok = await enrollQuest(q);
            if (ok) { enrolledAny = true; break; } // one enroll per scan - Discord escalates on bursts
        } catch (e) {
            // one malformed quest must not abort the whole enroll loop
            log(`Enroll error on "${q?.config?.messages?.questName ?? q?.id}":`, e);
        }
        await sleep(3000);
    }

    return enrolledAny;
}

// fast quests first: videos finish in ~1 min, game/stream spoofs take the full
// quest time and would otherwise starve everything queued behind them
const TASK_PRIORITY: Record<string, number> = {
    WATCH_VIDEO: 0,
    WATCH_VIDEO_ON_MOBILE: 0,
    PLAY_ACTIVITY: 1,
    ACHIEVEMENT_IN_ACTIVITY: 1,
    STREAM_ON_DESKTOP: 2,
    PLAY_ON_DESKTOP: 3
};

function questPriority(quest: any): number {
    try {
        const tasks = getTaskConfig(quest)?.tasks ?? {};
        const name = SUPPORTED_TASKS.find(t => tasks[t] != null);
        return name != null ? (TASK_PRIORITY[name] ?? 9) : 9;
    } catch {
        return 9;
    }
}

function syncQueueFromStore() {
    const store = getQuestsStore();
    if (!store?.quests) return;

    const enrolled = [...store.quests.values()].filter((q: any) =>
        isEnrolled(q) && !isCompleted(q) && isCompletable(q) && !parkedQuests.has(q.id)
    );

    let added = 0;
    for (const quest of enrolled) {
        if (quest.id === activeQuestId) continue;
        if (!questQueue.find(q => q.id === quest.id)) {
            questQueue.push(quest);
            added++;
            log(`Queued: ${quest.config.messages.questName}`);
        }
    }

    questQueue.sort((a, b) => questPriority(a) - questPriority(b));

    if (added > 0) log(`${added} quest(s) added to queue (total: ${questQueue.length})`);

    if (!processingQuests && questQueue.length > 0) {
        log("Starting processing loop...");
        doJob();
    }
}

// a game/stream spoof only finishes when Discord's heartbeats say so - if they
// never come, the whole queue stalls behind it. Rotate it to the back so the
// rest keep moving; server-side progress is kept, so it resumes where it left off.
// (video/activity loops drive themselves and always terminate, so only
// cleanup-holding spoofs are eligible.)
// FIFO rotation: a failed quest goes to the back with a retry cooldown so other
// quests always run first; deterministically-rejected quests park until restart.
// Server-side progress is kept either way.
function stallActiveQuest(reason: string, cooldownMs = RETRY_COOLDOWN_ROTATE, park = false) {
    const id = activeQuestId;
    const q = id ? getQuestsStore()?.quests?.get(id) : null;
    const name = q?.config?.messages?.questName ?? id ?? "quest";
    const stalls = (stallCounts.get(id!) ?? 0) + 1;
    stallCounts.set(id!, stalls);
    try {
        if (q && isEnrolled(q) && !isCompleted(q)) {
            if (park && id) {
                parkedQuests.add(id);
                log(`"${name}" parked until restart (${reason}) - videos/achievements carry on`);
            } else {
                if (id) retryAfter.set(id, Date.now() + cooldownMs);
                if (!questQueue.find(x => x.id === q.id)) questQueue.push(q);
                log(`"${name}" stalled (${reason}) - to back of queue (attempt ${stalls}), others first`);
            }
        } else {
            log(`"${name}" no longer active (${reason}) - dropping`);
        }
    } catch (e) {
        log("Watchdog requeue failed:", e);
    }
    activeCleanup?.();
    activeCleanup = null;
    activeQuestId = null;
    activeStartedAt = 0;
    activeBeatAt = 0;
    activeConsecFails = 0;
    processingQuests = false;
    doJob();
}

function rotateStuckActive() {
    if (!activeQuestId || !activeStartedAt) return;
    if (activeCleanup == null) return;
    // Discord beats about every 60s; 150s of total silence (no success AND no
    // failure) means it is not driving this quest at all
    const silentMs = activeBeatAt ? Date.now() - activeBeatAt : Date.now() - activeStartedAt;
    if (silentMs >= HEARTBEAT_SILENCE_MS) {
        stallActiveQuest("no heartbeat from Discord - not accepting the injected process");
        return;
    }
    if (Date.now() - activeStartedAt >= activeTimeoutMs)
        stallActiveQuest(`no completion after ${Math.round(activeTimeoutMs / 60000)} min`);
}

async function scan() {
    if (paused) return; // /disquest stop freezes all automation until /disquest start
    let newlyEnrolled = false;
    if (!acceptingQuests) {
        acceptingQuests = true;
        try {
            newlyEnrolled = await autoAcceptAvailableQuests();
        } catch (err) {
            logError("Enroll loop failed - continuing to queue", err);
        } finally {
            acceptingQuests = false;
        }
    }
    if (newlyEnrolled) await sleep(1500);
    rotateStuckActive();
    try {
        syncQueueFromStore();
        await claimCompletedQuests();
    } catch (err) {
        logError("Queue/claim pass failed - next cycle retries", err);
    }
}

// one claim attempt per quest per session (cleared on restart); keeps us off Discord's radar
const claimFailed = new Set<string>();
let claiming = false;

async function claimCompletedQuests() {
    if (!settings.store.autoClaim) return;
    if (!settings.store.captchaApiKey) return;
    if (claiming) return;
    const store = getQuestsStore();
    if (!store?.quests) return;

    const unclaimed = [...store.quests.values()].filter((q: any) =>
        isCompleted(q)
        && !q.userStatus?.claimedAt
        && !claimFailed.has(q.id)
        && getTaskConfig(q)?.tasks != null
    );
    if (unclaimed.length === 0) return;

    claiming = true;
    // stop() bumps generation mid-loop, so snapshot now and bail if it moves
    const myGen = generation;
    try {
        for (const quest of unclaimed) {
            if (myGen !== generation) break;
            try {
                await claimReward(quest);
            } catch (e: any) {
                log(`Failed to claim "${quest.config.messages.questName}":`, e?.message ?? e);
                // one shot per quest per session
                claimFailed.add(quest.id);
            }
            await sleep(Math.floor(Math.random() * 5000) + 8000);
        }
    } finally {
        claiming = false;
    }
}

async function claimReward(quest: any) {
    const questName = quest.config.messages.questName;

    // user token straight off the auth store; Discord's RestAPI would intercept the
    // 403 challenge and pop its own captcha modal, so the claim goes via main instead
    const attemptClaim = (captchaToken?: string) => Native.claimReward({
        userToken: (AuthenticationStore as any).getToken(),
        questId: quest.id,
        captchaToken,
        trafficMetadataSealed: quest.userStatus?.trafficMetadataSealed ?? null
    });

    log(`Claiming reward for "${questName}"...`);
    let res = await attemptClaim();

    if (!res.ok && res.body?.captcha_sitekey) {
        log(`Solving hCaptcha for "${questName}"...`);
        const solved = await Native.solveCaptcha({
            service: settings.store.captchaService,
            apiKey: settings.store.captchaApiKey,
            websiteUrl: "https://discord.com/",
            siteKey: res.body.captcha_sitekey
        });
        res = await attemptClaim(solved.token);
    }

    if (res.body?.claimed_at == null) {
        throw new Error(res.ok ? "no claimed_at in response" : `status ${res.status}: ${res.body?.message ?? JSON.stringify(res.body)?.slice(0, 120)}`);
    }

    log(`Claimed reward: ${questName}`);
}

async function fetchNewQuests() {
    try {
        log("Checking for new quests...");
        await fetchQuests();
        await sleep(1000);
    } catch (e) {
        log("Quest fetch failed (will retry next cycle):", e);
        return;
    }
    await scan();
}

function shutdown() {
    generation++;

    activeCleanup?.();
    activeCleanup = null;
    activeQuestId = null;
    activeStartedAt = 0;
    activeBeatAt = 0;
    activeConsecFails = 0;
    processingQuests = false;
    completedCount = 0;
    enrolledCount = 0;
    lastIdleLog = 0;
    questQueue = [];
    retryAfter.clear();
    stallCounts.clear();
    parkedQuests.clear();
    claimFailed.clear();

    if (pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (fetchInterval !== null) {
        clearInterval(fetchInterval);
        fetchInterval = null;
    }
}

function startSession() {
    shutdown();

    // DiscordNative only exists in the official desktop app; Vesktop exposes
    // VesktopNative instead (it never defines DiscordNative), so accept either -
    // otherwise game/stream quests are always skipped under Vesktop
    isApp = typeof (window as any).DiscordNative !== "undefined"
        || typeof (window as any).VesktopNative !== "undefined";

    const minutes = Math.max(MIN_FETCH_MINUTES, settings.store.fetchIntervalMinutes ?? 120);
    pollInterval = setInterval(() => scan(), SCAN_INTERVAL_MS);
    fetchInterval = setInterval(() => fetchNewQuests(), minutes * 60_000);
    log(`DisQuest ${BUILD_ID}`);
    log(`Session started (isApp = ${isApp}, checking for new quests every ${minutes} min)`);

    sessionStartedAt = Date.now();
    fetchNewQuests();
}

function doJob() {
    activeCleanup?.();
    activeCleanup = null;
    activeQuestId = null;
    activeStartedAt = 0;
    if (paused) { processingQuests = false; return; }

    // FIFO with cooldowns: cooling quests cycle to the back, first eligible runs
    let queued: any = null;
    const waiting = questQueue.length;
    for (let i = 0; i < waiting; i++) {
        const q = questQueue.shift();
        if ((retryAfter.get(q.id) ?? 0) > Date.now()) { questQueue.push(q); continue; }
        queued = q;
        break;
    }
    if (!queued) {
        processingQuests = false;
        activeQuestId = null;
        activeStartedAt = 0;
        if (questQueue.length === 0) {
            log("All queued quests done.");
        } else if (Date.now() - lastIdleLog > 5 * 60_000) {
            lastIdleLog = Date.now();
            log("All remaining quests are cooling down - retrying automatically");
        }
        return;
    }

    const quest = refreshQuest(queued);
    if (isCompleted(quest)) {
        doJob();
        return;
    }

    processingQuests = true;
    activeQuestId = quest.id;
    activeStartedAt = Date.now();
    activeBeatAt = Date.now();
    activeConsecFails = 0;
    manualPlay = false;
    activeTimeoutMs = 25 * 60_000;
    try {
        const tasks = getTaskConfig(quest)?.tasks ?? {};
        const tName = SUPPORTED_TASKS.find(t => tasks[t] != null);
        const target = tName != null ? Number(tasks[tName]?.target) : NaN;
        if (Number.isFinite(target) && target > 0)
            activeTimeoutMs = Math.max(25 * 60_000, (target + 600) * 1000);
    } catch { /* keep default timeout */ }

    try {
        startQuest(quest);
    } catch (e) {
        log(`Failed to start "${quest.config.messages?.questName}":`, e);
        doJob();
    }
}

// achievement quests ignore plain heartbeat spoofing until discord thinks the activity itself authorized us,
// which is what this oauth roundtrip fakes; grants created along the way get revoked at the end
async function bypassAchievement(quest: any, applicationId: string, myGen: number): Promise<boolean> {
    const questName = quest.config.messages.questName;
    const target = getTaskConfig(quest)?.tasks?.ACHIEVEMENT_IN_ACTIVITY?.target ?? 0;
    if (target <= 0) throw new Error("no ACHIEVEMENT_IN_ACTIVITY target on this quest");

    // snapshot is a precondition, not best-effort: without it the cleanup below cannot tell
    // our grants apart, so a failed snapshot aborts before anything is authorized
    const beforeIds = new Set<string>();
    let snapshotOk = false;
    try {
        const res = await RestAPI.get({ url: "/oauth2/tokens" });
        for (const g of res.body ?? []) {
            if (g?.application?.id === applicationId) beforeIds.add(g.id);
        }
        snapshotOk = true;
    } catch { }
    if (!snapshotOk) throw new Error("could not snapshot existing OAuth grants - aborting before authorization");

    try {
        const authRes = await RestAPI.post({
            url: "/oauth2/authorize",
            query: {
                response_type: "code",
                client_id: applicationId,
                scope: "identify applications.commands applications.entitlements"
            },
            body: {
                permissions: "0",
                authorize: true,
                integration_type: 1,
                location_context: {
                    guild_id: "10000",
                    channel_id: "10000",
                    channel_type: 10000
                }
            }
        });

        const location = authRes.body?.location;
        const code = location ? new URL(location).searchParams.get("code") : null;
        if (!code) throw new Error(`no code in authorize response (${JSON.stringify(authRes.body)?.slice(0, 120)})`);

        const ticketRes = await RestAPI.post({
            url: `/applications/${applicationId}/proxy-tickets`,
            body: {}
        });
        const ticket = ticketRes.body?.ticket;
        if (!ticket) throw new Error("no proxy ticket");

        const referrer = `https://${applicationId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${ticket}`;
        const acfAuth = await Native.discordsaysAuthorize({ appId: applicationId, questId: quest.id, referrer, code });
        if (!acfAuth.ok || !acfAuth.body?.token) throw new Error(`acf authorize failed (status ${acfAuth.status})`);

        // walk progress up over real time instead of jumping to target, so completion takes as long as playing would
        let done = 0;
        log(`Bypassing achievement: ${questName} - ~${Math.ceil(target / 60)} min left`);
        while (done < target && myGen === generation && !paused) {
            done = Math.min(target, done + Math.floor(Math.random() * 20) + 30);
            const progressRes = await Native.discordsaysProgress({
                appId: applicationId,
                questId: quest.id,
                referrer,
                token: acfAuth.body.token,
                progress: done
            });
            if (!progressRes.ok) throw new Error(`acf progress failed (status ${progressRes.status}): ${JSON.stringify(progressRes.body)?.slice(0, 120)}`);
            log(`[${questName}] Progress: ${done}/${target} - ~${Math.ceil((target - done) / 60)} min left`);
            if (done < target) await sleep(Math.floor(Math.random() * 4000) + 18000);
        }

        if (myGen !== generation || paused) return false;

        completedCount++;
        log(`Completed via bypass: ${questName}`);
        return true;
    } catch (e: any) {
        log(`Bypass failed for "${questName}":`, e?.message ?? e);
        return false;
    } finally {
        // revoke whatever grants this run created - only when the snapshot lets us tell
        // ours apart, and only for this quest's app; unknown shapes are never touched
        if (!snapshotOk) {
            log(`Skipping OAuth cleanup for "${questName}" - no pre-authorization snapshot, refusing to touch unconfirmed state`);
        } else {
            try {
                const after = await RestAPI.get({ url: "/oauth2/tokens" });
                for (const g of after.body ?? []) {
                    if (g?.application?.id !== applicationId) continue;
                    if (!beforeIds.has(g.id)) RestAPI.del({ url: `/oauth2/tokens/${g.id}` }).catch(() => { });
                }
            } catch { }
        }
    }
}

// Last resort for PLAY quests whose automatic heartbeats Discord rejects (HTTP 401):
// beat the endpoint ourselves on Discord's own ~60s cadence. Real-world clients do
// exactly this (roxy-plus runs play quests on {application_id, terminal} every 30s;
// Orion's ACTIVITY path posts the same shape plus stream_key; console scripts drive the
// internal QuestActions heartbeat as {questId, applicationId, streamKey: null}). Runs only
// after the native path proves deterministically rejected; probes each evidenced body
// variant once and stops at the first accept, otherwise the quest rotates as before.
async function manualPlayTakeover(quest: any, questName: string, applicationId: string, taskName: string, secondsNeeded: number, myGen: number) {
    const qid = quest.id;
    const variants: Array<{ label: string; extra: any }> = [
        { label: "application_id", extra: {} },
        { label: "application_id+stream_key", extra: { stream_key: null } },
    ];
    const beat = async (terminal: boolean, extra: any) => RestAPI.post({
        url: `/quests/${qid}/heartbeat`,
        body: { application_id: applicationId, terminal, ...extra }
    });

    const readProgress = (b: any): number | undefined => {
        try {
            const v = b?.progress?.[taskName]?.value
                ?? b?.user_status?.progress?.[taskName]?.value
                ?? b?.userStatus?.progress?.[taskName]?.value;
            if (typeof v === "number") return v;
            if (quest.config.configVersion === 1) {
                const s = b?.stream_progress_seconds ?? b?.streamProgressSeconds
                    ?? b?.user_status?.stream_progress_seconds ?? b?.userStatus?.streamProgressSeconds;
                if (typeof s === "number") return Math.floor(s);
            }
        } catch { /* ignore */ }
        return undefined;
    };

    // probe: one beat per evidenced body variant; first accept wins, all rejected = rotate
    let first: any = null;
    let acceptedExtra: any = null;
    let probeError = "?";
    for (const v of variants) {
        if (myGen !== generation || activeQuestId !== qid) return; // rotated away - the new quest owns the watchdog now
        try {
            const res = await beat(false, v.extra);
            if (res && (res.status == null || res.status < 400)) {
                first = res;
                acceptedExtra = v.extra;
                break;
            }
            probeError = `HTTP ${res?.status ?? "?"} (${v.label})`;
        } catch (e: any) {
            probeError = `HTTP ${e?.status ?? e?.res?.status ?? "?"} (${v.label})`;
        }
    }
    if (myGen !== generation || activeQuestId !== qid) return;
    if (!first) {
        stallActiveQuest(`manual heartbeat probes rejected (${probeError})`, RETRY_COOLDOWN_FAIL, true);
        return;
    }

    log(`[${questName}] Manual heartbeat accepted - driving progress directly (native beats rejected)`);
    try { log(`[${questName}] Heartbeat response fields:`, Object.keys(first?.body ?? {}).join(", ")); } catch { /* ignore */ }

    let beats = 0;
    while (myGen === generation && !paused && activeQuestId === qid) {
        beats++;
        let progress: number | undefined;
        try {
            const res = await beat(false, acceptedExtra);
            if (!res || (res.status != null && res.status >= 400)) throw new Error(`HTTP ${res?.status ?? "?"}`);
            progress = readProgress(res.body);
            activeBeatAt = Date.now();
        } catch (e: any) {
            if (myGen !== generation || activeQuestId !== qid) return;
            stallActiveQuest(`manual heartbeat failed (${e?.message ?? e})`);
            return;
        }
        if (progress != null) log(`[${questName}] Progress: ${progress}/${secondsNeeded} (manual)`);
        else if (beats === 1 || beats % 5 === 0) log(`[${questName}] Manual beat ${beats} (progress field unreadable - still trying)`);
        if (progress != null && progress >= secondsNeeded) {
            try { await beat(true, acceptedExtra); } catch { /* ignore terminal errors */ }
            if (myGen !== generation || activeQuestId !== qid) return;
            completedCount++;
            log(`Completed: ${questName}`);
            doJob();
            return;
        }
        await sleep(60000);
    }
}

function startQuest(quest: any) {
    const myGen           = generation;
    const pid             = Math.floor(Math.random() * 30000) + 1000;
    const questName       = quest.config.messages.questName;
    const taskConfig      = getTaskConfig(quest);
    const taskName        = taskConfig?.tasks ? SUPPORTED_TASKS.find(x => taskConfig.tasks[x] != null) : undefined;
    if (taskName == null || taskConfig?.tasks == null) {
        log(`"${questName}" has no supported task anymore - dropping`);
        doJob();
        return;
    }
    const taskData        = taskConfig.tasks[taskName];
    const applicationId   = quest.config.application?.id ?? taskData.applications?.[0]?.id;
    const applicationName = quest.config.application?.name ?? taskData.applications?.[0]?.name ?? questName;
    const secondsNeeded   = taskData.target;
    let secondsDone       = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
        const maxFuture = 10, speed = 7, interval = 1;
        const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
        let completed = false;

        (async () => {
            try {
                while (myGen === generation && !paused) {
                    const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                    const diff = maxAllowed - secondsDone;
                    const timestamp = secondsDone + speed;

                    if (diff >= speed) {
                        const res = await RestAPI.post({
                            url: `/quests/${quest.id}/video-progress`,
                            body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                        });
                        completed = res.body?.completed_at != null;
                        secondsDone = Math.min(secondsNeeded, timestamp);
                    }

                    if (timestamp >= secondsNeeded) break;
                    await sleep(interval * 1000);
                }

                if (myGen !== generation || paused) return;

                if (!completed) {
                    await RestAPI.post({
                        url: `/quests/${quest.id}/video-progress`,
                        body: { timestamp: secondsNeeded }
                    });
                }

                completedCount++;
                log(`Completed: ${questName}`);
            } catch (e) {
                // parity with the desktop branches: requeue with cooldown instead of
                // dropping silently (sync would re-add it next scan with no cooldown)
                if (myGen !== generation) return;
                stallActiveQuest(`activity error: ${e?.message ?? e}`);
                return;
            }
            if (myGen === generation) doJob();
        })();

        log(`Spoofing video: ${questName}`);

    } else if (taskName === "PLAY_ON_DESKTOP") {
        if (!isApp) {
            log(`${questName} requires the desktop app - skipping`);
            doJob();
            return;
        }

        RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` })
            .then((res: any) => {
                if (myGen !== generation) return;

                const appData = res.body?.[0];

                if (!appData) {
                    log(`No app data returned for "${questName}" - skipping`);
                    doJob();
                    return;
                }

                const win32Exe = appData.executables?.find((x: any) => x.os === "win32");
                const anyExe   = appData.executables?.[0];
                const exeName  = (win32Exe ?? anyExe)?.name?.replace(">", "") ?? `${appData.name}.exe`;

                const fakeGame: any = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                    exeName,
                    exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                    hidden: false,
                    isLauncher: false,
                    id: applicationId,
                    name: appData.name,
                    pid,
                    pidPath: [pid],
                    processName: appData.name,
                    start: Date.now(),
                    // extra shape newer Discord builds read; missing fields can make
                    // the heartbeat sender ignore the injected process entirely
                    icon: appData.icon,
                    executables: [{ os: "win32", name: exeName, is_launcher: false }],
                    windowHandle: 0,
                    fullscreenType: 0,
                    overlay: true,
                    sandboxed: false,
                };

                const realGames = RunningGameStore.getRunningGames();
                // Discord's heartbeat sender may read any of these; patch every one
                // that exists so the injected process is visible whichever it uses
                const gameMethods = ["getRunningGames", "getGameForPID", "getVisibleGame", "getVisibleRunningGames", "getRunningDiscordApplicationIds", "getCandidateGames"];
                const realGameMethods: Record<string, any> = {};
                for (const m of gameMethods) {
                    try {
                        if (typeof RunningGameStore[m] === "function") realGameMethods[m] = RunningGameStore[m];
                    } catch { /* ignore */ }
                }

                let done = false;
                const cleanup = () => {
                    if (done) return;
                    done = true;
                    for (const m of Object.keys(realGameMethods)) {
                        try { RunningGameStore[m] = realGameMethods[m]; } catch { /* ignore */ }
                    }
                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFail);
                };

                RunningGameStore.getRunningGames = () => [fakeGame];
                RunningGameStore.getGameForPID   = (p: number) => (p === fakeGame.pid ? fakeGame : null);
                if (realGameMethods.getVisibleGame) RunningGameStore.getVisibleGame = () => fakeGame;
                if (realGameMethods.getVisibleRunningGames) RunningGameStore.getVisibleRunningGames = () => [fakeGame];
                if (realGameMethods.getRunningDiscordApplicationIds) RunningGameStore.getRunningDiscordApplicationIds = () => [applicationId];
                if (realGameMethods.getCandidateGames) RunningGameStore.getCandidateGames = () => [fakeGame];
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });

                const fn = (data: any) => {
                    if (data.questId !== quest.id) return;
                    if (activeQuestId !== quest.id) return; // stale beat from a rotated quest - never touch the new one
                    activeBeatAt = Date.now();
                    activeConsecFails = 0;
                    stallCounts.delete(quest.id);

                    try {
                        const progress = quest.config.configVersion === 1
                            ? data.userStatus.streamProgressSeconds
                            : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);

                        log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                        if (progress >= secondsNeeded) {
                            completedCount++;
                            log(`Completed: ${questName}`);
                            doJob();
                        }
                    } catch (e) {
                        log(`Error in heartbeat handler for "${questName}":`, e);
                        doJob();
                    }
                };

                // Discord also dispatches failures; without this a rejected heartbeat
                // is invisible and the quest just sits silent
                const onFail = (data: any) => {
                    if (data?.questId !== quest.id) return;
                    if (myGen !== generation) return;
                    if (activeQuestId !== quest.id) return; // stale failure from a rotated quest
                    try {
                        const e = data?.error ?? data;
                        const status = e?.status ?? e?.httpStatus;
                        const code = e?.body?.code ?? e?.code;
                        const msg = e?.body?.message ?? e?.message;
                        const detail = [
                            status != null ? `HTTP ${status}` : null,
                            code != null && code !== status ? `code ${code}` : null,
                            msg ? String(msg) : null
                        ].filter(Boolean).join(", ") || "no detail";
                        activeBeatAt = Date.now();
                        activeConsecFails++;
                        if (activeConsecFails === 1) {
                            try { log(`[${questName}] Heartbeat failure detail:`, JSON.stringify(data?.error ?? data)?.slice(0, 300)); } catch { /* ignore */ }
                        }
                        log(`[${questName}] Heartbeat failed (${activeConsecFails}/${MAX_HEARTBEAT_FAILS}): ${detail}`);
                        // 401/403/400-class rejections are deterministic (same token works
                        // everywhere else), so skip fast; 429/5xx stay on the patient path
                        const retryable = status == null || status === 408 || status === 429 || status >= 500;
                        if (manualPlay) return; // manual takeover owns the quest now
                        if (!retryable && activeConsecFails >= 2) {
                            manualPlay = true;
                            log(`[${questName}] Native beats deterministically rejected - probing manual heartbeat...`);
                            void manualPlayTakeover(quest, questName, applicationId, taskName, secondsNeeded, myGen);
                            return;
                        }
                        if (activeConsecFails >= MAX_HEARTBEAT_FAILS) stallActiveQuest("Discord keeps rejecting the heartbeat");
                    } catch (err) {
                        log(`Error in heartbeat failure handler for "${questName}":`, err);
                    }
                };

                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFail);
                activeCleanup = cleanup;
                activeBeatAt = Date.now();
                log(`Spoofed game: ${applicationName} - ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left`);
            })
            .catch((e: any) => {
                if (myGen !== generation) return;
                log(`Failed to fetch app data for "${questName}":`, e);
                doJob();
            });

    } else if (taskName === "STREAM_ON_DESKTOP") {
        if (!isApp) {
            log(`${questName} requires the desktop app - skipping`);
            doJob();
            return;
        }

        const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;

        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFail);
        };

        ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
            id: applicationId,
            pid,
            sourceName: null
        });

        const fn = (data: any) => {
            if (data.questId !== quest.id) return;
            if (activeQuestId !== quest.id) return; // stale beat from a rotated quest - never touch the new one
            activeBeatAt = Date.now();
            activeConsecFails = 0;
            stallCounts.delete(quest.id);

            try {
                const progress = quest.config.configVersion === 1
                    ? data.userStatus.streamProgressSeconds
                    : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);

                log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                if (progress >= secondsNeeded) {
                    completedCount++;
                    log(`Completed: ${questName}`);
                    doJob();
                }
            } catch (e) {
                log(`Error in heartbeat handler for "${questName}":`, e);
                doJob();
            }
        };

        const onFail = (data: any) => {
            if (data?.questId !== quest.id) return;
            if (myGen !== generation) return;
            if (activeQuestId !== quest.id) return; // stale failure from a rotated quest
            try {
                const e = data?.error ?? data;
                const status = e?.status ?? e?.httpStatus;
                const code = e?.body?.code ?? e?.code;
                const msg = e?.body?.message ?? e?.message;
                const detail = [
                    status != null ? `HTTP ${status}` : null,
                    code != null && code !== status ? `code ${code}` : null,
                    msg ? String(msg) : null
                ].filter(Boolean).join(", ") || "no detail";
                activeBeatAt = Date.now();
                activeConsecFails++;
                if (activeConsecFails === 1) {
                    try { log(`[${questName}] Heartbeat failure detail:`, JSON.stringify(data?.error ?? data)?.slice(0, 300)); } catch { /* ignore */ }
                }
                log(`[${questName}] Heartbeat failed (${activeConsecFails}/${MAX_HEARTBEAT_FAILS}): ${detail}`);
                const retryable = status == null || status === 408 || status === 429 || status >= 500;
                if (!retryable && activeConsecFails >= 2) {
                    stallActiveQuest(`Discord rejects this quest's heartbeat (${detail}) - not retryable`, RETRY_COOLDOWN_FAIL, true);
                    return;
                }
                if (activeConsecFails >= MAX_HEARTBEAT_FAILS) stallActiveQuest("Discord keeps rejecting the heartbeat");
            } catch (err) {
                log(`Error in heartbeat failure handler for "${questName}":`, err);
            }
        };

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFail);
        activeCleanup = cleanup;
        activeBeatAt = Date.now();
        log(`Spoofed stream: ${applicationName} - ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left (need 1+ in VC)`);

    } else if (taskName === "PLAY_ACTIVITY") {
        const channelId =
            ChannelStore.getSortedPrivateChannels()[0]?.id ??
            (Object.values(GuildChannelStore.getAllGuilds()) as any[])
                .find((x: any) => x?.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;

        if (!channelId) {
            log("No suitable channel found for PLAY_ACTIVITY - skipping");
            doJob();
            return;
        }

        const streamKey = `call:${channelId}:1`;

        (async () => {
            try {
                log(`Activity: ${questName}`);
                while (myGen === generation && !paused) {
                    const res = await RestAPI.post({
                        url: `/quests/${quest.id}/heartbeat`,
                        body: { stream_key: streamKey, terminal: false }
                    });
                    const progress = res.body?.progress?.PLAY_ACTIVITY?.value;
                    if (typeof progress !== "number") throw new Error("unexpected heartbeat response shape");
                    log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                    if (progress >= secondsNeeded) {
                        await RestAPI.post({
                            url: `/quests/${quest.id}/heartbeat`,
                            body: { stream_key: streamKey, terminal: true }
                        });
                        break;
                    }

                        await sleep(20000);
                }
                if (myGen !== generation || paused) return;
                completedCount++;
                log(`Completed: ${questName}`);
            } catch (e) {
                log(`Error completing "${questName}":`, e);
            }
            if (myGen === generation) doJob();
        })();
    } else if (taskName === "ACHIEVEMENT_IN_ACTIVITY") {
        // heartbeats are always rejected here without a real activity session, so straight to the oauth bypass
        (async () => {
            if (settings.store.achievementBypass) {
                try {
                    await bypassAchievement(quest, applicationId, myGen);
                } catch (e) {
                    log(`Error bypassing "${questName}":`, e);
                }
            } else {
                log(`Skipped "${questName}" - achievement bypass is disabled in settings`);
            }
            if (myGen === generation) doJob();
        })();
    }
}

function questShortName(q: any): string {
    try {
        return q?.config?.messages?.questName ?? q?.id ?? "unknown quest";
    } catch {
        return "unknown quest";
    }
}

function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function questProgressText(q: any): string {
    try {
        const tasks = getTaskConfig(q)?.tasks ?? {};
        const t = SUPPORTED_TASKS.find(x => tasks[x] != null);
        const target = t ? Number(tasks[t]?.target) : NaN;
        const v = q?.userStatus?.progress?.[t]?.value;
        if (t && Number.isFinite(target) && typeof v === "number") return `${Math.floor(v)}/${target}`;
    } catch { /* ignore */ }
    return "progress unknown";
}

// ── /disquest message panels ──
// Fixed-width ┌─ boxes in a monospace ```txt fence. Content rows never exceed
// BOX_W chars; long quest names word-wrap onto │-indented continuation lines.
const BOX_W = 41;

function boxTop(title: string): string {
    return `┌─ ${title} ` + "─".repeat(BOX_W - title.length - 4);
}

function boxBot(): string {
    return "└" + "─".repeat(BOX_W - 1);
}

function box(title: string, rows: string[]): string {
    return [boxTop(title), ...rows, boxBot()].join("\n");
}

function fence(parts: string[]): string {
    return "```txt\n" + parts.join("\n\n") + "\n```";
}

// quest names come from Discord and can contain newlines/backticks that would
// break the box rows — collapse them to single spaces
function cleanName(s: string): string {
    return s.replace(/[`\s]+/g, " ").trim();
}

// greedy word-wrap; the first line gets firstW chars, continuations contW.
// overlong words are hard-cut so no row ever exceeds the box.
function wrapLines(text: string, firstW: number, contW: number): string[] {
    const words = cleanName(text).split(" ").filter(w => w.length > 0);
    const lines: string[] = [];
    let cur = "";
    let cap = firstW;
    const flush = () => { if (cur) { lines.push(cur); cur = ""; cap = contW; } };
    for (let w of words) {
        while (w.length > contW) {
            if (cur) {
                const room = cap - cur.length - 1;
                if (room > 0) { cur += " " + w.slice(0, room); w = w.slice(room); }
                flush();
            } else {
                lines.push(w.slice(0, cap));
                w = w.slice(cap);
                cap = contW;
            }
        }
        if ((cur ? cur.length + 1 + w.length : w.length) > cap) flush();
        cur = cur ? cur + " " + w : w;
    }
    flush();
    return lines.length ? lines : [""];
}

// "│ label    value" with wrapped continuations aligned under the value
function kv(label: string, value: string, w: number): string[] {
    const pre = `│ ${label.padEnd(w)} `;
    const cont = `│ ${" ".repeat(w + 1)}`;
    return wrapLines(value, BOX_W - pre.length, BOX_W - cont.length)
        .map((t, i) => (i === 0 ? pre : cont) + t);
}

// ACTIVE box rows: ▸ active quest, then numbered queue, each followed by an
// aligned progress row and separated by bare │ rows
function activeRows(shown: any[]): string[] {
    const rows: string[] = [];
    if (activeQuestId) {
        const aq = getQuestsStore()?.quests?.get(activeQuestId);
        const name = wrapLines(questShortName(aq), BOX_W - 4, BOX_W - 3);
        rows.push(`│ ▸ ${name[0]}`);
        name.slice(1).forEach(t => rows.push(`│   ${t}`));
        rows.push(`│   ${aq ? questProgressText(aq) : "progress unknown"}`);
    }
    shown.forEach((q, i) => {
        if (rows.length) rows.push("│");
        const pre = `│ ${i + 1}. `;
        const cont = `│ ${" ".repeat(pre.length - 2)}`;
        const name = wrapLines(questShortName(q), BOX_W - pre.length, BOX_W - cont.length);
        rows.push(pre + name[0]);
        name.slice(1).forEach(t => rows.push(cont + t));
        rows.push(cont + questProgressText(q));
    });
    return rows;
}

// PARKED box rows: "│ · name" with wrapped continuations, no separators.
// NOTE: if a reward/source field is ever added to the quest object, render it
// as a distinct "│   reward: ..." line under the name — never merge it into
// the wrapped name text, so name vs reward stays unambiguous.
function parkedRows(names: string[]): string[] {
    const rows: string[] = [];
    for (const n of names) {
        const chunks = wrapLines(n, BOX_W - 4, BOX_W - 3);
        rows.push(`│ · ${chunks[0]}`);
        chunks.slice(1).forEach(t => rows.push(`│   ${t}`));
    }
    return rows;
}

function statusBox(): string {
    const uptime = sessionStartedAt ? formatDuration(Date.now() - sessionStartedAt) : "just started";
    return box("STATUS", [
        ...kv("State", `${paused ? "Paused" : "Running"} · up ${uptime}`, 9),
        ...kv("Bridge", isApp ? "detected" : "missing (desktop quests skipped)", 9),
    ]);
}

function queueBox(): string {
    const cooling = questQueue.filter(q => (retryAfter.get(q.id) ?? 0) > Date.now()).length;
    return box("QUEUE", [
        ...kv("Total", String(questQueue.length), 10),
        ...kv("Parked", String(parkedQuests.size), 10),
        ...kv("Cooling", String(cooling), 10),
    ]);
}

function buildStatusMessage(): string {
    const s = settings.store;
    const allParked: string[] = [];
    try {
        for (const id of parkedQuests) allParked.push(cleanName(questShortName(getQuestsStore()?.quests?.get(id))) || "unknown quest");
    } catch { /* ignore */ }
    // shrink the variable-length boxes until the message fits Discord's limit
    let nq = Math.min(questQueue.length, 8);
    let np = allParked.length;
    while (true) {
        const shown = questQueue.slice(0, nq);
        const names = allParked.slice(0, np);
        const active = activeRows(shown);
        if (nq < questQueue.length) active.push(`│ ... (+${questQueue.length - nq} more)`);
        const parts = [
            statusBox(),
            box("SESSION", [
                ...kv("Done", String(completedCount), 10),
                ...kv("Enrolled", String(enrolledCount), 10),
            ]),
            queueBox(),
            box("SETTINGS", [
                ...kv("autoAccept", s.autoAcceptQuests ? "on" : "off", 11),
                ...kv("autoClaim", s.autoClaim ? "on" : "off", 11),
                ...kv("check", `${s.fetchIntervalMinutes}m`, 11),
            ]),
        ];
        // omit empty boxes: no ACTIVE section without an active/queued quest,
        // no PARKED section without parked quests
        if (active.length) parts.push(box("ACTIVE", active));
        if (np > 0) {
            const rows = parkedRows(names);
            if (np < allParked.length) rows.push(`│ ... (+${allParked.length - np} more)`);
            parts.push(box("PARKED", rows));
        }
        const msg = fence(parts);
        if (msg.length <= 1850 || (nq === 0 && np === 0)) return msg;
        if (nq > 0) nq--; else np--;
    }
}

function buildStartMessage(): string {
    return fence([statusBox(), queueBox()]);
}

function buildStopMessage(): string {
    return fence([statusBox(), queueBox()]);
}

const disquestCommands = [
    {
        name: "disquest status",
        description: "Show DisQuest state, queue, session stats and settings.",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async (_, ctx) => sendBotMessage(ctx.channel.id, { content: buildStatusMessage() }),
    },
    {
        name: "disquest start",
        description: "Resume DisQuest automation (unpauses scans and processing).",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async (_, ctx) => {
            paused = false;
            syncQueueFromStore();
            return sendBotMessage(ctx.channel.id, { content: buildStartMessage() });
        },
    },
    {
        name: "disquest stop",
        description: "Pause DisQuest automation (stops the active task, keeps the queue).",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async (_, ctx) => {
            paused = true;
            generation++; // in-flight loops (claims especially) bail on this - stop freezes everything
            activeCleanup?.();
            activeCleanup = null;
            activeQuestId = null;
            processingQuests = false;
            return sendBotMessage(ctx.channel.id, { content: buildStopMessage() });
        },
    },
];

export default definePlugin({
    name: "DisQuest",
    description: "Automatically completes Discord quests (videos, activities, achievements; game/stream where Discord allows). Control via /disquest status, start, stop. Fork of Seramicx/discord-quest-autocompleter with Vesktop support.",
    tags: ["Quests", "Commands"],
    authors: [{ name: "illocean", id: 0n }, { name: "0.ninetynine", id: 1017989766907699310n }, { name: "Seramicx", id: 543577333530099742n }],
    settings,
    settingsAboutComponent: () => (
        <>
            <Forms.FormTitle tag="h3">About DisQuest</Forms.FormTitle>
            <Forms.FormText>
                Maintained by <Link href="https://github.com/illocean">illocean on GitHub</Link> — fork of Seramicx/discord-quest-autocompleter with Vesktop support.
            </Forms.FormText>
        </>
    ),
    commands: disquestCommands,

    start() {
        log("Starting...");

        const onConnectionOpen = () => {
            log("CONNECTION_OPEN - starting new session...");
            startSession();
        };

        const onStatusUpdate = () => {
            setTimeout(() => syncQueueFromStore(), 500);
        };

        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
        FluxDispatcher.subscribe("QUEST_USER_STATUS_UPDATE", onStatusUpdate);

        fluxUnsubs = [
            () => FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen),
            () => FluxDispatcher.unsubscribe("QUEST_USER_STATUS_UPDATE", onStatusUpdate),
        ];

        startSession();
    },

    stop() {
        log("Stopping...");

        for (const unsub of fluxUnsubs) unsub();
        fluxUnsubs = [];

        shutdown();
    }
});
