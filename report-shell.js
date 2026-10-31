'use strict';

/* ============================================================================
   报告页外壳：视觉样式 + 交互脚本
   由 engine.js 的 mdToHtml() 调用，生成纯静态单文件 HTML（可离线双击打开）
   ========================================================================== */

/* ------------------------------------------------------------- 线性图标集 */

const ICONS = {
  package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.9 20.4 7v9.9L12 21.1 3.6 16.9V7z"/><path d="M3.9 7.1 12 11.4l8.1-4.3"/><path d="M12 11.4v9.5"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="m15.4 8.6-2 4.8-4.8 2 2-4.8z"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 16.5 9 11l3.4 3.4L20.5 6.5"/><path d="M15.5 6.5h5v5"/></svg>',
  rule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M4 12h16M4 18h13"/><circle cx="18" cy="6" r="2"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8.5 4.6L12 12.2 3.5 7.6z"/><path d="m3.5 12.4 8.5 4.6 8.5-4.6"/><path d="m3.5 16.9 8.5 4.6 8.5-4.6"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 6.5H21M8.5 12H21M8.5 17.5H21"/><circle cx="4" cy="6.5" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="17.5" r="1.2"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4H20v5.5"/><path d="M9.5 20H4v-5.5"/><path d="M20 4 13.5 10.5"/><path d="M4 20l6.5-6.5"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10.5h-5.5V5"/><path d="M4 13.5h5.5V19"/><path d="M14.5 10.5 20 5"/><path d="M9.5 13.5 4 19"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.5V9h4.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  arrowL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 5-7 7 7 7"/></svg>',
  arrowR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 5 7 7-7 7"/></svg>',
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>'
};

const EMOJI_MAP = {
  '📦': 'package',
  '📊': 'grid',
  '🧭': 'compass',
  '📈': 'trend',
  '📐': 'rule',
  '🗂': 'layers',
  '🌐': 'layers',
  '⭐': 'trend'
};

/* ------------------------------------------------------------------- 样式 */

