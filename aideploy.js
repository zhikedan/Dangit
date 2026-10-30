'use strict';
/* ============================================================================
   AI 部署模块
   —— 表单（项目名/仓库网址 + 本地绝对路径）→ 调用 DeepSeek Harness CLI
      `dsh headless --json -`（任务走 stdin，避免 Windows 引号问题）
   —— 把 CLI 的 NDJSON 事件流翻译成可读日志，前端轮询 /job 展示
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const E = require('./engine');

const APP_DIR = __dirname;

/* ------------------------------------------------------------------ CLI 发现 */

function cliCandidates() {
  const list = [];
  const cfg = (E.loadConfig() || {}).ai_deploy || {};
  if (cfg.cli) list.push(String(cfg.cli));
  if (process.env.DSH_CLI) list.push(process.env.DSH_CLI);
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  const tail = path.join('DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  for (const base of [la, path.join(la, 'Programs'), pf, pfx86, pd]) {
    if (base) list.push(path.join(base, tail));
  }
  // 本机的用户数据目录可能被挪到了其它盘（如 E:\Users\<user>\AppData\Local），逐盘探测
  const user = path.basename(os.homedir());
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    list.push(path.join(drive + ':\\Users', user, 'AppData', 'Local', 'Programs', tail));
    list.push(path.join(drive + ':\\Users', user, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  }
  // 兜底：PATH 里的 dsh
  try {
    const w = spawnSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    for (const line of String((w && w.stdout) || '').split(/\r?\n/)) {
      if (line.trim()) list.push(line.trim());
    }
  } catch (e) { /* ignore */ }
  return [...new Set(list.filter(Boolean))];
}

function findCli() {
  for (const p of cliCandidates()) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  return '';
}

/* --------------------------------------------------------------- 路径校验 */

const FORBIDDEN_TARGETS = [
  /^[a-z]:\\?$/i,
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\system volume information/i,
  /^[a-z]:\\\$recycle\.bin/i,
  /^[a-z]:\\users\\[^\\]+\\?$/i,
];

function checkTarget(input) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return { ok: false, error: '请填写本地文件夹绝对路径' };
  const isAbs = /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\/.test(raw);
  if (!isAbs) return { ok: false, error: '必须是绝对路径，例如 E:\\pc\\桌面\\deploy-demo' };
  let p;
  try { p = path.resolve(raw); } catch (e) { return { ok: false, error: '路径无法解析' }; }
  for (const re of FORBIDDEN_TARGETS) {
    if (re.test(p)) return { ok: false, error: '为了安全，请勿把系统目录或盘符根目录作为部署目标' };
  }
  let exists = false;
  let nonEmpty = false;
  try {
    if (fs.existsSync(p)) {
      exists = true;
      const st = fs.statSync(p);
      if (!st.isDirectory()) return { ok: false, error: '该路径已存在且不是文件夹' };
      nonEmpty = fs.readdirSync(p).length > 0;
    }
  } catch (e) { /* ignore */ }
  return { ok: true, path: p, exists, nonEmpty };
}

/* ------------------------------------------------------------------ 任务状态 */

let seq = 1;
const job = {
  id: null, running: false, status: 'idle', percent: 0, stage: '',
  logs: [], error: null, result: null,
  cancel: { v: false }, child: null, startedAt: 0, sessionId: '', finalText: '',
  project: '', target: '', steps: 0, killedByTimeout: false,
};

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function jlog(msg) {
  const text = String(msg == null ? '' : msg);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    job.logs.push('[' + ts() + '] ' + line);
  }
  if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
  console.log('[aideploy] ' + text.split('\n')[0]);
}

function resetJob(project, target) {
  job.id = 'ai_' + (seq++) + '_' + Date.now();
  job.running = true;
  job.status = 'running';
  job.percent = 3;
  job.stage = '准备中…';
  job.logs = [];
  job.error = null;
  job.result = null;
  job.cancel = { v: false };
  job.child = null;
  job.startedAt = Date.now();
  job.sessionId = '';
  job.finalText = '';
  job.project = project;
  job.target = target;
  job.steps = 0;
  job.killedByTimeout = false;
  job.dir = null;
}

