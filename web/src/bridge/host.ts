// Windows 앱 브리지 (MDViewer.exe 안의 WebView2). 문서 바이트와 그림은 같은 origin의 /api 주소로 받고,
// 대화상자·감시·저장·탐색기 같은 OS 일은 WebView2 메시지(chrome.webview)로 호스트에 맡긴다.
// 화면이 chrome.webview에 처음 닿으면 WebView2가 수백 ms 멈추므로, 첫 화면에 필요한 시작 정보와 첫 문서는 메시지 없이 얻는다.
import { isEncoding } from '../encoding';
import { normalizePath } from '../render/paths';
import { S } from '../strings';
import { filterEntries, hostError, toHostDoc, writeQuery } from './listing';
import { Emitter, HostError, type Bridge, type BridgeEvent, type DirEntry, type PathEntry, type ReadyInfo } from './types';

/** Windows 앱이 화면을 띄우는 주소의 호스트 이름 */
export const DESKTOP_HOST = 'app.mdview';

/** 호스트가 index.html에 넣어 주는 시작 정보(#mdv-boot) */
interface Boot {
  args?: PathEntry[];
  settings?: string | null;
  session?: string | null;
  version?: string;
  dataDir?: string;
  registered?: boolean;
}

export interface WebView {
  postMessage(msg: unknown): void;
  postMessageWithAdditionalObjects(msg: unknown, objs: unknown): void;
  addEventListener(type: 'message', fn: (ev: { data: any }) => void): void;
}

/** 이 시간 안에 답이 없으면 실패로 본다. 대화상자는 사용자가 오래 머물 수 있어 제한하지 않는다. */
const TIMEOUT_MS = 10_000;

