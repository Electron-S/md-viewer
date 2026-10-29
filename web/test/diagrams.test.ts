import { dom } from './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DiagramRenderer, gunzipBase64, summarize } from '../src/render/diagrams';
import { createMarkdown, renderMarkdown } from '../src/render/markdown';
import { createSanitizer } from '../src/render/sanitize';

const sanitizer = createSanitizer(dom.window as unknown as Window);

/** mermaid 대신 쓰는 가짜. render는 원문을 text에 담은 svg를 돌려주고, fail에 맞는 원문은 구문 오류를 던진다. */
function fakeMermaid(fail?: RegExp) {
  const calls: { id: string; source: string; theme: string }[] = [];
  let theme = '';
  let gate: Promise<void> = Promise.resolve();
  const m = {
    initialize(c: { theme: string }) {
      theme = c.theme;
    },
    async render(id: string, source: string) {
      await gate;
      calls.push({ id, source, theme });
      // 실제 mermaid는 무대 iframe에서 돌아 이 창의 Error가 아닌 오류를 던진다(instanceof Error가 거짓, 글자로 바꾸면 "Error: …").
      if (fail?.test(source)) {
        const message = 'Parse error on line 1:\nbad\n---^\nExpecting X, got Y';
        throw { message, toString: () => `Error: ${message}` };
      }
      return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><style>#${id} {fill: red}</style><text>${source}</text></svg>` };
    },
  };
  return { m, calls, hold: (p: Promise<void>) => (gate = p) };
}

function setup(load: () => Promise<unknown>) {
  const events: string[] = [];
  // 실제로는 격리된 iframe의 body다. 시험에서는 문서의 div로 대신한다.
  const stage = document.createElement('div');
  stage.className = 'mdv-mermaid-stage';
  document.body.append(stage);
  const r = new DiagramRenderer({
    clean: (svg, id) => sanitizer.sanitizeDiagram(svg, id),
    width: () => 800,
    onFailed: (line, msg) => events.push(`fail ${line} ${msg}`),
    onLoadFailed: (msg) => events.push(`load ${msg}`),
    onIdle: () => events.push('idle'),
    load: async () => ({ mermaid: (await load()) as never, stage }),
  });
  return { r, events, stage };
}

function doc(src: string): HTMLElement {
  const div = document.createElement('div');
  div.append(sanitizer.sanitize(renderMarkdown(createMarkdown(), src).html, { docDir: '/d', allowRemoteImages: false, imageUrl: () => null }));
  return div;
}

test('압축한 번들 풀기: 빌드가 만든 gzip·base64를 원문 그대로 되돌린다 (FR-REN-07)', async () => {
  const text = 'window.__x = "한글 ✓ 😀";\n'.repeat(1000);
  const back = await gunzipBase64(gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64'));
  assert.equal(back, text);
  // 화면은 이 글자를 인라인 스크립트로 붙이고, 브라우저는 그 UTF-8 해시를 CSP와 맞춘다.
  const h = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');
  assert.equal(h(back), h(text));
});

test('다이어그램 상자를 정제한 SVG로 바꾸고, 실패한 것은 원문과 오류 안내로 바꾼다 (FR-REN-07, FR-REN-04)', async () => {
  const { m, calls } = fakeMermaid(/bad/);
  const { r, events, stage } = setup(async () => m);
  const root = doc('```mermaid\ngraph A\n```\n\n```mermaid\nbad\n```\n');
  await r.renderPending(root);
  const svg = root.querySelector('div.mdv-mermaid[data-line="0"] > svg');
  assert.ok(svg);
  assert.equal(svg.querySelector('text')?.textContent, 'graph A\n');
  const err = root.querySelector('div.mdv-block-error[data-line="4"]')!;
  assert.equal(err.querySelector('p.mdv-render-error')?.textContent, '이 다이어그램을 그리지 못해 원문을 표시합니다: Parse error on line 1: Expecting X, got Y');
  assert.equal(err.querySelector('pre.mdv-plain')?.textContent, 'bad\n');
  assert.equal(root.querySelector('.mdv-mermaid > pre'), null);
  assert.deepEqual(events, ['fail 4 Parse error on line 1: Expecting X, got Y', 'idle']);
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map((c) => c.id)).size, 2, 'id는 그릴 때마다 새로');
  assert.equal(stage.childElementCount, 0, '그린 뒤 무대는 비운다');
  assert.equal(stage.style.width, '800px', '무대 폭은 미리보기 본문 폭');
});

test('같은 테마·원문은 캐시에서 바로 끼우고, 테마가 바뀌면 다시 그린다 (FR-REN-07)', async () => {
  const { m, calls } = fakeMermaid();
  const { r } = setup(async () => m);
  const src = '```mermaid\ngraph A\n```\n';
  await r.renderPending(doc(src));
  const again = doc(src);
  r.applyCached(again);
  assert.ok(again.querySelector('.mdv-mermaid > svg'), '그리기를 기다리지 않는다');
  assert.equal(calls.length, 1);
  r.setDark(true);
  const dark = doc(src);
  r.applyCached(dark);
  assert.ok(dark.querySelector('.mdv-mermaid > pre'), '다른 테마는 캐시에 없다');
  await r.renderPending(dark);
  assert.deepEqual(calls.map((c) => c.theme), ['default', 'dark']);
});

test('그리는 동안 문서가 바뀌면 끼우지 않고 캐시에만 남긴다 (FR-REN-07)', async () => {
  const { m, calls, hold } = fakeMermaid();
  let release!: () => void;
  hold(new Promise<void>((res) => (release = res)));
  const { r } = setup(async () => m);
  const root = doc('```mermaid\na\n```\n');
  const old = root.firstElementChild!;
  const done = r.renderPending(root);
  root.replaceChildren(...Array.from(doc('본문').childNodes));
  release();
  await done;
  assert.ok(old.querySelector('pre'), '떨어진 상자는 그대로 둔다');
  assert.equal(calls.length, 1);
  const next = doc('```mermaid\na\n```\n');
  r.applyCached(next);
  assert.ok(next.querySelector('.mdv-mermaid > svg'));
});

test('라이브러리를 불러오지 못하면 원문 코드를 두고 한 번만 알린다 (FR-REN-07)', async () => {
  let loads = 0;
  const { r, events } = setup(async () => {
    loads++;
    throw new Error('없음');
  });
  const root = doc('```mermaid\na\n```\n\n```mermaid\nb\n```\n');
  await r.renderPending(root);
  await r.renderPending(root);
  assert.equal(loads, 1);
  assert.equal(root.querySelectorAll('.mdv-mermaid > pre').length, 2);
  assert.deepEqual(events, ['load 없음', 'idle']);
});

test('mermaid 오류 문구는 첫 줄과 마지막 줄만 쓴다', () => {
  assert.equal(summarize('Parse error on line 2:\nflowchart A-->\n-----^\nExpecting X, got EOF'), 'Parse error on line 2: Expecting X, got EOF');
  assert.equal(summarize('No diagram type detected'), 'No diagram type detected');
  assert.equal(summarize(''), '');
});
