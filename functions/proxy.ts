const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const TENCENT_SEARCH_SOURCES = new Set(["tencent", "qq", "tx"]);

/**
 * QQ 搜索适配器（洛雪 musicSdk/tx 思路的重新实现，只做搜索，不抄洛雪代码）。
 *
 * 背景：默认 GD 上游对 tencent 直接返回 400 不支持，QQ 搜不到；洛雪桌面版
 * 的搜索本来就不在 .js 脚本里，而在各平台内置适配器里，QQ 用的是
 * 带 zzc 签名的 musics.fcg（DoSearchForQQMusicDesktop）。把这一个平台的
 * 搜索搬到 /proxy 的服务端转发层，搜 QQ 时不再经过 GD 上游。
 * 局限：只解决搜索。歌词/封面/播放地址仍走原有链路（GD 失败时播放靠
 * 洛雪脚本解析 tx 平台），pic_id 沿用 QQ 专辑 mid 以便将来接封面。
 * 注意：source 为 tencent 时，无论 ?apiBase= 指向哪个上游，搜索都走
 * 这个适配器，不再转发给那个上游。
 */
function tencentArtistName(item: any): string {
  const singer = item?.singer;
  if (Array.isArray(singer)) {
    return singer.map((s: any) => (typeof s === "string" ? s : s?.name || "")).filter(Boolean).join(" / ");
  }
  if (typeof singer === "string") return singer;
  return "";
}

function normalizeTencentItem(item: any): any | null {
  if (!item || typeof item !== "object") return null;
  // 洛雪 tx 适配器只保留有 media_mid 的条目（有可播文件）；旧接口条目没有
  // file 字段时不设此门槛，避免把旧接口结果误杀。
  if ("file" in item && !item.file?.media_mid) return null;
  const mid = item.mid || item.songmid || item.id;
  const name = item.title || item.name || item.songname;
  if (!mid || !name) return null;
  const album = item.album && typeof item.album === "object" ? item.album : null;
  return {
    id: String(mid),
    name: String(name),
    artist: tencentArtistName(item) || "未知艺术家",
    album: album?.name || item.albumname || (typeof item.album === "string" ? item.album : ""),
    pic_id: album?.mid || item.albummid || "",
    url_id: String(mid),
    lyric_id: String(mid),
    source: "tencent",
  };
}

function findTencentSongList(node: any, depth = 0): any[] | null {
  if (!node || typeof node !== "object" || depth > 4) return null;
  const song = (node as any).song;
  if (song && Array.isArray(song.list)) return song.list;
  if (Array.isArray((node as any).list)) return (node as any).list;
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const found = findTencentSongList(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 洛雪 tx 的 zzc 签名（musicSdk/tx/utils/crypto.js 的同义实现，不抄原文件）：
 * SHA1(请求体) 取指定位字符 + 异或扰动后的 base64，拼成 zzc… 签名。
 * Worker 内用 crypto.subtle 做 SHA1，base64 用 btoa 实现。
 */
const ZZC_PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const ZZC_PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const ZZC_SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64StripSpecial(bytes: number[]): string {
  const u8 = Uint8Array.from(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  return btoa(binary).replace(/[\\/+=]/g, "");
}

async function zzcSign(text: string): Promise<string> {
  const hash = await sha1Hex(text);
  const part1 = ZZC_PART_1_INDEXES.map((idx) => hash[idx]).join("");
  const part2 = ZZC_PART_2_INDEXES.map((idx) => hash[idx]).join("");
  const scrambled = ZZC_SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
  return `zzc${part1}${base64StripSpecial(scrambled)}${part2}`.toLowerCase();
}

function tencentSearchId(): string {
  let guid = "";
  for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16);
  return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, "0");
}

/**
 * 带签名的 QQ 搜索（洛雪 tx/musicSearch.js 的请求形状）：POST 到
 * musics.fcg?sign=zzc…，请求体键名即模块名，响应按该键名取回。
 * 无签名的 musicu.fcg 实测返回 sum 0、列表为空，故不用它作首选。
 */
async function searchTencentSigned(keyword: string, count: number, page: number): Promise<any[]> {
  const payload: Record<string, unknown> = {
    comm: {
      _channelid: "0", _os_version: "6.2.9200-2", ct: "19", cv: "2151",
      guid: "1F70E520B2EAA7D25E11760783C53CA9", patch: "118",
      psrf_access_token_expiresAt: 0, psrf_qqaccess_token: "", psrf_qqopenid: "", psrf_qqunionid: "",
      tmeAppID: "qqmusic", tmeLoginType: 0, uin: "0", wid: "7223299733393904640",
    },
    "music.search.SearchCgiService": {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicDesktop",
      param: {
        grp: 1, num_per_page: count, page_num: page, query: keyword,
        remoteplace: "txt.newclient.top", search_type: 0, searchid: tencentSearchId(),
      },
    },
  };
  const bodyText = JSON.stringify(payload);
  const sign = await zzcSign(bodyText);
  const response = await fetchWithTimeout(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "QQMusic 14090508(android 12)",
    },
    body: bodyText,
  }, 10000);
  if (!response.ok) throw new Error(`QQ 签名搜索返回 HTTP ${response.status}`);
  const json: any = await response.json();
  const req = json?.["music.search.SearchCgiService"] ?? json?.req;
  if (!req || json?.code !== 0 || req.code !== 0) {
    throw new Error(`QQ 签名搜索返回异常 code=${json?.code}/${req?.code}`);
  }
  const list = req.data?.body?.song?.list || [];
  return list.map(normalizeTencentItem).filter(Boolean);
}

