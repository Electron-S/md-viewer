// 세션·설정 직렬화 (SDD 5.3, ARCH-07). 알 수 없는 값은 기본값으로 되돌린다.
import type { ViewMode } from './tabs';

export const SCHEMA_VERSION = 1;
export const MAX_RECENT_FILES = 20;
export const MAX_RECENT_FOLDERS = 10;

export interface SessionTab {
  path: string;
  mode: ViewMode;
  line: number;
}

export interface SessionData {
  schemaVersion: number;
  tabs: SessionTab[];
  activeIndex: number;
  workspace: string | null;
  /** 왼쪽 패널: 열린 파일 목록(설정이 목록일 때, 위)과 작업 공간(아래). listHeight는 위 목록의 높이(px). */
  sidePanel: { visible: boolean; width: number; listHeight: number };
  /** 오른쪽 패널: 목차 */
  tocPanel: { visible: boolean; width: number };
  recentFiles: string[];
  recentFolders: string[];
}

export type Theme = 'light' | 'dark' | 'system';
/** 열린 파일을 위쪽 탭 줄로 보일지, 왼쪽 패널의 목록으로 보일지 */
export type OpenFilesView = 'tabs' | 'list';

export interface Settings {
  schemaVersion: number;
  theme: Theme;
  openFiles: OpenFilesView;
  zoom: number;
  wordWrap: boolean;
  allowRemoteImages: boolean;
  largeFileMB: number;
  /** 독립 모드에서 연 파일·폴더 핸들을 브라우저 저장소에 기억할지 (SDD 8.4) */
  rememberHandles: boolean;
  /** v1.1 단축키 사용자 지정용 예약 */
  keybindings: Record<string, string>;
  /** 입력이 멈추면 저장한다 (FR-EDIT-10, 기본 끔) */
  autoSave: boolean;
}

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const PANEL_MIN = 160;
export const PANEL_MAX = 600;
export const LIST_MIN = 60;

export function defaultSession(): SessionData {
  return {
    schemaVersion: SCHEMA_VERSION,
    tabs: [],
    activeIndex: 0,
    workspace: null,
    sidePanel: { visible: true, width: 240, listHeight: 200 },
    tocPanel: { visible: true, width: 240 },
    recentFiles: [],
    recentFolders: [],
  };
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: 'system',
    openFiles: 'tabs',
    zoom: 100,
    wordWrap: true,
    allowRemoteImages: true,
    largeFileMB: 5,
    rememberHandles: true,
    keybindings: {},
    autoSave: false,
  };
}

function parseJson(json: string | null | undefined): any {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isMode = (v: unknown): v is ViewMode => v === 'preview' || v === 'source' || v === 'split';

function clampNum(v: unknown, min: number, max: number, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function strList(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter(isStr).slice(0, max) : [];
}

export function parseSession(json: string | null | undefined): SessionData {
  const d = defaultSession();
  const v = parseJson(json);
  if (!v) return d;
  if (Array.isArray(v.tabs)) {
    d.tabs = v.tabs
      .filter((t: any) => t && isStr(t.path))
      .map((t: any) => ({
        path: t.path,
        mode: isMode(t.mode) ? t.mode : 'preview',
        line: clampNum(t.line, 0, 1e9, 0),
      }));
  }
  d.activeIndex = Math.round(clampNum(v.activeIndex, 0, Math.max(0, d.tabs.length - 1), 0));
  d.workspace = isStr(v.workspace) ? v.workspace : null;
  // v1.2까지의 sidePanel.tab(목차·작업 공간 중 보이던 탭)은 두 패널로 나뉘면서 쓰지 않는다.
  if (v.sidePanel && typeof v.sidePanel === 'object') {
    d.sidePanel = {
      visible: typeof v.sidePanel.visible === 'boolean' ? v.sidePanel.visible : true,
      width: Math.round(clampNum(v.sidePanel.width, PANEL_MIN, PANEL_MAX, 240)),
      listHeight: Math.round(clampNum(v.sidePanel.listHeight, LIST_MIN, 2000, 200)),
    };
  }
  if (v.tocPanel && typeof v.tocPanel === 'object') {
    d.tocPanel = {
      visible: typeof v.tocPanel.visible === 'boolean' ? v.tocPanel.visible : true,
      width: Math.round(clampNum(v.tocPanel.width, PANEL_MIN, PANEL_MAX, 240)),
    };
  }
  d.recentFiles = strList(v.recentFiles, MAX_RECENT_FILES);
  d.recentFolders = strList(v.recentFolders, MAX_RECENT_FOLDERS);
  return d;
}

export function parseSettings(json: string | null | undefined): Settings {
  const d = defaultSettings();
  const v = parseJson(json);
  if (!v) return d;
  if (v.theme === 'light' || v.theme === 'dark' || v.theme === 'system') d.theme = v.theme;
  if (v.openFiles === 'tabs' || v.openFiles === 'list') d.openFiles = v.openFiles;
  d.zoom = Math.round(clampNum(v.zoom, ZOOM_MIN, ZOOM_MAX, 100));
  if (typeof v.wordWrap === 'boolean') d.wordWrap = v.wordWrap;
  if (typeof v.allowRemoteImages === 'boolean') d.allowRemoteImages = v.allowRemoteImages;
  if (typeof v.rememberHandles === 'boolean') d.rememberHandles = v.rememberHandles;
  if (typeof v.autoSave === 'boolean') d.autoSave = v.autoSave;
  d.largeFileMB = clampNum(v.largeFileMB, 1, 100, 5);
  if (v.keybindings && typeof v.keybindings === 'object') {
    for (const [k, val] of Object.entries(v.keybindings)) if (isStr(val)) d.keybindings[k] = val;
  }
  return d;
}

/** 최근 목록 맨 앞에 넣는다. 대소문자만 다른 같은 경로는 하나로 친다. */
export function pushRecent(list: string[], item: string, max: number): string[] {
  const key = item.toLowerCase();
  return [item, ...list.filter((x) => x.toLowerCase() !== key)].slice(0, max);
}

export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private fn: () => void,
    private ms: number,
  ) {}

  trigger() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fn();
    }, this.ms);
  }

  /** 대기 중인 실행이 있으면 바로 실행한다. */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.fn();
  }
}
