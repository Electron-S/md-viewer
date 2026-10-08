// MD Viewer 빌드 (SDD 9.2). Node.js만 있으면 어느 OS에서나 돈다.
//   1) 타입 검사  2) 뷰어 HTML 하나  3) 실행기 mdview.mjs  4) 스킬 묶음과 zip  5) 크기 검사
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const define = { __MDV_VERSION__: JSON.stringify(VERSION) };
const MAX_VIEWER = 2 * 1024 * 1024;
const MAX_BUNDLE = 2.5 * 1024 * 1024;

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
  define,
};
const app = await esbuild.build({ ...common, entryPoints: ['web/src/main.ts'] });
const source = await esbuild.build({ ...common, entryPoints: ['web/src/source-entry.ts'] });
// 원문 보기(CodeMirror)는 함수로 감싸 처음 쓸 때 실행한다(시작할 때는 구문만 훑는다, SDD 7.5).
const raw = `window.__mdvLoadSource=function(){${source.outputFiles[0].text}};\n${app.outputFiles[0].text}`;
// HTML 파서가 스크립트 안의 <!-- · <script · </script 를 태그로 보지 않도록 '<'를 \x3C로 바꾼다.
// 이 문자열들은 번들 안에서 문자열·정규식 리터럴에만 나오며, 그 안에서 \x3C는 같은 뜻이다.
if (/\\<(!--|\/?script)/i.test(raw)) throw new Error('번들에 \\< 로 시작하는 민감한 시퀀스가 있어 안전하게 바꿀 수 없습니다');
const js = raw.replace(/<(!--|\/?script)/gi, '\\x3C$1');
const hash = createHash('sha256').update(js, 'utf8').digest('base64');
let html = readFileSync('web/static/index.html', 'utf8');
const replaceOnce = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html에 ${from} 이 없습니다`);
  html = html.replace(from, () => to);
};
replaceOnce("script-src 'self'", `script-src 'sha256-${hash}'`);
replaceOnce('<link rel="stylesheet" href="app.css">', `<style>${readFileSync('web/static/app.css', 'utf8')}</style>`);
replaceOnce('<script type="module" src="app.js"></script>\n', '');
// 인라인 스크립트는 문서 끝에서 실행해야 DOM이 준비돼 있다.
replaceOnce('</body>', `<script>${js}</script>\n</body>`);
writeFileSync('dist/viewer.html', html);

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
const zipPath = `dist/mdview-${VERSION}.zip`;
writeFileSync(zipPath, makeZip('dist/mdview', 'mdview'));

console.log('== 5. 크기 검사 (NFR-PORT-03)');
const viewerSize = statSync('dist/viewer.html').size;
const bundleSize = readdirSync('dist/mdview').reduce((n, f) => n + statSync(join('dist/mdview', f)).size, 0);
console.log(`viewer.html ${(viewerSize / 1024).toFixed(0)} KB, mdview/ ${(bundleSize / 1024).toFixed(0)} KB, ${zipPath} ${(statSync(zipPath).size / 1024).toFixed(0)} KB`);
if (viewerSize > MAX_VIEWER) throw new Error('viewer.html이 2 MB를 넘습니다');
if (bundleSize > MAX_BUNDLE) throw new Error('스킬 묶음이 2.5 MB를 넘습니다');
console.log('== 완료');

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
