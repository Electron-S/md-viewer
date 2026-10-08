// 화면 단위 테스트: web/test/*.test.ts 를 node용으로 번들한 뒤 node:test 로 돌린다.
import * as esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const out = 'build/test';
rmSync(out, { recursive: true, force: true });
const entries = readdirSync('web/test').filter((f) => f.endsWith('.test.ts')).map((f) => `web/test/${f}`);
await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  external: ['jsdom', 'esbuild'],
  loader: { '.css': 'text' },
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
const files = entries.map((e) => `${out}/${e.split('/').pop().replace(/\.ts$/, '.mjs')}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
