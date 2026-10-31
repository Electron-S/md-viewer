// Claude Code 보고서 흐름(v2.1) 단위 테스트: 바뀐 곳, 위치 복사, 위치 인자, 코드 도구, 작업 공간 다시 읽기.
import { dom } from './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockLine, diffLines, markChangedBlocks, stepChange, type LineRange } from '../src/changes';
import { formatLocation, locationText, previewSelectionLines } from '../src/locref';
import { DocStore, type HostDoc } from '../src/docs';
import { parseAt } from '../src/bridge/server';
import { createMarkdown, renderMarkdown } from '../src/render/markdown';
import { addCodeTools, chunkBlocks } from '../src/views/preview';
import { WorkspacePanel } from '../src/panels/workspace';
import type { Bridge } from '../src/bridge';

void dom;

const lines = (n: number, f = (i: number) => `줄 ${i}`) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

test('줄 diff: 같음·바꿈·넣음·지움, 붙은 범위 합치기 (FR-WATCH-05)', () => {
  const base = lines(10);
  assert.deepEqual(diffLines(base, base), []);
  const changed = base.replace('줄 3', '줄 3 고침');
  assert.deepEqual(diffLines(base, changed), [{ start: 3, end: 4 }]);
  const inserted = base.replace('줄 5', '줄 5\n새 줄 a\n새 줄 b');
  assert.deepEqual(diffLines(base, inserted), [{ start: 6, end: 8 }]);
  const removed = base.replace('줄 2\n줄 3\n', '');
  assert.deepEqual(diffLines(base, removed), [{ start: 2, end: 2 }], '지운 곳은 지운 자리 뒤 줄을 가리키는 빈 범위');
  // 떨어진 두 곳과 붙은 바꿈+넣음
  const two = base.replace('줄 1', '하나').replace('줄 8', '여덟\n여덟 반');
  assert.deepEqual(diffLines(base, two), [{ start: 1, end: 2 }, { start: 8, end: 10 }]);
  // 앞뒤 공통이 없는 경우와 문서 끝에서 지운 경우
  assert.deepEqual(diffLines('a\nb', 'x\ny\nz'), [{ start: 0, end: 3 }]);
  assert.deepEqual(diffLines('a\nb\nc', 'a'), [{ start: 1, end: 1 }]);
  // 가운데 줄이 같은 두 덩어리: 공통 줄은 바뀐 곳이 아니다
  assert.deepEqual(diffLines('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE'), [{ start: 0, end: 1 }, { start: 4, end: 5 }]);
});

test('줄 diff: 편집 거리가 상한을 넘으면 가운데를 한 덩어리로 본다 (FR-WATCH-05)', () => {
  const n = 3000;
  const a = lines(n);
  const b = lines(n, (i) => (i % 2 ? `바뀐 ${i}` : `줄 ${i}`));
  const r = diffLines(a, b);
  assert.deepEqual(r, [{ start: 1, end: n }], '앞쪽 공통 한 줄 뒤 전체');
});

test('바뀐 곳 이동: 차례대로 돌고, 처음에는 지금 줄에서 가까운 것부터 (FR-WATCH-05)', () => {
  const r: LineRange[] = [{ start: 2, end: 3 }, { start: 10, end: 10 }, { start: 20, end: 25 }];
  assert.equal(stepChange(r, null, 0, 1), 0);
  assert.equal(stepChange(r, null, 11.4, 1), 2);
  assert.equal(stepChange(r, null, 30, 1), 0, '뒤에 없으면 처음으로');
  assert.equal(stepChange(r, null, 11.4, -1), 1);
  assert.equal(stepChange(r, null, 1, -1), 2, '앞에 없으면 마지막으로');
  assert.equal(stepChange(r, 2, 0, 1), 0, '차례대로 돌 때는 줄을 보지 않는다');
  assert.equal(stepChange(r, 0, 0, -1), 2);
  assert.equal(stepChange([], null, 0, 1), -1);
});

function rendered(md: string): DocumentFragment {
  const html = renderMarkdown(createMarkdown(), md).html;
  const t = document.createElement('template');
  t.innerHTML = html;
  return chunkBlocks(t.content);
}

