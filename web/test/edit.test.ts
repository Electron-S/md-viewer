// 편집과 저장 (FR-EDIT-01~10, NFR-ENC-05, NFR-SEC-05) 단위 테스트
import { dom } from './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countEols, decodeBytes, encodeText, findUnencodable, saveEolOf, toLf, type Encoding } from '../src/encoding';
import { toHostDoc } from '../src/bridge/listing';
import { DocStore, type DocModel } from '../src/docs';
import { isDocumentPath, isUntitledPath, untitledPath } from '../src/render/paths';
import { CommandRegistry } from '../src/commands';
import { parseSettings } from '../src/session';
import { TabManager } from '../src/tabs';
import { LocalBridge } from '../src/bridge/local';
import { ServerBridge } from '../src/bridge/server';
import { HostBridge } from '../src/bridge/host';
import { HostError, type Bridge, type HostDoc } from '../src/bridge/types';
import { EditController, type EditHost } from '../src/edit';
import { FindBar } from '../src/ui/findbar';
import type { SourceView } from '../src/views/source';

void dom;
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const domErr = (name: string) => Object.assign(new Error(name), { name });

/** 읽은 바이트를 고치지 않고 그대로 저장하면 같은 바이트가 나와야 한다 (NFR-ENC-05) */
function roundTrip(bytes: Uint8Array): Uint8Array {
  const h = toHostDoc('/x.md', bytes, 0);
  return encodeText(h.text, h.encoding, h.hasBom, saveEolOf(h.eol, h.eolCounts));
}

test('저장 인코딩: UTF-8·BOM·UTF-16 LE/BE·CP949, CRLF·LF·CR을 읽은 그대로 쓴다 (NFR-ENC-05)', () => {
  const s = '# 한글 문서\r\n본문 ✓ abc\r\n';
  const samples: [string, Uint8Array][] = [
    ['UTF-8 CRLF', utf8(s)],
    ['UTF-8 LF', utf8(s.replace(/\r\n/g, '\n'))],
    ['UTF-8 CR', utf8(s.replace(/\r\n/g, '\r'))],
    ['UTF-8 BOM', Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(s)])],
    ['줄 끝 없음', utf8('한 줄뿐')],
    ['빈 파일', new Uint8Array(0)],
    // '한글 문서입니다.\r\n가나다라\r\n'을 CP949(EUC-KR 범위)로 인코딩한 바이트
    ['CP949', hex('c7d1b1db20b9aebcadc0d4b4cfb4d92e0d0ab0a1b3aab4d9b6f30d0a')],
  ];
  for (const be of [false, true]) {
    const out = new Uint8Array(2 + s.length * 2);
    out.set(be ? [0xfe, 0xff] : [0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[2 + i * 2] = be ? c >> 8 : c & 0xff;
      out[3 + i * 2] = be ? c & 0xff : c >> 8;
    }
    samples.push([be ? 'UTF-16 BE' : 'UTF-16 LE', out]);
  }
  for (const [name, bytes] of samples) assert.deepEqual(roundTrip(bytes), bytes, name);
  assert.equal(decodeBytes(samples[6][1]).encoding, 'cp949', 'CP949 샘플은 CP949로 판별된다');
});

test('저장 인코딩: CP949에 없는 글자를 찾고, 섞인 줄 끝은 많은 쪽으로 맞춘다 (FR-EDIT-04)', () => {
  assert.deepEqual(findUnencodable('한글 abc 😀 ✓ 😀', 'cp949'), ['😀', '✓']);
  assert.deepEqual(findUnencodable('한글 abc', 'cp949'), []);
  assert.deepEqual(findUnencodable('😀 한글', 'utf-8'), [], 'UTF-8은 모든 글자를 쓴다');
  assert.deepEqual(findUnencodable('a\uD800b', 'utf-16le'), ['\uD800'], '짝 없는 서로게이트');
  assert.equal(saveEolOf('Mixed', countEols('a\r\nb\r\nc\nd')), 'CRLF');
  assert.equal(saveEolOf('Mixed', countEols('a\r\nb\nc')), 'LF', '같으면 LF');
  assert.equal(saveEolOf('None', countEols('abc')), 'LF');
  assert.equal(saveEolOf('CR', countEols('a\rb')), 'CR');
  assert.equal(toLf('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.deepEqual(encodeText('가\n나', 'utf-8', false, 'CRLF'), utf8('가\r\n나'));
  assert.deepEqual(encodeText('a', 'utf-8', true, 'LF'), Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]));
});

