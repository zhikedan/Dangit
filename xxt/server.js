/**
 * GitHub 开源项目下载工具 - 后端服务
 * 零依赖，仅需 Node.js (>=14)
 * 功能：URL 校验 / ZIP 下载+解压+CRC校验 / Git 完整克隆 / 浅克隆 / SSE 进度推送
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

const BASE_PORT = 5210;
const jobs = new Map(); // jobId -> job

/* ---------------- 工具函数 ---------------- */

/** 解析并校验仓库地址（GitHub / Gitee），返回 { owner, repo, platform } 或 null */
function normalizeParsed(platform, owner, repo) {
  owner = String(owner || '');
  repo = String(repo || '').replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (repo.startsWith('.') || repo.endsWith('.')) return null;
  return { owner, repo, platform: platform === 'gitee' ? 'gitee' : 'github' };
}

function parseGithubUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  // SSH 形式：git@github.com:owner/repo(.git) / git@gitee.com:owner/repo(.git)
  let m = s.match(/^git@(github|gitee)\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) return normalizeParsed(m[1].toLowerCase(), m[2], m[3]);
  // 是否 Gitee 地址（含 gitee.com 域名）
  const isGitee = /(?:^|\/\/|\.)gitee\.com[\/:]/i.test(s);
  const platform = isGitee ? 'gitee' : 'github';
  // 去掉协议与域名前缀（github.com / gitee.com / www.）
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:github|gitee)\.com\//i, '');
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  if (!m) return null;
  if (/^(https?|www)$/i.test(m[1])) return null;
  return normalizeParsed(platform, m[1], m[2]);
}

/** HTTPS GET（自动跟随重定向），超时 30s；extraHeaders 可追加请求头（如 Range 断点续传） */
function httpsGet(url, redirects = 5, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'gh-project-downloader', 'Accept': '*/*', ...extraHeaders },
      timeout: 30000
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('重定向次数过多'));
        return resolve(httpsGet(res.headers.location, redirects - 1, extraHeaders));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时，请检查网络')));
    req.on('error', reject);
  });
}

/** 常见英文错误消息 -> 中文 */
function translateEnglishError(msg) {
  const rules = [
    [/getaddrinfo\s+ENOTFOUND|ENOTFOUND/i, '无法解析域名，请检查网络连接'],
    [/connect\s+ECONNREFUSED|ECONNREFUSED/i, '连接被拒绝，请检查网络或代理设置'],
    [/ECONNRESET|connection\s+reset|read\s+ECONNRESET/i, '网络连接被中断，请重试'],
    [/ETIMEDOUT|timed?\s*out/i, '网络连接超时，请检查网络后重试'],
    [/EADDRINUSE/i, '端口已被占用，程序可能已在运行中'],
    [/certificate|CERT_|self[-\s]signed/i, '网络证书校验失败，请检查系统时间或代理'],
    [/permission\s+denied|EACCES|EPERM/i, '没有相应权限，请更换路径或检查授权'],
    [/no\s+space|ENOSPC/i, '磁盘空间不足，请清理磁盘后重试'],
    [/no\s+such\s+file|ENOENT|ENOTDIR/i, '文件或路径不存在'],
    [/broken\s+pipe|EPIPE/i, '连接已断开，请重试'],
    [/tunnel|proxy/i, '代理连接异常，请检查代理设置'],
    [/socket\s+(hang|closed)|write\s+after\s+end/i, '连接异常断开，请重试']
  ];
  for (const [re, zh] of rules) if (re.test(msg)) return zh;
  return null;
}

/** 网络/系统错误 -> 友好中文提示 */
function friendlyError(err) {
  const code = err && (err.code || err.errno);
  const map = {
    ENOTFOUND: '无法连接网络（DNS 解析失败），请检查网络连接',
    EAI_AGAIN: '网络 DNS 解析失败，请稍后重试',
    ETIMEDOUT: '网络连接超时，请检查网络后重试',
    ECONNRESET: '网络连接被中断，请重试',
    ECONNABORTED: '网络连接被中断，请重试',
    ECONNREFUSED: '连接被拒绝，请检查网络或代理设置',
    EADDRINUSE: '端口已被占用，程序可能已在运行中',
    EHOSTUNREACH: '无法连接到目标主机，请检查网络',
    ENETUNREACH: '网络不可达，请检查网络连接',
    EACCES: '目标路径没有写入权限，请更换路径或以管理员身份运行',
    EPERM: '目标路径没有写入权限，请更换路径',
    ENOSPC: '磁盘空间不足，请清理磁盘或更换存储路径',
    ENOENT: '路径不存在',
    EISDIR: '目标路径是一个文件夹，请更换为文件路径',
    ENOTDIR: '路径中的某个目录不存在',
    EINVAL: '参数无效，请检查输入内容',
    CERT_HAS_EXPIRED: '网络证书校验失败，请检查系统时间或代理',
    ERR_INVALID_URL: '地址格式无效'
  };
  if (map[code]) return map[code];
  // 已是中文的错误消息（如自定义「连接超时，请检查网络」）原样返回
  if (err && typeof err.message === 'string' && /[\u4e00-\u9fff]/.test(err.message)) return err.message;
  // 未知英文错误：先尝试翻译常见模式，兜底给通用中文提示，不再透出英文原文
  const msg = (err && err.message) || '';
  const t = translateEnglishError(msg);
  if (t) return t;
  return code ? `操作失败（${code}），请重试` : '操作失败，请重试';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* ---------------- ZIP 解压（纯 Node，含 CRC 完整性校验） ---------------- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 解压 zip 文件到 destDir，返回 { fileCount, rootName }；每个文件做 CRC32 校验 */
function extractZip(zipPath, destDir, onEntry) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailSize = Math.min(size, 66000);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('压缩包已损坏（未找到目录结构），请重新下载');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) throw new Error('暂不支持超大（ZIP64）压缩包');
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

    let fileCount = 0;
    let rootName = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // 防 Zip Slip
      const safe = e.name.replace(/^[/\\]+/, '').split(/[/\\]/).filter(seg => seg && seg !== '.' && seg !== '..').join(path.sep);
      if (!safe) continue;
      if (!rootName) rootName = safe.split(path.sep)[0];
      const outPath = path.join(destDir, safe);

      if (e.name.endsWith('/')) { fs.mkdirSync(outPath, { recursive: true }); continue; }
      if (e.method !== 0 && e.method !== 8) throw new Error(`不支持的压缩方式（method=${e.method}）`);

      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, e.localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('压缩包已损坏（文件头校验失败）');
      const dataStart = e.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const comp = Buffer.alloc(e.compSize);
      fs.readSync(fd, comp, 0, e.compSize, dataStart);
      const data = e.method === 8 ? zlib.inflateRawSync(comp) : comp;

      if (crc32(data) !== e.crc) throw new Error(`文件完整性校验失败：${e.name}（CRC 不匹配，下载可能已损坏）`);

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, data);
      fileCount++;
      if (onEntry) onEntry(i + 1, entries.length, e.name);
    }
    return { fileCount, rootName };
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------- 下载任务 ---------------- */

