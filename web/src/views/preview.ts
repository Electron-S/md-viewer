import { buildRegex, findRanges, MAX_MATCHES, type FindQuery, type FindStatus } from './find';
import markdownCss from '../../static/markdown.css';

let sharedSheet: CSSStyleSheet | null = null;

export type LinkAction =
  | { kind: 'fragment'; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'local'; path: string; fragment: string };

interface LineAnchor {
  line: number;
  el: HTMLElement;
  top: number;
}

/**
 * 미리보기 (SDD 4장). 정제된 문서를 Shadow DOM에 넣어 문서 스타일이 앱 UI로 새지 않게 한다.
 * 스크롤 위치는 `data-line` 소스 맵으로 원문 줄과 맞바꾼다 (ARCH-03).
 */
export class PreviewView {
  readonly el: HTMLElement;
  readonly root: ShadowRoot;
  readonly article: HTMLElement;
  onLink: (action: LinkAction) => void = () => {};
  private anchors: LineAnchor[] | null = null;
  private marks: HTMLElement[] = [];
  private current = -1;
  /** 프로그램이 스크롤 위치를 맞추는 중인지. 이 동안의 스크롤은 사용자 스크롤로 치지 않는다. */
  settling = false;
  private settleId = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'preview-scroll';
    this.el.tabIndex = 0;
    const host = document.createElement('div');
    host.className = 'preview-host';
    this.el.append(host);
    this.root = host.attachShadow({ mode: 'open' });
    this.article = document.createElement('article');
    this.article.className = 'markdown-body';
    if ('adoptedStyleSheets' in this.root && typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
      if (!sharedSheet) {
        sharedSheet = new CSSStyleSheet();
        sharedSheet.replaceSync(markdownCss);
      }
      this.root.adoptedStyleSheets = [sharedSheet];
    } else {
      const style = document.createElement('style');
      style.textContent = markdownCss;
      this.root.append(style);
    }
    this.root.append(this.article);
    this.root.addEventListener('click', (e) => this.onClick(e as MouseEvent));
    new ResizeObserver(() => (this.anchors = null)).observe(this.article);
    this.article.addEventListener('load', () => (this.anchors = null), true);
    // 사용자가 직접 스크롤하면 위치 맞추기를 멈춘다.
    for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) {
      this.el.addEventListener(ev, () => this.cancelSettle(), { passive: true });
    }
  }

  private cancelSettle() {
    this.settleId++;
    this.settling = false;
  }

  /**
   * 목표 위치로 스크롤한 뒤 몇 프레임 동안 같은 목표로 다시 맞춘다.
   * 화면 밖 블록(content-visibility)과 늦게 뜨는 이미지가 실제 크기로 그려지면 위치가 밀리기 때문이다.
   */
  private settle(target: () => number | null) {
    const id = ++this.settleId;
    this.settling = true;
    const apply = () => {
      this.anchors = null;
      const y = target();
      if (y != null) this.el.scrollTop = y;
    };
    apply();
    let frames = 0;
    let stable = 0;
    const step = () => {
      if (id !== this.settleId) return;
      const before = this.el.scrollTop;
      apply();
      stable = Math.abs(this.el.scrollTop - before) > 1 ? 0 : stable + 1;
      if (++frames < 15 && stable < 2) requestAnimationFrame(step);
      else this.settling = false;
    };
    requestAnimationFrame(step);
  }

  setContent(nodes: Node | null) {
    this.clearFind();
    this.article.replaceChildren(...(nodes ? [nodes] : []));
    this.anchors = null;
  }

  /** 보여주던 문서 노드를 복제 없이 꺼낸다. 다시 보여줄 때 setContent로 되돌린다. */
  takeContent(): DocumentFragment {
    this.clearFind();
    const frag = document.createDocumentFragment();
    while (this.article.firstChild) frag.append(this.article.firstChild);
    this.anchors = null;
    return frag;
  }

  /** 문서 대신 안내(큰 파일, 바이너리 등)를 보여준다. */
  setMessage(message: string, action?: { label: string; run: () => void }) {
    const box = document.createElement('div');
    box.className = 'mdv-message';
    const p = document.createElement('p');
    p.textContent = message;
    box.append(p);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      box.append(b);
    }
    this.setContent(box);
  }

  setZoom(percent: number) {
    this.article.style.setProperty('zoom', String(percent / 100));
    this.anchors = null;
  }

  private onClick(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a) return;
    e.preventDefault();
    const ext = a.getAttribute('data-mdv-ext');
    const path = a.getAttribute('data-mdv-path');
    const frag = a.getAttribute('data-mdv-frag') ?? '';
    if (ext) this.onLink({ kind: 'external', url: ext });
    else if (path) this.onLink({ kind: 'local', path, fragment: frag });
    else if (a.hasAttribute('data-mdv-frag')) this.onLink({ kind: 'fragment', fragment: frag });
  }

  /** id 또는 name으로 제목·각주를 찾아 스크롤한다. */
  scrollToFragment(fragment: string): boolean {
    if (!fragment) {
      this.el.scrollTop = 0;
      return true;
    }
    const target =
      this.root.getElementById(fragment) ??
      this.root.getElementById(fragment.toLowerCase()) ??
      this.root.querySelector(`[name="${CSS.escape(fragment)}"]`);
    if (!target) return false;
    this.settle(() => this.el.scrollTop + target.getBoundingClientRect().top - this.el.getBoundingClientRect().top - 8);
    return true;
  }

  private getAnchors(): LineAnchor[] {
    if (this.anchors) return this.anchors;
    const base = this.el.getBoundingClientRect().top - this.el.scrollTop;
    const list: LineAnchor[] = [];
    // 최상위 블록만 잰다. 블록은 content-visibility로 화면 밖 배치를 건너뛰므로,
    // 안쪽 요소(목록 항목·표 행)를 재면 블록마다 강제 배치가 일어나 매우 느려진다.
    for (const el of Array.from(this.article.children) as HTMLElement[]) {
      if (!el.hasAttribute('data-line')) continue;
      const line = Number(el.getAttribute('data-line'));
      if (!Number.isFinite(line)) continue;
      list.push({ line, el, top: el.getBoundingClientRect().top - base });
    }
    // 줄 번호와 위치가 함께 증가하는 것만 남긴다 (중첩 요소의 중복 제거).
    list.sort((a, b) => a.line - b.line || a.top - b.top);
    const mono: LineAnchor[] = [];
    for (const a of list) {
      const last = mono[mono.length - 1];
      if (last && (a.line === last.line || a.top <= last.top)) continue;
      mono.push(a);
    }
    this.anchors = mono;
    return mono;
  }

  /** 화면 맨 위에 보이는 원문 줄(소수점은 블록 안 비율) */
  topLine(): number {
    const anchors = this.getAnchors();
    if (!anchors.length) return 0;
    const y = this.el.scrollTop;
    let lo = 0;
    let hi = anchors.length - 1;
    if (y <= anchors[0].top) return anchors[0].line * Math.max(0, y / Math.max(1, anchors[0].top));
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (anchors[mid].top <= y) lo = mid;
      else hi = mid - 1;
    }
    const a = anchors[lo];
    const b = anchors[lo + 1];
    if (!b) return a.line;
    const t = (y - a.top) / Math.max(1, b.top - a.top);
    return a.line + Math.min(1, Math.max(0, t)) * (b.line - a.line);
  }

  scrollToLine(line: number) {
    if (line <= 0) {
      this.cancelSettle();
      this.el.scrollTop = 0;
      return;
    }
    this.settle(() => this.lineToY(line));
  }

  private lineToY(line: number): number | null {
    const anchors = this.getAnchors();
    if (!anchors.length) return null;
    let i = 0;
    while (i + 1 < anchors.length && anchors[i + 1].line <= line) i++;
    const a = anchors[i];
    const b = anchors[i + 1];
    let y = a.top;
    if (b && line > a.line) y += ((line - a.line) / (b.line - a.line)) * (b.top - a.top);
    return y;
  }

  // ---- 찾기 (FR-FIND-03) ----

  find(q: FindQuery): FindStatus {
    this.clearFind();
    const { re, error } = buildRegex(q);
    if (!re) return { count: 0, index: -1, error };
    const walker = document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    for (const node of nodes) {
      if (this.marks.length >= MAX_MATCHES) break;
      const ranges = findRanges(node.data, re, MAX_MATCHES - this.marks.length);
      if (!ranges.length) continue;
      // 뒤에서부터 잘라야 앞쪽 오프셋이 유지된다.
      const created: HTMLElement[] = [];
      for (let i = ranges.length - 1; i >= 0; i--) {
        const [s, e] = ranges[i];
        const hit = node.splitText(s);
        hit.splitText(e - s);
        const mark = document.createElement('mark');
        mark.className = 'mdv-hit';
        hit.replaceWith(mark);
        mark.append(hit);
        created.unshift(mark);
      }
      this.marks.push(...created);
    }
    this.current = -1;
    return { count: this.marks.length, index: -1 };
  }

  /** 다음(1)·이전(-1) 일치로 이동. 화면 위치 기준으로 가장 가까운 것부터 시작한다. */
  step(dir: 1 | -1): FindStatus {
    const n = this.marks.length;
    if (!n) return { count: 0, index: -1 };
    if (this.current < 0) {
      const top = this.el.getBoundingClientRect().top;
      const first = this.marks.findIndex((m) => m.getBoundingClientRect().top >= top);
      this.current = dir === 1 ? (first < 0 ? 0 : first) : (first <= 0 ? n - 1 : first - 1);
    } else {
      this.marks[this.current].classList.remove('mdv-current');
      this.current = (this.current + dir + n) % n;
    }
    const m = this.marks[this.current];
    m.classList.add('mdv-current');
    m.scrollIntoView({ block: 'center' });
    return { count: n, index: this.current };
  }

  clearFind() {
    for (const m of this.marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      m.replaceWith(...Array.from(m.childNodes));
      parent.normalize();
    }
    this.marks = [];
    this.current = -1;
  }
}
