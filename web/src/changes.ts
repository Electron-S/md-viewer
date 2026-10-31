// 밖에서 바뀌어 다시 읽은 문서의 바뀐 곳 (FR-WATCH-05, SDD 4장).
// 이전 본문과 새 본문을 줄 단위로 비교해 새 본문에서 바뀐 줄 범위를 낸다. 미리보기는 그 범위가 걸친 블록에, 원문 보기는 그 줄에 표시한다.

/** 새 본문의 줄 범위 [start, end), 0부터. 줄만 지운 곳은 start === end이고, 지운 자리 바로 뒤 줄을 가리킨다. */
export interface LineRange {
  start: number;
  end: number;
}

/** 편집 거리 상한. 넘으면 앞뒤 공통 부분을 뺀 가운데 전체를 바뀐 곳 하나로 본다(큰 문서를 통째로 바꾼 경우). */
const MAX_EDITS = 1000;

/** 두 본문(LF)의 바뀐 줄 범위. 같으면 빈 배열. */
export function diffLines(oldText: string, newText: string): LineRange[] {
  if (oldText === newText) return [];
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const whole = [{ start: pre, end: pre + B.length }];
  if (!A.length || !B.length) return whole;
  const common = commonLines(A, B, MAX_EDITS);
  if (!common) return whole;
  const out: LineRange[] = [];
  let ai = 0;
  let bi = 0;
  for (const [x, y] of [...common, [A.length, B.length] as const]) {
    // A[ai..x)는 지웠고 B[bi..y)는 넣었다. 둘 중 하나라도 있으면 B 쪽 자리 [bi, y)가 바뀐 곳이다.
    if (x > ai || y > bi) push(out, pre + bi, pre + y);
    ai = x + 1;
    bi = y + 1;
  }
  return out;
}

/** 붙어 있거나 겹치는 범위는 하나로 합친다. */
function push(out: LineRange[], start: number, end: number) {
  const last = out[out.length - 1];
  if (last && start <= last.end) last.end = Math.max(last.end, end);
  else out.push({ start, end });
}

/**
 * Myers의 O(ND) 차이 알고리즘으로 두 줄 목록의 공통 줄 짝 [a의 번호, b의 번호]를 순서대로 낸다.
 * 편집 거리가 max를 넘으면 null.
 */
function commonLines(a: string[], b: string[], max: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const off = max + 1;
  const v = new Int32Array(2 * off + 1);
  // trace[d]: d번째 단계를 시작하기 전의 v. 되짚을 때 쓴다.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, off, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], off: number, n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  return pairs.reverse();
}

/**
 * 다음(1)·이전(-1) 바뀐 곳의 번호. 바로 전에 옮겨 간 번호(current)가 있으면 그다음으로 차례대로 돌고,
 * 없으면 지금 보는 줄(line)에서 가장 가까운 앞·뒤 바뀐 곳부터 시작한다.
 */
export function stepChange(ranges: readonly LineRange[], current: number | null, line: number, dir: 1 | -1): number {
  const n = ranges.length;
  if (!n) return -1;
  if (current != null && current >= 0 && current < n) return (current + dir + n) % n;
  const at = Math.floor(line);
  if (dir === 1) {
    const i = ranges.findIndex((r) => Math.max(r.start, r.end - 1) >= at);
    return i < 0 ? 0 : i;
  }
  for (let i = n - 1; i >= 0; i--) if (ranges[i].start <= at) return i;
  return n - 1;
}

/** 바뀐 블록에 붙이는 클래스. 줄을 지우기만 한 곳은 그 뒤 블록에 다른 클래스를 붙인다. */
export const CHANGED_CLASS = 'mdv-changed';
export const DELETED_CLASS = 'mdv-deleted-before';

/** 블록의 원문 시작 줄. 코드 펜스는 `pre`가 아니라 안쪽 `code`가 줄을 갖는다 (SDD 8.2). */
export function blockLine(el: Element): number | null {
  const own = el.getAttribute('data-line') ?? (el.tagName === 'PRE' ? el.querySelector(':scope > code')?.getAttribute('data-line') : null);
  if (own == null) return null;
  const n = Number(own);
  return Number.isFinite(n) ? n : null;
}

/**
 * 미리보기에서 표시 단위가 되는 블록과 시작 줄을 문서 순서대로 낸다. 최상위 블록(묶음 .mdv-chunk 안 포함)을 쓰되,
 * 목록은 항목(li)마다 따로 표시해 긴 목록 전체가 칠해지지 않게 한다.
 */
export function markTargets(root: ParentNode): { el: Element; line: number }[] {
  const out: { el: Element; line: number }[] = [];
  const visit = (el: Element) => {
    if (el.classList.contains('mdv-chunk')) {
      for (const c of Array.from(el.children)) visit(c);
      return;
    }
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      const items = Array.from(el.children).filter((c) => c.tagName === 'LI' && blockLine(c) != null);
      if (items.length) {
        for (const li of items) out.push({ el: li, line: blockLine(li)! });
        return;
      }
    }
    const line = blockLine(el);
    if (line != null) out.push({ el, line });
  };
  for (const c of Array.from(root.children ?? [])) visit(c);
  return out;
}

/** 바뀐 범위가 걸친 블록에 클래스를 붙인다. 표시한 블록 수를 돌려준다. */
export function markChangedBlocks(root: ParentNode, ranges: readonly LineRange[]): number {
  const targets = markTargets(root);
  let marked = 0;
  for (let i = 0; i < targets.length; i++) {
    const start = targets[i].line;
    const end = i + 1 < targets.length ? targets[i + 1].line : Infinity;
    let changed = false;
    let deleted = false;
    for (const r of ranges) {
      if (r.end > r.start) {
        if (r.start < end && r.end > start) changed = true;
      } else if (r.start >= start && r.start < end) {
        deleted = true;
      }
    }
    if (changed) targets[i].el.classList.add(CHANGED_CLASS);
    else if (deleted) targets[i].el.classList.add(DELETED_CLASS);
    if (changed || deleted) marked++;
  }
  return marked;
}
