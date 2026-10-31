// 위치 복사 (FR-INFO-04, SDD 4장): 고른 부분을 Claude Code 대화에 붙여 넣을 '경로:줄' 한 줄과 인용문으로 만든다.

/** 인용에 넣는 최대 줄 수와 줄마다 최대 글자 수. 위치가 주인공이고 인용은 어디인지 알아보는 데만 쓴다. */
const QUOTE_LINES = 6;
const QUOTE_CHARS = 200;

/** 0부터 센 줄 범위 [start, end](끝 포함)를 1부터 세는 `경로:줄`·`경로:시작-끝`으로 */
export function formatLocation(path: string, start: number, end: number): string {
  const a = start + 1;
  const b = Math.max(start, end) + 1;
  return a === b ? `${path}:${a}` : `${path}:${a}-${b}`;
}

/** 위치 한 줄과 `> ` 인용. 인용할 글이 없으면 위치만 낸다. */
export function locationText(path: string, start: number, end: number, quote: string): string {
  const head = formatLocation(path, start, end);
  const lines = quote.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return head;
  const shown = lines.slice(0, QUOTE_LINES).map((l) => (l.length > QUOTE_CHARS ? `${l.slice(0, QUOTE_CHARS)}…` : l));
  if (lines.length > QUOTE_LINES) shown.push('…');
  return [head, ...shown.map((l) => (l ? `> ${l}` : '>'))].join('\n');
}

function lineAttr(el: Element): number | null {
  const n = Number(el.getAttribute('data-line'));
  return el.hasAttribute('data-line') && Number.isFinite(n) ? n : null;
}

/** 노드를 감싸는 가장 가까운 줄 정보 요소 */
function lineElement(node: Node, article: Element): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const hit = el?.closest('[data-line]') ?? null;
  return hit && article.contains(hit) ? hit : null;
}

/** 범위 안에서 공백이 아닌 글자를 가진 첫·마지막 글 노드. 문단을 세 번 눌러 고르면 범위 끝이 다음 블록 처음에 걸리므로 글 기준으로 잡는다. */
function textEnds(range: Range): [Node, Node] | null {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return (root.textContent ?? '').trim() ? [root, root] : null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: Node | null = null;
  let last: Node | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) {
      if (first) break;
      continue;
    }
    let text = n.textContent ?? '';
    if (n === range.startContainer) text = text.slice(range.startOffset);
    if (n === range.endContainer) text = text.slice(0, range.endOffset - (n === range.startContainer ? range.startOffset : 0));
    if (!text.trim()) continue;
    first ??= n;
    last = n;
  }
  return first && last ? [first, last] : null;
}

/**
 * 미리보기에서 고른 범위를 원문 줄 범위 [시작, 끝](0부터, 끝 포함)으로 바꾼다. 양 끝 글을 감싸는 블록의 data-line을 쓰고,
 * 끝 블록은 그 뒤 블록 앞까지(빈 줄 제외)로 본다. 줄 정보를 찾지 못하면 null.
 */
export function previewSelectionLines(article: Element, range: Range, lines: string[]): { start: number; end: number } | null {
  const ends = textEnds(range);
  if (!ends) return null;
  const startEl = lineElement(ends[0], article);
  const endEl = lineElement(ends[1], article);
  if (!startEl || !endEl) return null;
  const start = lineAttr(startEl)!;
  const endStart = lineAttr(endEl)!;
  // 끝 블록 뒤에 오는(그 안에 들지 않은) 첫 줄 정보 요소가 끝 블록의 끝을 정한다.
  let next: number | null = null;
  const all = Array.from(article.querySelectorAll('[data-line]'));
  for (let i = all.indexOf(endEl) + 1; i < all.length; i++) {
    if (endEl.contains(all[i])) continue;
    const n = lineAttr(all[i]);
    if (n != null && n > endStart) {
      next = n;
      break;
    }
  }
  let end = next != null ? next - 1 : lines.length - 1;
  while (end > endStart && !(lines[end] ?? '').trim()) end--;
  return { start: Math.min(start, endStart), end: Math.max(start, endStart, end) };
}
