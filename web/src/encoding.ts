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

export function detectEol(text: string): Eol {
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
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
  if (kinds === 0) return 'None';
  if (kinds > 1) return 'Mixed';
  return crlf ? 'CRLF' : lf ? 'LF' : 'CR';
}
