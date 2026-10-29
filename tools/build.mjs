// MD Viewer 빌드 (SDD 9.2). Node.js만 있으면 어느 OS에서나 돈다.
//   1) 타입 검사  2) 뷰어 HTML 하나  3) 실행기 mdview.mjs  4) 스킬 묶음과 zip  5) 크기 검사  6) Windows 앱
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { buildExe } from './exe.mjs';

// 아래 경로는 모두 저장소 루트 기준이다. 다른 폴더에서 불러도 그 폴더의 dist를 지우지 않게 루트로 옮긴다.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const define = { __MDV_VERSION__: JSON.stringify(VERSION) };
// NFR-PORT-03. Mermaid(FR-REN-07)를 넣으며 올렸다. 약 20%를 다음 기능(수식 FR-REN-06 등) 몫으로 남긴다.
const MIB = 1024 * 1024;
const MAX_VIEWER = 3.5 * MIB;
const MAX_EXE = 5 * MIB;
const MAX_BUNDLE = 4 * MIB;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/mdview', { recursive: true });

console.log('== 1. 타입 검사');
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'], { stdio: 'inherit' });

console.log('== 2. 뷰어 HTML');
const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome110',
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  loader: { '.css': 'text' },
  write: false,
  metafile: true,
  define,
};
const app = await esbuild.build({ ...common, entryPoints: ['web/src/main.ts'] });
const source = await esbuild.build({ ...common, entryPoints: ['web/src/source-entry.ts'] });
const mermaid = await esbuild.build({ ...common, entryPoints: ['web/src/mermaid-entry.ts'] });
// 원문 보기(CodeMirror)는 함수로 감싸 처음 쓸 때 실행한다(시작할 때는 구문만 훑는다, SDD 7.5).
const raw = `window.__mdvLoadSource=function(){${source.outputFiles[0].text}};\n${app.outputFiles[0].text}`;
// HTML 파서가 스크립트 안의 <!-- · <script · </script 를 태그로 보지 않도록 '<'를 \x3C로 바꾼다.
// 이 문자열들은 번들 안에서 문자열·정규식 리터럴에만 나오며, 그 안에서 \x3C는 같은 뜻이다.
if (/\\<(!--|\/?script)/i.test(raw)) throw new Error('번들에 \\< 로 시작하는 민감한 시퀀스가 있어 안전하게 바꿀 수 없습니다');
const js = raw.replace(/<(!--|\/?script)/gi, '\\x3C$1');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');
const hash = sha256(js);
// Mermaid(FR-REN-07)는 5 MB가 넘어 gzip·base64로 데이터 블록에 넣는다. 화면이 처음 다이어그램을 그릴 때 풀어
// 인라인 스크립트로 붙이며, 그 원문의 해시를 CSP에 넣어 둬 eval 없이 실행되게 한다 (render/diagrams.ts, SDD 7.5).
// 이 스크립트는 HTML 파서를 거치지 않으므로(textContent로 넣는다) '<' 바꾸기가 필요 없다.
const mermaidJs = mermaid.outputFiles[0].text;
const mermaidData = gzipSync(Buffer.from(mermaidJs, 'utf8'), { level: 9 }).toString('base64');
const mermaidHash = sha256(mermaidJs);
// Windows에서 git이 CRLF로 꺼낸 파일이어도 아래 찾기(줄 끝 \n 포함)가 맞도록 줄 끝을 LF로 맞춘다.
let html = readFileSync('web/static/index.html', 'utf8').replace(/\r\n/g, '\n');
const replaceOnce = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html에 ${from} 이 없습니다`);
  html = html.replace(from, () => to);
};
replaceOnce("script-src 'self'", `script-src 'sha256-${hash}' 'sha256-${mermaidHash}'`);
replaceOnce('<link rel="stylesheet" href="app.css">', `<style>${readFileSync('web/static/app.css', 'utf8')}</style>`);
replaceOnce('<script type="module" src="app.js"></script>\n', '');
// 인라인 스크립트는 문서 끝에서 실행해야 DOM이 준비돼 있다. 데이터 블록(type이 스크립트가 아니라 실행되지 않음)은 그 앞에 둔다.
replaceOnce('</body>', `<script type="application/octet-stream" id="mdv-mermaid">${mermaidData}</script>\n<script>${js}</script>\n</body>`);
writeFileSync('dist/viewer.html', html);
// 자기 검사: 데이터 블록을 다시 풀었을 때 CSP의 해시와 같아야 화면에서 실행된다.
{
  const built = readFileSync('dist/viewer.html', 'utf8');
  const data = /<script type="application\/octet-stream" id="mdv-mermaid">([^<]*)<\/script>/.exec(built)?.[1] ?? '';
  const csp = /script-src ([^;]*)/.exec(built)?.[1] ?? '';
  if (!csp.includes(`'sha256-${sha256(gunzipSync(Buffer.from(data, 'base64')).toString('utf8'))}'`)) {
    throw new Error('Mermaid 데이터 블록의 해시가 CSP와 다릅니다');
  }
}
writeNotices([app, source, mermaid]);

console.log('== 3. 실행기');
await esbuild.build({
  entryPoints: ['launcher/main.ts'],
  outfile: 'dist/mdview/mdview.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  charset: 'utf8',
  logLevel: 'warning',
  define,
  banner: { js: '#!/usr/bin/env node' },
});

console.log('== 4. 스킬 묶음');
copyFileSync('dist/viewer.html', 'dist/mdview/viewer.html');
copyFileSync('skill/SKILL.md', 'dist/mdview/SKILL.md');
copyFileSync('LICENSE', 'dist/mdview/LICENSE');
copyFileSync('dist/THIRD-PARTY-NOTICES.txt', 'dist/mdview/THIRD-PARTY-NOTICES.txt');
const zipPath = `dist/mdview-${VERSION}.zip`;
writeFileSync(zipPath, makeZip('dist/mdview', 'mdview'));

console.log('== 5. 크기 검사 (NFR-PORT-03)');
const viewerSize = statSync('dist/viewer.html').size;
const bundleSize = readdirSync('dist/mdview').reduce((n, f) => n + statSync(join('dist/mdview', f)).size, 0);
console.log(`viewer.html ${(viewerSize / 1024).toFixed(0)} KB, mdview/ ${(bundleSize / 1024).toFixed(0)} KB, ${zipPath} ${(statSync(zipPath).size / 1024).toFixed(0)} KB`);
if (viewerSize > MAX_VIEWER) throw new Error(`viewer.html이 ${MAX_VIEWER / MIB} MiB를 넘습니다`);
if (bundleSize > MAX_BUNDLE) throw new Error(`스킬 묶음이 ${MAX_BUNDLE / MIB} MiB를 넘습니다`);

console.log('== 6. Windows 앱 (MDViewer.exe)');
// 릴리스에는 HTML과 EXE를 함께 낸다. EXE는 csc(.NET Framework)가 있는 Windows·WSL에서만 만들 수 있다.
const exe = await buildExe({ version: VERSION, viewer: 'dist/viewer.html', out: 'dist/MDViewer.exe' });
if (exe) {
  const exeSize = statSync('dist/MDViewer.exe').size;
  console.log(`MDViewer.exe ${(exeSize / 1024).toFixed(0)} KB`);
  if (exeSize > MAX_EXE) throw new Error(`MDViewer.exe가 ${MAX_EXE / MIB} MiB를 넘습니다`);
} else {
  console.log('csc.exe가 없어 건너뜀 (Windows나 WSL에서 빌드하세요)');
}
console.log('== 완료');

/**
 * 제3자 고지를 만든다: 저장소의 THIRD-PARTY-NOTICES.txt(WebView2) 뒤에, viewer.html에 묶여 들어간 npm 패키지의
 * 이름·버전·라이선스·소스 위치와 라이선스 파일 전문을 붙인다. 묶인 패키지는 esbuild metafile의 입력 파일로 가린다.
 */
function writeNotices(builds) {
  const dirs = new Set();
  for (const b of builds) {
    for (const input of Object.keys(b.metafile.inputs)) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
      if (m) dirs.add(m[1]);
    }
  }
  const sections = [];
  for (const dir of [...dirs].sort()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const license = pkg.license ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? '';
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)(-[\w.]+)?(\.(md|txt))?$/i.test(f)).sort();
    const head = [`${pkg.name}@${pkg.version}`, license && `License: ${license}`, repo && `Source: ${repo}`].filter(Boolean).join('\n');
    const body = files.map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n');
    if (!body) throw new Error(`${pkg.name}에 라이선스 파일이 없습니다`);
    sections.push(`${head}\n\n${body}`);
  }
  const rule = '\n\n' + '-'.repeat(70) + '\n\n';
  const intro = `viewer.html(MDViewer.exe 안의 화면 포함)에는 다음 npm 패키지 ${sections.length}개가 묶여 들어 있습니다.`;
  const base = readFileSync('THIRD-PARTY-NOTICES.txt', 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (!existsSync('dist')) mkdirSync('dist');
  writeFileSync('dist/THIRD-PARTY-NOTICES.txt', `${base}${rule}${intro}${rule}${sections.join(rule)}\n`);
}

/** 폴더 하나를 zip으로 묶는다(deflate). 별도 도구 없이 Node 표준 라이브러리만 쓴다. */
function makeZip(dir, prefix) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of readdirSync(dir).sort()) {
    const data = readFileSync(join(dir, name));
    const packed = deflateRawSync(data, { level: 9 });
    const fname = Buffer.from(`${prefix}/${name}`, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 파일 이름
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fname, packed);
    centrals.push(central, fname);
    offset += local.length + fname.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
