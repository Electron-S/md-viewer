// 문서 위치 유틸 (SDD 5.2). 위치 문자열은 세 형식 중 하나다.
//  - win:   C:\docs\a.md, \\server\share\a.md  (실행기가 Windows에서 돌 때, 대소문자 구분 안 함)
//  - posix: /home/me/docs/a.md                 (실행기가 WSL·macOS·Linux에서 돌 때)
//  - mdv:   mdv:/d1/guide/a.md                 (브라우저 파일 핸들로 연 문서, 첫 마디가 루트 id)

export type PathStyle = 'win' | 'posix' | 'mdv';

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;
const TEXT_EXT = /\.txt$/i;

export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXT.test(p);
}

export function isTextPath(p: string): boolean {
  return TEXT_EXT.test(p);
}

const WIN_ABS = /^[a-zA-Z]:[\\/]|^[\\/]{2}[^\\/]/;

export function pathStyle(p: string): PathStyle | null {
  if (/^mdv:\//i.test(p)) return 'mdv';
  if (WIN_ABS.test(p)) return 'win';
  if (p.startsWith('/')) return 'posix';
  return null;
}

export function isAbsolutePath(p: string): boolean {
  return pathStyle(p) !== null;
}

function sepOf(style: PathStyle | null): string {
  return style === 'win' ? '\\' : '/';
}

/** 루트와 나머지로 나눈다. win `C:\`·`\\server\share\`, posix `/`, mdv `mdv:/d1/`. */
export function splitRoot(p: string): { root: string; rest: string } {
  const style = pathStyle(p);
  if (style === 'mdv') {
    const m = /^mdv:\/+([^\\/]+)(?:[\\/]+|$)/i.exec(p);
    if (m) return { root: `mdv:/${m[1]}/`, rest: p.slice(m[0].length) };
  } else if (style === 'win') {
    const drive = /^([a-zA-Z]:)(?:[\\/]+|$)/.exec(p);
    if (drive) return { root: drive[1].toUpperCase() + '\\', rest: p.slice(drive[0].length) };
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(p);
    if (unc) return { root: '\\\\' + unc[1] + '\\' + unc[2] + '\\', rest: p.slice(unc[0].length) };
  } else if (style === 'posix') {
    return { root: '/', rest: p.replace(/^\/+/, '') };
  }
  return { root: '', rest: p };
}

/** `.`·`..`·중복 구분자를 정리하고 구분자를 형식에 맞게 통일한다. `..`는 루트 위로 올라가지 않는다. */
export function normalizePath(p: string): string {
  const style = pathStyle(p);
  const { root, rest } = splitRoot(p);
  const out: string[] = [];
  for (const seg of rest.split(style === 'win' || style === null ? /[\\/]+/ : /\/+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return root + out.join(sepOf(style));
}

/** 문서 id: 정규화한 위치. Windows 경로는 대소문자를 구분하지 않으므로 소문자로 바꾼다. */
export function docKey(p: string): string {
  const n = normalizePath(p);
  return pathStyle(n) === 'win' ? n.toLowerCase() : n;
}

export function dirname(p: string): string {
  const n = normalizePath(p);
  const { root } = splitRoot(n);
  const i = n.lastIndexOf(sepOf(pathStyle(n)));
  return i < root.length ? root : n.slice(0, i);
}

export function basename(p: string): string {
  const n = p.replace(/[\\/]+$/, '');
  const i = Math.max(n.lastIndexOf('\\'), n.lastIndexOf('/'));
  return i < 0 ? n : n.slice(i + 1);
}

export function joinPath(dir: string, name: string): string {
  return normalizePath(dir.replace(/[\\/]+$/, '') + sepOf(pathStyle(dir)) + name);
}

/** child가 dir 안(같거나 아래)에 있는지. Windows 경로는 대소문자를 무시한다. */
export function isInside(child: string, dir: string): boolean {
  const c = docKey(child);
  const d = docKey(dir);
  const root = docKey(splitRoot(d).root);
  if (c === d || d === root) return c.startsWith(d);
  return c.startsWith(d + sepOf(pathStyle(d)));
}

/**
 * 문서 폴더 기준으로 상대 경로를 위치로 바꾼다.
 * `/x`(구분자로 시작)는 docRoot 기준이다. docRoot가 없으면 문서 위치의 루트(드라이브·`/`·mdv 루트) 기준이다.
 */
export function resolvePath(baseDir: string, rel: string, docRoot?: string | null): string {
  if (WIN_ABS.test(rel) || /^mdv:\//i.test(rel)) return normalizePath(rel);
  const style = pathStyle(baseDir);
  if (/^[\\/]/.test(rel)) {
    const root = docRoot || splitRoot(baseDir).root;
    return normalizePath(root.replace(/[\\/]+$/, '') + sepOf(style) + rel.replace(/^[\\/]+/, ''));
  }
  return normalizePath(baseDir.replace(/[\\/]+$/, '') + sepOf(style) + rel);
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

/** 로컬 링크(`docs/a.md#intro`)를 위치와 조각으로 나눈다. `file:` 스킴은 열지 않는다(SRS 4.3). */
export function resolveLocalUrl(raw: string, baseDir: string, docRoot?: string | null): { path: string; fragment: string } | null {
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
  const path = resolvePath(baseDir, s, docRoot);
  // 네트워크 경로(\\server\share)는 문서가 있는 공유 안일 때만 허용한다.
  // 다른 서버를 가리키면 문서를 여는 것만으로 SMB 접속(자격 증명 전송)이 일어나기 때문이다.
  const root = splitRoot(path).root;
  if (root.startsWith('\\\\') && root.toLowerCase() !== splitRoot(baseDir).root.toLowerCase()) return null;
  // 문서 형식과 다른 형식의 위치(posix 문서 안의 C:\ 링크 등)는 열 수 없다.
  if (pathStyle(baseDir) && pathStyle(path) !== pathStyle(baseDir)) return null;
  return { path, fragment };
}

/**
 * 루프백 주소(localhost, 127.x, [::1], 0.0.0.0)와 이 페이지 자신의 origin.
 * 문서가 직접 쓰면 실행기 API나 다른 로컬 서비스를 건드릴 수 있으므로 막는다 (SDD 8.4).
 */
export function isInternalUrl(raw: string, selfOrigin?: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (selfOrigin && u.origin === selfOrigin) return true;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0' ||
    /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:(7f|0:0)/.test(h)
  );
}
