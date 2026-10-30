/* ============================================================================
   一键部署 · 本地路径部署（Web 版后端）
   ----------------------------------------------------------------------------
   输入：项目名称 / 仓库网址 + 本地目标路径（如 E:\pc\桌面\github\xxt）
   自动完成：输入解析 → 路径校验 → 环境检测 → 获取源码 → 依赖安装 → 构建
             → 产物落位 → 完整性校验 → 生成启动脚本 → 输出结果

   设计要点：
     · 全程在临时暂存目录构建，成功后才写入目标路径，失败不会污染目标
     · 目标路径不存在自动创建；非空时按策略备份/合并/放入子目录
     · 常见异常自动处理：git 缺失或拉取失败改 ZIP；npm 慢改国内镜像重试；
       依赖锁文件自动选包管理器；无构建脚本自动跳过
     · 每个阶段都有明确中文日志；失败返回阶段名 + 可执行建议
   ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { URL } = require('url');

const E = require('./engine');

const DATA_DIR = E.DATA_DIR;
const HISTORY_FILE = path.join(DATA_DIR, 'deploy_history.json');

/** 工作目录（临时文件 + 依赖缓存）：默认放在程序所在盘，避免写满 C 盘 */
function workRoot() {
  try {
    const cfg = E.loadConfig();
    const custom = cfg && cfg.deploy && cfg.deploy.work_dir;
    if (custom) return path.win32.normalize(custom);
  } catch (e) { /* ignore */ }
  const appDrive = path.win32.parse(E.APP_DIR).root || 'E:\\';
  return path.win32.join(appDrive, 'deploy_cache');
}

/** 子进程统一使用的环境变量：TMP/TEMP 与各包管理器缓存全部指向工作目录 */
function childEnv(root) {
  const tmp = path.join(root, 'tmp');
  return {
    TMP: tmp, TEMP: tmp,
    PIP_CACHE_DIR: path.join(root, 'pip'),
    npm_config_cache: path.join(root, 'npm'),
    YARN_CACHE_FOLDER: path.join(root, 'yarn'),
    GIT_TERMINAL_PROMPT: '0',
  };
}
const SKIP_DIRS = new Set(['.git', '.github', '.gitlab', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'dist', 'build', '.next', 'out']);
const FORBIDDEN = [
  /^[a-z]:\\?$/i,                                  // 盘符根目录
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\system volume information/i,
  /^[a-z]:\\\$recycle\.bin/i,
];

/* ------------------------------------------------------------------ 任务状态 */

let seq = 1;
const job = {
  id: null, running: false, status: 'idle', percent: 0, stage: '',
  logs: [], result: null, error: null, cancel: { v: false }, child: null, startedAt: 0,
  issues: [], actions: [], summary: null, ctx: {},
};

function resetJob() {
  job.id = 'local_' + (seq++) + '_' + Date.now();
  job.running = true; job.status = 'running'; job.percent = 0;
  job.stage = '准备中…'; job.logs = []; job.result = null; job.error = null;
  job.cancel = { v: false }; job.child = null; job.startedAt = Date.now();
  job.env = {};
  job.issues = []; job.actions = []; job.summary = null; job.ctx = {};
  return job;
}

/** 同步等待（毫秒），用于 Windows 文件占用重试 */
function sleepSync(ms) {
  try { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
  catch (e) { /* ignore */ }
}

/** 取消异常（区别于真实故障，总结里不做“故障”处理） */
function cancelErr() {
  const e = new Error('用户取消了本次部署');
  e.code = 'CANCELLED';
  return e;
}

/** 立即收尾为「已取消」：不等管道自然结束 */
function jcancel() {
  if (job.status === 'cancelled') return;
  job.running = false;
  job.status = 'cancelled';
  job.stage = '已取消';
  job.error = '用户取消了本次部署（目标路径未写入）';
  recIssue('warn', '取消', '用户主动取消', '部署被手动取消，未继续安装/构建，目标路径保持不变');
  job.summary = buildSummary(false, true);
  persistSummary(job.summary);
}

function jlog(msg, percent, stage) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
  for (const part of String(msg).split('\n')) job.logs.push('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + part);
  if (job.logs.length > 1200) job.logs.splice(0, job.logs.length - 1200);
  if (typeof percent === 'number') job.percent = Math.max(job.percent, Math.min(100, percent));
  if (stage) job.stage = stage;
  console.log(line);
}

function jdone(result) {
  job.running = false; job.status = 'done'; job.percent = 100;
  job.stage = '部署成功'; job.result = result;
  job.summary = buildSummary(true);
  job.result.summary = { id: job.summary.id, issues: job.summary.issues.length, hasError: false };
  persistSummary(job.summary);
}
function jfail(err, stage) {
  if (err && err.code === 'CANCELLED') { jcancel(); return; }
  job.running = false; job.status = 'error'; job.stage = stage || job.stage || '部署失败';
  job.error = (err && err.message) ? err.message : String(err);
  jlog('❌ ' + job.error, undefined, job.stage);
  const t = String(job.error || '').split(/[：:]/)[0].slice(0, 24) || '部署失败';
  recIssue('error', job.stage, t, job.error);
  job.summary = buildSummary(false);
  persistSummary(job.summary);
}

/* ------------------------------------------------------- 问题收集与总结 */

/** 记录一条问题（warn / error）；同一阶段 + 同一说明只记一次，避免重复刷屏 */
function recIssue(level, stage, title, detail, suggestion) {
  const d = String(detail || '').slice(0, 800);
  const dup = job.issues.find(i => i.level === level && i.stage === (stage || job.stage) && i.detail === d);
  if (dup) {
    if (suggestion && !dup.suggestion) dup.suggestion = suggestion;
    return;
  }
  job.issues.push({
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level, stage: stage || job.stage, title, detail: d,
    suggestion: suggestion || '',
  });
}

/** 记录一次自动补救动作（不是错误，但要写进总结） */
function recAction(text) {
  job.actions.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text });
  jlog('🛠 ' + text);
}

/** 按错误文本判定根因 + 修复建议 */
function classifyError(msg) {
  const m = String(msg || '');
  const rules = [
    {
      re: /SSL|schannel|unexpected eof|ECONNRESET|ECONNREFUSED|502|proxy|CONNECT tunnel|ETIMEDOUT|timed? ?out/i,
      cause: '网络连接被中断（GitHub / 代理层）',
      sugg: ['开启代理或 GitHub 加速器后重试', '改用 Gitee 上的镜像仓库（https://gitee.com/owner/repo）', '确认公司/校园网代理没有拦截 github.com 与 codeload.github.com'],
    },
    {
      re: /404|Not Found|repository .* not found/i,
      cause: '仓库或分支不存在',
      sugg: ['检查 owner/repo 拼写是否完全一致', '确认分支名（main / master / 其他）', '私有仓库需先登录或改用 Token'],
    },
    {
      re: /EBUSY|EPERM|resource busy|被占用|无法备份|无法重命名/i,
      cause: '目标目录被其它程序占用（资源管理器窗口 / 编辑器 / 杀毒软件）',
      sugg: ['关闭正在浏览该目录的窗口或程序后重新部署', '把目标地址换成一个新的父目录（会自动建项目文件夹）', '选「合并覆盖」可保留原文件直接写入'],
    },
    {
      re: /EACCES|EPERM|permission denied|拒绝访问|没有写入权限/i,
      cause: '目标目录没有写入权限',
      sugg: ['换到用户可写的目录（如 E:\\projects\\xxx）', '关闭正在占用该目录的程序（编辑器 / 资源管理器预览）', '必要时以管理员身份运行'],
    },
    {
      re: /ENOSPC|no space|磁盘空间不足/i,
      cause: '磁盘空间不足',
      sugg: ['清理目标磁盘后重试', '换一个有空间的盘符'],
    },
    {
      re: /EADDRINUSE|address already in use|端口.*占用/i,
      cause: '端口被占用',
      sugg: ['关闭占用端口的程序', '或修改启动.bat 里的 PORT 环境变量'],
    },
    {
      re: /npm ERR|ERR_SOCKET|ERR_|registry|ETIMEDOUT|network|Read timed out|Could not install packages|Temporary failure|Connection aborted/i,
      cause: '依赖安装失败（网络或镜像问题）',
      sugg: ['重试一次（工具已自动走 npmmirror 镜像）', '检查代理是否影响 npm', '在本地手动执行 npm install 查看完整报错'],
    },
    {
      re: /build|构建|compile|tsc|vite|webpack/i,
      cause: '项目构建失败',
      sugg: ['查看总结里的关键日志（最后 20 行）', '在本机手动执行一次构建命令定位问题', '若是缺少环境变量，可在项目根目录补 .env 后重试'],
    },
    {
      re: /pg_config|Microsoft Visual C\+\+|Failed building wheel|error: subprocess-exited-with-error|requires? a compiler/i,
      cause: '依赖需要本机编译环境（缺 pg_config / Visual C++ 生成工具）',
      sugg: ['安装对应编译依赖（如 PostgreSQL 客户端开发库）后重试', '换用纯 Python 依赖或预编译轮子的版本', '源码已部署，可在兼容 Python 版本的环境里手动装依赖'],
    },
    {
      re: /No matching distribution|requires Python|Could not find a version|is not supported on this platform/i,
      cause: '依赖不支持当前 Python 版本 / 平台（常见于 Python 3.13 缺轮子）',
      sugg: ['安装 Python 3.10 ~ 3.12 后重试（部分 AI 库尚无 3.13 轮子）', '或按项目 README 指定的版本创建环境', '本项目已部署源码，可稍后手动在目标目录修复环境'],
    },
    {
      re: /workspace:|catalog:|Unsupported URL Type/i,
      cause: '项目是 bun / pnpm 工作区，依赖用了 workspace/catalog 协议',
      sugg: ['安装 bun（项目根 package.json 的 packageManager 字段会写明版本）或 pnpm 后重新部署', '也可在子包里单独 npm install', '源码已交付，装好包管理器即可运行'],
    },
    {
      re: /长时间无输出|执行超时|已终止并重试|timeout.*terminat/i,
      cause: '安装过程长时间无输出或超时（大仓库解析/下载大量依赖时 npm 默认几乎不打印）',
      sugg: ['这是保护机制误判，重新点一次「🚀 开始部署」通常即可完成（现已改为持续输出日志，不会再被误杀）', '若目标目录已有部分文件，会自动备份后重写', '网络极慢时可先手动 npm install 再部署'],
    },
    {
      re: /No matching version found|ETARGET|notarget/i,
      cause: '依赖版本在源上不存在（package.json 版本号写错，或镜像未同步）',
      sugg: ['核对报错里那个包在 package.json 中的版本号', '用 npm view <包> versions 查可用版本', '若官方源有、镜像没有，工具会自动改用官方源，可再试一次'],
    },
    {
      re: /已取消|用户取消/i,
      cause: '用户主动取消（不是故障）',
      sugg: ['重新点击「🚀 开始部署」即可从头再来', '取消不会删除目标目录中已有的文件'],
    },
    {
      re: /not recognized|不是内部或外部命令|ENOENT|未检测到 Git|command not found/i,
      cause: '本机缺少对应运行环境 / 命令',
      sugg: ['安装 Node.js（含 npm）或 Git 后重试', '安装后重新打开程序，让 PATH 生效'],
    },
    {
      re: /校验失败|缺少 index\.html|缺少 package\.json|部署可能不完整/i,
      cause: '部署内容不完整（构建产物缺失）',
      sugg: ['确认项目构建命令能产出 dist / build 目录', '若为纯静态站，确认根目录有 index.html'],
    },
  ];
  for (const r of rules) if (r.re.test(m)) return { cause: r.cause, suggestions: r.sugg };
  return { cause: '未归类错误（详见关键日志）', suggestions: ['查看关键日志最后 20 行', '把总结内容反馈给维护者'] };
}

