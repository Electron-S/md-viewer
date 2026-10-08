import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { ensureServer, findRoot, installShim, parseArgs, resolveArg, runCli, type CliIo } from '../cli';
import { Logger } from '../log';
import { browserCommands, revealCommand, splitCommand, waitWindowsReachable } from '../os';
import { startServer } from '../server';
import { readState, writeState } from '../state';
import { VERSION } from '../version';
import { makeViewer, tempDir } from './helpers';

let bundle: string;
let viewer: string;

before(() => {
  // 서버를 분리된 프로세스로 띄우는 경로까지 시험하려고 실제 실행 파일처럼 묶는다.
  const dir = tempDir('mdv-bundle-');
  bundle = path.join(dir, 'mdview.mjs');
  // 명령(이 테스트)과 서버(묶은 파일)가 같은 버전이어야 서버를 다시 쓴다.
  buildSync({
    entryPoints: [path.resolve('launcher/main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node18', outfile: bundle,
    logLevel: 'warning', define: { __MDV_VERSION__: JSON.stringify(VERSION) },
  });
  viewer = makeViewer(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: mdview\n---\n', 'utf8');
});

function io(home: string, cwd: string, opened: string[] = []): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (s) => lines.push(s),
    err: (s) => errors.push(s),
    env: { ...process.env, MDVIEW_HOME: home, MDVIEW_VIEWER: viewer, MDVIEW_IDLE_MS: '60000' },
    cwd,
    scriptPath: bundle,
    userHome: tempDir('mdv-userhome-'),
    open: async (u) => {
      opened.push(u);
      return true;
    },
    // 이 테스트가 WSL에서 돌아도 Windows의 curl.exe를 부르지 않는다.
    waitReachable: async () => true,
  };
}

const homes: string[] = [];
after(async () => {
  for (const h of homes) await runCli(['--stop'], io(h, h));
});

test('인자 해석', () => {
  assert.deepEqual(parseArgs(['a.md', '--root', 'r', '--no-open', '--port', '0', 'b']), {
    paths: ['a.md', 'b'], root: 'r', noOpen: true, port: 0, stop: false, status: false, version: false, help: false,
  });
  assert.equal(parseArgs(['--install-skill']).installSkill, true);
  assert.equal(parseArgs(['--install-skill', 'dir']).installSkill, 'dir');
  assert.deepEqual(parseArgs(['--', '--weird.md']).paths, ['--weird.md']);
  assert.throws(() => parseArgs(['--nope']), /알 수 없는 옵션/);
  assert.throws(() => parseArgs(['--port', 'x']), /포트/);
  assert.throws(() => parseArgs(['--root']), /값이 필요/);
});

test('허용 폴더: --root, git 저장소 루트, 파일 폴더 순 (SDD 2장)', () => {
  const base = tempDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'deep'), { recursive: true });
  const file = path.join(repo, 'docs', 'deep', 'a.md');
  fs.writeFileSync(file, '#', 'utf8');
  assert.equal(findRoot(file, false), repo);
  assert.equal(findRoot(path.join(repo, 'docs'), true), repo);
  assert.equal(findRoot(file, false, path.join(repo, 'docs')), path.join(repo, 'docs'));
  assert.equal(findRoot(file, false, path.join(base, 'elsewhere')), repo, '--root가 품지 않으면 무시');
  const plain = path.join(base, 'plain');
  fs.mkdirSync(path.join(plain, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'b.md'), '#', 'utf8');
  assert.equal(findRoot(path.join(plain, 'b.md'), false), plain);
  assert.equal(findRoot(path.join(plain, 'sub'), true), path.join(plain, 'sub'), '폴더 인자는 그 폴더 자신');
  assert.equal(findRoot(path.join(plain, 'sub'), true, plain), plain, '--root가 품으면 --root');
});

