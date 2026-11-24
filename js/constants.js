/**
 * Solara 全局常量与配置
 */

export const DEFAULT_RADAR_GENRES = [
    "热歌榜",
    "新歌榜",
    "飙升榜",
];

export const EXPLORE_RADAR_GENRES = [
    "热歌榜",
    "新歌榜",
    "飙升榜",
    "潮流风向榜",
    "原创榜",
    "网易云全球说唱榜",
    "美国Billboard榜",
];

export const SOURCE_OPTIONS = [
    { value: "netease", label: "网易云音乐" },
    { value: "tencent", label: "QQ音乐" },
    { value: "kuwo", label: "酷我音乐" },
    { value: "joox", label: "JOOX音乐" },
    { value: "bilibili", label: "哔哩哔哩" }
];

export const RADAR_PLAYLISTS = [
    { id: "3778678", name: "热歌榜", description: "网易云音乐官方热歌榜" },
    { id: "19723756", name: "飙升榜", description: "网易云音乐官方飙升榜" },
    { id: "3779629", name: "新歌榜", description: "网易云音乐官方新歌榜" },
    { id: "13372522766", name: "潮流风向榜", description: "网易云音乐官方潮流风向榜" },
    { id: "2884035", name: "原创榜", description: "网易云音乐官方原创榜" },
    { id: "14028249541", name: "网易云全球说唱榜", description: "网易云音乐全球说唱榜" },
    { id: "60198", name: "美国Billboard榜", description: "网易云音乐美国Billboard榜" }
];

export function normalizeSource(value) {
    const allowed = SOURCE_OPTIONS.map(option => option.value);
    return allowed.includes(value) ? value : SOURCE_OPTIONS[0].value;
}

export const QUALITY_OPTIONS = [
    { value: "128", label: "标准音质", description: "128 kbps" },
    { value: "192", label: "高品音质", description: "192 kbps" },
    { value: "320", label: "极高音质", description: "320 kbps" },
    { value: "999", label: "无损音质", description: "FLAC" }
];

export const DEFAULT_PLAYBACK_QUALITY = "320";

export function normalizeQuality(value) {
    const match = QUALITY_OPTIONS.find(option => option.value === value);
    return match ? match.value : DEFAULT_PLAYBACK_QUALITY;
}

export const REMOTE_STORAGE_ENDPOINT = "/api/storage";

export const STORAGE_KEYS_TO_SYNC = new Set([
    "playlistSongs",
    "currentTrackIndex",
    "playMode",
    "playbackQuality",
    "playerVolume",
    "currentPlaylist",
    "currentList",
    "currentSong",
    "currentPlaybackTime",
    "favoriteSongs",
    "currentFavoriteIndex",
    "favoritePlayMode",
    "favoritePlaybackTime",
    "searchSource",
    "lastSearchState.v1",
    "radarSettings",
    // 与 CUSTOM_APIS_STORAGE_KEY 同值；此处用字面量是为避免 TDZ（该常量定义在下方）。
    "solara.customApis.v1",
]);

export const PALETTE_STORAGE_KEY = "paletteCache.v3";
export const LAST_SEARCH_STATE_STORAGE_KEY = "lastSearchState.v1";
export const PLAYLIST_EXPORT_VERSION = 1;
export const FAVORITE_EXPORT_VERSION = 1;

/**
 * 自定义音源 / 自定义 API（设置面板里用户自己添加的条目）。
 *
 * 两种类型，行为不同，UI 里必须区分清楚，不能混为一谈：
 * - `api`：GD / Meting 兼容的上游（`.../api.php`），替换 `/proxy` 的默认上游，
 *   搜索、播放地址、歌词、封面、榜单都走它。相当于把原来只能用环境变量
 *   `API_BASE_URL` 配置的事，搬到了界面上。
 * - `lx-script`：洛雪（lx-music）音源脚本（`.js`，如示例的 f600412fe0.js）。
 *   这类脚本只实现 `musicUrl` 一个动作：给定一首歌，返回可播地址；它没有
 *   搜索/歌词/封面接口。所以它只能作为播放地址的解析器，在隔离 Worker 里
 *   运行，失败时自动回落到默认 `/proxy`。搜索仍走 Solara 自身的 API。
 *
 * 只存 URL 和解析出的元数据，不存脚本原文；脚本每次加载时重新从 URL 拉取。
 */
