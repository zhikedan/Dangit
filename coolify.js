/* ============================================================================
   Coolify 一键部署模块（Web 版后端）
   ----------------------------------------------------------------------------
   职责：把网页版「🚀 一键部署」弹窗的请求，转成 Coolify v4 REST API 调用。

   流程：
     校验仓库 → 找/建项目 → 取本机服务器 → 创建 Public Repository 应用
     → 设置访问地址（域名 或 端口映射）→ 触发部署 → 轮询构建状态 → 返回访问链接

   说明：
     · 只走 HTTP API（http://localhost:8000/api/v1），不依赖 docker / wsl 命令
     · Token 保存在 config.json，不返回给浏览器
     · 部署任务在内存中排队，前端通过 /api/coolify/job 轮询日志与进度
   ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const E = require('./engine');

/* ------------------------------------------------------------------ 配置 */

const DEFAULT_BASE = 'http://localhost:8000';
const PROJECT_NAME = '一键部署';

function getCfg() {
  const cfg = E.loadConfig();
  if (!cfg.coolify || typeof cfg.coolify !== 'object') {
    cfg.coolify = { base_url: DEFAULT_BASE, api_token: '', last_target: '' };
  }
  if (!cfg.coolify.base_url) cfg.coolify.base_url = DEFAULT_BASE;
  return cfg;
}

function saveCfg(cfg) { E.saveConfig(cfg); }

/* ------------------------------------------------------------ HTTP 请求工具 */

/** 本地 Coolify API 请求（不走系统代理：localhost 走代理必失败） */
function apiRequest(base, token, method, apiPath, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(base.replace(/\/+$/, '') + '/api/v1' + apiPath); }
    catch (e) { return reject(new Error('Coolify 面板地址格式不正确：' + base)); }
    const isHttps = u.protocol === 'https:';
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'gh-report-web/coolify',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }

    const req = (isHttps ? https : http).request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Coolify 响应超时（' + Math.round(timeout / 1000) + ' 秒）')));
    req.on('error', e => {
      const code = e && e.code;
      if (code === 'ECONNREFUSED') return reject(new Error('连不上 Coolify（' + base + '）：服务未启动或端口不对'));
      if (code === 'ENOTFOUND') return reject(new Error('Coolify 地址无法解析：' + base));
      reject(e);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 把接口错误翻译成能看懂的中文 */
function explain(r, action) {
  const msg = r && r.json && (r.json.message || r.json.error);
  if (r.status === 401 || r.status === 403) return new Error('Coolify API Token 无效或权限不足（HTTP ' + r.status + '）');
  if (r.status === 404) return new Error(action + '：接口或资源不存在（HTTP 404）' + (msg ? '：' + msg : ''));
  if (r.status === 422) return new Error(action + '：参数校验失败（HTTP 422）' + (msg ? '：' + msg : ''));
  return new Error(action + '失败（HTTP ' + r.status + '）' + (msg ? '：' + msg : ''));
}

/* -------------------------------------------------------------- 仓库解析 */

/** 解析 GitHub / Gitee 仓库地址，返回 { host, owner, repo, cloneUrl, webUrl } */
function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let host = 'github';
  let owner, repo;
  let m = s.match(/^git@(github|gitee)\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) {
    host = m[1].toLowerCase(); owner = m[2]; repo = m[3];
  } else {
    const hm = s.match(/^(?:https?:\/\/)?(?:www\.)?(github|gitee)\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
    if (hm) { host = hm[1].toLowerCase(); owner = hm[2]; repo = hm[3]; }
    else {
      const bare = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
      if (!bare) return null;
      owner = bare[1]; repo = bare[2];
    }
  }
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!repo || repo.startsWith('.') || repo.endsWith('.')) return null;
  const site = host === 'gitee' ? 'gitee.com' : 'github.com';
  return {
    host, owner, repo,
    webUrl: 'https://' + site + '/' + owner + '/' + repo,
    cloneUrl: 'https://' + site + '/' + owner + '/' + repo + '.git',
  };
}

/** 简单 JSON GET（用于仓库元数据；失败返回 null，不阻塞部署） */
function fetchJson(url, timeout = 12000) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'gh-report-web', 'Accept': 'application/json' }, timeout,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** 读取仓库信息 + 推测构建方式与端口 */
async function inspectRepo(repo) {
  const info = { ok: true };
  let meta = null;
  if (repo.host === 'github') {
    meta = await fetchJson('https://api.github.com/repos/' + repo.owner + '/' + repo.repo);
  } else {
    meta = await fetchJson('https://gitee.com/api/v5/repos/' + repo.owner + '/' + repo.repo);
  }
  if (meta && !meta.message && !meta.error) {
    info.name = meta.full_name || (repo.owner + '/' + repo.repo);
    info.desc = meta.description || '';
    info.stars = meta.stargazers_count;
    info.lang = meta.language || '';
    info.branch = meta.default_branch || 'main';
    info.sizeKB = meta.size;
    info.license = typeof meta.license === 'string' ? meta.license : (meta.license && meta.license.spdx_id) || '';
  } else {
    info.branch = repo.host === 'gitee' ? 'master' : 'main';
    info.name = repo.owner + '/' + repo.repo;
    info.offline = true;
  }
  // 构建方式 / 端口初判（按语言，粗判；用户可在高级选项里改）
  const lang = String(info.lang || '').toLowerCase();
  const guess = { node: ['nixpacks', 3000], python: ['nixpacks', 8000], go: ['nixpacks', 8080], php: ['nixpacks', 80], 'c#': ['nixpacks', 80], 'c++': ['nixpacks', 8080], rust: ['nixpacks', 8080] };
  let [pack, port] = guess[lang] || ['nixpacks', 3000];
  const nameLower = (repo.repo || '').toLowerCase();
  if (/static|website|site|docs|blog|html/.test(nameLower)) { pack = 'static'; port = 80; }
  info.suggest = { build_pack: pack, port: String(port), branch: info.branch || 'main' };
  return info;
}