test('바뀐 블록 표시: 블록·목록 항목·코드 펜스, 지운 자리 (FR-WATCH-05)', () => {
  const md = ['# 제목', '', '문단 하나', '', '- 항목 1', '- 항목 2', '- 항목 3', '', '```js', 'let a = 1;', '```', '', '끝 문단'].join('\n');
  const frag = rendered(md);
  const pre = frag.querySelector('pre')!;
  assert.equal(blockLine(pre), 8, '코드 펜스는 안쪽 code의 줄을 쓴다');
  const n = markChangedBlocks(frag, [{ start: 5, end: 6 }, { start: 9, end: 10 }, { start: 12, end: 12 }]);
  const marked = (sel: string) => Array.from(frag.querySelectorAll(sel)).map((e) => e.textContent!.trim().split('\n')[0]);
  assert.deepEqual(marked('.mdv-changed'), ['항목 2', 'let a = 1;'], '목록은 바뀐 항목만');
  assert.deepEqual(marked('.mdv-deleted-before'), ['끝 문단']);
  assert.equal(n, 3);
  assert.equal(frag.querySelectorAll('[style]').length, 0, 'style 속성을 쓰지 않는다 (NFR-SEC-01)');
});

test('문서 저장소: 밖에서 다시 읽으면 바뀐 곳을 남기고, 고치면 지운다 (FR-WATCH-05)', () => {
  const docs = new DocStore();
  const h = (text: string): HostDoc => ({
    path: '/d/a.md', text, encoding: 'utf-8', hasBom: false, eol: 'LF', eolCounts: { crlf: 0, lf: 1, cr: 0 }, size: text.length, mtime: 1,
    decodeWarning: false, kind: 'markdown', binary: false,
  });
  const first = docs.upsert(h('a\nb\nc'));
  assert.equal(first.changes, undefined, '처음 읽을 때는 없다');
  const plain = docs.upsert(h('a\nB\nc'));
  assert.equal(plain.changes, undefined, '추적하지 않은 다시 읽기(인코딩 바꾸기 등)는 남기지 않는다');
  const tracked = docs.upsert(h('a\nB\nc\nd'), false, true);
  assert.deepEqual(tracked.changes, [{ start: 3, end: 4 }]);
  const edited = docs.applyEdit(tracked.id, 'a\nB\nc\nd\ne')!;
  assert.equal(edited.changes, undefined, '고치기 시작하면 지운다');
});

test('위치 문자열: 경로:줄, 인용 줄 수·길이 제한 (FR-INFO-04)', () => {
  assert.equal(formatLocation('/d/a.md', 4, 4), '/d/a.md:5');
  assert.equal(formatLocation('/d/a.md', 4, 9), '/d/a.md:5-10');
  assert.equal(locationText('/d/a.md', 0, 0, ''), '/d/a.md:1');
  assert.equal(locationText('/d/a.md', 0, 2, '\n첫 줄\n\n셋째 줄\n'), '/d/a.md:1-3\n> 첫 줄\n>\n> 셋째 줄');
  const long = locationText('C:\\d\\a.md', 0, 9, lines(10) + '\n' + 'x'.repeat(300));
  const out = long.split('\n');
  assert.equal(out[0], 'C:\\d\\a.md:1-10');
  assert.equal(out.length, 1 + 6 + 1, '인용은 여섯 줄과 줄임표');
  assert.equal(out.at(-1), '> …');
  assert.ok(locationText('/a', 0, 0, 'y'.repeat(300)).endsWith('y…'), '긴 줄은 자른다');
});

test('위치 복사: 미리보기에서 고른 범위를 원문 줄로 바꾼다 (FR-INFO-04)', () => {
  const md = ['# 제목', '', '첫 문단', '둘째 줄', '', '- 항목 1', '- 항목 2', '', '```', 'code', '```', '', '끝'].join('\n');
  const article = document.createElement('article');
  article.append(rendered(md));
  document.body.append(article);
  const src = md.split('\n');
  const range = document.createRange();
  const p = article.querySelector('p')!;
  range.selectNodeContents(p);
  assert.deepEqual(previewSelectionLines(article, range, src), { start: 2, end: 3 }, '문단 전체');
  const li2 = article.querySelectorAll('li')[1];
  range.setStart(p.firstChild!, 1);
  range.setEnd(li2.firstChild!, 2);
  assert.deepEqual(previewSelectionLines(article, range, src), { start: 2, end: 6 }, '문단부터 둘째 항목까지');
  // 세 번 눌러 고르면 끝이 다음 블록 처음(오프셋 0)에 걸린다. 다음 블록은 넣지 않는다.
  range.setStart(p.firstChild!, 0);
  range.setEnd(article.querySelector('ul')!, 0);
  assert.deepEqual(previewSelectionLines(article, range, src), { start: 2, end: 3 });
  const code = article.querySelector('pre code')!;
  range.selectNodeContents(code);
  assert.deepEqual(previewSelectionLines(article, range, src), { start: 8, end: 10 }, '코드 펜스는 펜스 줄까지');
  article.remove();
});

