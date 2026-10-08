import { docKey } from './render/paths';

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp949';
export type Eol = 'CRLF' | 'LF' | 'CR' | 'Mixed' | 'None';

/** 호스트 file.read 결과 (SDD 6.2) */
export interface HostDoc {
  path: string;
  text: string;
  encoding: Encoding;
  hasBom: boolean;
  eol: Eol;
  size: number;
  mtime: number;
  decodeWarning: boolean;
  kind: 'markdown' | 'text';
  binary: boolean;
}

/** 문서 모델 (SDD 5.1, ARCH-01·06) */
export interface DocModel extends HostDoc {
  id: string;
  version: number;
  state: 'ok' | 'deleted';
  dirty: false;
  /** 사용자가 인코딩을 직접 고른 경우, 다시 읽을 때도 유지한다 (FR-INFO-02). */
  forcedEncoding?: Encoding;
  /** 큰 파일을 사용자가 미리보기로 그리기로 한 경우 (NFR-PERF-03) */
  forcePreview?: boolean;
}

type Listener = (doc: DocModel) => void;

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

  /** 새로 읽은 내용을 반영한다. 같은 문서면 버전만 올린다. */
  upsert(h: HostDoc): DocModel {
    const id = docKey(h.path);
    const prev = this.docs.get(id);
    const doc: DocModel = {
      ...h,
      id,
      version: ++this.seq,
      state: 'ok',
      dirty: false,
      forcedEncoding: prev?.forcedEncoding,
      forcePreview: prev?.forcePreview,
    };
    this.docs.set(id, doc);
    this.emit(doc);
    return doc;
  }

  update(id: string, patch: Partial<Pick<DocModel, 'forcedEncoding' | 'forcePreview' | 'state'>>): DocModel | undefined {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    Object.assign(doc, patch);
    this.emit(doc);
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

  private emit(doc: DocModel) {
    for (const fn of this.listeners) fn(doc);
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