/* --------------------------------------------------------------- 部署任务 */

let seq = 1;
const deployJob = {
  id: null, running: false, status: 'idle', percent: 0,
  stage: '', logs: [], result: null, error: null, cancel: { v: false }, startedAt: 0,
};

function resetJob() {
  deployJob.id = 'deploy_' + (seq++) + '_' + Date.now();
  deployJob.running = true;
  deployJob.status = 'running';
  deployJob.percent = 0;
  deployJob.stage = '准备中…';
  deployJob.logs = [];
  deployJob.result = null;
  deployJob.error = null;
  deployJob.cancel = { v: false };
  deployJob.startedAt = Date.now();
  return deployJob;
}

function jlog(msg, percent, stage) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
  deployJob.logs.push(line);
  console.log(line);
  if (deployJob.logs.length > 800) deployJob.logs.splice(0, deployJob.logs.length - 800);
  if (typeof percent === 'number') deployJob.percent = Math.max(0, Math.min(100, percent));
  if (stage) deployJob.stage = stage;
}

function jdone(result) {
  deployJob.running = false;
  deployJob.status = 'done';
  deployJob.percent = 100;
  deployJob.stage = '部署成功';
  deployJob.result = result;
}

function jfail(err) {
  deployJob.running = false;
  deployJob.status = 'error';
  deployJob.stage = '部署失败';
  deployJob.error = err && err.message ? err.message : String(err);
  jlog('❌ ' + deployJob.error);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------------------------------------------ Coolify 操作 */

/** 找项目（没有就建一个「一键部署」项目），返回 project_uuid */
async function ensureProject(api) {
  const list = await api('GET', '/projects', null, '读取项目列表');
  const arr = Array.isArray(list) ? list : (list && (list.data || list.projects)) || [];
  const hit = arr.find(p => String(p.name || '').trim() === PROJECT_NAME) ||
              arr.find(p => String(p.name || '').toLowerCase() === 'one-click-deploy');
  if (hit && hit.uuid) { jlog('📁 复用项目：' + hit.name, 16); return hit.uuid; }
  jlog('📁 创建项目：' + PROJECT_NAME, 16);
  const made = await api('POST', '/projects', { name: PROJECT_NAME, description: '由 GitHub 热门分析报告生成器「一键部署」自动创建' }, '创建项目');
  if (made && made.uuid) return made.uuid;
  throw new Error('创建项目失败：返回结果里没有 uuid');
}

/** 取本机服务器 uuid（Coolify 里名为 localhost 的那台） */
async function ensureServer(api) {
  const list = await api('GET', '/servers', null, '读取服务器列表');
  const arr = Array.isArray(list) ? list : (list && (list.data || list.servers)) || [];
  if (!arr.length) throw new Error('Coolify 里没有可用服务器，请先在面板 Servers 中添加 localhost');
  const hit = arr.find(s => /localhost|本机/i.test(String(s.name || ''))) || arr[0];
  jlog('🖥 部署服务器：' + (hit.name || hit.uuid), 22);
  return { uuid: hit.uuid, name: hit.name || 'localhost' };
}

/** 创建或复用同名应用（重复部署同一仓库时更新配置而不是再建一个） */
async function createApplication(api, payload) {
  // 先看有没有同名应用
  try {
    const list = await api('GET', '/applications', null, '读取应用列表');
    const arr = Array.isArray(list) ? list : (list && (list.data || list.applications)) || [];
    const hit = arr.find(a => String(a.name || '').toLowerCase() === String(payload.name).toLowerCase());
    if (hit && hit.uuid) {
      jlog('♻ 复用已有应用 ' + hit.name + '，按新参数更新', 40);
      await api('PATCH', '/applications/' + encodeURIComponent(hit.uuid), {
        git_repository: payload.git_repository,
        git_branch: payload.git_branch,
        build_pack: payload.build_pack,
        ports_exposes: payload.ports_exposes,
      }, '更新应用配置').catch(() => {});
      return hit.uuid;
    }
  } catch (e) { /* 列表读不到就走新建 */ }

  const body = Object.assign({}, payload);
  try {
    const r = await api('POST', '/applications/public', body, '创建应用');
    if (r && r.uuid) return r.uuid;
    throw new Error('创建应用失败：返回结果里没有 uuid');
  } catch (e) {
    // 兼容不同版本：environment_name 不被接受时改用 environment_uuid 再试一次
    if (/422/.test(e.message)) {
      jlog('⚠ ' + e.message + '，改用 environment_uuid 重试', 42);
      const envUuid = await findEnvironment(api, body.project_uuid);
      if (envUuid) {
        const body2 = Object.assign({}, body);
        delete body2.environment_name;
        body2.environment_uuid = envUuid;
        const r2 = await api('POST', '/applications/public', body2, '创建应用');
        if (r2 && r2.uuid) return r2.uuid;
      }
    }
    throw e;
  }
}

/** 读取项目下的 production 环境 uuid（兼容旧版 API） */
async function findEnvironment(api, projectUuid) {
  try {
    const p = await api('GET', '/projects/' + projectUuid, null, '读取项目详情');
    const envs = (p && (p.environments || p.data && p.data.environments)) || [];
    const hit = envs.find(x => /production/i.test(String(x.name || ''))) || envs[0];
    return hit && hit.uuid;
  } catch (e) { return null; }
}

/** 触发部署，拿到 deployment uuid（v4 为 POST） */
async function triggerDeploy(api, appUuid) {
  const q = '/deploy?uuid=' + encodeURIComponent(appUuid) + '&force=false';
  let r;
  try {
    r = await api('POST', q, {}, '触发部署');
  } catch (e) {
    // 兼容旧版本仍是 GET 的情况
    r = await api('GET', q, null, '触发部署');
  }
  const d = r && (r.deployments || r.data || r);
  const first = Array.isArray(d) ? d[0] : d;
  return (first && (first.deployment_uuid || first.uuid)) || null;
}

/** 轮询部署状态；失败时把最后几行日志带回来，便于界面直接看到原因 */
async function waitDeploy(api, deploymentUuid, maxMs) {
  const start = Date.now();
  let lastStatus = '';
  while (Date.now() - start < maxMs) {
    if (deployJob.cancel.v) throw new Error('已取消部署');
    let st = null, raw = null;
    try {
      raw = await api('GET', '/deployments/' + encodeURIComponent(deploymentUuid), null, '读取部署状态', 20000);
      st = raw && (raw.status || (raw.data && raw.data.status));
    } catch (e) { /* 单次失败继续等 */ }
    if (st && st !== lastStatus) {
      lastStatus = st;
      const map = { queued: '排队中', in_progress: '构建中', running: '构建中', finished: '已完成', failed: '构建失败', cancelled: '已取消' };
      jlog('⏳ 部署状态：' + (map[st] || st), st === 'finished' ? 96 : Math.min(94, deployJob.percent + 4));
    }
    if (st === 'finished') return { ok: true };
    if (st === 'failed' || st === 'cancelled') {
      let lines = [];
      const logs = raw && raw.logs;
      if (Array.isArray(logs)) lines = logs.map(l => String((l && l.output) || ''));
      else if (typeof logs === 'string' && logs.trim()) {
        const sTxt = logs.trim();
        if (sTxt.startsWith('[')) {
          try { lines = JSON.parse(sTxt).map(l => String((l && l.output) || '')); }
          catch (e) { lines = sTxt.split('\n'); }
        } else lines = sTxt.split('\n');
      }
      const bad = lines.map(s => s.trim())
        .filter(s => s && /error|fatal|failed|denied|refused|SSL|timed? ?out|not found|cannot|unable/i.test(s))
        .slice(-4);
      return { ok: false, reason: bad.join(' ｜ ').slice(0, 500) };
    }
    await sleep(3000);
  }
  return { ok: null }; // 超时
}

/* -------------------------------------------------------- 请求体 → 部署参数 */

/** 生成访问地址：返回 { domains, ports_mappings, url } */
function buildTarget(target, repoName, containerPort) {
  const t = target || {};
  const kind = String(t.kind || 'domain');
  if (kind === 'port') {
    const hostPort = String(t.port || '').trim() || '8080';
    if (!/^\d{2,5}$/.test(hostPort)) throw new Error('本机端口不合法：' + hostPort);
    return {
      domains: '',
      ports_mappings: hostPort + ':' + containerPort,
      url: 'http://localhost:' + hostPort,
      desc: '本机端口 ' + hostPort + ' → 容器 ' + containerPort,
    };
  }
  let domain = String(t.domain || '').trim().toLowerCase();
  if (!domain) {
    const slug = String(repoName || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
    domain = slug + '.localhost';
  }
  domain = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain)) throw new Error('访问地址不合法：' + domain);
  return {
    domains: 'http://' + domain,
    ports_mappings: '',
    url: 'http://' + domain,
    desc: '域名 ' + domain,
  };
}