/** 生成结构化问题总结 */
function buildSummary(success, cancelled) {
  const ctx = job.ctx || {};
  const errs = job.issues.filter(i => i.level === 'error');
  const warns = job.issues.filter(i => i.level === 'warn');
  const main = success ? (warns[0] || null) : (errs[errs.length - 1] || null);
  const cls = success ? { cause: '', suggestions: [] }
    : cancelled
      ? { cause: '用户主动取消（不是故障）', suggestions: ['重新点击「🚀 开始部署」即可从头再来', '取消不会写入或删除目标目录里的文件'] }
      : classifyError(job.error || (main && main.detail) || '');
  const cost = Math.round((Date.now() - job.startedAt) / 1000);

  return {
    id: 'sum_' + Date.now(),
    jobId: job.id,
    time: new Date().toLocaleString('zh-CN'),
    success: Boolean(success),
    cancelled: Boolean(cancelled),
    verdict: cancelled ? '已取消' : (success ? '成功' : '失败'),
    stage: job.stage,
    error: cancelled ? '' : (job.error || ''),
    cause: cls.cause,
    suggestions: cls.suggestions,
    issues: job.issues.slice(),
    actions: job.actions.slice(),
    counts: { error: errs.length, warn: warns.length },
    context: {
      input: ctx.input || '', repo: ctx.repo || '', branch: ctx.branch || '',
      target: ctx.target || '', type: ctx.type || '', mode: ctx.mode || 'auto',
      deployVerdict: ctx.deployVerdict || null,
      cost,
    },
    env: ctx.env || {},
    disk: ctx.disk || null,
    logsTail: job.logs.slice(-30),
    health: ctx.health || null,
  };
}

/** 生成 Markdown 版总结（可复制 / 存文件） */
function summaryToMarkdown(s) {
  if (!s) return '';
  const L = [];
  L.push('# 一键部署问题总结');
  L.push('');
  L.push('- 时间：' + s.time);
  L.push('- 结果：' + (s.cancelled ? '⛔ 已取消（非故障）' : s.success ? '✅ 成功（含提示）' : '❌ 失败'));
  L.push('- 阶段：' + (s.stage || '-'));
  L.push('- 项目：' + (s.context.repo || s.context.input || '-') + '（分支 ' + (s.context.branch || '-') + '）');
  L.push('- 目标路径：' + (s.context.target || '-'));
  L.push('- 类型：' + (s.context.type || '-') + ' ｜ 耗时：' + (s.context.cost || 0) + ' 秒');
  if (s.context.deployVerdict) {
    L.push('- 部署判定：**' + s.context.deployVerdict.label + '** —— ' + s.context.deployVerdict.reason);
    if (s.context.deployVerdict.hint) L.push('  - 建议：' + s.context.deployVerdict.hint);
  }
  if (s.error) L.push('- 错误信息：' + s.error);
  if (s.cause) L.push('- 根因判定：' + s.cause);
  L.push('');
  if (s.suggestions && s.suggestions.length) {
    L.push('## 处理建议');
    s.suggestions.forEach((x, i) => L.push((i + 1) + '. ' + x));
    L.push('');
  }
  if (s.issues.length) {
    L.push('## 问题清单（' + s.issues.length + '）');
    s.issues.forEach(i => {
      L.push('- [' + i.level.toUpperCase() + '] ' + i.stage + ' · ' + i.title + '：' + (i.detail || ''));
      if (i.suggestion) L.push('  - 建议：' + i.suggestion);
    });
    L.push('');
  }
  if (s.actions.length) {
    L.push('## 已自动处理');
    s.actions.forEach(a => L.push('- ' + a.time + ' ' + a.text));
    L.push('');
  }
  if (s.env && Object.keys(s.env).length) {
    L.push('## 环境');
    Object.entries(s.env).forEach(([k, v]) => v && L.push('- ' + k + '：' + v));
    if (s.disk) L.push('- 目标盘剩余空间：' + s.disk);
    L.push('');
  }
  if (s.logsTail && s.logsTail.length) {
    L.push('## 关键日志（末尾 30 条）');
    L.push('```');
    s.logsTail.forEach(l => L.push(l));
    L.push('```');
  }
  return L.join('\n');
}

/** 总结落盘：data/deploy_issues/<时间>.json + latest.json */
function persistSummary(s) {
  try {
    const dir = path.join(DATA_DIR, 'deploy_issues');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, stamp + (s.success ? '_ok' : '_fail') + '.json');
    fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(s, null, 2), 'utf8');
    // Markdown 版，方便直接发给别人
    fs.writeFileSync(file.replace(/\.json$/, '.md'), summaryToMarkdown(s), 'utf8');
  } catch (e) { /* 落盘失败不影响部署结果 */ }
}

/* -------------------------------------------------------------- 输入解析 */

/** 解析仓库地址：支持 owner/repo、git@、github/gitee 网址 */
function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let host = 'github', owner, repo;
  let m = s.match(/^git@(github|gitee)\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) { host = m[1].toLowerCase(); owner = m[2]; repo = m[3]; }
  else {
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
    full: owner + '/' + repo,
    webUrl: 'https://' + site + '/' + owner + '/' + repo,
    cloneUrl: 'https://' + site + '/' + owner + '/' + repo + '.git',
    zipUrl: host === 'gitee'
      ? 'https://gitee.com/' + owner + '/' + repo + '/repository/archive/{branch}.zip'
      : 'https://codeload.github.com/' + owner + '/' + repo + '/zip/refs/heads/{branch}',
  };
}

/** 仅给项目名（无斜杠）时，用 GitHub 搜索补全，返回候选列表 */
function httpsJson(url, timeout = 12000) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'gh-report-web', 'Accept': 'application/vnd.github+json' }, timeout,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function resolveInput(input) {
  const s = String(input || '').trim();
  if (!s) return { ok: false, error: '请输入项目名称或仓库网址' };
  const direct = parseRepo(s);
  if (direct) return { ok: true, mode: 'repo', repo: direct };
  if (/[\\/:]/.test(s)) return { ok: false, error: '地址格式不对：支持 owner/repo、https://github.com/owner/repo、https://gitee.com/owner/repo' };

  // 纯项目名 → GitHub 搜索
  const q = encodeURIComponent(s + ' in:name');
  const data = await httpsJson('https://api.github.com/search/repositories?q=' + q + '&sort=stars&order=desc&per_page=6');
  const items = (data && data.items) || [];
  if (!items.length) return { ok: false, error: '没找到同名项目「' + s + '」，请改用 owner/repo 或完整网址' };
  return {
    ok: true, mode: 'search',
    candidates: items.map(it => ({
      full: it.full_name, host: 'github', desc: it.description || '',
      stars: it.stargazers_count, lang: it.language || '', branch: it.default_branch || 'main',
      webUrl: it.html_url,
    })),
  };
}

/* -------------------------------------------------------------- 路径校验 */

/** 校验本地目标路径，返回详细信息（含可执行的修复建议） */
function checkTarget(raw) {
  const s = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return { ok: false, level: 'empty', error: '请填写部署目标路径，例如 E:\\pc\\桌面\\github\\xxt' };

  // 归一化：支持 / 与 \
  let p = s.replace(/\//g, '\\');
  const winAbs = /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
  if (!winAbs) {
    return { ok: false, level: 'format', error: '路径必须是绝对路径（带盘符），例如 E:\\pc\\桌面\\github\\xxt，不支持相对路径' };
  }
  const norm = path.win32.normalize(p).replace(/\\+$/, '') || p;
  if (FORBIDDEN.some(re => re.test(norm))) {
    return { ok: false, level: 'danger', error: '这个路径是系统目录或磁盘根目录，为了安全不能作为部署目标：' + norm };
  }
  if (path.win32.normalize(norm).toLowerCase().startsWith(path.win32.normalize(E.APP_DIR).toLowerCase())) {
    return { ok: false, level: 'danger', error: '不能部署到本程序自身目录里（会覆盖程序文件）：' + norm };
  }
  // 盘符是否存在
  const drive = norm.slice(0, 2).toUpperCase();
  if (/^[A-Z]:$/.test(drive) && !fs.existsSync(drive + '\\')) {
    return { ok: false, level: 'drive', error: '盘符 ' + drive + ' 不存在，请检查后重填' };
  }

  let exists = false, empty = true, writable = false, entries = [];
  try {
    exists = fs.existsSync(norm);
    if (exists) {
      const st = fs.statSync(norm);
      if (!st.isDirectory()) return { ok: false, level: 'file', error: '该路径已存在且是文件，请指定一个文件夹路径：' + norm };
      entries = fs.readdirSync(norm);
      empty = entries.length === 0;
    }
    // 写权限：存在则直接测，不存在测最近存在的父目录能否创建
    let probe = norm;
    while (!fs.existsSync(probe) && path.win32.dirname(probe) !== probe) probe = path.win32.dirname(probe);
    fs.accessSync(probe, fs.constants.W_OK);
    writable = true;
  } catch (e) {
    return {
      ok: false, level: 'perm',
      error: (exists ? '目标目录没有写入权限：' : '无法在该位置创建目录：') + norm + '（' + (e.code || e.message) + '）',
    };
  }

  const parent = path.win32.dirname(norm);
  return {
    ok: true, path: norm, exists, empty, writable, entries: entries.slice(0, 10),
    parent, parentExists: fs.existsSync(parent),
    relDepth: norm.split('\\').filter(Boolean).length,
  };
}

/* ------------------------------------------------------------- 命令执行 */

function run(cmd, args, opts = {}) {
  // Windows 下 npm/pnpm/yarn/composer 是 .cmd，需要 shell；git/python/go/node 用数组传参更安全（路径含空格也不会断）
  const needShell = process.platform === 'win32' && /^(npm|npx|pnpm|yarn|composer|powershell)$/i.test(cmd);
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd, shell: needShell, windowsHide: true,
      env: Object.assign({}, process.env, job.env || {}, opts.env || {}),
    });
    job.child = child;
    let out = '', err = '', settled = false, idleTimer = null, hbTimer = null;
    const limit = opts.limit || 60000;
    const t0 = Date.now();

    /** 杀进程树：Windows 上 shell 启动的 npm 会派生子进程，只 kill 父进程杀不干净 */
    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else child.kill('SIGKILL');
      } catch (e) { /* ignore */ }
    };
    const finish = (code, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(idleTimer); clearInterval(hbTimer);
      job.child = null;
      if (note) err += '\n' + note;
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => { killTree(); finish(-1, '(执行超时，已终止)'); }, opts.timeout || 300000);

    // 空闲看门狗：连续 N 毫秒没有新输出，且进程还活着 → 判定卡死
    const resetIdle = () => {
      clearTimeout(idleTimer);
      if (opts.idleTimeout) idleTimer = setTimeout(() => { killTree(); finish(-1, '(长时间无输出，已终止)'); }, opts.idleTimeout);
    };
    resetIdle();

    // 心跳：长时间无输出时定期告诉用户“还在跑”，避免误以为卡死而取消
    if (opts.heartbeat) {
      hbTimer = setInterval(() => {
        if (settled) return;
        opts.heartbeat(Math.round((Date.now() - t0) / 1000));
      }, opts.heartbeatEvery || 30000);
    }

    // 行缓冲：子进程输出按 chunk 到达，直接 split 会把半行当成整行（时间戳会插进日志中间）
    const lineBuf = { out: '', err: '' };
    const feed = (which, t) => {
      if (!opts.onLine) return;
      lineBuf[which] += t;
      if (lineBuf[which].length > 4000) {          // 长时间无换行的进度输出，直接吐一段
        opts.onLine(lineBuf[which].slice(0, 4000));
        lineBuf[which] = '';
        return;
      }
      const parts = lineBuf[which].split(/\r?\n|\r/);
      lineBuf[which] = parts.pop();
      for (const l of parts) if (l.trim()) opts.onLine(l);
    };
    const flushLines = () => {
      if (!opts.onLine) return;
      ['out', 'err'].forEach(k => {
        const rest = (lineBuf[k] || '').trim();
        if (rest) opts.onLine(rest);
        lineBuf[k] = '';
      });
    };

    const onData = buf => {
      const t = buf.toString('utf8');
      if (out.length < limit) out += t;
      resetIdle();
      feed('out', t);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', b => {
      const t = b.toString('utf8');
      if (err.length < limit) err += t;
      resetIdle();
      feed('err', t);
    });
    child.on('error', e => { flushLines(); finish(-2, e.message); });
    child.on('close', code => { flushLines(); finish(code); });
    // 兜底：子进程已退出但 stdio 被孙进程占用时，close 可能永远不触发
    child.on('exit', code => setTimeout(() => { flushLines(); finish(code); }, 800));
  });
}

