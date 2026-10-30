// 인코딩 판별 (SDD 8.3, NFR-ENC-01~03). 두 브리지가 넘긴 원본 바이트를 문서 텍스트로 바꾼다.
// 순서: BOM → 바이너리 → 엄격 UTF-8 → 엄격 CP949 → UTF-8 대체 문자.

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp949';
export type Eol = 'CRLF' | 'LF' | 'CR' | 'Mixed' | 'None';

export interface Decoded {
  text: string;
  encoding: Encoding;
  hasBom: boolean;
  /** 잘못된 바이트를 대체 문자로 바꿨는지 (NFR-ENC-02) */
  decodeWarning: boolean;
  binary: boolean;
  eol: Eol;
}

export const ENCODINGS: readonly Encoding[] = ['utf-8', 'utf-16le', 'utf-16be', 'cp949'];

/** WHATWG 인코딩 표준의 euc-kr 디코더는 windows-949(CP949)다. */
const LABEL: Record<Encoding, string> = { 'utf-8': 'utf-8', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be', cp949: 'euc-kr' };
const BOM: Partial<Record<Encoding, number[]>> = { 'utf-8': [0xef, 0xbb, 0xbf], 'utf-16le': [0xff, 0xfe], 'utf-16be': [0xfe, 0xff] };
const BINARY_SCAN_BYTES = 8000;

export function isEncoding(v: unknown): v is Encoding {
  return typeof v === 'string' && (ENCODINGS as readonly string[]).includes(v);
}

function startsWith(b: Uint8Array, prefix: number[] | undefined): boolean {
  if (!prefix || b.length < prefix.length) return false;
  return prefix.every((x, i) => b[i] === x);
}

export function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function decode(b: Uint8Array, enc: Encoding, fatal: boolean): string {
  return new TextDecoder(LABEL[enc], { fatal, ignoreBOM: true }).decode(b);
}

function result(text: string, encoding: Encoding, hasBom: boolean, decodeWarning: boolean): Decoded {
  return { text, encoding, hasBom, decodeWarning, binary: false, eol: detectEol(text) };
}

/** 지정한 인코딩으로 읽는다 (FR-INFO-02). 잘못된 바이트는 대체 문자로 바꾸고 경고를 켠다. */
export function decodeAs(b: Uint8Array, enc: Encoding): Decoded {
  const bom = startsWith(b, BOM[enc]) ? BOM[enc]!.length : 0;
  const body = b.subarray(bom);
  try {
    return result(decode(body, enc, true), enc, bom > 0, false);
  } catch {
    return result(decode(body, enc, false), enc, bom > 0, true);
  }
}

/** 인코딩을 판별해 읽는다. forced가 있으면 판별 없이 그 인코딩으로 읽는다. */
export function decodeBytes(b: Uint8Array, forced?: Encoding): Decoded {
  if (forced) return decodeAs(b, forced);
  for (const enc of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
    if (startsWith(b, BOM[enc])) return decodeAs(b, enc);
  }
  if (looksBinary(b)) return { text: '', encoding: 'utf-8', hasBom: false, decodeWarning: false, binary: true, eol: 'None' };
  for (const enc of ['utf-8', 'cp949'] as const) {
    try {
      const text = decode(b, enc, true);
      // WHATWG euc-kr 디코더는 C1 제어 문자를 내지 않는다. 나왔다면 CP949 확장을 모르는 디코더가 지나친 것이다.
      if (enc === 'cp949' && /[\u0080-\u009f]/.test(text)) continue;
      return result(text, enc, false, false);
    } catch {
      // 다음 후보로
    }
  }
  return result(decode(b, 'utf-8', false), 'utf-8', false, true);
}

export interface EolCounts {
  crlf: number;
  lf: number;
  cr: number;
}

export function countEols(text: string): EolCounts {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  return { crlf, lf, cr };
}

export function eolOf({ crlf, lf, cr }: EolCounts): Eol {
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
  if (kinds === 0) return 'None';
  if (kinds > 1) return 'Mixed';
  return crlf ? 'CRLF' : lf ? 'LF' : 'CR';
}

export function detectEol(text: string): Eol {
  return eolOf(countEols(text));
}

/** 줄 끝을 LF로 맞춘다. 편집기(CodeMirror)가 쓰는 형식과 같게 둬야 저장 기준과 비교할 수 있다 (SDD 5.1). */
export function toLf(text: string): string {
  return text.indexOf('\r') < 0 ? text : text.replace(/\r\n?/g, '\n');
}

export type SaveEol = 'CRLF' | 'LF' | 'CR';

/** 저장할 줄 끝 (FR-EDIT-04, SDD 8.3). 섞여 있으면 많은 쪽(같으면 LF), 줄 끝이 없던 문서는 LF. */
export function saveEolOf(eol: Eol, counts: EolCounts): SaveEol {
  if (eol === 'CRLF' || eol === 'LF' || eol === 'CR') return eol;
  if (eol === 'Mixed') {
    const max = Math.max(counts.crlf, counts.lf, counts.cr);
    if (counts.lf === max) return 'LF';
    return counts.crlf === max ? 'CRLF' : 'CR';
  }
  return 'LF';
}

// ---- 저장용 인코딩 (FR-EDIT-04, NFR-ENC-05) ----

/** CP949 글자 → 두 바이트(lead << 8 | trail). 처음 저장할 때 브라우저의 euc-kr(= windows-949) 디코더로 만든다. */
let cp949Table: Map<string, number> | null = null;

function cp949Map(): Map<string, number> {
  if (cp949Table) return cp949Table;
  // 리드 0x81~0xFE, 트레일 0x41~0xFE 쌍을 줄바꿈으로 갈라 한 번에 푼다. 잘못된 쌍은 대체 문자(와 ASCII 트레일)가 되고,
  // 맞는 쌍은 글자 하나가 된다. 쌍 순서가 WHATWG 색인 순서라 같은 글자는 처음 쌍(= 표준 인코더가 고르는 쌍)을 쓴다.
  const pairs: number[] = [];
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x41; trail <= 0xfe; trail++) pairs.push(lead, trail, 0x0a);
  }
  const parts = new TextDecoder(LABEL.cp949).decode(Uint8Array.from(pairs)).split('\n');
  const map = new Map<string, number>();
  let k = 0;
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x41; trail <= 0xfe; trail++) {
      const ch = parts[k++];
      if (ch && ch.length === 1 && ch !== '�' && ch.charCodeAt(0) >= 0x80 && !map.has(ch)) map.set(ch, (lead << 8) | trail);
    }
  }
  cp949Table = map;
  return map;
}

