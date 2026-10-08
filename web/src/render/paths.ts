// Windows 경로 유틸. 화면은 OS를 모르지만, 호스트가 넘겨주는 경로 문자열은 Windows 형식이다.

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
const TEXT_EXT = /\.txt$/i;

export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXT.test(p);
}

export function isTextPath(p: string): boolean {
  return TEXT_EXT.test(p);
}

export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** 드라이브(`C:\`) 또는 UNC(`\\server\share\`) 루트와 나머지로 나눈다. */
export function splitRoot(p: string): { root: string; rest: string } {
  const drive = /^([a-zA-Z]:)(?:[\\/]+|$)/.exec(p);
  if (drive) return { root: drive[1].toUpperCase() + '\\', rest: p.slice(drive[0].length) };
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(p);
  if (unc) return { root: '\\\\' + unc[1] + '\\' + unc[2] + '\\', rest: p.slice(unc[0].length) };
  return { root: '', rest: p };
}

/** `.`·`..`·중복 구분자를 정리하고 구분자를 `\`로 통일한다. */
export function normalizePath(p: string): string {
  const { root, rest } = splitRoot(p);
  const out: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return root + out.join('\\');
}

/** 문서 id: 정규화한 절대 경로를 소문자로 (Windows 파일 시스템은 대소문자를 구분하지 않는다). */
export function docKey(p: string): string {
  return normalizePath(p).toLowerCase();
}

export function dirname(p: string): string {
  const n = normalizePath(p);
  const { root } = splitRoot(n);
  const i = n.lastIndexOf('\\');
  return i < root.length ? root : n.slice(0, i);
}

export function basename(p: string): string {
  const n = p.replace(/[\\/]+$/, '');
  const i = Math.max(n.lastIndexOf('\\'), n.lastIndexOf('/'));
  return i < 0 ? n : n.slice(i + 1);
}

/** 문서 폴더 기준으로 상대 경로를 절대 경로로 바꾼다. `/x`는 문서 드라이브 루트 기준. */
export function resolvePath(baseDir: string, rel: string): string {
  if (isAbsolutePath(rel)) return normalizePath(rel);
  if (/^[\\/]/.test(rel)) return normalizePath(splitRoot(baseDir).root + rel);
  return normalizePath(baseDir + '\\' + rel);
}

export type UrlKind = 'fragment' | 'external' | 'local' | 'data-image' | 'blocked';

export function classifyUrl(raw: string): UrlKind {
  const s = raw.trim();
  if (s.startsWith('#')) return 'fragment';
  if (/^(https?:|mailto:)/i.test(s)) return 'external';
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(s)) return 'data-image';
  if (/^[a-zA-Z]:[\\/]/.test(s)) return 'local';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return 'blocked';
  return 'local';
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 로컬 링크(`docs/a.md#intro`)를 절대 경로와 조각으로 나눈다. `file:` 스킴은 열지 않는다(SRS 4.3). */
export function resolveLocalUrl(raw: string, baseDir: string): { path: string; fragment: string } | null {
  let s = raw.trim();
  let fragment = '';
  const hash = s.indexOf('#');
  if (hash >= 0) {
    fragment = safeDecode(s.slice(hash + 1));
    s = s.slice(0, hash);
  }
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  s = safeDecode(s);
  if (!s) return null;
  if (!baseDir && !isAbsolutePath(s)) return null;
  const path = resolvePath(baseDir, s);
  // 네트워크 경로(\\server\share)는 문서가 있는 공유 안일 때만 허용한다.
  // 다른 서버를 가리키면 문서를 여는 것만으로 SMB 접속(자격 증명 전송)이 일어나기 때문이다.
  const root = splitRoot(path).root;
  if (root.startsWith('\\\\') && root.toLowerCase() !== splitRoot(baseDir).root.toLowerCase()) return null;
  return { path, fragment };
}

/** 앱 내부 주소. 문서가 직접 쓰면 경로 검사를 건너뛰게 되므로 막는다. */
export function isInternalUrl(raw: string): boolean {
  return /^https?:\/\/(file|app)\.mdview(?=[/?#:]|$)/i.test(raw.trim());
}

/** 문서 이미지를 호스트가 응답하는 주소로 바꾼다 (SDD 8.1, 8.4). */
export function fileResourceUrl(absPath: string): string {
  return 'https://file.mdview/' + encodeURIComponent(absPath);
}
