import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import hljs from 'highlight.js/lib/common';
import { createMarkdown, renderMarkdown, scanHeadings } from '../src/render/markdown';
import { Slugger } from '../src/render/slug';

test('CommonMark 0.31.2 스펙 예제 전체 일치 (FR-REN-01)', () => {
  const spec: { markdown: string; html: string; example: number; section: string }[] = JSON.parse(
    readFileSync('tests/samples/commonmark-spec.json', 'utf8'),
  );
  const md = createMarkdown({ sourceMap: false, extensions: false, highlight: false });
  // 공식 spec_tests.py처럼 <pre> 밖의 태그 사이 공백 차이는 무시한다.
  const norm = (html: string) =>
    html.split(/(<pre[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part.replace(/>\s+</g, '><').trim())).join('');
  const failed = spec.filter((ex) => norm(md.render(ex.markdown)) !== norm(ex.html)).map((ex) => `${ex.example}(${ex.section})`);
  assert.equal(spec.length, 652);
  assert.deepEqual(failed, [], `불일치 예제: ${failed.join(', ')}`);
});

test('GFM: 표, 작업 목록, 취소선, 자동 링크 (FR-REN-01)', () => {
  const md = createMarkdown();
  const { html } = renderMarkdown(
    md,
    '| a | b |\n| - | :-: |\n| 1 | 2 |\n\n- [x] 완료\n- [ ] 할 일\n\n~~지움~~\n\nwww.example.com 과 https://example.org\n',
  );
  assert.match(html, /<table data-line="0">/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td align="center">2<\/td>/);
  assert.match(html, /<input class="task-list-item-checkbox" checked="" disabled="" type="checkbox">/);
  assert.match(html, /<del>지움<\/del>/);
  assert.match(html, /<a href="http:\/\/www\.example\.com">www\.example\.com<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.org">/);
  assert.doesNotMatch(renderMarkdown(md, 'README.md 파일').html, /<a /, '파일 이름은 링크가 아니다');
  assert.match(renderMarkdown(md, '(www.example.com/a_(b))!').html, /href="http:\/\/www\.example\.com\/a_\(b\)"/);
});

test('각주와 제목 앵커 (FR-REN-05)', () => {
  const { html } = renderMarkdown(createMarkdown(), '본문[^1]\n\n[^1]: 각주 내용\n');
  assert.match(html, /class="footnote-ref"/);
  assert.match(html, /각주 내용/);
});

test('소스 맵: 블록마다 원문 시작 줄 (ARCH-03)', () => {
  const { html } = renderMarkdown(createMarkdown(), '# 제목\n\n문단\n\n- 하나\n- 둘\n\n```js\nlet a = 1\n```\n');
  assert.match(html, /<h1 id="제목" data-line="0">/);
  assert.match(html, /<p data-line="2">문단<\/p>/);
  assert.match(html, /<ul data-line="4">/);
  assert.match(html, /<li data-line="5">둘<\/li>/);
  assert.match(html, /<code data-line="7" class="language-js">/);
});

test('제목 id: 한글 유지, 문장부호 제거, 중복 번호 (FR-NAV-01)', () => {
  const { headings } = renderMarkdown(createMarkdown(), '# 한글 제목!\n## 한글 제목\n### `코드` 와 **굵게**\n#### Hello, World?\n');
  assert.deepEqual(
    headings.map((h) => [h.level, h.id, h.line]),
    [
      [1, '한글-제목', 0],
      [2, '한글-제목-1', 1],
      [3, '코드-와-굵게', 2],
      [4, 'hello-world', 3],
    ],
  );
});

test('코드 강조: 알려진 언어만, 모르는 언어는 그대로 (FR-REN-02)', () => {
  const md = createMarkdown();
  assert.match(renderMarkdown(md, '```js\nconst x = 1;\n```').html, /hljs-keyword/);
  const unknown = renderMarkdown(md, '```nosuchlang\n<b>x</b>\n```').html;
  assert.match(unknown, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('큰 문서용 목차 스캔은 펜스 안 #을 건너뛴다', () => {
  const h = scanHeadings('# 하나\n```\n# 코드 안\n```\n## 둘 ##\n');
  assert.deepEqual(h.map((x) => [x.level, x.text, x.line]), [[1, '하나', 0], [2, '둘', 4]]);
});

test('비정상 입력에서도 멈추지 않는다 (NFR-REL-01)', () => {
  const md = createMarkdown();
  const cases = {
    deepQuote: '>'.repeat(5000) + ' x',
    deepList: Array.from({ length: 2000 }, (_, i) => ' '.repeat(i * 2) + '- a').join('\n'),
    brackets: '['.repeat(20000),
    hugeTable: '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(10000),
    longLine: 'x'.repeat(100_000),
    emphasis: '*a **'.repeat(5000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now();
    assert.doesNotThrow(() => renderMarkdown(md, text), name);
    assert.ok(performance.now() - t0 < 5000, `${name} 5초 초과`);
  }
});

test('블록마다 따로 그려도 md.render와 결과가 같다 (FR-REN-04, ARCH-03)', () => {
  const spec: { markdown: string; example: number }[] = JSON.parse(readFileSync('tests/samples/commonmark-spec.json', 'utf8'));
  const plain = createMarkdown({ sourceMap: false, extensions: false, highlight: false });
  const full = createMarkdown();
  const extra = [
    '| a | b |\n| - | :-: |\n| 1 | 2 |\n\n- [x] 완료\n- [ ] 할 일\n\n~~지움~~ www.example.com\n',
    '본문[^1] 과 [^n]\n\n[^1]: 각주\n\n    들여 쓴 줄\n\n[^n]: 둘째\n\n# 끝\n',
    '- 하나\n- 둘\n\n  셋\n\n> 인용\n> - 목록\n\n```js\nlet a = 1;\n```\n\n<div>\n\n*html*\n\n</div>\n',
  ];
  const plainDiff = spec.filter((ex) => renderMarkdown(plain, ex.markdown).html !== plain.render(ex.markdown)).map((ex) => ex.example);
  const fullDiff = [...spec.map((ex) => ex.markdown), ...extra].filter(
    (src) => renderMarkdown(full, src).html !== full.render(src, { slugger: new Slugger(), headings: [] }),
  );
  assert.deepEqual(plainDiff, []);
  assert.deepEqual(fullDiff, []);
});

test('실패한 블록만 원문과 오류 안내로 바꾸고 나머지는 그린다 (FR-REN-04)', () => {
  const md = createMarkdown();
  md.renderer.rules.table_open = () => {
    throw new Error('표 오류');
  };
  const out = renderMarkdown(md, '# 제목\n\n| a | b |\n| - | - |\n| <1> | 2 |\n\n문단\n');
  assert.match(out.html, /<h1 id="제목" data-line="0">제목<\/h1>/);
  assert.match(out.html, /<p data-line="6">문단<\/p>/);
  assert.match(
    out.html,
    /<div class="mdv-block-error" data-line="2"><p class="mdv-render-error">[^<]*표 오류<\/p><pre class="mdv-plain">\| a \| b \|\n\| - \| - \|\n\| &lt;1&gt; \| 2 \|<\/pre><\/div>/,
  );
  assert.doesNotMatch(out.html, /<table/);
  assert.deepEqual(out.errors, [{ line: 2, message: '표 오류' }]);
});

test('코드 강조가 실패한 블록도 원문과 오류 안내로 바꾼다 (FR-REN-04)', () => {
  const md = createMarkdown();
  const original = hljs.highlight;
  hljs.highlight = (() => {
    throw new Error('강조 오류');
  }) as typeof hljs.highlight;
  try {
    const out = renderMarkdown(md, '앞\n\n```js\nlet a = 1;\n```\n\n뒤\n');
    assert.match(out.html, /<p data-line="0">앞<\/p>/);
    assert.match(out.html, /<p data-line="6">뒤<\/p>/);
    assert.match(out.html, /<div class="mdv-block-error" data-line="2"><p class="mdv-render-error">[^<]*강조 오류<\/p><pre class="mdv-plain">```js\nlet a = 1;\n```<\/pre><\/div>/);
    assert.deepEqual(out.errors, [{ line: 2, message: '강조 오류' }]);
  } finally {
    hljs.highlight = original;
  }
});

test('GFM 스펙 확장 예제 전체 일치 (FR-REN-01)', () => {
  // cmark-gfm test/spec.txt의 표·작업 목록·취소선·자동 링크·태그 필터 예제.
  // 앱이 일부러 덧붙이는 것(제목 id, 작업 목록 class)은 비교에서 뺀다(릴리스 노트에 적음).
  const spec: { markdown: string; html: string; extension: string; line: number }[] = JSON.parse(
    readFileSync('tests/samples/gfm-extensions.json', 'utf8'),
  );
  const md = createMarkdown({ sourceMap: false, highlight: false });
  const norm = (html: string) =>
    html
      .replace(/ id="[^"]*"/g, '')
      .replace(/ class="(task-list-item|contains-task-list|task-list-item-checkbox)"/g, '')
      .split(/(<pre[\s\S]*?<\/pre>)/)
      .map((part, i) => (i % 2 ? part : part.replace(/>\s+</g, '><').trim()))
      .join('');
  const failed = spec.filter((ex) => norm(renderMarkdown(md, ex.markdown).html) !== norm(ex.html)).map((ex) => `${ex.extension}:${ex.line}`);
  assert.equal(spec.length, 24);
  assert.deepEqual(failed, []);
});
