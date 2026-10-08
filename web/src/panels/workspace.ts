import type { Bridge } from '../bridge';
import { basename, docKey, joinPath } from '../render/paths';
import { S } from '../strings';

interface DirEntry {
  name: string;
  isDir: boolean;
}

/** 작업 공간 트리 (FR-NAV-02). 폴더는 펼칠 때 읽는다. */
export class WorkspacePanel {
  readonly el: HTMLElement;
  onOpen: (path: string) => void = () => {};
  onPickFolder: () => void = () => {};
  onClose: () => void = () => {};
  private root: string | null = null;
  private activeKey = '';
  private body: HTMLElement;

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
    const refresh = button('↻', S.workspace.refresh, () => this.setRoot(this.root));
    const close = button('×', S.workspace.close, () => this.onClose());
    head.append(name, refresh, close);
    const ul = document.createElement('ul');
    ul.setAttribute('role', 'group');
    this.body.append(head, ul);
    void this.load(path, ul, 0);
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

  private async load(dir: string, ul: HTMLElement, depth: number) {
    ul.replaceChildren(note(S.workspace.loading));
    let entries: DirEntry[];
    try {
      const r = await this.bridge.request<{ entries: DirEntry[] }>('dir.list', { path: dir });
      entries = r.entries;
    } catch {
      ul.replaceChildren(note(S.workspace.unreadable));
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
      item.textContent = (e.isDir ? '▸ ' : '') + e.name;
      li.append(item);
      ul.append(li);
      if (e.isDir) {
        const sub = document.createElement('ul');
        sub.setAttribute('role', 'group');
        sub.hidden = true;
        li.append(sub);
        item.setAttribute('aria-expanded', 'false');
        item.addEventListener('click', () => {
          const open = sub.hidden;
          sub.hidden = !open;
          item.setAttribute('aria-expanded', String(open));
          item.textContent = (open ? '▾ ' : '▸ ') + e.name;
          if (open && !sub.dataset.loaded) {
            sub.dataset.loaded = '1';
            void this.load(path, sub, depth + 1);
          }
        });
      } else {
        if (docKey(path) === this.activeKey) item.classList.add('active');
        item.addEventListener('click', () => this.onOpen(path));
      }
    }
  }
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
