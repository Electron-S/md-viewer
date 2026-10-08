import type { CommandRegistry } from '../commands';
import { S } from '../strings';

export interface MenuEntry {
  /** 명령 id. 제목·단축키·체크·활성 상태를 레지스트리에서 가져온다. */
  cmd?: string;
  label?: string;
  run?: () => void;
  sep?: boolean;
  sub?: () => MenuEntry[];
  disabled?: boolean;
}

export interface MenuDef {
  label: string;
  /** Alt+키 (예: 'F') */
  key: string;
  items: () => MenuEntry[];
}

interface Resolved {
  label: string;
  shortcut: string;
  checked: boolean;
  disabled: boolean;
  sep: boolean;
  sub?: () => MenuEntry[];
  run?: () => void;
}

/**
 * HTML 메뉴 바 (NFR-USE-01). 모든 항목은 명령 레지스트리에서 만든다.
 * 키보드: Alt 또는 F10으로 열고, 방향키·Enter·Esc로 다룬다. Alt+밑줄 글자로 바로 연다.
 */
export class MenuBar {
  private buttons: HTMLButtonElement[] = [];
  private openIndex = -1;
  private active = -1;
  private subActive = -1;
  private subOpen = false;
  private dropdown: HTMLElement | null = null;
  private subDropdown: HTMLElement | null = null;
  private entries: Resolved[] = [];
  private subEntries: Resolved[] = [];
  private altAlone = false;
  private restoreFocus: Element | null = null;

