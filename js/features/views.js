/**
 * Solara 新界面壳子：侧栏导航 + 视图路由 + 榜单/发现 + 听歌历史 + 歌词浮层。
 *
 * 约定：
 * - 只通过 window.SolaraViewsBridge 与主应用交互，不直接碰 state；播放、收藏、
 *   下载、音源切换全部走主应用已有的同一链路，避免两套状态逻辑。
 * - 榜单与发现数据走同源 /proxy 的 chart/discover 接口（服务端直取官方榜单，
 *   1 天缓存）。没有已验证接口的平台如实显示“暂未接入”，绝不编造数据。
 * - 趋势百分比/箭头：官方接口不返回可靠的排名变化字段时不显示，只酷我榜单
 *   自带 trend/rank_change 字段才显示升降箭头。
 */

import { API, SOURCE_OPTIONS } from "../constants.js";
import { dom } from "../dom.js";
import {
    safeGetLocalStorage,
    safeSetLocalStorage,
    parseJSON,
} from "../core/storage.js";

const HISTORY_STORAGE_KEY = "solara.playHistory.v1";
const HISTORY_LIMIT = 100;

/** 榜单目录（客户端镜像，与服务端 functions/proxy.ts 的目录逐一核对过）。 */
const CHART_CATALOG = {
    tencent: [
        { key: "hot", name: "热歌榜", group: "巅峰榜" },
        { key: "new", name: "新歌榜", group: "巅峰榜" },
        { key: "soaring", name: "飙升榜", group: "巅峰榜" },
        { key: "pop", name: "流行指数榜", group: "巅峰榜" },
        { key: "network", name: "网络歌曲榜", group: "巅峰榜" },
        { key: "mainland", name: "内地榜", group: "地区榜" },
        { key: "western", name: "欧美榜", group: "地区榜" },
        { key: "korea", name: "韩国榜", group: "地区榜" },
        { key: "japan", name: "日本榜", group: "地区榜" },
        { key: "hk", name: "香港地区榜", group: "地区榜" },
        { key: "tw", name: "台湾地区榜", group: "地区榜" },
    ],
    netease: [
        { key: "hot", name: "热歌榜", group: "巅峰榜" },
        { key: "soaring", name: "飙升榜", group: "巅峰榜" },
        { key: "new", name: "新歌榜", group: "巅峰榜" },
        { key: "original", name: "原创榜", group: "巅峰榜" },
    ],
    kuwo: [
        { key: "hot", name: "酷我热歌榜", group: "巅峰榜" },
    ],
    kugou: [],
    migu: [],
    joox: [],
    bilibili: [],
};

/** 卡片渐变（按顺序循环，与设计稿的渐变圆角卡片一致）。 */
const CARD_GRADIENTS = [
    "linear-gradient(135deg, #0f766e 0%, #134e4a 55%, #042f2e 100%)",
    "linear-gradient(135deg, #f97316 0%, #ea580c 55%, #7c2d12 100%)",
    "linear-gradient(135deg, #a855f7 0%, #7e22ce 55%, #3b0764 100%)",
    "linear-gradient(135deg, #334155 0%, #1e293b 55%, #0f172a 100%)",
    "linear-gradient(135deg, #e11d48 0%, #9f1239 55%, #4c0519 100%)",
    "linear-gradient(135deg, #2563eb 0%, #1d4ed8 55%, #172554 100%)",
    "linear-gradient(135deg, #0891b2 0%, #0e7490 55%, #164e63 100%)",
    "linear-gradient(135deg, #d97706 0%, #b45309 55%, #451a03 100%)",
];

const PLATFORM_BLURBS = {
    tencent: "QQ音乐官方榜单与新歌速递，每天刷新一次。",
    netease: "网易云音乐官方榜单与每日推荐歌单，每天刷新一次。",
    kugou: "酷狗音乐榜单正在接入中，搜索与播放不受影响。",
    kuwo: "酷我音乐官方热歌榜，每天刷新一次。",
    migu: "咪咕音乐榜单正在接入中，搜索与播放不受影响。",
    joox: "JOOX 榜单正在接入中，搜索与播放不受影响。",
    bilibili: "哔哩哔哩榜单正在接入中，搜索与播放不受影响。",
};

const VIEWS = ["discover", "charts", "chart-detail", "full-list", "now-playing", "search", "history"];

let currentView = "discover";
let detailContext = null;
let fullListContext = null;
const discoverCache = {};
let chartsWallPlatform = null;

function bridge() {
    return typeof window !== "undefined" ? window.SolaraViewsBridge || null : null;
}

function notify(msg, type) {
    const b = bridge();
    if (b && typeof b.notify === "function") b.notify(msg, type);
}

function currentPlatform() {
    const b = bridge();
    const value = b && typeof b.getSearchSource === "function" ? b.getSearchSource() : null;
    return value || "netease";
}

function platformLabel(value) {
    const option = SOURCE_OPTIONS.find((item) => item.value === value);
    return option ? option.label : value;
}

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
}

