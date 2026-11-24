/**
 * Solara 核心音频引擎与播放管线 (HTML5 Audio, 播放模式, 进度/音量同步, 自动切歌)
 */

import { API, getApiFallbackBases } from "../constants.js";
import { safeSetLocalStorage, preferHttpsUrl, buildAudioProxyUrl } from "./storage.js";
import { showNotification } from "../features/settings.js";
import { getSongKey } from "../features/playlist.js";
import { ensureFavoriteSongsArray } from "../features/favorites.js";
import { getCustomMusicUrl, resolveMusicUrlFromEntry, getEnabledLxScriptEntries } from "../features/custom-sources.js";

export const playModeTexts = {
    "list": "列表循环",
    "single": "单曲循环",
    "random": "随机播放"
};

// 短期音频地址内存缓存（15分钟 TTL），避免用户在播放列表内切歌反复请求 types=url
const audioUrlMemoryCache = new Map();
const AUDIO_URL_CACHE_TTL = 15 * 60 * 1000;

export const APPLE_SVG_ICONS = {
    play: `<svg class="apple-svg-icon icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.5v13a1.5 1.5 0 0 0 2.3 1.28l10.5-6.5a1.5 1.5 0 0 0 0-2.56L9.3 4.22A1.5 1.5 0 0 0 7 5.5z"/></svg>`,
    pause: `<svg class="apple-svg-icon icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1zm11 0a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1z"/></svg>`,
    repeatList: `<svg class="apple-svg-icon icon-repeat-list" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
    repeatSingle: `<svg class="apple-svg-icon icon-repeat-single" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="15.5" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif" font-size="9.5" font-weight="900" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>`,
    shuffle: `<svg class="apple-svg-icon shuffle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.6-8.6c.8-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.4c1.3 0 2.5.6 3.3 1.7l1.8 2.3"/><path d="M14.9 14.7l1.8 2.3c.8 1.1 2 1.7 3.3 1.7H22"/><path d="m18 22 4-4-4-4"/></svg>`
};

export function getActivePlayMode(state) {
    return state.currentList === "favorite" ? state.favoritePlayMode : state.playMode;
}

export function getLastNonRandomMode(state) {
    if (state.currentList === "favorite") {
        return state.favoriteLastNonRandomMode || "list";
    }
    return state.playlistLastNonRandomMode || "list";
}

export function rememberLastNonRandomMode(state) {
    const currentMode = getActivePlayMode(state);
    if (currentMode === "random") {
        return;
    }
    const mode = currentMode || "list";
    if (state.currentList === "favorite") {
        state.favoriteLastNonRandomMode = mode;
    } else {
        state.playlistLastNonRandomMode = mode;
    }
}

export function updateShuffleButtonUI(state, dom) {
    const button = dom.shuffleToggleBtn;
    if (!button) {
        return;
    }
    const mode = getActivePlayMode(state);
    const isRandom = mode === "random";
    button.setAttribute("aria-pressed", isRandom ? "true" : "false");
    button.classList.toggle("active", isRandom);
    button.classList.toggle("is-random", isRandom);
    button.innerHTML = APPLE_SVG_ICONS.shuffle;
    const label = isRandom ? "随机播放：已开启 (点击关闭)" : "随机播放：已关闭 (点击开启)";
    button.title = label;
    button.setAttribute("aria-label", label);
}

export function updatePlayModeUI(state, dom) {
    const mode = getActivePlayMode(state);
    if (dom.playModeBtn) {
        const isSingle = mode === "single";
        const isRandom = mode === "random";
        if (isSingle) {
            dom.playModeBtn.innerHTML = APPLE_SVG_ICONS.repeatSingle;
        } else if (isRandom) {
            dom.playModeBtn.innerHTML = APPLE_SVG_ICONS.shuffle;
        } else {
            dom.playModeBtn.innerHTML = APPLE_SVG_ICONS.repeatList;
        }
        dom.playModeBtn.classList.toggle("is-single", isSingle);
        dom.playModeBtn.classList.toggle("is-random", isRandom);
        dom.playModeBtn.classList.toggle("active", isSingle || isRandom);
        dom.playModeBtn.setAttribute("aria-pressed", (isSingle || isRandom) ? "true" : "false");
        const label = isSingle ? "当前模式：单曲循环" : (isRandom ? "当前模式：随机播放" : "当前模式：列表循环");
        dom.playModeBtn.title = label;
        dom.playModeBtn.setAttribute("aria-label", label);
    }
    updateShuffleButtonUI(state, dom);
}

