/* ============================================================================
   GitHub 热门项目分析报告生成器 · Web 版后端引擎
   —— 与桌面版 app.py v2.13.0 同一套流水线，移植为纯 Node（零第三方依赖）
      抓榜（多源并发 + 离线缓存）→ 元数据/README → 英译中 → 七问分析（内置/AI）
      → 趋势总结 → Markdown + HTML 报告落盘
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const { execSync } = require('child_process');

const APP_NAME = 'GitHub 热门项目分析报告生成器';
const VERSION = '2.31.0';
const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const REPORTS_DIR = path.join(APP_DIR, 'reports');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEFAULT_API_MODEL = 'deepseek-chat';
const PERIODS = { daily: '本日', weekly: '本周', monthly: '本月' };
const REPO_CACHE_TTL = 24 * 3600;

const FALLBACK_MIRRORS = [
  { name: 'GitHub 官方 Trending（官网直连）', url: 'https://github.com/trending?since={since}' },
  { name: 'bgithub.xyz 镜像', url: 'https://bgithub.xyz/trending?since={since}' },
  { name: 'github.ur1.fun 镜像', url: 'https://github.ur1.fun/trending?since={since}' },
  { name: 'bdnb.cn GitHub 中文版', url: 'https://bdnb.cn/trending?since={since}' },
  { name: 'gitclone.com 镜像', url: 'https://gitclone.com/github.com/trending?since={since}' },
  { name: 'dgithub.xyz 镜像', url: 'https://dgithub.xyz/trending?since={since}' },
  { name: 'kkgithub.com 镜像', url: 'https://kkgithub.com/trending?since={since}' },
  { name: 'github.store 镜像（备用）', url: 'https://github.store/trending?since={since}' },
  { name: 'mirror.ghproxy.com 加速', url: 'https://mirror.ghproxy.com/https://github.com/trending?since={since}' },
  { name: 'ghproxy.net 加速', url: 'https://ghproxy.net/https://github.com/trending?since={since}' },
  { name: 'gh.llkk.cc 加速', url: 'https://gh.llkk.cc/https://github.com/trending?since={since}' },
  { name: 'ghp.ci 加速', url: 'https://ghp.ci/https://github.com/trending?since={since}' },
  { name: 'moeyy.cn 加速', url: 'https://moeyy.cn/gh-proxy/https://github.com/trending?since={since}' },
  { name: 'r.jina.ai 网页代理', url: 'https://r.jina.ai/https://github.com/trending?since={since}' },
];
const FALLBACK_LINKS = {
  github: 'https://github.com/{full_name}',
  gitee: 'https://gitee.com/mirrors/{repo}',
  mirror: 'https://kkgithub.com/{full_name}',
  store: 'https://github.store/{full_name}',
};

const LICENSE_INFO = [
  ['no license', '无开源协议', '❌ 默认保留所有权利',
    '未附开源协议 = 保留版权，未经作者明确许可不得修改、商用、再分发；二次开发前请先联系作者获得授权。'],
  ['cc0', 'CC0', '✅ 完全支持二次开发',
    '作者放弃全部权利（公有领域），可任意修改、商用、再分发，连署名都不要求。'],
  ['unlicense', 'Unlicense', '✅ 完全支持二次开发', '公有领域协议，可任意修改、商用、再分发。'],
  ['mit', 'MIT', '✅ 完全支持二次开发',
    '可自由修改、商用、再分发，只需保留原版权声明；最宽松、最主流的协议之一。'],
  ['apache', 'Apache-2.0', '✅ 完全支持二次开发',
    '可自由修改、商用、再分发，附带专利授权；需保留版权声明与变更说明。'],
  ['bsd', 'BSD', '✅ 完全支持二次开发',
    '宽松协议，可自由修改、商用、再分发；需保留版权声明，禁止用作者名义背书。'],
  ['gpl', 'GPL', '⚠️ 支持但需开源回馈',
    '允许修改与商用，但衍生作品必须同样以 GPL 开源（Copyleft 传染性），不能闭源分发。'],
  ['agpl', 'AGPL', '⚠️ 支持但需开源回馈',
    '同 GPL，且通过网络的远程服务也视为分发，必须向用户提供源码。'],
  ['lgpl', 'LGPL', '✅ 支持（库可闭源链接）',
    '修改库本身需开源；以动态链接方式调用该库的程序可闭源商用。'],
  ['mpl', 'MPL', '✅ 支持（文件级开源）', '修改过的文件需以 MPL 开源，其余代码可闭源商用。'],
  ['epl', 'EPL', '✅ 支持（文件级开源）', '类似 MPL，修改的文件需开源，其余代码可闭源商用。'],
];

/* ------------------------------------------------------------------ 基础工具 */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function unescapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s) { return unescapeHtml(String(s || '').replace(/<[^>]+>/g, '')).trim(); }

function periodLabel(since) { return PERIODS[since] || since || '本月'; }

function licenseAnalysis(lic) {
  if (!lic) {
    return '暂无相关信息（联网生成报告时可自动解析仓库许可证；也可在 data/kb_projects.json 中为该仓库补充 license 字段）';
  }
  const t = String(lic).toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [kw, name, verdict, note] of LICENSE_INFO) {
    if (t.includes(kw)) return `${name} —— ${note}`;
  }
  return `${lic}：属于自定义/其他协议。具体授权范围请查看仓库 LICENSE 文件或联系作者确认；`
    + '可在 data/kb_projects.json 中为该仓库补充 license 字段以优化判定。';
}

/** 协议短名 + 是否支持二次开发（给 Web 界面用） */
function licenseBadge(lic) {
  if (!lic) return { name: '暂无相关信息', ok: false, warn: true, note: licenseAnalysis('') };
  const t = String(lic).toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [kw, name, verdict, note] of LICENSE_INFO) {
    if (t.includes(kw)) {
      const ok = !verdict.includes('❌');
      return { name, ok, warn: !ok || verdict.includes('⚠️'), note };
    }
  }
  return { name: String(lic), ok: false, warn: true, note: licenseAnalysis(lic) };
}

/* ------------------------------------------------------------------ 配置/数据 */

let _configCache = null;

function loadConfig() {
  const cfg = {
    proxy: '',
    since: 'monthly',
    engine: 'auto',
    api_base: DEFAULT_API_BASE,
    api_key: '',
    api_model: DEFAULT_API_MODEL,
    top_n: 10,
    source_mode: 'auto',
    last_source: '',
    lang: 'zh',
    favorites: [],
    schedule: null,
    autostart: false,
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
      Object.assign(cfg, JSON.parse(raw));
    }
  } catch (e) { /* 配置损坏 → 用默认值 */ }
  _configCache = cfg;
  return cfg;
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    _configCache = cfg;
    return true;
  } catch (e) { return false; }
}

const _dataCache = new Map();