function formatDuration(seconds) {
    const total = Math.floor(Number(seconds) || 0);
    if (total <= 0) return "--:--";
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatPlayCount(count) {
    const n = Number(count) || 0;
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
    if (n >= 10000) return `${Math.round(n / 10000)}万`;
    return String(n);
}

function formatPlayedAt(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (sameDay) return `今天 ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** 把各种来源的歌曲对象归一成榜单/历史统一形状（字段缺失时给安全默认值）。 */
function normalizeSong(raw, fallbackSource) {
    if (!raw || typeof raw !== "object") return null;
    const artist = Array.isArray(raw.artist)
        ? raw.artist.map((a) => (typeof a === "object" ? a?.name : a)).filter(Boolean).join(" / ")
        : (raw.artist || "");
    const duration = Number(raw.duration) || Math.round(Number(raw.dt || 0) / 1000) || 0;
    const pic = typeof raw.pic === "string" && raw.pic ? raw.pic
        : (typeof raw.pic_id === "string" && /^https?:\/\//.test(raw.pic_id) ? raw.pic_id : "");
    const id = raw.id != null ? String(raw.id) : "";
    if (!id || !raw.name) return null;
    return {
        id,
        name: String(raw.name),
        artist: artist || "未知艺术家",
        album: String(raw.album?.name || raw.album || ""),
        duration,
        pic_id: raw.pic_id != null ? String(raw.pic_id) : "",
        url_id: raw.url_id != null ? String(raw.url_id) : id,
        lyric_id: raw.lyric_id != null ? String(raw.lyric_id) : id,
        source: raw.source || fallbackSource || "netease",
        pic,
        mv: Boolean(raw.mv),
        vip: Boolean(raw.vip),
        rank: Number(raw.rank) || 0,
        trend: raw.trend || null,
        trendChange: Number(raw.trendChange) || 0,
    };
}

function gradientIndexFor(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) % 997;
    return hash % CARD_GRADIENTS.length;
}

function coverHtml(song, size) {
    const cls = size === "large" ? "song-cover song-cover--large" : "song-cover";
    if (song.pic) {
        return `<span class="${cls}"><img src="${esc(song.pic)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('song-cover--fallback');this.remove()"><span class="song-cover--fallback-mark" aria-hidden="true">♪</span></span>`;
    }
    const gradient = CARD_GRADIENTS[gradientIndexFor(`${song.source}:${song.id}`)];
    return `<span class="${cls} song-cover--fallback" style="background:${gradient}"><span class="song-cover--fallback-mark" aria-hidden="true">${esc((song.name || "?").slice(0, 1))}</span></span>`;
}

function trendHtml(song) {
    if (song.trend === "up") {
        return `<span class="chart-song-trend chart-song-trend--up" title="上升 ${song.trendChange || ""} 位">↑${song.trendChange ? song.trendChange : ""}</span>`;
    }
    if (song.trend === "down") {
        return `<span class="chart-song-trend chart-song-trend--down" title="下降 ${song.trendChange || ""} 位">↓${song.trendChange ? song.trendChange : ""}</span>`;
    }
    if (song.trend === "flat") {
        return `<span class="chart-song-trend chart-song-trend--flat" title="持平">–</span>`;
    }
    return `<span class="chart-song-trend"></span>`;
}

function songRowHtml(song, index, layout) {
    const rank = song.rank || index + 1;
    const rankCls = rank <= 3 ? " chart-song-rank--top" : "";
    const badges = `${song.mv ? '<i class="song-badge song-badge--mv">MV</i>' : ""}${song.vip ? '<i class="song-badge song-badge--vip">VIP</i>' : ""}`;
    return `<div class="chart-song-row" data-song-index="${index}" role="button" tabindex="0" aria-label="播放 ${esc(song.name)}">
        <span class="chart-song-rank${rankCls}">${rank}</span>
        ${trendHtml(song)}
        ${coverHtml(song)}
        <span class="chart-song-main">
            <span class="chart-song-name">${esc(song.name)}${badges}</span>
            <span class="chart-song-meta">${esc(platformLabel(song.source))} · ${esc(song.artist)}${song.album ? ` · ${esc(song.album)}` : ""}</span>
        </span>
        ${layout === "full" ? `<span class="chart-song-singer">${esc(song.artist)}</span>` : ""}
        <span class="chart-song-duration">${formatDuration(song.duration)}</span>
        <span class="chart-song-actions">
            <button type="button" class="icon-btn chart-song-action" data-action="fav" aria-label="收藏 ${esc(song.name)}" title="收藏">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
            </button>
            <button type="button" class="icon-btn chart-song-action" data-action="add" aria-label="添加到播放列表" title="添加到播放列表">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
            </button>
            <button type="button" class="icon-btn chart-song-action" data-action="download" aria-label="下载 ${esc(song.name)}" title="下载">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
            </button>
        </span>
        ${song.playedAt ? `<span class="chart-song-played-at">${esc(formatPlayedAt(song.playedAt))}</span>` : ""}
    </div>`;
}

function bindSongList(container, songs, onPlay) {
    if (!container) return;
    container.querySelectorAll(".chart-song-row").forEach((row) => {
        const index = Number(row.dataset.songIndex);
        const song = songs[index];
        if (!song) return;
        row.addEventListener("click", (e) => {
            const actionBtn = e.target.closest("[data-action]");
            if (actionBtn) {
                e.stopPropagation();
                const action = actionBtn.dataset.action;
                const b = bridge();
                if (action === "fav" && b && typeof b.toggleFavoriteSong === "function") b.toggleFavoriteSong(song);
                if (action === "add" && b && typeof b.appendToPlaylist === "function") {
                    b.appendToPlaylist([song]);
                }
                if (action === "download" && b && typeof b.downloadExternalSongs === "function") {
                    b.downloadExternalSongs([song]);
                }
                return;
            }
            if (typeof onPlay === "function") onPlay(song, index);
        });
        row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (typeof onPlay === "function") onPlay(song, index);
            }
        });
    });
}

/* ---------------- 视图路由 ---------------- */

function showView(name, options = {}) {
    if (!VIEWS.includes(name)) name = "discover";
    currentView = name;
    document.querySelectorAll(".view[data-view]").forEach((section) => {
        const active = section.dataset.view === name;
        section.classList.toggle("active", active);
        if (active) section.removeAttribute("hidden");
        else section.setAttribute("hidden", "");
        section.classList.toggle("view--from-right", Boolean(active && options.fromRight));
    });
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.nav === name);
    });
    closeSidebar();
    const viewsEl = document.getElementById("appViews");
    if (viewsEl) viewsEl.scrollTop = 0;
    if (name === "discover") loadDiscover();
    if (name === "charts") renderChartsWall();
    if (name === "history") renderHistory();
    if (name === "now-playing") updateSidebarCounts();
}

function onSearchHidden() {
    if (currentView === "search") showView("now-playing");
}

/* ---------------- 平台切换 ---------------- */

function buildPlatformSelect() {
    const sel = dom.platformSelect;
    if (!sel) return;
    sel.innerHTML = SOURCE_OPTIONS.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join("");
    sel.value = currentPlatform();
    sel.addEventListener("change", () => {
        const value = sel.value;
        const b = bridge();
        if (b && typeof b.setSearchSource === "function") b.setSearchSource(value);
        chartsWallPlatform = null;
        Object.keys(discoverCache).forEach((key) => { delete discoverCache[key]; });
        if (currentView === "discover") loadDiscover(true);
        if (currentView === "charts") renderChartsWall();
        if (currentView === "chart-detail" || currentView === "full-list") {
            // 详情页跟随平台变化：回到榜单墙，避免停留在旧平台的榜单里。
            showView("charts");
        }
    });
}

function syncPlatformSelect() {
    const sel = dom.platformSelect;
    if (sel) sel.value = currentPlatform();
}

/* ---------------- 侧栏 ---------------- */

function closeSidebar() {
    if (dom.sidebar) dom.sidebar.classList.remove("open");
    if (dom.sidebarScrim) dom.sidebarScrim.setAttribute("hidden", "");
    document.body.classList.remove("sidebar-open");
}

function openSidebar() {
    if (dom.sidebar) dom.sidebar.classList.add("open");
    if (dom.sidebarScrim) dom.sidebarScrim.removeAttribute("hidden");
    document.body.classList.add("sidebar-open");
}

function bindSidebar() {
    if (dom.sidebarToggleBtn) {
        dom.sidebarToggleBtn.addEventListener("click", () => {
            if (dom.sidebar && dom.sidebar.classList.contains("open")) closeSidebar();
            else openSidebar();
        });
    }
    if (dom.sidebarScrim) {
        dom.sidebarScrim.addEventListener("click", closeSidebar);
    }
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const target = btn.dataset.nav;
            if (target === "favorites") {
                showView("now-playing");
                const tab = document.getElementById("favoritesTab");
                if (tab) tab.click();
                return;
            }
            if (target === "playlist") {
                showView("now-playing");
                const tab = document.getElementById("playlistTab");
                if (tab) tab.click();
                return;
            }
            showView(target);
        });
    });
    if (dom.sidebarRadarBtn) {
        dom.sidebarRadarBtn.addEventListener("click", () => {
            showView("now-playing");
            if (dom.loadOnlineBtn) dom.loadOnlineBtn.click();
        });
    }
    updateSidebarCounts();
}

function updateSidebarCounts() {
    if (dom.playlistCount && dom.playlistItems) {
        const count = dom.playlistItems.querySelectorAll(".playlist-item").length;
        dom.playlistCount.textContent = count > 0 ? String(count) : "";
    }
    if (dom.favoritesCount && dom.favoriteItems) {
        const count = dom.favoriteItems.querySelectorAll(".playlist-item, .favorite-item").length;
        dom.favoritesCount.textContent = count > 0 ? String(count) : "";
    }
    if (dom.playerBarQueueCount && dom.playlistItems) {
        const count = dom.playlistItems.querySelectorAll(".playlist-item").length;
        dom.playerBarQueueCount.textContent = count > 0 ? String(count) : "";
    }
}

/* ---------------- 榜单数据 ---------------- */

async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}`);
    return response.json();
}

async function fetchChart(platform, chartKey, offset, limit) {
    const data = await fetchJson(
        `/proxy?types=chart&platform=${encodeURIComponent(platform)}&chart=${encodeURIComponent(chartKey)}&offset=${offset}&limit=${limit}`,
    );
    if (data && data.unsupported) {
        const error = new Error("unsupported");
        error.unsupported = true;
        throw error;
    }
    return data;
}

