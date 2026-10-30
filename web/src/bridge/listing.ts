// 두 브리지가 함께 쓰는 규칙: 폴더 목록 거르기, 바이트를 문서로 바꾸기, 이미지 종류, 오류 문구.
import { countEols, decodeBytes, eolOf, toLf, type Encoding } from '../encoding';
import { isMarkdownPath, isTextPath } from '../render/paths';
import { S } from '../strings';
import { HostError, type DirEntry, type HostDoc } from './types';

/** 파일 하나의 최대 크기. 넘으면 ETOOBIG. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_DIR_ENTRIES = 5000;
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);

/** 작업 공간 트리 규칙 (FR-NAV-02): 문서만, 폴더 먼저, 숨김·node_modules 제외, 이름순. */
export function filterEntries(entries: DirEntry[]): DirEntry[] {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDir) {
      if (!SKIP_DIRS.has(e.name.toLowerCase()) && dirs.length < MAX_DIR_ENTRIES) dirs.push(e.name);
    } else if ((isMarkdownPath(e.name) || isTextPath(e.name)) && files.length < MAX_DIR_ENTRIES) {
      files.push(e.name);
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return [...dirs.sort(byName).map((name) => ({ name, isDir: true })), ...files.sort(byName).map((name) => ({ name, isDir: false }))];
}

/** 원본 바이트를 file.read 결과로 바꾼다. 인코딩 판별은 여기 한 곳에서 한다 (SDD 8.3). */
export function toHostDoc(path: string, bytes: Uint8Array, mtime: number, forced?: Encoding): HostDoc {
  const d = decodeBytes(bytes, forced);
  const text = d.binary ? '' : d.text;
  const counts = countEols(text);
  return {
    path,
    // 편집기와 같은 형식(LF)으로 둔다. 저장할 때 eolCounts로 원래 줄 끝을 되돌린다 (SDD 8.3).
    text: toLf(text),
    encoding: d.encoding,
    hasBom: d.hasBom,
    eol: eolOf(counts),
    eolCounts: counts,
    size: bytes.length,
    mtime,
    decodeWarning: d.decodeWarning,
    kind: isMarkdownPath(path) ? 'markdown' : 'text',
    binary: d.binary,
  };
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** file.write의 덮어쓰기 검사·새 파일 인자를 실행기·Windows 앱의 /api/write 쿼리로 (SDD 6.1~6.2) */
export function writeQuery(p: Record<string, any>): Record<string, string> {
  const q: Record<string, string> = {};
  if (typeof p.baseMtime === 'number') q.baseMtime = String(Math.round(p.baseMtime));
  if (typeof p.baseSize === 'number') q.baseSize = String(p.baseSize);
  if (p.create) q.create = '1';
  if (p.overwrite) q.overwrite = '1';
  return q;
}

/** 브리지 오류 코드로 HostError를 만든다. 화면 문구가 없는 코드면 fallback(실행기가 준 문구 등)을 쓴다. */
export function hostError(code: string, fallback?: string): HostError {
  const known: Record<string, string> = {
    ENOENT: S.error.noFile,
    EACCES: S.error.accessDenied,
    EISDIR: S.error.isFolder,
    ETOOBIG: S.error.tooBig,
    ENOTSUP: S.error.notSupported,
    EINVAL: S.error.badPath,
    ECONFLICT: S.error.conflict,
    EEXIST: S.error.exists,
  };
  return new HostError(code, known[code] ?? fallback ?? S.error.host);
}

/** 문서 이미지로 보여줄 수 있는 확장자면 MIME 형식, 아니면 null */
export function imageType(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && IMAGE_TYPES[m[1].toLowerCase()]) || null;
}