/** 인코딩으로 나타낼 수 없는 글자(중복 없이, 처음 limit개). UTF-8·UTF-16은 짝 없는 서로게이트만 걸린다. */
export function findUnencodable(text: string, enc: Encoding, limit = 5): string[] {
  const out = new Set<string>();
  if (enc === 'cp949') {
    const map = cp949Map();
    for (const ch of text) {
      if (ch.charCodeAt(0) < 0x80 || map.has(ch)) continue;
      out.add(ch);
      if (out.size >= limit) break;
    }
  } else {
    for (const m of text.matchAll(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g)) {
      out.add(m[0]);
      if (out.size >= limit) break;
    }
  }
  return [...out];
}

function encodeUtf16(text: string, be: boolean, bom: boolean): Uint8Array {
  const off = bom ? 2 : 0;
  const out = new Uint8Array(off + text.length * 2);
  if (bom) out.set(be ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[off + i * 2] = be ? c >> 8 : c & 0xff;
    out[off + i * 2 + 1] = be ? c & 0xff : c >> 8;
  }
  return out;
}

function encodeCp949(text: string): Uint8Array {
  const map = cp949Map();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) {
      out[n++] = c;
      continue;
    }
    const v = map.get(ch);
    // 부르는 쪽이 findUnencodable로 먼저 거른다. 남은 글자는 '?'로 쓴다(WHATWG 인코더의 HTML 모드 대신).
    if (v === undefined) out[n++] = 0x3f;
    else {
      out[n++] = v >> 8;
      out[n++] = v & 0xff;
    }
  }
  return out.subarray(0, n);
}

/**
 * LF로 맞춘 본문을 문서의 원래 형식(인코딩·BOM·줄 끝)으로 바이트로 바꾼다 (FR-EDIT-04, NFR-ENC-05).
 * 나타낼 수 없는 글자는 findUnencodable로 먼저 확인한다.
 */
export function encodeText(text: string, enc: Encoding, hasBom: boolean, eol: SaveEol): Uint8Array {
  const body = eol === 'LF' ? text : text.replace(/\n/g, eol === 'CRLF' ? '\r\n' : '\r');
  switch (enc) {
    case 'utf-8': {
      const b = new TextEncoder().encode(body);
      if (!hasBom) return b;
      const out = new Uint8Array(b.length + 3);
      out.set(BOM['utf-8']!);
      out.set(b, 3);
      return out;
    }
    case 'utf-16le':
      return encodeUtf16(body, false, hasBom);
    case 'utf-16be':
      return encodeUtf16(body, true, hasBom);
    case 'cp949':
      return encodeCp949(body);
  }
}