async function fetchDiscover(platform) {
    const data = await fetchJson(`/proxy?types=discover&platform=${encodeURIComponent(platform)}`);
    if (data && data.unsupported) {
        const error = new Error("unsupported");
        error.unsupported = true;
        throw error;
    }
    return data;
}

function unsupportedHtml(platform) {
    return `<div class="view-empty">
        <div class="view-empty-title">${esc(platformLabel(platform))}榜单暂未接入</div>
        <p class="view-empty-text">该平台的官方榜单接口还没拉通，这里不放假数据。搜索、播放、歌词不受影响，也可以先看看其它平台的榜单。</p>
        <div class="view-empty-actions">
            <button type="button" class="btn btn--primary" data-action="goto-qq">看看 QQ音乐榜单</button>
            <button type="button" class="btn" data-action="goto-netease">看看 网易云音乐榜单</button>
        </div>
    </div>`;
}

function bindUnsupportedActions(container) {
    if (!container) return;
    container.querySelectorAll("[data-action='goto-qq']").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (dom.platformSelect) dom.platformSelect.value = "tencent";
            dom.platformSelect?.dispatchEvent(new Event("change"));
        });
    });
    container.querySelectorAll("[data-action='goto-netease']").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (dom.platformSelect) dom.platformSelect.value = "netease";
            dom.platformSelect?.dispatchEvent(new Event("change"));
        });
    });
}

function errorHtml(message, retryLabel) {
    return `<div class="view-empty">
        <div class="view-empty-title">加载失败</div>
        <p class="view-empty-text">${esc(message)}</p>
        <div class="view-empty-actions">
            <button type="button" class="btn btn--primary" data-action="retry">${esc(retryLabel || "重试")}</button>
        </div>
    </div>`;
}

/* ---------------- 榜单墙 ---------------- */

function renderChartsWall() {
    const container = dom.chartsGrid;
    if (!container) return;
    const platform = currentPlatform();
    if (chartsWallPlatform === platform && container.dataset.rendered === "1") return;
    chartsWallPlatform = platform;
    const catalog = CHART_CATALOG[platform] || [];
    const head = document.querySelector(".charts-head-platform");
    if (head) head.textContent = platformLabel(platform);
    const blurb = document.querySelector(".charts-head-blurb");
    if (blurb) blurb.textContent = PLATFORM_BLURBS[platform] || "";
    if (catalog.length === 0) {
        container.dataset.rendered = "1";
        container.innerHTML = unsupportedHtml(platform);
        bindUnsupportedActions(container);
        return;
    }
    const groups = [];
    catalog.forEach((def) => {
        let group = groups.find((g) => g.name === def.group);
        if (!group) {
            group = { name: def.group, items: [] };
            groups.push(group);
        }
        group.items.push(def);
    });
    container.dataset.rendered = "1";
    container.innerHTML = groups.map((group) => `
        <div class="charts-group">
            <h3 class="charts-group-title">${esc(group.name)}</h3>
            <div class="charts-card-grid">
                ${group.items.map((def, i) => {
                    const gradient = CARD_GRADIENTS[gradientIndexFor(`${platform}:${def.key}`)];
                    return `<button type="button" class="chart-card" data-chart-key="${esc(def.key)}" style="background:${gradient}">
                        <span class="chart-card-group">${esc(group.name)}</span>
                        <span class="chart-card-name">${esc(def.name)}</span>
                        <span class="chart-card-meta">${esc(platformLabel(platform))} · 每日刷新</span>
                        <span class="chart-card-go">查看榜单 →</span>
                    </button>`;
                }).join("")}
            </div>
        </div>`).join("");
    container.querySelectorAll(".chart-card").forEach((card) => {
        card.addEventListener("click", () => openChartDetail(platform, card.dataset.chartKey));
    });
}

/* ---------------- 榜单详情 ---------------- */

function chartDefFor(platform, chartKey) {
    const catalog = CHART_CATALOG[platform] || [];
    return catalog.find((def) => def.key === chartKey) || null;
}

function renderDetailShell() {
    const container = dom.chartDetailContent;
    if (!container || !detailContext) return;
    const ctx = detailContext;
    container.innerHTML = `
        <div class="detail-head">
            <button type="button" class="btn btn--ghost detail-back" data-action="back">← 全部榜单</button>
            <div class="detail-head-main">
                <span class="platform-badge">${esc(platformLabel(ctx.platform))}</span>
                <h2 class="detail-title">${esc(ctx.name)}</h2>
                <span class="detail-date">${esc(ctx.date || "")} · 每日刷新${ctx.total ? ` · 共 ${ctx.total} 首` : ""}</span>
            </div>
            <div class="detail-actions">
                <button type="button" class="btn btn--primary" data-action="play-all">播放全部</button>
                <button type="button" class="btn" data-action="download-all">批量下载</button>
                <button type="button" class="btn" data-action="save-playlist">存为歌单</button>
                <button type="button" class="btn" data-action="view-full">查看完整榜单</button>
            </div>
        </div>
        <div class="detail-list" data-detail-list></div>
        <div class="detail-foot" data-detail-foot></div>`;
    container.querySelector("[data-action='back']").addEventListener("click", () => showView("charts"));
    container.querySelector("[data-action='play-all']").addEventListener("click", () => {
        const b = bridge();
        if (b && typeof b.playExternalList === "function" && ctx.songs.length > 0) {
            b.playExternalList(ctx.songs, 0);
        }
    });
    container.querySelector("[data-action='download-all']").addEventListener("click", () => {
        const b = bridge();
        if (b && typeof b.downloadExternalSongs === "function") b.downloadExternalSongs(ctx.songs);
    });
    container.querySelector("[data-action='save-playlist']").addEventListener("click", () => {
        const b = bridge();
        if (b && typeof b.replacePlaylistWith === "function") {
            b.replacePlaylistWith(ctx.songs);
            notify(`已存为歌单，共 ${ctx.songs.length} 首`, "success");
            showView("now-playing");
            const tab = document.getElementById("playlistTab");
            if (tab) tab.click();
        }
    });
    container.querySelector("[data-action='view-full']").addEventListener("click", () => {
        openFullList(ctx.platform, ctx.chartKey);
    });
}

function renderDetailList() {
    const container = dom.chartDetailContent;
    if (!container || !detailContext) return;
    const listEl = container.querySelector("[data-detail-list]");
    const footEl = container.querySelector("[data-detail-foot]");
    const ctx = detailContext;
    if (ctx.error) {
        if (listEl) listEl.innerHTML = errorHtml(ctx.error, "重新加载");
        if (footEl) footEl.innerHTML = "";
        const retry = listEl?.querySelector("[data-action='retry']");
        if (retry) retry.addEventListener("click", () => loadMoreDetail(true));
        return;
    }
    if (listEl) {
        listEl.innerHTML = ctx.songs.map((song, i) => songRowHtml(song, i, "detail")).join("");
        bindSongList(listEl, ctx.songs, (song) => {
            const b = bridge();
            if (b && typeof b.playExternalSong === "function") b.playExternalSong(song);
        });
    }
    if (footEl) {
        const head = container.querySelector(".detail-date");
        if (head) head.textContent = `${ctx.date || ""} · 每日刷新${ctx.total ? ` · 共 ${ctx.total} 首` : ""}`;
        if (ctx.exhausted) {
            footEl.innerHTML = ctx.songs.length > 0 ? `<p class="detail-foot-note">已加载全部 ${ctx.songs.length} 首</p>` : "";
        } else {
            footEl.innerHTML = `<button type="button" class="btn detail-load-more" data-action="load-more">${ctx.loading ? "加载中…" : "加载更多"}</button>`;
            const btn = footEl.querySelector("[data-action='load-more']");
            if (btn) btn.addEventListener("click", () => loadMoreDetail(false));
        }
    }
}

