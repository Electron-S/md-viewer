// 실행기 브리지 (SDD 4장, 6.1~6.2, 7.3). 실행기 모드에서 OS 경로를 실행기 서버의 HTTP·SSE로 읽는다.
// Ctrl+O·끌어다 놓기로 연 `mdv:` 위치는 품고 있는 파일 핸들 브리지가 맡는다.
import { isEncoding } from '../encoding';
import { isInside, normalizePath } from '../render/paths';
import { S } from '../strings';
import { filterEntries, toHostDoc } from './listing';
import type { LocalBridge } from './local';
import { Emitter, HostError, type Bridge, type BridgeEvent, type DirEntry, type PathEntry, type ReadyInfo } from './types';

const isLocal = (p: unknown) => typeof p === 'string' && /^mdv:/i.test(p);

export class ServerBridge implements Bridge {
  readonly mode = 'launcher' as const;
  readonly caps = { reveal: true, fullPaths: true };
  private readonly token: string;
  private readonly client = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private roots: string[] = [];
  private args: PathEntry[] = [];
  private watching: string[] = [];
  private events = new Emitter();
  private source: EventSource | null = null;
  private online = true;

  constructor(
    private local: LocalBridge,
    params: URLSearchParams,
  ) {
    this.token = params.get('t') ?? '';
    this.args = [
      ...params.getAll('f').map((path) => ({ path, isDir: false })),
      ...params.getAll('d').map((path) => ({ path, isDir: true })),
    ];
    // 다시 고칠 때 같은 인자로 탭이 또 열리지 않게 주소에는 토큰만 남긴다.
    try {
      history.replaceState(null, '', `${location.pathname}?t=${encodeURIComponent(this.token)}`);
    } catch {
      // 주소를 바꿀 수 없어도 동작에는 지장이 없다.
    }
    local.on('file.changed', (p) => this.events.emit('file.changed', p));
    local.on('file.deleted', (p) => this.events.emit('file.deleted', p));
  }

  on(event: BridgeEvent, fn: (p: any) => void) {
    this.events.on(event, fn);
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const q = new URLSearchParams({ t: this.token, ...query });
    return `${path}?${q}`;
  }

  private async call(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path, query), {
        method,
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new HostError('EOFFLINE', S.error.offline);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      const code = e?.code ?? 'EHOST';
      const known: Record<string, string> = {
        ENOENT: S.error.noFile,
        EACCES: S.error.accessDenied,
        EISDIR: S.error.isFolder,
        ETOOBIG: S.error.tooBig,
        EINVAL: S.error.badPath,
      };
      throw new HostError(code, known[code] ?? e?.message ?? S.error.host);
    }
    return res;
  }

  async request<T = any>(method: string, p: Record<string, any> = {}): Promise<T> {
    if (isLocal(p.path)) return this.local.request<T>(method, p);
    switch (method) {
      case 'app.ready': {
        const info = (await (await this.call('GET', '/api/ready')).json()) as { version: string; roots: string[] };
        this.roots = info.roots ?? [];
        const local = await this.local.request<ReadyInfo>('app.ready');
        return { ...local, mode: 'launcher', args: this.args, version: info.version, roots: this.roots } as T;
      }
      case 'file.read': {
        const res = await this.call('GET', '/api/read', { path: String(p.path) });
        const bytes = new Uint8Array(await res.arrayBuffer());
        const mtime = Number(res.headers.get('x-mdv-mtime') ?? Date.now());
        return toHostDoc(normalizePath(String(p.path)), bytes, mtime, isEncoding(p.encoding) ? p.encoding : undefined) as T;
      }
      case 'dir.list': {
        const entries = (await (await this.call('GET', '/api/list', { path: String(p.path) })).json()) as DirEntry[];
        return { entries: filterEntries(entries) } as T;
      }
      case 'watch.set': {
        const paths: string[] = p.paths ?? [];
        void this.local.request('watch.set', { paths: paths.filter(isLocal) }).catch(() => {});
        this.watching = paths.filter((x) => !isLocal(x));
        await this.call('POST', '/api/watch', {}, { client: this.client, paths: this.watching });
        return {} as T;
      }
      case 'shell.reveal':
        await this.call('POST', '/api/reveal', {}, { path: String(p.path) });
        return {} as T;
      case 'app.log':
        void this.call('POST', '/api/log', {}, { level: p.level, msg: String(p.msg) }).catch(() => {});
        return {} as T;
      default:
        // 대화상자, 저장소, 외부 링크, 세션 권한은 브라우저 쪽 일이다.
        return this.local.request<T>(method, p);
    }
  }

  /** 실행기 이벤트(SSE)에 붙는다. 끊기면 EventSource가 스스로 다시 붙고, 붙으면 감시 목록을 다시 보낸다. */
  connect() {
    if (this.source) return;
    const es = new EventSource(this.url('/api/events', { client: this.client }));
    this.source = es;
    es.addEventListener('file.changed', (e) => this.events.emit('file.changed', JSON.parse((e as MessageEvent).data)));
    es.addEventListener('file.deleted', (e) => this.events.emit('file.deleted', JSON.parse((e as MessageEvent).data)));
    es.onopen = () => {
      if (!this.online) {
        this.online = true;
        this.events.emit('bridge.online');
        if (this.watching.length) void this.call('POST', '/api/watch', {}, { client: this.client, paths: this.watching }).catch(() => {});
      }
    };
    es.onerror = () => {
      if (this.online) {
        this.online = false;
        this.events.emit('bridge.offline');
      }
    };
  }

  disconnect() {
    this.source?.close();
    this.source = null;
  }

  isRestorable(path: string): boolean {
    return isLocal(path) ? this.local.isRestorable(path) : true;
  }

  isPending(path: string): boolean {
    return isLocal(path) && this.local.isPending(path);
  }

  takeDrop(dt: DataTransfer): Promise<PathEntry[]> {
    return this.local.takeDrop(dt);
  }

  imageUrl(path: string): string | null {
    return isLocal(path) ? null : this.url('/api/file', { path });
  }

  loadImage(path: string): Promise<string | null> {
    return this.local.loadImage(path);
  }

  displayPath(path: string): string {
    return isLocal(path) ? this.local.displayPath(path) : path;
  }

  rootOf(path: string): string | null {
    if (isLocal(path)) return this.local.rootOf(path);
    let best: string | null = null;
    for (const r of this.roots) if (isInside(path, r) && (!best || r.length > best.length)) best = r;
    return best;
  }

  canResolveRelative(path: string): boolean {
    return isLocal(path) ? this.local.canResolveRelative(path) : true;
  }
}