async function hasCmd(cmd, versionArgs) {
  const r = await run(cmd, versionArgs || ['--version'], { timeout: 15000 });
  if (r.code === 0) return { ok: true, version: (r.out || r.err).split(/\r?\n/)[0].trim() };
  return { ok: false, version: '' };
}

/* --------------------------------------------------------- ZIP 下载与解压 */

function download(url, dest, redirects = 5, onProgress) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('下载地址无效')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: u.hostname, path: u.pathname + u.search, timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('重定向次数过多'));
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1, onProgress));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败（HTTP ' + res.statusCode + '）')); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const f = fs.createWriteStream(dest);
      res.on('data', c => { got += c.length; if (onProgress && total) onProgress(got / total); });
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(dest)));
      res.on('error', reject);
      f.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0; }

/** 解压 zip（store/deflate），返回 { fileCount, rootName } */
function extractZip(zipPath, destDir) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailSize = Math.min(size, 66000);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('压缩包已损坏（找不到目录结构）');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('压缩包目录损坏');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({ method, crc, compSize, localOff, name });
      p += 46 + nameLen + extraLen + commentLen;
    }
    let fileCount = 0, rootName = null;
    for (const e of entries) {
      const safe = e.name.replace(/^[/\\]+/, '').split(/[/\\]/).filter(x => x && x !== '.' && x !== '..').join(path.sep);
      if (!safe) continue;
      if (!rootName) rootName = safe.split(path.sep)[0];
      const outPath = path.join(destDir, safe);
      if (e.name.endsWith('/')) { fs.mkdirSync(outPath, { recursive: true }); continue; }
      if (e.method !== 0 && e.method !== 8) throw new Error('不支持压缩方式：' + e.method);
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, e.localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('压缩包已损坏（文件头错误）');
      const dataStart = e.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(e.compSize);
      fs.readSync(fd, comp, 0, e.compSize, dataStart);
      const data = e.method === 8 ? zlib.inflateRawSync(comp) : comp;
      if (crc32(data) !== e.crc) throw new Error('文件校验失败：' + e.name);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, data);
      fileCount++;
    }
    return { fileCount, rootName };
  } finally { fs.closeSync(fd); }
}

/* ------------------------------------------------------------- 文件操作 */

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name)); else n++;
  }
  return n;
}

function dirSize(dir) {
  let s = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) s += dirSize(p);
    else { try { s += fs.statSync(p).size; } catch (x) {} }
  }
  return s;
}

/** 复制目录（跳过版本库 / 缓存等） */
function copyDir(src, dest, opts = {}) {
  const skip = new Set(opts.skip || []);
  let copied = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const keep = opts.include && opts.include.has(e.name);
      if (skip.has(e.name) || (SKIP_DIRS.has(e.name) && !keep)) continue;
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) walk(sp, dp);
      else { try { fs.copyFileSync(sp, dp); copied++; } catch (x) { /* 个别文件被占用时跳过 */ } }
    }
  };
  walk(src, dest);
  return copied;
}

/* ------------------------------------------------------------ 项目识别 */

/** 识别 Node 项目的包管理器：packageManager 字段 > 锁文件 > 默认 npm */
function detectNodeManager(dir, pkg) {
  const has = f => fs.existsSync(path.join(dir, f));
  const pm = String((pkg && pkg.packageManager) || '').trim();      // 例如 bun@1.4.2 / pnpm@9.1.0
  const field = pm.split('@')[0].toLowerCase();
  const known = ['npm', 'pnpm', 'yarn', 'bun'];
  if (known.includes(field)) return { name: field, source: 'packageManager 字段（' + pm + '）' };
  if (has('bun.lockb') || has('bun.lock')) return { name: 'bun', source: 'bun.lock' };
  if (has('pnpm-lock.yaml')) return { name: 'pnpm', source: 'pnpm-lock.yaml' };
  if (has('yarn.lock')) return { name: 'yarn', source: 'yarn.lock' };
  if (has('package-lock.json')) return { name: 'npm', source: 'package-lock.json' };
  return { name: 'npm', source: '默认' };
}

/** 扫描工作区依赖里 npm 无法解析的协议（workspace: / catalog: / link:） */
function scanWorkspaceProtocols(dir, pkg) {
  const found = [];
  const check = file => {
    let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
    const all = Object.assign({}, j.dependencies, j.devDependencies, j.peerDependencies, j.optionalDependencies);
    for (const [k, v] of Object.entries(all)) {
      if (typeof v === 'string' && /^(workspace|catalog|link):/i.test(v)) found.push(k + '@' + v);
    }
  };
  check(path.join(dir, 'package.json'));
  if (!found.length && pkg) {
    const wsRaw = pkg.workspaces;
    const list = Array.isArray(wsRaw) ? wsRaw : (wsRaw && wsRaw.packages) || [];
    const subs = new Set();
    for (const pat of list.slice(0, 20)) {
      const base = path.join(dir, String(pat).replace(/\/?\*\*?$/, ''));
      if (!fs.existsSync(base)) continue;
      try {
        for (const d of fs.readdirSync(base)) {
          const f = path.join(base, d, 'package.json');
          if (fs.existsSync(f)) subs.add(f);
        }
      } catch (e) { /* ignore */ }
    }
    subs.forEach(check);
  }
  return [...new Set(found)];
}

/** 解析 npm 失败原因（版本不存在 / 工作区协议 / 网络 / 其他） */
function analyzeNpmFailure(res) {
  const raw = ((res && res.err) || '') + '\n' + ((res && res.out) || '');
  if (/Unsupported URL Type|workspace:|catalog:/i.test(raw) && /ERR|error/i.test(raw)) {
    return { type: 'workspace' };
  }
  const m = raw.match(/No matching version found for ([^\s,]+)/i);
  if (m) {
    const spec = m[1].replace(/[.。]+$/, '');
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const ver = at > 0 ? spec.slice(at + 1) : '';
    return { type: 'etarget', pkg: name, ver, spec };
  }
  if (/ETARGET|notarget/i.test(raw)) return { type: 'etarget' };
  if (/ECONN|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i.test(raw)) return { type: 'network' };
  return { type: 'other' };
}

/** 官方源上是否存在该包该版本（用于判断镜像是否只是没同步） */
async function npmHasVersion(name, ver) {
  const r = await run('npm', ['view', name + '@' + ver, 'version',
    '--registry=https://registry.npmjs.org', '--fetch-timeout=20000'],
    { timeout: 45000, idleTimeout: 30000 });
  return r.code === 0 && /\d+\.\d+/.test(r.out || '');
}

/**
 * Node 依赖预检：装之前先查 package.json 里"精确固定版本"的依赖，
 * 看镜像源是否有该版本。镜像缺 → 直接用官方源装，不再白等一次失败重试。
 * 只查精确版本（^ ~ * 等范围由 npm 解析，镜像缺个别版本时会自动换源兜底）。
 */
async function preflightNodeDeps(srcDir, registry) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8')); } catch (e) { return { ok: true }; }
  const all = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  // 查精确版本与 ^/~ 范围版本的基线（^0.25.0 → 查 0.25.0）
  const pins = Object.entries(all)
    .map(([n, v]) => {
      const raw = String(v).trim();
      // 精确版本直接查；^/~ 范围版本查其基线版本（如 ^0.25.0 → 查 0.25.0）
      const m = raw.match(/^[\^~]?(\d+\.\d+\.\d+)/);
      return m ? [n, m[1], raw] : null;
    })
    .filter(Boolean)
    .slice(0, 25);   // 上限 25 个，避免预检本身太慢
  if (!pins.length) return { ok: true, skipped: true };

  const host = String(registry || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const missing = [];
  for (const [name, ver, spec] of pins) {
    if (job.cancel.v) throw cancelErr();
    const r = await run('npm', ['view', name + '@' + ver, 'version',
      '--registry=' + registry, '--fetch-timeout=12000', '--fetch-retries=0'],
      { timeout: 25000, idleTimeout: 15000 });
    if (r.code !== 0) missing.push(name + '@' + (spec || ver));
    if (missing.length >= 3) break;   // 发现 3 个就够判断了，不必全查
  }
  if (missing.length) {
    jlog('   ⚠ 预检发现 ' + host + ' 缺少：' + missing.join('、') + '（镜像未同步）');
    return { ok: true, mirrorMissing: missing };
  }
  return { ok: true };
}

/**
 * 安装 Node 依赖：先认包管理器（bun/pnpm/yarn/npm），再认工作区协议，
 * 最后按 npm 的报错类型决定"换源重试"还是"立刻止损"。
 * 返回 { ok, skipped, reason }
 */