async function loadMoreDetail(reset) {
    if (!detailContext) return;
    const ctx = detailContext;
    if (ctx.loading || (ctx.exhausted && !reset)) return;
    if (reset) {
        ctx.songs = [];
        ctx.loaded = 0;
        ctx.total = 0;
        ctx.exhausted = false;
        ctx.error = null;
    }
    ctx.loading = true;
    renderDetailList();
    try {
        const data = await fetchChart(ctx.platform, ctx.chartKey, ctx.loaded, 50);
        ctx.date = data.date || ctx.date;
        ctx.total = Number(data.total) || ctx.total;
        const songs = (Array.isArray(data.songs) ? data.songs : []).map((s, i) => normalizeSong({ ...s, rank: ctx.loaded + i + 1 }, ctx.platform)).filter(Boolean);
        ctx.songs = ctx.songs.concat(songs);
        ctx.loaded = ctx.songs.length;
        if (songs.length === 0 || ctx.loaded >= ctx.total) ctx.exhausted = true;
    } catch (err) {
        if (err && err.unsupported) {
            ctx.error = "该平台榜单暂未接入";
        } else {
            ctx.error = "榜单加载失败，可能是上游接口波动，请稍后重试。";
        }
    } finally {
        ctx.loading = false;
        renderDetailList();
    }
}

async function openChartDetail(platform, chartKey, preset) {
    const def = chartDefFor(platform, chartKey);
    if (!def && !preset) return;
    detailContext = {
        platform,
        chartKey,
        name: preset?.name || def?.name || "",
        songs: [],
        loaded: 0,
        total: preset?.total || 0,
        date: preset?.date || "",
        loading: false,
        exhausted: false,
        error: null,
        preset: preset || null,
    };
    renderDetailShell();
    showView("chart-detail", { fromRight: true });
    if (preset) {
        // 歌单/推荐内容：直接用已取到的歌曲，不再按榜单分页拉，也没有“完整榜单”可看。
        detailContext.songs = (preset.songs || []).map((s, i) => normalizeSong({ ...s, rank: i + 1 }, platform)).filter(Boolean);
        detailContext.loaded = detailContext.songs.length;
        detailContext.total = detailContext.songs.length;
        detailContext.exhausted = true;
        renderDetailList();
        const viewFullBtn = dom.chartDetailContent?.querySelector("[data-action='view-full']");
        if (viewFullBtn) viewFullBtn.remove();
        return;
    }
    await loadMoreDetail(true);
}

/* ---------------- 完整榜单 ---------------- */

function renderFullListShell() {
    const container = dom.fullListContent;
    if (!container || !fullListContext) return;
    const ctx = fullListContext;
    const catalog = CHART_CATALOG[ctx.platform] || [];
    container.innerHTML = `
        <div class="fulllist-layout">
            <aside class="fulllist-side">
                <div class="fulllist-side-title">${esc(platformLabel(ctx.platform))} · 榜单分类</div>
                ${catalog.map((def) => `<button type="button" class="fulllist-cat${def.key === ctx.chartKey ? " active" : ""}" data-chart-key="${esc(def.key)}">${esc(def.name)}</button>`).join("")}
                <button type="button" class="btn btn--ghost fulllist-back" data-action="back">← 返回榜单详情</button>
            </aside>
            <div class="fulllist-main">
                <div class="fulllist-head">
                    <h2 class="detail-title">${esc(ctx.name)}</h2>
                    <span class="detail-date">${esc(ctx.date || "")} · 每日刷新${ctx.total ? ` · 共 ${ctx.total} 首` : ""}</span>
                    <span class="fulllist-rule">榜单规则：按平台官方热度排序，每日刷新</span>
                    <div class="fulllist-actions">
                        <button type="button" class="btn btn--primary" data-action="play-all">播放全部</button>
                        <button type="button" class="btn" data-action="download-all">批量下载</button>
                    </div>
                    <div class="fulllist-filter">
                        <input type="text" class="fulllist-filter-input" placeholder="在已加载的榜单里筛选歌名 / 歌手…" autocomplete="off">
                        <span class="fulllist-filter-count"></span>
                    </div>
                </div>
                <div class="fulllist-list" data-fulllist-list></div>
                <div class="fulllist-foot" data-fulllist-foot></div>
            </div>
        </div>`;
    container.querySelector("[data-action='back']").addEventListener("click", () => {
        if (detailContext) {
            renderDetailShell();
            renderDetailList();
            showView("chart-detail");
        } else {
            showView("charts");
        }
    });
    container.querySelector("[data-action='play-all']").addEventListener("click", () => {
        const b = bridge();
        if (b && typeof b.playExternalList === "function" && ctx.songs.length > 0) b.playExternalList(ctx.songs, 0);
    });
    container.querySelector("[data-action='download-all']").addEventListener("click", () => {
        const b = bridge();
        if (b && typeof b.downloadExternalSongs === "function") b.downloadExternalSongs(ctx.songs);
    });
    container.querySelectorAll(".fulllist-cat").forEach((btn) => {
        btn.addEventListener("click", () => {
            const key = btn.dataset.chartKey;
            if (key === ctx.chartKey) return;
            const def = chartDefFor(ctx.platform, key);
            fullListContext = { ...ctx, chartKey: key, name: def?.name || ctx.name, songs: [], loaded: 0, total: 0, date: "", loading: false, exhausted: false, error: null, filter: "" };
            renderFullListShell();
            loadMoreFullList(true);
        });
    });
    const filterInput = container.querySelector(".fulllist-filter-input");
    if (filterInput) {
        filterInput.addEventListener("input", () => {
            ctx.filter = filterInput.value.trim().toLowerCase();
            renderFullListRows();
        });
    }
}

function filteredFullListSongs() {
    const ctx = fullListContext;
    if (!ctx) return [];
    if (!ctx.filter) return ctx.songs;
    return ctx.songs.filter((song) => `${song.name} ${song.artist}`.toLowerCase().includes(ctx.filter));
}

function renderFullListRows() {
    const container = dom.fullListContent;
    if (!container || !fullListContext) return;
    const ctx = fullListContext;
    const listEl = container.querySelector("[data-fulllist-list]");
    const footEl = container.querySelector("[data-fulllist-foot]");
    const countEl = container.querySelector(".fulllist-filter-count");
    if (ctx.error) {
        if (listEl) listEl.innerHTML = errorHtml(ctx.error, "重新加载");
        if (footEl) footEl.innerHTML = "";
        const retry = listEl?.querySelector("[data-action='retry']");
        if (retry) retry.addEventListener("click", () => loadMoreFullList(true));
        return;
    }
    const songs = filteredFullListSongs();
    if (countEl) countEl.textContent = ctx.filter ? `已筛选 ${songs.length} / ${ctx.songs.length} 首` : "";
    if (listEl) {
        if (ctx.songs.length === 0 && !ctx.loading) {
            listEl.innerHTML = `<div class="view-empty"><p class="view-empty-text">榜单还没有歌曲。</p></div>`;
        } else {
            listEl.innerHTML = songs.map((song) => {
                const index = ctx.songs.indexOf(song);
                return songRowHtml(song, index, "full");
            }).join("");
            bindSongList(listEl, ctx.songs, (song) => {
                const b = bridge();
                if (b && typeof b.playExternalSong === "function") b.playExternalSong(song);
            });
        }
    }
    if (footEl) {
        const head = container.querySelector(".detail-date");
        if (head) head.textContent = `${ctx.date || ""} · 每日刷新${ctx.total ? ` · 共 ${ctx.total} 首` : ""}`;
        if (ctx.filter) {
            footEl.innerHTML = "";
        } else if (ctx.exhausted) {
            footEl.innerHTML = ctx.songs.length > 0 ? `<p class="detail-foot-note">已加载全部 ${ctx.songs.length} 首</p>` : "";
        } else {
            footEl.innerHTML = `<button type="button" class="btn detail-load-more" data-action="load-more">${ctx.loading ? "加载中…" : "加载更多（每次 50 首）"}</button>`;
            const btn = footEl.querySelector("[data-action='load-more']");
            if (btn) btn.addEventListener("click", () => loadMoreFullList(false));
        }
    }
}

