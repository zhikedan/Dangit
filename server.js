/* ============================================================================
   GitHub 热门项目分析报告生成器 · Web 版
   零依赖 Node 服务：静态界面 + JSON API + 报告落盘 + 计划任务 + CLI 模式
   启动：双击「启动.bat」或 `node server.js`
   ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const E = require('./engine');
const COOLIFY = require('./coolify');
const LOCALDEPLOY = require('./localdeploy');
const AIDEPLOY = require('./aideploy');

const APP_DIR = E.APP_DIR;
const REPORTS_DIR = E.REPORTS_DIR;
const DATA_DIR = E.DATA_DIR;
const INDEX_FILE = path.join(APP_DIR, 'index.html');
const WALL_DIR = path.join(APP_DIR, '壁纸');
const LAST_REPORT = path.join(DATA_DIR, 'last_report.json');
const BASE_PORT = 5215;
const TASK_NAME = 'DoubaoGitHubTrendingReport';
const AUTOSTART_NAME = 'GitHubTrendingReport';

/* ------------------------------------------------------------------ 全局状态 */

const job = {
  running: false,
  percent: 0,
  logs: [],
  startedAt: 0,
  finishedAt: 0,
  done: false,
  error: null,
  cancel: { v: false },
  report: null,
  since: null,
};

function jobLog(line) {
  const s = String(line == null ? '' : line);
  for (const part of s.split('\n')) {
    job.logs.push(part);
    console.log(part);
  }
  if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
}

function readLastReport() {
  try {
    if (fs.existsSync(LAST_REPORT)) return JSON.parse(fs.readFileSync(LAST_REPORT, 'utf8'));
  } catch (e) { /* ignore */ }
  return null;
}

/* ------------------------------------------------------------------ 工具函数 */

function send(res, code, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** 执行一段 cmd 命令文本，并把输出（含 stderr）带回来。经 .bat 文件执行，避免多层引号地狱。 */
function runShell(commandText) {
  const bat = path.join(os.tmpdir(), `gh_trending_${process.pid}_${Date.now()}.bat`);
  const log = bat + '.log';
  try {
    fs.writeFileSync(bat, `@echo off\r\nchcp 65001 >nul\r\n${commandText} > "${log}" 2>&1\r\n`, 'utf8');
    const r = spawnSync('cmd', ['/c', bat], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    let message = '';
    try {
      message = fs.readFileSync(log, 'utf8').trim();
    } catch (e) { /* ignore */ }
    return { ok: r.status === 0, status: r.status, message: message.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: -1, message: e.message };
  } finally {
    try { fs.unlinkSync(bat); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(log); } catch (e) { /* ignore */ }
  }
}

function q(s) { return `"${s}"`; }

function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
}

/* --------------------------------------------------------------- 报告历史/导出 */

function listReports() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return [];
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
    return files.map((f) => {
      const md = path.join(REPORTS_DIR, f);
      const html = md.replace(/\.md$/, '.html');
      const st = fs.statSync(md);
      const d = new Date(st.mtimeMs);
      const p = n => String(n).padStart(2, '0');
      return {
        name: f.replace(/\.md$/, ''),
        md: f,
        html: fs.existsSync(html) ? path.basename(html) : null,
        ts: st.mtimeMs,
        time: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
      };
    }).sort((a, b) => b.ts - a.ts);
  } catch (e) { return []; }
}