async function installNodeDeps(srcDir, proj) {
  const mgr = proj.managerInfo || { name: proj.manager || 'npm', source: '默认' };
  const ws = proj.workspace || [];
  const MIRROR = 'https://registry.npmmirror.com';
  const binOk = async bin => {
    if (bin === 'npm') return true;
    const v = await run(bin, ['--version'], { timeout: 10000 });
    return v.code === 0;
  };

  let bin = mgr.name;
  const ok1 = await binOk(bin);
  if (!ok1) {
    jlog('   ⚠ 项目指定 ' + mgr.name + '（' + mgr.source + '），但本机未安装，先尝试用 npm…');
    recAction('本机缺少 ' + mgr.name + '，已尝试改用 npm 安装');
    bin = 'npm';
  } else if (bin !== 'npm') {
    jlog('   包管理器：' + bin + '（' + mgr.source + '）');
  }

  // 工作区协议（workspace:/catalog:）npm 一定解析不了，别浪费 3 分钟重试
  if (bin === 'npm' && ws.length) {
    const sample = ws.slice(0, 3).join('、') + (ws.length > 3 ? ' 等' : '');
    jlog('   ⚠ 跳过依赖安装：检测到 ' + ws.length + ' 个 workspace/catalog 依赖（' + sample + '），npm 无法解析');
    recIssue('warn', '安装依赖', '工作区依赖需要 bun / pnpm，npm 装不了',
      '检测到 ' + ws.length + ' 个 workspace/catalog 协议依赖：' + sample,
      '安装 bun（项目声明 ' + mgr.source + '）或 pnpm 后重新部署；源码已完整交付');
    return { ok: false, skipped: true, reason: 'workspace 协议依赖需要 bun / pnpm' };
  }

  // 预检：镜像源缺精确版本 → 直接用官方源，跳过注定失败的镜像安装
  let firstReg = MIRROR;
  if (bin === 'npm') {
    jlog('   依赖预检：检查镜像源是否有项目固定的版本…');
    const pf = await preflightNodeDeps(srcDir, MIRROR);
    if (pf.mirrorMissing && pf.mirrorMissing.length) {
      firstReg = null;
      jlog('   → 镜像未同步这些版本，直接改用 npm 官方源安装（省掉一次失败重试）');
      recAction('预检发现镜像缺 ' + pf.mirrorMissing.join('、') + '，已直接改用官方源');
    } else {
      jlog('   ✓ 预检通过');
    }
  }

  // --loglevel=http：npm 解析依赖时默认几乎不打印，长时间静默会被看门狗误杀；加了之后每个请求都吐一行
  const npmArgs = reg => ['install', '--no-audit', '--no-fund', '--fetch-timeout=60000', '--loglevel=http'].concat(reg ? ['--registry=' + reg] : []);
  const otherArgs = reg => ['install'].concat(reg ? ['--registry=' + reg] : []);
  const exec = (b, args) => run(b, args, {
    cwd: srcDir, timeout: 25 * 60 * 1000, idleTimeout: 600000,
    heartbeat: s2 => jlog('   …仍在安装依赖（已 ' + s2 + ' 秒，解析/下载大量依赖时输出很少属正常，请不要取消）'),
    onLine: l => {
      const t = l.trim();
      if (/^(added|removed|changed|up to date)/i.test(t) || /(npm|pnpm|yarn|bun) (error|ERR)|^error /i.test(t)) {
        jlog('   ' + t.slice(0, 160));
      }
    },
  });

  let r;
  if (bin === 'pnpm') {
    r = await exec('pnpm', otherArgs(MIRROR));
    if (r.code !== 0) { jlog('   pnpm 镜像安装失败，改用官方源重试…'); recAction('pnpm 镜像安装失败，已改用官方源'); r = await exec('pnpm', otherArgs(null)); }
  } else if (bin === 'yarn') {
    r = await exec('yarn', ['install', '--registry=' + MIRROR]);
    if (r.code !== 0) { jlog('   yarn 镜像安装失败，改用官方源重试…'); recAction('yarn 镜像安装失败，已改用官方源'); r = await exec('yarn', ['install']); }
  } else if (bin === 'bun') {
    r = await exec('bun', otherArgs(MIRROR));
    if (r.code !== 0) { jlog('   bun 镜像安装失败，改用官方源重试…'); recAction('bun 镜像安装失败，已改用官方源'); r = await exec('bun', ['install']); }
  } else {
    r = await exec('npm', npmArgs(firstReg));
    if (r.code !== 0) {
      const kind = analyzeNpmFailure(r);
      if (kind.type === 'etarget' && kind.pkg && kind.ver) {
        const exists = await npmHasVersion(kind.pkg, kind.ver);
        if (exists) {
          jlog('   镜像没同步 ' + kind.pkg + '@' + kind.ver + '（官方源有），改用官方源重试…');
          recAction('npmmirror 缺少 ' + kind.pkg + '@' + kind.ver + '，已改用官方源');
          r = await exec('npm', npmArgs(null));
        } else {
          const why = kind.pkg + '@' + kind.ver + ' 在 npm 官方源上也不存在';
          jlog('   ⚠ ' + why + '，停止换源重试');
          recIssue('warn', '安装依赖', '依赖版本不存在',
            why + '（package.json 里的版本号可能写错，或该包已下架）',
            '核对 package.json 中 ' + kind.pkg + ' 的版本；源码已交付，改对后重新部署即可');
          return { ok: false, reason: why };
        }
      } else if (kind.type === 'workspace') {
        jlog('   ⚠ npm 报告不支持 workspace 协议，停止重试');
        recIssue('warn', '安装依赖', '依赖使用 workspace 协议',
          'npm 不支持 workspace: / catalog: 协议',
          '安装 bun 或 pnpm 后重新部署；源码已完整交付');
        return { ok: false, skipped: true, reason: 'workspace 协议' };
      } else {
        jlog('   镜像安装失败，改用 npm 官方源重试…');
        recAction('npmmirror 镜像安装失败，已自动改用 npm 官方源重试');
        r = await exec('npm', npmArgs(null));
      }
    }
  }

  if (job.cancel.v) throw cancelErr();
  if (r.code !== 0) {
    const tail = ((r.err || '') + ' ' + (r.out || '')).split('\n').map(x => x.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 200);
    jlog('   ⚠ 依赖安装未完成：' + (tail || '见关键日志'));
    recIssue('warn', '安装依赖', '依赖安装未完成（源码已就绪）', tail || '见关键日志',
      '可手动执行 install 排查；源码已交付，装好依赖后即可运行');
    return { ok: false, reason: tail };
  }
  jlog('✓ 依赖安装完成', 52);
  return { ok: true };
}

function detectProject(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return ''; } };
  const pkgRaw = read('package.json');
  let pkg = null;
  if (pkgRaw) { try { pkg = JSON.parse(pkgRaw); } catch (e) { pkg = { _broken: true }; } }
  if (pkg) {
    const scripts = pkg.scripts || {};
    const mgr = detectNodeManager(dir, pkg);
    const manager = mgr.name === 'npm' ? 'npm' : mgr.name;
    return {
      type: 'node', pkg, manager, managerInfo: mgr,
      buildCmd: scripts.build ? [manager === 'npm' ? 'npm' : manager, ['run', 'build']] : null,
      startCmd: scripts.start
        ? (manager === 'npm' ? ['npm', ['start']] : manager === 'bun' ? ['bun', ['run', 'start']] : [manager, ['start']])
        : (pkg.main ? ['node', [pkg.main]] : null),
      hasDeps: Boolean(pkg.dependencies || pkg.devDependencies),
      workspace: scanWorkspaceProtocols(dir, pkg),
    };
  }
  if (has('requirements.txt') || has('pyproject.toml')) return { type: 'python', hasDeps: true, buildCmd: null, startCmd: null };
  if (has('go.mod')) return { type: 'go', hasDeps: true, buildCmd: ['go', ['build', './...']], startCmd: null };
  if (has('composer.json')) return { type: 'php', hasDeps: true, buildCmd: null, startCmd: null };
  if (has('index.html')) return { type: 'static', hasDeps: false, buildCmd: null, startCmd: null };
  return { type: 'unknown', hasDeps: false, buildCmd: null, startCmd: null };
}

/** 构建产物目录选择 */
/** 判定项目「需要部署」还是「免部署」（结果写进部署信息.json / 结果卡 / 问题总结） */
function detectDeployVerdict(proj, dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return ''; } };
  const need = (reason, hint) => ({ decision: 'need', label: '需要部署', reason, hint });
  const none = (reason, hint) => ({ decision: 'none', label: '免部署', reason, hint });

  // 自带容器定义 → 一定要构建镜像
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml') || has('docker-compose.yaml')) {
    return need('仓库自带 Dockerfile / Compose，需要构建镜像后运行', '建议用 Coolify 或 docker compose 部署');
  }

  if (proj.type === 'static') {
    return none('纯静态站点：双击 index.html 就能看，不需要服务端',
      '要分享给局域网/他人时，再点「▶ 启动」用内置静态服务器（自动选端口）');
  }

  if (proj.type === 'node') {
    const pkg = proj.pkg || {};
    const scripts = pkg.scripts || {};
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const depNames = Object.keys(deps).join(' ').toLowerCase();
    const serverDep = /express|koa|fastify|@nestjs|next|nuxt|hapi|h3|sveltekit|astro|socket\.io/.test(depNames);
    if (scripts.start || serverDep || scripts.build) {
      return need(serverDep || scripts.start ? 'Node 服务型项目：需要常驻进程/端口' : 'Node 构建型项目：需要先构建产物',
        '点「▶ 启动」或双击 启动.bat 即可运行');
    }
    return none('Node 库 / 工具包（没有 start、build 脚本，也没有服务端框架）',
      '作为依赖被其他项目引用即可；若要试用，可直接 node 引用或看 README');
  }

  if (proj.type === 'python') {
    const reqs = (read('requirements.txt') + '\n' + read('pyproject.toml')).toLowerCase();
    const web = /flask|django|fastapi|uvicorn|gunicorn|gradio|streamlit|aiohttp|tornado|bottle/.test(reqs);
    const entry = ['app.py', 'main.py', 'run.py', 'server.py', 'manage.py'].some(has);
    if (web || entry) return need('Python 服务/应用型项目：需要装依赖并启动服务', '装好依赖后双击 启动.bat，或按 README 指定启动命令');
    return none('Python 库 / 脚本集（没有 Web 框架，也没有常见入口文件）', '装好依赖后按 README 调用即可，不需要部署服务');
  }

  if (proj.type === 'go') {
    const hasMain = fs.readdirSync(dir).some(f => f.endsWith('.go') && /package\s+main/.test(read(f)));
    if (hasMain) return need('Go 可执行程序：需要 go build 后运行二进制', '在目标目录执行 go build 生成 exe');
    return none('Go 库（没有 main 包）', '作为模块被引用即可');
  }

  if (proj.type === 'php') return need('PHP 项目：需要 Web 服务器 + PHP 运行环境', '建议用 php -S 或 Nginx/Apache 托管');

  return none('未识别到服务端入口', '按源码 / 资源直接使用即可');
}

/** 选择构建产物目录 */
function pickPublishDir(dir, type) {
  const cands = ['dist', 'build', 'out', '.next/out', 'public'];
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length) {
      // .next 需要 static 资源，直接交付 .next 不具备可运行性，排除
      if (c === '.next/out') continue;
      return p;
    }
  }
  return dir;
}