async function loadMoreFullList(reset) {
    if (!fullListContext) return;
    const ctx = fullListContext;
    if (ctx.loading || (ctx.exhausted && !reset)) return;
    if (reset) {
        ctx.songs = [];
        ctx.loaded = 0;
        ctx.total = 0;
        ctx.exhausted = false;
        ctx.error = null;
    }
    ctx.loading = true;
    renderFullListRows();
    try {
        const data = await fetchChart(ctx.platform, ctx.chartKey, ctx.loaded, 50);
        ctx.date = data.date || ctx.date;
        ctx.total = Number(data.total) || ctx.total;
        const songs = (Array.isArray(data.songs) ? data.songs : []).map((s, i) => normalizeSong({ ...s, rank: ctx.loaded + i + 1 }, ctx.platform)).filter(Boolean);
        ctx.songs = ctx.songs.concat(songs);
        ctx.loaded = ctx.songs.length;
        if (songs.length === 0 || ctx.loaded >= ctx.total) ctx.exhausted = true;
    } catch (err) {
        ctx.error = err && err.unsupported ? "该平台榜单暂未接入" : "榜单加载失败，可能是上游接口波动，请稍后重试。";
    } finally {
        ctx.loading = false;
        renderFullListRows();
    }
}

function openFullList(platform, chartKey) {
    const def = chartDefFor(platform, chartKey);
    fullListContext = {
        platform,
        chartKey,
        name: def?.name || detailContext?.name || "",
        songs: detailContext && detailContext.platform === platform && detailContext.chartKey === chartKey
            ? detailContext.songs.slice() : [],
        loaded: detailContext && detailContext.platform === platform && detailContext.chartKey === chartKey
            ? detailContext.songs.length : 0,
        total: detailContext?.total || 0,
        date: detailContext?.date || "",
        loading: false,
        exhausted: false,
        error: null,
        filter: "",
    };
    renderFullListShell();
    showView("full-list", { fromRight: true });
    renderFullListRows();
    if (fullListContext.songs.length === 0) {
        loadMoreFullList(true);
    } else if (detailContext && detailContext.loaded < detailContext.total) {
        // 详情页只拉了前 50 首：完整榜单继续往后拉，直到拉完或用户停下。
        loadMoreFullList(false);
    }
}

/* ---------------- 发现广场 ---------------- */

async function loadDiscover(force) {
    const container = dom.discoverContent;
    if (!container) return;
    const platform = currentPlatform();
    if (!force && discoverCache[platform]) {
        renderDiscover(discoverCache[platform]);
        return;
    }
    container.innerHTML = `<div class="view-loading">正在加载${esc(platformLabel(platform))}的发现内容…</div>`;
    try {
        const data = await fetchDiscover(platform);
        discoverCache[platform] = data;
        renderDiscover(data);
    } catch (err) {
        if (err && err.unsupported) {
            container.innerHTML = unsupportedHtml(platform);
            bindUnsupportedActions(container);
        } else {
            container.innerHTML = errorHtml("发现内容加载失败，可能是上游接口波动，请稍后重试。", "重试");
            const retry = container.querySelector("[data-action='retry']");
            if (retry) retry.addEventListener("click", () => loadDiscover(true));
        }
    }
}

function renderDiscover(data) {
    const container = dom.discoverContent;
    if (!container) return;
    const platform = data.platform || currentPlatform();
    const head = document.querySelector(".discover-head-platform");
    if (head) head.textContent = platformLabel(platform);
    const blurb = document.querySelector(".discover-head-blurb");
    if (blurb) blurb.textContent = PLATFORM_BLURBS[platform] || "";
    const dateEl = document.querySelector(".discover-head-date");
    if (dateEl) dateEl.textContent = data.date ? `${data.date} · 每日刷新` : "";
    const sections = Array.isArray(data.sections) ? data.sections : [];
    if (sections.length === 0) {
        container.innerHTML = unsupportedHtml(platform);
        bindUnsupportedActions(container);
        return;
    }
    const chartKeyForSection = (section, index) => {
        if (platform === "tencent") return index === 0 ? "new" : "hot";
        if (platform === "netease") return "new";
        return "hot";
    };
    container.innerHTML = sections.map((section, sectionIndex) => {
        if (section.kind === "playlists") {
            const items = Array.isArray(section.items) ? section.items : [];
            return `<section class="discover-section">
                <div class="discover-section-head">
                    <h3 class="discover-section-title">${esc(section.title)}</h3>
                </div>
                <div class="discover-playlist-grid">
                    ${items.map((item) => `
                        <button type="button" class="discover-playlist-card" data-playlist-id="${esc(item.id)}">
                            <span class="discover-playlist-cover">${item.pic ? `<img src="${esc(item.pic)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="discover-playlist-cover-fallback">♪</span>`}</span>
                            <span class="discover-playlist-name">${esc(item.name)}</span>
                            <span class="discover-playlist-meta">${item.trackCount ? `${item.trackCount} 首 · ` : ""}播放 ${formatPlayCount(item.playCount)}</span>
                        </button>`).join("")}
                </div>
            </section>`;
        }
        const songs = (Array.isArray(section.items) ? section.items : []).map((s) => normalizeSong(s, platform)).filter(Boolean);
        return `<section class="discover-section">
            <div class="discover-section-head">
                <h3 class="discover-section-title">${esc(section.title)}</h3>
                <button type="button" class="btn btn--ghost discover-more" data-section-index="${sectionIndex}">查看完整榜单 →</button>
            </div>
            <div class="discover-song-list">
                ${songs.map((song, i) => songRowHtml(song, i, "detail")).join("")}
            </div>
        </section>`;
    }).join("");
    container.querySelectorAll(".discover-playlist-card").forEach((card) => {
        card.addEventListener("click", () => openPlaylistDetail(card.dataset.playlistId, card.querySelector(".discover-playlist-name")?.textContent || "歌单"));
    });
    container.querySelectorAll(".discover-more").forEach((btn) => {
        btn.addEventListener("click", () => {
            const sectionIndex = Number(btn.dataset.sectionIndex);
            openChartDetail(platform, chartKeyForSection(sections[sectionIndex], sectionIndex));
        });
    });
    // 绑定每组歌曲行的播放与行内操作：注意 sections 里可能混有歌单组，
    // 渲染出的 .discover-song-list 只对应其中的歌曲组，需按歌曲组顺序对齐。
    const songSections = sections.filter((section) => section.kind !== "playlists");
    container.querySelectorAll(".discover-song-list").forEach((listEl, listIndex) => {
        const section = songSections[listIndex];
        if (!section) return;
        const songs = (Array.isArray(section.items) ? section.items : []).map((s) => normalizeSong(s, platform)).filter(Boolean);
        bindSongList(listEl, songs, (song) => {
            const b = bridge();
            if (b && typeof b.playExternalSong === "function") b.playExternalSong(song);
        });
    });
}