function hostDoc(path: string, text: string, extra: Partial<HostDoc> = {}): HostDoc {
  return {
    path, text, encoding: 'utf-8', hasBom: false, eol: 'LF', eolCounts: countEols(text), size: text.length, mtime: 1,
    decodeWarning: false, kind: 'markdown', binary: false, ...extra,
  };
}

test('문서 모델: 고치면 수정됨, 저장한 내용과 같아지면 꺼지고, 고친 문서는 디스크 내용으로 덮지 않는다 (FR-EDIT-02, FR-EDIT-09)', () => {
  const store = new DocStore();
  const kinds: string[] = [];
  store.subscribe((_d, k) => kinds.push(k));
  const d = store.upsert(hostDoc('/a.md', 'v1'));
  assert.deepEqual([d.dirty, d.savedText, d.untitled], [false, 'v1', false]);
  const e = store.applyEdit(d.id, 'v1 고침')!;
  assert.notEqual(e, d, '고칠 때마다 새 객체(상태 표시줄 캐시가 객체 단위다)');
  assert.ok(e.version > d.version);
  assert.equal(e.dirty, true);
  assert.equal(store.upsert(hostDoc('/a.md', 'disk')), e, '고친 문서는 다시 읽은 내용으로 덮지 않는다');
  assert.equal(store.get(d.id)!.text, 'v1 고침');
  assert.equal(store.applyEdit(d.id, 'v1')!.dirty, false, '실행 취소로 저장한 내용과 같아지면 수정됨이 꺼진다');
  store.applyEdit(d.id, 'v2');
  store.markSaved(d.id, { text: 'v2', mtime: 9, size: 2, encoding: 'utf-8', hasBom: false, eol: 'None', eolCounts: countEols('v2') });
  const saved = store.get(d.id)!;
  assert.deepEqual([saved.dirty, saved.savedText, saved.mtime, saved.size], [false, 'v2', 9, 2]);
  store.applyEdit(d.id, 'v3');
  const forced = store.upsert(hostDoc('/a.md', 'disk'), true);
  assert.deepEqual([forced.text, forced.dirty], ['disk', false], '버리기로 하면 force로 덮는다');
  assert.ok(kinds.includes('content') && kinds.includes('edit') && kinds.includes('flags'));
});

test('문서 모델: 새 문서와 다른 이름으로 저장 뒤 위치 옮기기 (FR-EDIT-05~06)', () => {
  const store = new DocStore();
  const path = untitledPath(1, '제목 없음 1.md');
  assert.ok(isUntitledPath(path) && !isUntitledPath('mdv:/d1/a.md'));
  const n = store.create(path);
  assert.deepEqual([n.untitled, n.text, n.dirty, n.encoding, n.eol], [true, '', false, 'utf-8', 'None']);
  store.applyEdit(n.id, '# 새 글\n');
  const moved = store.rekey(n.id, '/docs/새 글.md', 'markdown')!;
  assert.equal(store.get(n.id), undefined, '옛 위치는 지운다');
  assert.deepEqual([moved.path, moved.text, moved.dirty], ['/docs/새 글.md', '# 새 글\n', true]);
  store.markSaved(moved.id, { text: moved.text, mtime: 5, size: 9, encoding: 'utf-8', hasBom: false, eol: 'LF', eolCounts: countEols(moved.text) });
  assert.deepEqual([store.get(moved.id)!.untitled, store.get(moved.id)!.dirty], [false, false]);
  assert.ok(isDocumentPath('a.MD') && isDocumentPath('/x/b.txt') && !isDocumentPath('run.cmd') && !isDocumentPath('a.png'));
});