function exportLatest() {
  const list = listReports();
  if (!list.length) return { ok: false, error: '还没有报告，请先生成一份报告' };
  const mdPath = path.join(REPORTS_DIR, list[0].md);
  const md = fs.readFileSync(mdPath, 'utf8');
  const names = [...md.matchAll(/### 📦 项目 \d+：([^\n]+)/g)].map(m => m[1].trim());
  const urls = [...md.matchAll(/\*\*GitHub 仓库地址：\*\* ([^\s]+)/g)].map(m => m[1].trim());
  const intros = [...md.matchAll(/\*\*一句话介绍：\*\* ([^\n]+)/g)].map(m => m[1].trim());
  const n = Math.min(names.length, urls.length);
  if (!n) return { ok: false, error: '最近一份报告里没有解析到项目条目' };
  const d = new Date();
  const p = x => String(x).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const base = path.join(REPORTS_DIR, `项目地址清单_${ts}`);
  const csvPath = base + '.csv';
  const txtPath = base + '.txt';
  const lines = ['项目名称,GitHub地址,一句话介绍'];
  for (let i = 0; i < n; i++) {
    const intro = (intros[i] || '').replace(/,/g, '，');
    lines.push(`${names[i]},${urls[i]},${intro}`);
  }
  fs.writeFileSync(csvPath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  const txt = [];
  for (let i = 0; i < n; i++) txt.push(`${urls[i]}\t${names[i]}\t${intros[i] || ''}`);
  fs.writeFileSync(txtPath, txt.join('\r\n'), 'utf8');
  return {
    ok: true,
    count: n,
    csv: path.basename(csvPath),
    txt: path.basename(txtPath),
    csvUrl: '/reports/' + encodeURIComponent(path.basename(csvPath)),
    txtUrl: '/reports/' + encodeURIComponent(path.basename(txtPath)),
  };
}

/* ------------------------------------------------------------------- 定时任务 */

function scheduleRunBat(since) {
  const nodeExe = process.execPath;
  const batPath = path.join(APP_DIR, '_schedule_run.bat');
  const content = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    `"${nodeExe}" server.js --cli --since ${since} --out "%~dp0reports"`,
    '',
  ].join('\r\n');
  fs.writeFileSync(batPath, content, 'utf8');
  return batPath;
}

function applySchedule(sch) {
  const out = { task: null, autostart: null };
  try {
    if (sch && sch.enabled) {
      const bat = scheduleRunBat(sch.since || 'daily');
      const sc = sch.freq === 'weekly' ? 'WEEKLY' : 'DAILY';
      let cmdText = `schtasks /Create /TN ${q(TASK_NAME)} /TR ${q(bat)} /SC ${sc}`;
      if (sc === 'WEEKLY') cmdText += ` /D ${['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][(sch.weekday || 0) % 7]}`;
      cmdText += ` /ST ${sch.time || '09:00'} /F`;
      out.task = runShell(cmdText);
    } else {
      out.task = runShell(`schtasks /Delete /TN ${q(TASK_NAME)} /F`);
    }
  } catch (e) { out.task = { ok: false, error: e.message }; }

  out.autostart = toggleAutostart(Boolean(sch && sch.boot));
  return out;
}

function toggleAutostart(on) {
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  try {
    if (on) {
      const bat = path.join(APP_DIR, '_autostart.bat');
      fs.writeFileSync(bat, [
        '@echo off',
        'chcp 65001 >nul',
        'cd /d "%~dp0"',
        `start "" ${q(process.execPath)} server.js`,
        '',
      ].join('\r\n'), 'utf8');
      return runShell(`reg add ${q(regKey)} /v ${AUTOSTART_NAME} /t REG_SZ /d ${q(bat)} /f`);
    }
    return runShell(`reg delete ${q(regKey)} /v ${AUTOSTART_NAME} /f`);
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ------------------------------------------------------------------ 下载工具 */

async function openDownloadTool() {
  const cands = [
    path.join(APP_DIR, 'xxt'),
    path.join(APP_DIR, '..', 'xxt'),
    path.join(APP_DIR, '..', 'dist', 'xxt'),
  ];
  if (await portOpen(5210)) return { ok: true, url: 'http://127.0.0.1:5210', msg: '下载工具已在运行，已为你打开浏览器页面。' };
  const dir = cands.find(d => fs.existsSync(path.join(d, 'server.js')));
  if (!dir) return { ok: false, msg: '未找到内置下载工具（xxt/server.js）。请将 xxt 文件夹放到 html 目录或项目根目录后重试。' };
  spawn(process.execPath, ['server.js'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await portOpen(5210)) return { ok: true, url: 'http://127.0.0.1:5210', msg: '下载工具已启动。' };
  }
  return { ok: false, msg: '下载工具启动超时，请手动运行 xxt/启动.bat。' };
}

/* --------------------------------------------------------------------- 路由 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv']);

/** 壁纸目录里的视频清单（放什么播什么） */
function listWallpapers() {
  try {
    return fs.readdirSync(WALL_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && VIDEO_EXT.has(path.extname(d.name).toLowerCase()))
      .map(d => {
        const st = fs.statSync(path.join(WALL_DIR, d.name));
        return {
          name: d.name,
          size: st.size,
          mtime: st.mtimeMs,
          url: '/wallpaper/' + encodeURIComponent(d.name),
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

/** 视频流：支持 Range，可拖动进度条 */
function serveWallpaper(req, res, name) {
  const fp = path.join(WALL_DIR, path.basename(name));
  try {
    if (!fp.startsWith(WALL_DIR) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      return send(res, 404, '404 Not Found');
    }
  } catch (e) { return send(res, 404, '404 Not Found'); }

  const size = fs.statSync(fp).size;
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (!isFinite(start) || start < 0) start = 0;
    if (!isFinite(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(fp).pipe(res);
}

function serveFile(res, filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res, 404, '404 Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'max-age=60',
    });
    res.end(buf);
  } catch (e) {
    send(res, 500, '500 Internal Error');
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const cfg = E.loadConfig();

  // 一键部署（独立模块，见 coolify.js / localdeploy.js）
  if (p.startsWith('/api/coolify/')) return await COOLIFY.handle(req, res, url);
  if (p.startsWith('/api/localdeploy/')) return await LOCALDEPLOY.handle(req, res, url);
  if (p.startsWith('/api/aideploy/')) return await AIDEPLOY.handle(req, res, url);

  // 壁纸视频清单（html/壁纸 里有什么就播什么）
  if (p === '/api/wallpapers' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, dir: WALL_DIR, files: listWallpapers() });
  }

  if (p === '/api/state' && req.method === 'GET') {
    // 浏览器端不下发敏感 Token（Coolify Token / AI 部署模型 Key 一律打码）
    const safeCfg = Object.assign({}, cfg);
    if (safeCfg.coolify) safeCfg.coolify = Object.assign({}, safeCfg.coolify, { api_token: safeCfg.coolify.api_token ? '***' : '' });
    if (safeCfg.ai_deploy) safeCfg.ai_deploy = Object.assign({}, safeCfg.ai_deploy, { api_key: safeCfg.ai_deploy.api_key ? '***' : '' });
    return sendJson(res, 200, {
      app: E.APP_NAME,
      version: E.VERSION,
      dir: APP_DIR,
      reportsDir: REPORTS_DIR,
      config: safeCfg,
      reports: listReports(),
      last: readLastReport(),
      platform: process.platform,
      node: process.version,
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const next = Object.assign({}, cfg);
    for (const k of ['proxy', 'since', 'engine', 'api_base', 'api_key', 'api_model', 'source_mode', 'lang']) {
      if (body[k] !== undefined) next[k] = String(body[k]);
    }
    if (body.top_n !== undefined) next.top_n = Math.max(5, Math.min(30, parseInt(body.top_n, 10) || 10));
    if (Array.isArray(body.favorites)) next.favorites = body.favorites.map(String).slice(0, 200);
    for (const k of ['favorites', 'schedule', 'autostart', 'last_source']) {
      if (body[k] !== undefined && !Array.isArray(body[k])) next[k] = body[k];
    }
    E.saveConfig(next);
    return sendJson(res, 200, { ok: true, config: next });
  }

  if (p === '/api/favorites' && req.method === 'POST') {
    const body = await readBody(req);
    const repo = String(body.repo || '').trim().replace(/^https?:\/\/(github\.com|gitee\.com|kkgithub\.com)\//i, '');
    let favs = Array.isArray(cfg.favorites) ? cfg.favorites.slice() : [];
    if (body.action === 'add' && repo && !favs.includes(repo)) favs.push(repo);
    if (body.action === 'remove') favs = favs.filter(f => f !== (repo || body.repo));
    if (body.action === 'clear') favs = [];
    cfg.favorites = favs;
    E.saveConfig(cfg);
    return sendJson(res, 200, { ok: true, favorites: favs });
  }

  if (p === '/api/generate' && req.method === 'POST') {
    if (job.running) return sendJson(res, 409, { ok: false, error: '已有任务在运行中，请等待完成或先取消。' });
    const body = await readBody(req);
    const since = String(body.since || cfg.since || 'monthly');
    const sourceMode = String(body.sourceMode || cfg.source_mode || 'auto');
    job.running = true;
    job.percent = 0;
    job.logs = [];
    job.done = false;
    job.error = null;
    job.report = null;
    job.startedAt = Date.now();
    job.finishedAt = 0;
    job.cancel = { v: false };
    job.since = since;

    (async () => {
      try {
        jobLog(`════ 开始生成【${E.periodLabel(since)}榜】分析报告 ════`);
        const res2 = await E.runGenerate(since, cfg, {
          log: jobLog,
          progress: (pct, msg) => { job.percent = pct; if (msg) jobLog('· ' + msg); },
          sourceMode,
          cancel: job.cancel,
        });
        job.report = res2.report;
        job.percent = 100;
        jobLog(`════ 全部完成，用时 ${Math.round((Date.now() - job.startedAt) / 1000)} 秒 ════`);
      } catch (err) {
        job.error = err && err.message ? err.message : String(err);
        jobLog('❌ 出错：' + job.error);
      } finally {
        job.running = false;
        job.done = true;
        job.finishedAt = Date.now();
      }
    })();
    return sendJson(res, 200, { ok: true, since, sourceMode, startedAt: job.startedAt });
  }

  if (p === '/api/job' && req.method === 'GET') {
    const from = parseInt(url.searchParams.get('from'), 10) || 0;
    return sendJson(res, 200, {
      running: job.running,
      percent: job.percent,
      done: job.done,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      logs: job.logs.slice(from),
      next: job.logs.length,
      report: job.report,
    });
  }

  if (p === '/api/cancel' && req.method === 'POST') {
    job.cancel.v = true;
    jobLog('⛔ 已请求取消，正在停止…');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/last-report' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, report: readLastReport() });
  }

  if (p === '/api/history' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, reports: listReports() });
  }

  if (p === '/api/history/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const name = path.basename(String(body.md || ''));
    let removed = 0;
    for (const f of [name, name.replace(/\.md$/, '.html'), name.replace(/\.md$/, '.json')]) {
      const fp = path.join(REPORTS_DIR, f);
      try {
        if (f && fs.existsSync(fp)) { fs.unlinkSync(fp); removed++; }
      } catch (e) { /* ignore */ }
    }
    return sendJson(res, 200, { ok: true, removed, reports: listReports() });
  }

  if (p === '/api/export' && req.method === 'POST') {
    return sendJson(res, 200, exportLatest());
  }

  if (p === '/api/open-report' && req.method === 'POST') {
    const body = await readBody(req);
    const file = path.basename(String(body.file || ''));
    const fp = path.join(REPORTS_DIR, file);
    if (!file || !fs.existsSync(fp)) return sendJson(res, 200, { ok: false, error: '报告文件不存在' });
    try { spawn('cmd', ['/c', 'start', '', fp], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { /* ignore */ }
    return sendJson(res, 200, { ok: true, file });
  }

  if (p === '/api/open-folder' && req.method === 'POST') {
    const body = await readBody(req);
    const target = body.target === 'data' ? DATA_DIR : REPORTS_DIR;
    try { spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* ignore */ }
    return sendJson(res, 200, { ok: true, dir: target });
  }

  if (p === '/api/test-conn' && req.method === 'POST') {
    const chain = E.buildSourceChain(String(cfg.since || 'daily'), String(cfg.proxy || ''), () => {}, String(cfg.source_mode || 'auto'));
    const results = await Promise.all(chain.map(async (src) => {
      const t0 = Date.now();
      try {
        const r = await E.request(src.url, { timeout: 7000, proxy: src.proxy });
        return { name: src.name, url: src.url, ok: r.status >= 200 && r.status < 400, detail: `HTTP ${r.status}`, ms: Date.now() - t0 };
      } catch (e) {
        return { name: src.name, url: src.url, ok: false, detail: e.code || e.message, ms: Date.now() - t0 };
      }
    }));
    return sendJson(res, 200, { ok: true, results });
  }

  if (p === '/api/test-api' && req.method === 'POST') {
    if (!String(cfg.api_key || '').trim()) return sendJson(res, 200, { ok: false, error: '尚未填写 API Key' });
    try {
      const reply = await E.callLLM(cfg, [{ role: 'user', content: '连通性测试，请只回复两个字：正常' }], () => {}, 1);
      return sendJson(res, 200, { ok: true, reply: String(reply).slice(0, 120) });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/schedule' && req.method === 'POST') {
    const body = await readBody(req);
    const sch = body.enabled ? {
      enabled: true,
      freq: body.freq === 'weekly' ? 'weekly' : 'daily',
      weekday: parseInt(body.weekday, 10) || 0,
      time: /^\d{2}:\d{2}$/.test(body.time) ? body.time : '09:00',
      since: ['daily', 'weekly', 'monthly'].includes(body.since) ? body.since : 'daily',
      boot: Boolean(body.boot),
    } : { enabled: false, boot: Boolean(body.boot) };
    cfg.schedule = sch;
    cfg.autostart = Boolean(body.boot);
    E.saveConfig(cfg);
    const result = applySchedule(sch);
    return sendJson(res, 200, { ok: true, schedule: sch, result });
  }

  if (p === '/api/autostart' && req.method === 'POST') {
    const body = await readBody(req);
    const on = Boolean(body.enabled);
    cfg.autostart = on;
    E.saveConfig(cfg);
    return sendJson(res, 200, { ok: true, result: toggleAutostart(on) });
  }

  if (p === '/api/open-tool' && req.method === 'POST') {
    const r = await openDownloadTool();
    return sendJson(res, 200, r);
  }

  if (p === '/api/compare' && req.method === 'POST') {
    // 收藏对比：优先从最近报告取；不在报告里的仓库，现场抓元数据 + README 生成简易分析
    const body = await readBody(req);
    const repo = String(body.repo || '').trim();
    const last = readLastReport();
    const hit = last && (last.items || []).find(x => String(x.full_name).toLowerCase() === repo.toLowerCase());
    if (hit) return sendJson(res, 200, { ok: true, from: 'report', item: hit });
    return sendJson(res, 200, { ok: false, error: `项目「${repo}」不在最近一份报告中。生成一份包含它的报告后再对比。` });
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在：' + p });
}

/* ------------------------------------------------------------------ HTTP 服务 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, INDEX_FILE);

    if (url.pathname === '/favicon.ico') return send(res, 204, '');

    if (url.pathname.startsWith('/wallpaper/')) {
      const name = decodeURIComponent(url.pathname.slice('/wallpaper/'.length));
      return serveWallpaper(req, res, name);
    }

    if (url.pathname.startsWith('/reports/')) {
      const name = decodeURIComponent(url.pathname.slice('/reports/'.length));
      const fp = path.join(REPORTS_DIR, path.basename(name));
      return serveFile(res, fp);
    }

    // 其余静态文件（限制在 html 目录内，且不暴露 config.json）
    const rel = decodeURIComponent(url.pathname.slice(1));
    const fp = path.normalize(path.join(APP_DIR, rel));
    if (!fp.startsWith(APP_DIR) || path.basename(fp) === 'config.json') return send(res, 403, '403 Forbidden');
    return serveFile(res, fp);
  } catch (e) {
    return send(res, 500, '500 ' + (e && e.message));
  }
});

/* -------------------------------------------------------------------- 启动 */

function openBrowser(url) {
  try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { /* ignore */ }
}

/** 探测该端口上是否已经跑着本程序（用于单实例：避免开了旧进程又开新进程导致按钮行为不一致） */
function probeInstance(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 1200 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(j && j.app && String(j.app).includes('GitHub') ? j : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function listen(port, tries = 0) {
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n🔥 ${E.APP_NAME} v${E.VERSION} · Web 版已启动`);
    console.log(`   ${url}`);
    console.log(`   报告目录：${REPORTS_DIR}`);
    console.log('   关闭本窗口即退出服务。\n');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  }).on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      const running = await probeInstance(port);
      if (running) {
        // 同版本已在跑：直接打开它，不再起第二个实例
        if (String(running.version) === String(E.VERSION)) {
          const url = `http://127.0.0.1:${port}`;
          console.log(`✔ 本程序已在运行：${url}（已为你打开该页面，本次启动退出）`);
          if (!process.argv.includes('--no-open')) openBrowser(url);
          process.exit(0);
        }
        // 旧版本占着端口：换下一个端口启动新版本，避免用户对着旧界面点按钮
        console.log(`⚠ 端口 ${port} 上是旧版本 v${running.version}，将换端口启动 v${E.VERSION}`);
      }
      if (tries < 20 && !process.argv.includes('--no-open')) {
        console.log(`端口 ${port} 被占用，尝试 ${port + 1} …`);
        setTimeout(() => listen(port + 1, tries + 1), 80);
        return;
      }
    }
    console.error('启动失败：' + err.message);
    process.exit(1);
  });
}

/* ------------------------------------------------------------------ CLI 模式 */

function parseArgs(argv) {
  const a = { cli: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--cli') a.cli = true;
    else if (k === '--no-open') a.no_open = true;
    else if (k === '--since') a.since = argv[++i];
    else if (k === '--source') a.source = argv[++i];
    else if (k === '--engine') a.engine = argv[++i];
    else if (k === '--proxy') a.proxy = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--html-file') a.htmlFile = argv[++i];
    else if (k === '--port') a.port = parseInt(argv[++i], 10);
  }
  return a;
}

async function runCli(args) {
  const cfg = E.loadConfig();
  if (args.proxy !== undefined) cfg.proxy = args.proxy;
  if (args.engine) cfg.engine = args.engine;
  if (args.source) cfg.source_mode = args.source;
  const since = args.since || cfg.since || 'monthly';
  try {
    const r = await E.runGenerate(since, cfg, {
      log: (l) => console.log(l),
      outDir: args.out || REPORTS_DIR,
      sourceMode: args.source || undefined,
      htmlFile: args.htmlFile || undefined,
    });
    console.log('OK:', r.mdPath);
    return 0;
  } catch (e) {
    console.error('❌ 生成失败：' + (e && e.message ? e.message : e));
    return 1;
  }
}

const args = parseArgs(process.argv);
if (args.cli) {
  runCli(args).then((code) => process.exit(code));
} else {
  listen(args.port || BASE_PORT);
}