/* --------------------------------------------------------- 启动脚本生成 */

const STATIC_SERVER = `// 由「一键部署」自动生成的静态站点服务器（零依赖，端口被占用会自动顺延）
const http = require('http'), fs = require('fs'), path = require('path'), { exec } = require('child_process');
const ROOT = __dirname;
const START_PORT = Number(process.env.PORT || 8080);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.map':'application/json', '.txt':'text/plain' };
function handler(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('404 Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(b2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}
function listen(port, tries) {
  const server = http.createServer(handler);
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && tries > 0) { console.log('端口 ' + port + ' 被占用，尝试 ' + (port + 1) + ' …'); return listen(port + 1, tries - 1); }
    console.error('启动失败：' + e.message); process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port;
    console.log('静态站点已启动：' + url + '（按 Ctrl+C 停止）');
    exec('start "" "' + url + '"');
  });
}
listen(START_PORT, 10);
`;

/**
 * 生成启动脚本与说明
 * ⚠ 关键：.bat 一律用纯 ASCII 写入。Windows 批处理按系统 ANSI 代码页(936/GBK)解析文件，
 *   UTF-8 中文会被拆成非法命令（报 "'xx' 不是内部或外部命令"），中文说明放 使用说明.txt。
 */
/**
 * 生成启动脚本与说明
 * ⚠ 关键：.bat 一律用纯 ASCII 写入。Windows 批处理按系统 ANSI 代码页(936/GBK)解析文件，
 *   UTF-8 中文会被拆成非法命令（报 "'xx' 不是内部或外部命令"），中文说明放 使用说明.txt。
 */
function writeStartScripts(target, info) {
  const bat = [];
  const has = f => fs.existsSync(path.join(target, f));
  const pyEntry = ['app.py', 'main.py', 'run.py', 'manage.py', 'wsgi.py', 'server.py'].find(has);
  const hasCompose = has('docker-compose.yml') || has('compose.yaml') || has('docker-compose.yaml');
  const pyWant = String((info.pythonWant || '')).trim();
  const projName = String(info.name || 'app').replace(/[^A-Za-z0-9_.-]/g, '_');

  bat.push('@echo off');
  bat.push('cd /d "%~dp0"');
  bat.push('title ' + projName + ' launcher');

  // 有 compose 且本机装了 docker -> 优先 docker；否则回退本地运行
  if (hasCompose) {
    bat.push('where docker >nul 2>&1');
    bat.push('if errorlevel 1 goto :nodocker');
    bat.push('echo [docker] starting containers with docker compose...');
    bat.push('docker compose up -d');
    bat.push('echo.');
    bat.push('echo Open the URL printed above (e.g. http://localhost:7860).');
    bat.push('echo Press any key to stop the containers...');
    bat.push('pause >nul');
    bat.push('docker compose down');
    bat.push('goto :eof');
    bat.push(':nodocker');
    bat.push('echo [warn] docker not found, falling back to local run.');
    bat.push('echo.');
  }

  if (info.type === 'static') {
    bat.push('echo [static] starting local server...');
    bat.push('node serve.js');
    bat.push('pause');
  } else if (info.type === 'python') {
    bat.push('if not exist "vendor" (');
    bat.push('  echo [deps] installing dependencies into vendor ...');
    bat.push('  python -m pip install --disable-pip-version-check --no-input --target vendor -r requirements.txt');
    bat.push('  if errorlevel 1 (');
    bat.push('    echo [fail] dependency install failed.');
    bat.push('    echo [hint] this project needs Python ' + (pyWant || '3.10 - 3.12') + ' - install it and run again.');
    bat.push('    pause & exit /b 1');
    bat.push('  )');
    bat.push(')');
    bat.push('set PYTHONPATH=%CD%\\vendor');
    if (pyEntry) {
      bat.push('echo [run] python ' + pyEntry);
      bat.push('python ' + pyEntry);
    } else {
      bat.push('echo [warn] no entry found (app.py / main.py / run.py). Edit this file to add the start command.');
    }
    bat.push('pause');
  } else if (info.type === 'node') {
    const mgr = String(info.pkgManager || 'npm').toLowerCase();
    // 用 goto 标签而非嵌套括号块：echo 文本里带括号会破坏 cmd 解析
    bat.push('if exist "node_modules" goto :rundev');
    bat.push('echo [deps] installing dependencies ...');
    if (mgr === 'bun' || mgr === 'pnpm' || mgr === 'yarn') {
      bat.push('where ' + mgr + ' >nul 2>&1');
      bat.push('if errorlevel 1 goto :npmdeps');
      bat.push(mgr + ' install');
      bat.push('if not errorlevel 1 goto :rundev');
      bat.push('echo [warn] ' + mgr + ' install failed, trying npm ...');
      bat.push(':npmdeps');
    }
    bat.push('npm install --no-audit --no-fund');
    bat.push('if errorlevel 1 echo [warn] dependency install failed, run it manually before start');
    bat.push(':rundev');
    if (info.startCommand) {
      bat.push('echo [run] ' + info.startCommand);
      bat.push(info.startCommand);
    } else {
      bat.push('echo [warn] no start script. Edit this file to add the start command.');
    }
    bat.push('pause');
  } else if (info.type === 'go') {
    bat.push('echo [go] building and running...');
    bat.push('go build -o app.exe .');
    bat.push('if errorlevel 1 (echo [fail] go build failed & pause & exit /b 1)');
    bat.push('app.exe');
    bat.push('pause');
  } else {
    bat.push('echo [warn] unknown project type. See the deploy info json for details.');
    bat.push('pause');
  }

  try { fs.writeFileSync(path.join(target, '启动.bat'), bat.join('\r\n') + '\r\n', 'ascii'); } catch (e) {}
  if (info.type === 'static') {
    try { fs.writeFileSync(path.join(target, 'serve.js'), STATIC_SERVER, 'utf8'); } catch (e) {}
  }

  // 中文说明单独存 UTF-8 文本，双击不会触发 cmd 解析问题
  const lines = [];
  lines.push('【' + (info.name || '一键部署') + '】使用说明');
  lines.push('');
  lines.push('部署时间：' + (info.deployedAt || ''));
  lines.push('项目类型：' + info.type + '　判定：' + ((info.deployVerdict && info.deployVerdict.label) || '-'));
  lines.push('目标目录：' + (info.target || target));
  if (pyWant) lines.push('建议 Python 版本：' + pyWant + '（当前 Python 装不上这组依赖时，换成这个版本即可）');
  if (info.startCommand) lines.push('启动命令：' + info.startCommand);
  if (hasCompose) lines.push('本项目自带 docker-compose：装了 Docker 时启动脚本会优先用 docker compose 启动。');
  lines.push('');
  lines.push('启动方式：双击「启动.bat」');
  if (info.type === 'python') {
    lines.push('  · 首次运行会自动把依赖装到 vendor\\ 目录（不污染系统环境）');
    lines.push('  · 若提示依赖安装失败，多半是 Python 版本不匹配，换成上面建议的版本再运行');
  }
  if (info.type === 'node') lines.push('  · 首次运行会自动执行 npm install');
  lines.push('');
  lines.push('本目录还包含「部署信息.json」，记录了仓库地址、分支、文件数、环境版本等信息。');
  try { fs.writeFileSync(path.join(target, '使用说明.txt'), lines.join('\r\n'), 'utf8'); } catch (e) {}
}

/* ------------------------------------------------------------- 部署主流程 */

function ts() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

