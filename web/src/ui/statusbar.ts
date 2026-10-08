import { countChars, countLines, countWords, encodingLabel, formatSize, type DocModel } from '../docs';
import { S } from '../strings';
import type { ViewMode } from '../tabs';

const MODE_LABEL: Record<ViewMode, string> = S.mode;

/** 상태 표시줄 (FR-INFO-01). 인코딩을 누르면 다시 읽을 인코딩을 고른다. */
export class StatusBar {
  onEncodingClick: (anchor: HTMLElement) => void = () => {};
  private left: HTMLElement;
  private right: HTMLElement;
  private counts = new WeakMap<DocModel, { lines: number; words: number; chars: number }>();
  private last: [DocModel | null, ViewMode | null, number] = [null, null, 100];
  private offline = false;

  constructor(el: HTMLElement) {
    this.left = document.createElement('div');
    this.left.className = 'status-left';
    this.right = document.createElement('div');
    this.right.className = 'status-right';
    el.append(this.left, this.right);
  }

  /** 실행기와 연결이 끊겼는지 표시한다 (SDD 7.3). */
  setOffline(offline: boolean) {
    this.offline = offline;
    this.render(...this.last);
  }

  render(doc: DocModel | null, mode: ViewMode | null, zoom: number) {
    this.last = [doc, mode, zoom];
    this.left.replaceChildren();
    this.right.replaceChildren();
    if (doc) {
      let c = this.counts.get(doc);
      if (!c) {
        c = { lines: countLines(doc.text), words: countWords(doc.text), chars: countChars(doc.text) };
        this.counts.set(doc, c);
      }
      const enc = document.createElement('button');
      enc.className = 'status-item status-button';
      enc.textContent = encodingLabel(doc);
      enc.title = S.status.reopenEncoding;
      enc.dataset.field = 'encoding';
      enc.addEventListener('click', () => this.onEncodingClick(enc));
      this.left.append(enc);
      this.item(this.left, doc.eol === 'None' ? S.status.noEol : doc.eol, 'eol');
      this.item(this.left, S.status.lines(c.lines.toLocaleString()), 'lines');
      this.item(this.left, S.status.words(c.words.toLocaleString()), 'words');
      this.item(this.left, S.status.chars(c.chars.toLocaleString()), 'chars');
      this.item(this.left, formatSize(doc.size), 'size');
      if (doc.decodeWarning) this.item(this.left, S.status.decodeWarning, 'warning').classList.add('warn');
      if (doc.state === 'deleted') this.item(this.left, S.status.deleted, 'deleted').classList.add('warn');
    }
    if (this.offline) this.item(this.right, S.status.offline, 'offline').classList.add('warn');
    if (mode) this.item(this.right, MODE_LABEL[mode], 'mode');
    this.item(this.right, `${zoom}%`, 'zoom');
  }

  private item(parent: HTMLElement, text: string, field: string): HTMLElement {
    const s = document.createElement('span');
    s.className = 'status-item';
    s.dataset.field = field;
    s.textContent = text;
    parent.append(s);
    return s;
  }
}