export const CUSTOM_APIS_STORAGE_KEY = "solara.customApis.v1";
export const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";

/** 洛雪平台代码 -> Solara 搜索 source 的映射（只有这两个平台在 Solara 里存在）。 */
export const LX_PLATFORM_TO_SOLARA_SOURCE = { wy: "netease", kw: "kuwo" };
export const SOLARA_SOURCE_TO_LX_PLATFORM = { netease: "wy", tencent: "tx", kuwo: "kw" };

function isPrivateIpLiteral(hostname) {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 127 || a === 0) return true;
        if (a === 169 && b === 254) return true;
    }
    if (hostname === "::1" || hostname === "[::1]") return true;
    return false;
}

/**
 * 校验用户在界面输入的自定义 URL（仅做字符串级校验，服务端还会再拦一次，
 * 包括内网地址与元数据地址）。返回 { ok, kind, url, error }。
 */
export function validateCustomApiUrl(raw) {
    const input = String(raw || "").trim();
    if (!input) return { ok: false, error: "请填写接口地址" };
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return { ok: false, error: "地址格式不正确，请输入以 http:// 或 https:// 开头的完整地址" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: "只支持 http:// 或 https:// 地址" };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, error: "地址里不能带用户名或密码" };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")
        || hostname === "metadata.google.internal" || isPrivateIpLiteral(hostname)) {
        return { ok: false, error: "不允许使用本地/内网地址" };
    }
    if (parsed.protocol === "http:" && hostname.endsWith(".onion")) {
        return { ok: false, error: "不支持 .onion 地址" };
    }
    const pathname = parsed.pathname.toLowerCase();
    const kind = pathname.endsWith(".js") ? "lx-script" : "api";
    return { ok: true, kind, url: parsed.toString() };
}

