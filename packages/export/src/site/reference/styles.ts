export const themeTokens = {
  dark: {
    page: '#16181c',
    chrome: '#1d2024',
    raised: '#22262c',
    text: '#e6edf3',
    text2: '#a3adb8',
    link: '#7fdcf0',
    line: '#333941',
    ctl: '#2b2f35',
    'ctl-edge': '#6c7480',
    accent: '#24ec54',
    cyan: '#1cdcfc',
    'accent-ink': '#24ec54',
    scrim: 'rgb(0 0 0 / .45)',
    'tp-surface': '#120e16',
    'tp-text': '#ffffff',
    'tp-pve': '#80aaff',
    'tp-pvp': '#ff9999',
    'tp-exotic': '#e6c300',
    'el-kinetic': '#dddddd',
    'el-arc': '#85c5ec',
    'el-solar': '#ff9a64',
    'el-void': '#c9a4df',
    'el-stasis': '#99b4ff',
    'el-strand': '#76d58b',
    'el-prismatic': '#ed9bbc',
  },
  light: {
    page: '#d7e1ea',
    chrome: '#c3d3df',
    raised: '#f6f9fc',
    text: '#0f151b',
    text2: '#3e4c5a',
    link: '#09647a',
    line: '#8fa6b8',
    ctl: '#f6f9fc',
    'ctl-edge': '#5c7488',
    accent: '#24ec54',
    cyan: '#1cdcfc',
    'accent-ink': '#0a6b2a',
    scrim: 'rgb(15 21 27 / .45)',
    'tp-surface': '#fdfeff',
    'tp-text': '#1a2027',
    'tp-pve': '#1f4fd1',
    'tp-pvp': '#b0211c',
    'tp-exotic': '#7d5d00',
    'el-kinetic': '#4f5b68',
    'el-arc': '#00708c',
    'el-solar': '#b54300',
    'el-void': '#8a4aab',
    'el-stasis': '#5b4ff0',
    'el-strand': '#147a33',
    'el-prismatic': '#a32766',
  },
};
const declarations = (theme: keyof typeof themeTokens) =>
  Object.entries(themeTokens[theme])
    .map(([key, value]) => `--${key}:${value}`)
    .join(';');