export function setPlayMode(mode, state, dom, callbacks = {}, { announce = true } = {}) {
    const validModes = ["list", "single", "random"];
    if (!validModes.includes(mode)) {
        return getActivePlayMode(state);
    }
    const isFavoriteList = state.currentList === "favorite";
    const key = isFavoriteList ? "favoritePlayMode" : "playMode";
    const previousMode = state[key];
    if (previousMode === mode) {
        updatePlayModeUI(state, dom);
        return mode;
    }

    state[key] = mode;
    if (mode !== "random") {
        if (isFavoriteList) {
            state.favoriteLastNonRandomMode = mode;
        } else {
            state.playlistLastNonRandomMode = mode;
        }
    }

    if (isFavoriteList) {
        if (typeof callbacks.saveFavoriteState === "function") callbacks.saveFavoriteState();
    } else {
        if (typeof callbacks.savePlayerState === "function") callbacks.savePlayerState();
    }

    updatePlayModeUI(state, dom);

    const modeText = playModeTexts[mode] || playModeTexts.list;
    window.__solaraDebugLog?.(`[模式切换] 播放模式已切换为: ${modeText}`);

    if (announce) {
        showNotification(`播放模式: ${modeText}`, "info", dom);
    }

    return mode;
}

export function togglePlayMode(state, dom, callbacks = {}, isMobileView = false) {
    const modes = isMobileView ? ["list", "single", "random"] : ["list", "single"];
    const currentMode = getActivePlayMode(state);
    let currentIndex = modes.indexOf(currentMode);
    if (currentIndex === -1) {
        currentIndex = 0;
    }
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    if (nextMode === "random") {
        rememberLastNonRandomMode(state);
    }
    setPlayMode(nextMode, state, dom, callbacks);
}

export function toggleShuffleMode(state, dom, callbacks = {}) {
    const currentMode = getActivePlayMode(state);
    if (currentMode === "random") {
        const fallback = getLastNonRandomMode(state);
        setPlayMode(fallback, state, dom, callbacks);
        return;
    }
    rememberLastNonRandomMode(state);
    setPlayMode("random", state, dom, callbacks);
}

export function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "00:00";
    }
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function updatePlayPauseButton(dom) {
    if (!dom.playPauseBtn || !dom.audioPlayer) return;
    const isPlaying = !dom.audioPlayer.paused && !dom.audioPlayer.ended;
    dom.playPauseBtn.innerHTML = isPlaying ? APPLE_SVG_ICONS.pause : APPLE_SVG_ICONS.play;
    dom.playPauseBtn.title = isPlaying ? "暂停" : "播放";
    if (typeof document !== "undefined" && document.body) {
        document.body.classList.toggle("is-playing", isPlaying);
    }
    const visualizer = typeof document !== "undefined" ? document.getElementById("audioVisualizer") : null;
    if (visualizer) {
        visualizer.classList.toggle("playing", isPlaying);
    }
}

export function updateProgressBarBackground(dom, value = Number(dom.progressBar?.value), max = Number(dom.progressBar?.max)) {
    if (!dom.progressBar) return;
    const duration = Number.isFinite(max) && max > 0 ? max : 0;
    const progressValue = Number.isFinite(value) ? Math.max(value, 0) : 0;
    const percent = duration > 0 ? Math.min(progressValue / duration, 1) * 100 : 0;
    dom.progressBar.style.setProperty("--progress", `${percent}%`);
}

export function updateVolumeSliderBackground(dom, volume = dom.audioPlayer?.volume) {
    if (!dom.volumeSlider) return;
    const clamped = Math.min(Math.max(Number.isFinite(volume) ? volume : 0, 0), 1);
    dom.volumeSlider.style.setProperty("--volume-progress", `${clamped * 100}%`);
}

export function updateVolumeIcon(dom, volume) {
    if (!dom.volumeIcon) return;
    const clamped = Math.min(Math.max(Number.isFinite(volume) ? volume : 0, 0), 1);
    
    // 如果是 SVG 图标（Apple 矢量图标），动态更新内部矢量路径
    if (dom.volumeIcon.tagName && dom.volumeIcon.tagName.toLowerCase() === "svg") {
        if (clamped === 0) {
            // 静音状态 (扬声器 + 叉号)
            dom.volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>';
        } else if (clamped < 0.4) {
            // 低音量状态 (扬声器 + 单波纹)
            dom.volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
        } else {
            // 高音量状态 (扬声器 + 双波纹)
            dom.volumeIcon.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
        }
        return;
    }

    // 兼容普通 <i> 标签（FontAwesome）
    let icon = "fa-volume-high";
    if (clamped === 0) {
        icon = "fa-volume-xmark";
    } else if (clamped < 0.4) {
        icon = "fa-volume-low";
    }
    dom.volumeIcon.setAttribute("class", `fas ${icon}`);
}

export function setAudioCurrentTime(time, state, dom) {
    if (!Number.isFinite(time) || !dom.audioPlayer) return;
    const duration = dom.audioPlayer.duration || Number(dom.progressBar?.max) || 0;
    const clamped = duration > 0 ? Math.min(Math.max(time, 0), duration) : Math.max(time, 0);
    try {
        dom.audioPlayer.currentTime = clamped;
    } catch (error) {
        console.warn("设置播放进度失败", error);
    }
    if (dom.progressBar) dom.progressBar.value = clamped;
    if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = formatTime(clamped);
    updateProgressBarBackground(dom, clamped, duration);
    if (state.currentList === "favorite") {
        state.favoritePlaybackTime = clamped;
    } else {
        state.currentPlaybackTime = clamped;
    }
}

