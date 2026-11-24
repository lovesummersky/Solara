/**
 * 自定义音源后端（Docker / Node 独立服务器版，与 functions/ 下 Cloudflare 版同行为）。
 *
 *  - GET  /proxy-source?url=…[&includeCode=1]  拉取并校验洛雪脚本，返回元数据
 *  - POST /proxy-fetch  { url, method, headers, body, timeoutMs }  通用请求代理
 *  - GET  /proxy-fetch?url=…  仅 GET
 *
 * 安全：除字符串级校验外，还会做 DNS 解析并拒绝解析到内网/回环/链路本地
 * 地址的主机名（防 DNS 重绑定）。响应体上限 2 MB，音频/视频只读前 8 KB。
 */
'use strict';

const { Router } = require('express');
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_CODE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MEDIA_BODY_CAP = 8 * 1024;
const FETCH_TIMEOUT_MS = 10000;

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  return false;
}

function parseAndCheckUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: '无效的地址' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: '只支持 http:// 或 https:// 地址' };
  }
  if (parsed.username || parsed.password) return { ok: false, error: '地址里不能带用户名或密码' };
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')
    || hostname === 'metadata.google.internal' || isPrivateIp(hostname)) {
    return { ok: false, error: '不允许使用本地/内网地址' };
  }
  return { ok: true, parsed };
}

async function assertPublicHostname(hostname) {
  if (net.isIP(hostname)) return;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('域名解析失败');
  }
  if (!addresses || addresses.length === 0) throw new Error('域名解析失败');
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('域名解析到内网地址，已拒绝');
  }
}

function json(res, status, body) {
  return res.status(status).set('Content-Type', 'application/json; charset=utf-8').set('Cache-Control', 'no-store').json(body);
}

function parseHeaderField(code, field) {
  const match = code.match(new RegExp(`@\\s*${field}\\s+([^\\r\\n*]+)`, 'i'));
  return match ? match[1].trim().replace(/\s*\*\/\s*$/, '').trim() : '';
}

function parsePlatforms(code) {
  const found = new Set();
  const block = code.match(/PLATFORM_NAMES\s*=\s*\{([\s\S]{0,600}?)\}/);
  if (block) {
    for (const m of block[1].matchAll(/\b(wy|tx|kw|kg|mg)\s*:/g)) found.add(m[1]);
  }
  if (found.size === 0) {
    for (const m of code.matchAll(/["'](wy|tx|kw|kg|mg)["']\s*:/g)) found.add(m[1]);
  }
  return Array.from(found);
}

function createSourceRouter() {
  const router = Router();
  router.get('/', async (req, res) => {
    const target = req.query.url || '';
    const checked = parseAndCheckUrl(target);
    if (!checked.ok) return json(res, 400, { ok: false, error: checked.error });
    try {
      await assertPublicHostname(checked.parsed.hostname);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { 'User-Agent': 'Solara/2.0', Accept: 'text/javascript,application/javascript,text/plain,*/*' },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return json(res, 502, { ok: false, error: err.name === 'AbortError' ? '拉取脚本超时' : '拉取脚本失败，请检查地址与网络' });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) return json(res, 502, { ok: false, error: `脚本地址返回 HTTP ${upstream.status}` });
    const contentLength = Number(upstream.headers.get('content-length') || '0');
    if (contentLength > MAX_CODE_BYTES) return json(res, 502, { ok: false, error: '脚本文件过大（超过 2 MB）' });
    const code = await upstream.text();
    if (code.length > MAX_CODE_BYTES) return json(res, 502, { ok: false, error: '脚本文件过大（超过 2 MB）' });

    const looksLikeLx = code.includes('globalThis.lx') && code.includes('EVENT_NAMES');
    if (!looksLikeLx) {
      return json(res, 422, { ok: false, error: '该文件不是洛雪音源脚本（未找到 globalThis.lx / EVENT_NAMES）' });
    }
    const result = {
      ok: true,
      url: target,
      name: parseHeaderField(code, 'name'),
      version: parseHeaderField(code, 'version'),
      author: parseHeaderField(code, 'author'),
      description: parseHeaderField(code, 'description'),
      platforms: parsePlatforms(code),
      supportsMusicUrl: code.includes('musicUrl'),
      codeSize: code.length,
    };
    if (req.query.includeCode === '1') result.code = code;
    return json(res, 200, result);
  });
  return router;
}

const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'cookie', 'authorization']);

async function readCappedBody(upstream, cap) {
  if (!upstream.body) return '';
  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > cap) {
          const keep = value.subarray(0, Math.max(0, cap - (total - value.length)));
          if (keep.length) chunks.push(keep);
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
  } catch {
    // 读取中断时返回已读部分
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return merged.toString('utf-8');
}

function createFetchRouter() {
  const router = Router();
  router.options('/', (req, res) => {
    res.status(204).set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    }).end();
  });

  async function handle(req, res, target, method, headers, body, timeoutMs) {
    const checked = parseAndCheckUrl(target);
    if (!checked.ok) return json(res, 400, { ok: false, error: checked.error });
    try {
      await assertPublicHostname(checked.parsed.hostname);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    if (!['GET', 'POST', 'HEAD'].includes(method)) {
      return json(res, 400, { ok: false, error: '仅支持 GET / POST / HEAD' });
    }
    const forwardHeaders = { 'User-Agent': 'Solara/2.0 (lx-worker)' };
    for (const [key, value] of Object.entries(headers || {})) {
      if (typeof value === 'string' && !HOP_HEADERS.has(key.toLowerCase())) forwardHeaders[key] = value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream;
    try {
      upstream = await fetch(target, {
        method,
        headers: forwardHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : (typeof body === 'string' ? body : body == null ? undefined : JSON.stringify(body)),
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return json(res, 502, { ok: false, error: err.name === 'AbortError' ? '上游请求超时' : '上游请求失败' });
    } finally {
      clearTimeout(timer);
    }
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
    const contentType = (responseHeaders['content-type'] || '').toLowerCase();
    const cap = /^(audio|video)\//.test(contentType) ? MEDIA_BODY_CAP : MAX_BODY_BYTES;
    const text = await readCappedBody(upstream, cap);
    return json(res, 200, {
      ok: true,
      statusCode: upstream.status,
      headers: responseHeaders,
      body: text,
      url: upstream.url || target,
    });
  }

  router.get('/', (req, res) => handle(req, res, req.query.url || '', 'GET', {}, null, 8000));
  router.post('/', (req, res) => {
    const payload = req.body || {};
    const timeoutMs = Number.isFinite(payload.timeoutMs)
      ? Math.min(Math.max(Number(payload.timeoutMs), 1000), 30000) : 8000;
    return handle(req, res, payload.url || '', String(payload.method || 'GET').toUpperCase(), payload.headers || {}, payload.body ?? null, timeoutMs);
  });
  return router;
}

module.exports = { createSourceRouter, createFetchRouter, parseAndCheckUrl };