async function searchTencentViaMusicU(keyword: string, count: number, page: number): Promise<any[]> {
  const payload = {
    comm: { g_tk: 5381, uin: 0, format: "json", inCharset: "utf-8", outCharset: "utf-8", notice: 0, platform: "h5", needNewCode: 1, ct: 24, cv: 0 },
    req_1: {
      method: "DoSearchForQQMusicDesktop",
      module: "music.search.SearchCgiService",
      param: { num_per_page: count, page_num: page, query: keyword, search_type: 0 },
    },
  };
  const response = await fetchWithTimeout("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://y.qq.com/",
      Origin: "https://y.qq.com/",
    },
    body: JSON.stringify(payload),
  }, 10000);
  if (!response.ok) throw new Error(`QQ musicu 返回 HTTP ${response.status}`);
  const json: any = await response.json();
  const list = findTencentSongList(json?.req_1?.data) || findTencentSongList(json) || [];
  return list.map(normalizeTencentItem).filter(Boolean);
}

async function searchTencentViaLegacy(keyword: string, count: number, page: number): Promise<any[]> {
  const params = new URLSearchParams({
    ct: "24", qqmusic_ver: "1298", new_json: "1", remoteplace: "txt.yqq.song",
    searchid: String(Date.now()), t: "0", aggr: "1", cr: "1", catZhida: "1",
    lossless: "0", flag_qc: "0", p: String(page), n: String(count), w: keyword,
    g_tk: "5381", loginUin: "0", hostUin: "0", format: "json",
    inCharset: "utf8", outCharset: "utf-8", notice: "0", platform: "yqq.json", needNewCode: "0",
  });
  const response = await fetchWithTimeout(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://y.qq.com/",
    },
  }, 10000);
  if (!response.ok) throw new Error(`QQ 旧搜索接口返回 HTTP ${response.status}`);
  let text = await response.text();
  const firstParen = text.indexOf("(");
  const lastParen = text.lastIndexOf(")");
  if (text.trimStart().startsWith("callback") && firstParen >= 0 && lastParen > firstParen) {
    text = text.slice(firstParen + 1, lastParen);
  }
  const json: any = JSON.parse(text);
  const list = findTencentSongList(json?.data) || findTencentSongList(json) || [];
  return list.map(normalizeTencentItem).filter(Boolean);
}

async function searchTencent(keyword: string, count: number, page: number): Promise<any[]> {
  let lastError: unknown = null;
  for (const attempt of [searchTencentSigned, searchTencentViaMusicU, searchTencentViaLegacy]) {
    try {
      const results = await attempt(keyword, count, page);
      if (results.length > 0) return results;
    } catch (err) {
      lastError = err;
      console.warn("[QQ搜索] 一路接口失败，尝试下一路:", err);
    }
  }
  if (lastError) throw lastError;
  return [];
}