/** 歌曲全长（秒）：搜索/榜单/导入结果里带的 duration（秒）或 dt（毫秒）。 */
function expectedSongDurationSeconds(song) {
    if (!song || typeof song !== "object") return null;
    const seconds = Number(song.duration);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
    const dt = Number(song.dt);
    if (Number.isFinite(dt) && dt > 0) return dt / 1000;
    return null;
}

/**
 * 试听片段判定：实际播出的音频远短于歌曲全长（不到七成）时，判定为
 * 试听片段。任一时长未知/无效时不判定（不断掉可播的歌）。
 */
function isTrialClipDuration(actualDuration, expectedDuration) {
    if (!Number.isFinite(actualDuration) || actualDuration <= 0) return false;
    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return false;
    return actualDuration < expectedDuration * 0.7;
}

const PLATFORM_SHORT_LABELS = {
    netease: "网易云",
    tencent: "QQ",
    kugou: "酷狗",
    kuwo: "酷我",
    migu: "咪咕",
    joox: "JOOX",
    bilibili: "哔哩哔哩",
};

/** 歌名/歌手归一化：去空格、大小写与常见标点，便于跨平台比对。 */
function normalizeSongText(text) {
    return String(text || "").toLowerCase().replace(/[\s·•・、，,。！!？?：:；;""''「」『』《》〈〉()（）【】[\]{}_~～\-—–]/g, "");
}

/** 去掉歌名里的括号后缀（Live/伴奏/翻唱标注等），只要主歌名。 */
function baseSongName(name) {
    return String(name || "").replace(/[(（\[][^\]）)]*[\]）)]/g, "").trim();
}

function artistTokens(artist) {
    const raw = Array.isArray(artist) ? artist.join("/") : String(artist || "");
    return raw.split(/[/／&,&、,，;；+＋]/).map((t) => normalizeSongText(t)).filter(Boolean);
}

function artistsMatch(originalArtist, candidateArtist) {
    const a = artistTokens(originalArtist);
    const b = artistTokens(candidateArtist);
    if (a.length === 0 || b.length === 0) return false;
    return a.some((x) => b.some((y) => x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)))));
}

/**
 * 在候选列表里找原歌曲的同名完整版：歌名须对上（严格模式要求全名
 * 一致；放宽模式允许去掉括号后缀），歌手须对上（避免顶错成翻唱版），
 * 已知时长时与原全长相差不能过大。返回最佳匹配或 null。
 */
function findCrossPlatformSubstitute(original, candidates, strict, origExpectedDuration) {
    const origName = normalizeSongText(original?.name);
    const origBase = normalizeSongText(baseSongName(original?.name));
    const origAlbum = normalizeSongText(original?.album);
    let best = null;
    let bestScore = -1;
    for (const cand of candidates) {
        if (!cand || !cand.name || !cand.id) continue;
        if (String(cand.id) === String(original.id) && (cand.source || "") === (original.source || "")) continue;
        const candName = normalizeSongText(cand.name);
        const candBase = normalizeSongText(baseSongName(cand.name));
        const nameExact = origName !== "" && candName === origName;
        const nameBase = !nameExact && origBase !== "" && candBase === origBase;
        if (!nameExact && !( !strict && nameBase)) continue;
        if (!artistsMatch(original.artist, cand.artist)) continue;
        const candExpected = expectedSongDurationSeconds(cand);
        if (Number.isFinite(origExpectedDuration) && origExpectedDuration > 0
            && Number.isFinite(candExpected) && candExpected > 0
            && (candExpected < origExpectedDuration * 0.6 || candExpected > origExpectedDuration * 1.6)) continue;
        let score = nameExact ? 2 : 1;
        if (origAlbum && normalizeSongText(cand.album) === origAlbum) score += 1;
        if (score > bestScore) {
            best = cand;
            bestScore = score;
        }
    }
    return best;
}

/**
 * 跨平台代播：用网易云/酷我搜同名歌曲，找歌名与歌手都对得上的
 * 完整版（原平台除外）。每个平台最多搜一次，先精确歌名、再放宽。
 */
async function findFullVersionSubstitute(song, expectedDuration, log) {
    const keyword = (song?.name || "").trim();
    if (!keyword) return null;
    const platforms = ["netease", "kuwo"].filter((p) => p !== (song.source || "netease"));
    const searched = [];
    for (const platform of platforms) {
        try {
            const results = await API.searchWithFallback(keyword, platform, 20, 1);
            if (Array.isArray(results) && results.length > 0) searched.push(results);
        } catch (err) {
            console.warn(`[跨平台代播] ${platform} 搜索失败:`, err);
        }
    }
    for (const strict of [true, false]) {
        for (const results of searched) {
            const match = findCrossPlatformSubstitute(song, results, strict, expectedDuration);
            if (match) return { song: match };
        }
    }
    return null;
}