test('명령: keyHint는 메뉴에만 보이고 전역 키로 잡지 않는다 (SDD 6.3)', () => {
  const c = new CommandRegistry();
  let ran = 0;
  c.register({ id: 'edit.undo', title: 'u', keyHint: ['Ctrl+Z'], run: () => ran++ });
  assert.equal(c.keyFor('edit.undo'), 'Ctrl+Z');
  assert.equal(c.commandForKey('Ctrl+Z'), undefined, '입력 칸·편집기의 실행 취소를 빼앗지 않는다');
  assert.equal(parseSettings(null).autoSave, false, '자동 저장은 기본 끔 (FR-EDIT-10)');
  assert.equal(parseSettings('{"autoSave": true}').autoSave, true);
  const t = new TabManager();
  const tab = t.open('a', '/a.md');
  t.retarget(tab.id, 'b', '/b.md');
  assert.deepEqual([t.get(tab.id)!.docId, t.get(tab.id)!.path], ['b', '/b.md']);
  t.close(tab.id);
  t.forgetClosed((p) => p !== '/b.md');
  assert.equal(t.closed.length, 0);
});

// ---- 파일 핸들 브리지 쓰기 (독립 모드)

class WFile {
  readonly kind = 'file' as const;
  perm: PermissionState = 'prompt';
  asked = 0;
  constructor(
    readonly name: string,
    public content: Uint8Array,
    public lastModified = 1,
  ) {}
  async getFile() {
    return new File([this.content as BlobPart], this.name, { lastModified: this.lastModified });
  }
  async isSameEntry(o: unknown) {
    return o === this;
  }
  async queryPermission() {
    return this.perm;
  }
  async requestPermission() {
    this.asked++;
    this.perm = 'granted';
    return this.perm;
  }
  async createWritable() {
    const parts: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array) => void parts.push(new Uint8Array(d)),
      close: async () => {
        this.content = Uint8Array.from(parts.flatMap((p) => [...p]));
        this.lastModified++;
      },
    };
  }
}

function dropOf(handle: unknown): DataTransfer {
  return { items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(handle), getAsFile: () => null }], files: [] } as unknown as DataTransfer;
}

test('파일 핸들 브리지: 처음 저장할 때 쓰기 권한을 묻고, 읽은 뒤 바뀌었으면 ECONFLICT, 자기 쓰기는 폴링이 알리지 않는다 (FR-EDIT-04, FR-EDIT-09)', async () => {
  const b = new LocalBridge({ pollMs: 20 });
  const f = new WFile('메모.md', utf8('old'));
  const [entry] = await b.takeDrop(dropOf(f));
  const events: string[] = [];
  b.on('file.changed', () => events.push('changed'));
  b.request('watch.set', { paths: [entry.path] });
  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(b.request('file.write', { path: entry.path, bytes: utf8('x'), prompt: false }), (e: HostError) => e.code === 'EACCES', '자동 저장은 권한을 묻지 않는다');
  const r = await b.request('file.write', { path: entry.path, bytes: utf8('new 본문'), baseMtime: 1, baseSize: 3 });
  assert.equal(f.asked, 1, '쓰기 권한을 한 번 묻는다');
  assert.equal(new TextDecoder().decode(f.content), 'new 본문');
  assert.deepEqual(r, { mtime: 2, size: utf8('new 본문').length });
  await new Promise((r2) => setTimeout(r2, 80));
  assert.deepEqual(events, [], '자기가 쓴 변경은 밖의 변경으로 알리지 않는다');
  await assert.rejects(b.request('file.write', { path: entry.path, bytes: utf8('y'), baseMtime: 1, baseSize: 3 }), (e: HostError) => e.code === 'ECONFLICT');
  // 핸들 없는 파일(input·옛 끌어다 놓기)은 제자리에 쓰지 못한다.
  const [mem] = await b.takeDrop({ items: [{ kind: 'file', getAsFile: () => new File(['m'], 'm.md') }], files: [] } as unknown as DataTransfer);
  await assert.rejects(b.request('file.write', { path: mem.path, bytes: utf8('x') }), (e: HostError) => e.code === 'ENOTSUP');
  await assert.rejects(b.request('dialog.saveFile', { suggestedName: 'a.md' }), (e: HostError) => e.code === 'ENOTSUP', '저장 대화상자가 없는 브라우저는 내려받기로');
  await b.request('watch.set', { paths: [] });
});