async function pipeline(opts) {
  const input = String(opts.input || '').trim();
  const rawTarget = String(opts.target || '').trim();
  const mode = opts.mode || 'auto';          // auto | replace | subdir
  const branch = String(opts.branch || '').trim();
  const doInstall = opts.install !== false;
  const doBuild = opts.build !== false;

  /* ---------- 1. 输入 ---------- */
  jlog('① 解析项目：' + input, 3, '解析项目');
  const repo = parseRepo(input);
  if (!repo) throw new Error('项目地址格式不对：支持 owner/repo、https://github.com/owner/repo、https://gitee.com/owner/repo');
  job.ctx.input = input;
  job.ctx.repo = repo.webUrl;

  /* ---------- 2. 路径 ---------- */
  jlog('② 校验目标路径：' + rawTarget, 6, '校验路径');
  const chk = checkTarget(rawTarget);
  if (!chk.ok) throw new Error(chk.error);

  // 默认：目标地址是「父目录」，项目文件放进 <父目录>/<项目名>/，不污染已有内容
  const direct = mode === 'direct' || mode === 'subdir';
  let target = direct ? chk.path : path.win32.join(chk.path, repo.repo);
  job.ctx.mode = direct ? 'direct' : mode;
  job.ctx.root = chk.path;
  job.ctx.folder = direct ? path.win32.basename(chk.path) : repo.repo;
  if (!direct) jlog('  目标地址作为父目录 → 将在其中新建文件夹「' + repo.repo + '」并部署到该文件夹', 8);

  fs.mkdirSync(target, { recursive: true });
  job.ctx.target = target;
  const tExists = fs.existsSync(target);
  const tEmpty = !tExists || fs.readdirSync(target).length === 0;
  jlog('✓ 部署目录：' + target + (tExists && !tEmpty ? '（已存在，将先备份）' : '（已自动创建）'), 10);

  // 目标盘剩余空间（进总结，便于判断 ENOSPC）
  try {
    const st = fs.statfsSync(target);
    const freeGB = (st.bavail * st.bsize / 1073741824).toFixed(1);
    job.ctx.disk = freeGB + ' GB';
    if (Number(freeGB) < 1) recIssue('warn', '校验路径', '目标盘剩余空间偏小', '仅剩 ' + freeGB + ' GB', '建议清理磁盘，避免依赖安装中途失败');
  } catch (e) { /* 老系统不支持 statfs，忽略 */ }

  /* ---------- 3. 环境 ---------- */
  jlog('③ 检测运行环境…', 12, '环境检测');
  const env = {};
  const nodeV = await hasCmd('node', ['-v']); env.node = nodeV;
  const npmV = await hasCmd('npm', ['-v']); env.npm = npmV;
  const gitV = await hasCmd('git', ['--version']); env.git = gitV;
  const pyV = await hasCmd('python', ['--version']); env.python = pyV;
  const goV = await hasCmd('go', ['version']); env.go = goV;
  jlog(`   Node ${nodeV.version || '未安装'} ｜ npm ${npmV.version || '未安装'} ｜ git ${gitV.version || '未安装'}`);
  if (pyV.ok) jlog('   Python ' + pyV.version);
  if (goV.ok) jlog('   Go ' + goV.version);
  job.ctx.env = {
    'Node': nodeV.version || '未安装', 'npm': npmV.version || '未安装',
    'Git': gitV.version || '未安装', 'Python': pyV.version || '',
    'Go': goV.version || '', '系统': process.platform + ' ' + (process.arch || ''),
  };
  if (!nodeV.ok) recIssue('warn', '环境检测', '未检测到 Node.js', '静态站点启动脚本依赖 Node，其他类型不受影响', '如需启动静态站点，请安装 Node.js');
  if (job.cancel.v) throw cancelErr();

  /* ---------- 4. 取源码 ---------- */
  // 暂存目录与包缓存都放到工作目录（默认程序所在盘，不占 C 盘）
  const root = workRoot();
  job.env = childEnv(root);
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(job.env.PIP_CACHE_DIR, { recursive: true });
  fs.mkdirSync(job.env.npm_config_cache, { recursive: true });
  job.ctx.workRoot = root;
  jlog('   临时目录与依赖缓存：' + root + '（不占用 C 盘）', 14);

  const stagingRoot = path.join(root, 'tmp', 'onedeploy_' + Date.now());
  const srcDir = path.join(stagingRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  job.ctx.stagingRoot = stagingRoot;
  jlog('④ 获取源码（' + repo.host + '）…', 16, '获取源码');
  let got = false, usedBranch = branch || 'main';
  if (env.git.ok) {
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push(repo.cloneUrl, srcDir);
    // git 进度很密：只在 0/25/50/75/100% 与关键节点打日志，避免刷屏
    let lastPct = -1;
    const r = await run('git', args, {
      timeout: 120000, idleTimeout: 60000,
      onLine: l => {
        const t = l.trim();
        const pm = t.match(/(\d{1,3})%/);
        if (pm) {
          const pct = Number(pm[1]);
          if (pct === 100 || pct - lastPct >= 25) { lastPct = pct; jlog('   ' + t.slice(0, 80)); }
          return;
        }
        if (/Cloning into|Receiving objects|Resolving deltas|done\./i.test(t)) jlog('   ' + t.slice(0, 80));
      },
    });
    if (r.code === 0) got = true;
    else {
      jlog('   git 拉取失败（' + (r.err || '').split('\n').filter(Boolean).slice(-1)[0] + '），改用 ZIP 下载…');
      recAction('Git 拉取失败，已自动改用 ZIP 下载源码');
      try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch (e) {}
      fs.mkdirSync(srcDir, { recursive: true });
    }
  } else {
    jlog('   未检测到 Git，改用 ZIP 下载…');
    recAction('未安装 Git，已自动改用 ZIP 下载源码');
  }
  if (!got) {
    const tryBranches = branch ? [branch] : ['main', 'master'];
    let lastErr = null;
    for (const b of tryBranches) {
      const zipPath = path.join(stagingRoot, 'src.zip');
      const url = repo.zipUrl.replace('{branch}', encodeURIComponent(b));
      try {
        jlog('   下载 ' + url);
        await download(url, zipPath, 5, p => { if (Math.round(p * 100) % 20 === 0) jlog('   下载进度 ' + Math.round(p * 100) + '%'); });
        const { rootName } = extractZip(zipPath, stagingRoot);
        const inner = path.join(stagingRoot, rootName);
        if (!fs.existsSync(inner)) throw new Error('压缩包解压后没有根目录');
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.renameSync(inner, srcDir);
        usedBranch = b;
        got = true;
        try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
        break;
      } catch (e) { lastErr = e; jlog('   分支 ' + b + ' 下载失败：' + e.message); recAction('分支 ' + b + ' 不可用，自动尝试下一个分支'); }
    }
    if (!got) throw new Error('源码获取失败：' + ((lastErr && lastErr.message) || '请检查网络或仓库是否私有'));
  }
  if (job.cancel.v) throw cancelErr();
  job.ctx.branch = usedBranch;
  jlog('✓ 源码已就绪（分支 ' + usedBranch + '）', 28);

  /* ---------- 5. 识别 + 依赖 + 构建 ---------- */
  const proj = detectProject(srcDir);
  if (proj.type === 'unknown') throw new Error('未能识别项目类型（目录里没有 package.json / requirements.txt / go.mod / index.html）');
  job.ctx.type = proj.type;
  const verdict = detectDeployVerdict(proj, srcDir);
  job.ctx.deployVerdict = verdict;
  jlog('⑤ 项目类型：' + ({ node: 'Node.js', python: 'Python', go: 'Go', php: 'PHP', static: '纯静态站点' }[proj.type] || proj.type)
    + ' ｜ 判定：' + verdict.label + '（' + verdict.reason + '）', 32);

  if (doInstall && proj.hasDeps) {
    jlog('⑥ 安装依赖…', 36, '安装依赖');
    if (proj.type === 'node') {
      const res = await installNodeDeps(srcDir, proj);
      job.ctx.installOk = res.ok;
      if (!res.ok) jlog('   ⚠ 依赖未装齐（' + (res.reason || '见上') + '），继续交付源码，装好依赖即可运行', 48);
    } else if (proj.type === 'python') {
      // Python 的 venv 内是绝对路径，不能在暂存目录装好再复制 —— 改为落位后再建环境
      jlog('   Python 项目：依赖将在写入目标目录后装到 vendor/（隔离环境）', 52);
      job.ctx.pythonDeferred = true;
    } else if (proj.type === 'go') {
      const r = await run('go', ['mod', 'download'], { cwd: srcDir, timeout: 10 * 60 * 1000, idleTimeout: 180000 });
      if (r.code !== 0) throw new Error('go mod download 失败：' + (r.err || '').split('\n').slice(-2).join(' '));
      jlog('✓ Go 依赖下载完成', 52);
    }
  } else if (proj.hasDeps) {
    jlog('⑥ 已跳过依赖安装（按设置）', 52);
  } else {
    jlog('⑥ 无需安装依赖（' + (proj.type === 'static' ? '纯静态站点' : '未发现依赖清单') + '）', 52);
  }

  let built = false;
  if (doBuild && proj.buildCmd && job.ctx.installOk === false) {
    jlog('⑦ 跳过构建：依赖未装齐，构建必然失败（源码已交付）', 60, '构建项目');
    recIssue('warn', '构建项目', '已跳过构建', '依赖未装齐，构建无法进行', '装好依赖后可在目标目录手动构建');
  } else if (doBuild && proj.buildCmd) {
    jlog('⑦ 执行构建：' + proj.buildCmd[0] + ' ' + proj.buildCmd[1].join(' '), 55, '构建项目');
    const r = await run(proj.buildCmd[0], proj.buildCmd[1], { cwd: srcDir, timeout: 15 * 60 * 1000, idleTimeout: 180000, onLine: l => { if (/error|ERR|warn|built|compiled/i.test(l)) jlog('   ' + l.trim()); } });
    if (r.code !== 0) {
      const tail = (r.err || r.out).split('\n').filter(Boolean).slice(-3).join(' ｜ ');
      throw new Error('构建失败（' + proj.buildCmd.join(' ') + '）：' + tail);
    }
    built = true;
    jlog('✓ 构建完成', 68);
  } else if (proj.buildCmd) {
    jlog('⑦ 已跳过构建（按设置），直接部署源码', 68);
  } else {
    jlog('⑦ 无需构建（' + (proj.type === 'static' ? '静态文件直接部署' : '项目未定义 build 脚本') + '）', 68);
  }

  if (job.cancel.v) throw cancelErr();

  /* ---------- 6. 选产物 ---------- */
  const publishDir = (proj.type === 'node' || proj.type === 'static') ? pickPublishDir(srcDir, proj.type) : srcDir;
  const isPublishSub = path.resolve(publishDir) !== path.resolve(srcDir);
  const pubLabel = proj.type === 'static'
    ? (isPublishSub ? '构建产物 ' + path.relative(srcDir, publishDir) : '静态文件（仓库根目录）')
    : proj.type === 'node'
      ? (isPublishSub ? '构建产物 ' + path.relative(srcDir, publishDir) : '源码目录 + 依赖（可直接启动）')
      : '源码目录';
  jlog('⑧ 部署内容：' + pubLabel, 72);

  if (job.cancel.v) throw cancelErr();

  /* ---------- 7. 落位（先备份再覆盖） ---------- */
  jlog('⑨ 写入目标路径：' + target, 76, '写入目标');
  let backup = null;
  const dstEntries = fs.existsSync(target) ? fs.readdirSync(target) : [];
  const dstEmpty = dstEntries.length === 0;

  if (!dstEmpty && mode === 'merge') {
    jlog('   合并模式：保留目标目录已有文件，仅覆盖同名文件', 77);
  } else if (!dstEmpty) {
    // 备份：Windows 下目录可能被资源管理器 / 编辑器 / 杀软短暂占用（EBUSY / EPERM），重试几次
    let backedUp = false, lastErr = null;
    for (let i = 0; i < 3; i++) {
      backup = target + '.bak-' + ts();
      try {
        fs.renameSync(target, backup);
        backedUp = true;
        jlog('   已备份原目录 → ' + backup);
        recAction('目标目录非空，已自动备份为 ' + path.basename(backup));
        fs.mkdirSync(target, { recursive: true });
        break;
      } catch (e) {
        lastErr = e;
        if (i < 2) {
          jlog('   目标目录被占用（' + (e.code || e.message) + '），重试备份…');
          recAction('目标目录被其它程序占用，备份重试中');
          sleepSync(400);
        }
      }
    }
    if (!backedUp) {
      // 兜底：不改名，改为就地合并覆盖（不删除已有文件，也不会因被占用而失败）
      jlog('   目录被占用无法改名备份 → 改为就地合并覆盖（不会删除已有文件）');
      recAction('目标目录被占用（' + ((lastErr && lastErr.code) || '未知') + '），无法改名备份，已改为就地合并覆盖');
      mode = 'merge';
      backup = null;
    }
  } else {
    fs.mkdirSync(target, { recursive: true });
  }

  let copied = 0;
  if (proj.type === 'node' && !isPublishSub) {
    // 服务端项目：源码 + node_modules 一起交付，保证可直接启动
    copied = copyDir(srcDir, target, { skip: new Set(['.git']) });
    if (!fs.existsSync(path.join(target, 'node_modules')) && fs.existsSync(path.join(srcDir, 'node_modules'))) {
      copyDir(path.join(srcDir, 'node_modules'), path.join(target, 'node_modules'), { skip: new Set() });
    }
  } else if (proj.type === 'node' && isPublishSub) {
    copied = copyDir(publishDir, target);
  } else {
    copied = copyDir(publishDir, target, { include: new Set(proj.type === 'python' ? ['.venv'] : []) });
  }
  if (!copied) throw new Error('部署失败：没有文件被写入目标路径');
  jlog('✓ 已写入 ' + copied + ' 个文件', 88);

  /* ---------- 8. 环境收尾（Python 依赖）/ 启动脚本 / 清单 ---------- */
  const startCommand = proj.type === 'node' && proj.startCmd ? proj.startCmd.join(' ') : null;
  const info = {
    name: repo.repo, repo: repo.webUrl, host: repo.host, branch: usedBranch,
    type: proj.type, manager: proj.manager || null, pkgManager: proj.manager || null,
    pkgManagerSource: (proj.managerInfo && proj.managerInfo.source) || '', built, publishFrom: isPublishSub ? path.relative(srcDir, publishDir) : '.',
    deployedAt: new Date().toLocaleString('zh-CN'),
    target, files: countFiles(target), sizeMB: +(dirSize(target) / 1048576).toFixed(2),
    startCommand, backup,
    deployVerdict: job.ctx.deployVerdict || null,
    env: { node: env.node.version || null, npm: env.npm.version || null, git: env.git.version || null, python: env.python.version || null },
  };

  if (proj.type === 'python' && doInstall && !job.cancel.v) {
    const penv = await installPythonEnv(target);
    info.pythonEnv = penv.ok ? (penv.mode || 'vendor') : (penv.blocked ? 'blocked' : (penv.skipped ? 'none' : 'failed'));
    info.pythonWant = suggestPythonVersion(target) || '';
    if (!penv.ok && !penv.skipped) {
      recIssue('warn', '配置 Python 环境', penv.blocked ? '依赖与当前 Python 版本不兼容' : '依赖未装完，源码已就绪',
        penv.reason || '可在目标目录执行 python -m pip install --target vendor -r requirements.txt',
        penv.blocked ? '安装 Python 3.10~3.12 后重试，或在本机手动补齐依赖' : '装好依赖后再运行 启动.bat');
    }
    info.files = countFiles(target);
    info.sizeMB = +(dirSize(target) / 1048576).toFixed(2);
  }

  writeStartScripts(target, info);
  try { fs.writeFileSync(path.join(target, '部署信息.json'), JSON.stringify(info, null, 2), 'utf8'); } catch (e) {}

  /* ---------- 9. 校验 ---------- */
  jlog('⑩ 校验部署结果…', 92, '校验结果');
  const mustHave = proj.type === 'static' ? ['index.html'] : proj.type === 'node' ? ['package.json'] : null;
  if (mustHave) {
    for (const f of mustHave) {
      if (!fs.existsSync(path.join(target, f))) throw new Error('校验失败：目标目录缺少 ' + f + '，部署可能不完整');
    }
  }
  const finalFiles = countFiles(target);
  const finalSize = dirSize(target);
  const warnings = [];
  if (proj.type === 'node' && proj.startCmd && !fs.existsSync(path.join(target, 'node_modules'))) {
    warnings.push('未找到 node_modules，启动前需在目标目录执行 ' + (proj.manager === 'npm' ? 'npm install' : proj.manager + ' install'));
  }
  if (!proj.buildCmd && proj.type === 'node' && !proj.startCmd) warnings.push('项目没有 start/build 脚本，可能需要手动指定启动方式');
  // 汇总阶段内记录过的提示（如依赖未装完），一并回传给界面；跳过“校验结果”自身避免重复
  job.issues.filter(x => x.level === 'warn' && !(x.stage === '校验结果' && x.title === '需要注意')).forEach(x => {
    if (x.detail && !warnings.includes(x.detail)) warnings.push(x.detail);
  });
  warnings.forEach(w => {
    // 已在其它阶段记录过的问题不再重复记一条
    if (!job.issues.some(i => i.detail === w)) recIssue('warn', '校验结果', '需要注意', w, '按提示确认后即可使用');
  });

  // 清理暂存
  try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) {}

  return {
    ok: true, target, root: job.ctx.root || target, folder: job.ctx.folder || path.win32.basename(target),
    type: proj.type, branch: usedBranch, repo: repo.webUrl,
    files: finalFiles, sizeMB: +(finalSize / 1048576).toFixed(2),
    backup, startCommand,
    deployVerdict: job.ctx.deployVerdict || null,
    pythonEnv: info.pythonEnv || null,
    pythonWant: info.pythonWant || '',
    startBat: fs.existsSync(path.join(target, '启动.bat')) ? path.join(target, '启动.bat') : null,
    localUrl: proj.type === 'static' ? 'http://localhost:8080' : null,
    warnings, cost: Math.round((Date.now() - job.startedAt) / 1000),
  };
}

