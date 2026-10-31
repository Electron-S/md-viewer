import type { Bridge } from '../bridge';
import { basename, docKey, joinPath } from '../render/paths';
import { S } from '../strings';

interface DirEntry {
  name: string;
  isDir: boolean;
}

/**
 * 작업 공간 트리 (FR-NAV-02). 폴더는 펼칠 때 읽는다.
 * 펼친 폴더와 읽은 목록을 기억해 두었다가, 다시 읽을 때(창 포커스·새로 고침) 펼친 폴더만 다시 나열하고 바뀐 것이 있을 때만 다시 그린다 (FR-WATCH-04).
 */
export class WorkspacePanel {
  readonly el: HTMLElement;
  onOpen: (path: string) => void = () => {};
  onPickFolder: () => void = () => {};
  onClose: () => void = () => {};
  private root: string | null = null;
  private activeKey = '';
  private body: HTMLElement;
  private tree: HTMLElement | null = null;
  /** 펼친 폴더: 위치 키 → 위치 */
  private expanded = new Map<string, string>();
  /** 마지막으로 읽은 폴더 목록: 위치 키 → 항목 */
  private listings = new Map<string, DirEntry[]>();
  /** 루트를 바꿀 때마다 올린다. 늦게 끝난 읽기가 다른 루트의 트리에 그려지지 않게 한다. */
  private generation = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private bridge: Bridge) {
    this.el = document.createElement('div');
    this.el.className = 'workspace';
    this.body = document.createElement('div');
    this.body.className = 'ws-body';
    this.body.setAttribute('role', 'tree');
    this.el.append(this.body);
    this.renderEmpty();
  }

  get rootPath(): string | null {
    return this.root;
  }

  setRoot(path: string | null) {
    this.root = path;
    this.generation++;
    this.expanded.clear();
    this.listings.clear();
    this.tree = null;
    if (!path) {
      this.renderEmpty();
      return;
    }
    this.body.replaceChildren();
    const head = document.createElement('div');
    head.className = 'ws-head';
    const name = document.createElement('span');
    name.className = 'ws-name';
    const shown = this.bridge.displayPath(path);
    name.textContent = basename(shown) || shown;
    name.title = shown;
    const refresh = button('↻', S.workspace.refresh, () => void this.refresh(true));
    const close = button('×', S.workspace.close, () => this.onClose());
    head.append(name, refresh, close);
    const ul = document.createElement('ul');
    ul.setAttribute('role', 'group');
    this.tree = ul;
    this.body.append(head, ul);
    void this.load(path, ul, 0);
  }

  /**
   * 루트와 펼친 폴더를 다시 읽는다 (FR-WATCH-04). 목록이 그대로면 그리지 않는다. force면 같아도 다시 그린다(새로 고침 단추).
   * 여러 번 불러도 읽는 중이면 그 읽기를 같이 기다린다.
   */
  refresh(force = false): Promise<void> {
    if (!this.root || !this.tree) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const gen = this.generation;
    const root = this.root;
    const dirs = [root, ...[...this.expanded.values()].filter((d) => docKey(d) !== docKey(root))];
    this.refreshing = Promise.all(dirs.map((d) => this.list(d).then((e) => [d, e] as const, () => [d, null] as const)))
      .then((results) => {
        if (gen !== this.generation || !this.tree) return;
        let changed = force;
        const next = new Map<string, DirEntry[]>();
        for (const [dir, entries] of results) {
          const key = docKey(dir);
          if (!entries) {
            // 지워진(읽을 수 없는) 폴더는 접는다. 루트면 다시 그리며 읽을 수 없다고 보인다.
            if (key !== docKey(root)) this.expanded.delete(key);
            changed = true;
            continue;
          }
          if (!sameEntries(this.listings.get(key), entries)) changed = true;
          next.set(key, entries);
        }
        if (!changed) return;
        this.listings = next;
        const scroller = this.el.parentElement;
        const top = scroller?.scrollTop ?? 0;
        this.renderDir(root, this.tree, 0);
        if (scroller) scroller.scrollTop = top;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  setActive(path: string) {
    this.activeKey = path ? docKey(path) : '';
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>('.ws-file'))) {
      el.classList.toggle('active', docKey(el.dataset.path ?? '') === this.activeKey);
    }
  }

  private renderEmpty() {
    const p = document.createElement('div');
    p.className = 'panel-empty';
    p.append(S.workspace.noFolder);
    const b = document.createElement('button');
    b.className = 'link-button';
    b.textContent = S.workspace.openFolder;
    b.addEventListener('click', () => this.onPickFolder());
    p.append(document.createElement('br'), b);
    this.body.replaceChildren(p);
  }

  private async list(dir: string): Promise<DirEntry[]> {
    const r = await this.bridge.request<{ entries: DirEntry[] }>('dir.list', { path: dir });
    return r.entries;
  }

  /** 폴더를 읽어 기억하고 그린다. */
  private async load(dir: string, ul: HTMLElement, depth: number) {
    const gen = this.generation;
    ul.replaceChildren(note(S.workspace.loading));
    let entries: DirEntry[];
    try {
      entries = await this.list(dir);
    } catch {
      if (gen === this.generation) ul.replaceChildren(note(S.workspace.unreadable));
      return;
    }
    if (gen !== this.generation) return;
    this.listings.set(docKey(dir), entries);
    this.renderDir(dir, ul, depth);
  }

  /** 기억한 목록으로 폴더 하나를 그린다. 펼친 하위 폴더도 그린다(목록이 없으면 읽는다). */
  private renderDir(dir: string, ul: HTMLElement, depth: number) {
    const entries = this.listings.get(docKey(dir));
    if (!entries) {
      void this.load(dir, ul, depth);
      return;
    }
    ul.replaceChildren();
    if (!entries.length) ul.append(note(S.workspace.noDocs));
    for (const e of entries) {
      const path = joinPath(dir, e.name);
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const item = document.createElement('button');
      item.setAttribute('role', 'treeitem');
      item.className = e.isDir ? 'ws-item ws-dir' : 'ws-item ws-file';
      item.style.paddingLeft = `${8 + depth * 14}px`;
      item.dataset.path = path;
      item.title = this.bridge.displayPath(path);
      li.append(item);
      ul.append(li);
      if (e.isDir) {
        const sub = document.createElement('ul');
        sub.setAttribute('role', 'group');
        li.append(sub);
        const key = docKey(path);
        const show = (open: boolean) => {
          sub.hidden = !open;
          item.setAttribute('aria-expanded', String(open));
          item.textContent = (open ? '▾ ' : '▸ ') + e.name;
        };
        show(this.expanded.has(key));
        if (this.expanded.has(key)) this.renderDir(path, sub, depth + 1);
        item.addEventListener('click', () => {
          const open = !!sub.hidden;
          show(open);
          if (open) {
            this.expanded.set(key, path);
            this.renderDir(path, sub, depth + 1);
          } else {
            this.expanded.delete(key);
          }
        });
      } else {
        item.textContent = e.name;
        if (docKey(path) === this.activeKey) item.classList.add('active');
        item.addEventListener('click', () => this.onOpen(path));
      }
    }
  }
}

function sameEntries(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x.name === b[i].name && x.isDir === b[i].isDir);
}

function button(text: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'icon-button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', run);
  return b;
}

function note(text: string): HTMLElement {
  const li = document.createElement('li');
  li.className = 'ws-note';
  li.textContent = text;
  return li;
}