test('WSL에서 Windows 경로 인자는 wslpath로 바꾸고, 네트워크 공유는 거부한다', () => {
  const calls: string[] = [];
  const wsl: CliIo = {
    out() {}, err() {}, env: {}, cwd: '/home/me/proj', scriptPath: '/x/mdview.mjs',
    platform: { platform: 'linux', wsl: true, env: {} },
    toPosix: (w) => {
      calls.push(w);
      return '/mnt/c/docs/a.md';
    },
  };
  assert.equal(resolveArg('C:\\docs\\a.md', wsl), '/mnt/c/docs/a.md');
  assert.equal(resolveArg('c:/docs/a.md', wsl), '/mnt/c/docs/a.md');
  assert.equal(resolveArg('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.md', wsl), '/mnt/c/docs/a.md');
  assert.equal(calls.length, 3);
  assert.equal(resolveArg('docs/b.md', wsl), '/home/me/proj/docs/b.md', '보통 경로는 그대로');
  assert.throws(() => resolveArg('\\\\srv\\share\\a.md', wsl), /네트워크 공유/);
  const native: CliIo = { ...wsl, platform: { platform: 'linux', wsl: false, env: {} } };
  assert.equal(resolveArg('docs/b.md', native), '/home/me/proj/docs/b.md');
  assert.equal(calls.length, 3, 'WSL이 아니면 바꾸지 않는다');
});