function finish(status, extra) {
  job.running = false;
  job.status = status;
  if (status === 'done') job.percent = 100;
  Object.assign(job, extra || {});
}

/* ------------------------------------------------------------- 事件流 → 日志 */

function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const type = String(ev.type || '');
  if (type === 'session') {
    job.sessionId = ev.sessionId || '';
    job.percent = Math.max(job.percent, 8);
    job.stage = '会话已创建';
    jlog('🧠 已连接 DeepSeek Harness（会话 ' + (job.sessionId || '?') + '）');
    if (ev.cwd) jlog('   工作目录：' + ev.cwd);
    return;
  }
  if (type === 'status') {
    const phase = String(ev.phase || '');
    if (phase === 'turn_start') {
      job.stage = 'AI 开始执行';
      job.percent = Math.max(job.percent, 12);
      jlog('▶ 任务开始（turn ' + (ev.turn || 1) + '）');
    } else if (phase === 'step_start') {
      job.steps++;
      job.percent = Math.min(92, 14 + job.steps * 4);
      job.stage = '执行第 ' + job.steps + ' 步';
      jlog('· 第 ' + job.steps + ' 步…');
    } else if (phase === 'turn_end') {
      const reason = ev.reason || {};
      if (reason.kind === 'error' && reason.error) {
        jlog('❌ ' + (reason.error.message || '模型调用失败'));
        if (/MISSING_CREDENTIAL|no API key/i.test(String(reason.error.message || ''))) {
          job.error = 'DeepSeek Harness 未配置模型 API Key：请在 Harness 的 Models 页面配置，或在启动环境里设置 DEEPSEEK_API_KEY';
        }
      }
    }
    return;
  }
  if (type === 'final') {
    job.finalText = String(ev.text || '').trim();
    if (job.finalText) {
      job.percent = Math.max(job.percent, 96);
      job.stage = 'AI 已输出结果';
      jlog('✔ AI 已输出部署报告');
    }
    return;
  }
  // 其它事件：尽量提炼成人话，避免把整包 JSON 糊到界面上
  if (type === 'message' || type === 'assistant' || type === 'text') {
    const text = typeof ev.text === 'string' ? ev.text : (ev.message && ev.message.content) || '';
    const s = String(text || '').trim();
    if (s) jlog('💬 ' + s.slice(0, 400));
    return;
  }
  if (type === 'tool_call' || type === 'tool' || type === 'tool_use') {
    const name = ev.name || ev.tool || (ev.tool && ev.tool.name) || '工具';
    jlog('🔧 调用工具：' + name);
    return;
  }
  if (type === 'tool_result') {
    const ok = ev.ok !== false;
    jlog((ok ? '   ↳ 完成' : '   ↳ 失败') + (ev.error ? '：' + String(ev.error).slice(0, 200) : ''));
    return;
  }
  // 未知类型：只记录一行摘要
  const brief = JSON.stringify(ev);
  if (brief && brief !== '{}') jlog('· ' + brief.slice(0, 240));
}

/* ------------------------------------------------------------------- 启动 */

/**
 * 部署子进程环境：
 * - DEEPSEEK_API_KEY：优先 ai_deploy.api_key；若报告引擎本身就是 DeepSeek，复用它
 * - DSH_PERMISSION_MODE：headless 默认 approval=ask，没有界面应答会卡死；
 *   部署必须能写目标目录 / 装依赖 / 执行命令，所以默认 danger-full-access（可在配置里改）
 */