let jobSeq = 1;
function createJob() {
  const id = 'job_' + (jobSeq++) + '_' + Date.now();
  const job = {
    id, status: 'running', cancelled: false,
    percent: 0, stage: '准备中…', logs: [],
    listeners: [], result: null, error: null,
    _cleanup: []
  };
  jobs.set(id, job);
  return job;
}

function emit(job, obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  job.listeners.forEach(res => { try { res.write(line); } catch {} });
}
function log(job, msg) {
  const item = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  job.logs.push(item);
  emit(job, { type: 'log', msg: item });
}
function progress(job, percent, stage, speed) {
  job.percent = percent; if (stage) job.stage = stage;
  job.speed = speed || 0;
  emit(job, { type: 'progress', percent: Math.round(percent * 10) / 10, stage: job.stage, speed: job.speed });
}
function finish(job, result) {
  job.status = 'done'; job.result = result;
  emit(job, { type: 'done', result });
  closeJob(job);
}
function fail(job, err) {
  job.status = 'error';
  job.error = friendlyError(err);
  log(job, '❌ ' + job.error);
  emit(job, { type: 'error', message: job.error });
  closeJob(job);
}
function closeJob(job) {
  job.listeners.forEach(res => { try { res.end(); } catch {} });
  job.listeners = [];
  setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
}

/** 通过平台 API 获取仓库信息（失败不致命）。platform: 'github' | 'gitee' */
async function fetchRepoInfo(owner, repo, platform = 'github') {
  const api = platform === 'gitee'
    ? `https://gitee.com/api/v5/repos/${owner}/${repo}`
    : `https://api.github.com/repos/${owner}/${repo}`;
  const res = await httpsGet(api);
  let body = '';
  res.resume && res.on('data', c => body += c);
  await new Promise(r => res.on('end', r));
  if (res.statusCode === 404) return { notFound: true };
  if (res.statusCode !== 200) return { error: res.statusCode };
  try {
    const j = JSON.parse(body);
    return {
      fullName: j.full_name, desc: j.description, stars: j.stargazers_count,
      branch: j.default_branch || (platform === 'gitee' ? 'master' : 'main'),
      sizeKB: j.size,
      license: platform === 'gitee'
        ? (j.license && (j.license.name || j.license.license || j.license.spdx_id))
        : (j.license && j.license.spdx_id),
      platform
    };
  } catch { return { error: 'parse' }; }
}

