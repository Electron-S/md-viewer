// 실행기 명령 (SDD 7.3, FR-LAUNCH-01·05, FR-FILE-04).
// mdview [--root 폴더] [--no-open] [--port 번호] [파일 또는 폴더 ...] | --status | --stop | --install-skill [폴더]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Logger } from './log';
import { currentPlatform, isUncPath, isWindowsPathArg, openBrowser, waitWindowsReachable, wslToPosix, type Platform } from './os';
import { ensureHome, homeDir, lockPath, logsDir, readState, writeState } from './state';
import { L } from './strings';
import { VERSION } from './version';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** 묶인 실행기 파일(mdview.mjs). 서버를 띄울 때와 스킬을 설치할 때 쓴다. */
  scriptPath: string;
  platform?: Platform;
  /** 브라우저 열기를 바꿔 끼울 때(테스트) */
  open?: (url: string) => Promise<boolean>;
  /** WSL에서 Windows 경로를 WSL 경로로 바꾼다(기본: wslpath -u). 테스트에서 바꿔 끼운다. */
  toPosix?: (winPath: string) => string;
  /** 사용자 홈(스킬·명령 바로 가기 위치). 기본 os.homedir() */
  userHome?: string;
  /** WSL에서 새로 띄운 서버의 포트가 Windows에서 닿을 때까지 기다린다(기본: waitWindowsReachable). 테스트에서 바꿔 끼운다. */
  waitReachable?: (port: number) => Promise<boolean>;
}

export interface CliArgs {
  paths: string[];
  root?: string;
  noOpen: boolean;
  port?: number;
  stop: boolean;
  status: boolean;
  installSkill?: string | true;
  version: boolean;
  help: boolean;
}

export class CliError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { paths: [], noOpen: false, stop: false, status: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new CliError(L.needValue(v));
      return next;
    };
    if (v === '--root') a.root = value();
    else if (v === '--no-open') a.noOpen = true;
    else if (v === '--port') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliError(L.badPort(raw));
      a.port = n;
    } else if (v === '--stop') a.stop = true;
    else if (v === '--status') a.status = true;
    else if (v === '--install-skill') a.installSkill = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else if (v === '--version') a.version = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--') {
      a.paths.push(...argv.slice(i + 1));
      break;
    } else if (v.startsWith('--')) throw new CliError(L.badOption(v));
    else a.paths.push(v);
  }
  return a;
}

const insideDir = (child: string, dir: string) => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * 문서가 속할 허용 폴더(SDD 2장): `--root`가 그 문서를 품으면 그것, 아니면 가장 가까운 git 저장소 루트,
 * 그것도 없으면 파일 폴더(폴더면 그 폴더).
 */
export function findRoot(target: string, isDir: boolean, explicitRoot?: string): string {
  if (explicitRoot) {
    const r = path.resolve(explicitRoot);
    if (insideDir(target, r)) return r;
  }
  const start = isDir ? target : path.dirname(target);
  for (let dir = start; ; ) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** 127.0.0.1의 실행기에 요청한다. Host는 서버가 받는 이름 그대로 보낸다. */
export function apiRequest(port: number, token: string, method: 'GET' | 'POST', api: string, body?: unknown, timeoutMs = 2000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        // 연결을 붙잡아 두지 않는다. 명령이 바로 끝나고, 닫힌 서버의 소켓을 다시 쓰지 않게 한다.
        agent: false,
        path: `${api}?t=${encodeURIComponent(token)}`,
        headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

export type Probe = { kind: 'ok'; version: string; pid: number } | { kind: 'forbidden' } | { kind: 'down' };

/** 그 포트·토큰의 실행기가 살아 있는지. 403이면 다른 토큰의 서버(또는 다른 프로그램)가 그 포트를 쓴다. */
export async function probe(port: number | null, token: string | null): Promise<Probe> {
  if (!port || !token) return { kind: 'down' };
  try {
    const r = await apiRequest(port, token, 'GET', '/api/ping', undefined, 300);
    if (r.status === 200) {
      const v = JSON.parse(r.text);
      return { kind: 'ok', version: String(v.version ?? ''), pid: Number(v.pid) };
    }
    return r.status === 403 ? { kind: 'forbidden' } : { kind: 'down' };
  } catch {
    return { kind: 'down' };
  }
}

/**
 * state.json의 pid가 지금 살아 있는 내 프로세스인지. 아니면(끝났거나, 다른 사용자의 프로세스면) 그 포트에 묻지 않는다.
 * 묻는 요청에 토큰이 실리므로, 실행기가 꺼진 사이 그 포트를 차지한 남의 프로그램에 토큰을 넘기지 않기 위해서다.
 */
export function ownLiveProcess(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: 없음, EPERM: 다른 사용자의 프로세스
  }
}

/** state.json이 가리키는 실행기에 묻는다. 내 실행기가 떠 있을 수 없는 상태면 묻지 않고 down으로 본다. */
function probeState(st: { port: number | null; token: string | null; pid: number | null } | null): Promise<Probe> {
  return st && ownLiveProcess(st.pid) ? probe(st.port, st.token) : Promise.resolve({ kind: 'down' });
}

export async function ping(port: number, token: string): Promise<{ version: string; pid: number } | null> {
  const p = await probe(port, token);
  return p.kind === 'ok' ? p : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALE_LOCK_MS = 10_000;

/** 실행기 시작을 한 번에 하나로 묶는다. 10초 넘은 잠금은 죽은 명령이 남긴 것으로 보고 지운다. */
async function acquireLock(home: string): Promise<() => void> {
  ensureHome(home);
  const file = lockPath(home);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch {
        continue; // 그사이 풀렸다.
      }
      if (Date.now() > deadline) throw new CliError(L.lockBusy(file));
      await sleep(50);
    }
  }
}

