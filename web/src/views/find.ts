import { S } from '../strings';

export interface FindQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindStatus {
  count: number;
  /** 0부터. 일치가 없으면 -1 */
  index: number;
  error?: string;
}

export const MAX_MATCHES = 10_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 찾기 조건을 정규식으로 바꾼다. 정규식 문법이 틀리면 error를 돌려준다. */
export function buildRegex(q: FindQuery): { re: RegExp | null; error?: string } {
  if (!q.text) return { re: null };
  let src = q.regex ? q.text : escapeRegExp(q.text);
  if (q.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return { re: new RegExp(src, 'gu' + (q.caseSensitive ? '' : 'i')) };
  } catch (err) {
    return { re: null, error: S.find.regexError };
  }
}

/** 문자열 안의 일치 구간. 빈 일치는 건너뛴다. */
export function findRanges(text: string, re: RegExp, limit = MAX_MATCHES): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