test('실행기 브리지: 쓰기는 날 바이트 POST /api/write, 덮어쓰기 검사 인자를 쿼리로 (SDD 6.2)', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/write')) {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('baseMtime') === '1') return Response.json({ code: 'ECONFLICT', message: 'changed' }, { status: 409 });
      return Response.json({ mtime: 7, size: 3 });
    }
    return new Response(null, { status: 404 });
  };
  const b = new ServerBridge(new LocalBridge(), new URLSearchParams('t=TOK'));
  const r = await b.request('file.write', { path: '/home/me/a.md', bytes: utf8('abc'), baseMtime: 5.4, baseSize: 3 });
  assert.deepEqual(r, { mtime: 7, size: 3 });
  const q = new URL(calls[0].url, 'http://x').searchParams;
  assert.deepEqual([q.get('t'), q.get('path'), q.get('baseMtime'), q.get('baseSize'), q.get('create')], ['TOK', '/home/me/a.md', '5', '3', null]);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string>)['content-type'], 'application/octet-stream');
  assert.deepEqual(calls[0].init?.body, utf8('abc'));
  await assert.rejects(b.request('file.write', { path: '/home/me/a.md', bytes: utf8('x'), baseMtime: 1 }), (e: HostError) => e.code === 'ECONFLICT');
  await b.request('file.write', { path: '/home/me/b.md', bytes: utf8('x'), create: true });
  assert.equal(new URL(calls.at(-1)!.url, 'http://x').searchParams.get('create'), '1');
});

test('Windows 앱 브리지: 쓰기 쿼리는 encodeURIComponent 모양이라 공백이 든 경로도 그대로 간다 (SDD 6.4)', async () => {
  const urls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    urls.push(url);
    return Response.json({ mtime: 1, size: 1 });
  };
  const b = new HostBridge(() => undefined);
  await b.request('file.write', { path: 'C:\\앱 문서\\고칠 앱 문서.md', bytes: utf8('x'), baseMtime: 3, baseSize: 1 });
  assert.equal(urls[0], `/api/write?path=${encodeURIComponent('C:\\앱 문서\\고칠 앱 문서.md')}&baseMtime=3&baseSize=1`);
  assert.ok(!urls[0].includes('+'), '공백을 +로 쓰지 않는다(호스트가 공백으로 읽지 않는다)');
});

// ---- 편집 조정자

class FakeSource {
  texts = new Map<string, string>();
  dropped: string[] = [];
  textOf(id: string) {
    return this.texts.get(id) ?? null;
  }
  syncVersion() {}
  drop(id: string) {
    this.dropped.push(id);
  }
}

function setup(write: (p: Record<string, any>) => Promise<{ mtime: number; size: number }>, disk: () => HostDoc) {
  const docs = new DocStore();
  const tabs = new TabManager();
  const source = new FakeSource();
  const writes: Record<string, any>[] = [];
  const bridge = {
    mode: 'launcher',
    request: async (m: string, p: Record<string, any>) => {
      if (m === 'file.write') {
        writes.push(p);
        return write(p);
      }
      return {};
    },
  } as unknown as Bridge;
  const edited: DocModel[] = [];
  const host: EditHost = {
    bridge, docs, tabs,
    source: () => source as unknown as SourceView,
    autoSave: () => false,
    roots: () => ['/docs'],
    workspace: () => null,
    readDoc: async () => disk(),
    edited: (d) => edited.push(d),
    moved: () => {},
    closeTab: (id) => void tabs.close(id),
    log: () => {},
  };
  const bar = document.createElement('div');
  const ed = new EditController(host, bar);
  return { docs, tabs, source, writes, ed, bar, edited };
}

test('편집 조정자: 고치면 바로 수정됨, 반영 뒤 저장하면 원래 인코딩·줄 끝으로 쓴다 (FR-EDIT-01~04)', async () => {
  const cp = hex('c7d1b1db0d0a'); // '한글\r\n' (CP949, CRLF)
  const s = setup(async (p) => ({ mtime: 50, size: (p.bytes as Uint8Array).length }), () => toHostDoc('/docs/a.md', cp, 10));
  const doc = s.docs.upsert(toHostDoc('/docs/a.md', cp, 10));
  s.tabs.open(doc.id, doc.path);
  s.source.texts.set(doc.id, '한글\n가나\n');
  s.ed.onSourceChange(doc.id);
  assert.equal(s.docs.get(doc.id)!.dirty, true, '반영 전에도 곧바로 수정됨');
  assert.equal(await s.ed.save(doc.id), true);
  assert.equal(s.writes.length, 1);
  assert.deepEqual(s.writes[0].bytes, hex('c7d1b1db0d0ab0a1b3aa0d0a'), 'CP949·CRLF로 쓴다');
  assert.deepEqual([s.writes[0].baseMtime, s.writes[0].baseSize], [10, 6], '읽은 수정 시각·크기로 덮어쓰기를 검사한다');
  const saved = s.docs.get(doc.id)!;
  assert.deepEqual([saved.dirty, saved.mtime, saved.savedText, saved.encoding as Encoding], [false, 50, '한글\n가나\n', 'cp949']);
  assert.equal(s.edited.length, 1, '반영하면 미리보기를 고치게 알린다');
  assert.equal(await s.ed.save(doc.id), true, '고치지 않았으면 쓰지 않는다');
  assert.equal(s.writes.length, 1);
});