function buildDeployEnv(rootCfg, aiCfg, keyOverride) {
  const env = Object.assign({}, process.env);
  if (aiCfg.dsh_home) env.DSH_HOME = String(aiCfg.dsh_home);
  const deepseekBase = /deepseek/i.test(String(rootCfg.api_base || ''));
  const key = String(keyOverride || aiCfg.api_key || (deepseekBase ? rootCfg.api_key : '') || '').trim();
  if (key) env.DEEPSEEK_API_KEY = key;
  env.DSH_PERMISSION_MODE = String(aiCfg.permission_mode || 'danger-full-access');
  return env;
}

/** 把模型侧错误翻译成人话（保留原始信息便于排查） */
function friendlyModelError(msg) {
  const s = String(msg || '').trim();
  if (!s) return '';
  if (/Authentication Fails|invalid api key|incorrect api key|401|unauthorized/i.test(s)) {
    return 'Key 无效或已失效（请重新复制 DeepSeek API Key）：' + s;
  }
  if (/insufficient|balance|quota|exceeded|402|余额|额度/i.test(s)) {
    return '账户余额/额度不足：' + s;
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(s)) {
    return '网络连接失败（检查代理/DNS）：' + s;
  }
  if (/model|not found|404/i.test(s)) return '模型不可用：' + s;
  return s;
}

/** 跑一次 headless（用临时脚本 + 文件输出），返回 { ok, reply, error, ms } */
function runHeadlessOnce(prompt, env, timeoutMs) {
  return new Promise((resolve) => {
    const cli = findCli();
    if (!cli) return resolve({ ok: false, error: '未找到 DeepSeek Harness CLI（dsh.cmd）' });
    const dir = path.join(APP_DIR, 'data', 'ai_deploy', 'test_' + Date.now());
    const promptFile = path.join(dir, 'prompt.txt');
    const outFile = path.join(dir, 'out.ndjson');
    const errFile = path.join(dir, 'err.log');
    const batFile = path.join(dir, 'run.cmd');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(promptFile, prompt, 'utf8');
      fs.writeFileSync(outFile, '');
      fs.writeFileSync(errFile, '');
      fs.writeFileSync(batFile, [
        '@echo off',
        'chcp 65001 >nul',
        `"${cli}" headless --json - < "${promptFile}" > "${outFile}" 2> "${errFile}"`,
        '',
      ].join('\r\n'), 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: '准备测试文件失败：' + e.message });
    }

    let child;
    try {
      child = spawn('cmd.exe', ['/d', '/s', '/c', batFile], { env, windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return resolve({ ok: false, error: '启动 dsh 失败：' + e.message });
    }

    const started = Date.now();
    let settled = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      let out = '';
      let err = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* ignore */ }
      try { err = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      let reply = '';
      let errMsg = '';
      for (const line of out.split(/\r?\n/)) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(s); } catch (e) { continue; }
        if (ev.type === 'final') reply = String(ev.text || '').trim();
        if (ev.type === 'status' && ev.reason && ev.reason.kind === 'error' && ev.reason.error) {
          errMsg = String(ev.reason.error.message || ev.reason.error.code || '');
        }
      }
      if (timedOut) return resolve({ ok: false, error: '测试超时（' + Math.round(timeoutMs / 1000) + 's），请检查网络或 Harness 状态', ms });
      if (/MISSING_CREDENTIAL|no API key/i.test(err + errMsg)) {
        return resolve({ ok: false, error: '没有可用的模型 Key：请在下方填入 DeepSeek API Key 后重试', ms });
      }
      if (errMsg) return resolve({ ok: false, error: friendlyModelError(errMsg.replace(/^llm-[^:]+:\s*/i, '')), ms });
      const tail = (err || '').trim().split('\n').slice(-2).join('\n');
      if (!reply) return resolve({ ok: false, error: friendlyModelError(tail) || '未收到模型回复（退出码 ' + (child.exitCode == null ? '?' : child.exitCode) + '）', ms });
      return resolve({ ok: true, reply, ms });
    };

    const timer = setTimeout(() => {
      try {
        if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch (e) { /* ignore */ }
      finish(true);
    }, timeoutMs);

    child.on('close', () => setTimeout(() => finish(false), 300));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err2) { /* ignore */ }
      resolve({ ok: false, error: '启动失败：' + e.message });
    });
  });
}