export class HostBridge implements Bridge {
  readonly mode = 'desktop' as const;
  readonly caps = { reveal: true };
  private events = new Emitter();
  private wv: WebView | null = null;
  private attached = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private findWebView: () => WebView | undefined = () => (window as any).chrome?.webview) {}

  on(event: BridgeEvent, fn: (p: any) => void) {
    this.events.on(event, fn);
  }

  /**
   * 첫 화면을 그린 뒤 호스트 이벤트(파일 변경, 다시 실행해 넘긴 위치)를 받기 시작한다. 호스트는 이 알림(app.attach)을 받고서야
   * 이벤트를 보내므로, 그 전에 다른 인스턴스가 넘긴 위치는 답으로 받아 open.paths로 알린다.
   */
  connect() {
    if (this.attached) return;
    this.attached = true;
    void this.post<{ paths?: PathEntry[] }>('app.attach')
      .then((r) => {
        if (r.paths?.length) this.events.emit('open.paths', { paths: r.paths });
      })
      .catch(() => {});
  }

  disconnect() {}

  private attach(): WebView {
    if (this.wv) return this.wv;
    const wv = this.findWebView();
    if (!wv) throw new HostError('EHOST', S.error.host);
    wv.addEventListener('message', (ev) => this.onMessage(ev.data));
    this.wv = wv;
    return wv;
  }

  private onMessage(data: any) {
    const msg = typeof data === 'string' ? JSON.parse(data) : data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r ?? {});
      else p.reject(hostError(msg.e?.code ?? 'EHOST', msg.e?.msg));
    } else if (msg.t === 'evt' && typeof msg.n === 'string') {
      this.events.emit(msg.n, msg.p ?? {});
    }
  }

  /** 호스트에 메시지로 묻는다. extra는 함께 넘길 File 객체(끌어다 놓은 파일의 경로는 호스트만 안다). */
  private post<T>(method: string, params: Record<string, unknown> = {}, extra?: unknown[]): Promise<T> {
    let wv: WebView;
    try {
      wv = this.attach();
    } catch (err) {
      return Promise.reject(err);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = method.startsWith('dialog.')
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new HostError('ETIMEOUT', S.error.host));
          }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { t: 'req', id, m: method, p: params };
      if (extra?.length) wv.postMessageWithAdditionalObjects(msg, extra);
      else wv.postMessage(msg);
    });
  }

  /** 같은 origin의 호스트 주소로 바이트를 받는다. 실패하면 호스트가 준 코드·문구로 HostError를 던진다. */
  private async fetchApi(api: string, path: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${api}?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    } catch {
      throw new HostError('EHOST', S.error.host);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      throw hostError(e?.code ?? 'EHOST', e?.message);
    }
    return res;
  }

  async request<T = any>(method: string, p: Record<string, any> = {}): Promise<T> {
    switch (method) {
      case 'app.ready':
        return (await this.ready()) as T;
      case 'file.read': {
        const path = normalizePath(String(p.path ?? ''));
        const res = await this.fetchApi('/api/read', path);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const mtime = Number(res.headers.get('x-mdv-mtime') ?? Date.now());
        return toHostDoc(path, bytes, mtime, isEncoding(p.encoding) ? p.encoding : undefined) as T;
      }
      case 'dir.list': {
        const r = await this.post<{ entries?: DirEntry[] }>('dir.list', { path: String(p.path ?? '') });
        return { entries: filterEntries(r.entries ?? []) } as T;
      }
      case 'file.write': {
        // 실행기와 같은 모양의 POST /api/write. 날 바이트라 메시지(JSON)보다 가볍고 10초 제한도 없다 (SDD 6.4).
        const path = normalizePath(String(p.path ?? ''));
        // 호스트는 encodeURIComponent 모양만 푼다('+'를 공백으로 읽지 않음). URLSearchParams는 공백을 '+'로 쓰므로 쓰지 않는다.
        const q = Object.entries({ path, ...writeQuery(p) }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        let res: Response;
        try {
          res = await fetch(`/api/write?${q}`, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/octet-stream' }, body: p.bytes as Uint8Array<ArrayBuffer> });
        } catch {
          throw new HostError('EHOST', S.error.host);
        }
        if (!res.ok) {
          const e = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
          throw hostError(e?.code ?? 'EHOST', e?.message);
        }
        return (await res.json()) as T;
      }
      // 파일 핸들(독립 모드)에만 있는 일이다.
      case 'handles.remember':
        return {} as T;
      case 'session.restore':
        return { restored: 0, remaining: 0 } as T;
      default:
        return this.post<T>(method, p);
    }
  }

  /** 시작 정보. 호스트가 index.html에 넣어 준 것을 쓰고, 없으면(페이지를 다시 읽은 경우) 메시지로 묻는다. */
  private async ready(): Promise<ReadyInfo> {
    let boot: Boot | null = null;
    const el = document.getElementById('mdv-boot');
    if (el?.textContent) {
      try {
        boot = JSON.parse(el.textContent) as Boot;
      } catch {
        boot = null;
      }
      el.remove();
    }
    boot ??= await this.post<Boot>('app.ready');
    return {
      mode: 'desktop',
      args: boot.args ?? [],
      settings: boot.settings ?? null,
      session: boot.session ?? null,
      version: boot.version ?? '?',
      roots: [],
      restorable: 0,
      dataDir: boot.dataDir,
      registered: !!boot.registered,
    };
  }

  isRestorable(): boolean {
    return true;
  }

  isPending(): boolean {
    return false;
  }

  takeDrop(dt: DataTransfer): Promise<PathEntry[]> {
    // File 객체는 drop 이벤트가 끝나도 남지만, 목록은 이벤트 안에서만 읽을 수 있으므로 여기서 바로 꺼낸다.
    const files = Array.from(dt.files ?? []);
    if (!files.length) return Promise.resolve([]);
    return this.post<{ entries?: PathEntry[] }>('drop.paths', {}, files).then((r) => r.entries ?? []);
  }

  imageUrl(path: string): string | null {
    return `/api/file?path=${encodeURIComponent(path)}`;
  }

  loadImage(): Promise<string | null> {
    return Promise.resolve(null);
  }

  displayPath(path: string): string {
    return path;
  }

  /** `/x` 링크는 문서가 있는 드라이브(공유)의 루트를 기준으로 한다. */
  rootOf(): string | null {
    return null;
  }

  canResolveRelative(): boolean {
    return true;
  }
}