test('명령: 서버를 띄우고, 다시 부르면 같은 서버를 쓰고, 멈춘 뒤 다시 띄우면 포트·토큰을 이어 쓴다 (FR-FILE-04, FR-LAUNCH-01)', async () => {
  const home = tempDir();
  homes.push(home);
  const docs = path.join(tempDir('mdv-cli-'), '한글 폴더');
  fs.mkdirSync(docs);
  const file = path.join(docs, '문서.md');
  fs.writeFileSync(file, '# 안녕\n', 'utf8');
  const opened: string[] = [];

  const a = io(home, docs, opened);
  assert.equal(await runCli(['--port', '0', '문서.md'], a), 0, a.errors.join('\n'));
  const url = new URL(a.lines.at(-1)!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.deepEqual(url.searchParams.getAll('f'), [file]);
  assert.equal(opened[0], a.lines.at(-1));
  const st1 = readState(home)!;
  assert.equal(url.searchParams.get('t'), st1.token);
  assert.equal(Number(url.port), st1.port);
  const read = await fetch(new URL(`/api/read?t=${encodeURIComponent(st1.token!)}&path=${encodeURIComponent(file)}`, url));
  assert.equal(await read.text(), '# 안녕\n', '명령이 등록한 루트 안의 파일을 읽는다');

  const b = io(home, docs);
  assert.equal(await runCli(['--no-open', docs], b), 0);
  assert.equal(readState(home)!.pid, st1.pid, '두 번째 실행은 같은 서버를 쓴다');
  assert.deepEqual(new URL(b.lines.at(-1)!).searchParams.getAll('d'), [docs]);
  assert.ok(b.lines.some((l) => /브라우저를 열지 않았습니다/.test(l)));

  const s = io(home, docs);
  await runCli(['--status'], s);
  assert.match(s.lines[0], new RegExp(`127\\.0\\.0\\.1:${st1.port} \\(pid ${st1.pid}\\)`));
  await runCli(['--stop'], io(home, docs));
  for (let i = 0; i < 30 && readState(home)!.pid; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readState(home)!.pid, null);
  const n = io(home, docs);
  await runCli(['--status'], n);
  assert.match(n.lines[0], /실행 중인 실행기가 없습니다/);

  const c = io(home, docs);
  assert.equal(await runCli(['--no-open', file], c), 0);
  const st2 = readState(home)!;
  assert.notEqual(st2.pid, st1.pid);
  assert.deepEqual([st2.port, st2.token], [st1.port, st1.token], '다시 뜬 실행기는 포트·토큰을 이어 쓴다');
});

test('WSL에서 새로 띄운 서버는 Windows에서 닿을 때까지 기다린 뒤 주소를 낸다 (FR-LAUNCH-04)', async () => {
  const home = tempDir();
  homes.push(home);
  const docs = tempDir('mdv-cli-');
  const waits: number[] = [];
  const wslIo = () => ({
    ...io(home, docs),
    platform: { platform: 'linux' as const, wsl: true, env: {} },
    waitReachable: async (port: number) => {
      waits.push(port);
      return true;
    },
  });
  assert.equal(await runCli(['--no-open', '--port', '0', docs], wslIo()), 0);
  const port = readState(home)!.port;
  assert.equal(await runCli(['--no-open', docs], wslIo()), 0);
  assert.deepEqual(waits, [port], '새로 띄울 때만 기다린다');

  // curl.exe가 연결 거부(7)를 두 번 내고 성공(0)하면 true
  const codes = [7, 7, 0];
  const calls: string[][] = [];
  assert.equal(await waitWindowsReachable(1234, 5000, async (c, a) => (calls.push([c, ...a]), codes.shift()!)), true);
  assert.equal(calls.length, 3);
  assert.match(calls[0].join(' '), /^curl\.exe .*http:\/\/127\.0\.0\.1:1234\/favicon\.ico$/);
  assert.equal(await waitWindowsReachable(1, 5000, async () => null), false, 'curl.exe가 없으면 잠깐 기다리고 넘어간다');
  assert.equal(await waitWindowsReachable(1, 200, async () => 7), false, '시간이 지나면 포기한다');
});

test('없는 파일은 오류로 끝난다', async () => {
  const home = tempDir();
  const x = io(home, home);
  assert.equal(await runCli(['없는파일.md'], x), 1);
  assert.match(x.errors[0], /파일이나 폴더가 없습니다/);
  assert.equal(readState(home), null, '서버를 띄우지 않는다');
});

test('스킬 설치: SKILL.md·mdview.mjs·viewer.html을 복사하고 mdview 명령을 만든다 (FR-LAUNCH-05)', async () => {
  const target = path.join(tempDir(), '스킬', 'mdview');
  const x = io(tempDir(), tempDir());
  x.platform = { platform: 'linux', wsl: false, env: {} };
  x.env = { ...x.env, PATH: '/usr/bin' };
  assert.equal(await runCli(['--install-skill', target], x), 0, x.errors.join('\n'));
  assert.deepEqual(fs.readdirSync(target).sort(), ['SKILL.md', 'mdview.mjs', 'viewer.html']);
  assert.match(x.lines[0], /스킬을 설치했습니다/);
  const shim = path.join(x.userHome!, '.local', 'bin', 'mdview');
  assert.equal(fs.readFileSync(shim, 'utf8'), `#!/bin/sh\nexec node "${path.join(target, 'mdview.mjs')}" "$@"\n`);
  assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
  assert.match(x.lines[1], /mdview 명령을 만들었습니다/);
  assert.match(x.lines[2], /PATH에 더하면/);

  const y = io(tempDir(), tempDir());
  y.platform = { platform: 'linux', wsl: false, env: {} };
  y.env = { ...y.env, PATH: `/usr/bin:${path.join(y.userHome!, '.local', 'bin')}` };
  const r = installShim(y, '/opt/skill "q"');
  assert.equal(r.onPath, true);
  assert.equal(fs.readFileSync(r.file, 'utf8'), '#!/bin/sh\nexec node "/opt/skill \\"q\\"/mdview.mjs" "$@"\n', '따옴표를 이스케이프한다');

  const w = io(tempDir(), tempDir());
  w.platform = { platform: 'win32', wsl: false, env: {} };
  const rw = installShim(w, 'C:\\skills\\mdview');
  assert.equal(path.basename(rw.file), 'mdview.cmd');
  assert.equal(path.dirname(rw.file), path.join(w.env.MDVIEW_HOME!, 'bin'));
  assert.match(fs.readFileSync(rw.file, 'utf8'), /^@node "C:\\skills\\mdview.mdview\.mjs" %\*\r\n$/);
});

test('동시에 두 명령이 실행기를 찾아도 start.lock으로 하나만 띄운다', async () => {
  const home = tempDir();
  homes.push(home);
  const [a, b] = await Promise.all([ensureServer(io(home, home), 0), ensureServer(io(home, home), 0)]);
  assert.equal(a.pid, b.pid);
  assert.equal(a.port, b.port);
  assert.equal(fs.existsSync(path.join(home, 'start.lock')), false, '잠금을 푼다');
  // 오래된 잠금은 죽은 명령이 남긴 것으로 보고 지운다.
  await runCli(['--stop'], io(home, home));
  for (let i = 0; i < 30 && readState(home)!.pid; i++) await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(path.join(home, 'start.lock'), '1', 'utf8');
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(path.join(home, 'start.lock'), old, old);
  const c = await ensureServer(io(home, home), 0);
  assert.ok(c.pid > 0);
});

test('다른 버전의 실행기가 떠 있으면 멈추고 새로 띄운다', async () => {
  const home = tempDir();
  homes.push(home);
  const oldServer = await startServer({ home, viewerPath: viewer, version: 'old-version', port: 0, idleMs: 60_000 });
  const x = io(home, home);
  const r = await ensureServer(x);
  await oldServer.closed;
  assert.notEqual(r.pid, process.pid);
  assert.ok(x.lines.some((l) => /다른 버전\(old-version\)/.test(l)));
  assert.deepEqual([r.port, r.token], [oldServer.port, oldServer.token], '같은 포트·토큰으로 이어 띄운다');
});

test('state.json의 포트에서 남의 서버가 403으로 답하면 그 포트·토큰을 버리고 새로 띄운다', async () => {
  const home = tempDir();
  homes.push(home);
  const otherHome = tempDir();
  const other = await startServer({ home: otherHome, viewerPath: viewer, version: 'x', port: 0, idleMs: 60_000 });
  // pid는 살아 있는 내 프로세스(이 테스트)라 그 포트에 묻고, 403을 받는다.
  writeState(home, { schemaVersion: 2, port: other.port, token: 'not-the-right-token-123', pid: process.pid, version: 'x', roots: [] });
  const r = await ensureServer(io(home, home), 0);
  assert.notEqual(r.port, other.port);
  assert.notEqual(r.token, 'not-the-right-token-123');
  await other.close('test');
});

test('state.json의 pid가 살아 있는 내 실행기가 아니면 그 포트에 묻지 않는다(토큰을 넘기지 않는다)', async () => {
  const home = tempDir();
  homes.push(home);
  // 실행기가 꺼진 사이 남이 그 포트를 차지해 같은 버전인 척 답하는 경우
  const seen: string[] = [];
  const squatter = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: VERSION, pid: 4242 }));
  });
  await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', () => r()));
  const port = (squatter.address() as AddressInfo).port;
  const token = 'my-secret-token-0123456789';
  for (const pid of [null, 0x3fffffff]) {
    writeState(home, { schemaVersion: 2, port, token, pid, version: VERSION, roots: [] });
    const s = io(home, home);
    await runCli(['--status'], s);
    assert.match(s.lines[0], /실행 중인 실행기가 없습니다/);
  }
  const r = await ensureServer(io(home, home));
  assert.notEqual(r.port, port, '차지된 포트는 비워 두고 다른 포트로 띄운다');
  assert.deepEqual(seen, [], '남의 프로그램에 아무 요청도 보내지 않는다');
  await new Promise((r2) => squatter.close(r2));
});