export function waitForAudioReady(player) {
    if (!player) return Promise.resolve();
    if (player.readyState >= 1) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            player.removeEventListener('loadedmetadata', onLoaded);
            player.removeEventListener('error', onError);
        };
        const onLoaded = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error('音频加载失败'));
        };
        player.addEventListener('loadedmetadata', onLoaded, { once: true });
        player.addEventListener('error', onError, { once: true });
    });
}

let currentPlaybackToken = 0;

export function cancelPendingPlayback() {
    currentPlaybackToken++;
}

export async function playSong(song, options = {}, state, dom, callbacks = {}, debugLogger = null) {
    const myToken = ++currentPlaybackToken;
    const { autoplay = true, startTime = 0, preserveProgress = false, isRetry = false } = options;

    state.audioReadyForPalette = false;

    const log = (msg) => {
        if (typeof debugLogger === "function") debugLogger(msg);
        else if (typeof window !== "undefined" && typeof window.__solaraDebugLog === "function") window.__solaraDebugLog(msg);
    };

    try {
        if (typeof callbacks.updateCurrentSongInfo === "function") {
            callbacks.updateCurrentSongInfo(song, { loadArtwork: false });
        }

        // 先停掉正在播的上一首并复位进度显示：取新歌地址在下面抛错时，
        // 旧音频若还响着，标题却已换成新歌，就会“放的是上一首、显示的是新歌”。
        // 这里先停，失败时保持安静 + 新歌标题 + 报错提示；成功时再正常起播。
        dom.audioPlayer.pause();
        state.currentSong = song;
        state.currentAudioUrl = null;
        if (dom.progressBar) {
            dom.progressBar.value = 0;
            dom.progressBar.max = 0;
            updateProgressBarBackground(dom, 0, 1);
        }
        if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = "00:00";
        if (dom.durationDisplay) dom.durationDisplay.textContent = "00:00";

        const quality = state.playbackQuality || '320';
        log(`[音频播放] 准备加载: ${song.name || "未知歌曲"} (音质: ${quality}k, 来源: ${song.source || 'netease'})`);

        const cacheKey = `${song.source || 'netease'}_${song.id}_${quality}`;
        // 试听片段判定用的全长：有全长信息时，解析出的地址若远短于全长
        // 就换下一个音源接着试，直到播出整首；没有全长信息时不判断。
        // 跨平台代播的歌曲本身常无全长信息，沿用原歌曲的全长作判断。
        const ownExpectedDuration = expectedSongDurationSeconds(song);
        const fallbackExpectedDuration = Number(options.fallbackExpectedDuration);
        const expectedDuration = ownExpectedDuration
            ?? (Number.isFinite(fallbackExpectedDuration) && fallbackExpectedDuration > 0 ? fallbackExpectedDuration : null);

        // 试某条解析出的地址：逐个变体加载元数据；只有播出整首（或无法
        // 判断时长）才算选中。试听片段返回 { clip: true }，由调用方换下
        // 一个音源；加载失败返回 { error }。
        const tryLoadCandidate = async (resolvedUrl) => {
            const proxiedAudioUrl = buildAudioProxyUrl(resolvedUrl);
            const preferredAudioUrl = preferHttpsUrl(resolvedUrl);
            const variants = Array.from(
                new Set([proxiedAudioUrl, preferredAudioUrl, resolvedUrl].filter(Boolean))
            );
            let lastError = null;
            let sawClipVariant = false;
            for (const candidateUrl of variants) {
                if (myToken !== currentPlaybackToken) return { superseded: true };
                dom.audioPlayer.src = candidateUrl;
                dom.audioPlayer.load();
                try {
                    await waitForAudioReady(dom.audioPlayer);
                } catch (error) {
                    lastError = error;
                    continue;
                }
                if (isTrialClipDuration(dom.audioPlayer.duration, expectedDuration)) {
                    log(`[试听片段] 地址只有 ${Math.round(dom.audioPlayer.duration)} 秒（全长约 ${Math.round(expectedDuration)} 秒），换下一个音源: ${song.name}`);
                    dom.audioPlayer.pause();
                    // 同一地址的不同变体可能是同一文件的不同取法：全部变体
                    // 都短才算试听片段，避免代理取法造成的误判。
                    sawClipVariant = true;
                    continue;
                }
                return { selectedUrl: candidateUrl, resolvedUrl };
            }
            if (sawClipVariant) return { clip: true };
            return { error: lastError || new Error('音频加载失败') };
        };

        state.currentSong = song;
        state.currentAudioUrl = null;
        dom.audioPlayer.pause();

        if (state.currentList === "favorite") {
            if (!preserveProgress) {
                state.favoritePlaybackTime = 0;
                state.favoriteLastSavedPlaybackTime = 0;
                safeSetLocalStorage('favoritePlaybackTime', '0');
            } else if (startTime > 0) {
                state.favoritePlaybackTime = startTime;
                state.favoriteLastSavedPlaybackTime = startTime;
            }
        } else {
            if (!preserveProgress) {
                state.currentPlaybackTime = 0;
                state.lastSavedPlaybackTime = 0;
                safeSetLocalStorage('currentPlaybackTime', '0');
            } else if (startTime > 0) {
                state.currentPlaybackTime = startTime;
                state.lastSavedPlaybackTime = startTime;
            }
        }

        state.pendingSeekTime = startTime > 0 ? startTime : null;

        // 逐个音源解析、逐个验时长：缓存 → 洛雪脚本（启用顺序）→ /proxy
        // 上游轮询。某条地址是试听片段就换下一条，直到播出整首；只有
        // 选中的地址才进缓存，试听片段不缓存。
        let selectedAudioUrl = null;
        let acceptedResolvedUrl = null;
        let lastAudioError = null;
        let sawTrialClip = false;

        // 1. 内存缓存（命中时同样验时长：缓存里可能是旧逻辑存下的片段）。
        if (!isRetry && audioUrlMemoryCache.has(cacheKey)) {
            const cachedItem = audioUrlMemoryCache.get(cacheKey);
            if (Date.now() - cachedItem.timestamp < AUDIO_URL_CACHE_TTL && cachedItem.url) {
                log(`[音频缓存] 命中内存直链: ${song.name} (${quality}k)，省去 1 次网络请求`);
                const tried = await tryLoadCandidate(cachedItem.url);
                if (tried.superseded) return;
                if (tried.selectedUrl) {
                    selectedAudioUrl = tried.selectedUrl;
                    acceptedResolvedUrl = cachedItem.url;
                } else {
                    audioUrlMemoryCache.delete(cacheKey);
                    if (tried.clip) sawTrialClip = true;
                    else lastAudioError = tried.error;
                }
            } else {
                audioUrlMemoryCache.delete(cacheKey);
            }
        }

        // 2. 洛雪脚本：逐条解析、逐条验时长。
        if (!selectedAudioUrl) {
            for (const entry of getEnabledLxScriptEntries()) {
                if (myToken !== currentPlaybackToken) return;
                let customUrl = null;
                try {
                    customUrl = await resolveMusicUrlFromEntry(entry, song, quality);
                } catch (err) {
                    console.warn("自定义音源解析异常，尝试下一条:", err);
                }
                if (!customUrl) continue;
                log(`[音频解析] 自定义音源解析成功: ${song.name}`);
                const tried = await tryLoadCandidate(customUrl);
                if (tried.superseded) return;
                if (tried.selectedUrl) {
                    selectedAudioUrl = tried.selectedUrl;
                    acceptedResolvedUrl = customUrl;
                    break;
                }
                if (tried.clip) sawTrialClip = true;
                else lastAudioError = tried.error;
            }
        }

        // 3. 默认 /proxy 轮询：按“当前上游 → 其他已启用 api → 默认上游”
        // 逐个试，拿到地址后同样验时长。
        if (!selectedAudioUrl) {
            if (isRetry) {
                log(`[音频重试] 正在通过非缓存链路重试请求...`);
            }
            for (const base of getApiFallbackBases()) {
                if (myToken !== currentPlaybackToken) return;
                let audioUrl = API.getSongUrlWithBase(song, quality, base);
                if (isRetry) {
                    audioUrl += '&nocache=true';
                }
                log(`[音频解析] 请求接口: ${audioUrl}`);
                let data = null;
                try {
                    data = await API.fetchJson(audioUrl);
                } catch (err) {
                    console.warn(`[轮询] 上游 ${base || "默认上游"} 取播放地址失败，尝试下一个音源:`, err);
                    continue;
                }
                if (!data || !data.url) continue;
                const tried = await tryLoadCandidate(data.url);
                if (tried.superseded) return;
                if (tried.selectedUrl) {
                    selectedAudioUrl = tried.selectedUrl;
                    acceptedResolvedUrl = data.url;
                    break;
                }
                if (tried.clip) sawTrialClip = true;
                else lastAudioError = tried.error;
            }
        }

        if (myToken !== currentPlaybackToken) {
            return;
        }

        if (!selectedAudioUrl) {
            const clipError = new Error('只找到试听片段，未找到完整歌曲');
            clipError.noRetry = true;
            clipError.reason = 'trial-clip';
            if (sawTrialClip && !options.noCrossFallback) {
                // 跨平台代播：原平台只有试听片段时，用网易云/酷我的同名
                // 完整版顶上（歌名与歌手须同时对上，避免顶错成翻唱版）。
                const substitute = await findFullVersionSubstitute(song, expectedDuration, log);
                if (substitute) {
                    const fromLabel = PLATFORM_SHORT_LABELS[song.source || "netease"] || "";
                    const toLabel = PLATFORM_SHORT_LABELS[substitute.song.source || "netease"] || "";
                    showNotification(`《${song.name}》${fromLabel}只有试听片段，已改播${toLabel}完整版`, "info", dom);
                    try {
                        return await playSong(
                            substitute.song,
                            { ...options, noCrossFallback: true, fallbackExpectedDuration: expectedDuration },
                            state, dom, callbacks, debugLogger,
                        );
                    } catch (subError) {
                        // 代播也失败：按原歌曲的片段结论处理，不再重试原链路。
                        throw clipError;
                    }
                }
            }
            if (sawTrialClip) {
                // 所有音源都只给了试听片段：重试也拿不到整首，直接跳过
                // 重试、走自动跳歌，避免反复等同一批超时。
                throw clipError;
            }
            throw lastAudioError || new Error('无法获取音频播放地址');
        }

        if (acceptedResolvedUrl) {
            audioUrlMemoryCache.set(cacheKey, { url: acceptedResolvedUrl, timestamp: Date.now() });
            log(`[音频地址] 解析就绪: ${acceptedResolvedUrl.slice(0, 50)}...`);
        }

        if (myToken !== currentPlaybackToken) {
            return;
        }

        state.currentAudioUrl = selectedAudioUrl;

        if (state.pendingSeekTime != null) {
            setAudioCurrentTime(state.pendingSeekTime, state, dom);
            state.pendingSeekTime = null;
        } else {
            setAudioCurrentTime(dom.audioPlayer.currentTime || 0, state, dom);
        }

        state.lastSavedPlaybackTime = state.currentPlaybackTime;

        let playPromise = null;
        log(`[音频解码] 缓冲就绪 (${autoplay ? '开始自动播放' : '静音待播'})`);

        if (autoplay) {
            playPromise = dom.audioPlayer.play();
            if (playPromise !== undefined) {
                playPromise.catch(async error => {
                    console.error('播放失败:', error);
                    log(`[音频异常] 播放失败: ${error?.message || error}`);
                    if (!isRetry) {
                        try {
                            await playSong(song, { ...options, isRetry: true }, state, dom, callbacks, debugLogger);
                        } catch (retryError) {
                            showNotification('播放失败，请检查网络连接', 'error', dom);
                        }
                    } else {
                        showNotification('播放失败，请检查网络连接', 'error', dom);
                    }
                });
            }
        } else {
            dom.audioPlayer.pause();
            updatePlayPauseButton(dom);
        }

        // 异步延迟调度封面、歌词与极光色彩应用
        if (typeof callbacks.scheduleDeferredSongAssets === "function") {
            callbacks.scheduleDeferredSongAssets(song, playPromise);
        }

        if (typeof window.__SOLARA_UPDATE_MEDIA_METADATA === 'function') {
            window.__SOLARA_UPDATE_MEDIA_METADATA();
        }
    } catch (error) {
        console.error('播放歌曲失败:', error);
        // 已被更新的播放请求取代：静默返回，不重试、不跳歌、不报错，
        // 避免旧请求的重试把用户刚点的歌顶掉、或弹出过时的失败提示。
        if (myToken !== currentPlaybackToken) return;
        // noRetry（如所有音源都只给试听片段）是确定性结论，重试也拿不到
        // 整首：跳过重试，直接清理并走自动跳歌。
        if (!isRetry && !(error && error.noRetry)) {
            return playSong(song, { ...options, isRetry: true }, state, dom, callbacks, debugLogger);
        }
        // 最终失败：清掉音频源，避免残留上一首的地址被播放键误播。
        if (dom.audioPlayer) {
            try {
                dom.audioPlayer.pause();
                dom.audioPlayer.removeAttribute("src");
                dom.audioPlayer.src = "";
                dom.audioPlayer.load();
            } catch (e) {
                console.warn("清理失败音频源异常:", e);
            }
        }
        // 复位进度显示：被拒的试听片段加载过元数据，时长栏会残留它的
        // 短时长，不复位就会显示“00:00 / 00:24”这种误导数字。
        if (dom.progressBar) {
            dom.progressBar.value = 0;
            dom.progressBar.max = 0;
            updateProgressBarBackground(dom, 0, 1);
        }
        if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = "00:00";
        if (dom.durationDisplay) dom.durationDisplay.textContent = "00:00";
        state.isPlaying = false;
        updatePlayPauseButton(dom);
        // 播不了就跳下一首（回调接管后不再抛错，避免再弹通用失败提示；
        // 没有回调时保持原有抛错行为）。reason 说明失败原因（如试听片段），
        // 供跳歌提示如实说明。
        if (typeof callbacks.onPlaybackFailed === "function") {
            const handled = callbacks.onPlaybackFailed(song, options.autoSkipChain, error && error.reason);
            if (handled) return;
        }
        throw error;
    } finally {
        if (typeof callbacks.savePlayerState === "function") {
            callbacks.savePlayerState();
        }
    }
}

