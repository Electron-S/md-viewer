// OS 연동 (SDD 4장, NFR-PORT-02): 실행기 안에서 OS에 기대는 코드는 이 모듈에만 둔다.
// WSL·drvfs·UNC 판별, WSL 경로 바꾸기, WSL 포트가 Windows에서 닿기 기다리기, 브라우저 열기(Windows·WSL·macOS·Linux), 탐색기에서 파일 위치 열기.
// 외부 명령은 늘 셸 없이(execFile·spawn) 부른다. 주소·경로가 셸 문법으로 풀리지 않게 하기 위해서다.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Command = [cmd: string, args: string[]];

export interface Platform {
  platform: NodeJS.Platform;
  wsl: boolean;
  env: NodeJS.ProcessEnv;
}

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function currentPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  return { platform: process.platform, wsl: isWsl(), env };
}

/** WSL에서 Windows 드라이브를 마운트한 경로(/mnt/c/...). Windows 쪽 변경이 inotify로 오지 않는다. */
export function isDrvfsPath(p: string, wsl: boolean): boolean {
  return wsl && /^\/mnt\/[a-z](\/|$)/i.test(p);
}

/** 네트워크 공유 경로(\\server\share, //server/share) */
export function isUncPath(p: string): boolean {
  return /^(\\\\|\/\/)[^\\/]/.test(p);
}

/** 이 파일을 폴링으로 감시해야 하는지 (SDD 4장 감시 모듈) */
export function needsPolling(p: string, platform: Pick<Platform, 'wsl'>): boolean {
  return isDrvfsPath(p, platform.wsl) || isUncPath(p);
}

/** 파일 이름의 대소문자를 가리지 않는 파일 시스템인지(Windows·macOS 기본값) */
export function caseInsensitiveFs(p: Pick<Platform, 'platform'>): boolean {
  return p.platform === 'win32' || p.platform === 'darwin';
}

/** WSL에서 받은 인자가 Windows 형식 경로인지(C:\…, C:/…, \\wsl.localhost\…, \\wsl$\…) */
export function isWindowsPathArg(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\wsl(\.localhost|\$)\\/i.test(p);
}

export function wslToPosix(win: string): string {
  return execFileSync('wslpath', ['-u', win], { encoding: 'utf8' }).trim();
}

/** 따옴표를 존중해 명령 문자열을 나눈다(MDVIEW_BROWSER용). */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 기본 브라우저로 주소를 여는 명령 후보. 앞에서부터 시도한다 (FR-LAUNCH-04). */
export function browserCommands(url: string, p: Platform): Command[] {
  const out: Command[] = [];
  if (p.env.MDVIEW_BROWSER) {
    const [cmd, ...args] = splitCommand(p.env.MDVIEW_BROWSER);
    if (cmd) out.push([cmd, [...args, url]]);
  }
  if (p.wsl) {
    // Windows의 rundll32로 연다. explorer.exe는 물음표가 든 주소(?t=…)를 브라우저에 넘기지 못한다.
    // 주소는 셸을 거치지 않고 인자 하나로 넘긴다. rundll32가 없거나(상호 운용이 꺼진 경우) 실패하면 wslu의 wslview.
    out.push(['rundll32.exe', ['url.dll,FileProtocolHandler', url]], ['wslview', [url]]);
  } else if (p.platform === 'win32') {
    out.push(['rundll32', ['url.dll,FileProtocolHandler', url]]);
  } else if (p.platform === 'darwin') {
    out.push(['open', [url]]);
  } else {
    out.push(['xdg-open', [url]]);
  }
  return out;
}

/** 명령을 분리된 프로세스로 띄운다. 명령이 없으면(ENOENT) false. */
function launch([cmd, args]: Command): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** 명령을 셸 없이 돌려 종료 코드를 받는다. 명령이 없으면(ENOENT) null. */
function exitCode(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * WSL(NAT 네트워킹)은 WSL 안에서 새로 연 포트를 Windows의 localhost로 넘기기까지 0.5~1초쯤 걸린다.
 * 그 전에 Windows 브라우저가 주소를 열면 연결 거부 화면이 뜬다. Windows의 curl.exe로 닿을 때까지 기다린다.
 * curl.exe를 부를 수 없으면(Windows 상호 운용이 꺼진 경우 등) 1초만 기다린다.
 */
export async function waitWindowsReachable(port: number, timeoutMs = 5000, run: (cmd: string, args: string[]) => Promise<number | null> = exitCode): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = await run('curl.exe', ['-s', '-o', 'NUL', '-m', '1', `http://127.0.0.1:${port}/favicon.ico`]);
    if (code === 0) return true;
    if (code === null) {
      await sleep(1000);
      return false;
    }
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

export async function openBrowser(url: string, p: Platform = currentPlatform()): Promise<boolean> {
  for (const c of browserCommands(url, p)) if (await launch(c)) return true;
  return false;
}

/** 탐색기에서 파일 위치를 여는 명령 (FR-INFO-03). toWindows는 WSL 경로를 Windows 경로로 바꾼다. */
export function revealCommand(file: string, p: Platform, toWindows: (posix: string) => string = wslToWindows): Command {
  if (p.wsl) return ['explorer.exe', [`/select,${toWindows(file)}`]];
  if (p.platform === 'win32') return ['explorer', [`/select,${file}`]];
  if (p.platform === 'darwin') return ['open', ['-R', file]];
  return ['xdg-open', [path.dirname(file)]];
}

export function wslToWindows(posix: string): string {
  return execFileSync('wslpath', ['-w', posix], { encoding: 'utf8' }).trim();
}

export async function reveal(file: string, p: Platform = currentPlatform()): Promise<boolean> {
  return launch(revealCommand(file, p));
}
