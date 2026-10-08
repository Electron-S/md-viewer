import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { closeSearchPanel, findNext, findPrevious, openSearchPanel, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { S } from '../strings';
import { MAX_MATCHES, type FindQuery, type FindStatus } from './find';

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'calc(13.5px * var(--mdv-zoom, 1))' },
  '.cm-scroller': { fontFamily: 'Consolas, "D2Coding", "Malgun Gothic", monospace', lineHeight: '1.55' },
  '.cm-content': { padding: '8px 0' },
  '.cm-gutters': { borderRight: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--find-hit)', outline: 'none' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--find-current)' },
});

/** scrollToLine 뒤 같은 줄로 다시 맞추는 시간 */
const SETTLE_MS = 1000;

const lightTheme = [syntaxHighlighting(defaultHighlightStyle, { fallback: true }), EditorView.theme({}, { dark: false })];

/**
 * 원문 보기. 실제 편집기 컴포넌트를 읽기 전용으로 쓴다 (ARCH-02).
 * 편집 단계에서는 readOnly compartment만 바꾸면 된다.
 */
export class SourceView {
  readonly el: HTMLElement;
  readonly view: EditorView;
  docId: string | null = null;
  docVersion = 0;
  private readOnly = new Compartment();
  private wrap = new Compartment();
  private theme = new Compartment();
  private wrapOn = true;
  private dark = false;
  /** scrollToLine이 위치를 다시 맞추는 중인지. 이 동안의 스크롤은 사용자 스크롤로 치지 않는다. */
  settling = false;
  private settleId = 0;
  /** 맞출 줄과 맞추기를 그만둘 시각(performance.now 기준) */
  private target: { line: number; until: number } | null = null;
  private query: SearchQuery | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'source-wrap';
    this.view = new EditorView({ parent: this.el, state: this.makeState('') });
    // 사용자가 직접 스크롤하면 위치 맞추기를 멈춘다.
    for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) {
      this.view.scrollDOM.addEventListener(ev, () => this.cancelSettle(), { passive: true });
    }
  }

  private cancelSettle() {
    this.target = null;
    this.settleId++;
    this.settling = false;
  }

  private makeState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        drawSelection(),
        // markdown()은 HTML·JS·CSS 파서까지 끌고 오므로 Markdown 문법만 쓴다.
        new LanguageSupport(markdownLanguage),
        // 하이라이트는 패널이 열려 있을 때만 그려지므로 보이지 않는 패널을 쓴다.
        search({ createPanel: () => ({ dom: Object.assign(document.createElement('div'), { hidden: true }) }) }),
        keymap.of(defaultKeymap),
        this.readOnly.of(EditorState.readOnly.of(true)),
        this.wrap.of(this.wrapOn ? EditorView.lineWrapping : []),
        this.theme.of(this.dark ? oneDark : lightTheme),
        baseTheme,
        // 맞추는 시간 안에 줄 높이가 바뀌면(늦게 잰 줄 바꿈 등) 다시 맞춘다.
        EditorView.updateListener.of((u) => {
          if (this.target && (u.heightChanged || u.geometryChanged) && performance.now() < this.target.until) this.runSettle();
        }),
      ],
    });
  }

  setText(docId: string, version: number, text: string) {
    this.cancelSettle();
    this.docId = docId;
    this.docVersion = version;
    this.view.setState(this.makeState(text));
    if (this.query) this.applyQuery(this.query);
  }

  setWrap(on: boolean) {
    this.wrapOn = on;
    this.view.dispatch({ effects: this.wrap.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  setDark(dark: boolean) {
    this.dark = dark;
    this.view.dispatch({ effects: this.theme.reconfigure(dark ? oneDark : lightTheme) });
  }

  /** 화면 맨 위에 보이는 줄(0부터, 소수점은 줄 안 비율) */
  topLine(): number {
    const v = this.view;
    const rect = v.scrollDOM.getBoundingClientRect();
    const h = rect.top - v.documentTop;
    if (h <= 0) return 0;
    const block = v.lineBlockAtHeight(h);
    const line = v.state.doc.lineAt(block.from).number - 1;
    const frac = block.height > 0 ? (h - block.top) / block.height : 0;
    return line + Math.min(1, Math.max(0, frac));
  }

  /**
   * 원문 줄로 스크롤한다. 화면 밖 줄(특히 줄 바꿈된 줄)은 추정 높이로 배치됐다가 그려진 뒤 실제 높이로 바뀌고,
   * 편집기가 그 높이를 언제 잴지는 화면 사정에 따라 늦어질 수 있다. 그래서 1초 동안은 목표를 기억해 두고
   * 프레임마다, 그리고 줄 높이가 바뀔 때마다 같은 목표로 다시 맞춘다. 사용자가 직접 스크롤하면 그만둔다.
   */
  scrollToLine(line: number) {
    this.target = { line, until: performance.now() + SETTLE_MS };
    this.applyLine(line);
    this.runSettle();
  }

  private runSettle() {
    const id = ++this.settleId;
    this.settling = true;
    const dom = this.view.scrollDOM;
    let stable = 0;
    const step = () => {
      const t = this.target;
      if (id !== this.settleId || !t) return;
      const before = dom.scrollTop;
      this.applyLine(t.line);
      stable = Math.abs(dom.scrollTop - before) > 1 ? 0 : stable + 1;
      if (stable < 3 && performance.now() < t.until) requestAnimationFrame(step);
      else this.settling = false;
    };
    requestAnimationFrame(step);
  }

  private applyLine(line: number) {
    const v = this.view;
    const doc = v.state.doc;
    const n = Math.min(doc.lines, Math.max(1, Math.floor(line) + 1));
    const block = v.lineBlockAt(doc.line(n).from);
    const frac = Math.max(0, line - Math.floor(line));
    const contentOffset = v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop;
    v.scrollDOM.scrollTop = contentOffset + block.top + frac * block.height;
  }

  // ---- 찾기 (FR-FIND-01~03) ----

  find(q: FindQuery): FindStatus {
    const query = new SearchQuery({ search: q.text, caseSensitive: q.caseSensitive, regexp: q.regex, wholeWord: q.wholeWord });
    this.query = query;
    if (q.regex && q.text && !query.valid) return { count: 0, index: -1, error: S.find.regexError };
    this.applyQuery(query);
    return { count: this.count(query), index: -1 };
  }

  private applyQuery(query: SearchQuery) {
    openSearchPanel(this.view);
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private count(query: SearchQuery): number {
    if (!query.valid || !query.search) return 0;
    const cursor = query.getCursor(this.view.state);
    let n = 0;
    while (!cursor.next().done && n < MAX_MATCHES) n++;
    return n;
  }

  step(dir: 1 | -1): FindStatus {
    const q = this.query;
    if (!q || !q.valid || !q.search) return { count: 0, index: -1 };
    (dir === 1 ? findNext : findPrevious)(this.view);
    const sel = this.view.state.selection.main;
    const cursor = q.getCursor(this.view.state);
    let i = 0;
    let index = -1;
    for (let r = cursor.next(); !r.done && i < MAX_MATCHES; r = cursor.next(), i++) {
      if (r.value.from === sel.from && r.value.to === sel.to) index = i;
    }
    return { count: i, index };
  }

  clearFind() {
    this.query = null;
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    closeSearchPanel(this.view);
  }

  selectionText(): string {
    const sel = this.view.state.selection.main;
    return this.view.state.sliceDoc(sel.from, sel.to);
  }
}