const KUWO_SEARCH_SOURCES = new Set(["kuwo", "kw"]);

/**
 * 酷我搜索适配器（洛雪 kw/musicSearch.js 的请求形状，无签名）：
 * GET search.kuwo.cn/r.s，响应 abslist 归一化为 GD 形数组。
 * 只解决搜索；歌词/封面/播放地址仍走原有链路。
 */
function decodeKuwoName(raw: string): string {
  return String(raw || "")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function searchKuwo(keyword: string, count: number, page: number): Promise<any[]> {
  const params = new URLSearchParams({
    client: "kt", all: keyword, pn: String(page - 1), rn: String(count),
    uid: "794762570", ver: "kwplayer_ar_9.2.2.1", vipver: "1", show_copyright_off: "1",
    newver: "1", ft: "music", cluster: "0", strategy: "2012", encoding: "utf8",
    rformat: "json", vermerge: "1", mobi: "1", issubtitle: "1",
  });
  const response = await fetchWithTimeout(`http://search.kuwo.cn/r.s?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  }, 10000);
  if (!response.ok) throw new Error(`酷我搜索返回 HTTP ${response.status}`);
  let text = await response.text();
  const firstParen = text.indexOf("(");
  const lastParen = text.lastIndexOf(")");
  if (text.trimStart().startsWith("callback") && firstParen >= 0 && lastParen > firstParen) {
    text = text.slice(firstParen + 1, lastParen);
  }
  const json: any = JSON.parse(text);
  const abslist = Array.isArray(json?.abslist) ? json.abslist : [];
  const results: any[] = [];
  for (const info of abslist) {
    const songId = String(info?.MUSICRID || "").replace(/^MUSIC_/, "");
    const name = decodeKuwoName(info?.SONGNAME || "");
    if (!songId || !name) continue;
    results.push({
      id: songId,
      name,
      artist: decodeKuwoName(info?.ARTIST || "") || "未知艺术家",
      album: decodeKuwoName(info?.ALBUM || ""),
      pic_id: decodeKuwoName(info?.ALBUMID || ""),
      url_id: songId,
      lyric_id: songId,
      source: "kuwo",
    });
  }
  return results;
}

const KUGOU_SEARCH_SOURCES = new Set(["kugou", "kg"]);

/**
 * 酷狗搜索适配器（洛雪 kg/musicSearch.js 的请求形状，无签名）：
 * GET songsearch.kugou.com/song_search_v2，响应 data.lists 归一化为
 * GD 形数组。id 取 FileHash（洛雪脚本解析与 GD 酷狗都以 hash 为键），
 * Grp 子项一并展开并按 Audioid+FileHash 去重。只解决搜索。
 */
function normalizeKugouItem(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  const hash = raw.FileHash || raw.HQFileHash || raw.SQFileHash || "";
  const name = `${decodeKuwoName(raw.OriSongName || raw.SongName || "")}${raw.Suffix ? ` ${decodeKuwoName(raw.Suffix)}` : ""}`.trim();
  if (!hash || !name) return null;
  const singers = Array.isArray(raw.Singers) ? raw.Singers : [];
  const artist = singers.map((s: any) => decodeKuwoName(s?.name || s || "")).filter(Boolean).join(" / ") || decodeKuwoName(raw.SingerName || "") || "未知艺术家";
  return {
    id: String(hash),
    name,
    artist,
    album: decodeKuwoName(raw.AlbumName || ""),
    pic_id: raw.AlbumID != null ? String(raw.AlbumID) : "",
    url_id: String(hash),
    lyric_id: String(hash),
    source: "kugou",
  };
}

async function searchKugou(keyword: string, count: number, page: number): Promise<any[]> {
  const params = new URLSearchParams({
    platform: "AndroidFilter", iscorrection: "1", keyword,
    hifiquality: "0", pagesize: String(count), PrivilegeFilter: "0", page: String(page),
  });
  const response = await fetchWithTimeout(`http://songsearch.kugou.com/song_search_v2?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Linux; Android 11; MI 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    },
  }, 10000);
  if (!response.ok) throw new Error(`酷狗搜索返回 HTTP ${response.status}`);
  const json: any = await response.json();
  if (!json || json.error_code !== 0 || !Array.isArray(json.data?.lists)) {
    throw new Error(`酷狗搜索返回异常 error_code=${json?.error_code}`);
  }
  const seen = new Set<string>();
  const results: any[] = [];
  for (const item of json.data.lists) {
    for (const candidate of [item, ...(Array.isArray(item?.Grp) ? item.Grp : [])]) {
      const key = `${candidate?.Audioid || ""}${candidate?.FileHash || ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const normalized = normalizeKugouItem(candidate);
      if (normalized) results.push(normalized);
    }
  }
  return results;
}

async function handleKugouSearch(url: URL): Promise<Response> {
  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchKugou(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[酷狗搜索] 失败:", err);
    return new Response(JSON.stringify({ error: "酷狗搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function handleKuwoSearch(url: URL): Promise<Response> {  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchKuwo(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[酷我搜索] 失败:", err);
    return new Response(JSON.stringify({ error: "酷我搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

const MIGU_SEARCH_SOURCES = new Set(["migu", "mg"]);

/**
 * 纯 JS MD5（RFC 1321）。Worker 的 crypto.subtle 不提供 MD5，而咪咕搜索
 * 签名要求 MD5，故自带实现；已在 Node 里对照 crypto 验算通过（含中文）。
 */
function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, bitLen & 0xffffffff, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const K: number[] = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const add = (x: number, y: number) => (x + y) >>> 0;
  const rol = (x: number, c: number) => ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let off = 0; off < paddedLen; off += 64) {
    const M: number[] = [];
    for (let j = 0; j < 16; j++) M.push(view.getUint32(off + j * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      b = add(b, rol(add(add(add(a, f), K[i]), M[g]), S[i]));
      a = tmp;
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return Array.from(out).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * 咪咕搜索适配器（洛雪 mg/musicSearch.js 的请求形状，MD5 签名）：
 * GET jadeite.migu.cn/music_search/v3/search/searchAll，响应
 * songResultData.resultList（组内数组）归一化为 GD 形数组。
 * id 取 songId，url_id 取 copyrightId（播放解析用），只解决搜索。
 */
async function searchMigu(keyword: string, count: number, page: number): Promise<any[]> {
  const time = Date.now().toString();
  const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
  const sign = md5Hex(`${keyword}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`);
  const params = new URLSearchParams({
    isCorrect: "0", isCopyright: "1",
    searchSwitch: '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}',
    pageSize: String(count), text: keyword, pageNo: String(page), sort: "0", sid: "USS",
  });
  const response = await fetchWithTimeout(`https://jadeite.migu.cn/music_search/v3/search/searchAll?${params.toString()}`, {
    headers: {
      uiVersion: "A_music_3.6.1",
      deviceId,
      timestamp: time,
      sign,
      channel: "0146921",
      "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30",
    },
  }, 10000);
  if (!response.ok) throw new Error(`咪咕搜索返回 HTTP ${response.status}`);
  const json: any = await response.json();
  if (!json || json.code !== "000000") {
    throw new Error(`咪咕搜索返回异常 code=${json?.code} info=${json?.info || ""}`);
  }
  const groups = json.songResultData?.resultList || [];
  const seen = new Set<string>();
  const results: any[] = [];
  for (const group of groups) {
    for (const data of Array.isArray(group) ? group : [group]) {
      if (!data?.songId || !data?.copyrightId || seen.has(String(data.copyrightId))) continue;
      seen.add(String(data.copyrightId));
      const singers = Array.isArray(data.singerList) ? data.singerList : [];
      const artist = singers.map((s: any) => s?.name || "").filter(Boolean).join(" / ") || "未知艺术家";
      results.push({
        id: String(data.songId),
        name: String(data.name || ""),
        artist,
        album: String(data.album || ""),
        pic_id: data.albumId != null ? String(data.albumId) : "",
        url_id: String(data.copyrightId),
        lyric_id: String(data.songId),
        source: "migu",
      });
    }
  }
  return results;
}