export function sanitizeCustomApiEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const checked = validateCustomApiUrl(raw.url);
    if (!checked.ok) return null;
    const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
    return {
        id: typeof raw.id === "string" && raw.id ? raw.id : `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: typeof raw.name === "string" ? raw.name.slice(0, 80) : "",
        url: checked.url,
        kind: checked.kind,
        enabled: raw.enabled !== false,
        // 只有 api 类型有“当前生效”一说；lx-script 只要 enabled 就会参与解析。
        active: checked.kind === "api" ? raw.active === true : false,
        status: ["unknown", "ok", "error", "partial"].includes(raw.status) ? raw.status : "unknown",
        statusMessage: typeof raw.statusMessage === "string" ? raw.statusMessage.slice(0, 200) : "",
        // 逐平台检测结果（仅洛雪脚本）：[{ platform, name, ok }]，按脚本上报顺序存。
        platformResults: Array.isArray(raw.platformResults) ? raw.platformResults.filter(r => r && typeof r === "object" && typeof r.platform === "string").slice(0, 8).map(r => ({
            platform: r.platform.slice(0, 16),
            name: typeof r.name === "string" && r.name ? r.name.slice(0, 20) : r.platform.slice(0, 16),
            ok: r.ok === true,
        })) : [],
        meta: {
            name: typeof meta.name === "string" ? meta.name.slice(0, 120) : "",
            version: typeof meta.version === "string" ? meta.version.slice(0, 60) : "",
            author: typeof meta.author === "string" ? meta.author.slice(0, 80) : "",
            description: typeof meta.description === "string" ? meta.description.slice(0, 300) : "",
            platforms: Array.isArray(meta.platforms) ? meta.platforms.filter(p => typeof p === "string").slice(0, 8) : [],
            supportsMusicUrl: meta.supportsMusicUrl === true,
        },
        addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
        lastTestedAt: Number.isFinite(raw.lastTestedAt) ? raw.lastTestedAt : 0,
    };
}

export function loadCustomApis() {
    try {
        if (typeof localStorage === "undefined") return [];
        const parsed = JSON.parse(localStorage.getItem(CUSTOM_APIS_STORAGE_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.map(sanitizeCustomApiEntry).filter(Boolean);
    } catch {
        return [];
    }
}

/** 当前生效的自定义 API 上游（api 类型、已启用、被设为当前），没有则返回 null（用默认上游）。 */
export function getActiveApiBaseUrl() {
    const entry = loadCustomApis().find(e => e.kind === "api" && e.enabled && e.active);
    return entry ? entry.url : null;
}

/**
 * 音源检测结果存储：按当前生效上游分桶（上游地址或 "default"），避免换了上游
 * 还沿用旧上游的检测结论。只存每个平台最近一次的状态（ok / empty / error）。
 */
export const HEALTH_CHECK_RESULTS_STORAGE_KEY = "solara.healthCheckResults.v1";

function healthCheckResultsKey() {
    return getActiveApiBaseUrl() || "default";
}

function readHealthCheckResultsStore() {
    try {
        if (typeof localStorage === "undefined") return {};
        const parsed = JSON.parse(localStorage.getItem(HEALTH_CHECK_RESULTS_STORAGE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/** 当前上游下各平台最近一次检测状态：{ [source]: "ok" | "empty" | "error" }，无记录为空对象。 */
export function loadHealthCheckResults() {
    const bucket = readHealthCheckResultsStore()[healthCheckResultsKey()];
    if (!bucket || typeof bucket !== "object") return {};
    const out = {};
    for (const option of SOURCE_OPTIONS) {
        const record = bucket[option.value];
        if (record && (record.state === "ok" || record.state === "empty" || record.state === "error")) {
            out[option.value] = record.state;
        }
    }
    return out;
}

export function saveHealthCheckResult(source, state) {
    if (state !== "ok" && state !== "empty" && state !== "error") return;
    try {
        if (typeof localStorage === "undefined") return;
        const store = readHealthCheckResultsStore();
        const key = healthCheckResultsKey();
        const bucket = store[key] && typeof store[key] === "object" ? store[key] : {};
        bucket[source] = { state, at: Date.now() };
        store[key] = bucket;
        localStorage.setItem(HEALTH_CHECK_RESULTS_STORAGE_KEY, JSON.stringify(store));
    } catch {
        // 存储不可用时检测结果仅保留在本次会话，不影响检测本身。
    }
}

/**
 * 各条已启用洛雪脚本逐平台检测通过的平台（面板的平台口径：wy/tx/kg/kw/mg
 * 对应网易云/QQ/酷狗/酷我/咪咕；JOOX/哔哩哔哩没有脚本平台）。
 * 检测面板药丸与主界面下拉都用它取并集：只要有一处通过，该平台就算可用。
 */
const LX_PLATFORM_TO_PANEL_SOURCE = { wy: "netease", tx: "tencent", kg: "kugou", kw: "kuwo", mg: "migu" };
export function getScriptPassingSources(entries) {
    const passing = new Set();
    for (const entry of entries || []) {
        if (entry.kind !== "lx-script" || !entry.enabled || !Array.isArray(entry.platformResults)) continue;
        for (const record of entry.platformResults) {
            if (record && record.ok === true && LX_PLATFORM_TO_PANEL_SOURCE[record.platform]) {
                passing.add(LX_PLATFORM_TO_PANEL_SOURCE[record.platform]);
            }
        }
    }
    return passing;
}

/** 是否有已启用的接口类条目检测通过（接口检测只测网易云搜索，只计入网易云）。 */
export function hasPassingApiEntry(entries) {
    return (entries || []).some((e) => e.kind === "api" && e.enabled && e.status === "ok");
}

/**
 * 主界面音源下拉的可见选项：没测过的平台照常显示；检测出“没有音源”（失败或
 * 无结果）的平台不显示——除非某条已启用的洛雪脚本逐平台检测通过了它（脚本能
 * 解析该平台的播放地址），这时也显示。两者取并集：只要有一处通过就显示。
 * 脚本平台与下拉选项的对应只有 wy/tx/kw 三个（下拉没有酷狗/咪咕/汽水选项）。
 * 如果全部平台都没通过则全部显示，避免下拉变空。
 */
export function getVisibleSourceOptions() {
    const results = loadHealthCheckResults();
    const scriptPassing = getScriptPassingSources(loadCustomApis());
    const visible = SOURCE_OPTIONS.filter((option) => {
        const state = results[option.value];
        if (state !== "error" && state !== "empty") return true;
        return scriptPassing.has(option.value);
    });
    return visible.length > 0 ? visible : SOURCE_OPTIONS.slice();
}

function withApiBase(url, base) {
    if (!base) return url;
    try {
        const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
        parsed.searchParams.set("apiBase", base);
        // 相对路径要保持相对形式，避免把 /proxy 写成绝对地址破坏原有行为。
        return url.startsWith("/") ? `${parsed.pathname}${parsed.search}` : parsed.toString();
    } catch {
        return url;
    }
}

function withActiveApiBase(url) {
    return withApiBase(url, getActiveApiBaseUrl());
}

function describeApiBase(base) {
    return base || "默认上游";
}

/**
 * 音源轮询顺序：当前生效上游在前，其余已启用的自定义 api 按列表顺序
 * 在后，最后是默认上游（null）。去重；没有任何自定义 api 时只有 [null]，
 * 与原来“只用默认上游”完全一致。lx-script 不走 api 协议，不参与。
 */
export function getApiFallbackBases() {
    const entries = loadCustomApis().filter(e => e.kind === "api" && e.enabled);
    const active = entries.find(e => e.active);
    const ordered = [];
    const push = (base) => { if (!ordered.includes(base)) ordered.push(base); };
    if (active) push(active.url);
    for (const entry of entries) push(entry.url);
    push(null);
    return ordered;
}

/** 单次上游请求的最长等待（轮询时每个上游单独计时，避免一个挂起的上游拖住整条链）。 */
export const FALLBACK_ATTEMPT_TIMEOUT_MS = 10000;

async function fetchJsonWithTimeout(url, timeoutMs = FALLBACK_ATTEMPT_TIMEOUT_MS, debugLogger = null) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: controller ? controller.signal : undefined,
        });
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }
        const cacheStatus = response.headers.get("X-Cache-Status");
        if (cacheStatus && typeof debugLogger === "function" && typeof window !== "undefined") {
            const urlObj = new URL(url, window.location.origin);
            const type = urlObj.searchParams.get("types") || "未知接口";
            if (cacheStatus === "HIT") debugLogger(`[边缘缓存] 命中接口数据: ${type}`);
            else if (cacheStatus === "MISS") debugLogger(`[穿透回源] 拉取接口数据: ${type}`);
        }
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.warn("JSON parse failed, returning raw text", parseError);
            return text;
        }
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 对指定上游（base 为 null 时用默认上游）做一次搜索并归一化结果。 */
async function searchOnce(keyword, source, count, page, base, debugLogger) {
    const signature = API.generateSignature();
    const url = withApiBase(`${API.baseUrl}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=${count}&pages=${page}&s=${signature}`, base);
    if (typeof debugLogger === "function") debugLogger(`API请求: ${url}`);
    const data = await fetchJsonWithTimeout(url, FALLBACK_ATTEMPT_TIMEOUT_MS, debugLogger);
    if (typeof debugLogger === "function") debugLogger(`API响应: ${JSON.stringify(data).substring(0, 200)}...`);
    if (!Array.isArray(data)) throw new Error("搜索结果格式错误");
    return data.map(song => ({
        id: song.id,
        name: song.name,
        artist: song.artist,
        album: song.album,
        pic_id: song.pic_id,
        url_id: song.url_id,
        lyric_id: song.lyric_id,
        source: song.source,
    }));
}

/** 对指定上游拉一次榜单并归一化。 */
async function fetchRadarOnce(playlistId, limit, offset, base) {
    const signature = API.generateSignature();
    const params = new URLSearchParams({
        types: "playlist",
        id: playlistId,
        limit: String(limit),
        offset: String(offset),
        s: signature,
    });
    const url = withApiBase(`${API.baseUrl}?${params.toString()}`, base);
    const data = await fetchJsonWithTimeout(url);
    const tracks = data && data.playlist && Array.isArray(data.playlist.tracks)
        ? data.playlist.tracks.slice(0, limit)
        : [];
    if (tracks.length === 0) throw new Error("No tracks found");
    return tracks.map(track => {
        const directPicUrl = track.al?.picUrl || (typeof track.al?.pic === "string" && track.al.pic.startsWith("http") ? track.al.pic : "");
        return {
            id: track.id,
            name: track.name,
            artist: Array.isArray(track.ar) ? track.ar.map(artist => artist.name).join(" / ") : (track.ar?.name || "未知艺术家"),
            album: track.al?.name || "",
            source: "netease",
            lyric_id: track.id,
            pic: directPicUrl,
            pic_id: track.al?.pic_str || track.al?.pic || "",
            url_id: track.id,
        };
    });
}

export const BACKGROUND_TRANSITION_DURATION = 850;
export const PALETTE_APPLY_DELAY = 140;
export const PALETTE_MAX_DIMENSION = 96;
export const PALETTE_TARGET_SAMPLE_COUNT = 2400;

export const PLACEHOLDER_HTML = `<div class="placeholder"><i class="fas fa-music"></i></div>`;

export const themeDefaults = {
    light: {
        gradient: "",
        primaryColor: "",
        primaryColorDark: "",
    },
    dark: {
        gradient: "",
        primaryColor: "",
        primaryColorDark: "",
    }
};

/**
 * 核心后端 API 代理接口
 */
export const API = {
    baseUrl: "/proxy",

    generateSignature: () => {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    },

    fetchJson: async (url, debugLogger = null) => {
        try {
            const response = await fetch(url, {
                headers: {
                    "Accept": "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            const cacheStatus = response.headers.get("X-Cache-Status");
            if (cacheStatus && typeof debugLogger === "function") {
                const urlObj = new URL(url, window.location.origin);
                const type = urlObj.searchParams.get("types") || "未知接口";
                if (cacheStatus === "HIT") {
                    debugLogger(`[边缘缓存] 命中接口数据: ${type}`);
                } else if (cacheStatus === "MISS") {
                    debugLogger(`[穿透回源] 拉取接口数据: ${type}`);
                }
            }

            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (parseError) {
                console.warn("JSON parse failed, returning raw text", parseError);
                return text;
            }
        } catch (error) {
            console.error("API request error:", error);
            throw error;
        }
    },

    search: async (keyword, source = "netease", count = 20, page = 1, debugLogger = null) => {
        try {
            return await searchOnce(keyword, source, count, page, getActiveApiBaseUrl(), debugLogger);
        } catch (error) {
            if (typeof debugLogger === "function") debugLogger(`API错误: ${error.message}`);
            throw error;
        }
    },

    /**
     * 搜索轮询：按 getApiFallbackBases() 的顺序逐个上游尝试；某上游报错
     * 或返回空结果就换下一个。全部返回空时返回 []，全部报错时抛最后一个错。
     * “当前生效”设置不变——轮询只影响本次请求，不改动用户设定的首选顺序。
     * 音源检测面板继续用 API.search，不走轮询，检测结果才如实反映单个上游。
     */
    searchWithFallback: async (keyword, source = "netease", count = 20, page = 1, debugLogger = null) => {
        const bases = getApiFallbackBases();
        let lastError = null;
        let sawEmpty = false;
        for (const base of bases) {
            try {
                const results = await searchOnce(keyword, source, count, page, base, debugLogger);
                if (results.length > 0) {
                    if (bases.indexOf(base) > 0 && typeof debugLogger === "function") {
                        debugLogger(`[轮询] 上游 ${describeApiBase(base)} 返回 ${results.length} 条结果`);
                    }
                    return results;
                }
                sawEmpty = true;
                if (typeof debugLogger === "function") debugLogger(`[轮询] 上游 ${describeApiBase(base)} 返回空结果，尝试下一个音源`);
            } catch (error) {
                lastError = error;
                const note = `[轮询] 上游 ${describeApiBase(base)} 失败 (${error.message})，尝试下一个音源`;
                if (typeof debugLogger === "function") debugLogger(note);
                else console.warn(note, error);
            }
        }
        if (sawEmpty) return [];
        throw lastError || new Error("搜索失败");
    },

    getRadarPlaylist: async (playlistId = "3778678", options = {}) => {
        let limit = 20;
        let offset = 0;

        if (typeof options === "number") {
            limit = options;
        } else if (options && typeof options === "object") {
            if (Number.isFinite(options.limit)) {
                limit = options.limit;
            } else if (Number.isFinite(options.count)) {
                limit = options.count;
            }
            if (Number.isFinite(options.offset)) {
                offset = options.offset;
            }
        }

        limit = Math.max(1, Math.min(200, Math.trunc(limit)) || 20);
        offset = Math.max(0, Math.trunc(offset) || 0);

        try {
            return await fetchRadarOnce(playlistId, limit, offset, getActiveApiBaseUrl());
        } catch (error) {
            console.error("API request failed:", error);
            throw error;
        }
    },

    /** 榜单轮询：与 searchWithFallback 相同顺序，全部失败时抛最后一个错。 */
    getRadarPlaylistWithFallback: async (playlistId = "3778678", options = {}) => {
        let limit = 20;
        let offset = 0;

        if (typeof options === "number") {
            limit = options;
        } else if (options && typeof options === "object") {
            if (Number.isFinite(options.limit)) {
                limit = options.limit;
            } else if (Number.isFinite(options.count)) {
                limit = options.count;
            }
            if (Number.isFinite(options.offset)) {
                offset = options.offset;
            }
        }

        limit = Math.max(1, Math.min(200, Math.trunc(limit)) || 20);
        offset = Math.max(0, Math.trunc(offset) || 0);

        const bases = getApiFallbackBases();
        let lastError = null;
        for (const base of bases) {
            try {
                return await fetchRadarOnce(playlistId, limit, offset, base);
            } catch (error) {
                lastError = error;
                console.warn(`[轮询] 上游 ${describeApiBase(base)} 榜单失败，尝试下一个音源:`, error);
            }
        }
        console.error("API request failed:", lastError);
        throw lastError || new Error("No tracks found");
    },

    getSongUrlWithBase: (song, quality = "320", base = null) => {
        const signature = API.generateSignature();
        return withApiBase(`${API.baseUrl}?types=url&id=${song.id}&source=${song.source || "netease"}&br=${quality}&s=${signature}`, base);
    },

    getSongUrl: (song, quality = "320") => {
        return API.getSongUrlWithBase(song, quality, getActiveApiBaseUrl());
    },

    getLyric: (song) => {
        const signature = API.generateSignature();
        return withActiveApiBase(`${API.baseUrl}?types=lyric&id=${song.lyric_id || song.id}&source=${song.source || "netease"}&s=${signature}`);
    },

    getPicUrl: (song) => {
        const signature = API.generateSignature();
        return withActiveApiBase(`${API.baseUrl}?types=pic&id=${song.pic_id}&source=${song.source || "netease"}&size=300&s=${signature}`);
    }
};

Object.freeze(API);

/**
 * 脚本逐平台检测的探针：按检测歌曲名在网易云搜一条真实结果，用它的 id/歌名/歌手
 * 作探针（脚本后端按平台原生 ID 解析，写死一首歌的 ID 会与歌名对不上）。
 * 搜不到或搜索失败时回落到给定的默认探针，调用方须在状态文字里注明改用了默认探针。
 * searchFn 由调用方传入（默认用 API.search），便于隔离测试。
 */
export function buildLxProbeMusicInfo(first, song) {
    const id = first && (first.id ?? first.songmid ?? first.hash);
    if (first && id != null && String(id) !== "") {
        const sid = String(id);
        const artist = first.artist || first.singer || "";
        return {
            musicInfo: {
                id: sid,
                songmid: sid,
                hash: sid,
                name: first.name || song,
                singer: artist,
                artist,
                albumName: "",
                album: "",
                duration: 0,
                pic: "",
            },
            songName: first.name || song,
        };
    }
    return null;
}

export async function resolveLxProbeInfo(searchFn, song, fallbackMusicInfo, timeoutMs = 10000) {
    const fallback = {
        musicInfo: { ...fallbackMusicInfo },
        songName: fallbackMusicInfo.name,
        fallback: true,
    };
    try {
        const data = await Promise.race([
            searchFn(song, "netease", 1, 1),
            new Promise((_, reject) => setTimeout(() => reject(new Error("解析检测歌曲超时")), timeoutMs)),
        ]);
        const built = Array.isArray(data) ? buildLxProbeMusicInfo(data[0], song) : null;
        if (built) return { ...built, fallback: false };
    } catch (_) {
        // 搜不到/超时都回落默认探针，不抛错。
    }
    return fallback;
}
