import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { applyPageStrings, S } from '../src/strings';

// NFR-USE-02 합격 기준 "코드 안 UI 문자열 0건": 한글 문자열은 화면·실행기의 문자열 표 두 곳에만 둔다.
const TABLES = ['web/src/strings.ts', 'launcher/strings.ts'];
const HANGUL = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f).replace(/\\/g, '/');
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** TypeScript에서 주석을 뺀 코드. esbuild가 주석만 지우고 문자열·정규식 리터럴은 그대로 둔다. */
function tsCode(src: string): string {
  return transformSync(src, { loader: 'ts', minifyWhitespace: true, legalComments: 'none', charset: 'utf8' }).code;
}

function htmlText(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function codeOf(file: string): string {
  const src = readFileSync(file, 'utf8');
  if (file.endsWith('.ts')) return tsCode(src);
  return htmlText(src);
}

function hangulIn(file: string): string[] {
  const code = codeOf(file);
  return [...code.matchAll(HANGUL)].map((m) => `${file}: …${code.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 10)}…`);
}

test('UI 문자열은 문자열 표에만 있다 (NFR-USE-02)', () => {
  const files = [
    ...walk('web/src').filter((f) => f.endsWith('.ts')),
    'web/static/index.html',
    ...walk('launcher').filter((f) => f.endsWith('.ts') && !f.startsWith('launcher/test/')),
  ];
  for (const t of TABLES) assert.ok(files.includes(t), `${t} 이 없습니다`);
  const found = files.filter((f) => !TABLES.includes(f)).flatMap(hangulIn);
  assert.deepEqual(found, []);
  // 검사기가 실제로 한글을 찾는지: 표 파일에서는 찾아야 한다.
  for (const t of TABLES) assert.ok(hangulIn(t).length > 0, `${t} 에서 한글을 찾지 못함 (검사기 오류)`);
});

test('주석 제거기는 문자열 리터럴 안의 한글만 남긴다', () => {
  assert.doesNotMatch(tsCode('// 주석\n/** 문서 */ const a = 1;'), HANGUL);
  assert.match(tsCode('const a = `한글 ${1}`;'), HANGUL);
});

test('index.html의 data-s 키는 모두 표에 있고 시작할 때 채워진다 (NFR-USE-02)', () => {
  const doc = new JSDOM(readFileSync('web/static/index.html', 'utf8')).window.document;
  const keyed = Array.from(doc.querySelectorAll<HTMLElement>('[data-s]'));
  const titled = Array.from(doc.querySelectorAll<HTMLElement>('[data-s-title]'));
  assert.ok(keyed.length >= 6 && titled.length >= 1);
  applyPageStrings(doc);
  for (const el of keyed) assert.ok(el.textContent, `data-s="${el.dataset.s}" 가 비었습니다`);
  for (const el of titled) assert.ok(el.title, `data-s-title="${el.dataset.sTitle}" 가 비었습니다`);
  assert.equal(doc.querySelector('.side-tab[data-tab="toc"]')!.textContent, S.page.tocTab);
});
