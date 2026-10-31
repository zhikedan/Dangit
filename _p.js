'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const R = 'zhikedan/Dangit';

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dangit-push',
      'Authorization': 'Bearer ' + token,
    };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = https.request({ hostname: 'api.github.com', port: 443, path: p, method, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: t });
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('timeout ' + p)));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const dir = String.raw`E:\pc\桌面\Dangit`;
  const ref = await api('GET', `/repos/${R}/git/ref/heads/main`);
  const headSha = ref.json.object.sha;
  const headC = await api('GET', `/repos/${R}/git/commits/${headSha}`);
  console.log('head = ' + headSha.slice(0, 7));

  const out = execSync('git -c core.quotepath=false ls-files -z', { cwd: dir, encoding: 'utf8' });
  const files = out.split('\u0000').filter(Boolean);
  console.log('files = ' + files.length);

  const tree = [];
  for (const rel of files) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { console.log('  skip ' + rel); continue; }
    const buf = fs.readFileSync(abs);
    const b = await api('POST', `/repos/${R}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    if (b.status !== 201) { console.error('blob fail ' + rel); process.exit(1); }
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: b.json.sha });
  }

  const nt = await api('POST', `/repos/${R}/git/trees`, { base_tree: headC.json.tree.sha, tree });
  if (nt.status !== 201) { console.error('tree fail ' + nt.status); process.exit(1); }

  const cm = await api('POST', `/repos/${R}/git/commits`, {
    message: 'docs: 界面预览换成新版截图（4 张）\n\n- 主控制台加载态\n- 主控制台清晰壁纸（虚化调低）\n- 分析报告 + 样式设置面板\n- 下载工具',
    tree: nt.json.sha,
    parents: [headSha],
  });
  if (cm.status !== 201) { console.error('commit fail ' + cm.status + ' ' + cm.text.slice(0, 200)); process.exit(1); }
  console.log('commit = ' + cm.json.sha.slice(0, 7));

  const up = await api('PATCH', `/repos/${R}/git/refs/heads/main`, { sha: cm.json.sha });
  console.log('ref = ' + up.status + (up.status === 200 ? ' OK' : ' ' + up.text.slice(0, 150)));
})().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