/** 从项目文件里推断作者期望的 Python 版本（.python-version / runtime.txt / Dockerfile / pyproject / README） */
function suggestPythonVersion(dir) {
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return ''; } };
  let m;
  const pv = read('.python-version').trim();
  if ((m = pv.match(/^(\d+\.\d+)/))) return m[1];
  const rt = read('runtime.txt');
  if ((m = rt.match(/python-(\d+\.\d+)/i))) return m[1];
  const df = read('Dockerfile');
  if ((m = df.match(/FROM\s+python:(\d+\.\d+)/i))) return m[1];
  const pp = read('pyproject.toml');
  if ((m = pp.match(/requires-python\s*=\s*["'][^"']*?(\d+\.\d+)/))) return m[1];
  const rd = read('README.md') + read('README_EN.md');
  if ((m = rd.match(/python\s*(?:>=|>|版本)?\s*(3\.(?:[6-9]|1[0-2]))/i))) return m[1];
  return '';
}

/** 读取 requirements.txt 里被版本约束固定的依赖（== / <= / ~=），这些最可能与当前 Python 不兼容 */
function parsePinnedDeps(dir) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8'); } catch (e) { return []; }
  const out = [];
  const re = /^\s*([A-Za-z0-9_.-]+)\s*(===|==|<=|~=)\s*([^\s;#]+)/gm;
  let m;
  while ((m = re.exec(txt))) out.push({ name: m[1], op: m[2], version: m[3] });
  return out;
}

/** 快速核对：被钉死的版本在 PyPI 上有没有匹配当前 Python 的预编译包（几次 JSON 请求即可） */
async function checkPinnedWheels(dir, pyTag) {
  const pins = parsePinnedDeps(dir);
  if (!pins.length) return null;
  const no = String(pyTag || '').replace(/\D/g, '').slice(0, 2);   // 3.13 → 13
  if (!no) return null;
  for (const p of pins.slice(0, 12)) {
    const j = await httpsJson('https://pypi.org/pypi/' + encodeURIComponent(p.name) + '/' + encodeURIComponent(p.version) + '/json', 10000);
    if (!j || !j.urls || !j.urls.length) continue;
    const ok = j.urls.some(u => /\.whl$/i.test(u.filename || '')
      && (/py3-none-any/i.test(u.filename) || new RegExp('cp3' + no).test(u.filename)));
    if (!ok) return { name: p.name, op: p.op, version: p.version };
  }
  return null;
}

/** Python：把依赖装到项目内 vendor/（中文路径安全，不动系统环境，也不依赖 ensurepip） */
async function installPythonEnv(target) {
  const reqFile = path.join(target, 'requirements.txt');
  const pyproject = path.join(target, 'pyproject.toml');
  if (!fs.existsSync(reqFile) && !fs.existsSync(pyproject)) {
    jlog('   没有 requirements.txt / pyproject.toml，跳过依赖安装');
    return { ok: true, skipped: true, mode: 'none' };
  }
  const pipOk = await run('python', ['-m', 'pip', '--version'], { timeout: 30000 });
  if (pipOk.code !== 0) {
    const why = '当前 Python 没有可用的 pip（' + ((pipOk.err || '').split('\n')[0] || '未知') + '）';
    recIssue('warn', '配置 Python 环境', '未检测到 pip', why, '安装 Python 时勾选 pip，或执行 python -m ensurepip --upgrade');
    return { ok: false, reason: why, mode: 'none' };
  }

  jlog('   将依赖安装到项目内 vendor/（隔离，不影响系统 Python）…', 82, '配置 Python 环境');

  // ---- 依赖预检：核对被钉死的版本有没有匹配当前 Python 的预编译包（走 PyPI JSON，快） ----
  jlog('   依赖预检：检查被固定的依赖版本是否适配当前 Python…');
  const pyVer = (job.ctx.env && job.ctx.env.Python) || '';
  const pyTag = (pyVer.match(/(\d+\.\d+)/) || [])[1] || '';
  const bad = await checkPinnedWheels(target, pyTag);
  if (job.cancel.v) throw cancelErr();
  if (bad) {
    const want = suggestPythonVersion(target);
    const cons = bad.name + (bad.op === '==' || bad.op === '===' ? '==' : bad.op) + bad.version;
    const why = cons + ' 没有适用于 Python ' + (pyTag || '当前版本') + ' 的预编译包（版本被固定或尚未支持）'
      + (want ? '；项目自身建议 Python ' + want : '');
    jlog('   ⚠ 预检失败：' + why);
    recIssue('warn', '配置 Python 环境', '依赖与当前 Python 版本不兼容', why,
      want ? '安装 Python ' + want + ' 后重新部署即可（源码已就绪）' : '建议安装 Python 3.10~3.12 后重试；源码已完整部署，补好环境即可运行');
    return { ok: false, blocked: true, mode: 'none', reason: why };
  }
  jlog('   ✓ 预检通过：固定的依赖版本都有可用预编译包');

  try { fs.rmSync(path.join(target, '.pipchk'), { recursive: true, force: true }); } catch (e) {}

  const base = ['-m', 'pip', 'install', '--prefer-binary', '--disable-pip-version-check', '--no-input', '--timeout', '30', '--retries', '2', '--target', 'vendor']
    .concat(fs.existsSync(reqFile) ? ['-r', 'requirements.txt'] : ['.']);
  const mirrors = [
    { name: '清华镜像', args: ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'] },
    { name: '阿里云镜像', args: ['-i', 'https://mirrors.aliyun.com/pypi/simple'] },
    { name: 'PyPI 官方源', args: [] },
  ];
  let r = null, last = '';
  for (let i = 0; i < mirrors.length; i++) {
    if (job.cancel.v) throw cancelErr();
    const m = mirrors[i];
    if (i > 0) {
      jlog('   ' + mirrors[i - 1].name + ' 失败，改用' + m.name + '…');
      recAction(mirrors[i - 1].name + '安装失败，已自动切换' + m.name);
    }
    jlog('   使用' + m.name + '安装依赖（首次较慢，请耐心等）…');
    r = await run('python', base.concat(m.args), {
      cwd: target, timeout: 15 * 60 * 1000, idleTimeout: 300000,
      heartbeat: s => jlog('   …仍在安装（已 ' + s + ' 秒，下载/编译较慢，请继续等待，不要取消）'),
      onLine: l => {
        const t = l.trim();
        if (/^(Collecting|Downloading|Installing|Successfully|ERROR|error)/i.test(t)) jlog('     ' + t.slice(0, 110));
      },
    });
    if (r.code === 0) break;
    last = (r.err || r.out || '').split('\n').filter(Boolean).slice(-2).join(' ');
    // 这类错误换镜像也没用（缺编译工具 / 无对应轮子），直接停
    if (/pg_config|Microsoft Visual C\+\+|Failed building wheel|subprocess-exited-with-error|requires? a compiler/i.test(r.err || r.out || '')) {
      jlog('   依赖需要本机编译环境，换镜像无效，停止重试');
      const raw = (r.err || '') + '\n' + (r.out || '');
      const pkgName = (raw.match(/Failed to build '([^']+)'/) || [])[1]
        || (raw.match(/Collecting ([A-Za-z0-9_.-]+)/) || [])[1] || '该依赖';
      const need = /pg_config/i.test(raw) ? 'PostgreSQL 开发库（pg_config）' : 'C++ 编译工具（Visual Studio Build Tools）';
      last = pkgName + ' 需要本机编译环境：缺少 ' + need;
      break;
    }
  }
  if (job.cancel.v) throw cancelErr();
  if (r.code !== 0) {
    recIssue('warn', '配置 Python 环境', '依赖安装未完成（源码已就绪）', String(last || '').slice(0, 300),
      '在目标目录执行 python -m pip install --target vendor -r requirements.txt 补齐后即可运行');
    return { ok: false, reason: last, mode: 'vendor' };
  }
  jlog('✓ Python 依赖已装到 vendor/', 90);
  return { ok: true, mode: 'vendor' };
}

/* --------------------------------------------------------------- API */

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(Buffer.from(JSON.stringify(obj), 'utf8'));
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

function pushHistory(entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr.unshift(entry);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(0, 50), null, 2), 'utf8'); } catch (e) {}
}

async function handle(req, res, url) {
  const p = url.pathname;

  if (p === '/api/localdeploy/resolve' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await resolveInput(body.input));
  }

  if (p === '/api/localdeploy/checkpath' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, checkTarget(body.path));
  }

  if (p === '/api/localdeploy/pickfolder' && req.method === 'POST') {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
      '$d.Description = "选择部署目标文件夹"; $d.ShowNewFolderButton = $true; ' +
      'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }';
    const r = await run('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120000 });
    const picked = (r.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    return sendJson(res, 200, { ok: Boolean(picked), path: picked });
  }

  if (p === '/api/localdeploy/start' && req.method === 'POST') {
    if (job.running) return sendJson(res, 409, { ok: false, error: '已有部署任务进行中' });
    const body = await readBody(req);
    const chk = checkTarget(body.target);
    if (!chk.ok) return sendJson(res, 200, { ok: false, stage: '校验路径', error: chk.error });
    if (!String(body.input || '').trim()) return sendJson(res, 200, { ok: false, stage: '解析项目', error: '请输入项目名称或仓库网址' });
    resetJob();
    pipeline(Object.assign({}, body, { target: chk.path }))
      .then(r => {
        if (job.cancel.v || job.status === 'cancelled') return;
        jdone(r);
        pushHistory({
          time: new Date().toLocaleString('zh-CN'), target: r.target, repo: r.repo,
          type: r.type, files: r.files, sizeMB: r.sizeMB, status: 'success', cost: r.cost,
          issues: (job.issues || []).length, warnings: (job.issues || []).filter(x => x.level === 'warn').length,
        });
      })
      .catch(e => {
        const stage = job.stage;
        try { if (job.ctx.stagingRoot) fs.rmSync(job.ctx.stagingRoot, { recursive: true, force: true }); } catch (err) {}
        if (!(e && e.code === 'CANCELLED') && !job.cancel.v) jfail(e, stage);
        else jcancel();
        pushHistory({
          time: new Date().toLocaleString('zh-CN'), target: chk.path, repo: String(body.input || ''),
          type: '', files: 0, sizeMB: 0, status: job.status === 'cancelled' ? 'cancelled' : 'failed',
          error: job.error, stage, issues: (job.issues || []).length,
        });
      });
    return sendJson(res, 200, { ok: true, jobId: job.id });
  }

  if (p === '/api/localdeploy/job' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true, id: job.id, running: job.running, status: job.status,
      percent: job.percent, stage: job.stage, error: job.error, result: job.result,
      logs: job.logs.slice(-400),
      issueCounts: {
        error: job.issues.filter(x => x.level === 'error').length,
        warn: job.issues.filter(x => x.level === 'warn').length,
      },
      hasSummary: Boolean(job.summary),
    });
  }

  if (p === '/api/localdeploy/cancel' && req.method === 'POST') {
    job.cancel.v = true;
    try {
      if (job.child && job.child.pid) {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else job.child.kill('SIGKILL');
      }
    } catch (e) {}
    jlog('⛔ 已取消本次部署');
    jcancel();
    return sendJson(res, 200, { ok: true, status: 'cancelled' });
  }

  // 停止所有部署：取消当前任务 + 清残留进程 + 清暂存目录
  if (p === '/api/localdeploy/stop-all' && req.method === 'POST') {
    const report = { cancelled: false, killed: [], stagingRemoved: [], errors: [] };

    // ① 取消当前部署任务
    job.cancel.v = true;
    try {
      if (job.child && job.child.pid) {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else job.child.kill('SIGKILL');
        report.cancelled = true;
      }
    } catch (e) { report.errors.push('kill child: ' + e.message); }
    if (job.running) { jlog('⏹ 已停止当前部署任务'); jcancel(); report.cancelled = true; }

    // ② 扫描并终止残留的 npm / git / node 子进程（命令行含 deploy_cache 或 onedeploy）
    if (process.platform === 'win32') {
      try {
        const r = spawn('powershell', ['-NoProfile', '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "deploy_cache|onedeploy" -and $_.Name -match "node|npm|git|cmd" } | Select-Object ProcessId,Name | ConvertTo-Json'
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
        const out = await new Promise(resolve => {
          let d = ''; r.stdout.on('data', c => d += c);
          r.on('close', () => resolve(d));
          setTimeout(() => resolve(d), 8000);
        });
        let procs = [];
        try { procs = JSON.parse(out || '[]'); if (!Array.isArray(procs)) procs = [procs]; } catch (e) {}
        for (const pr of procs) {
          if (!pr || !pr.ProcessId) continue;
          try {
            spawn('taskkill', ['/PID', String(pr.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            report.killed.push({ pid: pr.ProcessId, name: pr.Name });
          } catch (e) { report.errors.push('kill ' + pr.ProcessId + ': ' + e.message); }
        }
      } catch (e) { report.errors.push('scan: ' + e.message); }
    }

    // ③ 清理暂存目录（onedeploy_*）
    try {
      const tmpRoot = path.join(workRoot(), 'tmp');
      if (fs.existsSync(tmpRoot)) {
        for (const d of fs.readdirSync(tmpRoot)) {
          if (!d.startsWith('onedeploy_')) continue;
          try {
            fs.rmSync(path.join(tmpRoot, d), { recursive: true, force: true });
            report.stagingRemoved.push(d);
          } catch (e) { report.errors.push('rm ' + d + ': ' + e.message); }
        }
      }
    } catch (e) { report.errors.push('staging: ' + e.message); }

    const n = report.killed.length;
    jlog('⏹ 停止所有部署完成：' + (report.cancelled ? '已取消当前任务' : '无运行任务') + (n ? '，清理 ' + n + ' 个残留进程' : '') + (report.stagingRemoved.length ? '，删除 ' + report.stagingRemoved.length + ' 个暂存目录' : ''));
    return sendJson(res, 200, Object.assign({ ok: true }, report));
  }

  if (p === '/api/localdeploy/install-deps' && req.method === 'POST') {
    const body = await readBody(req);
    const dir = String(body.path || '').trim();
    if (!dir || !fs.existsSync(dir)) return sendJson(res, 200, { ok: false, error: '目标目录不存在：' + dir });
    if (job.running) return sendJson(res, 409, { ok: false, error: '已有任务进行中' });
    resetJob();
    job.env = childEnv(workRoot());
    job.ctx.target = dir;
    job.ctx.type = 'python';
    (async () => {
      const v = await run('python', ['-c', 'import sys;print("Python", sys.version.split()[0])'], { timeout: 30000 });
      job.ctx.env = { Python: (v.out || '').trim() || 'Python' };
      jlog('开始补装依赖：' + dir, 5, '补装依赖');
      const r = await installPythonEnv(dir);
      let info = {};
      try { info = JSON.parse(fs.readFileSync(path.join(dir, '部署信息.json'), 'utf8')); } catch (e) { info = {}; }
      info.target = dir; info.pythonWant = suggestPythonVersion(dir) || info.pythonWant || '';
      writeStartScripts(dir, info);
      if (r.ok) { jlog('✓ 依赖已就绪（' + (r.mode || 'vendor') + '），可双击 启动.bat 运行', 100, '完成'); jdone({ ok: true, target: dir, mode: r.mode }); }
      else { jfail(new Error(r.reason || '依赖安装失败'), '补装依赖'); }
    })().catch(e => jfail(e, '补装依赖'));
    return sendJson(res, 200, { ok: true, jobId: job.id });
  }

  if (p === '/api/localdeploy/history' && req.method === 'GET') {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { arr = []; }
    return sendJson(res, 200, { ok: true, history: Array.isArray(arr) ? arr : [] });
  }

  if (p === '/api/localdeploy/summary' && req.method === 'GET') {
    let sm = job.summary;
    if (!sm) {
      try { sm = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'deploy_issues', 'latest.json'), 'utf8')); } catch (e) { sm = null; }
    }
    if (!sm) return sendJson(res, 200, { ok: false, error: '还没有可用的部署总结', summary: null });
    return sendJson(res, 200, { ok: true, summary: sm, markdown: summaryToMarkdown(sm) });
  }

  if (p === '/api/localdeploy/summary/save' && req.method === 'POST') {
    const body = await readBody(req);
    let sm = job.summary;
    if (!sm) {
      try { sm = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'deploy_issues', 'latest.json'), 'utf8')); } catch (e) { sm = null; }
    }
    if (!sm) return sendJson(res, 200, { ok: false, error: '没有可保存的总结' });
    const dir = body.path && fs.existsSync(body.path) ? body.path : path.join(DATA_DIR, 'deploy_issues');
    const name = '问题总结_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16).replace('T', '_') + '.md';
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, summaryToMarkdown(sm), 'utf8');
      return sendJson(res, 200, { ok: true, file });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === '/api/localdeploy/open' && req.method === 'POST') {
    const body = await readBody(req);
    const t = String(body.path || '');
    if (!t || !fs.existsSync(t)) return sendJson(res, 200, { ok: false, error: '路径不存在：' + t });

    // 用 cmd start 打开（比直接 spawn explorer 更稳），失败再退回 explorer.exe
    let opened = false, how = '';
    try {
      const c1 = spawn('cmd', ['/c', 'start', '', 'explorer.exe', t], { windowsHide: true, detached: true, stdio: 'ignore' });
      c1.unref();
      opened = true; how = 'cmd start explorer';
    } catch (e1) {
      try {
        const c2 = spawn('explorer.exe', [t], { windowsHide: true, detached: true, stdio: 'ignore' });
        c2.unref();
        opened = true; how = 'explorer.exe';
      } catch (e2) {
        return sendJson(res, 200, { ok: false, error: '系统拒绝打开资源管理器：' + e2.message });
      }
    }
    return sendJson(res, 200, { ok: opened, how, path: t });
  }

  if (p === '/api/localdeploy/launch' && req.method === 'POST') {
    const body = await readBody(req);
    const t = String(body.path || '');
    const bat = path.join(t, '启动.bat');
    if (!t || !fs.existsSync(bat)) {
      return sendJson(res, 200, { ok: false, error: '目标目录里没有 启动.bat（可能部署未完成）' });
    }
    try {
      // /D 指定工作目录，保证 bat 里的相对路径正确；新窗口运行，便于看日志
      const c = spawn('cmd', ['/c', 'start', '', '/D', t, bat], { detached: true, stdio: 'ignore', windowsHide: false });
      c.unref();
      return sendJson(res, 200, { ok: true, how: 'cmd start bat' });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在：' + p });
}

module.exports = { handle, checkTarget, parseRepo, resolveInput, run };
