import type { HostDoc } from './bridge/types';
import { diffLines, type LineRange } from './changes';
import type { Encoding } from './encoding';
import { docKey } from './render/paths';

export type { HostDoc } from './bridge/types';
export type { Encoding } from './encoding';

/** 문서 모델 (SDD 5.1, ARCH-01·06) */
export interface DocModel extends HostDoc {
  id: string;
  version: number;
  state: 'ok' | 'deleted';
  /** 수정됨: 본문이 마지막으로 읽거나 저장한 내용과 다르다 (FR-EDIT-02) */
  dirty: boolean;
  /** 마지막으로 읽거나 저장한 본문(LF). 수정됨을 다시 셀 때와 자기 저장 알림을 거를 때의 기준 (FR-EDIT-09) */
  savedText: string;
  /** 새 문서: 파일이 없고 본문은 화면 메모리에만 있다 (FR-EDIT-06) */
  untitled: boolean;
  /** 사용자가 인코딩을 직접 고른 경우, 다시 읽을 때도 유지한다 (FR-INFO-02). */
  forcedEncoding?: Encoding;
  /** 큰 파일을 사용자가 미리보기로 그리기로 한 경우 (NFR-PERF-03) */
  forcePreview?: boolean;
  /** 밖에서 바뀌어 다시 읽은 본문에서 바뀐 줄 범위 (FR-WATCH-05). 고치기 시작하면 지운다. 세션에는 남기지 않는다. */
  changes?: LineRange[];
}

/** 구독 알림의 종류. content: 디스크에서 읽은 본문, edit: 편집기에서 고친 본문, flags: 수정됨·삭제 같은 표시만 (SDD 5.1) */
export type DocChange = 'content' | 'edit' | 'flags';
type Listener = (doc: DocModel, kind: DocChange) => void;

/** 저장한 뒤 문서 모델에 반영할 디스크 상태 */
export interface SavedState {
  text: string;
  mtime: number;
  size: number;
  encoding: Encoding;
  hasBom: boolean;
  eol: HostDoc['eol'];
  eolCounts: HostDoc['eolCounts'];
}

export class DocStore {
  private docs = new Map<string, DocModel>();
  private listeners = new Set<Listener>();
  /** 버전은 문서를 지웠다 다시 읽어도 되돌아가지 않는다(렌더링 캐시 키로 쓰인다). */
  private seq = 0;

  get(id: string): DocModel | undefined {
    return this.docs.get(id);
  }

  byPath(path: string): DocModel | undefined {
    return this.docs.get(docKey(path));
  }

  all(): DocModel[] {
    return [...this.docs.values()];
  }

  /**
   * 새로 읽은 내용을 반영한다. 같은 문서면 버전만 올린다.
   * 고친 문서는 디스크 내용으로 덮지 않고 그대로 돌려준다. 사용자가 고친 내용을 버리기로 했을 때만 force로 덮는다 (FR-EDIT-09).
   * track이면 밖에서 바뀌어 다시 읽은 것이므로 보이던 본문과 비교해 바뀐 곳을 남긴다 (FR-WATCH-05).
   */
  upsert(h: HostDoc, force = false, track = false): DocModel {
    const id = docKey(h.path);
    const prev = this.docs.get(id);
    if (prev?.dirty && !force) return prev;
    const changes = track && prev && !prev.untitled && !prev.binary && !h.binary ? diffLines(prev.text, h.text) : [];
    const doc: DocModel = {
      ...h,
      id,
      version: ++this.seq,
      state: 'ok',
      dirty: false,
      savedText: h.text,
      untitled: false,
      forcedEncoding: prev?.forcedEncoding,
      forcePreview: prev?.forcePreview,
      changes: changes.length ? changes : undefined,
    };
    this.docs.set(id, doc);
    this.emit(doc, 'content');
    return doc;
  }

