import { dom } from './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, dirname, docKey, isInside, isInternalUrl, joinPath, normalizePath, pathStyle, resolveLocalUrl, resolvePath, splitRoot } from '../src/render/paths';
import { CommandRegistry, eventToKey } from '../src/commands';
import { parseSession, parseSettings, pushRecent, Debouncer } from '../src/session';
import { buildRegex, findRanges } from '../src/views/find';
import { TabManager } from '../src/tabs';
import { DocStore, countChars, countLines, countWords, encodingLabel, type HostDoc } from '../src/docs';
import { PreviewView } from '../src/views/preview';
import type { SourceView } from '../src/views/source';
import { ScrollSync } from '../src/views/sync';
import { MenuBar } from '../src/ui/menubar';

void dom;

test('경로: 드라이브·UNC·WSL 정규화와 상대 경로 해석', () => {
  assert.equal(normalizePath('c:/docs//a/../b/./x.md'), 'C:\\docs\\b\\x.md');
  assert.deepEqual(splitRoot('\\\\wsl.localhost\\Ubuntu\\home\\a.md'), { root: '\\\\wsl.localhost\\Ubuntu\\', rest: 'home\\a.md' });
  assert.equal(dirname('C:\\a.md'), 'C:\\');
  assert.equal(dirname('\\\\server\\share\\a.md'), '\\\\server\\share\\');
  assert.equal(resolvePath('C:\\docs\\guide', '../img/a.png'), 'C:\\docs\\img\\a.png');
  assert.equal(resolvePath('C:\\docs\\guide', '/root.md'), 'C:\\root.md');
  assert.equal(resolvePath('\\\\wsl.localhost\\Ubuntu\\home\\me', '../../etc/x.md'), '\\\\wsl.localhost\\Ubuntu\\etc\\x.md');
  assert.equal(docKey('C:\\Docs\\README.md'), docKey('c:/docs/readme.MD'));
  assert.deepEqual(resolveLocalUrl('sub/a%20b.md?x=1#%ED%95%9C', 'C:\\d'), { path: 'C:\\d\\sub\\a b.md', fragment: '한' });
  assert.equal(classifyUrl('file:///C:/x.md'), 'blocked');
  assert.equal(classifyUrl('C:/x.md'), 'local');
  assert.equal(classifyUrl('javascript:x'), 'blocked');
  assert.equal(classifyUrl('#a'), 'fragment');
  assert.equal(classifyUrl('HTTPS://x'), 'external');
  // 드라이브 루트·공유 루트를 폴더로 줄 때 (실행기의 허용 폴더가 D:\ 같은 경우)
  assert.ok(isInside('D:\\a\\b.md', 'D:\\'));
  assert.ok(isInside('d:\\A.md', 'D:\\'));
  assert.ok(isInside('\\\\Srv\\Share\\x.md', '\\\\srv\\share\\'));
  assert.ok(!isInside('E:\\a.md', 'D:\\'));
});

test('경로: POSIX(WSL·macOS·Linux)와 브라우저 핸들(mdv:) 위치 (SDD 5.2)', () => {
  assert.equal(pathStyle('/home/me/a.md'), 'posix');
  assert.equal(pathStyle('mdv:/d1/a.md'), 'mdv');
  assert.equal(pathStyle('docs/a.md'), null);
  assert.equal(normalizePath('/home//me/./docs/../a.md'), '/home/me/a.md');
  assert.equal(normalizePath('/../../etc'), '/etc', '루트 위로 올라가지 않는다');
  assert.equal(docKey('/Home/A.md') === docKey('/home/a.md'), false, 'POSIX는 대소문자를 구분한다');
  assert.equal(dirname('/a.md'), '/');
  assert.equal(dirname('mdv:/d1/guide/a.md'), 'mdv:/d1/guide');
  assert.equal(dirname('mdv:/f2/a.md'), 'mdv:/f2/');
  assert.equal(normalizePath('mdv:/d1/guide/../../../x.md'), 'mdv:/d1/x.md', 'mdv 루트 위로 올라가지 않는다');
  assert.equal(joinPath('mdv:/d1/', 'a.md'), 'mdv:/d1/a.md');
  assert.equal(joinPath('/home/me', 'b'), '/home/me/b');
  assert.equal(joinPath('C:\\', 'x.md'), 'C:\\x.md');
  assert.equal(resolvePath('/home/me/repo/docs', '../img/a.png'), '/home/me/repo/img/a.png');
  assert.equal(resolvePath('/home/me/repo/docs', '/img/a.png', '/home/me/repo'), '/home/me/repo/img/a.png', '/x는 루트 기준');
  assert.equal(resolvePath('/home/me/repo/docs', '/img/a.png'), '/img/a.png', '루트를 모르면 파일 시스템 루트');
  assert.equal(resolvePath('mdv:/d1/guide', '/img/a.png'), 'mdv:/d1/img/a.png');
  assert.equal(resolveLocalUrl('C:/x.png', '/home/me'), null, '다른 형식의 위치는 열지 않는다');
  assert.deepEqual(resolveLocalUrl('../b.md#x', 'mdv:/d3/sub'), { path: 'mdv:/d3/b.md', fragment: 'x' });
  assert.ok(isInside('/home/me/repo/a.md', '/home/me/repo'));
  assert.ok(!isInside('/home/me/repo2/a.md', '/home/me/repo'));
  assert.ok(isInside('C:\\Docs\\A.md', 'c:\\docs'));
  assert.ok(isInside('/etc/x', '/'));
  assert.ok(isInside('mdv:/d1/a/b.md', 'mdv:/d1'));
});