function loadData(name, dflt) {
  if (_dataCache.has(name)) return _dataCache.get(name);
  const p = path.join(DATA_DIR, name);
  let val = dflt;
  try {
    if (fs.existsSync(p)) {
      val = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch (e) { val = dflt; }
  _dataCache.set(name, val);
  return val;
}

function getMirrorsCfg() {
  const m = loadData('mirrors.json', {}) || {};
  return {
    trendingSources: m.trending_sources && m.trending_sources.length ? m.trending_sources : FALLBACK_MIRRORS,
    readmeChannels: m.readme_channels || [],
    branches: m.branches || ['main', 'master'],
    linkTemplates: m.link_templates || FALLBACK_LINKS,
    firecrawl: m.firecrawl || {},
  };
}

function getKb() { return (loadData('kb_projects.json', {}) || {}).projects || {}; }
function kbLookup(item) { return getKb()[String(item.full_name).toLowerCase()]; }

/* ------------------------------------------------------------------ 网络层 */

const proxyAgents = new Map();

function getProxyAgent(proxyUrl, verify) {
  const key = proxyUrl + '|' + (verify ? 'v' : 'nv');
  if (proxyAgents.has(key)) return proxyAgents.get(key);
  const p = new URL(proxyUrl);
  const proxyPort = Number(p.port || (p.protocol === 'https:' ? 443 : 80));
  const auth = p.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`).toString('base64')
    : '';

  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function (options, cb) {
    const sock = net.connect({ host: p.hostname, port: proxyPort }, () => {
      sock.write(
        `CONNECT ${options.host}:${options.port} HTTP/1.1\r\n`
        + `Host: ${options.host}:${options.port}\r\n`
        + (auth ? `Proxy-Authorization: ${auth}\r\n` : '')
        + 'Connection: keep-alive\r\n\r\n'
      );
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; sock.destroy(); cb(e); };
    sock.once('error', fail);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) { if (buf.length > 16384) fail(new Error('代理响应过长')); return; }
      sock.removeListener('data', onData);
      const head = buf.slice(0, idx).toString('latin1');
      const m = head.match(/^HTTP\/1\.[01]\s+(\d+)/);
      if (!m || m[1] !== '200') { fail(new Error('代理 CONNECT 失败 HTTP ' + (m ? m[1] : '?'))); return; }
      const rest = buf.slice(idx + 4);
      sock.pause();
      if (rest.length) sock.unshift(rest);
      const tlsSock = tls.connect({
        socket: sock,
        servername: options.host,
        rejectUnauthorized: verify !== false,
      }, () => { if (settled) return; settled = true; cb(null, tlsSock); });
      tlsSock.once('error', (e) => { if (!settled) fail(e); });
    };
    sock.on('data', onData);
  };
  proxyAgents.set(key, agent);
  return agent;
}

let _sysProxy = { at: 0, val: '' };

function getSystemProxy() {
  if (Date.now() - _sysProxy.at < 60000) return _sysProxy.val;
  let val = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!val && process.platform === 'win32') {
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const en = execSync(`reg query "${key}" /v ProxyEnable`, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      const sv = execSync(`reg query "${key}" /v ProxyServer`, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(en);
      const m = sv.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
      if (enabled && m) {
        let server = m[1].trim();
        if (server.includes('=')) {
          const hm = server.match(/https?=([^;]+)/);
          server = hm ? hm[1] : server.split(';')[0];
        }
        if (!/^https?:\/\//.test(server)) server = 'http://' + server;
        val = server;
      }
    } catch (e) { val = ''; }
  }
  _sysProxy = { at: Date.now(), val };
  return val;
}

/**
 * 统一 HTTP 客户端（支持代理 / 重定向 / gzip / 忽略证书 / TLS 证书异常自动降级重试）
 * @returns {Promise<{status:number, headers:object, text:string, buffer:Buffer, url:string}>}
 */
function request(urlStr, opt = {}) {
  return requestRaw(urlStr, opt).catch((err) => {
    const code = String((err && err.code) || '');
    if (opt.verify !== false && /CERT|SELF_SIGNED|ALTNAME|EPROTO|UNABLE_TO_VERIFY|ERR_SSL/.test(code)) {
      return requestRaw(urlStr, Object.assign({}, opt, { verify: false }));
    }
    throw err;
  });
}

function requestRaw(urlStr, opt = {}) {
  const o = Object.assign({ method: 'GET', timeout: 15000, maxRedirects: 5 }, opt);
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('URL 非法：' + urlStr)); }
    if (!url.protocol.startsWith('http')) return reject(new Error('不支持的协议：' + url.protocol));

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
    }, o.headers || {});
    const body = o.body == null ? null : (Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8'));
    if (body) headers['Content-Length'] = body.length;

    const reqOpts = {
      method: o.method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: o.timeout,
    };
    if (isHttps) reqOpts.rejectUnauthorized = o.verify !== false;
    if (o.proxy && isHttps) {
      reqOpts.agent = getProxyAgent(o.proxy, o.verify !== false);
    }

    const req = lib.request(reqOpts, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && o.maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return request(next, Object.assign({}, o, { maxRedirects: o.maxRedirects - 1 })).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
        } catch (e) { /* 保持原样 */ }
        resolve({ status, headers: res.headers, buffer: buf, text: buf.toString('utf8'), url: url.href });
      });
      res.on('error', reject);
    });
    // 硬超时：覆盖 DNS 解析 / 建连 / TLS 握手等 socket 超时覆盖不到的阶段
    const hardTimer = setTimeout(() => {
      const err = new Error('timeout');
      err.code = 'TIMEOUT';
      req.destroy(err);
    }, (o.timeout || 15000) + 1200);
    req.on('close', () => clearTimeout(hardTimer));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postJson(urlStr, obj, opt = {}) {
  return request(urlStr, Object.assign({}, opt, {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}),
  }));
}

/* ------------------------------------------------------------------ 榜单抓取 */

function trendingCachePath(since) {
  return path.join(DATA_DIR, `trending_cache_${since || 'monthly'}.html`);
}

function saveTrendingCache(since, text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(trendingCachePath(since), text, 'utf8');
    return true;
  } catch (e) { return false; }
}

function loadTrendingCache(since) {
  try {
    const p = trendingCachePath(since);
    if (!fs.existsSync(p)) return [null, null];
    const st = fs.statSync(p);
    const d = new Date(st.mtimeMs);
    const p2 = n => String(n).padStart(2, '0');
    return [fs.readFileSync(p, 'utf8'), `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`];
  } catch (e) { return [null, null]; }
}

function loadTrendingCacheAny(since) {
  for (const p of [since, 'weekly', 'monthly', 'daily']) {
    const [cached, mtime] = loadTrendingCache(p);
    if (!cached) continue;
    try {
      if (parseTrending(cached, { topN: 10, loose: true, require: false }).length >= 5) return [cached, mtime, p];
    } catch (e) { /* 继续找 */ }
  }
  return [null, null, null];
}

function buildSourceChain(since, userProxy, log, sourceMode) {
  const mode = String(sourceMode || 'auto').trim().toLowerCase();
  const allSrcs = getMirrorsCfg().trendingSources;
  const ghUrl = `https://github.com/trending?since=${since}`;
  const chain = [];
  const addSrc = (src, proxy) => {
    const url = String(src.url).replace(/\{since\}/g, since);
    chain.push({
      name: proxy ? `${src.name}（走自定义代理）` : src.name,
      url,
      proxy: proxy || null,
    });
  };
  const isAccel = src => String(src.url || '').includes('github.com/trending');

  if (mode === 'official') {
    chain.push({ name: 'GitHub 官网直连', url: ghUrl, proxy: null });
    const sp = getSystemProxy();
    if (sp) {
      log(`检测到系统代理：${sp}`);
      chain.push({ name: '系统代理直连', url: ghUrl, proxy: sp });
    }
    if (userProxy) chain.push({ name: `自定义代理 ${userProxy}`, url: ghUrl, proxy: userProxy });
    for (const src of allSrcs) {
      if (!isAccel(src)) continue;
      addSrc(src);
      if (userProxy) addSrc(src, userProxy);
    }
  } else if (mode === 'china') {
    log('数据来源：国内镜像站优先（gitcn.org 中文热榜等，免代理），加速器兜底');
    for (const src of allSrcs) {
      if (isAccel(src)) continue;
      addSrc(src);
      if (userProxy) addSrc(src, userProxy);
    }
    for (const src of allSrcs) {
      if (!isAccel(src)) continue;
      addSrc(src);
      if (userProxy) addSrc(src, userProxy);
    }
  } else {
    chain.push({ name: 'GitHub 官网直连', url: ghUrl, proxy: null });
    const sp = getSystemProxy();
    if (sp) {
      log(`检测到系统代理：${sp}`);
      chain.push({ name: '系统代理直连', url: ghUrl, proxy: sp });
    }
    if (userProxy) chain.push({ name: `自定义代理 ${userProxy}`, url: ghUrl, proxy: userProxy });
    for (const src of allSrcs) {
      addSrc(src);
      if (userProxy) addSrc(src, userProxy);
    }
  }
  const last = (loadConfig() || {}).last_source || '';
  if (last && chain.some(c => c.name === last)) {
    chain.sort((a, b) => (b.name === last ? 1 : 0) - (a.name === last ? 1 : 0));
  }
  return chain;
}

/**
 * 抓取 Trending：Firecrawl → 多源并发（最快优先）→ 离线缓存兜底
 * @returns {Promise<{html:string, source:string, proxy:string|null, loose:boolean}>}
 */
async function fetchTrending(since, userProxy, log, cancel, sourceMode, progress) {
  const mode = String(sourceMode || 'auto').trim().toLowerCase();
  const fc = getMirrorsCfg().firecrawl || {};
  if (fc.enabled && mode !== 'china') {
    try {
      log(`尝试 Firecrawl 抓取通道（${fc.base_url || 'http://localhost:3002'}）...`);
      const r = await postJson(
        String(fc.base_url || 'http://localhost:3002') + (fc.api_path || '/v1/scrape'),
        { url: `https://github.com/trending?since=${since}`, formats: ['rawHtml'] },
        { timeout: (fc.timeout || 25) * 1000 }
      );
      if (r.status === 200) {
        const data = (JSON.parse(r.text) || {}).data || {};
        const html = data.rawHtml || data.html || '';
        if (html) {
          let n = (html.match(/<article class="Box-row"/g) || []).length;
          let loose = false;
          if (n < 5) {
            const items = parseTrending(html, { topN: 10, loose: true, require: false });
            if (items.length >= 5) { n = items.length; loose = true; }
          }
          if (n >= 5) {
            log(`✔ Firecrawl 抓取成功（发现 ${n} 个项目条目）`);
            saveTrendingCache(since, html);
            return { html, source: 'Firecrawl（开源抓取引擎）', proxy: null, loose };
          }
          log('  Firecrawl 返回页面未解析出项目条目，回落多源抓取链');
        }
      } else {
        log(`  Firecrawl 返回 HTTP ${r.status}，回落多源抓取链`);
      }
    } catch (e) {
      log(`  Firecrawl 通道不可用（${e.name || 'Error'}），回落多源抓取链`);
    }
  }

  const chain = buildSourceChain(since, userProxy, log, mode);
  if (!chain.length) throw new Error('数据源链为空：请检查 data/mirrors.json 中 trending_sources 配置，或恢复默认值。');

  const errors = [];
  const state = { ok: false };

  const classify = (name, text, proxy) => {
    const n = (text.match(/<article class="Box-row"/g) || []).length;
    if (n >= 5) return { kind: 'OK', name, proxy, html: text, count: n, loose: false };
    const looseItems = parseTrending(text, { topN: 10, loose: true, require: false });
    if (looseItems.length >= 5) return { kind: 'OK', name, proxy, html: text, count: looseItems.length, loose: true };
    return { kind: 'BAD', name, count: n };
  };

  const probe = async (i) => {
    const src = chain[i];
    if (state.ok || (cancel && cancel.v)) return null;
    try {
      const r = await request(src.url, { timeout: 5000, proxy: src.proxy });
      return classify(src.name, r.text, src.proxy);
    } catch (e) {
      if (src.name.includes('官网直连') || src.name.includes('系统代理')) {
        try {
          await sleep(800);
          const r2 = await request(src.url, { timeout: 5000, proxy: src.proxy });
          return classify(src.name, r2.text, src.proxy);
        } catch (e2) { /* 落到失败分支 */ }
      }
      return { kind: 'FAIL', name: src.name, reason: (e && (e.code || e.message)) || String(e) };
    }
  };

  if (chain.length === 1) {
    const res = await probe(0);
    if (res && res.kind === 'OK') {
      log(`✔ ${res.name} 抓取成功（发现 ${res.count} 个项目条目）`);
      saveTrendingCache(since, res.html);
      return { html: res.html, source: res.name, proxy: res.proxy, loose: res.loose };
    }
  } else {
    const LIMIT = Math.min(6, chain.length);
    const LOOSE_WAIT = 5000;   // 宽松源（镜像站）命中后，再等官方结构源这么久以补全星标/语言
    let next = 0;
    const okResult = await new Promise((resolve) => {
      let running = 0;
      let settled = false;
      let bestLoose = null;
      let looseTimer = null;
      let cancelWatch = null;
      const settle = (res) => {
        if (settled) return;
        settled = true;
        state.ok = true;
        clearTimeout(looseTimer);
        clearInterval(cancelWatch);
        resolve(res);
      };
      // 用户点「取消」时立刻结束探测，不再等待各源超时
      cancelWatch = setInterval(() => {
        if (cancel && cancel.v) {
          log('⛔ 已取消榜单抓取');
          settle(null);
        }
      }, 250);
      const probeOne = (idx) => {
        running++;
        probe(idx).then((res) => {
          running--;
          if (settled) return;
          if (res && res.kind === 'OK') {
            if (!res.loose) {
              log(`✔ ${res.name} 抓取成功（发现 ${res.count} 个项目条目，最快源优先）`);
              return settle(res);
            }
            if (!bestLoose) {
              bestLoose = res;
              log(`✔ ${res.name} 抓取成功（宽松解析 ${res.count} 条，等待官方结构源补全星标/语言）`);
              looseTimer = setTimeout(() => settle(bestLoose), LOOSE_WAIT);
            }
          } else if (res && res.kind === 'BAD') {
            errors.push(`${res.name}: 页面结构异常（条目数 ${res.count}，宽松解析也未识别）`);
            log(`✘ ${res.name} 页面结构异常`);
          } else if (res && res.kind === 'FAIL') {
            errors.push(`${res.name}: ${res.reason}`);
            log(`✘ ${res.name} 失败（${res.reason}）`);
          }
          launch();
        });
      };
      const launch = () => {
        if (settled) return;
        while (running < LIMIT && next < chain.length) probeOne(next++);
        if (running === 0 && next >= chain.length) {
          if (bestLoose) settle(bestLoose);
          else settle(null);
        }
      };
      launch();
    });
    if (cancel && cancel.v) throw new Error('用户取消');
    if (okResult) {
      saveTrendingCache(since, okResult.html);
      return { html: okResult.html, source: okResult.name, proxy: okResult.proxy, loose: okResult.loose };
    }
  }

  if (cancel && cancel.v) throw new Error('用户取消');

  const [cached, mtime, cacheSince] = loadTrendingCacheAny(since);
  if (cached) {
    const label = `离线缓存（${cacheSince}榜 · 抓取于 ${mtime}）`;
    log(`⚠ 在线数据源全部不可用，已自动启用【离线缓存】继续（${label}）。如需最新榜单，请开启代理/加速器后重新生成。`);
    // 缓存若是官方 Trending 页面（含 Box-row 结构），按严格模式解析才能拿到语言与星标
    const cacheLoose = !/<article class="Box-row"/.test(cached);
    return { html: cached, source: label, proxy: null, loose: cacheLoose };
  }
  throw new Error('所有数据源均不可用。请在「⚙ 设置 → 网络」填写代理地址（如 Clash 的 http://127.0.0.1:7890）后重试，'
    + '网络恢复或开启加速器后即可正常生成。\n失败详情：\n' + errors.slice(0, 8).join('\n'));
}

/* ------------------------------------------------------------------ 榜单解析 */

/* 语言识别规则：先找「用 X 编写 / written in X」这类明确表述，再按词边界统计出现次数。
   不做子串匹配（此前 "evaluate" 里的 lua 会被误判成 Lua）。 */
const LANG_CANON = {
  python: 'Python', rust: 'Rust', go: 'Go', golang: 'Go', typescript: 'TypeScript', ts: 'TypeScript',
  javascript: 'JavaScript', js: 'JavaScript', java: 'Java', 'c++': 'C++', cpp: 'C++', 'c#': 'C#',
  csharp: 'C#', ruby: 'Ruby', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', dart: 'Dart',
  elixir: 'Elixir', scala: 'Scala', zig: 'Zig', lua: 'Lua', shell: 'Shell', perl: 'Perl',
  r: 'R', matlab: 'MATLAB',
};
const LANG_NAMES = Object.keys(LANG_CANON).filter(k => k !== 'ts' && k !== 'js' && k !== 'golang' && k !== 'cpp' && k !== 'csharp');
const LANG_ALT = LANG_NAMES.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const LANG_EXPLICIT_RE = new RegExp(`(?:用|使用|基于|采用)\\s*(${LANG_ALT})\\s*(?:语言)?\\s*(?:编写|开发|实现|构建)`, 'i');
const LANG_WRITTEN_RE = new RegExp(`\\bwritten in (${LANG_ALT})\\b`, 'i');
const LANG_WORD_RES = LANG_NAMES.map(k => [LANG_CANON[k], new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'gi')]);

function canonLang(name) {
  return LANG_CANON[String(name || '').toLowerCase()] || '';
}

function inferLangFromText(text) {
  if (!text) return '';
  const t = String(text);
  const m = t.match(LANG_EXPLICIT_RE) || t.match(LANG_WRITTEN_RE);
  if (m) return canonLang(m[1]);
  let best = '';
  let bestN = 0;
  for (const [lang, re] of LANG_WORD_RES) {
    const n = (t.match(re) || []).length;
    if (n > bestN) { best = lang; bestN = n; }
  }
  return bestN >= 2 ? best : '';   // 至少出现两次才当作证据，避免误判
}

function parseKNum(numTxt) {  let t = String(numTxt || '').trim().replace(/,/g, '').replace(/\s+/g, '');
  let mult = 1;
  if (/[kK]$/.test(t)) { mult = 1000; t = t.slice(0, -1); }
  const v = parseFloat(t);
  if (!isFinite(v)) return null;
  return Math.round(v * mult);
}

const NON_PROJECT_PREFIX = ['topics/', 'features/', 'about/', 'sponsors/', 'settings/', 'explore/',
  'collections/', 'events/', 'marketplace/', 'orgs/', 'users/', 'login', 'signup', 'pricing/',
  'customer-stories/', 'readme/', 'search', 'trending'];

function makeItem(fullName, extra) {
  const owner = fullName.split('/')[0] || '';
  const repo = fullName.split('/').slice(1).join('/') || '';
  const links = getMirrorsCfg().linkTemplates;
  const tpl = (k) => (links[k] || FALLBACK_LINKS[k]);
  return Object.assign({
    rank: 0,
    full_name: fullName,
    owner,
    repo,
    url: tpl('github').replace(/\{full_name\}/g, fullName).replace(/\{repo\}/g, repo),
    gitee_url: tpl('gitee').replace(/\{full_name\}/g, fullName).replace(/\{repo\}/g, repo.toLowerCase()),
    mirror_url: tpl('mirror').replace(/\{full_name\}/g, fullName).replace(/\{repo\}/g, repo),
    store_url: tpl('store').replace(/\{full_name\}/g, fullName).replace(/\{repo\}/g, repo),
    lang: '未标注',
    desc: '暂无相关信息',
    total_stars: '暂无相关信息',
    period_stars: '暂无相关信息',
  }, extra || {});
}

/* ===== 镜像链接真实性校验：避免报告里出现打不开 / 「没有这内容」的假地址 ===== */
const _linkAliveCache = new Map();
async function linkAlive(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (_linkAliveCache.has(u)) return _linkAliveCache.get(u);
  let ok = false;
  try {
    const res = await request(u, { method: 'GET', timeout: 8000, maxRedirects: 3 });
    const st = res.status || 0;
    if (st >= 200 && st < 400) {
      const head = String(res.text || '').slice(0, 8000);
      // 软 404：HTTP 打得开但页面明示不存在（如 Gitee「没有这内容」）
      ok = !/没有这内容|页面不存在|找不到页面|无法找到该页面/.test(head);
    }
  } catch (e) { ok = false; }
  _linkAliveCache.set(u, ok);
  return ok;
}

/** 校验项目三类镜像链接（Gitee/加速镜像/github.store），把打不开的清空，报告里不再展示假地址 */
async function verifyItemLinks(it) {
  const res = await Promise.all([
    linkAlive(it.gitee_url),
    linkAlive(it.mirror_url),
    linkAlive(it.store_url),
  ]);
  if (!res[0]) it.gitee_url = '';
  if (!res[1]) it.mirror_url = '';
  if (!res[2]) it.store_url = '';
}

/* ===== 定位 GitHub 项目在 Gitee 上的真实镜像地址 =====
 * Gitee 站内搜索是 JS 渲染、纯 GET 抓不到结果（实测只返回 Loading 外壳），所以改为
 * 「按官方镜像约定直接构造候选地址 + 逐一探测是否真实可访问」。
 * GitHub 热门项目的 Gitee 镜像通常位于 gitee.com/mirrors/{项目名}，或由同名 owner 自建镜像；
 * 只把探测可访问（HTTP 2xx/3xx 且非「没有这内容」软 404）的真实地址写入报告，绝不编造假链接。 */
async function findGiteeMirror(fullName, repo, proxy) {
  const owner = String(fullName || '').split('/')[0].toLowerCase();
  const repoL = String(repo || '').trim().toLowerCase();
  if (!repoL) return '';
  const candidates = [
    `https://gitee.com/mirrors/${repoL}`,
    owner ? `https://gitee.com/${owner}/${repoL}` : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (await linkAlive(c)) return c;
  }
  return '';
}

/** 清理镜像站（gitcn 等）描述里的项目名前缀与页面残留 */
function cleanTrendingDesc(desc, fullName) {
  let t = String(desc || '').trim();
  if (!t) return '';
  const parts = String(fullName || '').split('/');
  const repo = parts[1] || '';
  for (const p of [fullName, repo]) {
    if (!p) continue;
    if (t.toLowerCase().startsWith(String(p).toLowerCase())) {
      t = t.slice(String(p).length).replace(/^[\s:：|\-–—]+/, '').trim();
      break;
    }
  }
  t = t.replace(/^来自\s*AI\s*总结显示原文\s*/i, '')
    .replace(/\s*Build by\s*\d+/gi, ' ')
    .replace(/\b[\d.]+ ?[kK]?\s*(今天|今日|today)\b/gi, ' ')
    .replace(/\s*Fork (it|this repo)( and own it)?[.!]?\s*$/i, '')
    .replace(/\s*Star (us|this repo)[.!]?\s*$/i, '')
    .replace(/\s*(Pull requests?|Contributions?) welcome[.!]?\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

function parseTrendingLoose(htmlText, topN = 10) {
  const items = [];
  const seen = new Set();
  if (!htmlText) return items;
  const patterns = [
    /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)"/g,
    /href="\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)\/stargazers"/g,
    /href="https:\/\/github\.com\/([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)"/g,
  ];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(htmlText))) {
      const full = String(m[1] || '').trim();
      if (!full || seen.has(full) || !full.includes('/')) continue;
      if (NON_PROJECT_PREFIX.some(p => full.startsWith(p))) continue;
      seen.add(full);
      const window = htmlText.slice(m.index + m[0].length, m.index + m[0].length + 8000);
      let d = window.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (!d) d = window.match(/<div[^>]*class="[^"]*line-clamp-[0-9]+[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      let desc = d ? stripTags(d[1]) : '';
      desc = cleanTrendingDesc(desc, full);
      let totalTxt = '暂无相关信息';
      let periodTxt = '暂无相关信息';
      const tm = window.match(/<!--\s*-->\s*([\d.]+ ?[kK]?)(?=<\/span>)/);
      const pm = window.match(/<!--\s*-->\s*(\d+)(?=<!--\s*-->\s*<!--\s*-->\s*(?:今天|今日)<\/span>)/);
      if (tm) {
        const tv = parseKNum(tm[1]);
        if (tv !== null) totalTxt = tv.toLocaleString('en-US');
      }
      if (pm) periodTxt = `+${pm[1]}`;
      items.push(makeItem(full, {
        rank: items.length + 1,
        lang: inferLangFromText(desc) || '未标注',
        desc: desc || '暂无相关信息',
        total_stars: totalTxt,
        period_stars: periodTxt,
      }));
      if (items.length >= topN) return items;
    }
  }
  return items;
}

/* ===== Gitee「热门项目 / explore」列表页解析（gitee.com/explore/all?order=starred）===== */
function isGiteeExploreHtml(htmlText) {
  return /gitee\.com\/explore|Gitee 最有价值|gitee\.com\/gvp|<title>[^<]*Gitee/i.test(String(htmlText || ''));
}

