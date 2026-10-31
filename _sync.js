'use strict';
/**
 * 把本地 .github/assets + README 同步到远端，并删除远端已不存在的旧图。
 * 分两步：先上传（全量 tree），再用剔除法重建 tree 去掉多余文件。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const R = 'zhikedan/Dangit';
const DIR = String.raw`E:\pc\桌面\Dangit`;

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dangit-sync',
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
    req.setTimeout(120000, () => req.destroy(new Error('timeout ' + p)));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const ref = await api('GET', `/repos/${R}/git/ref/heads/main`);
  const headSha = ref.json.object.sha;
  const headC = await api('GET', `/repos/${R}/git/commits/${headSha}`);
  console.log('head = ' + headSha.slice(0, 7));

  // 本地应存在的全部文件（以 git ls-files 为准）
  const out = execSync('git -c core.quotepath=false ls-files -z', { cwd: DIR, encoding: 'utf8' });
  const localFiles = new Set(out.split('\u0000').filter(Boolean));

  // 远端现有 blob
  const full = await api('GET', `/repos/${R}/git/trees/${headC.json.tree.sha}?recursive=1`);
  const remoteBlobs = full.json.tree.filter((x) => x.type === 'blob');
  console.log('remote blobs = ' + remoteBlobs.length + '  local files = ' + localFiles.size);

  const stale = remoteBlobs.filter((b) => !localFiles.has(b.path));
  console.log('stale on remote: ' + (stale.length ? stale.map((b) => b.path).join(', ') : '(none)'));

  // 上传所有本地文件
  const tree = [];
  for (const rel of localFiles) {
    const abs = path.join(DIR, rel);
    if (!fs.existsSync(abs)) { console.log('  skip missing ' + rel); continue; }
    const buf = fs.readFileSync(abs);
    const b = await api('POST', `/repos/${R}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    if (b.status !== 201) { console.error('blob fail ' + rel + ' ' + b.status); process.exit(1); }
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: b.json.sha });
  }
  console.log('uploaded blobs = ' + tree.length);

  // 建 tree（不含任何 base_tree，天然剔除远端多余文件）
  const nt = await api('POST', `/repos/${R}/git/trees`, { tree });
  if (nt.status !== 201) { console.error('tree fail ' + nt.status + ' ' + nt.text.slice(0, 200)); process.exit(1); }

  const cm = await api('POST', `/repos/${R}/git/commits`, {
    message: 'docs: 第一张预览换成预设壁纸（晨曦）\n\n- 01-console-loading.jpg -> 01-console-preset.jpg（换成内置渐变壁纸状态）\n- README 四段说明同步更新',
    tree: nt.json.sha,
    parents: [headSha],
  });
  if (cm.status !== 201) { console.error('commit fail ' + cm.status + ' ' + cm.text.slice(0, 200)); process.exit(1); }
  console.log('commit = ' + cm.json.sha.slice(0, 7));

  const up = await api('PATCH', `/repos/${R}/git/refs/heads/main`, { sha: cm.json.sha });
  console.log('ref = ' + up.status + (up.status === 200 ? ' OK' : ' ' + up.text.slice(0, 150)));
})().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