export function autoPlayNext(state, dom, callbacks = {}) {
    if (dom.audioPlayer && dom.audioPlayer.__solaraMediaSessionHandledEnded === 'skip') {
        dom.audioPlayer.__solaraMediaSessionHandledEnded = false;
        return;
    }
    const mode = getActivePlayMode(state);
    if (mode === "single") {
        dom.audioPlayer.currentTime = 0;
        dom.audioPlayer.play();
        return;
    }

    playNext(state, dom, callbacks);
    updatePlayPauseButton(dom);
}

export function playNext(state, dom, callbacks = {}) {
    if (state.currentList === "favorite") {
        const favorites = ensureFavoriteSongsArray(state);
        if (favorites.length === 0) {
            if (typeof callbacks.clearLyricsIfLibraryEmpty === "function") callbacks.clearLyricsIfLibraryEmpty();
            return;
        }
        const mode = state.favoritePlayMode || "list";
        let nextIndex = state.currentFavoriteIndex;
        if (mode === "random") {
            nextIndex = Math.floor(Math.random() * favorites.length);
        } else if (mode === "list") {
            nextIndex = (state.currentFavoriteIndex + 1) % favorites.length;
        }
        if (mode !== "single") {
            state.currentFavoriteIndex = nextIndex;
        }
        if (typeof callbacks.playFavoriteSong === "function") {
            callbacks.playFavoriteSong(state.currentFavoriteIndex);
        }
        return;
    }

    let nextIndex = -1;
    let playlist = [];

    if (state.currentPlaylist === "playlist") {
        playlist = state.playlistSongs;
    } else if (state.currentPlaylist === "online") {
        playlist = state.onlineSongs;
    } else if (state.currentPlaylist === "search") {
        playlist = state.searchResults;
    }

    if (playlist.length === 0) {
        if (typeof callbacks.clearLyricsIfLibraryEmpty === "function") callbacks.clearLyricsIfLibraryEmpty();
        return;
    }

    const mode = state.playMode || "list";
    if (mode === "random") {
        nextIndex = Math.floor(Math.random() * playlist.length);
    } else if (mode === "list") {
        nextIndex = (state.currentTrackIndex + 1) % playlist.length;
    } else if (mode === "single") {
        nextIndex = state.currentTrackIndex >= 0 ? state.currentTrackIndex : 0;
    }

    if (mode !== "single") {
        state.currentTrackIndex = nextIndex;
    }

    const targetIndex = mode === "single" ? state.currentTrackIndex : nextIndex;

    if (state.currentPlaylist === "playlist" && typeof callbacks.playPlaylistSong === "function") {
        callbacks.playPlaylistSong(targetIndex);
    } else if (state.currentPlaylist === "online" && typeof callbacks.playOnlineSong === "function") {
        callbacks.playOnlineSong(targetIndex);
    } else if (state.currentPlaylist === "search" && typeof callbacks.playSearchResult === "function") {
        callbacks.playSearchResult(targetIndex);
    }
}

