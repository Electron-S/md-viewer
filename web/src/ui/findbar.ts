import { S } from '../strings';
import type { FindQuery, FindStatus } from '../views/find';

/** 찾기 바 (FR-FIND-01~02). Enter 다음, Shift+Enter 이전, Esc 닫기. */
export class FindBar {
  readonly el: HTMLElement;
  onQuery: (q: FindQuery) => FindStatus = () => ({ count: 0, index: -1 });
  onStep: (dir: 1 | -1) => FindStatus = () => ({ count: 0, index: -1 });
  onClose: () => void = () => {};
  private input: HTMLInputElement;
  private count: HTMLElement;
  private opts = { caseSensitive: false, wholeWord: false, regex: false };
  private dirty = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'findbar';
    this.el.hidden = true;
    this.el.setAttribute('role', 'search');
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = S.find.placeholder;
    this.input.setAttribute('aria-label', S.find.inputLabel);
    this.input.spellcheck = false;
    this.count = document.createElement('span');
    this.count.className = 'find-count';
    this.count.setAttribute('aria-live', 'polite');
    const toggle = (label: string, title: string, key: keyof typeof this.opts) => {
      const b = document.createElement('button');
      b.className = 'find-toggle';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-pressed', 'false');
      b.dataset.opt = key;
      b.addEventListener('click', () => {
        this.opts[key] = !this.opts[key];
        b.setAttribute('aria-pressed', String(this.opts[key]));
        this.dirty = true;
        this.runQuery();
        this.input.focus();
      });
      return b;
    };
    const btn = (label: string, title: string, run: () => void) => {
      const b = document.createElement('button');
      b.className = 'find-button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', run);
      return b;
    };
    this.el.append(
      this.input,
      toggle('Aa', S.find.caseSensitive, 'caseSensitive'),
      toggle(S.find.wholeWordButton, S.find.wholeWord, 'wholeWord'),
      toggle('.*', S.find.regex, 'regex'),
      this.count,
      btn('↑', S.find.prev, () => this.step(-1)),
      btn('↓', S.find.next, () => this.step(1)),
      btn('×', S.find.close, () => this.close()),
    );
    this.input.addEventListener('input', () => {
      this.dirty = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.runQuery(), 150);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  query(): FindQuery {
    return { text: this.input.value, ...this.opts };
  }

  open(prefill?: string) {
    this.el.hidden = false;
    if (prefill && !prefill.includes('\n')) {
      this.input.value = prefill;
      this.dirty = true;
    }
    this.input.focus();
    this.input.select();
    if (this.dirty) this.runQuery();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.dirty = true;
    this.onClose();
  }

  /** 문서가 바뀌었을 때 같은 조건으로 다시 찾는다. */
  refresh() {
    this.dirty = true;
    if (this.isOpen) this.runQuery();
  }

  runQuery() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.show(this.onQuery(this.query()));
  }

  step(dir: 1 | -1) {
    if (this.el.hidden) {
      this.open();
      if (!this.input.value) return;
    }
    if (this.dirty) this.runQuery();
    this.show(this.onStep(dir));
  }

  private show(s: FindStatus) {
    this.el.classList.toggle('no-match', !!this.input.value && s.count === 0);
    if (s.error) this.count.textContent = s.error;
    else if (!this.input.value) this.count.textContent = '';
    else if (s.count === 0) this.count.textContent = S.find.noResult;
    else this.count.textContent = s.index >= 0 ? `${s.index + 1}/${s.count}` : S.find.count(s.count);
  }
}
