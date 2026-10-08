// 파일 감시 (SDD 4장, FR-WATCH-01~02, NFR-PERF-04).
// 파일이 아니라 상위 폴더를 fs.watch로 본다. 편집기가 임시 파일에 쓰고 이름을 바꿔 저장해도 놓치지 않기 위해서다.
// WSL의 Windows 드라이브(/mnt/<글자>/)·UNC는 Windows 쪽 변경이 알림으로 오지 않으므로 폴링한다.
import fs from 'node:fs';
import path from 'node:path';
import { caseInsensitiveFs, currentPlatform, needsPolling } from './os';

export interface WatchEvent {
  type: 'changed' | 'deleted';
  path: string;
}

export interface WatcherOptions {
  debounceMs?: number;
  pollMs?: number;
  /** 이 경로를 폴링으로 볼지. 기본은 os.needsPolling(WSL Windows 드라이브·UNC) */
  poll?: (file: string) => boolean;
  /** 폴더 알림의 파일 이름을 대소문자 없이 맞출지. 기본은 Windows·macOS에서 켠다(입력한 이름과 디스크의 이름이 다를 수 있다). */
  ignoreCase?: boolean;
  onError?: (dir: string, err: Error) => void;
}

interface FileState {
  stamp: string | null;
  gone: boolean;
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DirWatch {
  watcher: fs.FSWatcher;
  files: Set<string>;
}

function stampOf(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? `${s.mtimeMs}:${s.size}` : null;
  } catch {
    return null;
  }
}

export class Watcher {
  private files = new Map<string, FileState>();
  private dirs = new Map<string, DirWatch>();
  private debounceMs: number;
  private pollMs: number;
  private poll: (file: string) => boolean;

  constructor(
    private onEvent: (e: WatchEvent) => void,
    private opts: WatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 100;
    this.pollMs = opts.pollMs ?? 300;
    if (opts.poll) this.poll = opts.poll;
    else {
      const platform = currentPlatform();
      this.poll = (f) => needsPolling(f, platform);
    }
  }

  /** 감시 대상을 통째로 바꾼다. */
  setPaths(paths: Iterable<string>): void {
    const want = new Set(paths);
    for (const f of [...this.files.keys()]) if (!want.has(f)) this.remove(f);
    for (const f of want) if (!this.files.has(f)) this.add(f);
  }

  get watching(): string[] {
    return [...this.files.keys()];
  }

  close(): void {
    for (const f of [...this.files.keys()]) this.remove(f);
  }

  private add(file: string): void {
    const st: FileState = { stamp: stampOf(file), gone: false, polling: false, timer: null };
    st.gone = st.stamp === null;
    this.files.set(file, st);
    if (this.poll(file) || !this.watchDir(file)) this.startPolling(file, st);
  }

  private watchDir(file: string): boolean {
    const dir = path.dirname(file);
    const existing = this.dirs.get(dir);
    if (existing) {
      existing.files.add(file);
      return true;
    }
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        const d = this.dirs.get(dir);
        if (!d) return;
        const base = name ? String(name) : null;
        const ignoreCase = this.opts.ignoreCase ?? caseInsensitiveFs(currentPlatform());
        const same = (a: string, b: string) => (ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b);
        for (const f of d.files) if (!base || same(path.basename(f), base)) this.schedule(f);
      });
    } catch (err) {
      this.opts.onError?.(dir, err as Error);
      return false;
    }
    watcher.on('error', (err) => {
      // 폴더가 사라지는 등으로 감시가 끊기면 그 폴더의 파일을 폴링으로 돌린다.
      this.opts.onError?.(dir, err);
      const d = this.dirs.get(dir);
      this.dirs.delete(dir);
      try {
        watcher.close();
      } catch {
        // 이미 닫혔다.
      }
      for (const f of d?.files ?? []) {
        const st = this.files.get(f);
        if (st) {
          this.startPolling(f, st);
          this.schedule(f);
        }
      }
    });
    this.dirs.set(dir, { watcher, files: new Set([file]) });
    return true;
  }

  private startPolling(file: string, st: FileState): void {
    if (st.polling) return;
    st.polling = true;
    fs.watchFile(file, { interval: this.pollMs, persistent: false }, () => this.schedule(file));
  }

  private schedule(file: string): void {
    const st = this.files.get(file);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      this.check(file);
    }, this.debounceMs);
  }

  private check(file: string): void {
    const st = this.files.get(file);
    if (!st) return;
    const stamp = stampOf(file);
    if (stamp === null) {
      if (!st.gone) {
        st.gone = true;
        this.onEvent({ type: 'deleted', path: file });
      }
      return;
    }
    if (st.gone || stamp !== st.stamp) {
      st.gone = false;
      st.stamp = stamp;
      this.onEvent({ type: 'changed', path: file });
    }
  }

  private remove(file: string): void {
    const st = this.files.get(file);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    if (st.polling) fs.unwatchFile(file);
    this.files.delete(file);
    const dir = path.dirname(file);
    const d = this.dirs.get(dir);
    if (d) {
      d.files.delete(file);
      if (!d.files.size) {
        d.watcher.close();
        this.dirs.delete(dir);
      }
    }
  }
}