export function playPrevious(state, dom, callbacks = {}) {
    if (state.currentList === "favorite") {
        const favorites = ensureFavoriteSongsArray(state);
        if (favorites.length === 0) {
            return;
        }
        const mode = state.favoritePlayMode || "list";
        let prevIndex = state.currentFavoriteIndex;
        if (mode === "random") {
            prevIndex = Math.floor(Math.random() * favorites.length);
        } else if (mode === "list") {
            prevIndex = state.currentFavoriteIndex - 1;
            if (prevIndex < 0) {
                prevIndex = favorites.length - 1;
            }
        }
        if (mode !== "single") {
            state.currentFavoriteIndex = prevIndex;
        }
        if (typeof callbacks.playFavoriteSong === "function") {
            callbacks.playFavoriteSong(state.currentFavoriteIndex);
        }
        return;
    }

    let prevIndex = -1;
    let playlist = [];

    if (state.currentPlaylist === "playlist") {
        playlist = state.playlistSongs;
    } else if (state.currentPlaylist === "online") {
        playlist = state.onlineSongs;
    } else if (state.currentPlaylist === "search") {
        playlist = state.searchResults;
    }

    if (playlist.length === 0) return;

    const mode = state.playMode || "list";
    if (mode === "random") {
        prevIndex = Math.floor(Math.random() * playlist.length);
    } else if (mode === "list") {
        prevIndex = state.currentTrackIndex - 1;
        if (prevIndex < 0) prevIndex = playlist.length - 1;
    } else if (mode === "single") {
        prevIndex = state.currentTrackIndex >= 0 ? state.currentTrackIndex : 0;
    }

    if (mode !== "single") {
        state.currentTrackIndex = prevIndex;
    }

    const targetIndex = mode === "single" ? state.currentTrackIndex : prevIndex;

    if (state.currentPlaylist === "playlist" && typeof callbacks.playPlaylistSong === "function") {
        callbacks.playPlaylistSong(targetIndex);
    } else if (state.currentPlaylist === "online" && typeof callbacks.playOnlineSong === "function") {
        callbacks.playOnlineSong(targetIndex);
    } else if (state.currentPlaylist === "search" && typeof callbacks.playSearchResult === "function") {
        callbacks.playSearchResult(targetIndex);
    }
}

