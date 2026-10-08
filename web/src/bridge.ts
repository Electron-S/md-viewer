// 브리지 클라이언트 (SDD 6장). 화면에서 OS를 아는 유일한 모듈.

import { S } from './strings';

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (payload: any) => void;

export interface Bridge {
  readonly isHost: boolean;
  request<T = any>(method: string, params?: unknown, additionalObjects?: unknown[]): Promise<T>;
  on(event: string, fn: Listener): void;
  /**
   * 호스트와 연결한다. WebView2는 화면이 chrome.webview에 처음 닿을 때 수백 ms 멈추므로,
   * 첫 화면을 그린 뒤에 부른다. 그 전의 요청은 줄 세워 두었다가 연결하면 보낸다.
   */
  connect(): void;
}

interface WebView {
  postMessage(msg: unknown): void;
  postMessageWithAdditionalObjects(msg: unknown, objs: unknown): void;
  addEventListener(type: 'message', fn: (ev: { data: any }) => void): void;
}

const TIMEOUT_MS = 10_000;

export function createBridge(): Bridge {
  // chrome.webview를 건드리지 않고 호스트 안인지 가린다.
  if (location.hostname !== 'app.mdview') return createMockBridge();

  let wv: WebView | null = null;
  let nextId = 1;
  const queue: { msg: unknown; extra?: unknown[] }[] = [];
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  const listeners = new Map<string, Set<Listener>>();

  const onMessage = (ev: { data: any }) => {
    const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r);
      else p.reject(new HostError(msg.e?.code ?? 'EHOST', msg.e?.msg ?? S.error.host));
    } else if (msg.t === 'evt') {
      for (const fn of listeners.get(msg.n) ?? []) {
        try {
          fn(msg.p);
        } catch (err) {
          console.error(err);
        }
      }
    }
  };

  const post = (msg: unknown, extra?: unknown[]) => {
    if (extra) wv!.postMessageWithAdditionalObjects(msg, extra);
    else wv!.postMessage(msg);
  };

  return {
    isHost: true,
    connect() {
      if (wv) return;
      wv = (window as any).chrome.webview as WebView;
      wv.addEventListener('message', onMessage);
      for (const q of queue.splice(0)) post(q.msg, q.extra);
    },
    request(method, params = {}, additionalObjects) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // 대화상자는 사용자가 오래 머물 수 있으므로 시간 제한을 두지 않는다.
        const timer = method.startsWith('dialog.')
          ? 0
          : window.setTimeout(() => {
              pending.delete(id);
              reject(new HostError('ETIMEOUT', S.error.timeout(method)));
            }, TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        const msg = { t: 'req', id, m: method, p: params };
        if (wv) post(msg, additionalObjects);
        else queue.push({ msg, extra: additionalObjects });
      });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
  };
}

/** 일반 브라우저에서 화면만 띄워 볼 때 쓰는 모의 호스트. 파일 시스템 대신 메모리 문서를 쓴다. */
function createMockBridge(): Bridge {
  const files = new Map<string, string>([
    ['C:\\mock\\README.md', S.mockDoc],
  ]);
  return {
    isHost: false,
    connect() {},
    async request(method: string, params?: any): Promise<any> {
      switch (method) {
        case 'app.ready':
          return {
            args: [{ path: 'C:\\mock\\README.md', isDir: false }],
            settings: localStorage.getItem('mdv.settings'),
            session: null,
            portable: false,
            version: 'mock',
            webview2: 'browser',
          };
        case 'file.read': {
          const text = files.get(params.path);
          if (text == null) throw new HostError('ENOENT', S.error.noFile);
          return {
            path: params.path, text, encoding: 'utf-8', hasBom: false, eol: 'LF', size: text.length,
            mtime: Date.now(), decodeWarning: false, kind: 'markdown', binary: false,
          };
        }
        case 'dir.list':
          return { entries: [{ name: 'README.md', isDir: false }] };
        case 'store.save':
          localStorage.setItem('mdv.' + params.name, params.data);
          return {};
        case 'dialog.openFiles':
          return { paths: [] };
        case 'dialog.openFolder':
          return { path: null };
        default:
          return {};
      }
    },
    on() {},
  };
}