function buildPrompt(project, target, info) {
  return [
    '你是一名 Windows 本地部署工程师。现在要把一个开源项目自动部署到本机，请直接动手完成，不要反问。',
    '',
    '【项目】' + project,
    '【部署目标（绝对路径）】' + target,
    '【目标现状】' + (info.exists ? (info.nonEmpty ? '目录已存在且非空' : '目录已存在但为空') : '目录不存在（需要创建）'),
    '',
    '执行要求：',
    '1. 项目可能是完整网址（https://github.com/owner/repo）、owner/repo，或只有项目名；只有名称时先搜索并选最匹配的仓库。',
    '2. 目标目录不存在就创建；如果已存在且非空，改为在其下新建以项目名命名的子目录，绝对不能删除或覆盖用户已有文件。',
    '3. 用 git clone --depth 1 获取源码；失败时再尝试下载 ZIP 或使用镜像站点。',
    '4. 识别项目类型（Node / Python / Go / Rust / 静态站点 / Docker），安装依赖并构建；纯静态站点直接落位即可。',
    '5. 尽量启动并验证服务（端口被占用就换一个），最后给出访问地址或启动命令。',
    '6. 不要执行破坏性命令：不删除目标目录以外的文件，不改系统设置，不格式化磁盘。',
    '7. 结束时用中文输出简明报告，包含：仓库地址、部署目录、项目类型、安装/构建命令、启动命令、访问地址、验证结果、遇到的问题与建议。',
  ].join('\n');
}

function readFrom(file, startPos) {
  try {
    const b = fs.readFileSync(file);
    return b.length > startPos ? b.slice(startPos) : Buffer.alloc(0);
  } catch (e) { return Buffer.alloc(0); }
}