function reportCss() {
  return `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0}

:root{
  --maxw:1120px; --fs:15px; --blur:20px; --radius:18px; --gap:16px;
  --accent:#2f6fd6; --accent-2:#7c5cff;
  --bg-a:#f7f9fd; --bg-b:#eaeff8;
  --blob-a:#a9c8ff; --blob-b:#a7ecd8; --blob-c:#dccdff;
  --surface:rgba(255,255,255,.74);
  --surface-2:rgba(255,255,255,.93);
  --surface-3:rgba(255,255,255,.58);
  --border:rgba(17,32,64,.10);
  --border-2:rgba(17,32,64,.20);
  --text:#182136; --text-2:#3b4964; --dim:#5f6d88;
  --chip:rgba(255,255,255,.70);
  --shadow:0 20px 48px rgba(28,48,92,.10),0 2px 8px rgba(28,48,92,.05);
  --shadow-sm:0 8px 20px rgba(28,48,92,.08);
  --on-accent:#fff;
  --stage-h:min(64vh,600px);
}

body[data-theme="night"]{
  --bg-a:#070c17; --bg-b:#0b1222;
  --blob-a:#1b3d8a; --blob-b:#0c6659; --blob-c:#402784;
  --surface:rgba(18,25,42,.72); --surface-2:rgba(23,31,50,.94); --surface-3:rgba(18,25,42,.52);
  --border:rgba(255,255,255,.08); --border-2:rgba(255,255,255,.18);
  --text:#e9effc; --text-2:#c4d0e7; --dim:#8ea0c1;
  --chip:rgba(255,255,255,.06);
  --accent:#6aa8ff; --accent-2:#a78bfa;
  --shadow:0 22px 54px rgba(0,0,0,.46); --shadow-sm:0 8px 22px rgba(0,0,0,.32);
}

body[data-theme="aurora"]{
  --bg-a:#0b0f2c; --bg-b:#141a44;
  --blob-a:#3a2c8c; --blob-b:#0d5878; --blob-c:#682c9c;
  --surface:rgba(26,31,66,.66); --surface-2:rgba(31,37,78,.93); --surface-3:rgba(26,31,66,.48);
  --border:rgba(178,168,255,.13); --border-2:rgba(178,168,255,.28);
  --text:#eae8ff; --text-2:#c9c5ef; --dim:#9a95c7;
  --chip:rgba(255,255,255,.07);
  --accent:#a78bfa; --accent-2:#67e8f9;
  --shadow:0 22px 54px rgba(4,2,24,.5); --shadow-sm:0 8px 22px rgba(4,2,24,.36);
}

body[data-theme="warm"]{
  --bg-a:#fdfaf4; --bg-b:#f5ecdd;
  --blob-a:#ffd6a2; --blob-b:#f6c7b2; --blob-c:#e6d9f6;
  --surface:rgba(255,253,248,.80); --surface-2:rgba(255,253,248,.96); --surface-3:rgba(255,253,248,.62);
  --border:rgba(84,56,20,.12); --border-2:rgba(84,56,20,.24);
  --text:#2f2418; --text-2:#4e3e2c; --dim:#7c6852;
  --chip:rgba(255,255,255,.66);
  --accent:#c9752a; --accent-2:#a8551f;
  --shadow:0 20px 44px rgba(120,78,26,.11),0 2px 8px rgba(120,78,26,.06);
  --shadow-sm:0 8px 20px rgba(120,78,26,.09);
}

body[data-theme="mono"]{
  --bg-a:#ffffff; --bg-b:#f4f5f7;
  --blob-a:#ffffff; --blob-b:#ffffff; --blob-c:#ffffff;
  --surface:#ffffff; --surface-2:#ffffff; --surface-3:#fafbfc;
  --border:#e4e6eb; --border-2:#c9cdd6;
  --text:#101318; --text-2:#2b303a; --dim:#5c6270;
  --chip:#f6f7f9;
  --accent:#101318; --accent-2:#3d4350;
  --shadow:0 2px 10px rgba(16,19,24,.06); --shadow-sm:0 1px 4px rgba(16,19,24,.06);
}

body{
  font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,"Noto Sans SC",sans-serif;
  font-size:var(--fs);line-height:1.72;color:var(--text);
  background:var(--bg-a);background-image:linear-gradient(178deg,var(--bg-a) 0%,var(--bg-b) 100%);
  background-attachment:fixed;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  min-height:100vh;overflow-x:hidden;
}
body[data-theme="mono"]{background-image:none}

/* ---------------- 背景：柔光虚化 ---------------- */
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bg .blob{position:absolute;border-radius:50%;filter:blur(88px);opacity:.75;will-change:transform}
.bg .b1{width:620px;height:620px;left:-180px;top:-220px;background:var(--blob-a);animation:drift1 26s ease-in-out infinite alternate}
.bg .b2{width:560px;height:560px;right:-170px;top:6%;background:var(--blob-b);animation:drift2 31s ease-in-out infinite alternate}
.bg .b3{width:640px;height:640px;left:32%;bottom:-320px;background:var(--blob-c);animation:drift3 24s ease-in-out infinite alternate}
@keyframes drift1{from{transform:translate3d(0,0,0)}to{transform:translate3d(70px,60px,0)}}
@keyframes drift2{from{transform:translate3d(0,0,0)}to{transform:translate3d(-60px,80px,0)}}
@keyframes drift3{from{transform:translate3d(0,0,0)}to{transform:translate3d(50px,-70px,0)}}
body[data-theme="mono"] .bg{display:none}
@media(prefers-reduced-motion:reduce){.bg .blob{animation:none}}

.page{position:relative;z-index:1;max-width:var(--maxw);margin:0 auto;padding:30px 20px 84px}

/* 原始内容节点：仅作为数据源，不参与渲染 */
.slide-src{display:none}

/* ---------------- 顶栏 ---------------- */
.topbar{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px 22px;align-items:start;
  padding:24px 26px 22px;border-radius:calc(var(--radius) + 10px);
  background:var(--surface);border:1px solid var(--border);
  box-shadow:var(--shadow);
  backdrop-filter:blur(var(--blur)) saturate(1.55);-webkit-backdrop-filter:blur(var(--blur)) saturate(1.55);
}
.brand{display:flex;align-items:center;gap:14px;min-width:0}
.brand .mark{
  width:46px;height:46px;flex:none;border-radius:14px;display:grid;place-items:center;
  color:var(--on-accent);background:linear-gradient(150deg,var(--accent),var(--accent-2));
  box-shadow:0 10px 24px -8px var(--accent);
}
.brand .mark svg{width:24px;height:24px}
.brand .bt{min-width:0}
.kicker{
  margin:0 0 4px;font-size:10.5px;letter-spacing:2.4px;text-transform:uppercase;
  color:var(--dim);font-weight:700;white-space:nowrap;
}
.brand h1{
  margin:0;font-size:clamp(19px,2.3vw,25px);font-weight:800;letter-spacing:.2px;
  line-height:1.3;color:var(--text);white-space:nowrap;
}
.tb-side{display:flex;align-items:center;gap:10px;flex:none}

.viewseg{display:inline-flex;gap:3px;padding:3px;border-radius:11px;background:var(--chip);border:1px solid var(--border)}
.viewseg button{
  display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border:1px solid transparent;border-radius:8px;
  background:transparent;color:var(--dim);cursor:pointer;font:inherit;font-size:12.5px;font-weight:700;
  white-space:nowrap;transition:background .18s,color .18s,box-shadow .18s;
}
.viewseg button svg{width:15px;height:15px;flex:none}
.viewseg button span{flex:none;white-space:nowrap}
.viewseg button:hover{color:var(--text)}
.viewseg button.on{
  color:var(--on-accent);background:linear-gradient(140deg,var(--accent),var(--accent-2));
  box-shadow:0 6px 16px -6px var(--accent);
}
.ibtn{
  display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:10px;
  border:1px solid var(--border);background:var(--chip);color:var(--text-2);cursor:pointer;
  font:inherit;font-size:12.5px;font-weight:700;white-space:nowrap;transition:.18s;
}
.ibtn svg{width:15px;height:15px}
.ibtn:hover{border-color:var(--accent);color:var(--accent);box-shadow:0 6px 16px -8px var(--accent)}

.meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.meta ul{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0}
.meta li{
  display:inline-flex;align-items:center;gap:6px;padding:5px 13px;border-radius:999px;
  background:var(--chip);border:1px solid var(--border);color:var(--text-2);
  font-size:12px;white-space:nowrap;line-height:1.5;
}
.meta b{color:var(--text);font-weight:800}
.meta a{color:var(--accent);text-decoration:none}

/* ---------------- 章节导航 ---------------- */
.toc{
  display:flex;gap:8px;margin:18px 0 0;padding:6px 4px 10px;overflow-x:auto;scrollbar-width:thin;
  -webkit-overflow-scrolling:touch;
}
.toc::-webkit-scrollbar{height:4px}
.toc::-webkit-scrollbar-thumb{background:rgba(120,140,180,.26);border-radius:6px}
.toc:hover::-webkit-scrollbar-thumb{background:rgba(120,140,180,.45)}
.toc button{
  display:inline-flex;align-items:center;gap:8px;flex:none;padding:7px 14px;border-radius:999px;
  border:1px solid var(--border);background:var(--surface-3);color:var(--text-2);cursor:pointer;
  font:inherit;font-size:12.5px;font-weight:600;white-space:nowrap;line-height:1.5;
  transition:.18s;
}
.toc button svg{width:14px;height:14px;flex:none;opacity:.75}.toc button span{flex:none;white-space:nowrap}
.toc button:hover{border-color:var(--accent);color:var(--accent)}
.toc button.on{
  color:var(--on-accent);background:linear-gradient(140deg,var(--accent),var(--accent-2));
  border-color:transparent;box-shadow:0 8px 20px -10px var(--accent);
}
.toc button.on svg{opacity:.95}

/* ---------------- 卡片视图 ---------------- */
.view{display:none}
.view.on{display:block}

.stage-wrap{position:relative;margin-top:6px}
.stage{
  position:relative;height:var(--stage-h);perspective:1700px;transform-style:preserve-3d;
  touch-action:pan-y;
}
.card{
  position:absolute;left:50%;top:50%;width:196px;height:264px;border-radius:var(--radius);
  overflow:hidden;border:1px solid var(--border);background:var(--surface-2);
  box-shadow:var(--shadow-sm);cursor:pointer;
  transition:transform .58s cubic-bezier(.22,.61,.36,1),width .58s cubic-bezier(.22,.61,.36,1),
             height .58s cubic-bezier(.22,.61,.36,1),opacity .45s,border-color .3s,box-shadow .3s;
  will-change:transform,opacity;
}
.card.is-on{
  width:min(860px,calc(100vw - 132px));height:var(--stage-h);
  cursor:default;border-color:var(--border-2);box-shadow:var(--shadow);
}
.cover{
  position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;gap:8px;
  padding:16px 16px 18px;color:#fff;
  background:linear-gradient(150deg,var(--cover-a),var(--cover-b));
}
.cover::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.06),rgba(0,0,0,.34))}
.cover>*{position:relative;z-index:1}
.cover .no{
  position:absolute;top:13px;left:13px;z-index:2;font-size:10.5px;font-weight:800;letter-spacing:.5px;
  padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.26);
  border:1px solid rgba(255,255,255,.34);color:#fff;white-space:nowrap;
}
.cover .rank{position:absolute;top:9px;right:13px;z-index:2;font-size:19px;font-weight:900;opacity:.9;color:#fff}
.cover .nm{
  font-size:13px;font-weight:800;line-height:1.45;color:#fff;white-space:nowrap;overflow:hidden;
  text-overflow:clip;text-shadow:0 1px 6px rgba(0,0,0,.35);
}
.cover .pv{
  font-size:10.5px;line-height:1.5;color:rgba(255,255,255,.86);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
}
.card.is-on .cover{display:none}

.card .body{
  position:absolute;inset:0;display:none;overflow-y:auto;overscroll-behavior:contain;
  padding:26px 30px 30px;background:var(--surface-2);
}
.card.is-on .body{display:block}
.card .body::-webkit-scrollbar{width:9px}
.card .body::-webkit-scrollbar-track{background:transparent}
.card .body::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:9px}

.cb-head{
  position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;
  margin:-26px -30px 16px;padding:15px 30px;
  background:var(--surface-2);border-bottom:1px solid var(--border);
}
.cb-ic{
  width:30px;height:30px;flex:none;border-radius:9px;display:grid;place-items:center;
  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);
}
.cb-ic svg{width:16px;height:16px}
.cb-t{flex:1;min-width:0;font-size:15px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden}
.cb-b{
  flex:none;font-size:11px;font-weight:800;padding:3px 10px;border-radius:999px;white-space:nowrap;
  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);
}

.nav{
  position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;
  display:grid;place-items:center;cursor:pointer;z-index:120;
  border:1px solid var(--border);background:var(--surface-2);color:var(--text-2);
  box-shadow:var(--shadow-sm);transition:.2s;
}
.nav svg{width:20px;height:20px}
.nav:hover{color:var(--accent);border-color:var(--accent);transform:translateY(-50%) scale(1.06)}
.nav.prev{left:-4px}.nav.next{right:-4px}

.dots{display:flex;justify-content:center;align-items:center;gap:7px;margin-top:18px;flex-wrap:wrap}
.dot{
  width:8px;height:8px;padding:0;border-radius:999px;border:1px solid var(--border-2);
  background:transparent;cursor:pointer;transition:.24s;
}
.dot:hover{background:var(--border-2)}
.dot.on{width:24px;background:linear-gradient(90deg,var(--accent),var(--accent-2));border-color:transparent}
.hint{text-align:center;color:var(--dim);font-size:11.5px;margin-top:10px;letter-spacing:.4px;white-space:nowrap}

/* ---------------- 列表视图 ---------------- */
.list{display:flex;flex-direction:column;gap:var(--gap);margin-top:8px}
.item{scroll-margin-top:18px;
  border-radius:calc(var(--radius) + 4px);border:1px solid var(--border);background:var(--surface);
  box-shadow:var(--shadow-sm);overflow:hidden;
  transition:border-color .25s,box-shadow .25s;
}
.item:hover{border-color:var(--border-2)}
.item.flash{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent),var(--shadow-sm)}
.item.jump-in{animation:jumpIn .62s cubic-bezier(.22,.9,.3,1)}
@keyframes jumpIn{0%{transform:scale(.992);opacity:.55}55%{transform:scale(1.003);opacity:1}100%{transform:none;opacity:1}}
.item-head{
  display:flex;align-items:center;gap:12px;padding:15px 20px;cursor:pointer;user-select:none;
  border-bottom:1px solid var(--border);background:var(--surface-3);
}
.item.collapsed .item-head{border-bottom-color:transparent}
.item-head .ic{
  width:32px;height:32px;flex:none;border-radius:10px;display:grid;place-items:center;
  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);
}
.item-head .ic svg{width:17px;height:17px}
.item-head .tt{
  flex:1;min-width:0;font-size:15.5px;font-weight:800;color:var(--text);
  white-space:nowrap;overflow:hidden;text-overflow:clip;
}
.item-head .bd{
  flex:none;font-size:11px;font-weight:800;letter-spacing:.4px;padding:3px 10px;border-radius:999px;
  color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);white-space:nowrap;
}
.item-head .cx{flex:none;width:16px;height:16px;color:var(--dim);transition:transform .28s}
.item.collapsed .item-head .cx{transform:rotate(-90deg)}
.item-body{padding:8px 22px 22px}
.item.collapsed .item-body{display:none}

/* ---------------- 底部条 ---------------- */
.footbar{display:flex;justify-content:center;margin-top:26px}
.toggle{
  display:inline-flex;align-items:center;gap:8px;padding:11px 24px;border-radius:999px;
  border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer;
  font:inherit;font-size:13px;font-weight:700;white-space:nowrap;
  box-shadow:var(--shadow-sm);transition:.2s;
}
.toggle svg{width:16px;height:16px}
.toggle:hover{color:var(--accent);border-color:var(--accent);transform:translateY(-1px)}

/* ---------------- 内容排版 ---------------- */
.body h2,.item-body h2,.body h3,.item-body h3,.body h4,.item-body h4{
  line-height:1.4;letter-spacing:.2px;
}
.slide-h{display:none}

h2{
  font-size:1.26em;font-weight:800;color:var(--text);margin:6px 0 16px;padding:0 0 12px;
  border-bottom:1px solid var(--border);white-space:nowrap;
}
h3{font-size:1.08em;font-weight:800;color:var(--text);margin:20px 0 10px}
h4{
  display:flex;align-items:center;gap:8px;font-size:.95em;font-weight:800;color:var(--accent);
  margin:18px 0 8px;white-space:nowrap;
}
h4::after{content:"";flex:1;height:1px;background:var(--border)}
p{margin:9px 0;color:var(--text-2)}
ul,ol{padding-left:1.35em;margin:9px 0}
li{margin:5px 0;color:var(--text-2)}
li::marker{color:var(--accent)}
b,strong{color:var(--text);font-weight:800}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 38%,transparent);transition:border-color .18s}
a:hover{border-bottom-color:var(--accent)}
code{
  font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  font-size:.88em;padding:1.5px 7px;border-radius:6px;
  background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);
}
blockquote{
  margin:12px 0;padding:10px 16px;border-left:3px solid var(--accent);
  background:color-mix(in srgb,var(--accent) 8%,transparent);border-radius:0 10px 10px 0;color:var(--text-2);
}
.tbl{overflow-x:auto;margin:14px 0;border-radius:12px;border:1px solid var(--border);background:var(--surface-3)}
.tbl::-webkit-scrollbar{height:8px}
.tbl::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:max-content;font-size:.9em}
th,td{
  padding:9px 14px;text-align:left;border-bottom:1px solid var(--border);
  white-space:nowrap;color:var(--text-2);
}
th{
  font-size:.86em;font-weight:800;letter-spacing:.5px;text-transform:none;
  color:var(--dim);background:var(--surface-3);
}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 6%,transparent)}
td:first-child{font-weight:800;color:var(--text)}
tbody tr.goto-row{cursor:pointer}
tbody tr.goto-row td:nth-child(2){color:var(--accent);font-weight:700}
tbody tr.goto-row td:nth-child(2)::after{
  content:"\u2197";display:inline-block;margin-left:6px;font-size:.86em;
  opacity:.38;transition:opacity .16s,transform .16s;
}
tbody tr.goto-row:hover{background:color-mix(in srgb,var(--accent) 12%,transparent)}
tbody tr.goto-row:hover td:nth-child(2){text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1.5px}
tbody tr.goto-row:hover td:nth-child(2)::after{opacity:1;transform:translate(2px,-2px)}
tbody tr.goto-row:active{background:color-mix(in srgb,var(--accent) 20%,transparent)}

p.stars,p.gitee,p.links{
  display:flex;align-items:center;gap:8px;margin:10px 0;padding:8px 14px;border-radius:10px;
  font-size:.95em;white-space:nowrap;overflow-x:auto;
}
p.stars{background:color-mix(in srgb,#f5a623 14%,transparent);color:#a06a00;border:1px solid color-mix(in srgb,#f5a623 32%,transparent)}
p.gitee{background:color-mix(in srgb,#e06a6a 12%,transparent);color:#a53434;border:1px solid color-mix(in srgb,#e06a6a 30%,transparent)}
p.links{background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--text-2);border:1px solid var(--border)}
body[data-theme="night"] p.stars,body[data-theme="aurora"] p.stars{color:#ffcf6b}
body[data-theme="night"] p.gitee,body[data-theme="aurora"] p.gitee{color:#ff9b9b}

/* ---------------- 样式面板 ---------------- */
.scrim{
  position:fixed;inset:0;z-index:200;background:rgba(10,16,32,.28);opacity:0;pointer-events:none;
  transition:opacity .26s;
}
.scrim.on{opacity:1;pointer-events:auto}
.panel{
  position:fixed;top:0;right:0;bottom:0;z-index:210;width:min(342px,92vw);
  display:flex;flex-direction:column;
  background:var(--surface-2);border-left:1px solid var(--border);
  box-shadow:-22px 0 60px rgba(12,22,46,.20);
  transform:translateX(102%);transition:transform .32s cubic-bezier(.3,.7,.3,1);
  backdrop-filter:blur(26px) saturate(1.6);-webkit-backdrop-filter:blur(26px) saturate(1.6);
}
body[data-theme="night"] .panel,body[data-theme="aurora"] .panel{box-shadow:-22px 0 60px rgba(0,0,0,.5)}
.panel.on{transform:none}
.panel-head{
  display:flex;align-items:center;gap:10px;padding:18px 20px;border-bottom:1px solid var(--border);flex:none;
}
.panel-head .t{flex:1;font-size:14px;font-weight:800;color:var(--text);white-space:nowrap}
.panel-head .x{
  width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:9px;cursor:pointer;
  border:1px solid var(--border);background:transparent;color:var(--dim);transition:.18s;
}
.panel-head .x svg{width:14px;height:14px}
.panel-head .x:hover{color:var(--text);border-color:var(--border-2)}
.panel-body{flex:1;overflow-y:auto;padding:18px 20px 28px}
.panel-body::-webkit-scrollbar{width:8px}
.panel-body::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:8px}
.sec-t{
  font-size:11px;font-weight:800;letter-spacing:1.4px;color:var(--dim);text-transform:uppercase;
  margin:0 0 10px;white-space:nowrap;
}
.sec-t+.sec-t{margin-top:22px}

.themes{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.theme{
  position:relative;display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:11px;
  border:1px solid var(--border);background:var(--surface-3);cursor:pointer;font:inherit;
  transition:.18s;text-align:left;
}
.theme:hover{border-color:var(--border-2)}
.theme.on{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 20%,transparent)}
.theme .sw{width:26px;height:26px;flex:none;border-radius:8px;border:1px solid rgba(0,0,0,.08);position:relative;overflow:hidden}
.theme .sw::after{content:"";position:absolute;right:-6px;bottom:-6px;width:16px;height:16px;border-radius:50%;background:var(--sw2,#fff);opacity:.9}
.theme .tn{font-size:12.5px;font-weight:700;color:var(--text-2);white-space:nowrap}
.theme.on .tn{color:var(--text)}
.theme .ck{position:absolute;top:6px;right:7px;width:13px;height:13px;color:var(--accent);opacity:0}
.theme.on .ck{opacity:1}

.accents{display:flex;flex-wrap:wrap;gap:9px}
.acc{
  width:26px;height:26px;padding:0;border-radius:50%;cursor:pointer;border:2px solid transparent;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.10);transition:.16s;
}
.acc:hover{transform:scale(1.1)}
.acc.on{border-color:var(--text);box-shadow:0 0 0 2px var(--surface-2) inset,inset 0 0 0 1px rgba(0,0,0,.1)}

.row{margin-top:16px}
.row .lb{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.row .lb span{font-size:12.5px;font-weight:700;color:var(--text-2);white-space:nowrap}
.row .lb em{font-style:normal;font-size:11.5px;font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
input[type=range]{
  -webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:4px;outline:none;
  background:var(--border-2);cursor:pointer;
}
input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;width:15px;height:15px;border-radius:50%;
  background:var(--accent);border:2.5px solid var(--surface-2);
  box-shadow:0 2px 6px rgba(0,0,0,.22);cursor:pointer;
}
.reset{
  display:flex;align-items:center;justify-content:center;gap:7px;width:100%;margin-top:24px;
  padding:10px;border-radius:10px;border:1px solid var(--border);background:transparent;
  color:var(--dim);cursor:pointer;font:inherit;font-size:12.5px;font-weight:700;white-space:nowrap;transition:.18s;
}
.reset svg{width:14px;height:14px}
.reset:hover{color:var(--accent);border-color:var(--accent)}

/* ---------------- 自定义背景 ---------------- */
.bgseg{display:flex;gap:6px;margin:8px 0 10px}
.bgseg button{
  flex:1;padding:7px 4px;border-radius:9px;border:1px solid var(--border);
  background:var(--surface-3);color:var(--text-2);font:inherit;font-size:12px;font-weight:700;
  cursor:pointer;transition:.16s;white-space:nowrap;
}
.bgseg button:hover{border-color:var(--accent);color:var(--accent)}
.bgseg button.on{
  background:linear-gradient(140deg,var(--accent),var(--accent-2));color:var(--on-accent);
  border-color:transparent;box-shadow:0 6px 14px -8px var(--accent);
}
.bgbox{display:flex;flex-direction:column;gap:8px;margin:2px 0 12px}
.bgbox[hidden]{display:none}
.bgbox .bgrow{display:flex;gap:6px;align-items:center}
#bgColor{
  width:46px;height:32px;padding:0;border:1px solid var(--border-2);border-radius:8px;
  background:transparent;cursor:pointer;flex:none;
}
.bghint{font-size:11.5px;color:var(--dim);line-height:1.5}
.bgup{
  display:flex;align-items:center;justify-content:center;padding:9px 10px;
  border:1px dashed var(--border-2);border-radius:9px;background:var(--surface-3);
  color:var(--text-2);font-size:12px;font-weight:700;cursor:pointer;transition:.16s;
}
.bgup:hover{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 7%,transparent)}
#bgUrl{
  flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--border);
  background:var(--surface-2);color:var(--text);font:inherit;font-size:11.5px;
}
#bgUrl:focus{outline:none;border-color:var(--accent)}
.bgbtn{
  padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface-3);
  color:var(--text-2);font:inherit;font-size:11.5px;font-weight:700;cursor:pointer;flex:none;transition:.16s;
}
.bgbtn:hover{border-color:var(--accent);color:var(--accent)}
.bgbtn.wide{width:100%}
.bgbtn.wide:hover{border-color:#e0556f;color:#e0556f}

/* ---------------- 内嵌模式：背景透明，交给外层壁纸窗口 ---------------- */
html[data-embed] body{background:transparent!important;background-image:none!important}
html[data-embed] .bg{display:none}
html[data-embed] .page{padding:14px 14px 34px;width:100%;max-width:var(--maxw);margin:0 auto}
html[data-embed] .topbar{padding:16px 18px 15px;border-radius:14px;box-shadow:0 8px 22px -14px rgba(20,36,64,.35)}
html[data-embed] .brand .mark{width:38px;height:38px;border-radius:11px}
html[data-embed] .brand h1{font-size:19px}
html[data-embed] .kicker{font-size:10px;letter-spacing:.6px}
html[data-embed] .hint,html[data-embed] .footbar .toggle{display:none}
html[data-embed] .footbar{margin-top:12px}
html[data-embed] .toc{top:8px}
html[data-embed] .panel{width:min(320px,82vw)}
/* 嵌在壁纸窗口里时横向空间紧，表格收一下内边距，免得撑出横向滚动条 */
html[data-embed] th,html[data-embed] td{padding:8px 10px}

/* ---------------- 响应式 ---------------- */
@media(max-width:860px){
  .topbar{grid-template-columns:1fr;padding:18px 18px 16px}
  .tb-side{justify-content:flex-start}
  .brand h1{white-space:normal;font-size:19px}
  .kicker{white-space:normal}
  :root{--stage-h:min(68vh,540px)}
  .card.is-on{width:calc(100vw - 64px)}
  .nav{display:none}
  .card .body{padding:20px 18px 24px}
  .cb-head{margin:-20px -18px 14px;padding:13px 18px}
  .item-body{padding:4px 16px 18px}
}
@media(max-width:520px){
  .page{padding:16px 12px 70px}
  .brand .mark{width:38px;height:38px;border-radius:12px}
  .brand .mark svg{width:20px;height:20px}
  .brand h1{font-size:17px}
  .viewseg button{padding:6px 10px;font-size:11.5px}
  .ibtn{padding:7px 11px;font-size:11.5px}
  .ibtn .tx{display:none}
  .hint{font-size:10.5px}
  .toc button{font-size:11.5px;padding:6px 11px}
}

/* ---------------- 打印 ---------------- */
@media print{
  body{background:#fff;color:#111}
  .bg,.panel,.scrim,.toc,.footbar,.viewseg,.ibtn,.nav,.dots,.hint{display:none!important}
  .page{max-width:none;padding:0}
  .topbar{background:#fff;border:1px solid #ddd;box-shadow:none;backdrop-filter:none}
  .card,.item{background:#fff;box-shadow:none;border:1px solid #ddd;backdrop-filter:none;break-inside:avoid}
  .view.v-cards{display:none!important}
  .view.v-list{display:block!important}
  .item-body{display:block!important}
}
`;
}

