// 브리지 계약 (SDD 6.1). 화면이 파일·OS 기능을 부르는 유일한 창구다.
import type { Encoding, Eol } from '../encoding';

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PathEntry {
  path: string;
  isDir: boolean;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/** file.read 결과: 문서 모델 필드(SDD 5.1)에서 id·version·state를 뺀 것 */
export interface HostDoc {
  path: string;
  text: string;
  encoding: Encoding;
  hasBom: boolean;
  eol: Eol;
  size: number;
  mtime: number;
  decodeWarning: boolean;
  kind: 'markdown' | 'text';
  binary: boolean;
}

/** standalone: 브라우저에서 직접 연 viewer.html, launcher: 실행기(mdview)가 띄운 뷰어, desktop: Windows 앱(MDViewer.exe) 안의 뷰어 */
export type BridgeMode = 'standalone' | 'launcher' | 'desktop';

export interface ReadyInfo {
  mode: BridgeMode;
  /** 시작할 때 열 위치 (실행기 주소의 f·d 인자) */
  args: PathEntry[];
  settings: string | null;
  session: string | null;
  version: string;
  /** 실행기 루트(허용 폴더) */
  roots: string[];
  /** 독립 모드에서 권한을 다시 받아야 하는 저장된 루트 수 */
  restorable: number;
  /** 설정·세션을 두는 폴더 (Windows 앱) */
  dataDir?: string;
  /** 탐색기의 연결 프로그램 목록에 등록했는지 (Windows 앱) */
  registered?: boolean;
}

export interface Capabilities {
  /** 탐색기에서 파일 위치 열기 (실행기 모드, Windows 앱) */
  reveal: boolean;
}

/** open.paths: Windows 앱을 다시 실행해 넘긴 위치, app.closing: Windows 앱 창을 닫기 직전 (저장할 기회) */
export type BridgeEvent = 'file.changed' | 'file.deleted' | 'bridge.offline' | 'bridge.online' | 'open.paths' | 'app.closing';
type Listener = (payload: any) => void;

export interface Bridge {
  readonly mode: BridgeMode;
  readonly caps: Capabilities;
  /** SDD 6.1의 메서드를 이름으로 부른다. 실패하면 HostError로 거부한다. */
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: BridgeEvent, fn: Listener): void;
  /** 첫 화면을 그린 뒤 부른다. 실행기 모드는 이때 실행기 이벤트(SSE)에 붙는다. */
  connect(): void;
  /** 실행기 이벤트 연결을 끊는다(새 뷰어 탭에 자리를 넘길 때). */
  disconnect(): void;
  /** 다음에 뷰어를 열 때 다시 열 수 있는 위치인지 (세션·최근 목록에 남길지) */
  isRestorable(path: string): boolean;
  /** 지난 세션에서 기억한 위치인데 아직 읽기 권한을 다시 받지 못했는지 (독립 모드). 그런 탭은 세션에서 빼지 않는다. */
  isPending(path: string): boolean;
  /** drop 이벤트 처리기 안에서 바로(동기로) 불러야 한다. 이벤트가 끝나면 항목을 읽을 수 없다. */
  takeDrop(dt: DataTransfer): Promise<PathEntry[]>;
  /** 로컬 이미지의 표시 주소. null이면 loadImage로 나중에 받는다. */
  imageUrl(path: string): string | null;
  loadImage(path: string): Promise<string | null>;
  /** 화면에 보일 위치 문자열 */
  displayPath(path: string): string;
  /** 위치가 속한 루트(`/x` 링크의 기준). 모르면 null */
  rootOf(path: string): string | null;
  /** 이 위치 기준의 상대 경로 이미지·링크를 따라갈 수 있는지 (독립 모드의 단독 파일은 못 한다) */
  canResolveRelative(path: string): boolean;
}

/** 이벤트 구독을 담는 작은 도우미 */
export class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(event: string, payload: unknown = {}) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  }
}
