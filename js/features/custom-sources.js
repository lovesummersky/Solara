/**
 * 自定义音源 / 自定义 API：存储、检测、隔离 Worker 管理、播放地址解析。
 *
 * 与 settings.js 不互相 import（settings.js 把 showNotification 以回调传进来），
 * 避免循环依赖。constants.js 只负责“当前生效上游”的读取，不 import 本模块。
 */

import {
    API,
    CUSTOM_APIS_STORAGE_KEY,
    SOLARA_SOURCE_TO_LX_PLATFORM,
    getScriptPassingSources,
    hasPassingApiEntry,
    loadCustomApis,
    loadHealthCheckResults,
    resolveLxProbeInfo,
    saveHealthCheckResult,
    sanitizeCustomApiEntry,
    validateCustomApiUrl,
} from "../constants.js";
import { safeGetLocalStorage, safeSetLocalStorage } from "../core/storage.js";
import { buildSourceMenu, updateSourceLabel } from "../core/quality.js";

export { loadCustomApis, sanitizeCustomApiEntry, validateCustomApiUrl };

const LX_QUALITY_BY_SOLARA = { "999": "flac", "320": "320k", "192": "320k", "128": "128k" };
const WORKER_LOAD_TIMEOUT_MS = 20000;
const MUSIC_URL_TIMEOUT_MS = 15000;
// 单条检测与总测试同一时间只跑一路：总测试进行中时点条目“检测”不响应，
// 反之亦然，避免两路并行触发上游并发限制或抢同一个 Worker。
let detectionRunning = false;
// 条目检测改动了各音源的逐平台结论后，刷新检测面板药丸的并集显示
//（initSourceHealthCheck 初始化时登记，面板没初始化过时为空操作）。
let refreshHealthPills = () => {};

function persist(entries) {
    const clean = entries.map(sanitizeCustomApiEntry).filter(Boolean);
    safeSetLocalStorage(CUSTOM_APIS_STORAGE_KEY, JSON.stringify(clean));
    return clean;
}

export function getCustomApis() {
    return loadCustomApis();
}

export function saveCustomApis(entries) {
    return persist(entries);
}

export function findCustomApi(id) {
    return loadCustomApis().find((e) => e.id === id) || null;
}

export function updateCustomApi(id, patch) {
    const entries = loadCustomApis().map((e) => (e.id === id ? sanitizeCustomApiEntry({ ...e, ...patch, id }) : e)).filter(Boolean);
    return persist(entries);
}

export function removeCustomApi(id) {
    const entries = loadCustomApis().filter((e) => e.id !== id);
    terminateWorker(id);
    return persist(entries);
}

/** 设为当前生效的 API 上游（同一时间只有一个；lx-script 不参与此状态）。 */
export function setActiveCustomApi(id) {
    const entries = loadCustomApis().map((e) => ({
        ...e,
        active: e.kind === "api" && e.id === id ? true : (e.kind === "api" ? false : e.active),
    }));
    return persist(entries);
}

/* ---------------- 服务端检测 ---------------- */

