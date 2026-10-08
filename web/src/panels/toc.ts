import type { Heading } from '../render/markdown';
import { S } from '../strings';

/** 목차 패널 (FR-NAV-01). 지금 읽는 제목을 강조한다. */
export class TocPanel {
  readonly el: HTMLElement;
  onSelect: (h: Heading) => void = () => {};
  private headings: Heading[] = [];
  private items: HTMLElement[] = [];
  private current = -1;

  constructor() {
    this.el = document.createElement('nav');
    this.el.className = 'toc';
    this.el.setAttribute('aria-label', S.toc.label);
  }

  setHeadings(headings: Heading[]) {
    if (sameHeadings(this.headings, headings)) return;
    this.headings = headings;
    this.current = -1;
    this.items = [];
    this.el.replaceChildren();
    if (!headings.length) {
      const p = document.createElement('p');
      p.className = 'panel-empty';
      p.textContent = S.toc.empty;
      this.el.append(p);
      return;
    }
    const min = Math.min(...headings.map((h) => h.level));
    const ul = document.createElement('ul');
    for (const h of headings) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'toc-item';
      b.style.paddingLeft = `${10 + (h.level - min) * 14}px`;
      b.textContent = h.text || S.toc.untitled;
      b.title = h.text;
      b.addEventListener('click', () => this.onSelect(h));
      li.append(b);
      ul.append(li);
      this.items.push(b);
    }
    this.el.append(ul);
  }

  setCurrentLine(line: number) {
    let idx = -1;
    for (let i = 0; i < this.headings.length; i++) {
      if (this.headings[i].line <= line + 0.01) idx = i;
      else break;
    }
    if (idx === this.current) return;
    this.items[this.current]?.classList.remove('current');
    this.items[this.current]?.removeAttribute('aria-current');
    this.current = idx;
    const item = this.items[idx];
    if (item) {
      item.classList.add('current');
      item.setAttribute('aria-current', 'location');
      item.scrollIntoView({ block: 'nearest' });
    }
  }
}

function sameHeadings(a: Heading[], b: Heading[]): boolean {
  return a.length === b.length && a.every((h, i) => h.id === b[i].id && h.line === b[i].line && h.level === b[i].level);
}
