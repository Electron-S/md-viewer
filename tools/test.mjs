// 단위 테스트 (SDD 9.3): 화면(web/test, jsdom)과 실행기(launcher/test)를 node용으로 묶어 node:test로 돌린다.
import * as esbuild from 'esbuild';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
process.exit(r.status ?? 1);
