// 파일 핸들 브리지 (SDD 4장, 6.1, 7.2). 독립 모드에서 브라우저의 파일 API로 문서를 읽는다.
// 위치는 `mdv:/<루트 id>/<상대 경로>`. 루트 id: 폴더 핸들 d, 파일 핸들 f, 핸들 없는 파일 u, 끌어다 놓은 폴더 항목 e.
import { isEncoding } from '../encoding';
import { normalizePath, isMarkdownPath, isTextPath } from '../render/paths';
import { S } from '../strings';
import { filterEntries, imageType, MAX_FILE_BYTES, toHostDoc } from './listing';
import { Emitter, HostError, type Bridge, type BridgeEvent, type DirEntry, type PathEntry, type ReadyInfo } from './types';

// File System Access API 중 쓰는 부분만 적는다 (TypeScript DOM 정의에 아직 없는 것이 있다).
interface FsHandle {
  kind: 'file' | 'directory';
  name: string;
  isSameEntry(other: FsHandle): Promise<boolean>;
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>;
}
interface FsFile extends FsHandle {
  kind: 'file';
  getFile(): Promise<File>;
}
interface FsDir extends FsHandle {
  kind: 'directory';
  getDirectoryHandle(name: string): Promise<FsDir>;
  getFileHandle(name: string): Promise<FsFile>;
  values(): AsyncIterable<FsFile | FsDir>;
  resolve(h: FsHandle): Promise<string[] | null>;
}
// 끌어다 놓은 폴더의 옛 항목 API (Firefox·Safari)
interface OldEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface OldFileEntry extends OldEntry {
  file(ok: (f: File) => void, fail: (e: unknown) => void): void;
}
interface OldDirEntry extends OldEntry {
  createReader(): { readEntries(ok: (e: OldEntry[]) => void, fail: (e: unknown) => void): void };
  getFile(path: string, o: object, ok: (e: OldFileEntry) => void, fail: (e: unknown) => void): void;
  getDirectory(path: string, o: object, ok: (e: OldDirEntry) => void, fail: (e: unknown) => void): void;
}

type RootKind = 'dir' | 'file' | 'mem' | 'entry';

interface Root {
  id: string;
  kind: RootKind;
  /** 화면에 보일 이름(폴더·파일 이름) */
  name: string;
  dir?: FsDir;
  file?: FsFile;
  entry?: OldDirEntry;
  /** 핸들 없는 파일(input으로 받은 것): 상대 경로 → File. 폴더째 받았으면 folder = true */
  files?: Map<string, File>;
  folder?: boolean;
  /** 권한을 다시 받아야 하는지 (저장해 둔 핸들) */
  locked?: boolean;
}

const DOC_ACCEPT = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext', '.txt'];
const DB_NAME = 'mdview';
const DB_STORE = 'roots';
const POLL_MS = 1000;
/** 끌어다 놓은 항목의 핸들을 기다리는 시간. 넘으면 옛 API(webkitGetAsEntry·File)로 연다. */
const HANDLE_WAIT_MS = 1500;

function err(code: string): HostError {
  const msg: Record<string, string> = {
    ENOENT: S.error.noFile,
    EACCES: S.error.accessDenied,
    EISDIR: S.error.isFolder,
    ETOOBIG: S.error.tooBig,
    ENOTSUP: S.error.notSupported,
    EINVAL: S.error.badPath,
  };
  return new HostError(code, msg[code] ?? S.error.host);
}

/** 브라우저 파일 API 예외를 브리지 오류 코드로 */
function mapError(e: unknown): HostError {
  if (e instanceof HostError) return e;
  const name = (e as { name?: string })?.name;
  if (name === 'NotFoundError') return err('ENOENT');
  if (name === 'NotAllowedError' || name === 'SecurityError') return err('EACCES');
  if (name === 'TypeMismatchError') return err('EISDIR');
  if (name === 'NotReadableError') return err('ENOTSUP');
  return new HostError('EIO', (e as Error)?.message ?? String(e));
}

/** IndexedDB에 넣는 핸들 행 */
function savedRow(r: Root) {
  return { id: r.id, kind: r.kind, name: r.name, handle: r.dir ?? r.file };
}

/** ms 안에 풀리지 않거나 실패하면 null */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function oldFile(entry: OldFileEntry): Promise<File> {
  return new Promise((ok, fail) => entry.file(ok, fail));
}