async function openPlaylistDetail(playlistId, name) {
    if (!playlistId) return;
    notify(`正在加载歌单《${name}》…`, "info");
    try {
        const data = await API.getRadarPlaylist(playlistId, { limit: 200 });
        const raw = Array.isArray(data) ? data : (data?.tracks || data?.result?.tracks || data?.playlist?.tracks || []);
        const songs = raw.map((s) => normalizeSong(s, "netease")).filter(Boolean);
        if (songs.length === 0) {
            notify("这个歌单没有取到歌曲", "warning");
            return;
        }
        await openChartDetail("netease", "__playlist__", { name, songs, total: songs.length, date: "" });
    } catch (err) {
        notify("歌单加载失败，请稍后重试", "error");
    }
}

/* ---------------- 听歌历史 ---------------- */

function loadHistory() {
    const parsed = parseJSON(safeGetLocalStorage(HISTORY_STORAGE_KEY), []);
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.name) : [];
}

function recordHistory(song) {
    if (!song || !song.id) return;
    const normalized = normalizeSong(song, song.source);
    if (!normalized) return;
    const list = loadHistory();
    const key = `${normalized.source}:${normalized.id}`;
    if (list.length > 0 && `${list[0].source}:${list[0].id}` === key) return;
    list.unshift({ ...normalized, playedAt: Date.now() });
    safeSetLocalStorage(HISTORY_STORAGE_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
    if (currentView === "history") renderHistory();
}

function renderHistory() {
    const container = dom.historyList;
    if (!container) return;
    const list = loadHistory();
    if (list.length === 0) {
        container.innerHTML = `<div class="view-empty">
            <div class="view-empty-title">还没有听歌历史</div>
            <p class="view-empty-text">播放过的歌曲会记在这里，只存在这台设备的浏览器里。</p>
        </div>`;
        return;
    }
    container.innerHTML = list.map((item, i) => songRowHtml(item, i, "detail")).join("");
    bindSongList(container, list, (song) => {
        const b = bridge();
        if (b && typeof b.playExternalSong === "function") b.playExternalSong(song);
    });
}

function initHistoryRecorder() {
    const player = dom.audioPlayer;
    if (!player) return;
    player.addEventListener("play", () => {
        window.setTimeout(() => {
            if (player.paused) return;
            const b = bridge();
            const song = b && typeof b.getCurrentSong === "function" ? b.getCurrentSong() : null;
            if (song) recordHistory(song);
        }, 300);
    });
}

function bindHistoryUI() {
    if (dom.historyClearBtn) {
        dom.historyClearBtn.addEventListener("click", () => {
            safeSetLocalStorage(HISTORY_STORAGE_KEY, "[]");
            renderHistory();
            notify("已清空听歌历史", "success");
        });
    }
}

/* ---------------- 底部播放栏与歌词浮层 ---------------- */

function syncNowPlayingText() {
    if (dom.playerBarTitle && dom.currentSongTitle) dom.playerBarTitle.textContent = dom.currentSongTitle.textContent || "";
    if (dom.playerBarArtist && dom.currentSongArtist) {
        // 副行显示“歌手 · 当前时间 / 总时长”；进度条已是顶部通栏细线，不会再被认成音量。
        const artist = dom.currentSongArtist.textContent || "";
        const cur = dom.currentTimeDisplay ? dom.currentTimeDisplay.textContent || "" : "";
        const dur = dom.durationDisplay ? dom.durationDisplay.textContent || "" : "";
        dom.playerBarArtist.textContent = (dur && dur !== "00:00") ? `${artist} · ${cur} / ${dur}` : artist;
    }
    if (dom.overlayTitle && dom.currentSongTitle) dom.overlayTitle.textContent = dom.currentSongTitle.textContent || "";
    if (dom.overlayArtist && dom.currentSongArtist) dom.overlayArtist.textContent = dom.currentSongArtist.textContent || "";
    if (dom.overlayQualityLabel && dom.qualityLabel) dom.overlayQualityLabel.textContent = dom.qualityLabel.textContent || "";
}

/* 大封面没有可用图片时（上游封面失败、空地址）恢复音符占位，避免整块空白。 */
const COVER_PLACEHOLDER_HTML = '<div class="album-cover-ambience"></div><div class="placeholder"><svg class="apple-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg></div>';

function ensureCoverArt() {
    const cover = dom.albumCover;
    if (!cover) return;
    const img = cover.querySelector("img");
    if (!img || !img.getAttribute("src")) {
        if (!cover.querySelector(".placeholder")) cover.innerHTML = COVER_PLACEHOLDER_HTML;
        return;
    }
    if (img.dataset.coverFallbackBound) return;
    img.dataset.coverFallbackBound = "1";
    img.addEventListener("error", () => {
        if (dom.albumCover) dom.albumCover.innerHTML = COVER_PLACEHOLDER_HTML;
    });
}

/* 正在播放列显示当前歌词行，点开歌词浮层；无歌词时隐藏，不留空白行。 */
function syncNowPlayingLyricLine() {
    const line = dom.nowPlayingLyricLine;
    if (!line || !dom.lyricsContent) return;
    const current = dom.lyricsContent.querySelector(".current");
    const text = (current?.textContent || "").trim();
    // 歌词区空占位（只有省略号）不是歌词，不显示，避免一行橙色省略号挂在卡片上。
    if (text && !/^\.{2,}$/.test(text)) {
        line.textContent = text;
        line.removeAttribute("hidden");
    } else {
        line.textContent = "";
        line.setAttribute("hidden", "");
    }
}

function syncNowPlayingCover() {
    const img = dom.albumCover ? dom.albumCover.querySelector("img") : null;
    const src = img ? img.getAttribute("src") : "";
    [dom.playerBarCover, dom.overlayCover].forEach((el) => {
        if (!el) return;
        if (src) {
            el.setAttribute("src", src);
            el.style.visibility = "visible";
        } else {
            el.removeAttribute("src");
            el.style.visibility = "hidden";
        }
    });
}

function initNowPlayingMirror() {
    syncNowPlayingText();
    syncNowPlayingCover();
    ensureCoverArt();
    syncNowPlayingLyricLine();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((mutations) => {
        let textChanged = false;
        let coverChanged = false;
        for (const mutation of mutations) {
            if (mutation.target === dom.albumCover || (dom.albumCover && dom.albumCover.contains(mutation.target))) coverChanged = true;
            else textChanged = true;
        }
        if (textChanged) syncNowPlayingText();
        if (coverChanged) { ensureCoverArt(); syncNowPlayingCover(); }
    });
    if (dom.currentSongTitle) observer.observe(dom.currentSongTitle, { childList: true, characterData: true, subtree: true });
    if (dom.currentSongArtist) observer.observe(dom.currentSongArtist, { childList: true, characterData: true, subtree: true });
    if (dom.albumCover) observer.observe(dom.albumCover, { childList: true, subtree: true, attributes: true });
    if (dom.qualityLabel) observer.observe(dom.qualityLabel, { childList: true, characterData: true, subtree: true });
    // 进度时间变化时刷新播放栏副行的“歌手 · 时间 / 时长”。
    if (dom.currentTimeDisplay) observer.observe(dom.currentTimeDisplay, { childList: true, characterData: true, subtree: true });
    if (dom.durationDisplay) observer.observe(dom.durationDisplay, { childList: true, characterData: true, subtree: true });
    // 歌词高亮行变化时刷新正在播放列的当前歌词行。
    if (dom.lyricsContent) {
        const lyricObserver = new MutationObserver(syncNowPlayingLyricLine);
        lyricObserver.observe(dom.lyricsContent, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
    // 浮层播放按钮图标跟随真实播放按钮同步（播放/暂停状态变化时主按钮会换图标）。
    if (dom.playPauseBtn && dom.overlayPlayBtn) {
        const syncPlayIcon = () => { dom.overlayPlayBtn.innerHTML = dom.playPauseBtn.innerHTML; };
        syncPlayIcon();
        const playIconObserver = new MutationObserver(syncPlayIcon);
        playIconObserver.observe(dom.playPauseBtn, { childList: true, subtree: true });
    }
    // 播放栏收藏代理按钮跟随真实收藏按钮的 is-active 状态变红/变灰。
    const syncFavBtn = () => {
        if (dom.playerBarFavBtn && dom.currentFavoriteToggle) {
            dom.playerBarFavBtn.classList.toggle("is-active", dom.currentFavoriteToggle.classList.contains("is-active"));
        }
    };
    syncFavBtn();
    if (dom.currentFavoriteToggle) {
        const favObserver = new MutationObserver(syncFavBtn);
        favObserver.observe(dom.currentFavoriteToggle, { attributes: true, attributeFilter: ["class"] });
    }
    // 收藏/播放列表数量变化时刷新侧栏计数
    if (dom.playlistItems) observer.observe(dom.playlistItems, { childList: true });
    if (dom.favoriteItems) observer.observe(dom.favoriteItems, { childList: true });
    const countObserver = new MutationObserver(() => updateSidebarCounts());
    if (dom.playlistItems) countObserver.observe(dom.playlistItems, { childList: true });
    if (dom.favoriteItems) countObserver.observe(dom.favoriteItems, { childList: true });
}

function isOverlayOpen() {
    return Boolean(dom.lyricsOverlay && !dom.lyricsOverlay.hasAttribute("hidden"));
}

function openOverlay() {
    const overlay = dom.lyricsOverlay;
    if (!overlay) return;
    syncNowPlayingText();
    syncNowPlayingCover();
    syncOverlayProgress();
    overlay.removeAttribute("hidden");
    overlay.classList.add("open");
    document.body.classList.add("lyrics-overlay-open");
    if (dom.overlayCloseBtn) dom.overlayCloseBtn.focus();
}

function closeOverlay() {
    const overlay = dom.lyricsOverlay;
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("hidden", "");
    document.body.classList.remove("lyrics-overlay-open");
}

function syncOverlayProgress() {
    const player = dom.audioPlayer;
    if (!player || !dom.overlayProgress) return;
    const duration = Number(player.duration) || 0;
    const current = Number(player.currentTime) || 0;
    if (document.activeElement !== dom.overlayProgress) {
        dom.overlayProgress.max = String(Math.max(duration, 0));
        dom.overlayProgress.value = String(current);
    }
    if (dom.overlayCurrentTime) dom.overlayCurrentTime.textContent = formatDuration(current);
    if (dom.overlayDuration) dom.overlayDuration.textContent = formatDuration(duration);
}

function bindPlayerBarAndOverlay() {
    if (dom.playerBarStrip) {
        dom.playerBarStrip.addEventListener("click", (e) => {
            if (e.target.closest("button, input, a, select")) return;
            openOverlay();
        });
        dom.playerBarStrip.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openOverlay();
            }
        });
    }
    if (dom.overlayCloseBtn) dom.overlayCloseBtn.addEventListener("click", closeOverlay);
    if (dom.lyricsOverlay) {
        dom.lyricsOverlay.addEventListener("click", (e) => {
            if (e.target === dom.lyricsOverlay) closeOverlay();
        });
    }
    if (dom.overlayPlayBtn) {
        dom.overlayPlayBtn.addEventListener("click", () => {
            if (dom.playPauseBtn) dom.playPauseBtn.click();
        });
    }
    const overlayPrev = document.getElementById("overlayPrevBtn");
    if (overlayPrev) overlayPrev.addEventListener("click", () => { if (typeof window.playPrevious === "function") window.playPrevious(); });
    const overlayNext = document.getElementById("overlayNextBtn");
    if (overlayNext) overlayNext.addEventListener("click", () => { if (typeof window.playNext === "function") window.playNext(); });
    if (dom.overlayFavoriteBtn) {
        dom.overlayFavoriteBtn.addEventListener("click", () => {
            if (dom.currentFavoriteToggle) dom.currentFavoriteToggle.click();
        });
    }
    // 播放栏新增按钮：收藏代理（点真实收藏按钮）、加号（当前歌曲追加进播放列表）、
    // 历史与队列（切到对应视图）。播放栏条带点击会打开歌词浮层，这些按钮在条带
    // 外，不会误触发。
    if (dom.playerBarFavBtn) {
        dom.playerBarFavBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (dom.currentFavoriteToggle) dom.currentFavoriteToggle.click();
        });
    }
    if (dom.playerBarAddBtn) {
        dom.playerBarAddBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const b = bridge();
            const song = b && typeof b.getCurrentSong === "function" ? b.getCurrentSong() : null;
            if (!song) { notify("先选一首歌", "warning"); return; }
            if (typeof b.appendToPlaylist === "function") b.appendToPlaylist([song]);
        });
    }
    if (dom.playerBarHistoryBtn) {
        dom.playerBarHistoryBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            showView("history");
        });
    }
    if (dom.playerBarQueueBtn) {
        dom.playerBarQueueBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            showView("now-playing");
        });
    }
    if (dom.nowPlayingLyricLine) {
        const openFromLyricLine = (e) => {
            e.stopPropagation();
            openOverlay();
        };
        dom.nowPlayingLyricLine.addEventListener("click", openFromLyricLine);
        dom.nowPlayingLyricLine.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOverlay(); }
        });
    }
    if (dom.audioPlayer) {
        dom.audioPlayer.addEventListener("timeupdate", () => {
            if (isOverlayOpen()) syncOverlayProgress();
        });
        dom.audioPlayer.addEventListener("loadedmetadata", () => {
            if (isOverlayOpen()) syncOverlayProgress();
        });
    }
    if (dom.overlayProgress && dom.audioPlayer) {
        dom.overlayProgress.addEventListener("input", () => {
            const value = Number(dom.overlayProgress.value) || 0;
            dom.audioPlayer.currentTime = value;
            syncOverlayProgress();
        });
    }
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (isOverlayOpen()) {
            e.preventDefault();
            closeOverlay();
            return;
        }
        if (currentView === "search") {
            const activeEl = document.activeElement;
            const isInputActive = activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");
            if (!isInputActive && dom.closeSearchBtn) dom.closeSearchBtn.click();
        }
    });
}

