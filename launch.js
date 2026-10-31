/**
 * 隐藏启动器 —— 由 启动.bat 调用，只在后台待几十毫秒就退出。
 *
 * 做两件事：
 *   1. 5215 上没有服务 → 用分离 + windowsHide 的进程拉起 server.js，
 *      黑框不会留在桌面上；服务端自己会 openBrowser，这里不重复开。
 *   2. 已经在跑 → 不再起第二个实例，只把页面打开。
 *
 * 日志统一写到 data\server.log，方便出问题时回看。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const DIR = __dirname;
const PORT = 5215;
const URL = 'http://127.0.0.1:' + PORT + '/';

function openUrl(u) {
  try {
    spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { /* 打不开就算了，用户自己点也行 */ }
}

function alive(cb) {
  let done = false;
  const finish = ok => { if (!done) { done = true; cb(ok); } };
  let req;
  try {
    req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 900 }, res => {
      res.resume();
      finish(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
  } catch (e) {
    finish(false);
  }
}

function boot() {
  const dataDir = path.join(DIR, 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}

  let out = 'ignore';
  try { out = fs.openSync(path.join(dataDir, 'server.log'), 'a'); } catch (e) {}

  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
}

alive(up => {
  if (up) openUrl(URL);
  else boot();
});
