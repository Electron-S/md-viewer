// 화면 코드를 build/web/ 으로 번들한다 (SDD 9.2 1단계).
// 시작 직후 WebView2는 하위 리소스 응답을 수백 ms 붙잡으므로, 첫 화면에 필요한 CSS·JS는 index.html 안에 넣는다.
// 인라인 스크립트는 CSP에 해시로만 허용한다(인라인 이벤트 속성·다른 인라인 스크립트는 여전히 막힌다).
// 원문 보기(CodeMirror)는 source.js로 따로 묶어 처음 쓸 때 불러온다.
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = 'build/web';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
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
};
const app = await esbuild.build({ ...common, entryPoints: ['web/src/main.ts'], outfile: 'app.js' });
const source = await esbuild.build({ ...common, entryPoints: ['web/src/source-entry.ts'], outfile: 'source.js' });
writeFileSync(`${out}/source.js`, source.outputFiles[0].contents);

// HTML 파서가 스크립트 안의 <!-- · <script · </script 를 태그로 보지 않도록 '<'를 \x3C로 바꾼다.
// 이 문자열들은 번들 안에서 문자열·정규식 리터럴에만 나오며, 그 안에서 \x3C는 같은 뜻이다.
const raw = app.outputFiles[0].text;
if (/\\<(!--|\/?script)/i.test(raw)) throw new Error('번들에 \\< 로 시작하는 민감한 시퀀스가 있어 안전하게 바꿀 수 없습니다');
const js = raw.replace(/<(!--|\/?script)/gi, '\\x3C$1');
const css = readFileSync('web/static/app.css', 'utf8');
const hash = createHash('sha256').update(js, 'utf8').digest('base64');
let html = readFileSync('web/static/index.html', 'utf8');
const replaceOnce = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html에 ${from} 이 없습니다`);
  html = html.replace(from, () => to);
};
replaceOnce("script-src 'self'", `script-src 'self' 'sha256-${hash}'`);
replaceOnce('<link rel="stylesheet" href="app.css">', `<style>${css}</style>`);
replaceOnce('<script type="module" src="app.js"></script>', `<script defer-inline>${js}</script>`);
// 인라인 스크립트는 문서 끝에서 실행해야 DOM이 준비돼 있다.
html = html.replace(/<script defer-inline>[\s\S]*<\/script>\n?/, '');
html = html.replace('</body>', () => `<script>${js}</script>\n</body>`);
writeFileSync(`${out}/index.html`, html);
console.log('bundled ->', out, `(index.html ${(html.length / 1024).toFixed(0)} KB, source.js ${(source.outputFiles[0].contents.length / 1024).toFixed(0)} KB)`);
