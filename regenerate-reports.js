// 重新渲染 reports 目录下的所有 Markdown 报告为新的 HTML 模板
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const DIR = path.join(__dirname, 'reports');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md'));

let n = 0;
for (const f of files) {
  const md = fs.readFileSync(path.join(DIR, f), 'utf8');
  const period = (md.match(/统计周期[:：]\**\s*([^\n|]+)/) || [])[1] || '本月';
  const date = (md.match(/生成日期[:：]\**\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) || [])[1] || '';
  const title = `GitHub 热门项目分析报告（${period.trim().replace(/\*/g, '')}）${date ? ' ' + date : ''}`;
  const html = E.mdToHtml(md, title);
  const out = path.join(DIR, f.replace(/\.md$/, '.html'));
  fs.writeFileSync(out, html, 'utf8');
  console.log('written', path.basename(out), (html.length / 1024).toFixed(1) + 'KB');
  n++;
}
console.log('total', n);