/* ---------------- 导入外部歌单 ---------------- */

function bindImport() {
    if (dom.sidebarImportFileBtn) {
        dom.sidebarImportFileBtn.addEventListener("click", () => {
            if (dom.importPlaylistBtn) dom.importPlaylistBtn.click();
        });
    }
    if (dom.sidebarImportLinkBtn) {
        dom.sidebarImportLinkBtn.addEventListener("click", () => importLinkPlaylist());
    }
    if (dom.sidebarImportLinkInput) {
        dom.sidebarImportLinkInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                importLinkPlaylist();
            }
        });
    }
}

async function importLinkPlaylist() {
    const input = dom.sidebarImportLinkInput;
    const raw = (input?.value || "").trim();
    if (!raw) {
        notify("先粘贴一条歌单链接", "warning");
        return;
    }
    // 链接识别：网易云走原有雷达接口；QQ / 酷狗 / 酷我走服务端直取官方歌单接口。
    let platform = "";
    let playlistId = "";
    const neteaseMatch = raw.match(/playlist\?id=(\d+)/i) || raw.match(/[?&]id=(\d+)/i);
    if (/(music\.163\.com|y\.music\.163\.com)/i.test(raw) && neteaseMatch) {
        platform = "netease";
        playlistId = neteaseMatch[1];
    } else if (/y\.qq\.com/i.test(raw)) {
        const m = raw.match(/playlist\/(\d+)/i) || raw.match(/playsquare\/(\d+)/i) || raw.match(/disstid=(\d+)/i) || raw.match(/[?&]id=(\d+)/i);
        if (m) { platform = "tencent"; playlistId = m[1]; }
    } else if (/kugou\.com/i.test(raw)) {
        const m = raw.match(/single\/(\d+)/i) || raw.match(/plist\/list\/(\d+)/i) || raw.match(/plist\/index\/(\d+)/i) || raw.match(/specialid=(\d+)/i);
        if (m) { platform = "kugou"; playlistId = m[1]; }
    } else if (/kuwo\.cn/i.test(raw)) {
        const m = raw.match(/playlist_detail\/(\d+)/i) || raw.match(/play_detail\/(\d+)/i) || raw.match(/[?&]pid=(\d+)/i);
        if (m) { platform = "kuwo"; playlistId = m[1]; }
    }
    if (!platform || !playlistId) {
        notify("暂支持网易云、QQ、酷狗、酷我歌单链接，咪咕与哔哩哔哩正在接入中", "warning");
        return;
    }
    notify("正在导入歌单…", "info");
    try {
        let songs = [];
        if (platform === "netease") {
            const data = await API.getRadarPlaylist(playlistId, { limit: 200 });
            const tracks = Array.isArray(data) ? data : (data?.tracks || data?.result?.tracks || data?.playlist?.tracks || []);
            songs = tracks.map((s) => normalizeSong(s, "netease")).filter(Boolean);
        } else {
            const data = await API.importPlaylist(platform, playlistId);
            if (data?.error) throw new Error(data.error);
            const list = Array.isArray(data?.songs) ? data.songs : [];
            songs = list.map((s) => normalizeSong(s, platform)).filter(Boolean);
        }
        if (songs.length === 0) {
            notify("这个歌单没有取到歌曲", "warning");
            return;
        }
        const b = bridge();
        if (b && typeof b.replacePlaylistWith === "function") {
            b.replacePlaylistWith(songs);
            notify(`已导入歌单，共 ${songs.length} 首`, "success");
            showView("now-playing");
            const tab = document.getElementById("playlistTab");
            if (tab) tab.click();
            if (input) input.value = "";
        }
    } catch (err) {
        notify("歌单导入失败，请稍后重试", "error");
    }
}