test('뷰어 주소의 위치 인자 at: L줄·#조각 (FR-LAUNCH-06)', () => {
  assert.deepEqual(parseAt('L120'), { line: 119 });
  assert.deepEqual(parseAt('L0'), { line: 0 });
  assert.deepEqual(parseAt('#3.2 결과'), { fragment: '3.2 결과' });
  assert.deepEqual(parseAt(''), {});
  assert.deepEqual(parseAt(undefined), {});
  assert.deepEqual(parseAt('#'), {});
  assert.deepEqual(parseAt('x'), {});
});

test('코드 블록 도구: 언어 이름과 복사 버튼, 다이어그램·원문 대체 블록은 뺀다 (FR-REN-09)', () => {
  const frag = rendered(['```python', 'print(1)', '```', '', '```', 'plain', '```', '', '```mermaid', 'flowchart LR', '```'].join('\n'));
  addCodeTools(frag, { copy: '복사', copyTitle: '코드 복사' });
  const tools = Array.from(frag.querySelectorAll('.mdv-code-tools'));
  assert.equal(tools.length, 2, 'mermaid 펜스에는 달지 않는다');
  assert.equal(tools[0].querySelector('.mdv-code-lang')?.getAttribute('data-label'), 'python');
  assert.equal(tools[1].querySelector('.mdv-code-lang'), null, '언어가 없으면 이름을 달지 않는다');
  assert.equal(tools[0].textContent, '', '글자가 없어 찾기·복사에 섞이지 않는다');
  assert.equal(blockLine(frag.querySelector('pre')!), 0, '도구를 달아도 펜스 줄을 읽는다');
});

test('작업 공간: 다시 읽으면 펼친 폴더를 지키고, 바뀐 것이 없으면 그리지 않는다 (FR-WATCH-04)', async () => {
  const tree: Record<string, { name: string; isDir: boolean }[]> = {
    '/w': [{ name: 'sub', isDir: true }, { name: 'a.md', isDir: false }],
    '/w/sub': [{ name: 'x.md', isDir: false }],
  };
  let calls = 0;
  const bridge = {
    displayPath: (p: string) => p,
    request: async (method: string, p: { path: string }) => {
      assert.equal(method, 'dir.list');
      calls++;
      if (!tree[p.path]) throw new Error('없음');
      return { entries: tree[p.path] };
    },
  } as unknown as Bridge;
  const ws = new WorkspacePanel(bridge);
  document.body.append(ws.el);
  ws.setRoot('/w');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  await tick();
  const items = () => Array.from(ws.el.querySelectorAll('.ws-item')).map((e) => e.textContent);
  assert.deepEqual(items(), ['▸ sub', 'a.md']);
  (ws.el.querySelector('.ws-dir') as HTMLElement).click();
  await tick();
  assert.deepEqual(items(), ['▾ sub', 'x.md', 'a.md']);
  const before = ws.el.querySelector('.ws-file');
  await ws.refresh();
  assert.equal(ws.el.querySelector('.ws-file'), before, '목록이 같으면 다시 그리지 않는다');
  tree['/w/sub'] = [{ name: 'new.md', isDir: false }, { name: 'x.md', isDir: false }];
  tree['/w'] = [...tree['/w'], { name: 'b.md', isDir: false }];
  calls = 0;
  await ws.refresh();
  assert.equal(calls, 2, '루트와 펼친 폴더만 다시 읽는다');
  assert.deepEqual(items(), ['▾ sub', 'new.md', 'x.md', 'a.md', 'b.md'], '새 파일이 보이고 펼친 폴더는 그대로');
  delete tree['/w/sub'];
  tree['/w'] = [{ name: 'a.md', isDir: false }];
  await ws.refresh();
  assert.deepEqual(items(), ['a.md'], '지워진 폴더는 사라진다');
  ws.el.remove();
});