function start(project, target, info) {
  const cli = findCli();
  if (!cli) {
    const e = new Error('未找到 DeepSeek Harness CLI（dsh.cmd）。请确认已安装 DeepSeek Harness，或在 config.json 的 ai_deploy.cli 指定完整路径。');
    e.code = 'NO_CLI';
    throw e;
  }
  const prompt = buildPrompt(project, target, info);
  const rootCfg = E.loadConfig() || {};
  const cfg = rootCfg.ai_deploy || {};
  const env = buildDeployEnv(rootCfg, cfg);

  const workdir = info.exists ? target : (fs.existsSync(path.dirname(target)) ? path.dirname(target) : APP_DIR);

  // 用「临时文件 + 轮询」拿输出：避免 Windows 管道/编码问题，也能实时看到进度
  const dir = path.join(APP_DIR, 'data', 'ai_deploy', job.id);
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, 'prompt.txt');
  const outFile = path.join(dir, 'out.ndjson');
  const errFile = path.join(dir, 'err.log');
  const batFile = path.join(dir, 'run.cmd');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(errFile, '');
  fs.writeFileSync(batFile, [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${workdir}"`,
    `"${cli}" headless --json - < "${promptFile}" > "${outFile}" 2> "${errFile}"`,
    '',
  ].join('\r\n'), 'utf8');
  job.dir = dir;

  jlog('🤖 启动 DeepSeek Harness：' + cli);
  jlog('   项目：' + project);
  jlog('   目标：' + target);
  jlog('   工作目录：' + workdir);

  let child;
  try {
    child = spawn('cmd.exe', ['/d', '/s', '/c', batFile], {
      cwd: workdir, env, windowsHide: true, stdio: 'ignore',
    });
  } catch (e) {
    e.code = e.code || 'SPAWN_FAIL';
    throw new Error('启动 DeepSeek Harness 失败：' + e.message);
  }
  job.child = child;
  job.percent = 6;
  job.stage = '等待 Harness 响应';

  let outPos = 0;
  let errPos = 0;
  let outRest = Buffer.alloc(0);
  let errRest = Buffer.alloc(0);
  let stderrTail = '';
  let finalized = false;
  let exitCode = null;
  let timer = null;
  let pumpTimer = null;

  function processOutLine(line) {
    const trimmed = String(line || '').replace(/\r$/, '').trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{')) {
      try { handleEvent(JSON.parse(trimmed)); } catch (e) { jlog(trimmed.slice(0, 300)); }
    } else {
      jlog(trimmed);
    }
  }

  function pump() {
    const ob = readFrom(outFile, outPos);
    outPos += ob.length;
    if (ob.length) {
      outRest = Buffer.concat([outRest, ob]);
      let idx;
      while ((idx = outRest.indexOf(0x0a)) >= 0) {
        const line = outRest.slice(0, idx).toString('utf8');
        outRest = outRest.slice(idx + 1);
        processOutLine(line);
      }
    }
    const eb = readFrom(errFile, errPos);
    errPos += eb.length;
    if (eb.length) {
      errRest = Buffer.concat([errRest, eb]);
      let idx;
      while ((idx = errRest.indexOf(0x0a)) >= 0) {
        const line = errRest.slice(0, idx).toString('utf8').trim();
        errRest = errRest.slice(idx + 1);
        if (!line) continue;
        stderrTail = (stderrTail + '\n' + line).slice(-2000);
        jlog('⚠ ' + line.slice(0, 300));
      }
    }
  }

  function cleanup(success) {
    clearInterval(pumpTimer);
    if (timer) clearTimeout(timer);
    try {
      if (success) fs.rmSync(dir, { recursive: true, force: true });
      else if (job.dir) jlog('ℹ 排错文件保留在：' + dir);
    } catch (e) { /* ignore */ }
  }

  function finalize() {
    if (finalized) return;
    finalized = true;
    pump();
    if (outRest.length) { processOutLine(outRest.toString('utf8')); outRest = Buffer.alloc(0); }
    if (errRest.length) {
      const s = errRest.toString('utf8').trim();
      if (s) { stderrTail = (stderrTail + '\n' + s).slice(-2000); jlog('⚠ ' + s.slice(0, 300)); }
      errRest = Buffer.alloc(0);
    }
    if (!job.running) { cleanup(true); return; }   // 已取消 / 超时
    if (job.cancel.v) {
      jlog('⛔ 已取消本次 AI 部署');
      cleanup(true);
      finish('cancelled', { stage: '已取消', error: '用户取消了本次 AI 部署' });
      return;
    }
    const ok = exitCode === 0 && Boolean(job.finalText);
    if (ok) {
      jlog('✅ AI 部署流程结束（exit 0）');
      cleanup(true);
      finish('done', {
        stage: '完成',
        result: {
          ok: true,
          project: job.project,
          target: job.target,
          sessionId: job.sessionId,
          text: job.finalText.slice(0, 20000),
          costSec: Math.round((Date.now() - job.startedAt) / 1000),
        },
      });
      return;
    }
    let err = job.error || '';
    if (!err) {
      if (/MISSING_CREDENTIAL|no API key/i.test(stderrTail)) {
        err = 'DeepSeek Harness 未配置模型 API Key：请在「⚙ 配置」里填写 DeepSeek Key（或用 key 测试确认可用）。';
      } else if (stderrTail.trim()) {
        err = friendlyModelError(stderrTail.trim().split('\n').slice(-3).join('\n'));
      } else {
        err = 'AI 部署未完成（exit ' + exitCode + '），未收到结果。';
      }
    }
    jlog('❌ ' + err);
    cleanup(false);
    finish('error', {
      stage: job.killedByTimeout ? '超时终止' : '未完成',
      error: err,
      result: job.finalText ? { ok: false, text: job.finalText.slice(0, 8000), partial: true } : null,
    });
  }

  pumpTimer = setInterval(pump, 450);

  child.on('error', (e) => {
    clearInterval(pumpTimer);
    if (timer) clearTimeout(timer);
    jlog('❌ 进程错误：' + e.message);
    finish('error', { stage: '启动失败', error: e.message });
  });

  child.on('close', (code) => {
    exitCode = typeof code === 'number' ? code : -1;
    setTimeout(finalize, 500);   // 等最后几行输出落盘
  });

  const HARD_TIMEOUT = 45 * 60 * 1000;
  timer = setTimeout(() => {
    if (!job.running) return;
    job.killedByTimeout = true;
    jlog('⏱ 超过 45 分钟仍未完成，已终止。');
    killTree();
  }, HARD_TIMEOUT);
}