export async function downloadSong(song, quality = "320", dom = null, options = {}) {
    // options.notify=false 时不弹逐首提示、返回 true/false，供“下载全部”汇总用。
    const notify = options.notify !== false;
    const announce = (message, type) => { if (notify) showNotification(message, type, dom); };
    try {
        if (notify) showNotification("正在准备下载...", "info", dom);

        let audioDataUrl = null;
        try {
            audioDataUrl = await getCustomMusicUrl(song, quality);
        } catch (err) {
            console.warn("自定义音源下载解析异常，回落默认接口:", err);
        }
        if (!audioDataUrl) {
            for (const base of getApiFallbackBases()) {
                try {
                    const audioUrl = API.getSongUrlWithBase(song, quality, base);
                    const audioData = await API.fetchJson(audioUrl);
                    if (audioData && audioData.url) {
                        audioDataUrl = audioData.url;
                        break;
                    }
                } catch (err) {
                    console.warn(`[轮询] 上游 ${base || "默认上游"} 取下载地址失败，尝试下一个音源:`, err);
                }
            }
        }

        if (audioDataUrl) {
            const proxiedAudioUrl = buildAudioProxyUrl(audioDataUrl);
            const preferredAudioUrl = preferHttpsUrl(audioDataUrl);
            const downloadUrl = proxiedAudioUrl || preferredAudioUrl || audioDataUrl;

            const link = document.createElement("a");
            link.href = downloadUrl;
            const preferredExtension = quality === "999" ? "flac" : quality === "740" ? "ape" : "mp3";
            const fileExtension = (() => {
                try {
                    const url = new URL(audioDataUrl);
                    const pathname = url.pathname || "";
                    const match = pathname.match(/\.([a-z0-9]+)$/i);
                    if (match) return match[1];
                } catch (error) {
                    console.warn("无法从下载链接中解析扩展名:", error);
                }
                return preferredExtension;
            })();
            link.download = `${song.name} - ${Array.isArray(song.artist) ? song.artist.join(", ") : song.artist}.${fileExtension}`;
            link.target = "_blank";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            announce("下载已开始", "success");
            return true;
        }
        throw new Error("无法获取下载地址");
    } catch (error) {
        console.error("下载失败:", error);
        announce("下载失败，请稍后重试", "error");
        return false;
    }
}

