import { Annotation, Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Text } from '@codemirror/state';
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { defaultHighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import {
  closeSearchPanel, findNext, findPrevious, openSearchPanel, replaceAll, replaceNext, search, SearchQuery, setSearchQuery,
} from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import type { LineRange } from '../changes';
import { S } from '../strings';
import { MAX_MATCHES, type FindQuery, type FindStatus } from './find';

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'calc(13.5px * var(--mdv-zoom, 1))' },
  '.cm-scroller': { fontFamily: 'Consolas, "D2Coding", "Malgun Gothic", monospace', lineHeight: '1.55' },
  '.cm-content': { padding: '8px 0' },
  '.cm-gutters': { borderRight: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--find-hit)', outline: 'none' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--find-current)' },
  // 밖에서 바뀐 줄과 줄을 지운 자리 (FR-WATCH-05)
  '.cm-line.cm-mdv-changed': { boxShadow: 'inset 3px 0 0 var(--changed)' },
  '.cm-line.cm-mdv-deleted': { boxShadow: 'inset 0 2px 0 var(--changed-del)' },
});

/** scrollToLine 뒤 같은 줄로 다시 맞추는 시간 */
const SETTLE_MS = 1000;

const lightTheme = [syntaxHighlighting(defaultHighlightStyle, { fallback: true }), EditorView.theme({}, { dark: false })];

/** 디스크에서 다시 읽은 내용을 편집기에 넣는 변경. 사용자의 편집이 아니므로 수정됨을 켜지 않는다 (FR-EDIT-09). */
const external = Annotation.define<boolean>();

/** 바뀐 곳 표시를 바꾼다 (FR-WATCH-05). null이면 지운다. */
const setChanged = StateEffect.define<readonly LineRange[] | null>();

const changedLine = Decoration.line({ class: 'cm-mdv-changed' });
const deletedLine = Decoration.line({ class: 'cm-mdv-deleted' });

function changedDecorations(doc: Text, ranges: readonly LineRange[] | null): DecorationSet {
  if (!ranges?.length) return Decoration.none;
  const marks = [];
  for (const r of ranges) {
    if (r.end > r.start) {
      for (let n = r.start; n < Math.min(r.end, doc.lines); n++) marks.push(changedLine.range(doc.line(n + 1).from));
    } else {
      marks.push(deletedLine.range(doc.line(Math.min(r.start, doc.lines - 1) + 1).from));
    }
  }
  return Decoration.set(marks, true);
}

/** 문서 상태마다 바뀐 곳 표시를 둔다. 사용자가 고치면 지우고, 디스크에서 다시 넣은 변경에는 따라 옮긴 뒤 새 표시로 바꾼다. */
const changedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setChanged)) return changedDecorations(tr.state.doc, e.value);
    if (tr.docChanged) return tr.annotation(external) ? deco.map(tr.changes) : Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 원문 보기 (ARCH-02). 실제 편집기 컴포넌트(CodeMirror)이고 v2.0부터 편집한다 (FR-EDIT-01).
 * 편집기 하나를 모든 탭이 같이 쓰고, 문서마다 상태(본문·선택·실행 취소 기록)를 따로 두어 탭을 바꿀 때 갈아 끼운다.
 */
export class SourceView {
  readonly el: HTMLElement;
  readonly view: EditorView;
  docId: string | null = null;
  docVersion = 0;
  /** 사용자가 본문을 고쳤다. 편집 조정자(edit.ts)가 받아 문서 모델에 반영한다. */
  onChange: (docId: string) => void = () => {};
  /** 보이지 않는 문서의 편집기 상태 */
  private states = new Map<string, EditorState>();
  private editable = new Compartment();
  private wrap = new Compartment();
  private theme = new Compartment();
  private editableOn = true;
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

  private editableExt(on: boolean) {
    return [EditorState.readOnly.of(!on), EditorView.editable.of(on)];
  }