/** 把构建失败原因归成人话（原始日志只留在面板里看） */
function friendlyDeployError(reason) {
  if (/SSL|unexpected eof|RPC failed|unable to access|Could not resolve|resolve host|timed? ?out|connection reset|Empty reply/i.test(reason || '')) {
    return '无法从 GitHub 拉取代码（SSL 连接被中断，多为网络不通/需要代理）';
  }
  if (/not found|404/i.test(reason || '')) return '仓库不存在或为私有仓库（404）';
  if (/permission|denied|authentication|403/i.test(reason || '')) return '没有访问权限（私有仓库或 Token 权限不足）';
  if (/port is already allocated|address already in use/i.test(reason || '')) return '端口被占用，请换一个「本机端口」再试';
  return '';
}

/** 是否值得自动重试一次（网络抖动类错误） */
function worthRetry(reason) {
  return /SSL|unexpected eof|RPC failed|unable to access|Could not resolve|resolve host|timed? ?out|connection reset|Empty reply/i.test(reason || '');
}

/* ------------------------------------------------------------------ 主流程 */

async function runDeploy(cfg, repoInput, target, adv) {
  const cl = cfg.coolify;
  const api = (method, p, body, action, timeout) => apiRequest(cl.base_url, cl.api_token, method, p, body, timeout)
    .then(r => {
      if (r.status >= 400) throw explain(r, action || '调用 Coolify');
      return r.json;
    });

  jlog('🚀 开始一键部署：' + repoInput, 4, '解析仓库');
  const repo = parseRepo(repoInput);
  if (!repo) throw new Error('仓库地址格式不正确（支持 owner/repo、https://github.com/owner/repo、https://gitee.com/owner/repo）');
  if (repo.host !== 'github') throw new Error('本机 Coolify 实例只能部署 GitHub 公开仓库（Gitee 仓库请先镜像到 GitHub，或用「📦 下载工具」下载源码）');
  jlog('📦 仓库：' + repo.owner + '/' + repo.repo + '（' + repo.host + '）', 8);

  // 高级选项优先，否则读仓库信息猜
  const info = await inspectRepo(repo);
  const branch = (adv && adv.branch) || info.suggest.branch || 'main';
  const buildPack = (adv && adv.build_pack) || info.suggest.build_pack || 'nixpacks';
  const containerPort = String((adv && adv.port) || info.suggest.port || '3000');
  jlog('⚙ 分支 ' + branch + ' ｜ 构建方式 ' + buildPack + ' ｜ 容器端口 ' + containerPort, 12);

  const projectUuid = await ensureProject(api);
  const server = await ensureServer(api);

  // 应用名：owner-repo，避免重名
  const appName = (repo.owner + '-' + repo.repo).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 50);
  const tgt = buildTarget(target, repo.repo, containerPort);
  jlog('🎯 访问地址：' + tgt.desc, 28);

  jlog('📦 创建应用 ' + appName + ' …', 34, '创建应用');
  const appUuid = await createApplication(api, {
    project_uuid: projectUuid,
    server_uuid: server.uuid,
    environment_name: 'production',
    git_repository: repo.host === 'github' ? (repo.owner + '/' + repo.repo) : repo.cloneUrl,
    git_branch: branch,
    build_pack: buildPack,
    ports_exposes: containerPort,
    name: appName,
    instant_deploy: false,
  });
  jlog('✅ 应用已创建：' + appUuid, 48, '配置访问地址');

  // 写入访问地址（域名 或 端口映射）
  const patch = {};
  if (tgt.domains) patch.domains = tgt.domains;
  if (tgt.ports_mappings) patch.ports_mappings = tgt.ports_mappings;
  if (Object.keys(patch).length) {
    await api('PATCH', '/applications/' + encodeURIComponent(appUuid), patch, '设置访问地址');
    jlog('🔗 访问地址已设置：' + tgt.url, 54);
  }

  jlog('🔨 触发构建部署 …', 58, '构建中');
  let depUuid = await triggerDeploy(api, appUuid);
  if (!depUuid) throw new Error('触发部署失败：没有返回 deployment_uuid');

  let wait = await waitDeploy(api, depUuid, 15 * 60 * 1000);
  // 国内访问 GitHub 常被 SSL 掐断：自动重试一次
  if (wait.ok === false && worthRetry(wait.reason)) {
    jlog('🔁 拉代码时网络中断，自动重试一次 …', 60, '重试中');
    depUuid = await triggerDeploy(api, appUuid);
    if (depUuid) wait = await waitDeploy(api, depUuid, 15 * 60 * 1000);
  }
  if (wait.ok === false) {
    const friendly = friendlyDeployError(wait.reason);
    if (friendly) throw new Error('构建失败：' + friendly + '（详细日志见 Coolify 面板）');
    if (wait.reason) jlog('📋 失败原因：' + wait.reason);
    throw new Error('构建失败：' + (wait.reason || '请打开 Coolify 面板查看部署日志'));
  }
  if (wait.ok === null) jlog('⚠ 等待超时，部署可能仍在后台进行，可稍后到面板确认', 90);

  // 回读应用状态
  let finalUrl = tgt.url;
  try {
    const app = await api('GET', '/applications/' + encodeURIComponent(appUuid), null, '读取应用状态');
    const fqdn = app && (app.fqdn || app.domains);
    if (fqdn) finalUrl = String(fqdn).split(',')[0].trim();
  } catch (e) { /* 忽略 */ }

  jlog('✅ 部署完成：' + finalUrl, 100, '部署成功');
  return {
    appUuid, appName, url: finalUrl, branch, buildPack, containerPort,
    server: server.name, repo: repo.owner + '/' + repo.repo, host: repo.host,
    panel: cl.base_url.replace(/\/+$/, '') + '/project/' + projectUuid,
  };
}

