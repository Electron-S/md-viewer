import { buildRegex, findRanges, MAX_MATCHES, type FindQuery, type FindStatus } from './find';
import markdownCss from '../../static/markdown.css';

let sharedSheet: CSSStyleSheet | null = null;

/** background: 가운데 클릭. 다른 문서는 지금 탭에 머문 채 새 탭으로 연다 (FR-NAV-03). */
export type LinkAction =
  | { kind: 'fragment'; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'local'; path: string; fragment: string; background?: boolean };

interface LineAnchor {
  line: number;
  el: HTMLElement;
  top: number;
}

/** 최상위 묶음(.mdv-chunk 또는 묶지 않은 블록 하나)과 그 첫 줄·위치. 안쪽 블록의 위치(anchors)는 처음 쓸 때 잰다. */
interface Group extends LineAnchor {
  anchors: LineAnchor[] | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 찾기에서 건너뛰는 글자: 다이어그램의 스타일시트와 보이지 않는 SVG 제목·설명 */
const HIDDEN_TEXT_PARENTS = new Set(['style', 'script', 'title', 'desc']);

const CHUNK_CLASS = 'mdv-chunk';
/** 묶음 하나에 넣는 최상위 블록 수 */
const CHUNK_BLOCKS = 64;
/** 위 여백이 있는 블록. 묶음은 안쪽 여백이 밖과 겹치지 않으므로 이 블록이 묶음 첫 블록이 되면 간격이 넓어진다. */
const MARGIN_TOP_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);

/**
 * 최상위 블록을 CHUNK_BLOCKS개씩 묶음(.mdv-chunk)에 넣는다 (NFR-PERF-02).
 * 화면 밖 건너뛰기(content-visibility)를 블록마다 걸면 브라우저가 블록마다 교차 관찰을 해, 블록이 수만 개인 문서는
 * 그 계산만으로 수백 ms가 든다(1 MB 시험 문서에서 약 220 ms). 묶음에 걸면 그 수가 수십 분의 1로 준다.
 * 위 여백이 있는 블록 앞에서는 자르지 않고 미룬다. 그런 블록만 이어지면 두 배에서 자른다.
 */
export function chunkBlocks(frag: DocumentFragment): DocumentFragment {
  const out = document.createDocumentFragment();
  let chunk: HTMLElement | null = null;
  let count = 0;
  for (const node of Array.from(frag.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const full = count >= CHUNK_BLOCKS && (!MARGIN_TOP_TAGS.has((node as Element).tagName) || count >= 2 * CHUNK_BLOCKS);
      if (!chunk || full) {
        chunk = document.createElement('div');
        chunk.className = CHUNK_CLASS;
        out.append(chunk);
        count = 0;
      }
      count++;
    }
    (chunk ?? out).append(node);
  }
  return out;
}

/**
 * 코드 블록에 도구(언어 이름·복사 버튼)를 단다 (FR-REN-09). 정제가 끝난 노드에 화면이 직접 만든 요소만 넣는다.
 * 글자는 data-label을 CSS로 보여, 찾기·선택 복사·인쇄에 섞이지 않게 한다. Mermaid·앞머리·원문 대체 블록(mdv-plain)은 뺀다.
 */
export function addCodeTools(root: ParentNode, label: { copy: string; copyTitle: string }) {
  for (const code of Array.from(root.querySelectorAll('pre > code'))) {
    const pre = code.parentElement!;
    if (pre.classList.contains('mdv-plain') || pre.closest('.mdv-mermaid, .mdv-front-matter')) continue;
    const tools = document.createElement('div');
    tools.className = 'mdv-code-tools';
    const lang = /(?:^|\s)language-(\S+)/.exec(code.getAttribute('class') ?? '')?.[1];
    if (lang) {
      const name = document.createElement('span');
      name.className = 'mdv-code-lang';
      name.setAttribute('data-label', lang);
      tools.append(name);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mdv-code-copy';
    copy.setAttribute('data-label', label.copy);
    copy.title = label.copyTitle;
    copy.setAttribute('aria-label', label.copyTitle);
    tools.append(copy);
    pre.append(tools);
  }
}

/** 줄 번호와 위치가 함께 증가하는 것만 남긴다 (중첩 요소의 중복 제거). */
function monotone<T extends LineAnchor>(list: T[]): T[] {
  list.sort((a, b) => a.line - b.line || a.top - b.top);
  const out: T[] = [];
  for (const a of list) {
    const last = out[out.length - 1];
    if (last && (a.line === last.line || a.top <= last.top)) continue;
    out.push(a);
  }
  return out;
}

/** 앞쪽은 참, 뒤쪽은 거짓인 목록에서 마지막 참의 위치. 모두 거짓이면 0. */
function lastIndex<T>(list: T[], ok: (x: T) => boolean): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ok(list[mid])) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 블록의 data-line. 없거나 숫자가 아니면 null */
function lineOf(el: Element | null): number | null {
  const v = el?.getAttribute('data-line');
  if (v == null) return null;
  const line = Number(v);
  return Number.isFinite(line) ? line : null;
}

