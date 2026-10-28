// 단위 테스트 (SDD 9.3): 화면(web/test, jsdom)과 실행기(launcher/test)를 node용으로 묶어 node:test로 돌린다.
// csc(.NET Framework)가 있는 Windows·WSL에서는 Windows 앱(host/) 단위 테스트(tests/host)도 돌린다.
import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExe } from './exe.mjs';

// 경로는 저장소 루트 기준이다(build.mjs와 같다).
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const out = 'build/test';
rmSync(out, { recursive: true, force: true });
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const suites = ['web/test', 'launcher/test'].filter((d) => existsSync(d));
const entries = suites.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.test.ts')).map((f) => `${d}/${f}`));
await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  outbase: '.',
  outExtension: { '.js': '.mjs' },
  external: ['jsdom', 'esbuild'],
  loader: { '.css': 'text' },
  logLevel: 'warning',
  define: { __MDV_VERSION__: JSON.stringify(VERSION) },
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
const files = entries.map((e) => `${out}/${e.replace(/\.ts$/, '.mjs')}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
let status = r.status ?? 1;

const host = await buildExe({ version: VERSION, viewer: 'web/static/index.html', out: `${out}/MDViewer.exe`, tests: true, stageName: 'MdViewer-build-test' });
if (host) {
  // WebView2 DLL이 없는 폴더에서 돌려, EXE 안의 리소스에서 읽는지까지 본다.
  const run = join(host.stage, 'run');
  mkdirSync(run, { recursive: true });
  copyFileSync(host.tests, join(run, 'MDViewer-tests.exe'));
  console.log('# Windows 앱 단위 테스트 (tests/host)');
  const h = spawnSync(join(run, 'MDViewer-tests.exe'), [], { cwd: run, encoding: 'utf8' });
  process.stdout.write((h.stdout ?? '').replace(/\r/g, ''));
  if (h.status !== 0) status = 1;
} else {
  console.log('# Windows 앱 단위 테스트는 건너뜀 (csc.exe 없음)');
}
process.exit(status);