/** 源码 ZIP 下载地址：GitHub codeload / Gitee archive */
function sourceZipUrl(platform, owner, repo, branch) {
  if (platform === 'gitee') {
    const ref = (branch && branch !== 'HEAD') ? branch : 'master';
    return `https://gitee.com/${owner}/${repo}/repository/archive/${ref}.zip`;
  }
  return branch === 'HEAD'
    ? `https://codeload.github.com/${owner}/${repo}/zip/HEAD`
    : `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
}

/** 断点续传下载：本地已有部分时用 Range 从断点继续（服务端支持 206 时生效，否则从头覆盖重下）。
 *  返回 { received, fullTotal, resumed }；整体进度映射到 [pctBase, pctBase+pctSpan]。 */
function downloadResume(job, url, destPath, pctBase, pctSpan, stagePrefix) {
  return new Promise((resolve, reject) => {
    (async () => {
      let existing = 0;
      try { existing = fs.statSync(destPath).size || 0; } catch { existing = 0; }
      const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
      let res;
      try { res = await httpsGet(url, 5, headers); }
      catch (e) { return reject(e); }
      if (res.statusCode === 416) { // 本地文件已完整
        res.resume();
        return resolve({ received: existing, fullTotal: existing, resumed: true, done: true });
      }
      if (res.statusCode === 404) { res.resume(); return reject(new Error('文件不存在或已被移除（HTTP 404）')); }
      if (res.statusCode === 403) { res.resume(); return reject(new Error('访问被 GitHub 限制（HTTP 403），请稍后重试')); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`下载失败（HTTP ${res.statusCode}）`)); }

      const resumed = res.statusCode === 206;
      const offset = resumed ? existing : 0;
      const cr = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers['content-range'] || '');
      const chunkTotal = parseInt(res.headers['content-length'] || '0', 10);
      const fullTotal = resumed && cr ? parseInt(cr[3], 10) : (resumed ? existing + chunkTotal : chunkTotal);
      const totalText = fullTotal ? (fullTotal / 1048576).toFixed(1) + ' MB' : '';

      const file = fs.createWriteStream(destPath, { flags: resumed ? 'a' : 'w' });
      job._stream = res;
      let received = 0, lastLog = 0, speedBps = 0;
      let speedStart = Date.now(), speedBytes = 0;
      const speedSamples = [];
      res.on('data', chunk => {
        if (job.cancelled) { res.destroy(); return; }
        received += chunk.length;
        // 网速测算：每秒采样一次，取最近 8 个样本的滑动平均，更平稳
        const now = Date.now();
        speedBytes += chunk.length;
        if (now - speedStart >= 1000) {
          speedSamples.push(speedBytes * 1000 / (now - speedStart));
          if (speedSamples.length > 8) speedSamples.shift();
          speedStart = now; speedBytes = 0;
          speedBps = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        }
        const ratio = fullTotal ? (offset + received) / fullTotal : Math.min(0.99, received / (50 * 1048576));
        const mb = ((offset + received) / 1048576).toFixed(1);
        progress(job, pctBase + ratio * pctSpan, `${stagePrefix || '下载中…'} ${mb} MB${totalText ? ' / ' + totalText : ''}${resumed ? '（续传）' : ''}`, speedBps);
        if (received - lastLog > 10 * 1048576) { lastLog = received; log(job, `已下载 ${mb} MB`); }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve({ received: offset + received, fullTotal, resumed })));
      res.on('error', e => { file.destroy(); reject(e); });
      file.on('error', reject);
    })();
  });
}

/* ---------------- SHA 指纹校验 ---------------- */

/** 计算文件哈希（algo: sha256/sha512/sha1/md5） */
function hashOf(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 解析校验文件内容，返回匹配 targetName 的 { algo, hash }；找不到返回 null */
function parseChecksumFile(filePath, targetName) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  for (const line of content.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-fA-F0-9]{32,128})[\s*]+(.+?)\s*$/);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    const fname = m[2].replace(/^\*/, '').replace(/\\/g, '/').split('/').pop();
    if (fname === targetName) {
      return { algo: hash.length === 128 ? 'sha512' : hash.length === 64 ? 'sha256' : hash.length === 40 ? 'sha1' : 'md5', hash };
    }
  }
  // 校验文件只有裸哈希（无文件名）时按 sha256 处理
  const bare = content.match(/^\s*([a-fA-F0-9]{64})\s*$/m);
  if (bare) return { algo: 'sha256', hash: bare[1].toLowerCase() };
  return null;
}

/** 在资产列表里为某资产查找配套校验文件（xxx.sha256 / xxx.sha256sum / SHA256SUMS 等） */
function findChecksumAsset(asset, allAssets) {
  const base = asset.name.replace(/\.[^.]+$/, '');
  const candidates = [
    asset.name + '.sha256', base + '.sha256',
    asset.name + '.sha256sum', base + '.sha256sum',
    asset.name + '.sha512', base + '.sha512',
    asset.name + '.sha1', base + '.sha1',
    asset.name + '.md5', base + '.md5'
  ];
  for (const c of candidates) {
    const hit = allAssets.find(a => a.name.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return allAssets.find(a => /^(sha256sums?|SHA256SUMS)(\.txt)?$/i.test(a.name)) || null;
}

/** ZIP 下载 + 解压主流程（支持断点续传；GitHub / Gitee 双平台） */
async function runZipJob(job, owner, repo, branch, destDir, autoExtract, platform = 'github') {
  const isGitee = platform === 'gitee';
  const siteName = isGitee ? 'Gitee' : 'GitHub';
  const candidates = branch ? [branch] : (isGitee ? ['master', 'main'] : ['main', 'master', 'HEAD']);
  let r = null, usedBranch = null, lastErr = null;
  for (const b of candidates) {
    const zipPath = path.join(destDir, `${owner}.${repo}-${b === 'HEAD' ? 'HEAD' : b}.zip`);
    log(job, `正在连接 ${siteName}（分支 ${b}）…`);
    try {
      r = await downloadResume(job, sourceZipUrl(platform, owner, repo, b), zipPath, 0, 80, '下载中…');
      usedBranch = b;
      job._zipPath = zipPath;
      if (!job._files) job._files = [];
      if (!job._files.includes(zipPath)) job._files.push(zipPath);
      break;
    } catch (e) {
      lastErr = e;
      if (/404/.test(e.message)) { try { fs.rmSync(zipPath, { force: true }); } catch {} } // 分支不存在，清掉残留
      if (b === 'HEAD' && !isGitee) {
        const headPath = path.join(destDir, `${owner}.${repo}-HEAD.zip`);
        log(job, '尝试 HEAD 分支…');
        try {
          r = await downloadResume(job, sourceZipUrl(platform, owner, repo, 'HEAD'), headPath, 0, 80, '下载中…');
          usedBranch = 'HEAD';
          job._zipPath = headPath;
          if (!job._files) job._files = [];
          if (!job._files.includes(headPath)) job._files.push(headPath);
          break;
        } catch (e2) { lastErr = e2; }
      }
    }
  }
  if (!r) {
    const msg = (lastErr && lastErr.message) || '';
    if (/404/.test(msg)) throw new Error('仓库不存在、为私有仓库，或分支无法访问（HTTP 404）');
    if (/403/.test(msg)) throw new Error(`访问被 ${siteName} 限制（HTTP 403），请稍后重试`);
    throw lastErr || new Error(`下载失败（${msg || '无响应'}）`);
  }
  if (job.cancelled) return;
  if (r.fullTotal && r.received !== r.fullTotal) { fs.rmSync(job._zipPath, { force: true }); throw new Error('文件不完整（大小与服务器不符），请重试'); }
  log(job, `压缩包下载完成：${job._zipPath}`);

  if (!autoExtract) {
    progress(job, 100, '完成');
    return finish(job, { dir: destDir, zip: job._zipPath, fileCount: null, extracted: false });
  }

  // 解压 + CRC 校验（占 80-99%）
  progress(job, 82, '解压中…');
  log(job, '开始解压并进行文件完整性校验…');
  const tmpExtract = path.join(destDir, `.extract_${Date.now()}`);
  fs.mkdirSync(tmpExtract, { recursive: true });
  let fileCount = 0, rootName = null;
  try {
    ({ fileCount, rootName } = extractZip(job._zipPath, tmpExtract, (done, totalN) => {
      progress(job, 82 + done / totalN * 17, `解压并校验中… ${done}/${totalN}`);
    }));
  } catch (e) {
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.rmSync(job._zipPath, { force: true }); // 压缩包损坏不留，下次从头下载
    throw e;
  }
  if (job.cancelled) { fs.rmSync(tmpExtract, { recursive: true, force: true }); return; }

  // 移动为最终目录名：repo（冲突时 repo-branch / repo-2）
  let finalName = repo, n = 1;
  while (fs.existsSync(path.join(destDir, finalName))) {
    finalName = n === 1 ? `${repo}-${usedBranch}` : `${repo}-${n}`;
    n++;
  }
  const finalDir = path.join(destDir, finalName);
  fs.renameSync(path.join(tmpExtract, rootName), finalDir);
  fs.rmSync(tmpExtract, { recursive: true, force: true });

  // 完整性确认：目录非空
  const check = fs.readdirSync(finalDir);
  if (!check.length) throw new Error('解压结果为空，文件可能不完整');

  progress(job, 100, '完成');
  log(job, `✅ 完整性校验通过，共 ${fileCount} 个文件`);
  finish(job, { dir: finalDir, zip: job._zipPath, fileCount, extracted: true });
}

/* ---------------- Release 发行版 ---------------- */

/** 各平台资产文件名匹配特征 */
const PLATFORM_PATTERNS = {
  windows: [/\.(exe|msi|msix)$/i, /win(dows)?[._-]?(64|32|x64|x86)?/i, /pc-windows/i],
  macos: [/\.(dmg|pkg)$/i, /macos|mac[._-]?os|darwin|osx/i, /apple/i],
  linux: [/\.(appimage|deb|rpm|snap|flatpak)$/i, /linux/i, /gnu/i],
  android: [/\.(apk|aab)$/i, /android/i],
  ios: [/\.ipa$/i, /ios|iphone|ipad/i],
  docker: [/docker/i, /image|container/i, /\.tar(\.gz|\.zst)?$/i]
};

/* ---------------- Release 资产自动分类（智能解析） ---------------- */

const ASSET_TYPE_ORDER = ['windows', 'macos', 'linux', 'android', 'ios', 'docker', 'doc', 'checksum', 'source', 'other'];
const ASSET_TYPE_NAMES = {
  windows: '🪟 Windows', macos: '🍎 macOS', linux: '🐧 Linux',
  android: '🤖 Android', ios: '📱 iOS', docker: '🐳 Docker',
  doc: '📚 文档', checksum: '🔒 校验文件', source: '📄 源码包', other: '🗂 其他'
};

/** 自动识别单个发行版资产属于什么类型（Windows 之外的文档/校验/源码等也能认出） */
function classifyAsset(name) {
  const n = name.toLowerCase();
  // 1) 校验文件（.sha256 / .sha512 / .sha1 / .md5 / .sig / .asc / SHA256SUMS.txt 等）
  if (/\.(sha256|sha512|sha1|md5)(\.txt|\.sum)?$/i.test(name) || /\.(sig|asc)$/i.test(name) || /sha(256|512)?sums?\.txt$/i.test(n)) return 'checksum';
  // 2) 文档类（PDF / CHM / Markdown / Office / 电子书 / 纯文本等）
  if (/\.(pdf|chm|md|markdown|docx?|xlsx?|pptx?|epub|azw3|mobi|djvu|rtf|odt|ods|odp|txt|html?|rst|tex|wiki|csv|log)$/i.test(n)) return 'doc';
  // 3) 平台安装包：扩展名优先
  if (/\.(exe|msi|msix|msixbundle|appx|appxbundle)$/i.test(name)) return 'windows';
  if (/\.(dmg|pkg)$/i.test(name)) return 'macos';
  if (/\.(appimage|deb|rpm|snap|flatpak|run)$/i.test(name)) return 'linux';
  if (/\.(apk|aab|xapk)$/i.test(name)) return 'android';
  if (/\.ipa$/i.test(name)) return 'ios';
  // 4) Docker 镜像包
  if (/docker/i.test(n)) return 'docker';
  // 5) 平台关键词（常见命名习惯）
  if (/(^|[._\- ])(win|windows)([._\- ]|$)|win32|win64|x64|x86|amd64|pc-windows/i.test(n)) return 'windows';
  if (/(^|[._\- ])(mac|macos|darwin|osx)([._\- ]|$)|apple/i.test(n)) return 'macos';
  if (/(^|[._\- ])(linux|ubuntu|debian|fedora|centos|arch|manjaro)([._\- ]|$)|gnu/i.test(n)) return 'linux';
  if (/(^|[._\- ])android([._\- ]|$)/i.test(n)) return 'android';
  if (/(^|[._\- ])(ios|iphone|ipad)([._\- ]|$)/i.test(n)) return 'ios';
  // 6) 源码包 / 通用压缩包（含 Source code (zip) 这类 GitHub 默认资产）
  if (/source\s*code|(^|[._\- ])(src|source)([._\- ]|$)/i.test(name) || /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|7z|rar)$/i.test(n)) return 'source';
  if (/\.zip$/i.test(n)) return /source|src/i.test(n) ? 'source' : 'other';
  return 'other';
}

/** 按平台匹配发行版资产，返回打分排序后的列表 */
function matchAssets(assets, platform) {
  const pats = PLATFORM_PATTERNS[platform];
  if (!pats) return assets;
  return assets
    .map(a => ({ ...a, score: pats.reduce((s, p) => s + (p.test(a.name) ? 1 : 0), 0) }))
    .filter(a => a.score > 0)
    .sort((x, y) => y.score - x.score || y.downloads - x.downloads);
}

/** Release 信息缓存（5 分钟，避免触发 API 限流） */
const releaseCache = new Map();

/** 获取仓库最新发行版及资产列表（GitHub / Gitee 双平台） */
async function fetchReleases(owner, repo, platform = 'github') {
  const key = `${platform}:${owner}/${repo}`;
  const cached = releaseCache.get(key);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.data;

  const api = platform === 'gitee'
    ? `https://gitee.com/api/v5/repos/${owner}/${repo}/releases?page=1&per_page=10`
    : `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`;
  const res = await httpsGet(api);
  let body = '';
  res.on('data', c => body += c);
  await new Promise(r => res.on('end', r));
  if (res.statusCode === 404) return { notFound: true };
  if (res.statusCode === 403) return { rateLimited: true };
  if (res.statusCode !== 200) return { error: res.statusCode };

  let list;
  try { list = JSON.parse(body); } catch { return { error: 'parse' }; }
  if (!Array.isArray(list) || !list.length) return { empty: true };

  // 优先最新的正式版，其次预发布版
  const rel = list.find(r => !r.draft && !r.prerelease) || list.find(r => !r.draft) || list[0];
  const data = {
    tag: rel.tag_name,
    name: rel.name || rel.tag_name,
    publishedAt: rel.published_at || rel.created_at,
    prerelease: !!rel.prerelease,
    platform,
    assets: (rel.assets || []).map(a => ({
      name: a.name,
      size: a.size,
      downloads: a.download_count,
      url: a.browser_download_url || a.url
    })),
    // Gitee API 无 zipball_url，用 tag 归档地址兜底
    zipball: rel.zipball_url || (platform === 'gitee'
      ? `https://gitee.com/${owner}/${repo}/repository/archive/${rel.tag_name}.zip` : ''),
    tarball: rel.tarball_url || ''
  };
  releaseCache.set(key, { time: Date.now(), data });
  return data;
}