/**
 * 미리보기 (SDD 4장). 정제된 문서를 Shadow DOM에 넣어 문서 스타일이 앱 UI로 새지 않게 한다.
 * 스크롤 위치는 `data-line` 소스 맵으로 원문 줄과 맞바꾼다 (ARCH-03).
 */
export class PreviewView {
  readonly el: HTMLElement;
  readonly root: ShadowRoot;
  readonly article: HTMLElement;
  private noticeEl: HTMLElement;
  onLink: (action: LinkAction) => void = () => {};
  /** 코드 블록의 복사 버튼을 눌렀다 (FR-REN-09). */
  onCopyCode: (text: string) => void = () => {};
  private groups: Group[] | null = null;
  private marks: Element[] = [];
  private current = -1;
  /** 프로그램이 스크롤 위치를 맞추는 중인지. 이 동안의 스크롤은 사용자 스크롤로 치지 않는다. */
  settling = false;
  private settleId = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'preview-scroll';
    this.el.tabIndex = 0;
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'preview-notice';
    this.noticeEl.hidden = true;
    const host = document.createElement('div');
    host.className = 'preview-host';
    this.el.append(this.noticeEl, host);
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
    // 가운데 클릭: 브라우저가 링크 주소(상대 경로)를 새 탭으로 열지 않게 막고 뷰어가 연다 (FR-NAV-03).
    // 누를 때 막아야 자동 스크롤 표시도 뜨지 않는다.
    this.root.addEventListener('mousedown', (e) => {
      const me = e as MouseEvent;
      if (me.button === 1 && (me.target as Element | null)?.closest?.('a')) me.preventDefault();
    });
    this.root.addEventListener('auxclick', (e) => {
      const me = e as MouseEvent;
      if (me.button === 1) this.onClick(me, true);
    });
    new ResizeObserver(() => (this.groups = null)).observe(this.article);
    this.article.addEventListener('load', () => (this.groups = null), true);
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
      this.groups = null;
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
    this.groups = null;
  }

  /** 보여주던 문서 노드를 복제 없이 꺼낸다. 다시 보여줄 때 setContent로 되돌린다. */
  takeContent(): DocumentFragment {
    this.clearFind();
    const frag = document.createDocumentFragment();
    while (this.article.firstChild) frag.append(this.article.firstChild);
    this.groups = null;
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

  /** 문서 위에 띠 하나를 둔다(예: 폴더를 열어야 이미지가 보인다는 안내). null이면 숨긴다. */
  setNotice(notice: { text: string; action?: { label: string; run: () => void } } | null) {
    this.noticeEl.replaceChildren();
    this.noticeEl.hidden = !notice;
    // 띠가 문서를 밀어 내리므로 재 둔 블록 위치를 버린다.
    this.groups = null;
    if (!notice) return;
    const p = document.createElement('span');
    p.textContent = notice.text;
    this.noticeEl.append(p);
    if (notice.action) {
      const b = document.createElement('button');
      b.textContent = notice.action.label;
      b.addEventListener('click', notice.action.run);
      this.noticeEl.append(b);
    }
  }

  setZoom(percent: number) {
    this.article.style.setProperty('zoom', String(percent / 100));
    this.groups = null;
  }

  /** 본문 폭(안쪽 여백 제외, 확대 전). 다이어그램을 그리는 무대 폭으로 쓴다. */
  contentWidth(): number {
    const cs = getComputedStyle(this.article);
    return this.article.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  private onClick(e: MouseEvent, background = false) {
    const target = e.target as Element | null;
    const copy = target?.closest?.('.mdv-code-copy');
    if (copy) {
      e.preventDefault();
      this.onCopyCode(copy.closest('pre')?.querySelector(':scope > code')?.textContent ?? '');
      return;
    }
    const a = target?.closest?.('a');
    if (!a) return;
    e.preventDefault();
    const ext = a.getAttribute('data-mdv-ext');
    const path = a.getAttribute('data-mdv-path');
    const frag = a.getAttribute('data-mdv-frag') ?? '';
    if (ext) this.onLink({ kind: 'external', url: ext });
    else if (path) this.onLink({ kind: 'local', path, fragment: frag, background });
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

  /** 스크롤 영역 안 문서 좌표의 기준(스크롤해도 변하지 않는다) */
  private baseTop(): number {
    return this.el.getBoundingClientRect().top - this.el.scrollTop;
  }

  /**
   * 최상위 묶음의 첫 줄과 위치. 묶음만 재므로 블록이 수만 개여도 싸다.
   * 묶음은 content-visibility로 화면 밖 배치를 건너뛰므로, 안쪽 블록을 모두 재면 묶음마다 강제 배치가 일어나 매우 느려진다.
   * 안쪽 블록은 groupAnchors가 필요한 묶음만 잰다.
   */
  private getGroups(): Group[] {
    if (this.groups) return this.groups;
    const base = this.baseTop();
    const list: Group[] = [];
    for (const el of Array.from(this.article.children) as HTMLElement[]) {
      // 묶음의 첫 줄은 줄 정보가 있는 첫 블록의 줄이다.
      const first = el.classList.contains(CHUNK_CLASS) ? Array.from(el.children).find((c) => lineOf(c) != null) ?? null : el;
      const line = lineOf(first);
      if (line != null) list.push({ line, el, top: el.getBoundingClientRect().top - base, anchors: null });
    }
    this.groups = monotone(list);
    return this.groups;
  }

  /** 묶음 하나의 블록 위치. 처음 쓸 때 잰다. 묶지 않은 블록은 그 자체다. */
  private groupAnchors(g: Group): LineAnchor[] {
    if (g.anchors) return g.anchors;
    if (!g.el.classList.contains(CHUNK_CLASS)) return (g.anchors = [g]);
    const base = this.baseTop();
    const list: LineAnchor[] = [];
    for (const el of Array.from(g.el.children) as HTMLElement[]) {
      const line = lineOf(el);
      if (line != null) list.push({ line, el, top: el.getBoundingClientRect().top - base });
    }
    g.anchors = monotone(list);
    return g.anchors;
  }

  /** 묶음 i의 블록 위치에 다음 묶음의 시작을 붙인 것. 묶음 끝 블록과 다음 묶음 사이도 비율로 나눌 수 있다. */
  private anchorsIn(groups: Group[], i: number): LineAnchor[] {
    const own = this.groupAnchors(groups[i]);
    return i + 1 < groups.length ? [...own, groups[i + 1]] : own;
  }

  /** 화면 맨 위에 보이는 원문 줄(소수점은 블록 안 비율) */
  topLine(): number {
    const groups = this.getGroups();
    if (!groups.length) return 0;
    const y = this.el.scrollTop;
    const first = groups[0];
    if (y <= first.top) return first.line * Math.max(0, y / Math.max(1, first.top));
    const anchors = this.anchorsIn(groups, lastIndex(groups, (g) => g.top <= y));
    const lo = lastIndex(anchors, (x) => x.top <= y);
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
    const groups = this.getGroups();
    if (!groups.length) return null;
    const anchors = this.anchorsIn(groups, lastIndex(groups, (g) => g.line <= line));
    const i = lastIndex(anchors, (x) => x.line <= line);
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
    const walker = document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (HIDDEN_TEXT_PARENTS.has(n.parentElement?.localName ?? '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    for (const node of nodes) {
      if (this.marks.length >= MAX_MATCHES) break;
      const ranges = findRanges(node.data, re, MAX_MATCHES - this.marks.length);
      if (!ranges.length) continue;
      // SVG 글자(다이어그램의 text·tspan) 안에 HTML <mark>를 넣으면 글자가 사라진다. SVG tspan으로 감싸 색으로 강조한다 (FR-REN-07).
      const inSvg = node.parentElement?.namespaceURI === SVG_NS;
      // 뒤에서부터 잘라야 앞쪽 오프셋이 유지된다.
      const created: Element[] = [];
      for (let i = ranges.length - 1; i >= 0; i--) {
        const [s, e] = ranges[i];
        const hit = node.splitText(s);
        hit.splitText(e - s);
        const mark = inSvg ? document.createElementNS(SVG_NS, 'tspan') : document.createElement('mark');
        mark.setAttribute('class', 'mdv-hit');
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
    // 접힌 앞머리 상자 안의 일치는 상자를 펼쳐야 보인다 (FR-REN-08).
    const box = m.closest('details');
    if (box && !box.open) box.open = true;
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
