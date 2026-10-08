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
  sidePanel: { visible: boolean; tab: 'toc' | 'workspace'; width: number };
  recentFiles: string[];
  recentFolders: string[];
}

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  schemaVersion: number;
  theme: Theme;
  zoom: number;
  wordWrap: boolean;
  allowRemoteImages: boolean;
  largeFileMB: number;
  /** 독립 모드에서 연 파일·폴더 핸들을 브라우저 저장소에 기억할지 (SDD 8.4) */
  rememberHandles: boolean;
  /** v1.1 단축키 사용자 지정용 예약 */
  keybindings: Record<string, string>;
}

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;

export function defaultSession(): SessionData {
  return {
    schemaVersion: SCHEMA_VERSION,
    tabs: [],
    activeIndex: 0,
    workspace: null,
    sidePanel: { visible: true, tab: 'toc', width: 240 },
    recentFiles: [],
    recentFolders: [],
  };
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: 'system',
    zoom: 100,
    wordWrap: true,
    allowRemoteImages: true,
    largeFileMB: 5,
    rememberHandles: true,
    keybindings: {},
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
  if (v.sidePanel && typeof v.sidePanel === 'object') {
    d.sidePanel = {
      visible: typeof v.sidePanel.visible === 'boolean' ? v.sidePanel.visible : true,
      tab: v.sidePanel.tab === 'workspace' ? 'workspace' : 'toc',
      width: Math.round(clampNum(v.sidePanel.width, 160, 600, 240)),
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
  d.zoom = Math.round(clampNum(v.zoom, ZOOM_MIN, ZOOM_MAX, 100));
  if (typeof v.wordWrap === 'boolean') d.wordWrap = v.wordWrap;
  if (typeof v.allowRemoteImages === 'boolean') d.allowRemoteImages = v.allowRemoteImages;
  if (typeof v.rememberHandles === 'boolean') d.rememberHandles = v.rememberHandles;
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