function parseGiteeExplore(htmlText, topN = 10) {
  const items = [];
  const seen = new Set();
  if (!htmlText) return items;
  const NONSEG = ['explore', 'login', 'gvp', 'topics', 'user', 'search', 'help', 'about', 'api',
    'enterprise', 'git', 'trending', 'notifications', 'profile', 'settings', 'enterprises', 'schools'];
  // 仓库标题链接：https://gitee.com/{owner}/{repo}（或相对 href="/{owner}/{repo}"），需紧跟两段路径
  const linkRe = /(?:https?:\/\/gitee\.com\/|href=["']\/)([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)(?=["'<\s?&#])/g;
  const positions = [];
  let m;
  while ((m = linkRe.exec(htmlText))) {
    const full = String(m[1]).replace(/\.git$/i, '');
    if (!full || seen.has(full)) continue;
    const owner = full.split('/')[0].toLowerCase();
    if (NONSEG.includes(owner)) continue;
    if (NON_PROJECT_PREFIX.some(p => full.startsWith(p))) continue;
    seen.add(full);
    positions.push({ full, idx: m.index });
  }
  for (let i = 0; i < positions.length && items.length < topN; i++) {
    const start = positions[i].idx;
    const end = (i + 1 < positions.length) ? positions[i + 1].idx : Math.min(start + 9000, htmlText.length);
    const win = htmlText.slice(start, end);
    // 星标：优先「数字+K/M」，否则取块内较大纯数字
    let stars = '暂无相关信息';
    const smK = win.match(/([0-9][0-9.,]*)\s*([kKmM])\b/);
    if (smK) {
      let v = parseFloat(smK[1].replace(/,/g, ''));
      const u = smK[2].toLowerCase();
      if (u === 'k') v *= 1000; else if (u === 'm') v *= 1000000;
      if (isFinite(v)) stars = Math.round(v).toLocaleString('en-US');
    } else {
      const smN = win.match(/([0-9][0-9.,]{2,})\b/);
      if (smN) { const v = parseFloat(smN[1].replace(/,/g, '')); if (isFinite(v)) stars = Math.round(v).toLocaleString('en-US'); }
    }
    // 语言：?lang=XXX
    const lm = win.match(/[?&]lang=([A-Za-z0-9+#.%]+)/);
    let lang = lm ? decodeURIComponent(lm[1]) : '未标注';
    // 描述：优先 <p class="desc">，其次任意 <p>，最后取块内最长文本
    let desc = '';
    const dmDesc = win.match(/<p[^>]*class="[^"]*desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const dmP = dmDesc || win.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (dmP) desc = stripTags(dmP[1]);
    if (!desc || desc.length < 8) {
      const chunks = stripTags(win).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      for (const c of chunks) {
        if (c.length > desc.length && c.length > 10 && !/^[0-9.,]+[kKmM]?$/.test(c) && !c.includes('http')) desc = c;
      }
    }
    desc = cleanTrendingDesc(desc, positions[i].full);
    const it = makeItem(positions[i].full, {
      rank: items.length + 1,
      lang: lang === '未标注' ? (inferLangFromText(desc) || '未标注') : lang,
      desc: desc || '暂无相关信息',
      total_stars: stars,
      period_stars: '暂无相关信息',
    });
    // 这些是 Gitee 仓库：报告链接指向 Gitee，避免给出打不开的 GitHub 假地址
    it.url = 'https://gitee.com/' + positions[i].full;
    it.gitee_url = 'https://gitee.com/' + positions[i].full;
    it.mirror_url = '';
    it.store_url = '';
    items.push(it);
  }
  return items;
}

function parseTrending(htmlText, opt = {}) {
  const topN = opt.topN || 10;
  const require = opt.require !== false;
  if (isGiteeExploreHtml(htmlText)) {
    const gitems = parseGiteeExplore(htmlText, topN);
    if (gitems.length) return gitems;
    if (require) throw new Error('Gitee 热门项目页面解析失败：未提取到项目条目');
  }
  if (opt.loose) {
    const looseItems = parseTrendingLoose(htmlText, topN);
    if (looseItems.length) return looseItems;
  }
  const articles = String(htmlText || '').match(/<article class="Box-row"[\s\S]*?<\/article>/g) || [];
  const items = [];
  for (const art of articles) {
    const m = art.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"/);
    if (!m) continue;
    const fullName = m[1].trim();
    const d = art.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const desc = d ? stripTags(d[1]) : '';
    const l = art.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/);
    const s = art.match(/href="\/[^"]+\/stargazers"[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)/);
    const p = art.match(/float-sm-right[^>]*>[\s\S]*?<\/svg>\s*\+?([\d,]+)\s+stars?\s+(today|this week|this month)/);
    items.push(makeItem(fullName, {
      rank: items.length + 1,
      lang: l ? l[1].trim() : '未标注',
      desc: desc || '暂无相关信息',
      total_stars: s ? s[1].trim() : '暂无相关信息',
      period_stars: p ? `+${p[1].trim()}` : '暂无相关信息',
    }));
    if (items.length >= topN) break;
  }
  if (!items.length && require) throw new Error('页面解析失败：未提取到任何项目条目（页面结构可能已变化）');
  return items;
}

/** 官方榜单补充数据（给宽松解析的镜像榜单补语言/星标），本地缓存 24 小时 */
async function fetchOfficialTrendingStats(since, proxy, log) {
  const cacheFile = path.join(DATA_DIR, `trending_extra_${since || 'monthly'}.json`);
  let staleStats = null;
  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8').replace(/^\uFEFF/, ''));
      if (data.stats && Object.keys(data.stats).length) {
        if (Date.now() / 1000 - (data.ts || 0) < REPO_CACHE_TTL) {
          log(`✔ 使用官方榜单补充缓存（${Object.keys(data.stats).length} 个项目）`);
          return data.stats;
        }
        staleStats = data.stats;   // 过期缓存留作联网失败时的兜底
      }
    }
  } catch (e) { /* ignore */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request(`https://github.com/trending?since=${since}`, { timeout: 15000, proxy });
      const stats = {};
      for (const it of parseTrending(r.text, { topN: 30, loose: false })) {
        stats[it.full_name] = [it.lang || '', it.total_stars || '', it.period_stars || ''];
      }
      if (Object.keys(stats).length) {
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now() / 1000, stats }), 'utf8');
        } catch (e) { /* ignore */ }
        log(`✔ 已获取 GitHub 官方榜单数据（${Object.keys(stats).length} 个项目，用于补充语言等字段）`);
      }
      return stats;
    } catch (e) {
      if (attempt === 0) log(`  - 官方榜单补充第 1 次失败（${e.code || e.message}），重试…`);
      else log(`  - 官方榜单补充未成功（${e.code || e.message}）`);
    }
  }
  if (staleStats) {
    log(`⚠ 改用本机历史官方榜单缓存补充语言/星标（${Object.keys(staleStats).length} 个项目）`);
    return staleStats;
  }
  return {};
}

/* --------------------------------------------------------- 仓库元数据 / README */

function cleanReadme(text, maxChars = 4000) {
  let t = String(text || '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[!\[[^\]]*\][^)]*\)/g, '');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, maxChars);
}

/** 把 HTML 片段转成纯文本（保留段落/列表换行） */
function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  return unescapeHtml(t).replace(/[ \t]+/g, ' ');
}

function hostOf(url) {
  const m = String(url).match(/^https?:\/\/([^/]+)/);
  return m ? m[1] : url;
}