test('브라우저 열기 명령: 환경 변수, WSL, Windows, macOS, Linux (FR-LAUNCH-04)', () => {
  const url = 'http://127.0.0.1:7787/?t=a&f=%2Fx';
  // explorer.exe는 물음표가 든 주소를 브라우저에 넘기지 못하므로 쓰지 않는다(실제 Windows에서 확인).
  assert.deepEqual(browserCommands(url, { platform: 'linux', wsl: true, env: {} }), [['rundll32.exe', ['url.dll,FileProtocolHandler', url]], ['wslview', [url]]]);
  assert.deepEqual(browserCommands(url, { platform: 'win32', wsl: false, env: {} }), [['rundll32', ['url.dll,FileProtocolHandler', url]]]);
  assert.deepEqual(browserCommands(url, { platform: 'darwin', wsl: false, env: {} }), [['open', [url]]]);
  assert.deepEqual(browserCommands(url, { platform: 'linux', wsl: false, env: {} }), [['xdg-open', [url]]]);
  assert.deepEqual(browserCommands(url, { platform: 'linux', wsl: false, env: { MDVIEW_BROWSER: '"/opt/my browser/b" --new-tab' } })[0], ['/opt/my browser/b', ['--new-tab', url]]);
  assert.deepEqual(splitCommand(`a 'b c' "d e"`), ['a', 'b c', 'd e']);
  assert.deepEqual(revealCommand('/home/me/a.md', { platform: 'linux', wsl: true, env: {} }, () => 'C:\\x\\a.md'), ['explorer.exe', ['/select,C:\\x\\a.md']]);
  assert.deepEqual(revealCommand('/home/me/a.md', { platform: 'darwin', wsl: false, env: {} }), ['open', ['-R', '/home/me/a.md']]);
  assert.deepEqual(revealCommand('/home/me/a.md', { platform: 'linux', wsl: false, env: {} }), ['xdg-open', ['/home/me']]);
});

test('로그는 1 MB(여기선 작은 크기)에서 순환하며 3개만 남긴다 (NFR-REL-03)', () => {
  const dir = tempDir();
  const log = new Logger(dir, 300, 3);
  for (let i = 0; i < 60; i++) log.write('info', `줄 ${i} ${'x'.repeat(20)}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['mdview.log', 'mdview.log.1', 'mdview.log.2']);
  for (const f of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 300, f);
  assert.match(fs.readFileSync(path.join(dir, 'mdview.log'), 'utf8'), /줄 59/);
});