/**
 * 떠 있는 실행기를 다시 쓰고, 없으면 분리된 프로세스로 띄운 뒤 준비될 때까지 기다린다 (SDD 7.3).
 * - 같은 버전이 답하면 그대로 쓴다. 다른 버전이면 멈추고 새로 띄운다.
 * - 403으로 답하면(토큰이 맞지 않는 남의 서버) 그 포트·토큰을 버리고 빈 포트에 새 토큰으로 띄운다.
 */
export async function ensureServer(io: CliIo, preferredPort?: number): Promise<{ port: number; token: string; pid: number; reused: boolean }> {
  const home = homeDir(io.env);
  const first = readState(home);
  const quick = await probeState(first);
  if (quick.kind === 'ok' && quick.version === VERSION) return { port: first!.port!, token: first!.token!, pid: quick.pid, reused: true };

  const release = await acquireLock(home);
  try {
    // 잠금을 기다리는 동안 다른 명령이 띄웠을 수 있다.
    const st = readState(home);
    const now = await probeState(st);
    if (now.kind === 'ok' && now.version === VERSION) return { port: st!.port!, token: st!.token!, pid: now.pid, reused: true };
    if (now.kind === 'ok') {
      io.out(L.versionRestart(now.version));
      await apiRequest(st!.port!, st!.token!, 'POST', '/api/stop', {}).catch(() => null);
      for (let i = 0; i < 60 && (await probe(st!.port, st!.token)).kind === 'ok'; i++) await sleep(50);
    } else if (now.kind === 'forbidden' && st) {
      writeState(home, { ...st, port: null, token: null, pid: null });
    }

    const args = [io.scriptPath, '--serve', ...(preferredPort !== undefined ? ['--port', String(preferredPort)] : [])];
    // 분리하고 표준 입출력을 닫아, 부른 쪽(Claude Code의 셸 등)이 서버를 기다리며 멈추지 않게 한다.
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: io.env, windowsHide: true });
    child.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(100);
      const s = readState(home);
      if (s && s.pid === child.pid && s.port && s.token) {
        const p = await ping(s.port, s.token);
        if (p) return { port: s.port, token: s.token, pid: p.pid, reused: false };
      }
    }
    throw new CliError(L.serverFailed(new Logger(logsDir(home)).file));
  } finally {
    release();
  }
}

/** 인자로 받은 경로를 실행기가 읽을 수 있는 절대 경로로. WSL에서는 Windows 경로를 wslpath로 바꾼다. */
export function resolveArg(arg: string, io: CliIo): string {
  const platform = io.platform ?? currentPlatform(io.env);
  if (platform.wsl) {
    if (isWindowsPathArg(arg)) {
      try {
        return (io.toPosix ?? wslToPosix)(arg);
      } catch {
        throw new CliError(L.wslpathFailed(arg));
      }
    }
    if (isUncPath(arg) && arg.startsWith('\\')) throw new CliError(L.uncUnsupported(arg));
  }
  return path.resolve(io.cwd, arg);
}

