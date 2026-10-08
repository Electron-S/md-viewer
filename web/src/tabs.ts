export type ViewMode = 'preview' | 'source' | 'split';
export type FindTarget = 'preview' | 'source';

/** 탭 상태 (SDD 5.2). 스크롤 위치는 원문 줄 번호로 둔다. */
export interface Tab {
  id: number;
  docId: string;
  path: string;
  mode: ViewMode;
  line: number;
  findTarget: FindTarget;
}

export interface ClosedTab {
  path: string;
  mode: ViewMode;
  line: number;
}

export type TabChange = 'structure' | 'active' | 'state';

const MAX_CLOSED = 20;

export class TabManager {
  tabs: Tab[] = [];
  activeId: number | null = null;
  closed: ClosedTab[] = [];
  private nextId = 1;
  private listeners = new Set<(kind: TabChange) => void>();

  onChange(fn: (kind: TabChange) => void) {
    this.listeners.add(fn);
  }

  active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  byDoc(docId: string): Tab | undefined {
    return this.tabs.find((t) => t.docId === docId);
  }

  get(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  open(docId: string, path: string, init: Partial<Pick<Tab, 'mode' | 'line'>> = {}, activate = true): Tab {
    const existing = this.byDoc(docId);
    if (existing) {
      if (activate) this.activate(existing.id);
      return existing;
    }
    const tab: Tab = {
      id: this.nextId++,
      docId,
      path,
      mode: init.mode ?? 'preview',
      line: init.line ?? 0,
      findTarget: init.mode === 'source' ? 'source' : 'preview',
    };
    this.tabs.push(tab);
    this.emit('structure');
    if (activate || this.activeId == null) this.activate(tab.id);
    return tab;
  }

  activate(id: number) {
    if (this.activeId === id || !this.get(id)) return;
    this.activeId = id;
    this.emit('active');
  }

  close(id: number): Tab | undefined {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return undefined;
    const [tab] = this.tabs.splice(i, 1);
    this.closed.unshift({ path: tab.path, mode: tab.mode, line: tab.line });
    this.closed.length = Math.min(this.closed.length, MAX_CLOSED);
    this.emit('structure');
    if (this.activeId === id) {
      const next = this.tabs[i] ?? this.tabs[i - 1];
      this.activeId = next ? next.id : null;
      this.emit('active');
    }
    return tab;
  }

  closeOthers(id: number): Tab[] {
    const closed = this.tabs.filter((t) => t.id !== id);
    for (const t of closed) this.close(t.id);
    return closed;
  }

  move(id: number, toIndex: number) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    const to = Math.max(0, Math.min(this.tabs.length, toIndex));
    this.tabs.splice(to, 0, tab);
    this.emit('structure');
  }

  cycle(dir: 1 | -1) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  popClosed(): ClosedTab | undefined {
    return this.closed.shift();
  }

  setMode(id: number, mode: ViewMode) {
    const tab = this.get(id);
    if (!tab || tab.mode === mode) return;
    tab.mode = mode;
    if (mode !== 'split') tab.findTarget = mode;
    this.emit('state');
  }

  setLine(id: number, line: number) {
    const tab = this.get(id);
    if (!tab || Math.abs(tab.line - line) < 0.01) return;
    tab.line = line;
    this.emit('state');
  }

  setFindTarget(id: number, target: FindTarget) {
    const tab = this.get(id);
    if (tab) tab.findTarget = target;
  }

  private emit(kind: TabChange) {
    for (const fn of this.listeners) fn(kind);
  }
}