/* ---------------- 界面重组（运行时搬移已有节点，事件绑定不受影响） ---------------- */

/**
 * 把文件里原有的 .header / .search-area / .main-content / .controls 等节点
 * 搬进新壳子的插槽里：只移动节点本身，不重建、不改 id，所有已绑定的事件
 * 与 dom.js 缓存的引用都保持有效。搬空后的旧壳子移除。
 */
function restructureShell() {
    const brandWrap = document.querySelector(".header-brand-wrap");
    const brandSlot = document.getElementById("sidebarBrandSlot");
    if (brandWrap && brandSlot) brandSlot.appendChild(brandWrap);

    const warning = document.querySelector("#mainContainer > .header .warning");
    const footSlot = document.getElementById("sidebarFootSlot");
    if (warning && footSlot) footSlot.appendChild(warning);

    const actionsSlot = document.getElementById("topbarActionsSlot");
    const themeBtn = document.getElementById("themeToggleButton");
    if (themeBtn && actionsSlot) actionsSlot.appendChild(themeBtn);
    const layoutBtn = document.getElementById("layoutToggleBtn");
    if (layoutBtn && actionsSlot) actionsSlot.appendChild(layoutBtn);
    // 设置齿轮按钮：initSettings 在 initViews 之后运行，届时按 id 绑定点击打开设置。
    if (actionsSlot && !document.getElementById("openSettingsBtn")) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.id = "openSettingsBtn";
        btn.className = "topbar-icon-btn";
        btn.setAttribute("aria-label", "打开设置");
        btn.title = "设置（双击左上角 Logo 也可打开）";
        btn.innerHTML = '<svg class="apple-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
        actionsSlot.appendChild(btn);
    }

    // 搜索输入与搜索按钮 → 顶栏（旧音源下拉随搜索条一起搬入顶栏后由 CSS 藏起，
    // 平台切换改由顶栏右侧的平台下拉负责；旧下拉的菜单与标签更新逻辑保持运行）。
    const searchBar = document.querySelector(".search-bar-unified");
    const searchSlot = document.getElementById("topbarSearchSlot");
    if (searchBar && searchSlot) searchSlot.appendChild(searchBar);
    const searchBtn = document.getElementById("searchBtn");
    if (searchBtn && searchSlot) searchSlot.appendChild(searchBtn);

    // 搜索结果区 → 搜索视图
    const searchViewSlot = document.getElementById("searchViewSlot");
    if (searchViewSlot) {
        const searchHeader = document.querySelector(".search-header");
        if (searchHeader) searchViewSlot.appendChild(searchHeader);
        const toolbarRow = document.createElement("div");
        toolbarRow.className = "search-view-toolbar-row";
        const toolbar = document.querySelector(".search-results-toolbar");
        if (toolbar) toolbarRow.appendChild(toolbar);
        const closeBtn = document.getElementById("closeSearchBtn");
        if (closeBtn) toolbarRow.appendChild(closeBtn);
        searchViewSlot.appendChild(toolbarRow);
        const searchResults = document.getElementById("searchResults");
        if (searchResults) searchViewSlot.appendChild(searchResults);
        const searchHandle = document.getElementById("mobileSearchHandle");
        if (searchHandle) searchViewSlot.appendChild(searchHandle);
    }
    document.querySelector(".search-controls-wrapper")?.remove();
    document.querySelector("[data-legacy-search-area]")?.remove();
    document.querySelector("#mainContainer > .header")?.remove();

    // 正在播放视图
    const mainContent = document.querySelector(".main-content");
    const nowSlot = document.getElementById("nowPlayingSlot");
    if (mainContent && nowSlot) nowSlot.appendChild(mainContent);

    // 底部播放栏
    const controls = document.querySelector(".controls");
    const controlsSlot = document.getElementById("playerbarControlsSlot");
    if (controls && controlsSlot) controlsSlot.appendChild(controls);

    // 进度条提到播放栏的第一个孩子、独占顶部一行（通栏细线）。
    // 原来它在 .controls 里，绝对定位的方案会和播放器内容重合；改成正常
    // 文档流后，细线行与按钮行之间隔着播放栏的 gap，绝不重合。节点移动
    // 不影响已绑定的事件与 dom.js 缓存的引用。
    const playerBar = document.querySelector(".app-playerbar");
    const progressContainer = document.querySelector(".progress-container");
    if (playerBar && progressContainer && progressContainer.parentElement !== playerBar) {
        playerBar.insertBefore(progressContainer, playerBar.firstChild);
    }

    // 歌词面板 → 歌词浮层右侧
    const lyrics = document.getElementById("lyrics");
    const lyricsSlot = document.getElementById("overlayLyricsSlot");
    if (lyrics && lyricsSlot) lyricsSlot.appendChild(lyrics);
}

/* ---------------- 初始化 ---------------- */

export function initViews() {
    restructureShell();
    buildPlatformSelect();
    bindSidebar();
    bindPlayerBarAndOverlay();
    bindHistoryUI();
    bindImport();
    initNowPlayingMirror();
    initHistoryRecorder();
    window.SolaraViews = {
        show: showView,
        onSearchHidden,
        getCurrent: () => currentView,
    };
    // 启动时的恢复流程（搜索记录/D1 漫游）可能改 searchSource，晚一点再对齐一次下拉。
    window.setTimeout(syncPlatformSelect, 500);
    showView("discover");
}