function parseLicenseFromHtml(html) {
  let m = html.match(/"licenseInfo"\s*:\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/"license"\s*:\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  const ms = html.match(/"label"\s*:\s*"([^"]*[Ll]icense[^"]*)"/g);
  if (ms && ms.length) {
    const mm = ms[0].match(/"label"\s*:\s*"([^"]*)"/);
    if (mm) return mm[1];
  }
  m = html.match(/<a[^>]*href="\/[^"]*\/blob\/[^"]*\/LICENSE[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,60}?)\s*<\/a>/);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  return '';
}

async function fetchRepoMeta(fullName, proxy) {
  for (const url of [`https://github.com/${fullName}`, `https://kkgithub.com/${fullName}`]) {
    try {
      const r = await request(url, { timeout: 15000, proxy });
      const html = r.text;
      if (!html.slice(0, 200).toLowerCase().includes('<!doctype') || html.length < 5000) continue;
      let topics = [...html.matchAll(/class="topic-tag[^"]*"[^>]*href="[^"]*\/topics\/([^"]+)"/g)].map(m => m[1]);
      if (!topics.length) {
        const tm = html.match(/"topics"\s*:\s*\[([\s\S]*?)\]/);
        if (tm) {
          const names = [...tm[1].matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
          topics = names.length ? names : [...tm[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(x => x !== 'name');
        }
      }
      // 仓库页自带渲染好的 README，可作为多通道抓取全失败时的兜底资料
      const rm = html.match(/<article[^>]*class="[^"]*markdown-body[^"]*"[^>]*>([\s\S]*?)<\/article>/);
      const readmeText = rm ? cleanReadme(htmlToText(rm[1]), 4000) : '';
      let created = '';
      let m = html.match(/"createdAt"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
      if (m) created = m[1];
      let homepage = '';
      m = html.match(/"homepageUrl"\s*:\s*"([^"]+)"/);
      if (m) homepage = m[1];
      let stars = '';
      m = html.match(/"stargazerCount"\s*:\s*(\d+)/);
      if (m) stars = m[1];
      let lang = '';
      m = html.match(/"primaryLanguage"\s*:\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/);
      if (m) lang = m[1];
      // 根目录文件清单：用于「是否需要部署」判定（GitHub 仓库页内嵌 tree items，无需 API）
      let files = [];
      const treeM = html.match(/"tree"\s*:\s*\{\s*"items"\s*:\s*\[([\s\S]{0,30000}?)\]\s*,\s*"totalCount"/);
      if (treeM) files = [...treeM[1].matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(x => x[1]);
      if (!files.length) {
        files = [...html.matchAll(/aria-label="([^",]+), (?:File|Directory)"/g)].map(x => x[1]);
      }
      return {
        created_at: created,
        topics: [...new Set(topics)].slice(0, 10),
        homepage,
        license: parseLicenseFromHtml(html),
        stars,
        lang,
        files: [...new Set(files)].slice(0, 80),
        readme_text: readmeText,
      };
    } catch (e) { /* 尝试下一个入口 */ }
  }
  return null;
}

function hostFails() {
  const dead = new Set();
  return {
    ok: (h) => !dead.has(h),
    kill: (h) => dead.add(h),
  };
}

async function fetchReadmeMulti(item, proxy, hf) {
  const mc = getMirrorsCfg();
  const fullName = item.full_name;
  const repo = String(item.repo).toLowerCase();
  for (const ch of mc.readmeChannels) {
    const host = hostOf(ch.url);
    if (hf && !hf.ok(host)) continue;
    for (const br of mc.branches) {
      const url = String(ch.url)
        .replace(/\{full_name\}/g, fullName)
        .replace(/\{repo\}/g, repo)
        .replace(/\{branch\}/g, br);
      let r;
      try {
        r = await request(url, { timeout: 7000, proxy, verify: !ch.no_verify });
      } catch (e) {
        if (hf) hf.kill(host);
        break;
      }
      if (r.status === 200 && r.text.length > 50 && !r.text.slice(0, 200).toLowerCase().includes('<!doctype')) {
        return [cleanReadme(r.text), `${ch.name}（${br}）`];
      }
    }
  }
  return [null, null];
}

/* -------------------------------------------------------------- 翻译（英译中） */

const _transCache = new Map();
const _onlineTransCache = new Map();
const _transDeadHosts = new Set();

function translateOffline(text, minCoverage = 0.45) {
  if (!text || text === '暂无相关信息') return '';
  if (_transCache.has(text)) return _transCache.get(text);
  const words = (loadData('dict_terms.json', {}) || {}).words || {};
  const t = String(text).toLowerCase();
  const letters = Math.max(1, (t.match(/[a-z]/g) || []).length);
  const keys = Object.keys(words).filter(k => k && words[k]).sort((a, b) => b.length - a.length);
  const spans = [];
  for (const k of keys) {
    const cn = words[k];
    let start = 0;
    for (;;) {
      const i = t.indexOf(k, start);
      if (i < 0) break;
      const leftOk = i === 0 || !/[a-z0-9]/.test(t[i - 1]);
      const right = i + k.length;
      const rightOk = right >= t.length || !/[a-z0-9]/.test(t[right]);
      if (leftOk && rightOk) spans.push([i, right, cn]);
      start = i + 1;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  let last = -1;
  let covered = 0;
  for (const [a, b, cn] of spans) {
    if (a >= last) {
      out.push(cn);
      covered += b - a;
      last = b;
    }
  }
  const result = out.length && covered / letters >= minCoverage ? out.join(' ') : '';
  _transCache.set(text, result);
  return result;
}

let _transOffline = false;
let _transProxy = null;
const CJK_RE = /[\u4e00-\u9fa5]/;

function hasCJK(s) { return CJK_RE.test(String(s || '')); }

function setTranslateProxy(p) { _transProxy = p || null; }

/** 火山翻译（浏览器扩展公开接口，无需 Key，国内可直连，质量接近商用翻译） */
async function volcTranslate(text, timeout = 6000) {
  if (_transDeadHosts.has('volcengine')) return '';
  try {
    const r = await request('https://translate.volcengine.com/crx/translate/v1/', {
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://translate.volcengine.com',
        Referer: 'https://translate.volcengine.com/',
      },
      body: JSON.stringify({ source_language: 'en', target_language: 'zh', text }),
    });
    if (r.status !== 200) return '';
    const j = JSON.parse(r.text);
    const t = String((j && j.translation) || '').trim();
    return t && hasCJK(t) ? t : '';
  } catch (e) {
    _transDeadHosts.add('volcengine');
    return '';
  }
}

/**
 * 免费在线英译中（无需 Key），按可用性依次尝试：
 *   火山翻译（国内直连）→ Google（海外/挂代理）→ 内置词典（调用方兜底）
 * 已有中文的文本直接返回；单次调用有硬上限，超时即整轮关闭在线通道。
 */
async function onlineTranslate(text, timeout = 6000) {
  const src = String(text == null ? '' : text).trim();
  if (src.length < 2) return '';
  if (hasCJK(src)) return src;
  if (_transOffline) return '';
  if (_onlineTransCache.has(src)) return _onlineTransCache.get(src) || '';

  const work = (async () => {
    const v = await volcTranslate(src, timeout);
    if (v) return v;
    const q = encodeURIComponent(src.slice(0, 1200));
    const urls = [
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`,
      `https://translate.google.cn/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`,
    ];
    for (const url of urls) {
      const host = new URL(url).hostname;
      if (_transDeadHosts.has(host)) continue;
      try {
        const r = await request(url, { timeout: Math.min(timeout, 5000), verify: false, proxy: _transProxy });
        if (r.status !== 200) continue;
        const j = JSON.parse(r.text);
        const seg = (j[0] || []).map(x => (x && x[0]) || '').join('').trim();
        if (seg && hasCJK(seg)) return seg;
      } catch (e) {
        _transDeadHosts.add(host);
      }
    }
    return '';
  })();

  const TIMEOUT = Symbol('translate-timeout');
  const raced = await Promise.race([work, new Promise(r => setTimeout(() => r(TIMEOUT), timeout + 2000))]);
  if (raced === TIMEOUT) {
    _transOffline = true;
    _onlineTransCache.set(src, '');
    return '';
  }
  const seg = raced || '';
  _onlineTransCache.set(src, seg);
  return seg;
}

function translationOffline() { return _transOffline; }

/* ------------------------------------------------------------ 内置分析引擎 */

function countKeywordHits(text, keywords) {
  let n = 0;
  const t = String(text || '').toLowerCase();
  for (const kw of keywords || []) {
    const k = String(kw).toLowerCase();
    if (!k) continue;
    const re = new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    if (re.test(t)) n++;
  }
  return n;
}

/** 分类识别：项目名+简介权重高，README 只作补强；证据不足时归入「综合工具」，避免乱套模板 */
function detectCategory(item, readme) {
  const cats = loadData('categories.json', {}) || {};
  const table = cats.categories || {};
  const order = cats['_优先级'] && cats['_优先级'].length ? cats['_优先级'] : Object.keys(table);
  const head = `${item.full_name} ${item.desc}`;
  const rd = String(readme || '').slice(0, 4000);
  let best = null;
  let bestScore = 0;
  for (const key of order) {
    const cat = table[key];
    if (!cat || !(cat.keywords || []).length) continue;
    const s1 = countKeywordHits(head, cat.keywords);
    const s2 = Math.min(3, countKeywordHits(rd, cat.keywords));
    const score = s1 * 3 + (s1 > 0 ? s2 : (s2 >= 2 ? s2 : 0));
    if (score > bestScore) { best = key; bestScore = score; }
  }
  if (!best || bestScore < 3) return [table.other || {}, 'other'];
  return [table[best], best];
}

/** 清理 README 行：去图片/HTML/链接/emoji/标记符号 */
function cleanReadmeLine(line, maxLen = 110) {
  let t = String(line || '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, ' ');
  t = t.replace(/[`*_>#|]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, maxLen);
}

const README_FEATURE_HEAD_RE = /(?:^|\n)#{1,6}\s*[^\n]{0,24}(features?|功能|特性|亮点|特点|highlights?|capabilities|what it does|主要功能|核心功能)[^\n]{0,24}\n([\s\S]*?)(?=\n#{1,6}\s|$)/i;
const README_BULLET_RE = /^\s*(?:[-*•+]\s+|\d{1,2}[.)]\s+)(.{6,220})/;

function extractReadmePoints(readme) {
  const bullets = [];
  const eco = [];
  if (!readme) return [bullets, eco];
  const text = String(readme);
  const m = text.match(README_FEATURE_HEAD_RE);
  const seg = m ? m[2] : text.slice(0, 3500);
  const seen = new Set();
  for (const line of String(seg).split('\n')) {
    const b = line.trim().match(README_BULLET_RE);
    let raw = b ? b[1] : '';
    if (!raw && /^\s*\|.+\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2 && cells[0].length >= 6 && !/^[-: ]+$/.test(cells[0])) raw = cells[0] + '：' + cells[1];
    }
    if (!raw) continue;
    const txt = cleanReadmeLine(raw, 100);
    if (txt.length < 8 || seen.has(txt)) continue;
    // 过滤安装/使用命令类条目，它们不是「功能要点」
    if (/^(npm|npx|yarn|pnpm|bun|pip|pip3|uv|poetry|cargo|go|git|curl|wget|docker|cd|brew|apt|make|python|node|deno)\b/i.test(txt)) continue;
    if (/^[\w./-]+\s+--?[a-z]/i.test(txt)) continue;
    seen.add(txt);
    bullets.push(txt);
    if (bullets.length >= 6) break;
  }
  if (/npm (install|i)\b|npx\b|yarn add|pnpm add|bun add/i.test(text)) eco.push('npm / Node.js 生态分发');
  if (/pip install|pip3 install|uv add|uvx\b|poetry add|pipx/i.test(text)) eco.push('pip / Python 生态分发');
  if (/cargo (install|add|build)/i.test(text)) eco.push('cargo / Rust 生态');
  if (/go get|go install/i.test(text)) eco.push('Go modules 生态');
  if (/brew install/i.test(text)) eco.push('Homebrew 分发');
  if (/docker (run|compose|build)|dockerfile/i.test(text)) eco.push('Docker 容器化支持');
  if (/\b(web ui|web interface|dashboard|browser)\b/i.test(text)) eco.push('自带 Web 界面');
  return [bullets, eco];
}

const TECH_RULES = [
  [/\breact(\.js)?\b/i, 'React'], [/\bnext\.js\b/i, 'Next.js'], [/\bvue(\.js)?\b/i, 'Vue'],
  [/\bsvelte(kit)?\b/i, 'Svelte'], [/\bnuxt\b/i, 'Nuxt'], [/\belectron\b/i, 'Electron'], [/\btauri\b/i, 'Tauri'],
  [/\bwebgl\b|\bthree\.js\b/i, 'WebGL / Three.js'], [/\bwebassembly\b|\bwasm\b/i, 'WebAssembly'],
  [/\bdocker\b/i, 'Docker'], [/\bkubernetes\b|\bk8s\b/i, 'Kubernetes'],
  [/\bpytorch\b|\btorch\b/i, 'PyTorch'], [/\btensorflow\b/i, 'TensorFlow'], [/\btransformers\b/i, 'Hugging Face'],
  [/\bfastapi\b/i, 'FastAPI'], [/\bflask\b/i, 'Flask'], [/\bdjango\b/i, 'Django'], [/\bexpress\b/i, 'Express'],
  [/\bpostgres(ql)?\b/i, 'PostgreSQL'], [/\bsqlite\b/i, 'SQLite'], [/\bredis\b/i, 'Redis'], [/\bmongodb\b/i, 'MongoDB'],
  [/\bgraphql\b/i, 'GraphQL'], [/\bgrpc\b/i, 'gRPC'], [/\bnode\.?js\b/i, 'Node.js'], [/\bbun\b/i, 'Bun'],
  [/\bdeno\b/i, 'Deno'], [/\bmcp\b/i, 'MCP 工具协议'], [/\bopenai\b/i, 'OpenAI 兼容接口'],
  [/\bllama\.?cpp\b|\bgguf\b/i, 'GGUF / llama.cpp'], [/\bvllm\b/i, 'vLLM'], [/\bolllama\b/i, 'Ollama'],
];

function extractTechStack(readme, meta) {
  const hay = `${readme || ''} ${((meta || {}).topics || []).join(' ')}`.slice(0, 12000);
  const out = [];
  for (const [re, name] of TECH_RULES) {
    if (out.includes(name)) continue;
    if (re.test(hay)) out.push(name);
  }
  return out.slice(0, 8);
}

/** README 语言推断（仅在没有任何权威语言信息时使用，要求明确证据） */
function inferLangStrict(text) {
  if (!text) return '';
  const t = String(text).slice(0, 4000);
  const m = t.match(/\b(?:written|implemented|built|developed) in ([A-Za-z+#.]{1,12})\b/i)
    || t.match(/```(rust|go|python|typescript|javascript|ruby|java|csharp|swift|kotlin|php|dart|elixir|scala|zig|lua)\b/i);
  if (!m) return '';
  const raw = String(m[1] || '').toLowerCase();
  const map = {
    rust: 'Rust', go: 'Go', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript',
    ruby: 'Ruby', java: 'Java', 'c++': 'C++', csharp: 'C#', 'c#': 'C#', swift: 'Swift', kotlin: 'Kotlin',
    php: 'PHP', dart: 'Dart', elixir: 'Elixir', scala: 'Scala', zig: 'Zig', lua: 'Lua',
  };
  return map[raw] || '';
}

async function builtinIntroCnAsync(item) {
  const kb = kbLookup(item);
  if (kb && kb.intro_cn) return [kb.intro_cn, '知识库'];
  const t = await onlineTranslate(item.desc);
  if (t) return [`${t}（英文原文：${item.desc}）`, '免费在线翻译'];
  const gloss = translateOffline(item.desc);
  if (gloss) return [`${gloss}（英文原文：${item.desc}）`, '词典'];
  return [`${item.desc}（英文原文）`, '原文'];
}

/** 从 G 段分析文本反推协议短名（离线/无 meta 时兜底） */
function licenseFromText(text) {
  if (!text) return '';
  for (const [kw, name, verdict] of LICENSE_INFO) {
    if (kw === 'no license') continue;
    if (!verdict) continue;
    if (new RegExp(`(^|[^A-Za-z])${kw.replace(/[-]/g, '[- ]?')}([^A-Za-z]|$)`, 'i').test(String(text))) return name;
  }
  return '';
}

function parseLicenseFromReadme(readme) {
  if (!readme) return '';
  const rules = [
    [/apache[- ]?2\.0|apache\s+license/i, 'Apache-2.0'],
    [/permission is hereby granted|mit\s+license|license[:\s]+mit\b/i, 'MIT'],
    [/gnu\s+(?:affero\s+)?general public license|agpl[- ]?3\.0|gpl[- ]?3\.0|gpl[- ]?2\.0/i, 'GPL'],
    [/gnu\s+lesser\s+general public license|lgpl/i, 'LGPL'],
    [/mozilla\s+public\s+license|mpl[- ]?2\.0/i, 'MPL'],
    [/eclipse\s+public\s+license|epl[- ]?[12]\.0/i, 'EPL'],
    [/bsd[- ]?[23]?-?clause|redistribution and use in source/i, 'BSD'],
    [/creative commons[^\n]{0,20}?zero|cc0/i, 'CC0'],
    [/the\s+unlicense|this is free and unencumbered software/i, 'Unlicense'],
    [/no\s+license|all\s+rights\s+reserved/i, 'no license'],
  ];
  for (const [pat, name] of rules) if (pat.test(readme)) return name;
  return '';
}

function licenseG(meta, kb, readme) {
  let lic = ((kb || {}).license || (meta || {}).license || '');
  if (!lic && readme) lic = parseLicenseFromReadme(readme);
  if (!lic) {
    return '未检测到开源协议（README 中未标注 License；若项目确无协议则默认保留作者版权，'
      + '如需修改、商用或再分发请先联系作者获得授权。也可在 data/kb_projects.json 为该仓库补充 license 字段）';
  }
  return licenseAnalysis(lic);
}

/** 把中文句子拆成条目（去重、去空、限长） */
function splitClauses(text, max = 5) {
  return String(text || '')
    .split(/[。；;！!？?]\s*|\n+/)
    .map(s => s.replace(/^[\s\-*•]+/, '').trim())
    .filter(s => s.length >= 8 && s.length <= 120)
    .slice(0, max);
}

/** 按项目名做稳定轮换，避免同分类项目拿到完全相同的模板条目 */
function rotateByKey(arr, key, count) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  if (!list.length) return [];
  const h = [...String(key || '')].reduce((a, c) => a + c.charCodeAt(0), 0);
  const start = h % list.length;
  const out = [];
  for (let i = 0; i < list.length && out.length < count; i++) out.push(list[(start + i) % list.length]);
  return out;
}

/** 适用场景：先用仓库里真实出现的形态线索（CLI / Web / 自托管 / 插件 / API），再补分类场景 */
function buildScenes(item, descCn, readme, cat) {
  const hay = `${descCn || ''} ${item.desc || ''} ${String(readme || '').slice(0, 3000)}`;
  const cues = [];
  if (/命令行|\bcli\b|terminal|shell/i.test(hay)) cues.push('在终端 / 命令行里直接使用');
  if (/浏览器|browser|web ui|web 界面|dashboard|网页/i.test(hay)) cues.push('在浏览器 / Web 界面中使用');
  if (/self-?host|私有部署|私有化|docker/i.test(hay)) cues.push('自托管 / 私有化部署到自己的服务器');
  if (/\bapi\b|sdk|\blibrary\b|作为库/i.test(hay)) cues.push('作为库 / API 集成进现有系统');
  if (/插件|plugin|extension|扩展/i.test(hay)) cues.push('作为插件 / 扩展嵌入宿主工具');
  if (/agent|智能体/i.test(hay)) cues.push('接入 AI 智能体工作流');
  if (/离线|offline|本地|local-first/i.test(hay)) cues.push('离线 / 本地优先场景，数据不出本机');
  const out = [];
  for (const x of cues.slice(0, 3).concat(rotateByKey(cat.scenes, item.full_name, 3))) {
    if (!out.includes(x)) out.push(x);
    if (out.length >= 4) break;
  }
  return out;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function normalizeCmp(s) {
  return String(s || '').replace(/[\s，。；、,.;:：!！?？\-—（）()【】[\]"'“”]/g, '').toLowerCase();
}

/** 机器翻译常见开发术语修正 + 中英之间补空格 */
function postEditTranslation(s) {
  let t = String(s || '')
    .replace(/分叉(它|本仓库|该仓库|这个仓库|仓库)?/g, 'Fork')
    .replace(/拉取请求/g, 'Pull Request')
    .replace(/问题追踪(器|系统)?/g, 'Issue 跟踪')
    .replace(/\s{2,}/g, ' ')
    .trim();
  t = t.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

/** 判断两条文案是否高度重复（包含，或中文二元组重合度 > 0.5） */
function isSimilarText(a, b) {
  const x = normalizeCmp(a);
  const y = normalizeCmp(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  if (x.length < 6 || y.length < 6) return false;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(x);
  const gb = grams(y);
  let inter = 0;
  let na = 0;
  let nb = 0;
  ga.forEach(v => { na += v; });
  gb.forEach(v => { nb += v; });
  ga.forEach((v, k) => { if (gb.has(k)) inter += Math.min(v, gb.get(k)); });
  return inter / (na + nb - inter) > 0.5;
}

function pickByKey(arr, key) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.length) return '';
  const h = [...String(key || '')].reduce((a, c) => a + c.charCodeAt(0), 0);
  return list[h % list.length];
}

/** README 摘要：优先取「像介绍」的长段落；只有短标语时退回标语 */
function extractReadmeSummary(readme) {
  if (!readme) return '';
  const blocks = String(readme).split(/\n\s*\n/).map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const noise = /^(#|\||```|!\[|<|badge|table of contents|contents|install|installation|usage|license|licence|contribut|sponsor|acknowledg|changelog|faq|note:|disclaimer|warning)/i;
  const installLike = /\b(download|downloads|install|installation|npm i|npx|curl|brew|pip install|docker run|git clone)\b/i;
  const langList = /(English|简体中文|繁體中文|日本語|한국어|Deutsch|Español|Français|Italiano|Português|Русский|العربية)/i;
  const candidates = [];
  for (const b of blocks) {
    if (b.length < 20 || b.length > 600) continue;
    if (noise.test(b)) continue;
    if (installLike.test(b)) continue;
    if (/^[\w.-]+\/[\w.-]+$/.test(b)) continue;
    if ((b.match(/https?:\/\//g) || []).length > 1) continue;
    if (langList.test(b) && (b.split(/[|｜]/).length >= 2 || b.length < 200)) continue;
    if ((b.match(/[|｜]/g) || []).length >= 4) continue;
    if (!/[a-zA-Z]{3}/.test(b)) continue;
    candidates.push(b);
    if (candidates.length >= 5) break;
  }
  if (!candidates.length) return '';
  const long = candidates.find(b => b.length >= 80);
  return long || candidates[0];
}

/** README 的二级/三级标题（原始 Markdown 才有 # 标记） */
function extractReadmeHeadings(readme) {
  if (!readme) return [];
  const out = [];
  const noise = /install|usage|license|licence|contribut|sponsor|acknowledg|changelog|faq|table of contents|contents|credits?|disclaimer|安装|许可证|贡献/i;
  for (const m of String(readme).matchAll(/^\s{0,3}(#{2,3})\s+(.+?)\s*$/gm)) {
    const title = m[2].replace(/[`*_]/g, '').trim();
    if (!title || title.length > 40 || noise.test(title)) continue;
    if (out.includes(title)) continue;
    out.push(title);
    if (out.length >= 8) break;
  }
  return out;
}

/* 同一次运行内按分类计数：同分类的共性问题只展开一次，避免整份报告读起来像复读 */
const _catUseCount = new Map();

async function builtinAnalyze(item, readme, meta, cat) {
  const kb = kbLookup(item);
  if (kb) {
    const created = kb.created || (meta || {}).created_at || '';
    let A = kb.A || '';
    if (created && !String(A).includes(created)) A = `（仓库创建：${created}）` + A;
    return {
      S: kb.intro_cn || '',
      A,
      B: kb.B || '',
      C: kb.C || [],
      D: kb.D || [],
      E: kb.E || [],
      F: kb.F || '',
      G: kb.G || licenseG(meta, kb, readme),
      homepage: (meta || {}).homepage || '',
      _src: '知识库（内置调研沉淀）',
    };
  }
  const [bullets, eco] = extractReadmePoints(readme);
  const headings = extractReadmeHeadings(readme);
  const summaryEn = extractReadmeSummary(readme);
  const techs = extractTechStack(readme, meta);
  const topics = ((meta || {}).topics || []).slice(0, 8);
  const name = item.full_name;
  const author = item.owner || String(name).split('/')[0];
  const created = (meta || {}).created_at || '';
  const langTxt = item.lang && item.lang !== '未标注' ? item.lang : '';
  const descCn = postEditTranslation(String((await onlineTranslate(item.desc)) || translateOffline(item.desc) || item.desc))
    .replace(/\s+/g, ' ').trim();
  const summaryCn = summaryEn
    ? postEditTranslation(String((await onlineTranslate(summaryEn)) || translateOffline(summaryEn) || ''))
      .replace(/\s+/g, ' ').trim()
    : '';
  const selfIntro = clip(summaryCn || descCn, 240);
  const catName = cat.name_cn || '综合工具';
  const catUse = _catUseCount.get(catName) || 0;
  _catUseCount.set(catName, catUse + 1);

  // A. 背景：真实创建时间 + README 自述 + 方向痛点（措辞按项目轮换）
  const aParts = [];
  aParts.push(created
    ? `${name} 由 ${author} 创建于 ${created}${langTxt ? `，主要使用 ${langTxt} 编写` : ''}。`
    : `${name} 是 ${author} 维护的开源项目${langTxt ? `，主要使用 ${langTxt} 编写` : ''}。`);
  if (selfIntro) aParts.push(`它自己的介绍是：${selfIntro.replace(/[。.]$/, '')}。`);
  if (cat.pain) {
    if (catUse === 0) {
      aParts.push(pickByKey([
        `放到「${catName}」这个方向里看，同类项目普遍要解决的是：${cat.pain}。`,
        `「${catName}」方向常见的问题是：${cat.pain}；这个项目是其中一种解法。`,
        `这类工具出现的背景是：${cat.pain}。`,
      ], name));
    } else {
      aParts.push(`它属于「${catName}」方向。`);
    }
  }
  const A = aParts.join('');

  // B. 目的：分类目标 + 受众 + 真实话题
  const B = pickByKey([
    `创建者的目标是${cat.purpose || '把繁琐流程做得更简单'}，主要服务${cat.audience || '开发者'}。`,
    `它想解决的正是「${catName}」里的老问题，目标用户是${cat.audience || '开发者'}。`,
    `按作者意图，它应当${cat.purpose || '让流程更简单'}，面向${cat.audience || '开发者'}。`,
  ], `${name}|b`) + (topics.length ? `仓库话题集中在 ${topics.slice(0, 4).join('、')}。` : '');

  // 一句话介绍：优先 README 摘要首句，其次榜单简介
  const S = clip(splitClauses(summaryCn || descCn, 1)[0] || descCn, 110);

  // C. 作用：README 功能要点 → README 自述拆句 → README 章节 → 分类模板（与 S 去重）
  let C = [];
  const pushC = (v) => {
    const t = String(v || '').trim();
    if (!t || t.length < 6) return;
    if (isSimilarText(S, t)) return;
    if (C.some(x => isSimilarText(x, t))) return;
    C.push(t);
  };
  if (bullets.length) {
    for (const b of bullets.slice(0, 5)) pushC(postEditTranslation((await onlineTranslate(b)) || translateOffline(b) || b));
  }
  if (summaryCn) {
    for (const c of splitClauses(summaryCn, 4)) pushC(c);
  } else if (!bullets.length) {
    for (const c of splitClauses(descCn, 3)) pushC(c);
  }
  if (C.length < 3 && headings.length >= 2) {
    for (const h of headings.slice(0, 4)) pushC(postEditTranslation((await onlineTranslate(h)) || translateOffline(h) || h));
  }
  if (C.length < 3) {
    for (const x of rotateByKey(cat.functions, name, 4)) {
      if (C.length >= 4) break;
      pushC(x);
    }
  }
  C = C.slice(0, 4);

  // D. 技术：真实语言 / 技术栈 / 分发方式 / 话题标签
  const D = [];
  if (langTxt) D.push(`主语言：${langTxt}（GitHub 榜单 / 仓库页标注）`);
  for (const t of techs.slice(0, 5)) D.push(`技术栈：${t}`);
  for (const e of eco.slice(0, 2)) D.push(e);
  if (topics.length) D.push(`官方话题：${topics.slice(0, 6).join('、')}`);
  if (D.length < 2 && (cat.tech || []).length) {
    D.push(...rotateByKey(cat.tech, name, 2).map(x => '该方向常见技术：' + x));
  }

  // E. 适用场景
  const E = buildScenes(item, descCn, readme, cat);

  // F. 热门原因：真实星标 / 涨幅 + 排名 + 方向热度
  const per = item.period_stars !== '暂无相关信息' ? item.period_stars : '';
  const total = item.total_stars !== '暂无相关信息' ? item.total_stars : '';
  const pNum = toNum(per);
  const tNum = toNum(total);
  const fParts = [];
  if (pNum !== null && tNum) {
    fParts.push(`本期新增 ${per} 星、累计 ${total} 星（本期涨幅约 ${(pNum / tNum * 100).toFixed(1)}%），位列本期 Trending 第 ${item.rank} 名。`);
  } else if (per) {
    fParts.push(`本期新增 ${per} 星，位列本期 Trending 第 ${item.rank} 名。`);
  } else {
    fParts.push(`位列本期 GitHub Trending 第 ${item.rank} 名。`);
  }
  if (cat.hot) {
    fParts.push(pickByKey([
      cat.hot,
      `结合热度看，${topics.length ? topics.slice(0, 2).join('、') + ' 等话题' : '该方向'}最近的关注度明显上升。`,
    ], `${name}|f`));
  }
  const F = fParts.join('');

  return {
    S,
    A, B, C, D, E, F,
    G: licenseG(meta, null, readme),
    homepage: (meta || {}).homepage || '',
    _src: '内置规则引擎（榜单数据' + (readme ? '+README 特征' : '') + '）',
  };
}

function builtinTrendSummary(items, catKeys) {
  const langs = new Map();
  for (const it of items) if (it.lang !== '未标注') langs.set(it.lang, (langs.get(it.lang) || 0) + 1);
  const cats = new Map();
  for (const k of catKeys) cats.set(k, (cats.get(k) || 0) + 1);
  const catsCfg = (loadData('categories.json', {}) || {}).categories || {};
  const langSorted = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const langStr = langSorted.length ? langSorted.map(([l, n]) => `${l}（${n} 个）`).join('、') : '语言分布较分散';
  const catSorted = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const catNames = catSorted.map(([k]) => (catsCfg[k] || {}).name_cn || k);
  const catStr = catNames.length ? catNames.join('、') : '综合';
  const top = items[0];
  const topCat = catSorted.length ? catSorted[0][0] : 'other';
  const hotTxt = (catsCfg[topCat] || {}).hot || '';
  const topStarTxt = top.period_stars !== '暂无相关信息' ? `以本期 ${top.period_stars} 星领跑` : '位列榜首';
  const trend = langSorted.length
    ? `本期前 ${items.length} 名中：语言分布上 ${langStr}；主题方向上以「${catStr}」为主。榜首 ${top.full_name} ${topStarTxt}。${hotTxt}`
    : `本期前 ${items.length} 名中：主题方向上以「${catStr}」为主（本次未取到语言分布数据）。榜首 ${top.full_name} ${topStarTxt}。${hotTxt}`;
  const kb = getKb();
  const pick1 = kb[String(top.full_name).toLowerCase()] || {};
  const pick1Reason = pick1.pick_reason
    || (top.period_stars !== '暂无相关信息'
      ? `本期增长最快（${top.period_stars} 星），代表了当下最热的方向，且上手门槛低。`
      : '位列本期榜首，代表了当下最热的方向，且上手门槛低。');
  let second = null;
  for (const it of items.slice(1)) {
    const k = kb[String(it.full_name).toLowerCase()];
    if (k && k.pick_reason) { second = [it, k.pick_reason]; break; }
  }
  if (!second && items.length > 1) {
    const p2 = items[1].period_stars !== '暂无相关信息' ? `本期第 2 名（${items[1].period_stars} 星）` : '本期第 2 名';
    second = [items[1], `${p2}，题材大众化、演示性强，适合普通用户直接体验开源的魅力。`];
  }
  let picks = `**首推 ${top.full_name}**：${pick1Reason}`;
  if (second) picks += `\n\n**次推 ${second[0].full_name}**：${second[1]}`;
  return { trend, picks };
}

/* --------------------------------------------------------------- AI 分析层 */

const ANALYSIS_SYSTEM = '你是一名资深开源软件技术分析师，擅长用中文解读 GitHub 开源项目。'
  + '你必须优先基于用户提供的资料（简介、README 摘要、元数据）作答；资料不足时可基于技术常识合理推断，'
  + '但严禁编造具体 Star 数字、版本号等事实性数据；无法确定的写“暂无相关信息”。全部用中文回答，项目名/技术名可保留英文。'
  + '严格按用户要求的 JSON 格式输出，不要输出 JSON 以外的任何内容，不要使用 markdown 代码块标记。';

function buildAnalysisPrompt(item, meta, readme) {
  const lines = ['请分析以下 GitHub 热门项目，按 7 个问题作答：', '',
    `- 项目全名：${item.full_name}`, `- 项目网址：${item.url}`,
    `- 主要语言：${item.lang}`, `- 英文简介：${item.desc}`,
    `- 总 Star 数：${item.total_stars}`, `- 本期新增 Star：${item.period_stars}`];
  if (meta) {
    if (meta.created_at) lines.push(`- 仓库创建时间：${meta.created_at}`);
    if (meta.topics && meta.topics.length) lines.push(`- 官方话题标签：${meta.topics.slice(0, 12).join(', ')}`);
    if (meta.homepage) lines.push(`- 项目主页（官方网站）：${meta.homepage}`);
    if (meta.license) lines.push(`- 开源许可证：${meta.license}`);
  }
  if (readme) lines.push('', '- README 摘要：', readme);
  lines.push('', '7 个问题：',
    'A.背景：什么时候、为什么被创建？当时面临什么问题或需求？（2-4句话）',
    'B.目的：创建者想达到什么目标？想帮助谁？（2-3句话）',
    'C.作用：具体能做什么？列举3-5个主要功能。',
    'D.技术：用了哪些语言、框架、库或技术方案？分条列举。',
    'E.场景：什么样的人会用？什么情况下用？列举2-4个。',
    'F.热门原因：为什么最近特别受关注？结合当前技术趋势。（2-3句话）',
    'G.开源协议：仓库使用什么开源协议？（如 MIT、Apache-2.0、GPL-3.0 等；如无法确定写“暂无相关信息”。2-3句话）', '',
    '输出 JSON：',
    '{"S":"一句话中文介绍（翻译并改写英文简介）","A":"...","B":"...",'
    + '"C":["功能1","功能2","功能3"],"D":["技术1","技术2"],"E":["场景1","场景2"],'
    + '"F":"...","G":"开源协议说明"}');
  return lines.join('\n');
}

function parseLlmJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) { /* 继续宽松提取 */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* ignore */ } }
  return null;
}

async function callLLM(cfg, messages, log, maxRetry = 2) {
  const base = String(cfg.api_base || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const payload = {
    model: cfg.api_model || DEFAULT_API_MODEL,
    messages,
    temperature: 0.6,
  };
  let last = null;
  for (let i = 0; i < maxRetry; i++) {
    try {
      const r = await postJson(url, payload, {
        timeout: 240000,
        proxy: cfg.proxy || null,
        headers: { Authorization: `Bearer ${String(cfg.api_key || '').trim()}` },
      });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      const j = JSON.parse(r.text);
      return String(j.choices[0].message.content || '').trim();
    } catch (e) {
      last = e;
      log(`  AI 调用失败（第 ${i + 1} 次）：${e.message}`);
      if (i + 1 < maxRetry) await sleep(3000);
    }
  }
  throw new Error(`AI 接口调用失败：${last && last.message}`);
}

async function aiAnalyzeProject(item, meta, readme, cfg, log) {
  try {
    const raw = await callLLM(cfg, [
      { role: 'system', content: ANALYSIS_SYSTEM },
      { role: 'user', content: buildAnalysisPrompt(item, meta, readme) },
    ], log);
    const data = parseLlmJson(raw);
    if (!data) {
      log(`  ⚠ ${item.full_name}：AI 返回非合法 JSON`);
      return null;
    }
    if (!data.G) data.G = licenseAnalysis((meta || {}).license || '');
    if (!data.homepage && meta) data.homepage = meta.homepage || '';
    data._src = 'AI 深度分析';
    return data;
  } catch (e) {
    log(`  ⚠ ${item.full_name}：AI 分析失败（${e.message}）`);
    return null;
  }
}

async function aiTrendSummary(items, analyses, cfg, log) {
  const lines = ['以下是本期 GitHub Trending 前 10 名项目及分析摘要：', ''];
  for (const it of items) {
    const an = analyses.get(it.full_name) || {};
    lines.push(`${it.rank}. ${it.full_name}（${it.lang}，本期 ${it.period_stars} Star）：${an.S || it.desc}`);
    if (an.F) lines.push(`   热门原因：${an.F}`);
  }
  lines.push('', '请输出 JSON：{"trend":"本期技术趋势总结，3-5句话",'
    + '"picks":"编辑精选推荐：挑选1-2个项目说明为什么值得普通开发者特别关注"}');
  try {
    const raw = await callLLM(cfg, [
      { role: 'system', content: ANALYSIS_SYSTEM },
      { role: 'user', content: lines.join('\n') },
    ], log);
    const data = parseLlmJson(raw);
    if (data && data.trend) return data;
  } catch (e) {
    log(`  ⚠ 趋势总结生成失败（${e.message}）`);
  }
  return null;
}

function useAi(cfg) {
  if (cfg.engine === 'builtin') return false;
  return Boolean(String(cfg.api_key || '').trim());
}

/* --------------------------------------------------------------- 报告生成层 */

function toNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').replace(/\+/g, '').trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

function growthLabel(periodNum, totalNum, rank, totalItems) {
  if (periodNum === null) return '';
  if (totalNum && totalNum > 0) {
    const ratio = periodNum / totalNum;
    if (ratio >= 0.05) return '🚀 爆发';
    if (ratio >= 0.012) return '➡️ 平稳增长';
    return '📉 增长放缓';
  }
  if (totalItems <= 1) return '';
  if (rank <= Math.max(1, Math.floor(totalItems / 3))) return '🚀 爆发';
  if (rank >= totalItems - Math.max(1, Math.floor(totalItems / 3)) + 1) return '📉 增长放缓';
  return '➡️ 平稳增长';
}

function growthKey(label) {
  if (!label) return 'flat';
  if (label.includes('爆发')) return 'boom';
  if (label.includes('放缓')) return 'slow';
  return 'flat';
}

const RANK_ICONS = { 1: '🥇 1', 2: '🥈 2', 3: '🥉 3' };

function starsLine(it, meta, totalItems) {
  const total = it.total_stars || '暂无相关信息';
  const period = it.period_stars || '暂无相关信息';
  let t = toNum(total);
  if (t === null && meta) t = toNum(meta.stars);
  const p = toNum(period);
  const parts = [];
  if (t !== null) parts.push(`当前总星标 **${t.toLocaleString('en-US')}** ⭐`);
  if (p !== null) parts.push(`本期新增 **${p >= 0 ? '+' : ''}${p.toLocaleString('en-US')}** ⭐`);
  if (!parts.length) return null;
  const label = growthLabel(p, t, it.rank, totalItems);
  if (label) parts.push(`**${label}**`);
  return '**⭐ 星标增长：** ' + parts.join(' ｜ ') + '  ';
}

/* ------------------------------------------- 是否需要部署：判定（报告章节用） */

const DEPLOY_VERDICT_META = {
  need: { icon: '🚀', label: '需要部署', short: '需要' },
  none: { icon: '📄', label: '免部署', short: '免部署' },
  maybe: { icon: '⚠️', label: '建议按需', short: '按需' },
};

/**
 * 判定一个项目「需要部署 / 免部署 / 建议按需」
 * 依据优先级：仓库根目录文件清单 > README 关键字 > 榜单简介/话题/语言
 */
function deployVerdictOf(it, meta) {
  const files = ((meta && meta.files) || []).map(f => String(f).toLowerCase());
  const has = (...names) => names.some(n => files.includes(n));
  const hasPre = p => files.some(f => f.startsWith(p));
  const readme = String((meta && meta.readme_text) || '');
  const text = (readme + ' ' + String(it.desc || '')).toLowerCase();
  const topics = ((meta && meta.topics) || []).join(' ').toLowerCase();
  const lang = String(it.lang || (meta && meta.lang) || '').toLowerCase();
  const ev = [];
  const add = (...xs) => xs.filter(Boolean).forEach(x => { if (!ev.includes(x)) ev.push(x); });
  const noFiles = files.length === 0;

  const docker = has('dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml');
  const pkg = has('package.json');
  const pyReq = has('requirements.txt', 'pyproject.toml', 'setup.py', 'pipfile');
  const goMod = has('go.mod');
  const cargo = has('cargo.toml');
  const html = has('index.html');
  const jsServer = /express|koa|fastify|@nestjs|next\.js|nuxt|hapi|socket\.io|remix|sveltekit|astro/.test(text);
  const pyWeb = /flask|django|fastapi|gradio|streamlit|uvicorn|gunicorn|panel|dash/.test(text);
  const staticHint = /static (site|website|page)|single html|github pages|no build|纯静态|静态页/.test(text);
  const libHint = /\b(library|sdk|toolkit|cli tool|framework|boilerplate|template)\b/.test(text) || /library|sdk|cli/.test(topics);
  const docHint = /awesome|awesome-list|cheatsheet|tutorial|book|course|roadmap|handbook/.test(topics + ' ' + String(it.repo || '').toLowerCase());
  // 明确的启动/构建命令：出现即说明这是"要跑起来"的项目
  const runCmd = /npm (run )?start|npm run build|yarn (start|build)|pnpm (start|build)|uvicorn |gunicorn |streamlit run|python [\w./-]*(app|main|run|server)\.py|go run|go build|docker run|docker compose up/.test(text);
  // 库/框架本体：自述为库且没有任何启动命令 → 安装使用，而不是部署运行
  const libBody = libHint && !docker && !runCmd;

  let decision = 'maybe';
  if (docker) {
    decision = 'need';
    add('仓库含 Dockerfile / compose 编排');
    if (/docker compose|docker-compose up|docker run/.test(text)) add('README 给出 docker 启动方式');
  } else if (runCmd) {
    decision = 'need';
    add('README 提供启动/构建命令');
    if (pkg) add('Node 工程');
    if (pyReq) add('Python 依赖清单');
    if (goMod) add('Go module');
  } else if (html && !pkg && !pyReq && !goMod) {
    decision = 'none';
    add('根目录只有静态页面（index.html），无构建/服务端工程');
  } else if (staticHint && /html|css|javascript|typescript/.test(lang)) {
    decision = 'none';
    add('README 自述为静态站点，语言为 ' + (it.lang || 'HTML/CSS'));
  } else if (libBody) {
    decision = 'none';
    add('自述为库/框架本体，无 start/build 命令，按依赖安装使用');
  } else if (jsServer || pyWeb) {
    decision = 'need';
    add('含 Web 框架依赖，需起服务');
  } else if (docHint) {
    decision = 'none';
    add('话题/仓库名属于文档、清单或教程类');
  } else if (html) {
    decision = 'none';
    add('含静态首页，未见服务端工程文件');
  } else if (pyReq || pkg || goMod) {
    decision = 'maybe';
    add('有依赖清单但未见明确启动入口');
  } else {
    decision = 'maybe';
    add(noFiles ? '未取到文件清单，仅凭简介判断' : '文件清单未见服务端/构建特征');
  }

  if (noFiles) add('文件清单缺失，结论置信度偏低');
  const clue = [
    it.lang && it.lang !== '未标注' ? it.lang : '',
    docker ? 'Docker' : '',
    pkg ? 'Node 工程' : '',
    pyReq ? 'Python 依赖' : '',
    goMod ? 'Go module' : '',
    cargo ? 'Cargo' : '',
    html && !pkg ? '静态页面' : '',
  ].filter(Boolean).slice(0, 2).join(' · ') || '—';

  return {
    decision,
    label: DEPLOY_VERDICT_META[decision].label,
    short: DEPLOY_VERDICT_META[decision].short,
    icon: DEPLOY_VERDICT_META[decision].icon,
    clue,
    evidence: ev.slice(0, 2).join('；') || '暂无相关信息',
    confidence: noFiles ? (readme ? '中' : '低') : '高',
  };
}

/** 报告章节：爬取内容的部署判定 */
function deploySectionMd(items, metas) {
  const rows = items.map(it => ({ it, v: deployVerdictOf(it, (metas || {})[it.full_name] || null) }));
  const cnt = { need: 0, none: 0, maybe: 0 };
  rows.forEach(r => { cnt[r.v.decision] += 1; });

  const out = ['## 三、爬取内容的部署判定\n',
    '> 本章回答一个问题：**这个项目抓下来之后，是要"跑起来"还是"打开就能看"？**'
    + '判定只看运行形态（是否含服务端入口、构建步骤、常驻进程），与热度、语言无关；'
    + '依据来自仓库根目录文件清单、README 关键字与榜单简介。\n',
    '| 排名 | 项目 | 判定 | 判定依据（类型线索 → 依据） |',
    '|:---:|:---|:---:|:---|'];
  for (const r of rows) {
    out.push(`| ${RANK_ICONS[r.it.rank] || r.it.rank} | ${r.it.full_name} | ${r.v.icon} ${r.v.short} | ${r.v.clue !== '—' ? r.v.clue + '：' : ''}${r.v.evidence} |`);
  }
  out.push('',
    `**📊 小结：** 本期 ${rows.length} 个项目中，**需要部署 ${cnt.need} 个**、`
    + `**免部署 ${cnt.none} 个**、**建议按需 ${cnt.maybe} 个**。\n`,
    '### 📐 判定标准\n',
    '- **📄 免部署**：纯静态内容（根目录即成品页面，无构建脚本）；库 / SDK / CLI 工具（作为依赖或命令使用，无常驻服务）；文档、清单、教程类仓库。',
    '- **🚀 需要部署**：含 Dockerfile 或 compose 编排；Node 工程带服务端框架或构建产物；Python 依赖中含 Web 框架（Flask/Django/FastAPI/Gradio 等）；Go/Rust 含可执行入口；PHP 站点。',
    '- **⚠️ 建议按需**：文件清单与 README 都不足以判断（多为归档、示例或纯文档），建议先读 README 再决定是否起服务。\n',
    '> 📌 判定说明：优先采用仓库根目录文件清单；未取到清单时退回 README 与简介推断，'
    + '此时依据栏会标注"置信度偏低"。结论用于**快速分流**，不替代项目自身的部署文档。');

  return out.join('\n');
}

function buildReportMd(items, analyses, trend, since, sourceName, dateStr, metas, sourceMode) {
  const pl = periodLabel(since);
  const srcTxt = sourceName || '未知';
  const mode = String(sourceMode || 'auto').trim().toLowerCase();
  let srcLine;
  if (srcTxt.includes('离线缓存')) srcLine = `- **数据来源：** ${srcTxt}（在线源不可用时的兜底缓存）\n`;
  else if (/gitee/i.test(srcTxt)) srcLine = '- **数据来源：** Gitee 热门项目（gitee.com/explore，按星标排序）\n';
  else if (mode === 'official') srcLine = '- **数据来源：** GitHub 官方（github.com/trending）\n';
  else srcLine = `- **数据来源：** GitHub Trending（${srcTxt}）\n`;

  const out = ['# 🔥 GitHub 热门项目分析报告\n',
    `- **统计周期：** ${pl}`,
    `- **生成日期：** ${dateStr}`,
    srcLine,
    '---\n',
    '## 一、本期热门项目总览\n',
    '| 排名 | 项目名称 | 主要语言 | 本期新增⭐ |',
    '|:---:|:---:|:---:|:---:|'];
  for (const it of items) {
    const langC = it.lang !== '未标注' ? it.lang : '—';
    const periodC = it.period_stars !== '暂无相关信息' ? it.period_stars : '—';
    out.push(`| ${RANK_ICONS[it.rank] || it.rank} | ${it.full_name} | ${langC} | ${periodC} |`);
  }
  out.push('\n---\n\n## 二、项目详细分析\n');
  for (const it of items) {
    const an = analyses.get(it.full_name);
    const intro = (an && an.S) || it.desc;
    out.push('\n---\n',
      `### 📦 项目 ${it.rank}：${it.full_name}\n`,
      `**GitHub 仓库地址：** [${it.url}](${it.url})  `);
    const sl = starsLine(it, (metas || {})[it.full_name], items.length);
    if (sl) out.push(sl);
    if (an && an.homepage) out.push(`**项目主页（官方网站）：** [${an.homepage}](${an.homepage})  `);
    out.push(`**一句话介绍：** ${intro}\n`);
    if (an) {
      out.push('#### 🔍 A. 项目背景', an.A || '暂无相关信息\n',
        '\n#### 🎯 B. 项目目的', an.B || '暂无相关信息\n',
        '\n#### ⚙️ C. 主要作用');
      const c = an.C || [];
      out.push(Array.isArray(c) && c.length ? c.map(x => `- ${x}`).join('\n') : '暂无相关信息\n');
      out.push('\n#### 🛠️ D. 使用技术');
      const d = an.D || [];
      out.push(Array.isArray(d) && d.length ? d.map(x => `- ${x}`).join('\n') : '暂无相关信息\n');
      out.push('\n#### 📍 E. 适用场景');
      const e = an.E || [];
      out.push(Array.isArray(e) && e.length ? e.map(x => `- ${x}`).join('\n') : '暂无相关信息\n');
      out.push('\n#### 💡 F. 热门原因', an.F || '暂无相关信息');
      out.push('\n#### 📜 G. 开源协议', an.G || '暂无相关信息');
      if (an._src) out.push(`\n*▲ 本节分析来源：${an._src}*`);
    } else {
      for (const t of ['#### 🔍 A. 项目背景', '#### 🎯 B. 项目目的', '#### ⚙️ C. 主要作用',
        '#### 🛠️ D. 使用技术', '#### 📍 E. 适用场景', '#### 💡 F. 热门原因', '#### 📜 G. 开源协议']) {
        out.push('\n' + t, '暂无相关信息');
      }
    }
    out.push('');
  }
  out.push('\n---\n');
  out.push(deploySectionMd(items, metas));
  out.push('\n---\n', '## 四、趋势总结\n', '### 🌐 本期技术趋势',
    (trend || {}).trend || '暂无相关信息',
    '\n### ⭐ 编辑精选推荐', (trend || {}).picks || '暂无相关信息',
    '\n---\n',
    `*📌 提示：本报告由 ${APP_NAME} v${VERSION} 自动生成，数据来源为 GitHub Trending（含镜像通道），`
    + '榜单/元数据/README 全程零 API（纯网页抓取 + 多镜像容灾），分析内容仅供参考。*');
  return out.join('\n');
}

function mdToHtml(mdText, title) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => {
    let x = esc(s);
    x = x.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    x = x.replace(/\*(.+?)\*/g, '<i>$1</i>');
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    return x;
  };
  const lines = String(mdText).split('\n');
  const headerParts = [];
  const slides = [];
  let out = headerParts;
  function startSlide(meta) { const s = Object.assign({ parts: [] }, meta); slides.push(s); out = s.parts; }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|[\s:\-|]+\|\s*$/.test(lines[i + 1])) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      out.push('<table><thead><tr>' + cells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cs = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        out.push('<tr>' + cs.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      out.push('</tbody></table>');
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) {
      const lvl = hm[1].length;
      const htxt = hm[2];
      const pm = htxt.match(/📦\s*项目\s*(\d+)\s*[：:]\s*(.*)/);
      if (pm) {
        startSlide({ kind: 'project', rank: +pm[1], name: (pm[2] || '').trim(), icon: '📦', title: '项目 ' + pm[1], preview: '' });
        out.push(`<h3 class="slide-h">${inline(htxt)}</h3>`);
        i++; continue;
      }
      const sec = htxt.match(/^[一二三四]、(.*)/);
      if (sec) {
        const t = sec[1].trim();
        if (/项目详细分析/.test(t)) { i++; continue; }
        if (/热门项目总览|总览/.test(t)) startSlide({ kind: 'section', icon: '📊', title: '本期热门项目总览', preview: '排名 · 语言 · 本期增长' });
        else if (/部署判定/.test(t)) startSlide({ kind: 'section', icon: '🧭', title: '爬取内容的部署判定', preview: '是否需部署 · 判定依据' });
        else if (/趋势总结/.test(t)) startSlide({ kind: 'section', icon: '📈', title: '趋势总结', preview: '技术趋势 · 编辑精选' });
        out.push(`<h2 class="slide-h">${inline(htxt)}</h2>`);
        i++; continue;
      }
      out.push(`<h${lvl}>${inline(htxt)}</h${lvl}>`);
      i++; continue;
    }
    if (line.trim() === '---') { i++; continue; }
    if (line.trim().startsWith('> ')) {
      out.push(`<blockquote>${inline(line.trim().slice(2))}</blockquote>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      out.push('<ul>');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    } else if (line.trim()) {
      const s = line.trim();
      const mPrev = s.match(/^\*\*一句话介绍[:：]\*\*\s*(.+)$/);
      if (mPrev && slides.length && slides[slides.length - 1].kind === 'project') {
        slides[slides.length - 1].preview = mPrev[1].replace(/\*/g, '').slice(0, 60);
      }
      if (s.startsWith('**⭐ 星标增长：')) out.push(`<p class="stars">${inline(s)}</p>`);
      else if (s.startsWith('**Gitee 仓库地址：**')) out.push(`<p class="gitee">${inline(s)}</p>`);
      else if (s.startsWith('**项目链接：')) out.push(`<p class="links">${inline(s)}</p>`);
      else out.push(`<p>${inline(s)}</p>`);
    }
    i++;
  }

  const slideSrc = slides.map((s, idx) => {
    const prev = String(s.preview || '').replace(/"/g, '');
    return `<div class="slide-src" data-idx="${idx}" data-kind="${s.kind}" data-rank="${s.rank || ''}"`
      + ` data-icon="${s.icon || ''}" data-title="${esc(s.title || '')}" data-preview="${esc(prev)}">`
      + `${s.parts.join('')}</div>`;
  }).join('');

  const css = `
    html{scroll-behavior:smooth}
    body{font-family:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif;min-height:100vh;margin:0;
      padding:40px 22px 80px;color:#eaf0ff;line-height:1.8;overflow-x:hidden;
      background:
        radial-gradient(120% 130% at 14% -12%,#2c3d80 0%,#182552 34%,#0b1332 68%,#070c1e 100%),
        radial-gradient(46% 46% at 88% 6%,rgba(124,92,255,.32),transparent 62%),
        radial-gradient(52% 52% at 82% 102%,rgba(64,196,255,.20),transparent 60%),
        radial-gradient(42% 42% at 6% 94%,rgba(255,110,196,.16),transparent 60%)}
    body::before,body::after{content:'';position:fixed;border-radius:50%;filter:blur(80px);opacity:.5;z-index:0;pointer-events:none}
    body::before{width:440px;height:440px;top:-130px;right:-90px;background:radial-gradient(circle,#7c5cff,transparent 70%)}
    body::after{width:400px;height:400px;bottom:-150px;left:-70px;background:radial-gradient(circle,#2fd4e0,transparent 70%)}

    .rpt-head{position:relative;z-index:2;max-width:1160px;margin:0 auto 24px;padding:32px 38px 28px;border-radius:28px;
      background:linear-gradient(155deg,rgba(255,255,255,.15),rgba(255,255,255,.05));
      border:1px solid rgba(255,255,255,.2);overflow:hidden;
      backdrop-filter:blur(24px) saturate(1.3);-webkit-backdrop-filter:blur(24px) saturate(1.3);
      box-shadow:0 32px 78px rgba(4,10,28,.52),inset 0 1px 0 rgba(255,255,255,.24),0 0 0 1px rgba(130,150,255,.12)}
    .rpt-head::before{content:'';position:absolute;top:0;left:8%;right:8%;height:1px;
      background:linear-gradient(90deg,transparent,rgba(160,190,255,.7),transparent)}
    .rpt-kicker{display:block;text-align:center;font-size:11px;letter-spacing:5px;color:#93b3ff;
      text-transform:uppercase;font-weight:800;margin-bottom:12px;opacity:.9}
    .rpt-head h1{margin:0 0 18px;text-align:center;font-size:33px;font-weight:900;letter-spacing:.5px;
      background:linear-gradient(100deg,#d6e4ff 0%,#a9bcff 28%,#cba6ff 58%,#93e2ff 100%);
      -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
      filter:drop-shadow(0 6px 24px rgba(120,150,255,.34))}
    h1::after{content:'';display:block;width:126px;height:4px;margin:18px auto 0;border-radius:3px;
      background:linear-gradient(90deg,#6f8bff,#a78bfa,#4fd6e0)}
    .rpt-head ul{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:10px 12px;justify-content:center}
    .rpt-head li{color:#d2ddfa;font-size:12.5px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);
      padding:7px 17px;border-radius:999px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
    .rpt-head b{color:#a9c5ff}

    h2{font-size:20px;color:#26314f;margin:22px 0 14px;padding:12px 18px;font-weight:800;
      background:linear-gradient(100deg,#eaf0ff,#ffffff 65%);border-left:5px solid #6f8bff;border-radius:12px;
      box-shadow:0 8px 22px rgba(80,110,220,.12)}
    h3{font-size:17px;color:#26314e;margin:16px 0 11px;padding:11px 16px;font-weight:800;
      background:linear-gradient(100deg,#f2efff,#ffffff 68%);border:1px solid #e8e3f8;
      border-left:5px solid #7c5cff;border-radius:12px;box-shadow:0 6px 18px rgba(120,90,220,.1)}
    h4{font-size:14px;color:#3a52ad;margin:16px 0 8px;padding:9px 14px;font-weight:800;letter-spacing:.3px;
      border-left:3px solid #7c5cff;background:linear-gradient(90deg,rgba(124,92,255,.12),transparent 72%);
      border-radius:0 10px 10px 0}
    p{margin:9px 0;color:#28304a}
    table{border-collapse:separate;border-spacing:0;width:100%;margin:16px 0;
      background:rgba(255,255,255,.78);border:1px solid #e6eaf5;border-radius:14px;overflow:hidden;
      box-shadow:0 10px 28px rgba(60,90,180,.12)}
    th,td{border-bottom:1px solid #eef1f8;padding:11px 14px;text-align:center;color:#28304a}
    th{background:linear-gradient(135deg,#3b476e,#5566a0);color:#fff;font-weight:700;letter-spacing:.4px;font-size:12.5px}
    tr:last-child td{border-bottom:none}
    th:nth-child(3),td:nth-child(3){white-space:nowrap}
    tr:nth-child(even){background:rgba(246,248,252,.55)}
    tr:hover{background:rgba(228,238,255,.82)}
    td:first-child{font-weight:800;color:#3a52ad}
    ul{padding-left:22px;margin:7px 0}li{margin:5px 0;color:#28304a}
    li::marker{color:#7c5cff}
    a{color:#3a56c0;text-decoration:none;border-bottom:1px dashed rgba(58,86,192,.4);transition:color .18s}
    a:hover{color:#22307a;border-bottom-color:#22307a}
    code{background:rgba(120,140,220,.16);padding:2px 8px;border-radius:7px;font-size:90%;color:#b03a4a;font-family:'Consolas',monospace}
    blockquote{border-left:4px solid #7c9bff;margin:13px 0;padding:10px 18px;color:#33406e;
      background:rgba(120,150,255,.12);border-radius:0 12px 12px 0}
    p.stars{background:linear-gradient(100deg,#fff3d6,#fff9ec);border:1px solid #f0d79c;border-left:4px solid #f5a623;
      border-radius:12px;padding:10px 16px;color:#7a5a1a;margin:12px 0;box-shadow:0 4px 14px rgba(200,150,40,.12)}
    p.gitee{background:linear-gradient(100deg,#ffe9e9,#fff4f4);border:1px solid #f0c2c2;border-left:4px solid #e06a6a;
      border-radius:12px;padding:10px 16px;color:#a53434;margin:12px 0;box-shadow:0 4px 14px rgba(200,80,80,.12)}
    p.links{background:rgba(220,232,255,.75);border:1px solid #c6daff;border-left:4px solid #4d7cfe;
      border-radius:12px;padding:10px 16px;color:#2c4690;margin:12px 0;box-shadow:0 4px 14px rgba(70,110,220,.12)}

    .proj-card{display:none}
    #cfHost{position:relative;z-index:2;max-width:1200px;margin:12px auto 0}
    .cf-outer{position:relative;padding:32px 62px 30px;border-radius:30px;overflow:hidden;
      background:linear-gradient(165deg,rgba(255,255,255,.11),rgba(255,255,255,.03));
      border:1px solid rgba(255,255,255,.15);
      backdrop-filter:blur(26px) saturate(1.25);-webkit-backdrop-filter:blur(26px) saturate(1.25);
      box-shadow:0 36px 86px rgba(4,10,28,.5),inset 0 1px 0 rgba(255,255,255,.2)}
    .cf-stage{position:relative;height:540px;perspective:1700px;transform-style:preserve-3d;
      cursor:grab;user-select:none;touch-action:pan-y}
    .cf-stage:active{cursor:grabbing}
    .cf-card{position:absolute;left:50%;top:50%;width:212px;height:302px;border-radius:24px;overflow:hidden;
      border:1px solid rgba(255,255,255,.24);
      box-shadow:0 30px 62px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.28);
      transition:transform .6s cubic-bezier(.22,.61,.36,1),opacity .55s,width .55s,height .55s;will-change:transform}
    .cf-card.is-active{width:668px;height:502px;border-radius:24px;border-color:rgba(255,255,255,.55);
      box-shadow:0 44px 104px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.3),0 0 70px rgba(120,150,255,.28)}
    .cf-cover{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:18px;
      backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2)}
    .cf-cover::before{content:'';position:absolute;top:0;left:0;right:0;height:48%;pointer-events:none;
      background:linear-gradient(180deg,rgba(255,255,255,.24),transparent)}
    .cf-card.is-active .cf-cover{display:none}
    .cf-no{position:absolute;top:15px;left:17px;font-size:11.5px;font-weight:800;color:#fff;letter-spacing:.6px;
      background:rgba(255,255,255,.22);padding:5px 13px;border-radius:999px;
      border:1px solid rgba(255,255,255,.32);backdrop-filter:blur(8px);box-shadow:0 4px 12px rgba(0,0,0,.2)}
    .cf-rank{position:absolute;top:15px;right:17px;font-size:22px;font-weight:900;color:rgba(255,255,255,.95);
      text-shadow:0 2px 10px rgba(0,0,0,.45)}
    .cf-name{color:#fff;font-size:15px;font-weight:800;line-height:1.35;
      text-shadow:0 2px 12px rgba(0,0,0,.5);word-break:break-all}
    .cf-prev2{color:rgba(255,255,255,.85);font-size:11.5px;margin-top:9px;line-height:1.55;
      display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .cf-full{position:absolute;inset:0;display:none;border-radius:24px;
      background:linear-gradient(165deg,rgba(255,255,255,.93),rgba(242,246,255,.88));
      padding:22px 28px 24px;overflow-y:auto;overscroll-behavior:contain;color:#202634;line-height:1.76;font-size:13.5px;
      backdrop-filter:blur(30px) saturate(1.5);-webkit-backdrop-filter:blur(30px) saturate(1.5);
      box-shadow:inset 0 2px 0 rgba(130,150,255,.3),inset 0 0 0 1px rgba(255,255,255,.46)}
    .cf-card.is-active .cf-full{display:block}
    .cf-full::-webkit-scrollbar{width:9px}
    .cf-full::-webkit-scrollbar-track{background:transparent}
    .cf-full::-webkit-scrollbar-thumb{background:rgba(120,140,220,.38);border-radius:9px}
    .cf-full::-webkit-scrollbar-thumb:hover{background:rgba(120,140,220,.6)}
    .cf-nav{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;border-radius:50%;
      border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#eaf1ff;font-size:27px;
      cursor:pointer;z-index:120;transition:.22s;line-height:1;font-family:inherit;
      backdrop-filter:blur(12px);box-shadow:0 12px 30px rgba(0,0,0,.3)}
    .cf-nav:hover{background:rgba(255,255,255,.28);border-color:rgba(255,255,255,.5);
      box-shadow:0 16px 38px rgba(120,150,255,.42)}
    .cf-prev{left:15px}.cf-next{right:15px}
    .cf-prog{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:18px}
    .cf-dot{width:9px;height:9px;border-radius:999px;background:rgba(255,255,255,.2);
      border:1px solid rgba(255,255,255,.28);cursor:pointer;transition:.25s}
    .cf-dot:hover{background:rgba(255,255,255,.42)}
    .cf-dot.on{width:26px;background:linear-gradient(90deg,#8fb4ff,#b48fff);border-color:transparent;
      box-shadow:0 4px 14px rgba(140,160,255,.5)}
    .cf-hint{text-align:center;color:#9fb2e0;font-size:11.5px;margin-top:14px;letter-spacing:.7px}
    .cf-toggle{text-align:center;margin-top:14px}
    .cf-toggle button{border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.1);color:#dfe8ff;
      padding:10px 24px;border-radius:999px;cursor:pointer;font-size:12.5px;font-family:inherit;transition:.22s;
      backdrop-filter:blur(10px);box-shadow:0 10px 26px rgba(0,0,0,.22)}
    .cf-toggle button:hover{background:rgba(255,255,255,.24);border-color:rgba(255,255,255,.48);
      box-shadow:0 14px 34px rgba(120,150,255,.38)}
    .cf-outer.allmode .cf-stage,.cf-outer.allmode .cf-nav,.cf-outer.allmode .cf-hint,.cf-outer.allmode .cf-prog{display:none}

    .slide-src{display:none;position:relative;z-index:1;max-width:1160px;margin:22px auto;padding:28px 34px;
      border-radius:24px;background:rgba(255,255,255,.9);border:1px solid rgba(255,255,255,.55);
      color:#202634;box-shadow:0 24px 58px rgba(4,10,28,.34);
      backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}
    .cf-outer.allmode ~ .slide-src{display:block}

    @media (max-width:680px){
      body{padding:22px 12px}
      .rpt-head{padding:22px 18px}.rpt-head h1{font-size:24px}
      .cf-stage{height:470px}.cf-card{width:162px;height:224px}
      .cf-card.is-active{width:92vw;height:430px}.cf-outer{padding:18px 38px 22px}
      .cf-nav{width:42px;height:42px;font-size:22px}
    }
    @media print{
      body{background:#fff;padding:0;color:#1f2328}
      body::before,body::after{display:none}
      .rpt-head{box-shadow:none;background:#fff;border-color:#ddd}
      .cf-outer{display:none}
      .slide-src{display:block!important;box-shadow:none;background:#fff;page-break-inside:avoid}
    }
  `;

  const cfScript = "(function(){\n"
    + "  var host=document.getElementById('cfHost');\n"
    + "  if(!host)return;\n"
    + "  var srcs=[].slice.call(document.querySelectorAll('.slide-src'));\n"
    + "  if(!srcs.length)return;\n"
    + "  var meta=srcs.map(function(el){return {\n"
    + "    kind:el.getAttribute('data-kind')||'section',\n"
    + "    rank:el.getAttribute('data-rank')||'',\n"
    + "    icon:el.getAttribute('data-icon')||'',\n"
    + "    title:el.getAttribute('data-title')||'',\n"
    + "    preview:el.getAttribute('data-preview')||'',\n"
    + "    html:el.innerHTML\n"
    + "  };});\n"
    + "  var outer=document.createElement('div');outer.className='cf-outer';\n"
    + "  var prev=document.createElement('button');prev.className='cf-nav cf-prev';prev.innerHTML='\\u2039';prev.setAttribute('aria-label','上一个');\n"
    + "  var stage=document.createElement('div');stage.className='cf-stage';\n"
    + "  var next=document.createElement('button');next.className='cf-nav cf-next';next.innerHTML='\\u203a';next.setAttribute('aria-label','下一个');\n"
    + "  var hint=document.createElement('div');hint.className='cf-hint';hint.textContent='拖拽、点击卡片或按 \\u2190 \\u2192 切换内容';\n"
    + "  var prog=document.createElement('div');prog.className='cf-prog';\n"
    + "  var tgWrap=document.createElement('div');tgWrap.className='cf-toggle';\n"
    + "  var tg=document.createElement('button');tg.type='button';tg.textContent='展开全部内容';tgWrap.appendChild(tg);\n"
    + "  outer.appendChild(prev);outer.appendChild(stage);outer.appendChild(next);outer.appendChild(prog);outer.appendChild(hint);outer.appendChild(tgWrap);\n"
    + "  host.appendChild(outer);\n"
    + "  var palette=['#5b7cfa','#4fc3d9','#7c5cff','#4dd0a5','#8b7cf6','#4d9fff','#5eead4','#a78bfa','#67e8f9','#818cf8'];\n"
    + "  var cfCards=[];\n"
    + "  for(var i=0;i<meta.length;i++){\n"
    + "    var m=meta[i];\n"
    + "    var el=document.createElement('div');el.className='cf-card';\n"
    + "    var cover=document.createElement('div');cover.className='cf-cover';\n"
    + "    cover.style.background='linear-gradient(155deg,'+palette[i%palette.length]+'5c,'+palette[(i+3)%palette.length]+'2e)';\n"
    + "    var c1=document.createElement('div');c1.className='cf-no';\n"
    + "    c1.textContent=(m.kind==='project')?('项目 '+m.rank):(m.icon+' 区块');\n"
    + "    var c2=document.createElement('div');c2.className='cf-name';\n"
    + "    c2.textContent=(m.kind==='project')?m.name:m.title;\n"
    + "    var c3=document.createElement('div');c3.className='cf-rank';c3.textContent=m.kind==='project'?('#'+m.rank):m.icon;\n"
    + "    var c4=document.createElement('div');c4.className='cf-prev2';c4.textContent=m.preview||'点击查看完整内容 \\u2192';\n"
    + "    cover.appendChild(c1);cover.appendChild(c2);cover.appendChild(c3);cover.appendChild(c4);\n"
    + "    var full=document.createElement('div');full.className='cf-full';\n"
    + "    el.appendChild(cover);el.appendChild(full);\n"
    + "    (function(k){el.addEventListener('click',function(){if(k!==act)setIndex(k);});})(i);\n"
    + "    stage.appendChild(el);cfCards.push(el);\n"
    + "  }\n"
    + "  var dots=[];\n"
    + "  for(var q=0;q<meta.length;q++){\n"
    + "    var dt=document.createElement('span');dt.className='cf-dot';\n"
    + "    (function(k){dt.addEventListener('click',function(){if(k!==act)setIndex(k);});})(q);\n"
    + "    prog.appendChild(dt);dots.push(dt);\n"
    + "  }\n"
    + "  var act=0,allMode=false;\n"
    + "  function setIndex(n){act=((n%meta.length)+meta.length)%meta.length;layout();activate();}\n"
    + "  function layout(){\n"
    + "    var N=meta.length;\n"
    + "    for(var k=0;k<cfCards.length;k++){\n"
    + "      var d=k-act;if(d>N/2)d-=N;if(d<-N/2)d+=N;\n"
    + "      var abs=Math.abs(d),dir=d===0?0:(d>0?1:-1);\n"
    + "      var x=dir*(abs===0?0:(352+(abs-1)*214));\n"
    + "      var z=-abs*92;var ry=-dir*Math.min(abs,4)*13;\n"
    + "      var sc=abs===0?1:Math.max(.72,1-abs*0.06);\n"
    + "      var op=abs===0?1:Math.max(.34,1-abs*0.17);\n"
    + "      cfCards[k].style.transform='translate(-50%,-50%) translateX('+x+'px) translateZ('+z+'px) rotateY('+ry+'deg) scale('+sc+')';\n"
    + "      cfCards[k].style.opacity=op;cfCards[k].style.zIndex=100-abs;\n"
    + "    }\n"
    + "  }\n"
    + "  function activate(){\n"
    + "    for(var k=0;k<cfCards.length;k++){\n"
    + "      var isA=(k===act);\n"
    + "      if(isA){cfCards[k].classList.add('is-active');}else{cfCards[k].classList.remove('is-active');}\n"
    + "      var full=cfCards[k].querySelector('.cf-full');\n"
    + "      if(full){full.innerHTML=isA?(meta[k].html||''):'';}\n"
    + "    }\n"
    + "    for(var d2=0;d2<dots.length;d2++){dots[d2].classList.toggle('on',d2===act);}\n"
    + "  }\n"
    + "  prev.addEventListener('click',function(){setIndex(act-1);});\n"
    + "  next.addEventListener('click',function(){setIndex(act+1);});\n"
    + "  tg.addEventListener('click',function(){\n"
    + "    allMode=!allMode;\n"
    + "    tg.textContent=allMode?'恢复旋转浏览':'展开全部内容';\n"
    + "    outer.className=allMode?'cf-outer allmode':'cf-outer';\n"
    + "  });\n"
    + "  document.addEventListener('keydown',function(e){\n"
    + "    if(allMode)return;\n"
    + "    if(e.key==='ArrowLeft')setIndex(act-1);\n"
    + "    else if(e.key==='ArrowRight')setIndex(act+1);\n"
    + "  });\n"
    + "  var dragging=false,startX=0,moved=0;\n"
    + "  stage.addEventListener('pointerdown',function(e){dragging=true;startX=e.clientX;moved=0;});\n"
    + "  window.addEventListener('pointermove',function(e){if(dragging)moved=e.clientX-startX;});\n"
    + "  window.addEventListener('pointerup',function(){\n"
    + "    if(!dragging)return;dragging=false;\n"
    + "    if(Math.abs(moved)>40)setIndex(act+(moved<0?1:-1));\n"
    + "  });\n"
    + "  layout();activate();\n"
    + "})();";

  return `<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>`
    + `<meta name='viewport' content='width=device-width,initial-scale=1'>`
    + `<title>${esc(title)}</title><style>${css}</style></head><body>`
    + `<div class="rpt-head"><span class="rpt-kicker">GitHub Trending · Analysis Report</span>${headerParts.join('')}</div>`
    + `<div id="cfHost"></div>`
    + slideSrc
    + `<noscript><style>.slide-src{display:block}</style></noscript>`
    + `<script>${cfScript}</script></body></html>`;
}

function saveReports(mdText, title, outDir, since) {
  fs.mkdirSync(outDir, { recursive: true });
  const dateStr = nowStr();
  let base = path.join(outDir, `GitHub热门分析报告_${periodLabel(since)}_${dateStr}`);
  if (fs.existsSync(base + '.md') || fs.existsSync(base + '.html')) {
    let n = 2;
    while (fs.existsSync(`${base}-${n}.md`) || fs.existsSync(`${base}-${n}.html`)) n++;
    base = `${base}-${n}`;
  }
  const mdPath = base + '.md';
  const htmlPath = base + '.html';
  fs.writeFileSync(mdPath, mdText, 'utf8');
  fs.writeFileSync(htmlPath, mdToHtml(mdText, title), 'utf8');
  return [mdPath, htmlPath];
}

/* ------------------------------------------------- 仓库缓存（24h，二次生成提速） */

let _repoCache = null;

function repoCachePath() { return path.join(DATA_DIR, 'repo_cache.json'); }

function repoCacheLoad() {
  if (_repoCache) return _repoCache;
  try {
    _repoCache = JSON.parse(fs.readFileSync(repoCachePath(), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { _repoCache = {}; }
  return _repoCache;
}

function repoCacheGet(fullName) {
  const e = repoCacheLoad()[fullName];
  if (e && typeof e === 'object' && Date.now() / 1000 - (e.ts || 0) < REPO_CACHE_TTL) return e;
  return null;
}

function repoCacheSet(fullName, meta, readme, channel) {
  try {
    const cache = repoCacheLoad();
    cache[fullName] = { ts: Date.now() / 1000, meta: meta || null, readme: readme || null, channel: channel || '' };
    const keys = Object.keys(cache);
    if (keys.length > 300) {
      keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0)).slice(0, Math.floor(keys.length / 2))
        .forEach(k => delete cache[k]);
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(repoCachePath(), JSON.stringify(cache), 'utf8');
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ 主流程 */

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 生成报告主流程
 * @param {string} since daily/weekly/monthly 或 YYYY-MM-DD
 * @param {object} cfg 配置
 * @param {object} opt { log, progress, htmlFile, outDir, sourceMode, cancel }
 * @returns {Promise<{mdPath:string, htmlPath:string, report:object}>}
 */
async function runGenerate(since, cfg, opt = {}) {
  const log = opt.log || (() => {});
  const progress = opt.progress || (() => {});
  const cancel = opt.cancel || { v: false };
  const dateStr = nowStr();
  const outDir = opt.outDir || REPORTS_DIR;
  const proxy = String(cfg.proxy || '').trim();
  setTranslateProxy(proxy);
  let topN = parseInt(cfg.top_n, 10) || 10;
  topN = Math.max(1, Math.min(30, topN));
  const srcMode = String(opt.sourceMode || cfg.source_mode || 'auto').trim().toLowerCase();
  const srcLabel = { official: 'GitHub 官方（最权威）', china: '国内镜像站（免代理）', auto: '自动多源（官方优先）' }[srcMode] || srcMode;
  const t0 = Date.now();
  _catUseCount.clear();

  if (!PERIODS[since]) {
    log(`📅 自定义日期模式：按 ${since} 抓取热榜。GitHub 官方热榜仅支持本日/本周/本月，若站点不支持该日期，将自动回落为最近一期热榜。`);
  }

  let htmlText;
  let sourceName;
  let proxyUsed = null;
  let loose = false;

  if (opt.htmlFile) {
    log(`使用本地 HTML 数据：${opt.htmlFile}`);
    htmlText = fs.readFileSync(opt.htmlFile, 'utf8');
    sourceName = '本地缓存页面';
    proxyUsed = proxy || null;
    progress(10, '本地页面就绪');
  } else {
    log(`开始抓取 GitHub Trending（${periodLabel(since)}榜，数据来源：${srcLabel}）...`);
    progress(3, '抓取 GitHub Trending 榜单…');
    const res = await fetchTrending(since, proxy, log, cancel, srcMode);
    htmlText = res.html;
    sourceName = res.source;
    proxyUsed = res.proxy;
    loose = res.loose;
    if (sourceName && !sourceName.includes('离线缓存')) {
      cfg.last_source = sourceName;
      saveConfig(cfg);
      log(`记忆本次成功源：${sourceName}（下次优先使用）`);
    }
    progress(10, '榜单抓取完成');
  }

  let items;
  if (loose) {
    items = parseTrending(htmlText, { topN, loose: true });
  } else {
    try {
      items = parseTrending(htmlText, { topN });
    } catch (e) {
      items = parseTrending(htmlText, { topN, loose: true });
      loose = true;
      log('页面非官方模板结构，已自动启用宽松解析');
    }
  }
  log(`成功解析前 ${items.length} 名项目：`);
  for (const it of items) log(`  ${String(it.rank).padStart(2)}. ${it.full_name} [${it.lang}] ${it.period_stars}`);
  progress(12, '榜单解析完成');

  if (loose && !String(sourceName).includes('离线缓存')) {
    const stats = await fetchOfficialTrendingStats(since, proxyUsed, log);
    if (Object.keys(stats).length) {
      let filled = 0;
      for (const it of items) {
        const s = stats[it.full_name];
        if (s && s[0]) {
          if (it.lang === '未标注' && s[0]) it.lang = s[0];
          if (it.total_stars === '暂无相关信息' && s[1]) it.total_stars = s[1];
          if (it.period_stars === '暂无相关信息' && s[2]) it.period_stars = s[2];
          filled++;
        }
      }
      log(`✔ 已从 GitHub 官方榜单为 ${filled}/${items.length} 个项目补充语言与星标数据`);
    }
    for (const it of items) {
      if (it.lang === '未标注') {
        const inferred = inferLangFromText(it.desc);
        if (inferred) {
          it.lang = inferred;
          log(`  - 语言由描述推断：${it.full_name} → ${inferred}`);
        }
      }
    }
  }

  const metas = {};
  const readmes = {};
  const hf = hostFails();
  const offline = Boolean(opt.htmlFile || String(sourceName).includes('离线缓存'));

  if (offline) {
    if (String(sourceName).includes('离线缓存')) {
      log('网络不可用（已启用离线缓存兜底）：跳过联网抓取，优先复用本机仓库缓存继续分析');
    } else {
      log('离线模式：跳过元数据与 README 联网抓取（分析基于榜单数据 + 本地缓存 + 知识库）');
    }
    let reused = 0;
    for (const it of items) {
      const cached = repoCacheGet(it.full_name);
      if (!cached) continue;
      if (cached.meta) {
        metas[it.full_name] = cached.meta;
        if (it.lang === '未标注' && cached.meta.lang) it.lang = cached.meta.lang;
      }
      if (cached.readme) readmes[it.full_name] = cached.readme;
      reused++;
    }
    if (reused) log(`✔ 复用本地仓库缓存 ${reused}/${items.length} 个项目（话题 / 主页 / 协议 / README 仍可用）`);
    progress(38, '离线模式：使用本地缓存资料');
  } else {
    progress(15, '抓取项目元数据与 README…');
    let done = 0;
    await mapLimit(items, Math.min(4, items.length), async (it) => {
      if (cancel.v) return;
      const fullName = it.full_name;
      const cached = repoCacheGet(fullName);
      let meta;
      let rd;
      let ch;
      if (cached) {
        meta = cached.meta;
        rd = cached.readme;
        ch = '本地缓存';
      } else {
        [meta, [rd, ch]] = await Promise.all([
          fetchRepoMeta(fullName, proxyUsed),
          fetchReadmeMulti(it, proxyUsed, hf),
        ]);
        if (!rd && meta && meta.readme_text) { rd = meta.readme_text; ch = '仓库页内嵌 README'; }
        if (meta || rd) repoCacheSet(fullName, meta, rd, ch);
      }
      if (meta) {
        metas[fullName] = meta;
        if (it.lang === '未标注' && meta.lang) it.lang = meta.lang;
      }
      if (rd) readmes[fullName] = rd;
      done++;
      progress(15 + Math.round(18 * done / items.length), `资料抓取 ${done}/${items.length}`);
      log(`  ${fullName}：元数据${meta ? '✔' : '-'} README${rd ? '✔(' + ch + ')' : '-'}`);
    });
  }

  // 翻译（在线 / 离线都执行：火山翻译不依赖 GitHub 是否可达）
  log('并行翻译项目简介（免费在线英译中）...');
  progress(36, '翻译项目简介…');
  await mapLimit(items, Math.min(4, items.length), async (it) => {
    if (cancel.v) return null;
    const t = await onlineTranslate(it.desc);
    if (t) _onlineTransCache.set(it.desc, t);
    return t;
  });
  if (cancel.v) throw new Error('用户取消');
  if (translationOffline()) log('⚠ 免费在线翻译通道不可用（网络受限），本次已改用内置词典 / 英文原文兜底');
  progress(38, '简介翻译完成');

  // 语言兜底：README 里出现明确“用 X 编写”时补全
  for (const it of items) {
    if (it.lang === '未标注') {
      const rd = readmes[it.full_name] || '';
      if (rd) {
        const inferred = inferLangStrict(rd);
        if (inferred) {
          it.lang = inferred;
          log(`  - 语言由 README 推断：${it.full_name} → ${inferred}`);
        }
      }
    }
  }

  // ===== 镜像链接真实性校验：确保报告中 Gitee / 镜像地址可访问、内容真实存在 =====
  if (offline) {
    for (const it of items) { it.gitee_url = ''; it.mirror_url = ''; it.store_url = ''; }
    log('离线模式：无法联网校验镜像链接，已剔除 Gitee / 加速镜像等未核对地址（仅保留 GitHub 源地址）');
  } else {
    log('优先用 Gitee 站内搜索定位真实镜像地址，再校验 Gitee / 镜像链接真实性（剔除打不开或「没有这内容」的假地址）…');
    progress(39, '定位 Gitee 镜像并校验链接…');
    await mapLimit(items, Math.min(3, items.length), async (it) => {
      if (cancel.v) return;
      // 用 GitHub 项目名到 Gitee 站内搜索，拿到真实可访问的 Gitee 仓库地址
      try {
        const g = await findGiteeMirror(it.full_name, it.repo, proxyUsed);
        if (g) it.gitee_url = g;   // 搜到的真实地址优先；搜不到则保留模板猜测，交给下面校验
      } catch (e) { /* 忽略，退回模板校验 */ }
      await verifyItemLinks(it);   // 校验 gitee / 加速镜像 / github.store，打不开的清空
    });
    const okG = items.filter(x => x.gitee_url).length;
    const okM = items.filter(x => x.mirror_url).length;
    log(`镜像链接校验完成：可访问 Gitee ${okG}/${items.length}（含站内搜索定位）、加速镜像 ${okM}/${items.length}（打不开的已剔除，不写入报告）`);
  }

  if (cancel.v) throw new Error('用户取消');

  const engineAi = useAi(cfg);
  const analyses = new Map();
  const catKeys = [];
  if (engineAi) {
    log(`AI 深度分析模式（模型：${cfg.api_model || DEFAULT_API_MODEL}；多路并行，未配置或失败的项目自动退回内置引擎）`);
  } else {
    log('内置分析引擎模式（项目知识库 + 分类模板 + README 提取，全程不调用任何外部 API）');
  }
  progress(40, '逐项目分析中…');

  let analyzed = 0;
  const analyzeOne = async (it) => {
    if (cancel.v) return;
    const fullName = it.full_name;
    log(`  ▶ [${it.rank}/${items.length}] 分析 ${fullName} ...`);
    let an = null;
    let catKey;
    if (engineAi) an = await aiAnalyzeProject(it, metas[fullName], readmes[fullName], cfg, log);
    if (!an) {
      const [cat, key] = detectCategory(it, readmes[fullName]);
      an = await builtinAnalyze(it, readmes[fullName], metas[fullName], cat);
      catKey = key;
    } else {
      const kb = kbLookup(it);
      catKey = (kb && kb.category) || detectCategory(it, readmes[fullName])[1];
    }
    if (!String(an.S || '').trim()) an.S = (await builtinIntroCnAsync(it))[0];
    log(`    ✔ 完成（来源：${an._src || '分析引擎'}）`);
    analyses.set(fullName, an);
    catKeys.push(catKey);
    analyzed++;
    progress(42 + Math.round(46 * analyzed / items.length), `分析进度 ${analyzed}/${items.length}`);
  };

  await mapLimit(items, engineAi ? Math.min(3, items.length) : Math.min(4, items.length), analyzeOne);

  if (cancel.v) throw new Error('用户取消');

  log('生成趋势总结与编辑精选推荐 ...');
  progress(90, '生成趋势总结…');
  let trend = null;
  if (engineAi) trend = await aiTrendSummary(items, analyses, cfg, log);
  if (!trend) trend = builtinTrendSummary(items, catKeys);

  log('正在组装报告 ...');
  progress(95, '组装报告…');
  if (cancel.v) throw new Error('用户取消');
  const title = `GitHub 热门项目分析报告（${periodLabel(since)}） ${dateStr}`;
  const md = buildReportMd(items, analyses, trend, since, sourceName, dateStr, metas, srcMode);
  const [mdPath, htmlPath] = saveReports(md, title, outDir, since);
  log(`✔ 报告已生成：\n  Markdown：${mdPath}\n  HTML：${htmlPath}`);

  const report = buildReportPayload({
    items, analyses, trend, metas, since, sourceName, dateStr, srcMode,
    engine: engineAi ? 'AI 深度分析' : '内置规则引擎',
    cost: Date.now() - t0,
  });
  // 报告同名 JSON（供 Web 界面重新打开 / 收藏对比）
  try {
    fs.writeFileSync(mdPath.replace(/\.md$/, '.json'), JSON.stringify(report, null, 1), 'utf8');
    fs.writeFileSync(path.join(DATA_DIR, 'last_report.json'), JSON.stringify(report), 'utf8');
  } catch (e) { /* ignore */ }

  progress(100, '完成');
  return { mdPath, htmlPath, report };
}

/** 组装给前端渲染的报告 JSON */
function buildReportPayload({ items, analyses, trend, metas, since, sourceName, dateStr, srcMode, engine, cost }) {
  const payloadItems = items.map((it) => {
    const an = analyses.get(it.full_name) || {};
    const meta = (metas || {})[it.full_name] || {};
    const totalNum = toNum(it.total_stars) != null ? toNum(it.total_stars) : toNum(meta.stars);
    const periodNum = toNum(it.period_stars);
    const label = growthLabel(periodNum, totalNum, it.rank, items.length);
    const licName = (kbLookup(it) || {}).license || meta.license || licenseFromText(an.G) || '';
    const badge = licenseBadge(licName);
    return {
      rank: it.rank,
      full_name: it.full_name,
      owner: it.owner,
      repo: it.repo,
      url: it.url,
      gitee_url: it.gitee_url,
      mirror_url: it.mirror_url,
      store_url: it.store_url,
      lang: it.lang,
      desc: it.desc,
      total_stars: it.total_stars,
      period_stars: it.period_stars,
      stars_num: totalNum,
      period_num: periodNum,
      growth: { label, key: growthKey(label) },
      license: badge,
      homepage: an.homepage || meta.homepage || '',
      analysis: {
        S: an.S || '',
        A: an.A || '暂无相关信息',
        B: an.B || '暂无相关信息',
        C: an.C || [],
        D: an.D || [],
        E: an.E || [],
        F: an.F || '暂无相关信息',
        G: an.G || '暂无相关信息',
        _src: an._src || '',
      },
    };
  });
  return {
    ts: Date.now(),
    version: VERSION,
    meta: {
      since,
      period: periodLabel(since),
      date: dateStr,
      source: sourceName,
      sourceMode: srcMode,
      engine,
      cost: (cost / 1000).toFixed(1) + ' s',
      count: payloadItems.length,
    },
    items: payloadItems,
    trend: trend || { trend: '', picks: '' },
  };
}

module.exports = {
  APP_NAME,
  VERSION,
  APP_DIR,
  DATA_DIR,
  REPORTS_DIR,
  CONFIG_PATH,
  PERIODS,
  DEFAULT_API_BASE,
  DEFAULT_API_MODEL,
  loadConfig,
  saveConfig,
  loadData,
  getMirrorsCfg,
  getKb,
  kbLookup,
  request,
  postJson,
  getSystemProxy,
  buildSourceChain,
  fetchTrending,
  fetchOfficialTrendingStats,
  parseTrending,
  parseTrendingLoose,
  inferLangFromText,
  parseKNum,
  licenseAnalysis,
  licenseBadge,
  translateOffline,
  onlineTranslate,
  translationOffline,
  detectCategory,
  extractReadmePoints,
  builtinIntroCnAsync,
  builtinAnalyze,
  builtinTrendSummary,
  parseLicenseFromReadme,
  fetchRepoMeta,
  fetchReadmeMulti,
  cleanReadme,
  callLLM,
  useAi,
  growthLabel,
  buildReportMd,
  mdToHtml,
  saveReports,
  runGenerate,
  buildReportPayload,
  nowStr,
  periodLabel,
};
