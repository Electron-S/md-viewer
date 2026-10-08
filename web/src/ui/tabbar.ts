import type { DocModel } from '../docs';
import { basename } from '../render/paths';
import { S } from '../strings';
import type { TabManager } from '../tabs';

const DRAG_TYPE = 'application/x-mdv-tab';

/** 탭 바 (FR-FILE-05). 끌어서 순서 바꾸기, 가운데 클릭으로 닫기. */
export class TabBar {
  onClose: (id: number) => void = () => {};
  onOpenDialog: () => void = () => {};

  constructor(
    private el: HTMLElement,
    private tabs: TabManager,
    private getDoc: (docId: string) => DocModel | undefined,
  ) {
    el.setAttribute('role', 'tablist');
    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      el.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: true });
    el.addEventListener('dblclick', (e) => {
      if (e.target === el) this.onOpenDialog();
    });
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (e) => {
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(raw);
      const nodes = Array.from(el.querySelectorAll<HTMLElement>('.tab'));
      let to = nodes.length;
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          to = i;
          break;
        }
      }
      const from = this.tabs.tabs.findIndex((t) => t.id === id);
      if (from >= 0 && from < to) to--;
      this.tabs.move(id, to);
    });
  }

  render() {
    const active = this.tabs.activeId;
    this.el.replaceChildren();
    for (const tab of this.tabs.tabs) {
      const doc = this.getDoc(tab.docId);
      const deleted = doc?.state === 'deleted';
      const t = document.createElement('div');
      t.className = 'tab' + (tab.id === active ? ' active' : '') + (deleted ? ' deleted' : '');
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(tab.id === active));
      t.dataset.id = String(tab.id);
      t.title = tab.path + (deleted ? '\n' + S.tab.deletedTooltip : '');
      t.draggable = true;
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = basename(tab.path) + (deleted ? S.tab.deletedSuffix : '');
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = S.tab.closeTooltip;
      close.setAttribute('aria-label', S.tab.close);
      close.tabIndex = -1;
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onClose(tab.id);
      });
      t.append(name, close);
      t.addEventListener('mousedown', (e) => {
        if (e.button === 0) this.tabs.activate(tab.id);
      });
      t.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.onClose(tab.id);
        }
      });
      t.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(DRAG_TYPE, String(tab.id));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      this.el.append(t);
      if (tab.id === active) requestAnimationFrame(() => t.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
  }
}