/* ------------------------------------------------------------ API 入口 */

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

async function handle(req, res, url) {
  const p = url.pathname;
  const cfg = getCfg();

  // 状态：面板是否在线 + Token 是否已配置
  if (p === '/api/coolify/status' && req.method === 'GET') {
    const base = cfg.coolify.base_url;
    let reachable = false; let authed = false; let detail = '';
    try {
      const r = await apiRequest(base, cfg.coolify.api_token, 'GET', '/projects', null, 8000);
      reachable = true;
      authed = r.status < 400;
      if (r.status === 401) detail = 'Token 未配置或已失效';
    } catch (e) { detail = e.message; }
    return sendJson(res, 200, {
      ok: true, base, reachable, authed,
      tokenSet: Boolean(cfg.coolify.api_token),
      detail, version: 'v4',
    });
  }

  // 保存 Token（前端只在首次配置时传一次）
  if (p === '/api/coolify/token' && req.method === 'POST') {
    const body = await readBody(req);
    const token = String(body.token || '').trim();
    const base = String(body.base || cfg.coolify.base_url || DEFAULT_BASE).trim();
    if (!/^https?:\/\//i.test(base)) return sendJson(res, 400, { ok: false, error: '面板地址需要以 http:// 或 https:// 开头' });
    const r = await apiRequest(base, token, 'GET', '/projects', null, 8000).catch(e => ({ status: 0, text: e.message }));
    if (r.status === 401 || r.status === 403) return sendJson(res, 200, { ok: false, error: 'Token 无效或权限不足，请重新生成' });
    if (r.status >= 400) return sendJson(res, 200, { ok: false, error: '连接 Coolify 失败：HTTP ' + r.status });
    const c = getCfg();
    c.coolify.base_url = base.replace(/\/+$/, '');
    c.coolify.api_token = token;
    saveCfg(c);
    return sendJson(res, 200, { ok: true, base: c.coolify.base_url });
  }

  // 校验仓库 + 推断参数
  if (p === '/api/coolify/inspect' && req.method === 'POST') {
    const body = await readBody(req);
    const repo = parseRepo(body.repo);
    if (!repo) return sendJson(res, 200, { ok: false, error: '仓库地址格式不正确' });
    try {
      const info = await inspectRepo(repo);
      return sendJson(res, 200, Object.assign({ ok: true, repo }, info));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  // 发起部署
  if (p === '/api/coolify/deploy' && req.method === 'POST') {
    if (deployJob.running) return sendJson(res, 409, { ok: false, error: '已有部署任务进行中，请等待完成' });
    if (!cfg.coolify.api_token) return sendJson(res, 200, { ok: false, needToken: true, error: '尚未配置 Coolify API Token' });
    const body = await readBody(req);
    resetJob();
    const repoInput = String(body.repo || '').trim();
    const target = body.target || { kind: 'domain' };
    const adv = body.advanced || {};
    // 异步执行，前端轮询 /job
    runDeploy(cfg, repoInput, target, adv).then(r => jdone(r)).catch(e => jfail(e));
    return sendJson(res, 200, { ok: true, jobId: deployJob.id });
  }

  // 部署进度
  if (p === '/api/coolify/job' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true, id: deployJob.id, running: deployJob.running, status: deployJob.status,
      percent: deployJob.percent, stage: deployJob.stage,
      logs: deployJob.logs.slice(-300), result: deployJob.result, error: deployJob.error,
    });
  }

  // 取消
  if (p === '/api/coolify/cancel' && req.method === 'POST') {
    deployJob.cancel.v = true;
    jlog('⛔ 已请求取消，等待当前步骤结束…');
    return sendJson(res, 200, { ok: true });
  }

  // 已部署应用列表（面板用，可选）
  if (p === '/api/coolify/apps' && req.method === 'GET') {
    if (!cfg.coolify.api_token) return sendJson(res, 200, { ok: false, needToken: true, apps: [] });
    try {
      const r = await apiRequest(cfg.coolify.base_url, cfg.coolify.api_token, 'GET', '/applications', null, 15000);
      if (r.status >= 400) return sendJson(res, 200, { ok: false, error: explain(r, '读取应用列表').message, apps: [] });
      const arr = Array.isArray(r.json) ? r.json : (r.json && (r.json.data || r.json.applications)) || [];
      const apps = arr.map(a => ({
        uuid: a.uuid, name: a.name, url: (a.fqdn || a.domains || '').split(',')[0] || '',
        status: a.status || '', repo: a.git_repository || '',
      }));
      return sendJson(res, 200, { ok: true, apps });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message, apps: [] });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Coolify 接口不存在：' + p });
}

module.exports = { handle, parseRepo, inspectRepo };