/** Release 批量下载主流程：断点续传 / SHA 自动校验 / ZIP 自动解压 / 多文件 */
async function runReleaseBatchJob(job, assets, destDir, tag, autoExtract) {
  const total = assets.length;
  const doneFiles = [];
  const downloadedSet = new Set();
  log(job, `发行版版本：${tag || '最新版'}，共 ${total} 个文件`);
  for (let i = 0; i < total; i++) {
    if (job.cancelled) return;
    const a = assets[i];
    const safeName = (a.name || 'release.bin').replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(destDir, safeName);
    if (!job._files) job._files = [];
    if (!job._files.includes(dest)) job._files.push(dest);

    // 已在前面作为校验文件下载过，跳过
    if (downloadedSet.has(a.name.toLowerCase())) {
      log(job, `[${i + 1}/${total}] ${safeName} 已作为校验文件下载过，跳过`);
      progress(job, ((i + 1) / total) * 100, `完成 ${i + 1}/${total}`);
      doneFiles.push({ name: safeName, path: dest, skipped: true });
      continue;
    }

    log(job, `[${i + 1}/${total}] 开始下载：${safeName}`);
    progress(job, (i / total) * 100, `下载 ${i + 1}/${total}`);

    // 查找配套校验文件，优先下载用于后续指纹核对
    const check = findChecksumAsset(a, assets);
    let expected = null;
    if (check) {
      const checkPath = path.join(destDir, (check.name || 'check').replace(/[\\/:*?"<>|]/g, '_'));
      log(job, `发现校验文件 ${check.name}，先行下载用于完整性核对`);
      if (!job._files.includes(checkPath)) job._files.push(checkPath);
      try {
        await downloadResume(job, check.url, checkPath, (i / total) * 100, (100 / total) * 0.12, 'SHA 校验文件下载中…');
        expected = parseChecksumFile(checkPath, safeName);
        if (expected) log(job, `校验要求：${expected.algo.toUpperCase()} = ${expected.hash.slice(0, 16)}…`);
        else log(job, '未找到该文件对应的校验条目，跳过指纹核对');
        downloadedSet.add(check.name.toLowerCase());
      } catch (e) {
        log(job, `校验文件下载失败（${friendlyError(e)}），将不执行指纹核对`);
      }
    }

    // 下载主文件（断点续传）
    const r = await downloadResume(job, a.url, dest, (i / total) * 100 + (100 / total) * 0.12, (100 / total) * 0.8, `下载 ${safeName}…`);
    if (job.cancelled) return;
    if (r.fullTotal && r.received !== r.fullTotal) { fs.rmSync(dest, { force: true }); throw new Error(`${safeName} 文件不完整（${r.received}/${r.fullTotal} 字节），请重新下载`); }
    log(job, `${safeName} 下载完成（${(r.received / 1048576).toFixed(1)} MB）${r.resumed ? '· 断点续传' : ''}`);

    // SHA 指纹核对
    if (expected) {
      progress(job, (i / total) * 100 + (100 / total) * 0.92, `核对 ${expected.algo.toUpperCase()}…`);
      const actual = await hashOf(dest, expected.algo);
      if (actual !== expected.hash) {
        fs.rmSync(dest, { force: true });
        throw new Error(`${safeName} ${expected.algo.toUpperCase()} 指纹核对失败（下载可能损坏），已删除，请重新下载`);
      }
      log(job, `✅ ${safeName} ${expected.algo.toUpperCase()} 指纹核对通过`);
    }

    // ZIP 自动解压（可选，同时保留压缩包）
    let extracted = false, extractedDir = null;
    if (autoExtract && /\.zip$/i.test(safeName)) {
      progress(job, (i / total) * 100 + (100 / total) * 0.95, `解压 ${safeName}…`);
      log(job, `自动解压 ZIP：${safeName}…`);
      try {
        const tmpExtract = path.join(destDir, `.extract_${Date.now()}_${i}`);
        fs.mkdirSync(tmpExtract, { recursive: true });
        const { fileCount, rootName } = extractZip(dest, tmpExtract, (done, totalN) => {
          progress(job, (i / total) * 100 + (100 / total) * (0.95 + done / totalN * 0.04), `解压并校验中… ${done}/${totalN}`);
        });
        let finalName = safeName.replace(/\.zip$/i, '');
        let n2 = 1;
        while (fs.existsSync(path.join(destDir, finalName))) finalName = `${safeName.replace(/\.zip$/i, '')}-${n2++}`;
        const finalDir = path.join(destDir, finalName);
        fs.renameSync(path.join(tmpExtract, rootName), finalDir);
        fs.rmSync(tmpExtract, { recursive: true, force: true });
        extracted = true; extractedDir = finalDir;
        log(job, `✅ ${safeName} 解压完成：${finalDir}（共 ${fileCount} 个文件）`);
      } catch (e) {
        log(job, `⚠ ${safeName} 解压失败：${friendlyError(e)}（压缩包仍已保存，可手动处理）`);
      }
    }

    doneFiles.push({ name: safeName, path: dest, extracted, extractedDir });
    progress(job, ((i + 1) / total) * 100, `完成 ${i + 1}/${total}：${safeName}`);
    log(job, `[${i + 1}/${total}] ✅ ${safeName} 下载完成`);
  }

  progress(job, 100, '完成');
  log(job, `✅ 全部 ${doneFiles.length} 个文件下载完成`);
  finish(job, { dir: destDir, files: doneFiles, release: true });
}

/* ---------------- Git 克隆 ---------------- */

/** git 输出中常见英文错误 -> 中文 */
function translateGitError(line) {
  const rules = [
    [/destination path .* already exists/i, '目标文件夹已存在，请更换存储路径'],
    [/repository .* not found/i, '仓库不存在或为私有仓库'],
    [/could not resolve host/i, '无法解析主机地址（DNS 问题）'],
    [/unable to access/i, '无法访问远程仓库（网络或代理问题）'],
    [/failed to connect to/i, '无法连接到远程服务器'],
    [/could not read Username|authentication failed|terminal prompts disabled/i, '需要登录认证（可能是私有仓库）'],
    [/early EOF|index-pack failed|RPC failed/i, '数据传输中断，网络不稳定'],
    [/unable to auto-detect email address/i, '本机 Git 未配置用户名和邮箱（可用 git config --global 配置）'],
    [/SSL certificate problem/i, '证书校验失败，请检查系统时间或代理'],
    [/not a git repository/i, '目标位置不是有效的 Git 仓库'],
    [/no such file or directory/i, '目标路径不存在或无效'],
    [/could not open/i, '无法打开目标位置'],
    [/invalid reference|bad object/i, '仓库数据异常（引用或对象无效）']
  ];
  for (const [re, zh] of rules) if (re.test(line)) return zh;
  return null;
}

/** Git 克隆主流程（shallow=true 时为浅克隆；GitHub / Gitee 双平台） */
async function runCloneJob(job, owner, repo, destDir, shallow, platform = 'github') {
  const host = platform === 'gitee' ? 'gitee.com' : 'github.com';
  const target = path.join(destDir, repo);
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    throw new Error(`目标文件夹已存在且不为空：${target}\n请更换存储路径或清空该文件夹`);
  }
  const url = `https://${host}/${owner}/${repo}.git`;
  log(job, `开始${shallow ? '浅克隆（仅最新提交，体积更小）' : '完整克隆'} ${url}`);
  log(job, `目标位置：${target}`);
  progress(job, 1, '正在克隆…');

  await new Promise((resolve, reject) => {
    let child;
    const args = shallow
      ? ['clone', '--depth', '1', '--progress', url, target]
      : ['clone', '--progress', url, target];
    try {
      child = spawn('git', args, { windowsHide: true });
    } catch (e) { return reject(e); }
    job._child = child;
    let tail = '';
    child.stderr.on('data', d => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      // 解析 git 进度
      const lines = s.split(/\r|\n/);
      for (const line of lines) {
        let m = line.match(/(Counting|Compressing|Receiving|Resolving)\s+(\w+)?\s*:?\s*(\d+)%/i);
        if (m) {
          const stageMap = { counting: '统计对象', compressing: '压缩对象', receiving: '接收对象', resolving: '解析增量' };
          const key = m[1].toLowerCase();
          const pct = parseInt(m[3], 10);
          const overall = key === 'receiving' ? 5 + pct * 0.75 : key === 'resolving' ? 80 + pct * 0.19 : pct * 0.05;
          progress(job, overall, `${stageMap[key] || '克隆'}中… ${pct}%`);
        }
      }
    });
    child.stdout.on('data', () => {});
    child.on('error', e => {
      if (e.code === 'ENOENT') reject(new Error('未检测到 Git。请先安装 Git（https://git-scm.com），或改用「源码 ZIP」下载方式'));
      else reject(e);
    });
    child.on('close', code => {
      if (job.cancelled) return resolve();
      if (code === 0) resolve();
      else {
        try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch {}
        let msg = 'Git 克隆失败';
        if (/not found|404/i.test(tail)) msg = '仓库不存在或为私有仓库（Git 返回 404）';
        else if (/denied|authentication|403/i.test(tail)) msg = '没有访问权限（可能需要登录的私有仓库）';
        else if (/timed ?out|could not resolve|could not connect|failed to connect|connection.{0,20}reset|SSL_read|RPC failed|unable to (connect|access)/i.test(tail)) msg = `网络连接失败（无法连接到 ${host}），请检查网络或代理后重试`;
        else {
          const lastLine = tail.split(/[\r\n]+/).map(s => s.trim()).filter(s => /fatal|error/i.test(s)).pop();
          const gitMsg = translateGitError(lastLine || '');
          if (gitMsg) msg += '：' + gitMsg;
          else if (lastLine) msg += '：发生未预期的错误，请查看上方日志';
        }
        reject(new Error(msg));
      }
    });
  });
  if (job.cancelled) { fs.rmSync(target, { recursive: true, force: true }); return; }

  // 完整性确认：.git 存在且工作区非空
  progress(job, 99, '校验完整性…');
  const ok = fs.existsSync(path.join(target, '.git')) && fs.readdirSync(target).length > 1;
  if (!ok) throw new Error('克隆结果不完整（缺少 .git 或工作区为空）');
  const fileCount = fs.readdirSync(target).length;
  progress(job, 100, '完成');
  log(job, '✅ 仓库克隆完成，完整性校验通过');
  finish(job, { dir: target, zip: null, fileCount, extracted: false, cloned: true });
}

/* ---------------- HTTP 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    // 首页
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    // URL 校验
    if (req.method === 'POST' && u.pathname === '/api/validate') {
      const { url } = await readBody(req);
      const parsed = parseGithubUrl(url);
      if (!parsed) return sendJson(res, 200, { ok: false, message: 'URL 格式不正确。示例：https://github.com/owner/repo 或 https://gitee.com/owner/repo' });
      const out = { ok: true, owner: parsed.owner, repo: parsed.repo, platform: parsed.platform };
      try {
        const info = await fetchRepoInfo(parsed.owner, parsed.repo, parsed.platform);
        if (info.notFound) return sendJson(res, 200, { ok: false, message: '格式正确，但该仓库不存在或为私有仓库（404）' });
        if (!info.error) Object.assign(out, { info });
      } catch { out.online = false; } // 离线时仅做格式校验
      return sendJson(res, 200, out);
    }

    // Release 发行版资产查询（按平台匹配）
    if (req.method === 'POST' && u.pathname === '/api/releases') {
      const { url, platform } = await readBody(req);
      const parsed = parseGithubUrl(url);
      if (!parsed) return sendJson(res, 400, { error: 'GitHub / Gitee URL 格式不正确' });
      let rel;
      try { rel = await fetchReleases(parsed.owner, parsed.repo, parsed.platform); }
      catch (e) { return sendJson(res, 200, { ok: false, message: friendlyError(e) }); }
      if (rel.notFound) return sendJson(res, 200, { ok: false, message: '仓库不存在或为私有仓库（404）' });
      if (rel.rateLimited) return sendJson(res, 200, { ok: false, message: parsed.platform === 'gitee' ? 'Gitee API 访问频率超限，请稍等一分钟再试' : 'GitHub API 访问频率超限，请稍等一分钟再试' });
      if (rel.error) return sendJson(res, 200, { ok: false, message: rel.error === 'parse' ? '发行版数据解析失败，请稍后重试' : `查询发行版失败（HTTP ${rel.error}）` });
      if (rel.empty) return sendJson(res, 200, { ok: false, empty: true, message: '该仓库尚未发布任何 Release，可改用「源码 ZIP」方式' });

      // 自动解析：全部资产按类型分组返回
      if (platform === 'auto') {
        const enriched = rel.assets.map(a => {
          const type = classifyAsset(a.name);
          return { ...a, type, typeName: ASSET_TYPE_NAMES[type] };
        });
        const groups = ASSET_TYPE_ORDER
          .map(t => ({ type: t, typeName: ASSET_TYPE_NAMES[t], assets: enriched.filter(x => x.type === t) }))
          .filter(g => g.assets.length > 0);
        return sendJson(res, 200, {
          ok: true, tag: rel.tag, name: rel.name, publishedAt: rel.publishedAt,
          auto: true, groups, totalAssets: rel.assets.length
        });
      }
      // 文档 / 校验文件：按类型精确筛选
      if (platform === 'doc' || platform === 'checksum') {
        const filtered = rel.assets.filter(a => classifyAsset(a.name) === platform);
        return sendJson(res, 200, {
          ok: true, tag: rel.tag, name: rel.name, publishedAt: rel.publishedAt,
          assets: filtered, matched: filtered.length > 0,
          totalAssets: rel.assets.length, empty: !filtered.length
        });
      }
      // 源码包：直接用发行版的 zipball
      if (platform === 'source') {
        return sendJson(res, 200, {
          ok: true, tag: rel.tag, name: rel.name, publishedAt: rel.publishedAt,
          assets: [{ name: `${parsed.repo}-${rel.tag}.zip`, size: 0, downloads: null, url: rel.zipball, source: true }],
          matched: true
        });
      }
      const matched = matchAssets(rel.assets, platform);
      return sendJson(res, 200, {
        ok: true, tag: rel.tag, name: rel.name, publishedAt: rel.publishedAt,
        assets: matched.length ? matched : rel.assets,
        matched: matched.length > 0,
        totalAssets: rel.assets.length
      });
    }

    // 发起下载
    if (req.method === 'POST' && u.pathname === '/api/download') {
      const { url, path: dest, mode, autoExtract, assetUrl, assetName, tag, assets } = await readBody(req);
      const parsed = parseGithubUrl(url);
      if (!parsed) return sendJson(res, 400, { error: 'GitHub / Gitee URL 格式不正确' });
      if (!dest || typeof dest !== 'string') return sendJson(res, 400, { error: '请输入本地存储路径' });
      const releaseAssets = mode === 'release' && Array.isArray(assets) && assets.length
        ? assets.map(a => ({ name: a.name, url: a.url, size: a.size }))
        : (mode === 'release' ? [{ name: assetName, url: assetUrl }] : null);
      if (mode === 'release' && (!releaseAssets || !releaseAssets[0].url || !/^https:\/\//.test(releaseAssets[0].url)))
        return sendJson(res, 400, { error: '请先选择要下载的发行版文件' });
      const destDir = path.resolve(dest.trim());
      if (!fs.existsSync(destDir)) {
        try { fs.mkdirSync(destDir, { recursive: true }); }
        catch (e) { return sendJson(res, 400, { error: friendlyError(e) }); }
      }
      // 写权限测试
      try { fs.accessSync(destDir, fs.constants.W_OK); }
      catch (e) { return sendJson(res, 400, { error: friendlyError(e) }); }

      let branch = null;
      try { const info = await fetchRepoInfo(parsed.owner, parsed.repo, parsed.platform); if (info.branch) branch = info.branch; } catch {}

      const job = createJob();
      const platName = parsed.platform === 'gitee' ? 'Gitee' : 'GitHub';
      log(job, `目标仓库（${platName}）：${parsed.owner}/${parsed.repo}，存储路径：${destDir}`);
      const modeNames = { zip: '源码 ZIP 压缩包', clone: 'Git 完整克隆', shallow: 'Git 浅克隆（--depth 1）', release: `发行版 Release（${releaseAssets.length > 1 ? releaseAssets.length + ' 个文件' : (releaseAssets[0].name || '')}）` };
      log(job, `下载方式：${modeNames[mode] || modeNames.zip}`);
      (async () => {
        try {
          if (mode === 'clone' || mode === 'shallow') await runCloneJob(job, parsed.owner, parsed.repo, destDir, mode === 'shallow', parsed.platform);
          else if (mode === 'release') await runReleaseBatchJob(job, releaseAssets, destDir, tag, autoExtract === true);
          else await runZipJob(job, parsed.owner, parsed.repo, branch, destDir, autoExtract !== false, parsed.platform);
          if (job.cancelled) { log(job, '任务已取消'); job.status = 'cancelled'; emit(job, { type: 'cancelled' }); closeJob(job); }
        } catch (e) { if (!job.cancelled) fail(job, e); else { job.status = 'cancelled'; emit(job, { type: 'cancelled' }); closeJob(job); } }
      })();
      return sendJson(res, 200, { jobId: job.id });
    }

    // 取消任务
    if (req.method === 'POST' && u.pathname === '/api/cancel') {
      const { jobId } = await readBody(req);
      const job = jobs.get(jobId);
      if (!job) return sendJson(res, 404, { error: '任务不存在或已结束' });
      job.cancelled = true;
      try { job._stream && job._stream.destroy(); } catch {}
      try { job._child && job._child.kill(); } catch {}
      try {
        if (Array.isArray(job._files) && job._files.length) {
          for (const f of job._files) { try { if (f && fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {} }
        } else if (job._zipPath && fs.existsSync(job._zipPath)) fs.rmSync(job._zipPath, { force: true });
      } catch {}
      return sendJson(res, 200, { ok: true });
    }

    // SSE 进度
    if (req.method === 'GET' && u.pathname === '/api/events') {
      const job = jobs.get(u.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('retry: 1000\n\n');
      job.logs.forEach(m => res.write(`data: ${JSON.stringify({ type: 'log', msg: m })}\n\n`));
      res.write(`data: ${JSON.stringify({ type: 'progress', percent: job.percent, stage: job.stage, speed: job.speed || 0 })}\n\n`);
      job.listeners.push(res);
      req.on('close', () => { job.listeners = job.listeners.filter(r => r !== res); });
      return;
    }

    // 任务状态快照（测试/兜底用）
    if (req.method === 'GET' && u.pathname === '/api/job') {
      const job = jobs.get(u.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, { status: job.status, percent: job.percent, stage: job.stage, logs: job.logs, result: job.result, error: job.error });
    }

    // 打开文件夹
    if (req.method === 'POST' && u.pathname === '/api/open') {
      const { path: p } = await readBody(req);
      if (!p || !fs.existsSync(p)) return sendJson(res, 400, { error: '路径不存在' });
      const cmd = process.platform === 'win32' ? `explorer "${p}"` : process.platform === 'darwin' ? `open "${p}"` : `xdg-open "${p}"`;
      exec(cmd, () => {});
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: '接口不存在' });
  } catch (e) {
    sendJson(res, 500, { error: friendlyError(e) });
  }
});

function listen(port) {
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('==============================================');
    console.log('  GitHub 开源项目下载工具已启动');
    console.log(`  请在浏览器中访问：${url}`);
    console.log('  关闭本窗口即可退出工具');
    console.log('==============================================');
    const openCmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(openCmd, () => {});
  }).on('error', e => {
    if (e.code === 'EADDRINUSE' && port < BASE_PORT + 10) listen(port + 1);
    else { console.error('启动失败：' + friendlyError(e)); process.exit(1); }
  });
}
listen(BASE_PORT);