async function handleMiguSearch(url: URL): Promise<Response> {
  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchMigu(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[咪咕搜索] 失败:", err);
    return new Response(JSON.stringify({ error: "咪咕搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}

async function handleTencentSearch(url: URL): Promise<Response> {
  const keyword = (url.searchParams.get("name") || "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "Missing keyword" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count")) || 20));
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("pages")) || 1));
  try {
    const results = await searchTencent(keyword, count, page);
    const headers = createCorsHeaders();
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(results), { status: 200, headers });
  } catch (err) {
    console.warn("[QQ搜索] 两路接口均失败:", err);
    return new Response(JSON.stringify({ error: "QQ 搜索失败" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }
}
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

/**
 * 校验界面传入的自定义上游（`?apiBase=`）。字符串级校验：只放行公网
 * http(s) 地址，拦住本地/内网/元数据地址与带凭证的 URL。
 * 注意：Cloudflare Workers 内无法做 DNS 解析，DNS 重绑定风险由部署方
 * 承担——只在自己信任的部署上使用，且不要把 Solara 暴露给不可信用户。
 */
function isPrivateIpLiteral(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || a === 0 || (a === 169 && b === 254);
  }
  return hostname === "::1" || hostname === "[::1]";
}

export function isSafeApiBaseUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")
      || hostname === "metadata.google.internal" || isPrivateIpLiteral(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;
  
  // 构建缓存 Key（过滤掉随机签名 s 以及强制刷新标记 nocache，以便重试成功后能更新同一个缓存项）
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  
  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers
  });

  // 如果是 GET 请求且未指定 nocache 强制刷新，尝试命中缓存
  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache HIT] ${url.toString()}`);
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache" || key === "apiBase") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "Meting/1.5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  // 判断是否应该缓存：必须是 200 状态，且内容不能是空数组或包含错误标识，且未指定强制刷新
  const isSearch = url.searchParams.get("types") === "search";
  const isEmptyResult = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');
  
  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;
  
  // 如果是搜索请求且结果为空，通常是 API 繁忙或异常，不建议长缓存
  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  // 写入缓存（不阻塞主流程）
  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

export async function onRequest({ request, waitUntil, env }: { request: Request, waitUntil: (promise: Promise<any>) => void, env: any }): Promise<Response> {
  // 优先使用环境变量中配置的 API 地址，CF 部署未设置时 fallback 到默认节点；
  // 界面里用户添加并设为“当前生效”的自定义上游（?apiBase=）优先级最高，
  // 但必须通过校验，否则 400，绝不把非法地址当成上游去请求。
  let apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  const requestedUrl = new URL(request.url);
  const requestedApiBase = requestedUrl.searchParams.get("apiBase");
  if (requestedApiBase) {
    if (!isSafeApiBaseUrl(requestedApiBase)) {
      return new Response(JSON.stringify({ error: "Invalid apiBase" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    apiBaseUrl = requestedApiBase;
  }
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  // QQ 搜索走洛雪式适配器，不经过 GD 上游（GD 对 tencent 返回 400）。
  if (url.searchParams.get("types") === "search" && TENCENT_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleTencentSearch(url);
  }

  // 酷我搜索走洛雪式适配器，不经过 GD 上游（GD 对 kuwo 返回 400）。
  if (url.searchParams.get("types") === "search" && KUWO_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleKuwoSearch(url);
  }

  // 酷狗搜索走洛雪式适配器，不经过 GD 上游（GD 对 kugou 返回 400）。
  // 主界面下拉没有酷狗选项，这路只影响音源检测面板的酷狗药丸。
  if (url.searchParams.get("types") === "search" && KUGOU_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleKugouSearch(url);
  }

  // 咪咕搜索走洛雪式适配器，不经过 GD 上游（GD 对 migu 返回 400）。
  // 主界面下拉没有咪咕选项，这路只影响音源检测面板的咪咕药丸。
  if (url.searchParams.get("types") === "search" && MIGU_SEARCH_SOURCES.has((url.searchParams.get("source") || "").toLowerCase())) {
    return handleMiguSearch(url);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