/* ------------------------------------------------------------------- 脚本 */

function reportScript() {
  return [
    '(function(){',
    '  var doc=document;',
    '  var srcs=[].slice.call(doc.querySelectorAll(".slide-src"));',
    '  if(!srcs.length)return;',
    '  var ICONS=' + JSON.stringify({
      package: ICONS.package,
      grid: ICONS.grid,
      compass: ICONS.compass,
      trend: ICONS.trend,
      rule: ICONS.rule,
      layers: ICONS.layers,
      list: ICONS.list,
      sliders: ICONS.sliders,
      expand: ICONS.expand,
      collapse: ICONS.collapse,
      close: ICONS.close,
      reset: ICONS.reset,
      check: ICONS.check,
      arrowL: ICONS.arrowL,
      arrowR: ICONS.arrowR
    }) + ';',
    '  var EMO=' + JSON.stringify(EMOJI_MAP) + ';',
    '  var data=srcs.map(function(el){',
    '    return {',
    '      kind:el.getAttribute("data-kind")||"section",',
    '      rank:el.getAttribute("data-rank")||"",',
    '      icon:el.getAttribute("data-icon")||"",',
    '      title:el.getAttribute("data-title")||"",',
    '      name:el.getAttribute("data-name")||"",',
    '      short:el.getAttribute("data-short")||"",',
    '      preview:el.getAttribute("data-preview")||"",',
    '      html:el.innerHTML',
    '    };',
    '  });',
    '',
    '  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
    '  function iconOf(m){var k=EMO[m.icon]||(m.kind==="project"?"package":"layers");return ICONS[k]||ICONS.grid;}',
    '',
    '  var stage=doc.getElementById("stage");',
    '  var dotsEl=doc.getElementById("dots");',
    '  var listEl=doc.getElementById("listView");',
    '  var tocEl=doc.getElementById("toc");',
    '  var viewCards=doc.getElementById("viewCards");',
    '  var viewList=doc.getElementById("viewList");',
    '  var btnExpand=doc.getElementById("btnExpand");',
    '  var btnExpandTx=doc.getElementById("btnExpandTx");',
    '  var btnExpandIc=doc.getElementById("btnExpandIc");',
    '',
    '  var cards=[];',
    '  var dots=[];',
    '  var tocBtns=[];',
    '  var act=0;',
    '  var mode="cards";',
    '',
    '  function palette(i){',
    '    var P=[["#4f7df3","#8b5cf6"],["#0ea5a5","#3b82f6"],["#f0913a","#e0556f"],',
    '           ["#6366f1","#22b8cf"],["#8b5cf6","#ec4899"],["#0d9488","#65a30d"],',
    '           ["#3b82f6","#06b6d4"],["#f43f5e","#f59e0b"],["#7c3aed","#2563eb"],["#0f766e","#0891b2"]];',
    '    return P[i%P.length];',
    '  }',
    '',
    '  /* ---------- 卡片 ---------- */',
    '  data.forEach(function(m,i){',
    '    var el=doc.createElement("div");el.className="card";',
    '    var p=palette(i);',
    '    var cov=doc.createElement("div");cov.className="cover";',
    '    cov.style.setProperty("--cover-a",p[0]);cov.style.setProperty("--cover-b",p[1]);',
    '    var no=doc.createElement("span");no.className="no";',
    '    no.textContent=(m.kind==="project")?("项目 "+m.rank):m.title;',
    '    var rk=doc.createElement("span");rk.className="rank";',
    '    rk.textContent=(m.kind==="project")?("#"+m.rank):"";',
    '    var nm=doc.createElement("div");nm.className="nm";nm.setAttribute("data-fit","");',
    '    nm.textContent=m.kind==="project"?(m.short||m.title):m.title;',
    '    var pv=doc.createElement("div");pv.className="pv";',
    '    pv.textContent=m.preview||"点击查看完整内容";',
    '    cov.appendChild(no);cov.appendChild(rk);cov.appendChild(nm);cov.appendChild(pv);',
    '    var bd=doc.createElement("div");bd.className="body";',
    '    el.appendChild(cov);el.appendChild(bd);',
    '    el.addEventListener("click",function(){if(i!==act)go(i);});',
    '    stage.appendChild(el);cards.push(el);',
    '  });',
    '',
    '  /* ---------- 圆点 ---------- */',
    '  data.forEach(function(m,i){',
    '    var d=doc.createElement("button");d.className="dot";d.type="button";',
    '    d.setAttribute("aria-label","第 "+(i+1)+" 项");',
    '    d.addEventListener("click",function(){if(i!==act)go(i);});',
    '    dotsEl.appendChild(d);dots.push(d);',
    '  });',
    '',
    '  /* ---------- 章节导航 ---------- */',
    '  data.forEach(function(m,i){',
    '    var b=doc.createElement("button");b.type="button";',
    '    var label=(m.kind==="project")?("#"+m.rank+" "+(m.short||m.title)):m.title;',
    '    b.innerHTML=iconOf(m)+"<span>"+esc(label)+"</span>";',
    '    b.addEventListener("click",function(){',
    '      if(mode==="list"){scrollToItem(i);}else{go(i);}',
    '    });',
    '    tocEl.appendChild(b);tocBtns.push(b);',
    '  });',
    '',
    '  /* ---------- 列表 ---------- */',
    '  function buildList(){',
    '    var h="";',
    '    data.forEach(function(m,i){',
    '      h+=\'<article class="item" id="item-\'+i+\'" data-i="\'+i+\'">\'',
    '        +\'<header class="item-head" role="button" tabindex="0">\'',
    '        +\'<span class="ic">\'+iconOf(m)+\'</span>\'',
    '        +\'<span class="tt" data-fit>\'+esc((m.kind==="project")?("项目 "+m.rank+" · "+(m.name||m.title)):m.title)+\'</span>\'',
    '        +\'<span class="bd">\'+((m.kind==="project")?("#"+m.rank):"章节")+\'</span>\'',
    '        +\'<svg class="cx" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>\'',
    '        +\'</header>\'',
    '        +\'<div class="item-body">\'+(m.html||"")+\'</div>\'',
    '        +\'</article>\';',
    '    });',
    '    listEl.innerHTML=h;',
    '    [].forEach.call(listEl.querySelectorAll(".item"),function(it){',
    '      var head=it.querySelector(".item-head");',
    '      function tog(){it.classList.toggle("collapsed");}',
    '      head.addEventListener("click",tog);',
    '      head.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();tog();}});',
    '    });',
    '    markGoto(listEl);',
    '  }',
    '',
    '  function fill(k){',
    '    var bd=cards[k].querySelector(".body");',
    '    if(bd&&!bd.getAttribute("data-filled")){',
    '      bd.setAttribute("data-filled","1");',
    '      var m=data[k];',
    '      var lab=(m.kind==="project")?("项目 "+m.rank+" · "+(m.name||m.title)):m.title;',
    '      var bg=(m.kind==="project")?("#"+m.rank):"章节";',
    '      bd.innerHTML=\'<div class="cb-head"><span class="cb-ic">\'+iconOf(m)+\'</span>\'',
    '        +\'<span class="cb-t" data-fit>\'+esc(lab)+\'</span>\'',
    '        +\'<span class="cb-b">\'+bg+\'</span></div>\'',
    '        +(m.html||"");',
    '      markGoto(bd);',
    '      setTimeout(fitAll,30);',
    '    }',
    '  }',
    '',
    '  function layout(){',
    '    var N=data.length;',
    '    var w=stage.clientWidth||900;',
    '    var activeW=Math.min(860,w-40);',
    '    var sideW=196;',
    '    var gap=activeW/2+sideW/2+30;',
    '    for(var k=0;k<N;k++){',
    '      var d=k-act;',
    '      if(d>N/2)d-=N; if(d<-N/2)d+=N;',
    '      var abs=Math.abs(d),dir=d===0?0:(d>0?1:-1);',
    '      var x=dir*(abs===0?0:(gap+(abs-1)*(sideW+22)));',
    '      var sc=abs===0?1:Math.max(.62,1-abs*.1);',
    '      var op=abs===0?1:(abs===1?.5:(abs===2?.2:0));',
    '      var z=-abs*70;',
    '      cards[k].style.transform="translate(-50%,-50%) translateX("+x+"px) translateZ("+z+"px) scale("+sc+")";',
    '      cards[k].style.opacity=op;',
    '      cards[k].style.zIndex=100-abs;',
    '      cards[k].style.pointerEvents=abs>2?"none":"auto";',
    '    }',
    '  }',
    '',
    '  function activate(){',
    '    for(var k=0;k<cards.length;k++){',
    '      var on=(k===act);',
    '      cards[k].classList.toggle("is-on",on);',
    '      if(on)fill(k);',
    '    }',
    '    dots.forEach(function(d,i){d.classList.toggle("on",i===act);});',
    '    tocBtns.forEach(function(b,i){b.classList.toggle("on",i===act);});',
    '  }',
    '',
    '  function go(n){',
    '    act=((n%data.length)+data.length)%data.length;',
    '    layout();activate();',
    '  }',
    '',
    '  function smoothTo(y){',
    '    var sc=doc.scrollingElement||doc.documentElement;',
    '    var els=[doc.documentElement,doc.body];',
    '    var prev=els.map(function(e){return e?e.style.scrollBehavior:"";});',
    '    els.forEach(function(e){if(e)e.style.scrollBehavior="auto";});',
    '    function restore(){els.forEach(function(e,i){if(e)e.style.scrollBehavior=prev[i];});}',
    '    var start=sc.scrollTop,dist=y-start;',
    '    if(Math.abs(dist)<2){sc.scrollTop=y;restore();return;}',
    '    var dur=Math.min(520,220+Math.abs(dist)*.09),t0=0;',
    '    function step(t){',
    '      if(!t0)t0=t;',
    '      var p=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-p,3);',
    '      sc.scrollTop=start+dist*e;',
    '      if(p<1)requestAnimationFrame(step);else {sc.scrollTop=y;restore();}',
    '    }',
    '    requestAnimationFrame(step);',
    '  }',
    '  function scrollToItem(i){',
    '    var it=doc.getElementById("item-"+i);',
    '    if(!it)return;',
    '    var sc=doc.scrollingElement||doc.documentElement;',
    '    var y=it.getBoundingClientRect().top+sc.scrollTop-14;',
    '    smoothTo(y);',
    '    it.classList.add("flash");',
    '    setTimeout(function(){it.classList.remove("flash");},1200);',
    '    act=i;',
    '    tocBtns.forEach(function(b,k){b.classList.toggle("on",k===i);});',
    '  }',
    '',
    '  /* ---------- 总览表格：点项目名跳到对应详情 ---------- */',
    '  function findProject(name,rankText){',
    '    var mm=String(rankText||"").match(/(\\d+)/);',
    '    var rk=mm?mm[1]:"";',
    '    var i,m;',
    '    if(name){',
    '      for(i=0;i<data.length;i++){',
    '        m=data[i];',
    '        if(m.kind!=="project"||!m.name)continue;',
    '        if(m.name===name||m.name.indexOf(name)>=0||name.indexOf(m.name)>=0)return i;',
    '      }',
    '    }',
    '    if(rk){',
    '      for(i=0;i<data.length;i++){',
    '        if(data[i].kind==="project"&&String(data[i].rank)===rk)return i;',
    '      }',
    '    }',
    '    return -1;',
    '  }',
    '  function markGoto(root){',
    '    if(!root)return;',
    '    [].forEach.call(root.querySelectorAll("table tbody tr"),function(tr){',
    '      if(tr.getAttribute("data-goto")!==null)return;',
    '      var td=tr.children;',
    '      if(!td||td.length<2)return;',
    '      var idx=findProject((td[1].textContent||"").trim(),(td[0].textContent||"").trim());',
    '      if(idx<0)return;',
    '      tr.setAttribute("data-goto",String(idx));',
    '      tr.classList.add("goto-row");',
    '      tr.setAttribute("title","点击查看该项目的详细分析");',
    '    });',
    '  }',
    '  function gotoProject(idx){',
    '    if(!(idx>=0)||idx>=data.length)return;',
    '    if(mode==="list"){',
    '      var it=doc.getElementById("item-"+idx);',
    '      if(it){it.classList.remove("collapsed");}',
    '      scrollToItem(idx);',
    '    }else{',
    '      go(idx);',
    '    }',
    '    var cur=doc.getElementById("item-"+idx);',
    '    if(cur){',
    '      cur.classList.add("jump-in");',
    '      setTimeout(function(){cur.classList.remove("jump-in");},620);',
    '    }',
    '  }',
    '',
    '  doc.addEventListener("click",function(e){',
    '    var t=e.target;',
    '    if(!t||!t.closest)return;',
    '    var tr=t.closest("tbody tr");',
    '    if(!tr)return;',
    '    var gi=tr.getAttribute("data-goto");',
    '    if(gi===null)return;',
    '    e.preventDefault();',
    '    gotoProject(parseInt(gi,10));',
    '  });',
    '',
    '  /* ---------- 视图切换：唯一的显隐控制入口 ---------- */',
    '  function setMode(m,noScroll){',
    '    mode=m;',
    '    var isList=(m==="list");',
    '    viewCards.classList.toggle("on",!isList);',
    '    viewList.classList.toggle("on",isList);',
    '    doc.querySelectorAll(".viewseg button").forEach(function(b){',
    '      b.classList.toggle("on",b.getAttribute("data-v")===m);',
    '    });',
    '    btnExpandTx.textContent=isList?"返回卡片浏览":"展开全部内容";',
    '    btnExpandIc.innerHTML=isList?ICONS.collapse:ICONS.expand;',
    '    if(isList){',
    '      openItems();',
    '      setTimeout(function(){fitAll();},80);',
    '      if(!noScroll)setTimeout(function(){scrollToItem(act);},60);',
    '    }else{',
    '      requestAnimationFrame(function(){layout();activate();});',
    '    }',
    '  }',
    '  function openItems(){',
    '    [].forEach.call(listEl.querySelectorAll(".item"),function(it){it.classList.remove("collapsed");});',
    '  }',
    '',
    '  doc.querySelectorAll(".viewseg button").forEach(function(b){',
    '    b.addEventListener("click",function(){setMode(b.getAttribute("data-v"));});',
    '  });',
    '  btnExpand.addEventListener("click",function(){setMode(mode==="list"?"cards":"list");});',
    '  doc.getElementById("btnPrev").addEventListener("click",function(){go(act-1);});',
    '  doc.getElementById("btnNext").addEventListener("click",function(){go(act+1);});',
    '',
    '  doc.addEventListener("keydown",function(e){',
    '    if(mode!=="cards")return;',
    '    if(e.target&&/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))return;',
    '    if(e.key==="ArrowLeft")go(act-1);',
    '    else if(e.key==="ArrowRight")go(act+1);',
    '  });',
    '',
    '  var dragging=false,startX=0,moved=0;',
    '  stage.addEventListener("pointerdown",function(e){dragging=true;startX=e.clientX;moved=0;});',
    '  stage.addEventListener("pointermove",function(e){if(dragging)moved=e.clientX-startX;});',
    '  doc.addEventListener("pointerup",function(){',
    '    if(!dragging)return;',
    '    dragging=false;',
    '    if(Math.abs(moved)>45)go(act+(moved<0?1:-1));',
    '    moved=0;',
    '  });',
    '',
    '  /* ---------- 样式面板 ---------- */',
    '  var KEY="gh-report-style-v1";',
    '  var DEF={theme:"clear",accent:"",blur:20,radius:18,fs:15,maxw:1120,bgMode:"default",bgColor:"#0d1526",bgImage:""};',
    '  var st=Object.assign({},DEF);',
    '  try{var raw=localStorage.getItem(KEY);if(raw)st=Object.assign(st,JSON.parse(raw));}catch(e){}',
    '',
    '  var ACCENTS=["","#2f6fd6","#0e9aa8","#16a34a","#c9752a","#e0556f","#8b5cf6","#111318"];',
    '  var accWrap=doc.getElementById("accents");',
    '  ACCENTS.forEach(function(c){',
    '    var b=doc.createElement("button");b.type="button";b.className="acc";',
    '    b.style.background=c||"linear-gradient(135deg,#2f6fd6,#7c5cff)";',
    '    b.setAttribute("data-c",c);',
    '    b.title=c?c:"跟随主题";',
    '    b.addEventListener("click",function(){st.accent=c;apply();save();});',
    '    accWrap.appendChild(b);',
    '  });',
    '',
    '  var RANGES=[',
    '    {k:"blur",min:0,max:40,step:1,unit:"px",label:"背景虚化"},',
    '    {k:"radius",min:0,max:30,step:1,unit:"px",label:"卡片圆角"},',
    '    {k:"fs",min:13,max:19,step:1,unit:"px",label:"正文字号"},',
    '    {k:"maxw",min:680,max:1440,step:20,unit:"px",label:"内容宽度"}',
    '  ];',
    '  var rangeWrap=doc.getElementById("ranges");',
    '  RANGES.forEach(function(r){',
    '    var row=doc.createElement("div");row.className="row";',
    '    var lb=doc.createElement("div");lb.className="lb";',
    '    var nm=doc.createElement("span");nm.textContent=r.label;',
    '    var val=doc.createElement("em");val.textContent=st[r.k]+r.unit;',
    '    lb.appendChild(nm);lb.appendChild(val);',
    '    var inp=doc.createElement("input");',
    '    inp.type="range";inp.min=r.min;inp.max=r.max;inp.step=r.step;inp.value=st[r.k];',
    '    inp.addEventListener("input",function(){',
    '      st[r.k]=+inp.value;',
    '      val.textContent=inp.value+r.unit;',
    '      apply();save();',
    '    });',
    '    row.appendChild(lb);row.appendChild(inp);',
    '    rangeWrap.appendChild(row);',
    '  });',
    '',
    '  function shade(hex,amt){',
    '    var s=String(hex||"").replace("#","");',
    '    if(s.length<6)return hex;',
    '    var n=parseInt(s.slice(0,6),16);',
    '    if(isNaN(n))return hex;',
    '    var r=(n>>16)&255,g=(n>>8)&255,b=n&255;',
    '    function f(v){v=Math.max(0,Math.min(255,Math.round(v+255*amt)));return ("0"+v.toString(16)).slice(-2);}',
    '    return "#"+f(r)+f(g)+f(b);',
    '  }',
    '  function apply(){',
    '    doc.body.setAttribute("data-theme",st.theme||"clear");',
    '    var bs=doc.body.style,el=doc.documentElement.style;',
    '    var isDark=(st.theme==="night"||st.theme==="aurora");',
    '    if(st.accent){',
    '      bs.setProperty("--accent",st.accent);',
    '      bs.setProperty("--accent-2",shade(st.accent,isDark?0.18:-0.16));',
    '    }else{',
    '      bs.removeProperty("--accent");bs.removeProperty("--accent-2");',
    '    }',
    '    el.setProperty("--blur",st.blur+"px");',
    '    el.setProperty("--radius",st.radius+"px");',
    '    el.setProperty("--fs",st.fs+"px");',
    '    el.setProperty("--maxw",st.maxw+"px");',
    '    doc.querySelectorAll(".theme").forEach(function(b){',
    '      b.classList.toggle("on",b.getAttribute("data-t")===st.theme);',
    '    });',
    '    doc.querySelectorAll(".acc").forEach(function(b){',
    '      b.classList.toggle("on",(b.getAttribute("data-c")||"")===st.accent);',
    '    });',
    '    if(mode==="cards")requestAnimationFrame(layout);',
    '    bgApply();',
    '  }',
    '',
    '  function bgApply(){',
    '    var b=doc.body,bg=doc.querySelector(".bg");',
    '    if(!st.bgMode)st.bgMode="default";',
    '    b.style.removeProperty("background-image");',
    '    b.style.removeProperty("background-size");',
    '    b.style.removeProperty("background-position");',
    '    b.style.removeProperty("background-repeat");',
    '    b.style.removeProperty("background-attachment");',
    '    b.style.removeProperty("background-color");',
    '    if(st.bgMode==="color"&&st.bgColor){',
    '      b.style.setProperty("background-color",st.bgColor,"important");',
    '      b.style.setProperty("background-image","none","important");',
    '      if(bg)bg.style.display="none";',
    '    }else if(st.bgMode==="image"&&st.bgImage){',
    '      b.style.setProperty("background-image","url(\'"+st.bgImage+"\')","important");',
    '      b.style.setProperty("background-size","cover","important");',
    '      b.style.setProperty("background-position","center","important");',
    '      b.style.setProperty("background-repeat","no-repeat","important");',
    '      b.style.setProperty("background-attachment","fixed","important");',
    '      if(bg)bg.style.display="none";',
    '    }else{',
    '      if(bg)bg.style.display="";',
    '    }',
    '  }',
    '  function syncBgUI(){',
    '    var m=st.bgMode||"default";',
    '    doc.querySelectorAll("#bgSeg button").forEach(function(x){',
    '      x.classList.toggle("on",x.getAttribute("data-bg")===m);',
    '    });',
    '    doc.getElementById("bgColorBox").hidden=(m!=="color");',
    '    doc.getElementById("bgImageBox").hidden=(m!=="image");',
    '    var ci=doc.getElementById("bgColor");',
    '    if(ci&&st.bgColor&&st.bgColor.length===7)ci.value=st.bgColor;',
    '    var msg=doc.getElementById("bgMsg");',
    '    if(msg&&st.bgMode!=="image")msg.textContent="";',
    '  }',
    '  function save(){try{localStorage.setItem(KEY,JSON.stringify(st));return true;}catch(e){return false;}}',
    '',
    '  doc.querySelectorAll(".theme").forEach(function(b){',
    '    b.addEventListener("click",function(){',
    '      st.theme=b.getAttribute("data-t");',
    '      st.accent="";',
    '      apply();save();',
    '    });',
    '  });',
    '',
    '  doc.querySelectorAll("#bgSeg button").forEach(function(b){',
    '    b.addEventListener("click",function(){',
    '      st.bgMode=b.getAttribute("data-bg");',
    '      if(st.bgMode==="color"&&!st.bgColor)st.bgColor="#0d1526";',
    '      bgApply();syncBgUI();save();',
    '    });',
    '  });',
    '  doc.getElementById("bgColor").addEventListener("input",function(e){',
    '    st.bgColor=e.target.value;st.bgMode="color";',
    '    bgApply();syncBgUI();save();',
    '  });',
    '  doc.getElementById("bgUseUrl").addEventListener("click",function(){',
    '    var v=(doc.getElementById("bgUrl").value||"").trim();',
    '    if(!v)return;',
    '    st.bgImage=v;st.bgMode="image";',
    '    bgApply();syncBgUI();save();',
    '  });',
    '  doc.getElementById("bgClear").addEventListener("click",function(){',
    '    st.bgMode="default";st.bgImage="";',
    '    bgApply();syncBgUI();save();',
    '  });',
    '  doc.getElementById("bgFile").addEventListener("change",function(e){',
    '    var f=e.target.files&&e.target.files[0];',
    '    if(!f)return;',
    '    var msg=doc.getElementById("bgMsg");',
    '    var fr=new FileReader();',
    '    fr.onload=function(){',
    '      var img=new Image();',
    '      img.onload=function(){',
    '        var max=1600,w=img.width,h=img.height;',
    '        if(w>max||h>max){var rt=Math.min(max/w,max/h);w=Math.round(w*rt);h=Math.round(h*rt);}',
    '        var cv=doc.createElement("canvas");cv.width=w;cv.height=h;',
    '        cv.getContext("2d").drawImage(img,0,0,w,h);',
    '        st.bgImage=cv.toDataURL("image/jpeg",0.82);',
    '        st.bgMode="image";',
    '        bgApply();syncBgUI();',
    '        if(!save()){',
    '          st.bgImage=cv.toDataURL("image/jpeg",0.6);',
    '          bgApply();',
    '          if(!save()&&msg)msg.textContent="图片偏大，浏览器存不下，刷新后会丢失，建议换小一点的图";',
    '        }else if(msg){',
    '          msg.textContent="已应用（"+Math.round(st.bgImage.length/1024)+"KB）";',
    '        }',
    '      };',
    '      img.src=fr.result;',
    '    };',
    '    fr.readAsDataURL(f);',
    '  });',
    '',
    '  doc.getElementById("btnReset").addEventListener("click",function(){',
    '    st=Object.assign({},DEF);',
    '    apply();syncBgUI();save();',
    '    doc.querySelectorAll("#ranges .row").forEach(function(row,i){',
    '      var r=RANGES[i];',
    '      var inp=row.querySelector("input");',
    '      inp.value=st[r.k];',
    '      row.querySelector(".lb em").textContent=st[r.k]+r.unit;',
    '    });',
    '  });',
    '',
    '  var panel=doc.getElementById("stylePanel"),scrim=doc.getElementById("scrim");',
    '  function openPanel(){panel.classList.add("on");scrim.classList.add("on");}',
    '  function closePanel(){panel.classList.remove("on");scrim.classList.remove("on");}',
    '  doc.getElementById("btnStyle").addEventListener("click",openPanel);',
    '  doc.getElementById("btnClosePanel").addEventListener("click",closePanel);',
    '  scrim.addEventListener("click",closePanel);',
    '  doc.addEventListener("keydown",function(e){if(e.key==="Escape")closePanel();});',
    '',
    '  /* ---------- 启动 ---------- */',
    '  buildList();',
    '  apply();',
    '  syncBgUI();',
    '  var narrow=window.innerWidth<860;',
    '  setMode(narrow?"list":"cards",true);',
    '  if(!narrow){layout();activate();}',
    '  window.addEventListener("resize",function(){',
    '    if(mode==="cards")layout();',
    '    fitAll();',
    '  });',
    '  function fitAll(){',
    '    [].forEach.call(doc.querySelectorAll("[data-fit]"),function(el){',
    '      el.style.fontSize="";',
    '      var avail=el.clientWidth;',
    '      if(avail>0&&el.scrollWidth>avail+1){',
    '        var cur=parseFloat(getComputedStyle(el).fontSize)||15;',
    '        el.style.fontSize=Math.max(10,Math.floor(cur*avail/el.scrollWidth*10)/10)+"px";',
    '      }',
    '    });',
    '  }',
    '  setTimeout(fitAll,50);',
    '})();'
  ].join('\n');
}