  private makeState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        history(),
        // markdown()은 HTML·JS·CSS 파서까지 끌고 오므로 Markdown 문법만 쓴다.
        new LanguageSupport(markdownLanguage),
        // 하이라이트는 패널이 열려 있을 때만 그려지므로 보이지 않는 패널을 쓴다.
        search({ createPanel: () => ({ dom: Object.assign(document.createElement('div'), { hidden: true }) }) }),
        // 목록 기호 이어 쓰기(Enter)와 빈 기호 지우기(Backspace)가 기본 키보다 먼저다 (FR-EDIT-01).
        Prec.high(keymap.of(markdownKeymap)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        this.editable.of(this.editableExt(this.editableOn)),
        this.wrap.of(this.wrapOn ? EditorView.lineWrapping : []),
        this.theme.of(this.dark ? oneDark : lightTheme),
        baseTheme,
        changedField,
        EditorView.updateListener.of((u) => {
          // 맞추는 시간 안에 줄 높이가 바뀌면(늦게 잰 줄 바꿈 등) 다시 맞춘다.
          if (this.target && (u.heightChanged || u.geometryChanged) && performance.now() < this.target.until) this.runSettle();
          if (u.docChanged && this.docId && !u.transactions.some((tr) => tr.annotation(external))) this.onChange(this.docId);
        }),
      ],
    });
  }

  /**
   * 문서를 보인다. 처음 보는 문서면 상태를 만들고, 전에 본 문서면 그 상태(선택·실행 취소 기록)를 다시 쓴다.
   * text는 문서 모델의 본문이다. 편집기 본문과 다르면(디스크에서 다시 읽음) 바뀐 부분만 넣는다 (FR-EDIT-09).
   * editable이 거짓이면 읽기 전용이다(바이너리 문서).
   */
  show(docId: string, version: number, text: string, editable: boolean) {
    if (this.docId === docId) {
      if (this.docVersion !== version) {
        this.docVersion = version;
        this.reloadClean(text);
      }
      this.setEditable(editable);
      return;
    }
    this.cancelSettle();
    if (this.docId) this.states.set(this.docId, this.view.state);
    let state = this.states.get(docId);
    this.states.delete(docId);
    this.docId = docId;
    this.docVersion = version;
    this.editableOn = editable;
    if (!state) {
      this.view.setState(this.makeState(text));
    } else {
      this.view.setState(state);
      // 보이지 않는 동안 바뀐 설정(줄 바꿈·테마·편집 가능)을 맞춘다.
      this.view.dispatch({
        effects: [
          this.wrap.reconfigure(this.wrapOn ? EditorView.lineWrapping : []),
          this.theme.reconfigure(this.dark ? oneDark : lightTheme),
          this.editable.reconfigure(this.editableExt(editable)),
        ],
      });
      this.reloadClean(text);
    }
    if (this.query) this.applyQuery(this.query);
  }

  /** 디스크에서 다시 읽은 본문을 넣는다. 앞뒤 같은 부분은 두고 가운데만 바꿔 커서·스크롤을 지키고, 실행 취소 기록에는 넣지 않는다. */
  private reloadClean(text: string) {
    const doc = this.view.state.doc;
    if (doc.length === text.length && doc.toString() === text) return;
    const cur = doc.toString();
    let start = 0;
    const max = Math.min(cur.length, text.length);
    while (start < max && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
    let endCur = cur.length;
    let endNew = text.length;
    while (endCur > start && endNew > start && cur.charCodeAt(endCur - 1) === text.charCodeAt(endNew - 1)) {
      endCur--;
      endNew--;
    }
    this.view.dispatch({
      changes: { from: start, to: endCur, insert: text.slice(start, endNew) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }

  /** 문서의 편집 상태를 버린다(고친 내용을 버리고 다시 읽을 때, 탭을 닫을 때). 보이는 문서면 다음 show에서 새로 만든다. */
  drop(docId: string) {
    this.states.delete(docId);
    if (this.docId === docId) {
      this.docId = null;
      this.docVersion = 0;
    }
  }

  /** 열린 탭이 없는 문서의 상태를 버린다. */
  prune(keep: Set<string>) {
    for (const id of [...this.states.keys()]) if (!keep.has(id)) this.states.delete(id);
    if (this.docId && !keep.has(this.docId)) this.drop(this.docId);
  }

  /** 다른 이름으로 저장해 문서 id가 바뀌었다 (FR-EDIT-05). */
  rekey(oldId: string, newId: string, version: number) {
    const st = this.states.get(oldId);
    if (st) {
      this.states.delete(oldId);
      this.states.set(newId, st);
    }
    if (this.docId === oldId) {
      this.docId = newId;
      this.docVersion = version;
    }
  }

  /** 편집 조정자가 편집기 본문을 문서 모델에 반영했다. 다시 넣을 필요가 없게 버전만 맞춘다. */
  syncVersion(docId: string, version: number) {
    if (this.docId === docId) this.docVersion = version;
  }

  /** 문서의 편집기 본문(LF). 편집기에 없는 문서면 null */
  textOf(docId: string): string | null {
    if (this.docId === docId) return this.view.state.doc.toString();
    return this.states.get(docId)?.doc.toString() ?? null;
  }

  setEditable(on: boolean) {
    if (this.editableOn === on) return;
    this.editableOn = on;
    this.view.dispatch({ effects: this.editable.reconfigure(this.editableExt(on)) });
  }

  get isEditable(): boolean {
    return this.editableOn;
  }

  focus() {
    this.view.focus();
  }

  undo(): boolean {
    return undo(this.view);
  }

  redo(): boolean {
    return redo(this.view);
  }

  setWrap(on: boolean) {
    this.wrapOn = on;
    this.view.dispatch({ effects: this.wrap.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  setDark(dark: boolean) {
    this.dark = dark;
    this.view.dispatch({ effects: this.theme.reconfigure(dark ? oneDark : lightTheme) });
  }

  /** 밖에서 바뀐 줄을 표시한다 (FR-WATCH-05). 보이는 문서에만 쓴다. */
  setChanges(ranges: readonly LineRange[] | null) {
    this.view.dispatch({ effects: setChanged.of(ranges) });
  }

  /** 커서를 줄(0부터) 처음으로 옮긴다 (FR-NAV-05). */
  setCursorLine(line: number) {
    const doc = this.view.state.doc;
    const at = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(line) + 1))).from;
    this.view.dispatch({ selection: EditorSelection.cursor(at) });
  }

  /** 선택한 원문 줄 범위 [시작, 끝](0부터, 끝 포함)과 선택한 글. 고른 것이 없으면 커서 줄과 빈 글 (FR-INFO-04). */
  selectionLines(): { start: number; end: number; text: string } {
    const st = this.view.state;
    const sel = st.selection.main;
    const start = st.doc.lineAt(sel.from).number - 1;
    let end = st.doc.lineAt(sel.to).number - 1;
    // 줄 끝까지 고르면 커서가 다음 줄 처음에 있다. 그 줄은 넣지 않는다.
    if (sel.to > sel.from && end > start && st.doc.lineAt(sel.to).from === sel.to) end--;
    return { start, end, text: st.sliceDoc(sel.from, sel.to) };
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

  /**
   * 찾아 바꾸기 (FR-EDIT-07). 바꾸기는 지금 선택한 일치를 바꾸고 다음 일치를 고른다. 모두 바꾸기는 변경 하나라 실행 취소 한 번에 돌아온다.
   * 정규식이면 $1·$&로 찾은 부분을 쓴다.
   */
  replace(q: FindQuery, replacement: string, all: boolean): FindStatus {
    const query = new SearchQuery({ search: q.text, caseSensitive: q.caseSensitive, regexp: q.regex, wholeWord: q.wholeWord, replace: replacement });
    this.query = query;
    if (q.regex && q.text && !query.valid) return { count: 0, index: -1, error: S.find.regexError };
    this.applyQuery(query);
    if (!query.search || !this.editableOn) return { count: this.count(query), index: -1 };
    if (all) {
      replaceAll(this.view);
      return { count: this.count(query), index: -1 };
    }
    // 고른 것이 일치가 아니면 replaceNext는 다음 일치를 고르기만 한다. 그때는 한 번 더 불러 바꾼다.
    const sel = this.view.state.selection.main;
    const onMatch = this.matchAt(query, sel.from, sel.to);
    replaceNext(this.view);
    if (!onMatch) replaceNext(this.view);
    return this.status(query);
  }

  private matchAt(query: SearchQuery, from: number, to: number): boolean {
    if (from === to) return false;
    const cursor = query.getCursor(this.view.state, from, to);
    const r = cursor.next();
    return !r.done && r.value.from === from && r.value.to === to;
  }

  /** 일치 개수와 지금 선택한 일치의 순번 */
  private status(query: SearchQuery): FindStatus {
    const sel = this.view.state.selection.main;
    const cursor = query.getCursor(this.view.state);
    let i = 0;
    let index = -1;
    for (let r = cursor.next(); !r.done && i < MAX_MATCHES; r = cursor.next(), i++) {
      if (r.value.from === sel.from && r.value.to === sel.to) index = i;
    }
    return { count: i, index };
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
    return this.status(q);
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