test('편집 조정자: 자기 저장의 메아리는 무시하고, 고친 채 밖에서 바뀌면 덮지 않고 띠를 띄운다 (FR-EDIT-09)', async () => {
  let disk = hostDoc('/docs/b.md', 'base\n');
  const s = setup(async () => ({ mtime: 2, size: 5 }), () => disk);
  const doc = s.docs.upsert(disk);
  s.tabs.open(doc.id, doc.path);
  await s.ed.onFileChanged('/docs/b.md');
  assert.equal(s.docs.get(doc.id)!.version, doc.version, '같은 내용이면 다시 그리지 않는다');
  disk = hostDoc('/docs/b.md', 'outside\n', { mtime: 3 });
  await s.ed.onFileChanged('/docs/b.md');
  assert.equal(s.docs.get(doc.id)!.text, 'outside\n', '고치지 않은 문서는 다시 읽는다');
  s.source.texts.set(doc.id, 'mine\n');
  s.ed.onSourceChange(doc.id);
  disk = hostDoc('/docs/b.md', 'outside 2\n', { mtime: 4 });
  await s.ed.onFileChanged('/docs/b.md');
  assert.equal(s.docs.get(doc.id)!.text, 'mine\n', '고친 문서는 덮지 않는다');
  assert.equal(s.bar.hidden, false, '알림 띠');
  assert.equal(s.bar.querySelectorAll('button').length, 2);
  (s.bar.querySelectorAll('button')[0] as HTMLButtonElement).click(); // 디스크 내용으로 다시 읽기
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([s.docs.get(doc.id)!.text, s.docs.get(doc.id)!.dirty, s.bar.hidden], ['outside 2\n', false, true]);
  assert.ok(s.source.dropped.includes(doc.id), '고친 내용(실행 취소 기록)을 버린다');
});

test('편집 조정자: 새 문서는 저장하기 전까지 파일이 없고, 바이너리는 저장하지 않는다 (FR-EDIT-01·06)', async () => {
  const s = setup(async () => ({ mtime: 1, size: 1 }), () => hostDoc('/x.md', ''));
  const a = s.ed.newDocument();
  const b = s.ed.newDocument();
  assert.notEqual(a.path, b.path);
  assert.ok(isUntitledPath(a.path) && a.untitled);
  const bin = s.docs.upsert(hostDoc('/docs/c.md', '', { binary: true }));
  s.tabs.open(bin.id, bin.path);
  assert.equal(await s.ed.save(bin.id), false);
  assert.equal(s.writes.length, 0);
});

test('찾기 바: 찾아 바꾸기로 열면 바꾸기 줄이 보이고, 바꾸기·모두 바꾸기를 알린다 (FR-EDIT-07)', () => {
  const bar = new FindBar();
  document.body.append(bar.el);
  const calls: [string, string, boolean][] = [];
  bar.onReplace = (q, rep, all) => (calls.push([q.text, rep, all]), { count: 0, index: -1 });
  bar.open('사과', false);
  assert.equal(bar.replacing, false);
  bar.open('사과', true);
  assert.equal(bar.replacing, true);
  const rep = bar.el.querySelector('.replace-input') as HTMLInputElement;
  rep.value = '배';
  rep.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  rep.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, altKey: true, bubbles: true }));
  assert.deepEqual(calls, [['사과', '배', false], ['사과', '배', true]]);
  bar.close();
  bar.el.remove();
});

void domErr;