/* --------------------------------------------------------------- 页面拼装 */

function buildReportPage(o) {
  const head = String(o.headHtml || '');
  const m = head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  let titleText = m ? m[1] : (o.title || '分析报告');
  const rest = m ? head.replace(m[0], '') : head;
  titleText = titleText.replace(/<[^>]+>/g, '').replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim();

  const themeBtns = [
    { k: 'clear', n: '清爽', a: '#ffffff', b: '#dfe8f7' },
    { k: 'night', n: '暗夜', a: '#141b2e', b: '#2b3a5e' },
    { k: 'aurora', n: '极光', a: '#2a2a6e', b: '#7c5cff' },
    { k: 'warm', n: '暖阳', a: '#fdf3e2', b: '#e8b877' },
    { k: 'mono', n: '墨白', a: '#ffffff', b: '#111318' }
  ].map(t => `<button class="theme" type="button" data-t="${t.k}">
      <span class="sw" style="background:linear-gradient(140deg,${t.a},${t.b});--sw2:${t.b}"></span>
      <span class="tn">${t.n}</span>
      <span class="ck">${ICONS.check}</span>
    </button>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAttr(o.title || titleText || '分析报告')}</title>
<script>try{if(/[?&]embed=1/.test(location.search))document.documentElement.setAttribute('data-embed','1');}catch(e){}</script>
<style>${reportCss()}</style>
</head>
<body data-theme="clear">
<div class="bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>

<div class="page">
  <header class="topbar">
    <div class="brand">
      <div class="mark">${ICONS.logo}</div>
      <div class="bt">
        <p class="kicker">GitHub Trending · Analysis Report</p>
        <h1>${escapeHtml(titleText)}</h1>
      </div>
    </div>
    <div class="tb-side">
      <div class="viewseg" role="tablist">
        <button type="button" data-v="cards" class="on" role="tab">${ICONS.layers}<span>卡片</span></button>
        <button type="button" data-v="list" role="tab">${ICONS.list}<span>列表</span></button>
      </div>
      <button class="ibtn" type="button" id="btnStyle">${ICONS.sliders}<span class="tx">样式</span></button>
    </div>
    <div class="meta">${rest}</div>
  </header>

  <nav class="toc" id="toc" aria-label="章节导航"></nav>

  <section class="view v-cards on" id="viewCards">
    <div class="stage-wrap">
      <div class="stage" id="stage"></div>
      <button class="nav prev" type="button" id="btnPrev" aria-label="上一项">${ICONS.arrowL}</button>
      <button class="nav next" type="button" id="btnNext" aria-label="下一项">${ICONS.arrowR}</button>
    </div>
    <div class="dots" id="dots"></div>
    <div class="hint">拖拽、点击卡片或按 ← → 切换 · 右侧「样式」可换主题</div>
  </section>

  <section class="view v-list" id="viewList">
    <div class="list" id="listView"></div>
  </section>

  <div class="footbar">
    <button class="toggle" type="button" id="btnExpand">
      <span id="btnExpandIc">${ICONS.expand}</span><span id="btnExpandTx">展开全部内容</span>
    </button>
  </div>
</div>

<div class="scrim" id="scrim"></div>
<aside class="panel" id="stylePanel" aria-label="样式设置">
  <div class="panel-head">
    <span class="t">样式设置</span>
    <button class="x" type="button" id="btnClosePanel" aria-label="关闭">${ICONS.close}</button>
  </div>
  <div class="panel-body">
    <p class="sec-t">预设样式</p>
    <div class="themes" id="themes">${themeBtns}</div>

    <p class="sec-t">主色</p>
    <div class="accents" id="accents"></div>

    <p class="sec-t">自由调整</p>
    <div id="ranges"></div>

    <p class="sec-t">自定义背景</p>
    <div class="bgseg" id="bgSeg">
      <button type="button" data-bg="default" class="on">光斑</button>
      <button type="button" data-bg="color">纯色</button>
      <button type="button" data-bg="image">图片</button>
    </div>
    <div class="bgbox" id="bgColorBox" hidden>
      <input type="color" id="bgColor" value="#0d1526" aria-label="背景颜色">
      <span class="bghint">点右侧色块选背景颜色</span>
    </div>
    <div class="bgbox" id="bgImageBox" hidden>
      <label class="bgup" for="bgFile">
        <span>上传本地图片</span>
      </label>
      <input type="file" id="bgFile" accept="image/*" hidden>
      <div class="bgrow">
        <input type="url" id="bgUrl" placeholder="或粘贴图片网址 https://…">
        <button type="button" class="bgbtn" id="bgUseUrl">用</button>
      </div>
      <div class="bgrow">
        <button type="button" class="bgbtn wide" id="bgClear">清除自定义背景</button>
      </div>
      <div class="bghint" id="bgMsg"></div>
    </div>

    <button class="reset" type="button" id="btnReset">${ICONS.reset}<span>恢复默认</span></button>
  </div>
</aside>

${o.slidesHtml || ''}
<noscript><style>.slide-src{display:block;position:relative;margin:16px 0;padding:20px;background:#fff;border-radius:12px;border:1px solid #ddd}</style></noscript>
<script>${reportScript()}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

module.exports = { buildReportPage, reportCss, reportScript, ICONS };