/** 拉取脚本元数据（不含代码）。服务端已做 URL 校验与大小限制。 */
export async function fetchLxScriptMeta(url) {
    const response = await fetch(`/proxy-source?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || `检测失败 (HTTP ${response.status})`);
    }
    return data;
}

/** 拉取脚本原文（供 Worker 加载），同样走服务端代理。 */
export async function fetchLxScriptCode(url) {
    const response = await fetch(`/proxy-source?url=${encodeURIComponent(url)}&includeCode=1`, {
        headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true || typeof data.code !== "string") {
        throw new Error((data && data.error) || `拉取音源脚本失败 (HTTP ${response.status})`);
    }
    return data.code;
}

/** 检测 GD/Meting 兼容 API：发一次真实搜索，返回数组且非空才算可用。 */
export async function testCustomApi(url, song = "海阔天空") {
    const params = new URLSearchParams({
        types: "search",
        source: "netease",
        name: song,
        count: "1",
        pages: "1",
        s: Math.random().toString(36).slice(2),
        apiBase: url,
        nocache: "true",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(`/proxy?${params.toString()}`, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
        const data = JSON.parse(text);
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error("上游返回了空结果，可能是接口不兼容或暂不可用");
        }
        const first = data[0] || {};
        return { ok: true, sample: `${first.name || "未知"} - ${first.artist || ""}`.trim() };
    } catch (err) {
        if (err && err.name === "AbortError") throw new Error("检测超时（15 秒无响应）");
        throw err instanceof Error ? err : new Error(String(err));
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------- Worker 管理 ---------------- */

const workers = new Map(); // id -> { worker, ready: Promise, config }

export function terminateWorker(id) {
    const record = workers.get(id);
    if (record) {
        try { record.worker.terminate(); } catch (_) { /* ignore */ }
        workers.delete(id);
    }
}

export function terminateAllWorkers() {
    for (const id of Array.from(workers.keys())) terminateWorker(id);
}

function createWorkerRecord(entry) {
    const worker = new Worker("js/lx-worker.js");
    const record = { worker, config: null, ready: null };
    record.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("音源脚本加载超时")), WORKER_LOAD_TIMEOUT_MS);
        const onMessage = (event) => {
            const data = event.data || {};
            if (data.type === "loaded") {
                clearTimeout(timer);
                worker.removeEventListener("message", onMessage);
                if (!data.hasHandler) {
                    reject(new Error("脚本没有注册 musicUrl 处理函数"));
                    return;
                }
                record.config = data.config || null;
                resolve(record);
            } else if (data.type === "load-error") {
                clearTimeout(timer);
                worker.removeEventListener("message", onMessage);
                reject(new Error(data.message || "脚本加载失败"));
            } else if (data.type === "inited") {
                record.config = data.config || record.config;
            }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", (err) => {
            clearTimeout(timer);
            reject(new Error(err.message || "Worker 出错"));
        }, { once: true });
    });
    workers.set(entry.id, record);
    return record;
}

export async function ensureLxWorker(entry) {
    const existing = workers.get(entry.id);
    if (existing) return existing.ready;
    const code = await fetchLxScriptCode(entry.url);
    const record = createWorkerRecord(entry);
    record.worker.postMessage({ type: "load", code });
    return record.ready;
}

function requestMusicUrlFromWorker(record, platform, musicInfo, quality) {
    return new Promise((resolve, reject) => {
        const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            record.worker.removeEventListener("message", onMessage);
            reject(new Error("解析超时"));
        }, MUSIC_URL_TIMEOUT_MS);
        const onMessage = (event) => {
            const data = event.data || {};
            if (data.id !== id) return;
            clearTimeout(timer);
            record.worker.removeEventListener("message", onMessage);
            if (data.type === "request-result") {
                if (typeof data.result === "string" && /^https?:\/\//i.test(data.result.trim())) {
                    resolve(data.result.trim());
                } else {
                    reject(new Error("音源返回了无效地址"));
                }
            } else {
                reject(new Error(data.message || "解析失败"));
            }
        };
        record.worker.addEventListener("message", onMessage);
        record.worker.postMessage({
            type: "request",
            id,
            action: "musicUrl",
            source: platform,
            info: { musicInfo, type: quality },
        });
    });
}

/**
 * 用已启用的洛雪脚本解析播放地址。只对 netease/kuwo 生效（脚本只有
 * wy/kw 等平台；joox/bilibili 没有对应平台，直接跳过）。
 * 全部失败返回 null，调用方回落到默认 /proxy，绝不抛错中断播放。
 */
export async function getCustomMusicUrl(song, solaraQuality = "320") {
    if (!song || typeof song !== "object") return null;
    const platform = SOLARA_SOURCE_TO_LX_PLATFORM[song.source || "netease"];
    if (!platform) return null;
    const entries = loadCustomApis().filter((e) => e.kind === "lx-script" && e.enabled);
    if (entries.length === 0) return null;

    const artist = Array.isArray(song.artist) ? song.artist.join(" / ") : (song.artist || "");
    const musicInfo = {
        id: song.id,
        songmid: song.id,
        hash: song.id,
        name: song.name || "",
        singer: artist,
        artist,
        albumName: song.album || "",
        album: song.album || "",
        duration: 0,
        pic: song.pic || "",
    };
    const quality = LX_QUALITY_BY_SOLARA[String(solaraQuality)] || "320k";

    for (const entry of entries) {
        try {
            const record = await ensureLxWorker(entry);
            // 脚本上报的平台里没有当前平台时跳过（上报缺失时不拦截，照常尝试）。
            const sources = record.config && record.config.sources;
            if (sources && typeof sources === "object" && !sources[platform]) continue;
            const url = await requestMusicUrlFromWorker(record, platform, musicInfo, quality);
            if (url) return url;
        } catch (err) {
            console.warn(`自定义音源解析失败 [${entry.meta?.name || entry.url}]:`, err);
        }
    }
    return null;
}

/** 检测单个 lx-script：按脚本上报的平台逐个实测检测歌曲 128k 解析，顺序测（避免并行触发上游限制）。
 * 探针用检测歌曲在网易云的真实搜索结果（id/歌名/歌手）；搜不到时回落默认《晴天》探针，
 * 并在返回里注明 songFallback，调用方须写进状态文字。需要平台原生 ID 的后端可能误报失败，
 * 因此结果只代表“这首探针歌在这条脚本各平台的实测”，不代表该平台彻底不可用。
 * 只要加载/注册失败才抛错；各平台成败都记在 results 里返回，由调用方汇总。 */
const LX_PROBE_MUSIC_INFO = {
    id: "186016",
    songmid: "186016",
    hash: "186016",
    name: "晴天",
    singer: "周杰伦",
    artist: "周杰伦",
    albumName: "",
    album: "",
    duration: 0,
    pic: "",
};
const LX_PROBE_QUALITY = "128k";

export async function testLxScript(entry, song = "海阔天空") {
    const record = await ensureLxWorker(entry);
    const sources = record.config && record.config.sources && typeof record.config.sources === "object"
        ? record.config.sources
        : {};
    const platforms = Object.keys(sources).filter((code) => {
        const actions = sources[code] && sources[code].actions;
        return !Array.isArray(actions) || actions.includes("musicUrl");
    });
    const probeList = platforms.length > 0 ? platforms : ["wy"];
    const probe = await resolveLxProbeInfo((...args) => API.search(...args), song, LX_PROBE_MUSIC_INFO);
    const results = [];
    for (const platform of probeList) {
        const name = (sources[platform] && sources[platform].name) || platform;
        try {
            const url = await requestMusicUrlFromWorker(record, platform, probe.musicInfo, LX_PROBE_QUALITY);
            results.push({ platform, name, ok: true, sampleUrl: url.slice(0, 60) + "…" });
        } catch (err) {
            results.push({ platform, name, ok: false, error: (err && err.message) || "解析失败" });
        }
    }
    const passedCount = results.filter((r) => r.ok).length;
    return { ok: passedCount > 0, config: record.config, results, passedCount, totalCount: results.length, songName: probe.songName, songFallback: probe.fallback };
}

/** 检测一条已添加的音源（脚本逐平台解析，或接口网易云搜索），用的是检测面板里填的
 * 同一首检测歌曲。内部处理全部失败分支并写回存储，返回摘要供调用方通知；
 * 调用方负责重新渲染列表。 */
async function runEntryDetection(entry, song) {
    try {
        if (entry.kind === "lx-script") {
            terminateWorker(entry.id);
            const result = await testLxScript(entry, song);
            const passed = result.passedCount;
            const total = result.totalCount;
            const firstFailed = result.results.find((r) => !r.ok);
            let statusMessage = `逐平台检测《${result.songName}》128k：${passed}/${total} 个平台通过`;
            if (result.songFallback) statusMessage += `（未搜到《${song}》，改用《${result.songName}》探针）`;
            if (firstFailed) statusMessage += `；${firstFailed.name}：${String(firstFailed.error || "").slice(0, 60)}`;
            updateCustomApi(entry.id, {
                status: passed === total ? "ok" : passed === 0 ? "error" : "partial",
                statusMessage,
                platformResults: result.results.map((r) => ({ platform: r.platform, name: r.name, ok: r.ok })),
                lastTestedAt: Date.now(),
            });
            return { summary: `检测完成：${passed}/${total} 个平台通过`, type: passed === total ? "success" : passed === 0 ? "error" : "warning" };
        }
        const result = await testCustomApi(entry.url, song);
        updateCustomApi(entry.id, {
            status: "ok",
            statusMessage: `检测（网易云《${song}》搜索）通过，示例：${result.sample}`,
            lastTestedAt: Date.now(),
        });
        return { summary: `检测（网易云《${song}》搜索）通过`, type: "success" };
    } catch (err) {
        // 逐平台检测里各平台成败已记在结果中，不会走到这里；到这里的是脚本加载/注册失败，
        // 或接口检测失败。接口检测只测网易云搜索，写明测的是什么。
        const failMessage = entry.kind === "lx-script"
            ? `检测失败：${err.message || "脚本加载失败"}`
            : `检测（网易云《${song}》搜索）失败：${err.message || "检测失败"}`;
        updateCustomApi(entry.id, {
            status: "error",
            statusMessage: failMessage,
            lastTestedAt: Date.now(),
        });
        return { summary: failMessage, type: "error" };
    }
}

/* ---------------- 设置面板 UI ---------------- */

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statusText(entry) {
    if (entry.status === "ok") return entry.statusMessage || "检测通过";
    if (entry.status === "error") return entry.statusMessage || "检测失败";
    if (entry.status === "partial") return entry.statusMessage || "部分平台通过";
    return "尚未检测";
}

/* ---- 音源检测面板：总测试——先对当前生效上游的每个平台实测一次搜索，
 * 再按顺序检测上面每条已启用的音源；两段用的都是下面输入框里填的同一首检测歌曲 ---- */
const HEALTH_CHECK_SOURCES = [
    { value: "netease", label: "网易云" },
    { value: "tencent", label: "QQ音乐" },
    { value: "kugou", label: "酷狗音乐" },
    { value: "kuwo", label: "酷我音乐" },
    { value: "migu", label: "咪咕音乐" },
    { value: "joox", label: "JOOX音乐" },
    { value: "bilibili", label: "哔哩哔哩" },
];
const HEALTH_CHECK_TIMEOUT_MS = 15000;
const HEALTH_CHECK_SONG_DEFAULT = "海阔天空";
const HEALTH_CHECK_SONG_STORAGE_KEY = "solara.healthCheckSong.v1";

function getHealthCheckSong(dom) {
    const raw = dom.sourceHealthSongInput ? dom.sourceHealthSongInput.value : "";
    const song = String(raw || "").trim().slice(0, 60);
    return song || HEALTH_CHECK_SONG_DEFAULT;
}

function loadHealthCheckSong() {
    try {
        const saved = safeGetLocalStorage(HEALTH_CHECK_SONG_STORAGE_KEY);
        const song = String(saved || "").trim().slice(0, 60);
        return song || HEALTH_CHECK_SONG_DEFAULT;
    } catch (_) {
        return HEALTH_CHECK_SONG_DEFAULT;
    }
}

// 条目检测（上面每条音源单独的“检测”）与总测试共用下面输入框里填的同一首检测歌曲：
// 读输入框的实时值，顺手存下来，下次打开面板直接显示同一首。
function getSharedTestSong(dom) {
    const song = getHealthCheckSong(dom);
    safeSetLocalStorage(HEALTH_CHECK_SONG_STORAGE_KEY, song);
    return song;
}

async function probeSourceHealth(source, song) {
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const start = now();
    try {
        const data = await Promise.race([
            API.search(song, source, 1, 1),
            new Promise((_, reject) => setTimeout(() => reject(new Error("检测超时")), HEALTH_CHECK_TIMEOUT_MS)),
        ]);
        const seconds = (now() - start) / 1000;
        if (Array.isArray(data) && data.length > 0) {
            return { state: "ok", text: seconds.toFixed(1) + "s" };
        }
        return { state: "empty", text: "无结果" };
    } catch (_) {
        return { state: "error", text: "失败" };
    }
}

function renderSourceHealth(dom, results, running) {
    const listEl = dom.sourceHealthList;
    if (!listEl) return;
    // 药丸取并集：上游实测通过显示秒数；上游没通过、但上面某条已启用音源
    // 检测通过了该平台，也显示正常（“可用”），因为只要有一个音源能通过就行。
    // 接口类条目只测网易云搜索，只计入网易云。
    const scriptPassing = getScriptPassingSources(loadCustomApis());
    const apiNeteaseOk = hasPassingApiEntry(loadCustomApis());
    listEl.innerHTML = HEALTH_CHECK_SOURCES.map((source) => {
        const result = (results || {})[source.value];
        const viaOtherSource = scriptPassing.has(source.value) || (source.value === "netease" && apiNeteaseOk);
        let state;
        let suffix;
        if (running === source.value) {
            state = "pending";
            suffix = "检测中…";
        } else if (result && result.state === "ok") {
            state = "ok";
            suffix = result.text;
        } else if (viaOtherSource) {
            state = "ok";
            suffix = "可用";
        } else if (result) {
            state = result.state;
            suffix = result.text;
        } else if (running === true) {
            state = "pending";
            suffix = "检测中…";
        } else {
            state = "unknown";
            suffix = "未检测";
        }
        // running 为 true 表示全量检测进行中（未出结果的显示“检测中…”）；
        // running 为某个平台 value 时表示总测试正在测它，该项优先显示“检测中…”。
        return `<span class="source-health-pill is-${state}"><span class="source-health-dot"></span>${escapeHtml(source.label)} ${escapeHtml(suffix)}</span>`;
    }).join("");
}

function initSourceHealthCheck(dom, state, { refreshSourceMenu = () => {}, notify = () => {} } = {}) {
    const btn = dom.sourceHealthCheckBtn;
    const listEl = dom.sourceHealthList;
    if (!btn || !listEl || btn.__healthBound) return;
    btn.__healthBound = true;
    // 打开面板即按当前上游最近一次的检测结论显示；没测过的显示“未检测”，不隐藏任何平台。
    const storedStateText = { ok: "可用", empty: "无结果", error: "失败" };
    let results = {};
    for (const [source, healthState] of Object.entries(loadHealthCheckResults())) {
        if (storedStateText[healthState]) results[source] = { state: healthState, text: storedStateText[healthState] };
    }
    if (Object.keys(results).length > 0) btn.textContent = "重新检测";
    const applyHealthResult = (source, result) => {
        results[source.value] = result;
        saveHealthCheckResult(source.value, result.state);
        refreshSourceMenu();
    };
    const songInput = dom.sourceHealthSongInput;
    const commitSong = () => {
        const song = getHealthCheckSong(dom);
        if (songInput) songInput.value = song;
        safeSetLocalStorage(HEALTH_CHECK_SONG_STORAGE_KEY, song);
        return song;
    };
    if (songInput) {
        songInput.value = loadHealthCheckSong();
        songInput.addEventListener("change", () => {
            commitSong();
        });
    }
    renderSourceHealth(dom, results, false);
    refreshHealthPills = () => renderSourceHealth(dom, results, false);
    // 总测试：先把全部平台逐个测一遍（不再支持单点某个音源单独测），
    // 再按顺序检测上面每条已启用的音源，用的都是下面输入框里填的同一首检测歌曲。
    btn.addEventListener("click", async () => {
        if (btn.disabled || detectionRunning) return;
        detectionRunning = true;
        btn.disabled = true;
        btn.textContent = "检测中…";
        try {
            const song = commitSong();
            // 逐个测：并行 7 路会触发上游并发限制（实测 503），逐个测结果才准。
            // 每轮只把正在测的那一项标为“检测中…”，其余显示已有结果或“未检测”，
            // 一眼就能看出当前正在测哪一个平台。
            for (const source of HEALTH_CHECK_SOURCES) {
                renderSourceHealth(dom, results, source.value);
                const result = await probeSourceHealth(source.value, song);
                applyHealthResult(source, result);
            }
            renderSourceHealth(dom, results, false);
            // 第二段：上面填写的每条已启用音源，用同一首检测歌曲逐条检测；每测完一条
            // 就刷新一次列表，卡片状态实时更新。
            const entries = loadCustomApis().filter((e) => e.enabled);
            for (const entry of entries) {
                await runEntryDetection(entry, song);
                renderCustomApiList(dom);
                refreshSourceMenu();
            }
            // 条目重测可能改变并集结论，最后再刷新一次药丸显示。
            renderSourceHealth(dom, results, false);
            if (entries.length > 0) notify(`总检测完成：已检测 ${entries.length} 条音源`, "info");
        } finally {
            detectionRunning = false;
            btn.disabled = false;
            btn.textContent = "重新检测";
        }
    });
}

export function renderCustomApiList(dom) {
    const listEl = dom.customApiList;
    if (!listEl) return;
    const entries = loadCustomApis();
    if (entries.length === 0) {
        listEl.innerHTML = `<p class="custom-api-empty">还没有自定义接口。默认使用官方 GD 接口，添加后可在这里切换。</p>`;
        return;
    }
    listEl.innerHTML = entries.map((entry) => {
        const displayName = entry.meta?.name || entry.name || (entry.kind === "lx-script" ? "洛雪音源脚本" : "自定义 API");
        const sub = [
            entry.kind === "lx-script" ? "洛雪脚本 · 仅解析播放地址" : "GD / Meting API · 搜索与播放",
            entry.meta?.version ? `v${escapeHtml(entry.meta.version)}` : "",
            entry.meta?.author ? escapeHtml(entry.meta.author) : "",
            (entry.meta?.platforms || []).join(" / "),
        ].filter(Boolean).join(" · ");
        const statusClass = entry.status === "ok" ? "is-ok" : entry.status === "error" ? "is-error" : entry.status === "partial" ? "is-partial" : "is-unknown";
        const platformResultsHtml = Array.isArray(entry.platformResults) && entry.platformResults.length > 0
            ? `<div class="custom-api-platform-results">${entry.platformResults.map((r) => `<span class="source-health-pill is-${r.ok ? "ok" : "error"}"><span class="source-health-dot"></span>${escapeHtml(r.name)} ${r.ok ? "通过" : "失败"}</span>`).join("")}</div>`
            : "";
        return `
        <div class="custom-api-item" data-id="${escapeHtml(entry.id)}">
            <div class="custom-api-item-main">
                <div class="custom-api-item-title">
                    <span class="custom-api-name">${escapeHtml(displayName)}</span>
                    ${entry.kind === "api" && entry.active ? `<span class="custom-api-badge is-active">当前生效</span>` : ""}
                    ${entry.enabled ? "" : `<span class="custom-api-badge">已停用</span>`}
                </div>
                <div class="custom-api-item-sub">${escapeHtml(sub)}</div>
                <div class="custom-api-item-url" title="${escapeHtml(entry.url)}">${escapeHtml(entry.url)}</div>
                <div class="custom-api-item-status ${statusClass}">${escapeHtml(statusText(entry))}</div>
                ${platformResultsHtml}
            </div>
            <div class="custom-api-item-actions">
                <button type="button" class="custom-api-btn" data-action="test">检测</button>
                ${entry.kind === "api" && !entry.active ? `<button type="button" class="custom-api-btn" data-action="activate">设为当前</button>` : ""}
                <button type="button" class="custom-api-btn" data-action="toggle">${entry.enabled ? "停用" : "启用"}</button>
                <button type="button" class="custom-api-btn is-danger" data-action="remove">删除</button>
            </div>
        </div>`;
    }).join("");
}

export function initCustomApiSettings(dom, state, { showNotification } = {}) {
    const addBtn = dom.customApiAddBtn;
    const listEl = dom.customApiList;
    if (!addBtn || !listEl || addBtn.__customApiBound) return;
    addBtn.__customApiBound = true;

    const notify = (msg, type) => {
        if (typeof showNotification === "function") showNotification(msg, type, dom);
    };
    const setFormStatus = (msg) => {
        if (dom.customApiFormStatus) dom.customApiFormStatus.textContent = msg || "";
    };

    renderCustomApiList(dom);
    // 检测结论变化 / 上游切换后刷新主界面音源下拉（隐藏检测出无源的平台）。
    const refreshSourceMenu = () => {
        buildSourceMenu(state, dom);
        updateSourceLabel(state, dom);
    };
    initSourceHealthCheck(dom, state, { refreshSourceMenu, notify });

    addBtn.addEventListener("click", async () => {
        const rawUrl = dom.customApiUrlInput ? dom.customApiUrlInput.value : "";
        const checked = validateCustomApiUrl(rawUrl);
        if (!checked.ok) {
            setFormStatus(checked.error);
            notify(checked.error, "warning");
            return;
        }
        const name = dom.customApiNameInput ? dom.customApiNameInput.value.trim().slice(0, 80) : "";
        const existing = loadCustomApis();
        if (existing.some((e) => e.url === checked.url)) {
            setFormStatus("这个地址已经添加过了");
            notify("这个地址已经添加过了", "warning");
            return;
        }
        addBtn.disabled = true;
        setFormStatus("正在检测，请稍候…");
        try {
            let entry = sanitizeCustomApiEntry({
                name,
                url: checked.url,
                kind: checked.kind,
                enabled: true,
                active: false,
                status: "unknown",
                statusMessage: "",
                meta: {},
            });
            if (checked.kind === "lx-script") {
                const meta = await fetchLxScriptMeta(checked.url);
                if (!meta.supportsMusicUrl) {
                    throw new Error("该脚本没有 musicUrl 能力，Solara 无法用它解析播放地址");
                }
                entry = sanitizeCustomApiEntry({
                    ...entry,
                    // 只代表“识别出脚本且有 musicUrl 能力”，不代表今天能解析出地址：
                    // 上游经常失效，是否可用以“检测”按钮的真实解析结果为准。
                    status: "unknown",
                    statusMessage: "已识别为洛雪音源脚本；点“检测”用下方检测歌曲逐个平台实测解析，通过才算可用",
                    meta: {
                        name: meta.name || name,
                        version: meta.version || "",
                        author: meta.author || "",
                        description: meta.description || "",
                        platforms: meta.platforms || [],
                        supportsMusicUrl: true,
                    },
                    lastTestedAt: Date.now(),
                });
            } else {
                const result = await testCustomApi(checked.url, getSharedTestSong(dom));
                entry = sanitizeCustomApiEntry({
                    ...entry,
                    status: "ok",
                    statusMessage: `检测通过，示例：${result.sample}`,
                    lastTestedAt: Date.now(),
                });
            }
            // 第一个通过检测的 api 自动设为当前生效，避免“加了却没用上”的困惑。
            const entries = [...loadCustomApis(), entry];
            if (entry.kind === "api" && !entries.some((e) => e.kind === "api" && e.active)) {
                entries[entries.length - 1] = { ...entry, active: true };
            }
            persist(entries);
            renderCustomApiList(dom);
            refreshSourceMenu();
            if (dom.customApiUrlInput) dom.customApiUrlInput.value = "";
            if (dom.customApiNameInput) dom.customApiNameInput.value = "";
            setFormStatus("已添加");
            notify("自定义接口已添加", "success");
        } catch (err) {
            setFormStatus(err.message || "检测失败");
            notify(err.message || "检测失败", "error");
        } finally {
            addBtn.disabled = false;
        }
    });

    listEl.addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-action]");
        if (!btn) return;
        const item = btn.closest(".custom-api-item");
        if (!item) return;
        const id = item.dataset.id;
        const entry = findCustomApi(id);
        if (!entry) return;
        const action = btn.dataset.action;

        if (action === "remove") {
            saveCustomApis(loadCustomApis().filter((e) => e.id !== id));
            renderCustomApiList(dom);
            refreshSourceMenu();
            notify("已删除", "info");
            return;
        }
        if (action === "toggle") {
            if (entry.kind === "lx-script") terminateWorker(id);
            updateCustomApi(id, { enabled: !entry.enabled });
            renderCustomApiList(dom);
            refreshSourceMenu();
            return;
        }
        if (action === "activate") {
            setActiveCustomApi(id);
            renderCustomApiList(dom);
            refreshSourceMenu();
            notify("已切换上游接口，后续搜索与播放将走该接口", "success");
            return;
        }
        if (action === "test") {
            if (detectionRunning) return;
            detectionRunning = true;
            btn.disabled = true;
            btn.textContent = "检测中…";
            try {
                // 单独检测用的也是下面检测面板里填的同一首检测歌曲。
                const outcome = await runEntryDetection(entry, getSharedTestSong(dom));
                notify(outcome.summary, outcome.type);
            } finally {
                detectionRunning = false;
                renderCustomApiList(dom);
                refreshSourceMenu();
                refreshHealthPills();
            }
        }
    });

    // 打开设置面板时刷新一次列表，避免其它标签页改动后显示过期。
    if (dom.settingsModal && !dom.settingsModal.__customApiRefreshBound) {
        dom.settingsModal.__customApiRefreshBound = true;
        const observer = new MutationObserver(() => {
            if (dom.settingsModal.classList.contains("show")) renderCustomApiList(dom);
        });
        observer.observe(dom.settingsModal, { attributes: true, attributeFilter: ["class"] });
    }
}

// 供调试台/其它模块在切换上游后清理旧 Worker（脚本 URL 变化时重新加载）。
export function reloadCustomSources() {
    terminateAllWorkers();
}

export function getActiveCustomApiSummary() {
    const entries = loadCustomApis();
    const activeApi = entries.find((e) => e.kind === "api" && e.enabled && e.active);
    const lxCount = entries.filter((e) => e.kind === "lx-script" && e.enabled).length;
    return { activeApi: activeApi || null, lxEnabledCount: lxCount, total: entries.length };
}