  constructor(
    private el: HTMLElement,
    private cmds: CommandRegistry,
    private menus: MenuDef[],
  ) {
    el.setAttribute('role', 'menubar');
    menus.forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'menu-top';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('aria-haspopup', 'true');
      b.innerHTML = '';
      b.append(m.label, Object.assign(document.createElement('span'), { className: 'accel', textContent: `(${m.key})` }));
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.openIndex === i) this.close();
        else this.open(i, false);
      });
      b.addEventListener('mouseenter', () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i, false);
      });
      el.append(b);
      this.buttons.push(b);
    });
    document.addEventListener('mousedown', (e) => {
      if (this.openIndex < 0) return;
      const t = e.target as Node;
      if (this.el.contains(t) || this.dropdown?.contains(t) || this.subDropdown?.contains(t)) return;
      this.close();
    });
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
  }

  get isOpen(): boolean {
    return this.openIndex >= 0;
  }

  private resolve(items: MenuEntry[]): Resolved[] {
    return items.map((it) => {
      if (it.sep) return { label: '', shortcut: '', checked: false, disabled: true, sep: true };
      if (it.cmd) {
        const c = this.cmds.get(it.cmd);
        return {
          label: it.label ?? c?.title ?? it.cmd,
          shortcut: this.cmds.keyFor(it.cmd) ?? '',
          checked: !!c?.checked?.(),
          disabled: !c || !this.cmds.isEnabled(it.cmd),
          sep: false,
          run: () => this.cmds.run(it.cmd!),
        };
      }
      return { label: it.label ?? '', shortcut: '', checked: false, disabled: !!it.disabled, sep: false, sub: it.sub, run: it.run };
    });
  }

  open(index: number, focusFirst: boolean) {
    if (this.openIndex < 0) this.restoreFocus = document.activeElement;
    this.closeDropdowns();
    this.openIndex = index;
    this.buttons.forEach((b, i) => b.classList.toggle('open', i === index));
    this.entries = this.resolve(this.menus[index].items());
    this.active = focusFirst ? this.nextEnabled(this.entries, -1, 1) : -1;
    this.dropdown = this.renderDropdown(this.entries, false);
    const r = this.buttons[index].getBoundingClientRect();
    this.dropdown.style.left = `${r.left}px`;
    this.dropdown.style.top = `${r.bottom}px`;
    document.body.append(this.dropdown);
    this.paint();
  }

  close() {
    if (this.openIndex < 0) return;
    this.closeDropdowns();
    this.buttons.forEach((b) => b.classList.remove('open'));
    this.openIndex = -1;
    const f = this.restoreFocus as HTMLElement | null;
    this.restoreFocus = null;
    f?.focus?.();
  }

  private closeDropdowns() {
    this.closeSub();
    this.dropdown?.remove();
    this.dropdown = null;
  }

  private closeSub() {
    this.subDropdown?.remove();
    this.subDropdown = null;
    this.subOpen = false;
    this.subActive = -1;
  }

  private renderDropdown(entries: Resolved[], isSub: boolean): HTMLElement {
    const box = document.createElement('div');
    box.className = 'menu-dropdown';
    box.setAttribute('role', 'menu');
    entries.forEach((e, i) => {
      if (e.sep) {
        box.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
        return;
      }
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.setAttribute('role', e.checked ? 'menuitemcheckbox' : 'menuitem');
      if (e.checked) row.setAttribute('aria-checked', 'true');
      if (e.disabled) row.setAttribute('aria-disabled', 'true');
      row.append(
        Object.assign(document.createElement('span'), { className: 'menu-check', textContent: e.checked ? '✓' : '' }),
        Object.assign(document.createElement('span'), { className: 'menu-label', textContent: e.label }),
        Object.assign(document.createElement('span'), { className: 'menu-key', textContent: e.sub ? '▸' : e.shortcut }),
      );
      row.addEventListener('mouseenter', () => {
        if (isSub) this.subActive = i;
        else {
          this.active = i;
          if (e.sub && !e.disabled) this.openSub(false);
          else this.closeSub();
        }
        this.paint();
      });
      row.addEventListener('mousedown', (ev) => ev.preventDefault());
      row.addEventListener('click', () => this.activate(e, isSub));
      box.append(row);
    });
    return box;
  }

  private openSub(focusFirst: boolean) {
    const e = this.entries[this.active];
    if (!e?.sub || !this.dropdown) return;
    this.closeSub();
    this.subEntries = this.resolve(e.sub());
    if (!this.subEntries.length) this.subEntries = this.resolve([{ label: S.menu.empty, disabled: true }]);
    this.subDropdown = this.renderDropdown(this.subEntries, true);
    const row = this.rows(this.dropdown)[this.active];
    const r = row.getBoundingClientRect();
    this.subDropdown.style.left = `${r.right - 2}px`;
    this.subDropdown.style.top = `${r.top - 4}px`;
    document.body.append(this.subDropdown);
    this.subOpen = true;
    this.subActive = focusFirst ? this.nextEnabled(this.subEntries, -1, 1) : -1;
    this.paint();
  }

  private rows(box: HTMLElement): HTMLElement[] {
    return Array.from(box.children) as HTMLElement[];
  }

  private paint() {
    if (this.dropdown) this.rows(this.dropdown).forEach((r, i) => r.classList.toggle('active', i === this.active));
    if (this.subDropdown) this.rows(this.subDropdown).forEach((r, i) => r.classList.toggle('active', i === this.subActive));
  }

  private activate(e: Resolved, isSub: boolean) {
    if (e.disabled || e.sep) return;
    if (e.sub && !isSub) {
      this.openSub(true);
      return;
    }
    this.close();
    e.run?.();
  }

  private nextEnabled(list: Resolved[], from: number, dir: 1 | -1): number {
    const n = list.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + dir * k + n * 2) % n;
      if (!list[i].sep && !list[i].disabled) return i;
    }
    return -1;
  }

  /** 창 전체 keydown(캡처 단계)에서 먼저 부른다. 처리했으면 true. */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Alt') {
      this.altAlone = !e.ctrlKey && !e.shiftKey;
      e.preventDefault();
      return true;
    }
    this.altAlone = false;
    // Alt+글자만 메뉴를 연다. Shift 등이 붙은 조합(Alt+Shift+T 등)은 명령 단축키다.
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^Key[A-Z]$/.test(e.code)) {
      const idx = this.menus.findIndex((m) => m.key === e.code.slice(3));
      if (idx >= 0) {
        e.preventDefault();
        this.open(idx, true);
        return true;
      }
    }
    if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.isOpen) this.close();
      else this.open(0, true);
      return true;
    }
    if (!this.isOpen) return false;
    e.preventDefault();
    e.stopPropagation();
    const list = this.subOpen ? this.subEntries : this.entries;
    const cur = this.subOpen ? this.subActive : this.active;
    switch (e.key) {
      case 'Escape':
        if (this.subOpen) this.closeSub();
        else this.close();
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        const next = this.nextEnabled(list, cur, e.key === 'ArrowDown' ? 1 : -1);
        if (this.subOpen) this.subActive = next;
        else this.active = next;
        break;
      }
      case 'ArrowRight':
        if (!this.subOpen && this.entries[this.active]?.sub) this.openSub(true);
        else this.open((this.openIndex + 1) % this.menus.length, true);
        break;
      case 'ArrowLeft':
        if (this.subOpen) this.closeSub();
        else this.open((this.openIndex - 1 + this.menus.length) % this.menus.length, true);
        break;
      case 'Enter':
      case ' ':
        if (cur >= 0) this.activate(list[cur], this.subOpen);
        break;
    }
    this.paint();
    return true;
  }

  /** Alt를 단독으로 눌렀다 떼면 메뉴를 연다 (Windows 메뉴 관례). */
  handleKeyUp(e: KeyboardEvent): boolean {
    if (e.key !== 'Alt') return false;
    const alone = this.altAlone;
    this.altAlone = false;
    if (!alone) return false;
    e.preventDefault();
    if (this.isOpen) this.close();
    else this.open(0, true);
    return true;
  }
}