  /** 새 문서 (FR-EDIT-06). 저장하기 전까지 UTF-8·BOM 없음·LF로 둔다. */
  create(path: string): DocModel {
    const id = docKey(path);
    const doc: DocModel = {
      path, text: '', encoding: 'utf-8', hasBom: false, eol: 'None', eolCounts: { crlf: 0, lf: 0, cr: 0 }, size: 0, mtime: 0,
      decodeWarning: false, kind: 'markdown', binary: false,
      id, version: ++this.seq, state: 'ok', dirty: false, savedText: '', untitled: true,
    };
    this.docs.set(id, doc);
    this.emit(doc, 'content');
    return doc;
  }

  /**
   * 편집기 본문을 반영한다 (FR-EDIT-01). 상태 표시줄이 문서 객체마다 글자 수를 기억하므로 새 객체를 만든다.
   * 수정됨은 저장한 본문과 비교해 다시 정한다. 실행 취소로 저장한 내용과 같아지면 꺼진다 (FR-EDIT-02).
   */
  applyEdit(id: string, text: string): DocModel | undefined {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    const dirty = text !== doc.savedText;
    if (doc.text === text) {
      if (doc.dirty !== dirty) this.update(id, { dirty });
      return this.docs.get(id);
    }
    // 고치기 시작하면 밖에서 바뀐 곳 표시는 지운다 (FR-WATCH-05).
    const next: DocModel = { ...doc, text, version: ++this.seq, dirty, changes: undefined };
    this.docs.set(id, next);
    this.emit(next, 'edit');
    return next;
  }

  /** 저장했다: 본문·디스크 상태를 새 기준으로 삼는다. 저장하는 동안 더 고쳤으면 수정됨이 남는다. */
  markSaved(id: string, s: SavedState): DocModel | undefined {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    Object.assign(doc, {
      savedText: s.text, mtime: s.mtime, size: s.size, encoding: s.encoding, hasBom: s.hasBom, eol: s.eol, eolCounts: s.eolCounts,
      dirty: doc.text !== s.text, state: 'ok', untitled: false, decodeWarning: false,
    });
    this.emit(doc, 'flags');
    return doc;
  }

  /** 다른 이름으로 저장한 뒤 문서를 새 위치로 옮긴다 (FR-EDIT-05). 옛 위치의 문서는 지운다. */
  rekey(oldId: string, path: string, kind: DocModel['kind']): DocModel | undefined {
    const doc = this.docs.get(oldId);
    if (!doc) return undefined;
    const id = docKey(path);
    this.docs.delete(oldId);
    const next: DocModel = { ...doc, path, id, kind, version: ++this.seq };
    this.docs.set(id, next);
    this.emit(next, 'content');
    return next;
  }

  update(id: string, patch: Partial<Pick<DocModel, 'forcedEncoding' | 'forcePreview' | 'state' | 'dirty' | 'mtime' | 'size' | 'savedText'>>): DocModel | undefined {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    Object.assign(doc, patch);
    this.emit(doc, 'flags');
    return doc;
  }

  markDeleted(path: string): DocModel | undefined {
    const doc = this.byPath(path);
    if (!doc || doc.state === 'deleted') return doc;
    return this.update(doc.id, { state: 'deleted' });
  }

  remove(id: string) {
    this.docs.delete(id);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(doc: DocModel, kind: DocChange) {
    for (const fn of this.listeners) fn(doc, kind);
  }
}

/** 상태 표시줄용 단어 수: 공백으로 나눈 덩어리 */
export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export function countLines(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13) {
      n++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

/** 코드 포인트 기준 글자 수 (줄바꿈 제외) */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) if (ch !== '\n' && ch !== '\r') n++;
  return n;
}

export function encodingLabel(doc: Pick<DocModel, 'encoding' | 'hasBom'>): string {
  switch (doc.encoding) {
    case 'utf-8':
      return doc.hasBom ? 'UTF-8 BOM' : 'UTF-8';
    case 'utf-16le':
      return 'UTF-16 LE';
    case 'utf-16be':
      return 'UTF-16 BE';
    case 'cp949':
      return 'CP949';
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