function killTree() {
  job.cancel.v = true;
  const child = job.child;
  if (child && child.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch (e) { /* ignore */ }
  }
  if (job.running) {
    finish('cancelled', { stage: '已取消', error: job.killedByTimeout ? '超过 45 分钟，已自动终止' : '用户取消了本次 AI 部署' });
  }
}

/* --------------------------------------------------------------------- API */

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

async function handle(req, res, url) {
  const p = url.pathname;

  if (p === '/api/aideploy/status' && req.method === 'GET') {
    const cli = findCli();
    const rootCfg = E.loadConfig() || {};
    const cfg = rootCfg.ai_deploy || {};
    const key = String(cfg.api_key || '').trim();
    return sendJson(res, 200, {
      ok: true,
      cliFound: Boolean(cli),
      cli: cli || '',
      dshHome: cfg.dsh_home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      hasKey: Boolean(key),
      maskedKey: key ? ('••••' + key.slice(-4)) : '',
      busy: job.running,
    });
  }

  // 读取「AI 部署」的配置（Key 只返回掩码，不下发明文）
  if (p === '/api/aideploy/config' && req.method === 'GET') {
    const cli = findCli();
    const rootCfg = E.loadConfig() || {};
    const cfg = rootCfg.ai_deploy || {};
    const key = String(cfg.api_key || '').trim();
    return sendJson(res, 200, {
      ok: true,
      hasKey: Boolean(key),
      maskedKey: key ? ('••••' + key.slice(-4)) : '',
      cli: cli || '',
      cliFound: Boolean(cli),
      dshHome: cfg.dsh_home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      permissionMode: cfg.permission_mode || 'danger-full-access',
    });
  }

  // 测试模型 Key：真的跑一次 headless（只回复两个字），验证 Key/网络/模型是否可用
  if (p === '/api/aideploy/test-key' && req.method === 'POST') {
    const body = await readBody(req);
    const rootCfg = E.loadConfig() || {};
    const cfg = rootCfg.ai_deploy || {};
    const override = String(body.api_key || '').trim();
    const saved = String(cfg.api_key || '').trim();
    if (!override && !saved && !(rootCfg.api_base && /deepseek/i.test(String(rootCfg.api_base)) && rootCfg.api_key)) {
      return sendJson(res, 200, { ok: false, error: '还没有可测试的 Key：请先填入 DeepSeek API Key' });
    }
    const env = buildDeployEnv(rootCfg, cfg, override || saved);
    const r = await runHeadlessOnce('这是一次连通性测试：请只回复两个字「正常」，不要调用任何工具。', env, 90000);
    return sendJson(res, 200, r);
  }

  // 保存「AI 部署」专用模型 Key（仅存本机 config.json，调用时以 DEEPSEEK_API_KEY 传给 dsh）
  if (p === '/api/aideploy/config' && req.method === 'POST') {
    const body = await readBody(req);
    const rootCfg = E.loadConfig() || {};
    const next = Object.assign({}, rootCfg);
    const ai = Object.assign({}, next.ai_deploy || {});
    if (body.api_key !== undefined) {
      const key = String(body.api_key || '').trim();
      if (key && !/^[\x21-\x7e]+$/.test(key)) {
        return sendJson(res, 200, { ok: false, error: 'API Key 只能包含可见 ASCII 字符（不能有空格/中文）' });
      }
      ai.api_key = key;
    }
    if (body.dsh_home !== undefined) ai.dsh_home = String(body.dsh_home || '').trim();
    if (body.cli !== undefined) ai.cli = String(body.cli || '').trim();
    if (body.permission_mode !== undefined) {
      const mode = String(body.permission_mode || '').trim();
      if (!['danger-full-access', 'workspace-write', 'read-only'].includes(mode)) {
        return sendJson(res, 200, { ok: false, error: '权限模式只能是 danger-full-access / workspace-write / read-only' });
      }
      ai.permission_mode = mode;
    }
    next.ai_deploy = ai;
    if (!E.saveConfig(next)) return sendJson(res, 200, { ok: false, error: '写入 config.json 失败（检查文件是否只读）' });
    const key = String(ai.api_key || '').trim();
    return sendJson(res, 200, {
      ok: true,
      hasKey: Boolean(key),
      maskedKey: key ? ('••••' + key.slice(-4)) : '',
    });
  }

  if (p === '/api/aideploy/start' && req.method === 'POST') {
    if (job.running) return sendJson(res, 409, { ok: false, error: '已有 AI 部署任务进行中，请等待或先取消' });
    const body = await readBody(req);
    const project = String(body.project || '').trim();
    if (!project) return sendJson(res, 200, { ok: false, stage: '校验项目', error: '请填写项目名称或仓库网址' });
    if (project.length > 500) return sendJson(res, 200, { ok: false, stage: '校验项目', error: '项目名称/网址过长' });
    const chk = checkTarget(body.target);
    if (!chk.ok) return sendJson(res, 200, { ok: false, stage: '校验路径', error: chk.error });
    if (!findCli()) {
      return sendJson(res, 200, {
        ok: false, stage: '检测 Harness',
        error: '未找到 DeepSeek Harness CLI（dsh.cmd）。请确认已安装 DeepSeek Harness，或在 config.json 的 ai_deploy.cli 填写 dsh.cmd 的完整路径。',
      });
    }

    // 目录不存在则创建（AI 需要工作目录），已存在则保留原样
    if (!chk.exists) {
      try { fs.mkdirSync(chk.path, { recursive: true }); }
      catch (e) { return sendJson(res, 200, { ok: false, stage: '创建目录', error: '无法创建目录：' + e.message }); }
      chk.exists = true;
    }

    resetJob(project, chk.path);
    jlog('════ AI 部署开始 ════');
    try {
      start(project, chk.path, chk);
    } catch (e) {
      finish('error', { stage: '启动失败', error: e.message });
      return sendJson(res, 200, { ok: false, stage: '启动失败', error: e.message });
    }
    return sendJson(res, 200, { ok: true, jobId: job.id });
  }

  if (p === '/api/aideploy/job' && req.method === 'GET') {
    const from = parseInt(url.searchParams.get('from'), 10) || 0;
    const logs = job.logs.slice(Math.max(0, from));
    return sendJson(res, 200, {
      ok: true,
      id: job.id,
      running: job.running,
      status: job.status,
      percent: job.percent,
      stage: job.stage,
      error: job.error,
      result: job.result,
      project: job.project,
      target: job.target,
      logs,
      next: job.logs.length,
      costSec: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
    });
  }

  if (p === '/api/aideploy/cancel' && req.method === 'POST') {
    if (!job.running) return sendJson(res, 200, { ok: true, status: job.status });
    jlog('⛔ 正在取消…');
    killTree();
    return sendJson(res, 200, { ok: true, status: 'cancelled' });
  }

  if (p === '/api/aideploy/open' && req.method === 'POST') {
    const body = await readBody(req);
    const t = String(body.path || '').trim();
    if (!t || !fs.existsSync(t)) return sendJson(res, 200, { ok: false, error: '路径不存在：' + t });
    try {
      if (process.platform === 'win32') spawn('explorer.exe', [t], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn('xdg-open', [t], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在：' + p });
}

module.exports = { handle, findCli, checkTarget };