/** 逐首下载一组歌曲（“下载全部”用）：顺序触发、间隔 700ms 避免浏览器拦截多下载，失败跳过并汇总。 */
export async function downloadSongsSequentially(songs, quality = "320", dom = null, onProgress = null) {
    const list = Array.isArray(songs) ? songs.filter(Boolean) : [];
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
        if (typeof onProgress === "function") onProgress(i + 1, list.length, list[i]);
        const ok = await downloadSong(list[i], quality, dom, { notify: false });
        if (ok) succeeded++;
        else failed++;
        if (i < list.length - 1) await new Promise((r) => setTimeout(r, 700));
    }
    return { total: list.length, succeeded, failed };
}

/**
 * 彻底重置播放器为空闲/空态（停止播放、释放音频缓冲、重置界面与系统状态）
 */
export function resetPlayerToIdle(state, dom, callbacks = {}) {
    cancelPendingPlayback();

    if (dom.audioPlayer) {
        try {
            dom.audioPlayer.pause();
            dom.audioPlayer.removeAttribute("src");
            dom.audioPlayer.src = "";
            dom.audioPlayer.load();
        } catch (e) {
            console.warn("停止音频播放异常:", e);
        }
    }

    state.isPlaying = false;
    state.currentTrackIndex = -1;
    state.currentSong = null;
    state.currentAudioUrl = null;
    state.currentArtworkUrl = null;
    state.currentPlaybackTime = 0;
    state.lastSavedPlaybackTime = 0;
    if (state.currentList === "favorite") {
        state.currentFavoriteIndex = -1;
        state.favoritePlaybackTime = 0;
        state.favoriteLastSavedPlaybackTime = 0;
    }

    // 重置进度条
    if (dom.progressBar) {
        dom.progressBar.value = 0;
        dom.progressBar.max = 0;
        updateProgressBarBackground(dom, 0, 1);
    }
    if (dom.currentTimeDisplay) dom.currentTimeDisplay.textContent = "00:00";
    if (dom.durationDisplay) dom.durationDisplay.textContent = "00:00";

    // 重置播放/暂停按钮
    updatePlayPauseButton(dom);

    // 重置歌曲信息与封面
    if (dom.currentSongTitle) dom.currentSongTitle.textContent = "选择一首歌曲开始播放";
    if (dom.currentSongArtist) dom.currentSongArtist.textContent = "未知艺术家";
    if (typeof callbacks.showAlbumCoverPlaceholder === "function") {
        callbacks.showAlbumCoverPlaceholder();
    }
    if (typeof callbacks.clearLyricsContent === "function") {
        callbacks.clearLyricsContent();
    }

    // 重置系统媒体会话
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        try {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
        } catch (_) {}
    }

    // 更新收藏状态图标
    if (typeof callbacks.updateFavoriteIcons === "function") {
        callbacks.updateFavoriteIcons();
    }

    // 保存状态
    if (typeof callbacks.savePlayerState === "function") {
        callbacks.savePlayerState();
    }
}