export const tooltipCss = `/* SPDX-License-Identifier: MIT */
:root{${declarations('dark')};color-scheme:dark}
:root[data-theme=light]{${declarations('light')};color-scheme:light}
@media(prefers-color-scheme:light){:root:not([data-theme]){${declarations('light')};color-scheme:light}}
.clarity-tooltip,.clarity-details{color:var(--tp-text);font:inherit;overflow-wrap:anywhere}
.clarity-tooltip{white-space:pre-wrap}.clarity-line{min-height:1.3em}.clarity-spacer{height:.65em;min-height:0}
.clarity-bold{font-weight:bold}.clarity-exotic{color:var(--tp-exotic)}.clarity-pve{color:var(--tp-pve)}.clarity-pvp{color:var(--tp-pvp)}
${Object.keys(themeTokens.dark)
  .filter((key) => key.startsWith('el-'))
  .map((key) => `.clarity-element-${key.slice(3)}{color:var(--${key})}`)
  .join('')}
.clarity-icon{display:inline-block;width:.95em;height:.95em;margin:0 .125em;vertical-align:-.06em}
.clarity-icon img{width:100%;height:100%;object-fit:contain}.clarity-art-light{display:none}
:root[data-theme=light] .clarity-art-light{display:block}:root[data-theme=light] .clarity-art-dark{display:none}
@media(prefers-color-scheme:light){:root:not([data-theme]) .clarity-art-light{display:block}:root:not([data-theme]) .clarity-art-dark{display:none}}
.clarity-glue{white-space:nowrap}.clarity-note,.clarity-link{color:var(--link);text-decoration:underline;text-underline-offset:.15em}
.clarity-note{font:inherit;line-height:inherit;background:transparent;border:0;padding:0;cursor:pointer;text-align:start}
.clarity-note-body>.clarity-tooltip{display:inline}.clarity-note-body{white-space:normal}
.clarity-popover{position:fixed;z-index:50;background:var(--raised);color:var(--text);padding:.6rem;border:1px solid var(--ctl-edge);border-radius:4px;box-sizing:border-box;max-height:calc(100dvh - 16px);overflow:auto}
.clarity-details{padding-inline-start:1.6em;white-space:normal}.clarity-details .clarity-tooltip{display:inline}
[hidden]{display:none!important}
`;
export const pageCss = `
*{box-sizing:border-box}html{scroll-padding-top:1rem;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--text);font:14px/1.45 Arial,Helvetica,sans-serif;font-variant-ligatures:none}
a{color:var(--link)}:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
header{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:10px 16px;background:var(--chrome);border-bottom:1px solid var(--line)}
header img{width:132px;height:30px;object-fit:contain}header h1{font-size:18px;margin:0;flex:1}header label{display:flex;align-items:center;gap:6px}
.layout{display:grid;grid-template-columns:180px minmax(0,1fr);max-width:1440px;margin:auto}
nav{padding:16px 12px;align-self:start;position:sticky;top:0;max-height:100dvh;overflow:auto}nav a{display:block;padding:4px 0}
main{min-width:0;padding:0 20px 36px}section{padding:20px 0;border-bottom:1px solid var(--line)}
h2{font-size:18px;margin:0 0 10px}h3{font-size:15px;margin:12px 0 6px}p{max-width:78ch;margin:8px 0}small,.muted{color:var(--text2)}
button,input,select{font:inherit;color:var(--text);background:var(--ctl);border:1px solid var(--ctl-edge);border-radius:3px;min-height:36px;padding:5px 8px;max-width:100%}
button{cursor:pointer;white-space:nowrap}label{min-width:0}.controls{display:flex;align-items:end;flex-wrap:wrap;gap:8px}.controls label{display:grid;gap:4px}.controls .search{flex:1 1 200px}
.controls input{width:100%}.controls select{width:100%}.controls .picker{flex:1 1 240px}
.live-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;margin-top:12px}
.live-grid>*{min-width:0}.concepts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.concepts article{min-width:0;border-top:1px solid var(--line);padding-top:8px}.concepts article h3{margin-top:0}
.tip{background:var(--tp-surface);color:var(--tp-text);padding:10px;font-size:14px;line-height:1.3;border:1px solid var(--line);border-radius:3px;min-width:0}
.tip .clarity-note{min-height:0;border-radius:0;padding:0}.tip-name{display:block;font-size:15px;margin-bottom:8px}
.tip pre{background:transparent;padding:0}.perk-trigger{width:100%;text-align:left;margin-bottom:6px;white-space:normal}
pre{font:12px/1.5 Consolas,monospace;background:var(--raised);padding:10px;border:1px solid var(--line);border-radius:3px;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;margin:8px 0}
code{font-family:Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}.json{max-height:32rem;overflow:auto}summary{cursor:pointer;min-height:28px}
.feature{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;border-top:1px solid var(--line);padding:10px 0}.feature h3{grid-column:1/-1;margin:0}.feature>div{min-width:0}.feature p{margin-top:0}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:7px;overflow-wrap:anywhere}th{background:var(--chrome)}
.table-wrap{overflow:auto}dialog{color:var(--text);background:var(--raised);border:1px solid var(--ctl-edge);border-radius:6px;max-width:calc(100% - 16px);max-height:75dvh;overflow:auto;padding:12px;width:34rem}
dialog.sheet{position:fixed;inset:auto 0 0;margin:0 auto;border-radius:6px 6px 0 0}dialog::backdrop{background:var(--scrim)}
dialog h3{margin-top:0}.copy-row{display:flex;justify-content:end;gap:8px}.asset-list{columns:2;list-style:none;padding:0}.asset-list li{break-inside:avoid;margin:4px 0;overflow-wrap:anywhere}
@media(max-width:1000px){.live-grid{grid-template-columns:1fr}.concepts{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.layout{display:block}nav{position:static;display:flex;flex-wrap:wrap;gap:4px 14px;padding:10px 12px;border-bottom:1px solid var(--line)}nav a{padding:2px 0}main{padding:0 12px 24px}header{padding:8px 12px}.concepts,.feature{grid-template-columns:1fr}.asset-list{columns:1}input,select{font-size:16px}}
`;
