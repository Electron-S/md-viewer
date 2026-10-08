// 두 브리지가 함께 쓰는 규칙: 폴더 목록 거르기, 바이트를 문서로 바꾸기, 이미지 종류.
import { decodeBytes, type Encoding } from '../encoding';
import { isMarkdownPath, isTextPath } from '../render/paths';
import type { DirEntry, HostDoc } from './types';

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
  return {
    path,
    text: d.binary ? '' : d.text,
    encoding: d.encoding,
    hasBom: d.hasBom,
    eol: d.binary ? 'None' : d.eol,
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

/** 문서 이미지로 보여줄 수 있는 확장자면 MIME 형식, 아니면 null */
export function imageType(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && IMAGE_TYPES[m[1].toLowerCase()]) || null;
}