/** `mdview` 명령 바로 가기를 만든다. POSIX는 ~/.local/bin/mdview, Windows는 <실행기 홈>/bin/mdview.cmd. */
export function installShim(io: CliIo, skillDir: string): { file: string; dir: string; onPath: boolean } {
  const platform = io.platform ?? currentPlatform(io.env);
  const win = platform.platform === 'win32' && !platform.wsl;
  const dir = win ? path.join(homeDir(io.env), 'bin') : path.join(io.userHome ?? os.homedir(), '.local', 'bin');
  const file = path.join(dir, win ? 'mdview.cmd' : 'mdview');
  const script = path.join(skillDir, 'mdview.mjs');
  const body = win ? `@node "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script.replace(/["\\$`]/g, '\\$&')}" "$@"\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(file, 0o755);
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const pathVar = io.env.PATH ?? io.env.Path ?? '';
  const onPath = pathVar.split(win ? ';' : ':').filter(Boolean).some((d) => same(path.resolve(d), path.resolve(dir)));
  return { file, dir, onPath };
}

function installSkill(io: CliIo, target: string | true): number {
  const dir = target === true ? path.join(io.userHome ?? os.homedir(), '.claude', 'skills', 'mdview') : path.resolve(io.cwd, target);
  const from = path.dirname(io.scriptPath);
  const files = ['SKILL.md', path.basename(io.scriptPath), 'viewer.html'];
  for (const f of files) if (!fs.existsSync(path.join(from, f))) throw new CliError(L.installMissing(path.join(from, f)));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(from, f), path.join(dir, f === path.basename(io.scriptPath) ? 'mdview.mjs' : f));
  io.out(L.installed(dir));
  const shim = installShim(io, dir);
  io.out(L.shimWritten(shim.file));
  io.out(shim.onPath ? L.onPath(shim.dir) : L.notOnPath(shim.dir));
  return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const a = parseArgs(argv);
    if (a.help) {
      io.out(L.help);
      return 0;
    }
    if (a.version) {
      io.out(VERSION);
      return 0;
    }
    if (a.installSkill) return installSkill(io, a.installSkill);
    const home = homeDir(io.env);
    if (a.status || a.stop) {
      const st = readState(home);
      const alive = st?.port && st.token && ownLiveProcess(st.pid) ? await ping(st.port, st.token) : null;
      if (!alive || !st?.port || !st.token) {
        io.out(L.notRunning);
        return 0;
      }
      if (a.status) {
        io.out(L.status(st.port, alive.pid));
        return 0;
      }
      await apiRequest(st.port, st.token, 'POST', '/api/stop', {});
      io.out(L.stopped);
      return 0;
    }

    const root = a.root ? resolveArg(a.root, io) : undefined;
    const targets = a.paths.map((p) => {
      const abs = resolveArg(p, io);
      let isDir: boolean;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        throw new CliError(L.notFound(abs));
      }
      return { path: abs, isDir };
    });
    const server = await ensureServer(io, a.port);
    // WSL에서 새로 띄운 서버는 Windows 쪽 localhost 전달이 준비된 뒤에 주소를 낸다. 그 전에 열면 연결 거부 화면이 뜬다.
    if (!server.reused && (io.platform ?? currentPlatform(io.env)).wsl) await (io.waitReachable ?? waitWindowsReachable)(server.port);
    const roots = new Set(targets.map((t) => findRoot(t.path, t.isDir, root)));
    if (root && !targets.length) roots.add(root);
    for (const r of roots) await apiRequest(server.port, server.token, 'POST', '/api/roots', { root: r });

    const q = new URLSearchParams({ t: server.token });
    for (const t of targets) q.append(t.isDir ? 'd' : 'f', t.path);
    const url = `http://127.0.0.1:${server.port}/?${q}`;
    const files = targets.filter((t) => !t.isDir).length;
    const dirs = targets.length - files;
    if (files) io.out(L.opening(files));
    if (dirs) io.out(L.openingFolder(dirs));
    if (!targets.length) io.out(L.openingEmpty);
    if (a.noOpen) io.out(L.noOpen);
    else {
      const opened = await (io.open ?? ((u) => openBrowser(u, io.platform ?? currentPlatform(io.env))))(url);
      if (!opened) io.err(L.browserFailed);
    }
    // 마지막 줄은 주소만 둔다. 스킬과 스크립트가 이 줄을 읽는다.
    io.out(url);
    return 0;
  } catch (e) {
    io.err(e instanceof CliError ? e.message : String((e as Error)?.stack ?? e));
    return 1;
  }
}
