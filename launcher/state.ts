// 실행기 상태 (SDD 5.4): `~/.mdview/state.json`(포트·토큰·pid·허용 폴더)과 로그 폴더. MDVIEW_HOME으로 옮길 수 있다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 기억하는 허용 폴더 수. 넘으면 오래전에 더한 것부터 버린다. */
export const MAX_ROOTS = 100;

export interface LauncherState {
  schemaVersion: 2;
  port: number | null;
  token: string | null;
  /** 떠 있는 서버의 pid. 서버가 끝나면 null로 두고 포트·토큰은 남겨 다음 서버가 다시 쓴다. */
  pid: number | null;
  version: string;
  /** 허용 폴더(사용자가 준 경로), 오래된 것부터. 다시 뜬 서버가 이어 받는다. */
  roots: string[];
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MDVIEW_HOME || path.join(os.homedir(), '.mdview');
}

/** 홈 폴더는 본인만 읽게 만든다(0700). 토큰이 들어 있다. */
export function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function statePath(home: string): string {
  return path.join(home, 'state.json');
}

export function logsDir(home: string): string {
  return path.join(home, 'logs');
}

export function lockPath(home: string): string {
  return path.join(home, 'start.lock');
}

export function readState(home: string): LauncherState | null {
  try {
    const v = JSON.parse(fs.readFileSync(statePath(home), 'utf8'));
    if (!v || typeof v !== 'object') return null;
    return {
      schemaVersion: 2,
      port: Number.isInteger(v.port) && v.port > 0 && v.port < 65536 ? v.port : null,
      token: typeof v.token === 'string' && v.token.length >= 16 ? v.token : null,
      pid: Number.isInteger(v.pid) && v.pid > 0 ? v.pid : null,
      version: typeof v.version === 'string' ? v.version : '',
      roots: Array.isArray(v.roots) ? v.roots.filter((r: unknown): r is string => typeof r === 'string' && r.length > 0).slice(-MAX_ROOTS) : [],
    };
  } catch {
    return null;
  }
}

/** 임시 파일에 쓴 뒤 교체해, 쓰는 중에 끊겨도 파일이 깨지지 않게 한다. 파일은 본인만 읽는다(0600). */
export function writeState(home: string, state: LauncherState): void {
  ensureHome(home);
  const file = statePath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