test('루프백·자기 origin 주소 판별 (SDD 8.4)', () => {
  for (const u of ['http://127.0.0.1:7787/api/stop', 'http://localhost/x', 'https://LOCALHOST.:8/', 'http://[::1]/', 'http://0.0.0.0/', 'http://2130706433/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://a.localhost/']) {
    assert.ok(isInternalUrl(u), u);
  }
  assert.ok(isInternalUrl('http://192.168.0.5:7787/x', 'http://192.168.0.5:7787'), '자기 origin');
  for (const u of ['https://example.com/a.png', 'mailto:me@x.y', 'img/a.png', 'http://128.0.0.1/']) assert.ok(!isInternalUrl(u), u);
});

test('단축키: 물리 키 기준이라 한글 입력 중에도 같다 (ARCH-05)', () => {
  const ev = (code: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ code, key: 'Process', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }) as KeyboardEvent;
  assert.equal(eventToKey(ev('KeyO', { ctrlKey: true })), 'Ctrl+O');
  assert.equal(eventToKey(ev('KeyT', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+T');
  assert.equal(eventToKey(ev('Equal', { ctrlKey: true })), 'Ctrl+=');
  assert.equal(eventToKey(ev('NumpadAdd', { ctrlKey: true })), 'Ctrl+=');
  assert.equal(eventToKey(ev('ArrowLeft', { altKey: true })), 'Alt+Left');
  assert.equal(eventToKey(ev('F3', { shiftKey: true })), 'Shift+F3');
  assert.equal(eventToKey(ev('Digit1', { ctrlKey: true })), 'Ctrl+1');
  assert.equal(eventToKey(ev('ShiftLeft', { shiftKey: true })), null);

  const reg = new CommandRegistry();
  let ran = 0;
  reg.register({ id: 'x', title: 'X', keys: ['Ctrl+O'], run: () => ran++ });
  reg.register({ id: 'y', title: 'Y', keys: ['F5'], enabled: () => false, run: () => ran++ });
  let prevented = false;
  const e = { ...ev('KeyO', { ctrlKey: true }), preventDefault: () => (prevented = true), stopPropagation() {} } as KeyboardEvent;
  assert.equal(reg.handleKey(e), true);
  assert.equal(ran, 1);
  assert.ok(prevented);
  reg.run('y');
  assert.equal(ran, 1, '비활성 명령은 실행되지 않는다');
});

test('메뉴 바: Alt+글자는 메뉴를 열고, Shift가 붙은 명령 키(Alt+Shift+T)는 명령에 넘긴다 (NFR-USE-01)', () => {
  const cmds = new CommandRegistry();
  let reopened = 0;
  cmds.register({ id: 'file.reopenClosed', title: '닫은 탭 다시 열기', keys: ['Alt+Shift+T'], run: () => reopened++ });
  const el = document.createElement('div');
  document.body.append(el);
  const bar = new MenuBar(el, cmds, [{ label: '설정', key: 'T', items: () => [] }]);
  const key = (init: KeyboardEventInit) => new (dom.window as any).KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as KeyboardEvent;
  const combo = key({ key: 'T', code: 'KeyT', altKey: true, shiftKey: true });
  assert.equal(bar.handleKeyDown(combo), false, '메뉴가 가로채지 않는다');
  assert.equal(cmds.handleKey(combo), true);
  assert.equal(reopened, 1);
  assert.equal(bar.handleKeyDown(key({ key: 't', code: 'KeyT', altKey: true })), true, 'Alt+T는 설정 메뉴를 연다');
  el.remove();
});

test('세션·설정: 잘못된 값은 기본값, 범위는 자른다 (ARCH-07)', () => {
  assert.equal(parseSession('{깨진 json').tabs.length, 0);
  const s = parseSession(JSON.stringify({
    schemaVersion: 1,
    tabs: [{ path: 'C:\\a.md', mode: 'split', line: 12.5 }, { path: '', mode: 'x' }, { path: 'C:\\b.md', mode: 'bogus', line: -3 }],
    activeIndex: 9,
    sidePanel: { visible: false, tab: 'workspace', width: 9999 },
    recentFiles: ['C:\\a.md', 3, null],
    unknownField: true,
  }));
  assert.deepEqual(s.tabs, [{ path: 'C:\\a.md', mode: 'split', line: 12.5 }, { path: 'C:\\b.md', mode: 'preview', line: 0 }]);
  assert.equal(s.activeIndex, 1);
  assert.deepEqual(s.sidePanel, { visible: false, tab: 'workspace', width: 600 });
  assert.deepEqual(s.recentFiles, ['C:\\a.md']);
  const st = parseSettings('{"zoom": 999, "theme": "neon", "wordWrap": false, "schemaVersion": 7}');
  assert.equal(st.zoom, 300);
  assert.equal(st.theme, 'system');
  assert.equal(st.wordWrap, false);
  assert.deepEqual(pushRecent(['C:\\A.md', 'C:\\b.md'], 'c:\\a.md', 20), ['c:\\a.md', 'C:\\b.md']);
});

test('디바운서: 마지막 호출 뒤 한 번, flush는 즉시', async () => {
  let n = 0;
  const d = new Debouncer(() => n++, 30);
  d.trigger();
  d.trigger();
  d.trigger();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(n, 1);
  d.trigger();
  d.flush();
  assert.equal(n, 2);
});

test('찾기 정규식: 이스케이프, 단어 단위(한글), 대소문자, 오류', () => {
  const r1 = buildRegex({ text: 'a.b', caseSensitive: false, wholeWord: false, regex: false }).re!;
  assert.deepEqual(findRanges('a.b axb A.B', r1), [[0, 3], [8, 11]]);
  const r2 = buildRegex({ text: '뷰어', caseSensitive: true, wholeWord: true, regex: false }).re!;
  assert.deepEqual(findRanges('뷰어 마크다운뷰어 뷰어!', r2), [[0, 2], [10, 12]]);
  assert.equal(buildRegex({ text: '(', caseSensitive: false, wholeWord: false, regex: true }).error, '정규식 오류');
  const r3 = buildRegex({ text: 'x*', caseSensitive: false, wholeWord: false, regex: true }).re!;
  assert.deepEqual(findRanges('ab xx', r3), [[3, 5]]);
});

test('탭: 중복 열기 방지, 닫으면 이웃 탭, 닫은 탭 기록, 순서 이동 (FR-FILE-02~05)', () => {
  const t = new TabManager();
  const a = t.open('a', 'A');
  const b = t.open('b', 'B');
  const c = t.open('c', 'C');
  assert.equal(t.open('a', 'A').id, a.id);
  assert.equal(t.activeId, a.id);
  t.activate(b.id);
  t.close(b.id);
  assert.equal(t.activeId, c.id, '오른쪽 탭으로');
  assert.deepEqual(t.closed[0], { path: 'B', mode: 'preview', line: 0 });
  t.move(c.id, 0);
  assert.deepEqual(t.tabs.map((x) => x.docId), ['c', 'a']);
  t.cycle(1);
  assert.equal(t.activeId, a.id);
  t.closeOthers(a.id);
  assert.deepEqual(t.tabs.map((x) => x.docId), ['a']);
  assert.equal(t.popClosed()?.path, 'C');
});

test('문서 모델: 다시 읽으면 버전 증가, 수동 인코딩 유지, 개수 계산 (ARCH-01)', () => {
  const store = new DocStore();
  const h: HostDoc = {
    path: 'C:\\x.md', text: '가나 다\r\nb\rc\n', encoding: 'cp949', hasBom: false, eol: 'Mixed', size: 10,
    mtime: 0, decodeWarning: false, kind: 'markdown', binary: false,
  };
  const d1 = store.upsert(h);
  store.update(d1.id, { forcedEncoding: 'cp949' });
  const d2 = store.upsert({ ...h, text: 'new' });
  assert.equal(d2.version, 2);
  store.remove(d2.id);
  assert.equal(store.upsert(h).version, 3, '지웠다 다시 읽어도 버전은 되돌아가지 않는다 (리뷰 #4)');
  assert.equal(d2.forcedEncoding, 'cp949');
  assert.equal(d2.dirty, false);
  assert.equal(countLines(h.text), 4);
  assert.equal(countWords(h.text), 4);
  assert.equal(countChars(h.text), 6);
  assert.equal(encodingLabel({ encoding: 'utf-8', hasBom: true }), 'UTF-8 BOM');
  store.markDeleted('c:/X.md');
  assert.equal(store.byPath('C:\\x.md')?.state, 'deleted');
});

test('미리보기 찾기: 일치 표시·순환·해제 (FR-FIND-03)', () => {
  const v = new PreviewView();
  const frag = dom.window.document.createDocumentFragment();
  const p = dom.window.document.createElement('p');
  p.innerHTML = '사과 바나나 <b>사과</b> 포도사과';
  frag.append(p);
  v.setContent(frag as unknown as Node);
  const st = v.find({ text: '사과', caseSensitive: false, wholeWord: false, regex: false });
  assert.equal(st.count, 3);
  assert.equal(v.article.querySelectorAll('mark.mdv-hit').length, 3);
  assert.equal(v.step(1).count, 3);
  assert.equal(v.article.querySelectorAll('mark.mdv-current').length, 1);
  v.clearFind();
  assert.equal(v.article.querySelectorAll('mark').length, 0);
  assert.equal(v.article.textContent, '사과 바나나 사과 포도사과');
});

/** 분할 보기 동기화 시험용 가짜 한쪽 보기. 줄 번호만 다룬다. */
function fakePane(line: number) {
  const el = dom.window.document.createElement('div') as unknown as HTMLElement;
  return { el, line, moves: 0, settling: false, topLine() { return this.line; }, scrollToLine(l: number) { this.moves++; this.line = l; } };
}

const frames = (n: number) => new Promise<void>((r) => setTimeout(r, n * 20));

test('분할 보기: 따라간 뒤 배치가 바뀌어 어긋나면 다시 맞춘다 (FR-VIEW-05)', async () => {
  const preview = fakePane(0);
  const source = fakePane(0);
  // 원문의 줄 바꿈 줄 높이가 추정치라 처음 이동은 3.6줄 밀려 닿는다.
  source.scrollToLine = function (l: number) {
    this.moves++;
    this.line = this.moves === 1 ? l + 3.6 : l;
  };
  const lines: number[] = [];
  const sync = new ScrollSync(preview as unknown as PreviewView, () => true, () => true, (l) => lines.push(l));
  sync.attachSource({ view: { scrollDOM: source.el }, topLine: () => source.topLine(), scrollToLine: (l: number) => source.scrollToLine(l) } as unknown as SourceView);

  preview.line = 41.2;
  preview.el.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(Math.abs(source.line - 44.8) < 1e-9, '첫 이동은 어긋난다');
  // 미리보기도 새로 보이는 블록이 실제 크기로 그려지며 맨 위 줄이 바뀐다 (스크롤 이벤트 없음).
  preview.line = 40.5;
  await frames(15);
  assert.ok(Math.abs(source.line - 40.5) < 0.01, `원문 ${source.line}`);
  assert.equal(lines.at(-1), 40.5, '탭 줄도 최종 위치로');
  // 다시 맞추는 동안 생긴 원문 스크롤 이벤트는 되받지 않는다.
  source.el.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(preview.line, 40.5);
});

test('분할 보기: 따라가던 쪽을 사용자가 움직이면 다시 맞추기를 멈춘다 (FR-VIEW-05)', async () => {
  const preview = fakePane(0);
  const source = fakePane(0);
  const sync = new ScrollSync(preview as unknown as PreviewView, () => true, () => true, () => {});
  sync.attachSource({ view: { scrollDOM: source.el }, topLine: () => source.topLine(), scrollToLine: (l: number) => source.scrollToLine(l) } as unknown as SourceView);

  preview.line = 30;
  preview.el.dispatchEvent(new dom.window.Event('scroll'));
  source.el.dispatchEvent(new dom.window.Event('wheel'));
  source.line = 55;
  source.el.dispatchEvent(new dom.window.Event('scroll'));
  await frames(15);
  assert.equal(source.line, 55, '사용자가 굴린 위치를 되돌리지 않는다');
  assert.equal(preview.line, 55, '이제 원문이 앞선 쪽');
});