function oldChild(dir: OldDirEntry, rel: string, asDir: boolean): Promise<OldEntry> {
  return new Promise((ok, fail) => (asDir ? dir.getDirectory(rel, {}, ok, fail) : dir.getFile(rel, {}, ok, fail)));
}

async function oldList(dir: OldDirEntry): Promise<OldEntry[]> {
  const reader = dir.createReader();
  const all: OldEntry[] = [];
  for (;;) {
    const batch = await new Promise<OldEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

export class LocalBridge implements Bridge {
  readonly mode = 'standalone' as const;
  readonly caps = { reveal: false, fullPaths: false };
  private roots = new Map<string, Root>();
  private seq = 0;
  private events = new Emitter();
  private watched = new Map<string, { stamp: string; gone: boolean }>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private images = new Map<string, string>();
  private db: Promise<IDBDatabase | null> | null = null;
  /** 연 파일·폴더 핸들을 IndexedDB에 기억할지 (설정, SDD 8.4) */
  private remember = true;

  /** pollMs: 열린 파일을 확인하는 주기, handleWaitMs: 끌어다 놓은 항목의 핸들을 기다리는 시간(테스트에서 줄인다). */
  constructor(private readonly opts: { pollMs?: number; handleWaitMs?: number } = {}) {}

  on(event: BridgeEvent, fn: (p: any) => void) {
    this.events.on(event, fn);
  }

  connect() {}

  disconnect() {}

  isRestorable(path: string): boolean {
    const m = /^mdv:\/([df])\d+\//i.exec(path);
    return !!m && this.remember;
  }

  isPending(path: string): boolean {
    const m = /^mdv:\/([^/]+)\//i.exec(path);
    return !!m && !!this.roots.get(m[1])?.locked;
  }

  async request<T = any>(method: string, p: Record<string, any> = {}): Promise<T> {
    switch (method) {
      case 'app.ready':
        return (await this.ready()) as T;
      case 'file.read':
        return (await this.read(p.path, isEncoding(p.encoding) ? p.encoding : undefined)) as T;
      case 'dir.list':
        return { entries: filterEntries(await this.list(p.path)) } as T;
      case 'dialog.openFiles':
        return { paths: await this.pickFiles() } as T;
      case 'dialog.openFolder':
        return { path: await this.pickFolder() } as T;
      case 'watch.set':
        this.setWatch(p.paths ?? []);
        return {} as T;
      case 'store.save':
        try {
          localStorage.setItem('mdv.' + p.name, p.data);
        } catch {
          // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 세션을 기억하지 않는다.
        }
        if (p.name === 'session') void this.prune(String(p.data));
        return {} as T;
      case 'handles.remember':
        await this.setRemember(!!p.on);
        return {} as T;
      case 'shell.openExternal':
        if (!/^(https?:|mailto:)/i.test(String(p.url ?? ''))) throw err('EINVAL');
        window.open(p.url, '_blank', 'noopener,noreferrer');
        return {} as T;
      case 'session.restore':
        return { restored: await this.restorePermissions() } as T;
      case 'file.relocate':
        return { path: await this.relocate(p.path, p.dir) } as T;
      case 'app.log':
        (p.level === 'error' ? console.error : console.log)(p.msg);
        return {} as T;
      default:
        throw err('ENOTSUP');
    }
  }

  // ------------------------------------------------------------------ 위치·루트

  private parse(path: string): { root: Root; rel: string } {
    const m = /^mdv:\/([^/]+)\/?(.*)$/i.exec(normalizePath(String(path ?? '')));
    const root = m && this.roots.get(m[1]);
    if (!root) throw err('ENOENT');
    return { root, rel: m[2] };
  }

  /** 루트 id 번호는 페이지를 다시 열어도 되풀이하지 않는다(지난 세션의 위치와 섞이지 않게). */
  private nextId(prefix: string): string {
    try {
      this.seq = Math.max(this.seq, Number(localStorage.getItem('mdv.rootSeq')) || 0);
    } catch {
      // 저장소가 없으면 이 페이지 안에서만 겹치지 않으면 된다.
    }
    this.seq++;
    try {
      localStorage.setItem('mdv.rootSeq', String(this.seq));
    } catch {
      // 위와 같다.
    }
    return prefix + this.seq;
  }

  private addRoot(root: Root): string {
    this.roots.set(root.id, root);
    if ((root.kind === 'dir' || root.kind === 'file') && this.remember) void this.persist(root);
    return `mdv:/${root.id}/`;
  }

  displayPath(path: string): string {
    try {
      const { root, rel } = this.parse(path);
      if (root.kind === 'file' || (root.kind === 'mem' && !root.folder)) return root.name;
      return rel ? `${root.name}/${rel}` : root.name;
    } catch {
      return path;
    }
  }

  rootOf(path: string): string | null {
    const m = /^mdv:\/([^/]+)/i.exec(path);
    return m ? `mdv:/${m[1]}/` : null;
  }

  canResolveRelative(path: string): boolean {
    try {
      const { root } = this.parse(path);
      return root.kind === 'dir' || root.kind === 'entry' || (root.kind === 'mem' && !!root.folder);
    } catch {
      return false;
    }
  }

  /** 이미 연 폴더 안의 파일이면 그 폴더 기준 위치를, 이미 연 파일이면 그 위치를 돌려준다. */
  private async addFileHandle(h: FsFile): Promise<string> {
    for (const r of this.roots.values()) {
      try {
        if (r.kind === 'dir' && r.dir) {
          const segs = await r.dir.resolve(h);
          if (segs) return `mdv:/${r.id}/${segs.join('/')}`;
        } else if (r.kind === 'file' && r.file && (await r.file.isSameEntry(h))) {
          return `mdv:/${r.id}/${r.name}`;
        }
      } catch {
        // 권한이 없는 저장된 루트는 건너뛴다.
      }
    }
    const id = this.nextId('f');
    this.addRoot({ id, kind: 'file', name: h.name, file: h });
    return `mdv:/${id}/${h.name}`;
  }

  private async addDirHandle(h: FsDir): Promise<string> {
    for (const r of this.roots.values()) {
      if (r.kind === 'dir' && r.dir && (await r.dir.isSameEntry(h).catch(() => false))) return `mdv:/${r.id}/`;
    }
    return this.addRoot({ id: this.nextId('d'), kind: 'dir', name: h.name, dir: h });
  }

  private addFiles(files: File[], folder: boolean): PathEntry[] {
    if (!files.length) return [];
    if (folder) {
      // webkitdirectory: 상대 경로의 첫 마디가 고른 폴더 이름이다.
      const top = (files[0].webkitRelativePath || files[0].name).split('/')[0];
      const map = new Map<string, File>();
      for (const f of files) map.set((f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, f);
      const path = this.addRoot({ id: this.nextId('u'), kind: 'mem', name: top, files: map, folder: true });
      return [{ path, isDir: true }];
    }
    return files.map((f) => {
      const id = this.nextId('u');
      this.addRoot({ id, kind: 'mem', name: f.name, files: new Map([[f.name, f]]) });
      return { path: `mdv:/${id}/${f.name}`, isDir: false };
    });
  }

  // ------------------------------------------------------------------ 읽기

  private async fileHandleAt(root: Root, rel: string): Promise<FsFile> {
    if (root.kind === 'file') {
      if (rel !== root.name || !root.file) throw err('ENOENT');
      return root.file;
    }
    const segs = rel.split('/').filter(Boolean);
    if (!segs.length) throw err('EISDIR');
    let dir = root.dir!;
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    return dir.getFileHandle(segs[segs.length - 1]);
  }

  /** 위치의 현재 파일. 핸들이면 디스크의 최신 내용이다. */
  private async fileAt(path: string): Promise<File> {
    const { root, rel } = this.parse(path);
    try {
      if (root.kind === 'dir' || root.kind === 'file') return await (await this.fileHandleAt(root, rel)).getFile();
      if (root.kind === 'entry') return await oldFile((await oldChild(root.entry!, rel, false)) as OldFileEntry);
      const f = root.files?.get(rel);
      if (!f) throw err('ENOENT');
      return f;
    } catch (e) {
      throw mapError(e);
    }
  }

  private async read(path: string, encoding?: Parameters<typeof toHostDoc>[3]) {
    const file = await this.fileAt(path);
    if (file.size > MAX_FILE_BYTES) throw err('ETOOBIG');
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      throw mapError(e);
    }
    return toHostDoc(normalizePath(path), bytes, file.lastModified, encoding);
  }

  private async list(path: string): Promise<DirEntry[]> {
    const { root, rel } = this.parse(path);
    const segs = rel.split('/').filter(Boolean);
    try {
      if (root.kind === 'dir') {
        let dir = root.dir!;
        for (const s of segs) dir = await dir.getDirectoryHandle(s);
        const out: DirEntry[] = [];
        for await (const h of dir.values()) out.push({ name: h.name, isDir: h.kind === 'directory' });
        return out;
      }
      if (root.kind === 'entry') {
        const dir = segs.length ? ((await oldChild(root.entry!, segs.join('/'), true)) as OldDirEntry) : root.entry!;
        return (await oldList(dir)).map((e) => ({ name: e.name, isDir: e.isDirectory }));
      }
      if (root.kind === 'mem' && root.folder) {
        const prefix = segs.length ? segs.join('/') + '/' : '';
        const seen = new Map<string, boolean>();
        for (const key of root.files!.keys()) {
          if (!key.startsWith(prefix)) continue;
          const [head, ...tail] = key.slice(prefix.length).split('/');
          seen.set(head, seen.get(head) || tail.length > 0);
        }
        return [...seen].map(([name, isDir]) => ({ name, isDir }));
      }
    } catch (e) {
      throw mapError(e);
    }
    throw err('ENOENT');
  }

  imageUrl(): string | null {
    return null;
  }

  async loadImage(path: string): Promise<string | null> {
    const type = imageType(path);
    if (!type) return null;
    try {
      const file = await this.fileAt(path);
      const key = `${path}\n${file.lastModified}\n${file.size}`;
      const cached = this.images.get(key);
      if (cached) return cached;
      const url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type }));
      this.images.set(key, url);
      return url;
    } catch {
      return null;
    }
  }

  /** 단독 파일로 연 문서를 고른 폴더 기준 위치로 바꾼다 (SDD 7.2-6). 폴더가 그 파일을 품지 않으면 null. */
  private async relocate(path: string, dirPath: string): Promise<string | null> {
    const { root, rel } = this.parse(path);
    const target = this.parse(dirPath).root;
    // 핸들끼리는 resolve()로 정확히 찾는다.
    if (root.kind === 'file' && root.file && target.kind === 'dir' && target.dir) {
      const segs = await target.dir.resolve(root.file).catch(() => null);
      return segs ? `mdv:/${target.id}/${segs.join('/')}` : null;
    }
    // 그 밖(핸들 없는 파일, input으로 고른 폴더): 고른 폴더에서 이름과 크기가 같은 파일을 하나 찾으면 그것으로 본다.
    const file =
      root.kind === 'file' && root.file ? await root.file.getFile().catch(() => null) : root.kind === 'mem' && !root.folder ? root.files?.get(rel) : undefined;
    if (!file) return null;
    let hits: string[] = [];
    if (target.kind === 'dir' && target.dir) hits = await findByNameSize(target.dir, file.name, file.size);
    else if (target.kind === 'mem' && target.folder && target.files) {
      for (const [r, f] of target.files) if (r.split('/').pop() === file.name && f.size === file.size) hits.push(r);
    }
    return hits.length === 1 ? `mdv:/${target.id}/${hits[0]}` : null;
  }

  /** 세션·최근 목록이 가리키지 않는 저장된 핸들은 지운다. */
  private async prune(sessionJson: string) {
    const db = this.remember ? await this.openDb() : null;
    if (!db) return;
    const used = new Set(Array.from(sessionJson.matchAll(/mdv:\/([a-z]+\d+)/gi), (m) => m[1]));
    try {
      const store = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE);
      const req = store.getAllKeys();
      // 저장소를 세션(탭·작업 공간·최근 목록)이 가리키는 핸들과 같게 맞춘다: 안 가리키면 지우고, 가리키는데 없으면 넣는다.
      req.onsuccess = () => {
        const have = new Set(req.result.map(String));
        for (const key of have) if (!used.has(key)) store.delete(key);
        for (const id of used) {
          const r = this.roots.get(id);
          if (!have.has(id) && r && (r.kind === 'dir' || r.kind === 'file')) store.put(savedRow(r));
        }
      };
    } catch {
      // 정리하지 못해도 다음 저장에서 다시 한다.
    }
  }

  private async setRemember(on: boolean) {
    this.remember = on;
    const db = await this.openDb();
    if (!db) return;
    try {
      const store = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE);
      if (on) {
        for (const r of this.roots.values()) if (r.kind === 'dir' || r.kind === 'file') store.put(savedRow(r));
      } else {
        store.clear();
      }
    } catch {
      // 위와 같다.
    }
  }

  // ------------------------------------------------------------------ 열기

  private async pickFiles(): Promise<string[]> {
    const w = window as any;
    if (typeof w.showOpenFilePicker === 'function') {
      let handles: FsFile[];
      try {
        handles = await w.showOpenFilePicker({
          multiple: true,
          types: [{ description: S.picker.documents, accept: { 'text/markdown': DOC_ACCEPT.filter((x) => x !== '.txt'), 'text/plain': ['.txt'] } }],
        });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return [];
        throw mapError(e);
      }
      const out: string[] = [];
      for (const h of handles) out.push(await this.addFileHandle(h));
      return out;
    }
    return this.addFiles(await pickViaInput(false), false).map((e) => e.path);
  }

  private async pickFolder(): Promise<string | null> {
    const w = window as any;
    if (typeof w.showDirectoryPicker === 'function') {
      try {
        return await this.addDirHandle(await w.showDirectoryPicker({ mode: 'read' }));
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return null;
        throw mapError(e);
      }
    }
    return this.addFiles(await pickViaInput(true), true)[0]?.path ?? null;
  }

  takeDrop(dt: DataTransfer): Promise<PathEntry[]> {
    // 항목은 drop 이벤트가 끝나면 읽을 수 없으므로 여기서 바로 꺼낸다.
    const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
    const grabbed = items.map((i) => {
      const any = i as any;
      return {
        handle: typeof any.getAsFileSystemHandle === 'function' ? (any.getAsFileSystemHandle() as Promise<FsHandle | null>) : null,
        entry: typeof any.webkitGetAsEntry === 'function' ? (any.webkitGetAsEntry() as OldEntry | null) : null,
        file: i.getAsFile(),
      };
    });
    if (!items.length) grabbed.push(...Array.from(dt.files ?? []).map((file) => ({ handle: null, entry: null, file })));
    return (async () => {
      const out: PathEntry[] = [];
      for (const g of grabbed) {
        // 핸들 약속이 풀리지 않는 경우가 있다(자동화 도구가 흉내 낸 폴더 끌어다 놓기 등). 기다림을 제한한다.
        const h = g.handle ? await withTimeout(g.handle, this.opts.handleWaitMs ?? HANDLE_WAIT_MS) : null;
        if (h?.kind === 'directory') out.push({ path: await this.addDirHandle(h as FsDir), isDir: true });
        else if (h?.kind === 'file') out.push({ path: await this.addFileHandle(h as FsFile), isDir: false });
        else if (g.entry?.isDirectory) out.push({ path: this.addRoot({ id: this.nextId('e'), kind: 'entry', name: g.entry.name, entry: g.entry as OldDirEntry }), isDir: true });
        else if (g.file) out.push(...this.addFiles([g.file], false));
      }
      return out;
    })();
  }

  // ------------------------------------------------------------------ 감시 (1초 폴링)

  private setWatch(paths: string[]) {
    const want = new Set(paths.filter((p) => /^mdv:/i.test(p)).map((p) => normalizePath(p)));
    for (const p of [...this.watched.keys()]) if (!want.has(p)) this.watched.delete(p);
    for (const p of want) {
      if (this.watched.has(p)) continue;
      let root: Root;
      try {
        root = this.parse(p).root;
      } catch {
        continue; // 루트가 없다(권한을 잃은 지난 세션의 위치 등).
      }
      if (root.kind === 'mem') continue; // 핸들 없는 파일은 다시 읽을 수 없다.
      this.watched.set(p, { stamp: '', gone: false });
      void this.stamp(p).then((s) => {
        const w = this.watched.get(p);
        if (w && !w.stamp) w.stamp = s ?? '';
      });
    }
    if (this.watched.size && !this.pollTimer) this.pollTimer = setInterval(() => void this.poll(), this.opts.pollMs ?? POLL_MS);
    if (!this.watched.size && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async stamp(path: string): Promise<string | null> {
    try {
      const f = await this.fileAt(path);
      return `${f.lastModified}:${f.size}`;
    } catch (e) {
      if (e instanceof HostError && e.code === 'ENOENT') return null;
      return '';
    }
  }

  private async poll() {
    for (const [path, w] of this.watched) {
      const s = await this.stamp(path);
      if (s === null) {
        if (!w.gone) {
          w.gone = true;
          this.events.emit('file.deleted', { path });
        }
      } else if (s && (w.gone || (w.stamp && s !== w.stamp))) {
        w.gone = false;
        w.stamp = s;
        this.events.emit('file.changed', { path });
      } else if (s && !w.stamp) {
        w.stamp = s;
      }
    }
  }

  // ------------------------------------------------------------------ 세션 (IndexedDB 핸들)

  private openDb(): Promise<IDBDatabase | null> {
    if (!this.db) {
      this.db = new Promise((ok) => {
        try {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
          req.onsuccess = () => ok(req.result);
          req.onerror = () => ok(null);
        } catch {
          ok(null);
        }
      });
    }
    return this.db;
  }

  private async persist(root: Root) {
    const db = await this.openDb();
    if (!db) return;
    try {
      db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(savedRow(root));
    } catch {
      // 핸들을 저장할 수 없으면 다음 실행에서 복원하지 않는다.
    }
  }

  private async loadSaved(): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    const rows = await new Promise<any[]>((ok) => {
      try {
        const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
        req.onsuccess = () => ok(req.result ?? []);
        req.onerror = () => ok([]);
      } catch {
        ok([]);
      }
    });
    for (const r of rows) {
      const n = Number(/\d+$/.exec(r.id)?.[0] ?? 0);
      this.seq = Math.max(this.seq, n);
      if (this.roots.has(r.id) || !r.handle) continue;
      const state = await r.handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt');
      this.roots.set(r.id, {
        id: r.id, kind: r.kind, name: r.name,
        dir: r.kind === 'dir' ? r.handle : undefined,
        file: r.kind === 'file' ? r.handle : undefined,
        locked: state !== 'granted',
      });
    }
  }

  /** 저장된 핸들에 읽기 권한을 다시 받는다. 사용자 클릭 처리기 안에서 불러야 한다. */
  private async restorePermissions(): Promise<number> {
    let n = 0;
    for (const r of this.roots.values()) {
      if (!r.locked) continue;
      const h = r.dir ?? r.file;
      const state = await h?.requestPermission?.({ mode: 'read' }).catch(() => 'denied');
      if (state === 'granted') {
        r.locked = false;
        n++;
      }
    }
    return n;
  }

  private async ready(): Promise<ReadyInfo> {
    await this.loadSaved();
    const get = (k: string) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    };
    return {
      mode: 'standalone',
      args: [],
      settings: get('mdv.settings'),
      session: get('mdv.session'),
      version: __MDV_VERSION__,
      roots: [],
      restorable: [...this.roots.values()].filter((r) => r.locked).length,
    };
  }
}

/** File System Access API가 없는 브라우저용: 숨은 input으로 파일·폴더를 고른다. */
function pickViaInput(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) (input as any).webkitdirectory = true;
    else input.accept = DOC_ACCEPT.join(',');
    input.style.display = 'none';
    const done = (files: File[]) => {
      input.remove();
      resolve(files.filter((f) => !folder || isMarkdownPath(f.name) || isTextPath(f.name) || imageType(f.name)));
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

/** 폴더 아래(깊이 4까지, 항목 2000개까지)에서 이름과 크기가 같은 파일의 상대 경로들 */
async function findByNameSize(dir: FsDir, name: string, size: number, prefix = '', depth = 0, budget = { n: 2000 }): Promise<string[]> {
  const out: string[] = [];
  for await (const h of dir.values()) {
    if (--budget.n < 0) break;
    if (h.kind === 'file' && h.name === name && (await h.getFile()).size === size) out.push(prefix + h.name);
    else if (h.kind === 'directory' && depth < 4 && !h.name.startsWith('.') && h.name !== 'node_modules') {
      out.push(...(await findByNameSize(h, name, size, prefix + h.name + '/', depth + 1, budget)));
    }
  }
  return out;
}
