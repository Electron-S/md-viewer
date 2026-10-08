import { dom } from './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalBridge } from '../src/bridge/local';
import { ServerBridge } from '../src/bridge/server';
import { HostError } from '../src/bridge/types';

void dom;
const enc = (s: string) => new TextEncoder().encode(s);
const domErr = (name: string) => Object.assign(new Error(name), { name });

/** File System Access 핸들 흉내 */
class FakeFile {
  readonly kind = 'file' as const;
  deleted = false;
  constructor(
    readonly name: string,
    public content: Uint8Array,
    public lastModified = 1,
  ) {}
  async getFile() {
    if (this.deleted) throw domErr('NotFoundError');
    return new File([this.content as BlobPart], this.name, { lastModified: this.lastModified });
  }
  async isSameEntry(o: unknown) {
    return o === this;
  }
}

class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeFile | FakeDir>();
  constructor(readonly name: string) {}
  add<T extends FakeFile | FakeDir>(c: T): T {
    this.children.set(c.name, c);
    return c;
  }
  async getDirectoryHandle(n: string) {
    const c = this.children.get(n);
    if (!c) throw domErr('NotFoundError');
    if (c.kind !== 'directory') throw domErr('TypeMismatchError');
    return c;
  }
  async getFileHandle(n: string) {
    const c = this.children.get(n);
    if (!c) throw domErr('NotFoundError');
    if (c.kind !== 'file') throw domErr('TypeMismatchError');
    if (c.deleted) throw domErr('NotFoundError');
    return c;
  }
  async *values() {
    yield* this.children.values();
  }
  async resolve(h: unknown): Promise<string[] | null> {
    for (const c of this.children.values()) {
      if (c === h) return [c.name];
      if (c.kind === 'directory') {
        const sub = await c.resolve(h);
        if (sub) return [c.name, ...sub];
      }
    }
    return null;
  }
  async isSameEntry(o: unknown) {
    return o === this;
  }
}

/** drop 이벤트의 DataTransfer 흉내 */
function dataTransfer(items: { handle?: unknown; file?: File }[]): DataTransfer {
  return {
    items: items.map((i) => ({
      kind: 'file',
      ...(i.handle !== undefined ? { getAsFileSystemHandle: () => Promise.resolve(i.handle) } : {}),
      getAsFile: () => i.file ?? null,
    })),
    files: [],
  } as unknown as DataTransfer;
}

function tree() {
  const root = new FakeDir('문서 모음');
  const sub = root.add(new FakeDir('sub'));
  const x = sub.add(new FakeFile('x.md', enc('# 엑스\n')));
  root.add(new FakeFile('a.md', enc('# A\n')));
  root.add(new FakeFile('b.txt', enc('메모')));
  root.add(new FakeFile('c.png', new Uint8Array([137, 80, 78, 71])));
  root.add(new FakeFile('.hidden.md', enc('')));
  root.add(new FakeDir('node_modules'));
  return { root, sub, x };
}

test('파일 핸들 브리지: 끌어다 놓은 폴더를 mdv: 위치로 읽고 목록을 거른다 (FR-FILE-01, FR-NAV-02)', async () => {
  const b = new LocalBridge();
  const { root, x } = tree();
  const [entry] = await b.takeDrop(dataTransfer([{ handle: root }]));
  assert.deepEqual(entry, { path: 'mdv:/d1/', isDir: true });
  const { entries } = await b.request('dir.list', { path: entry.path });
  assert.deepEqual(entries, [
    { name: 'sub', isDir: true },
    { name: 'a.md', isDir: false },
    { name: 'b.txt', isDir: false },
  ]);
  const doc = await b.request('file.read', { path: 'mdv:/d1/sub/x.md' });
  assert.deepEqual([doc.path, doc.text, doc.kind], ['mdv:/d1/sub/x.md', '# 엑스\n', 'markdown']);
  assert.equal(b.displayPath('mdv:/d1/sub/x.md'), '문서 모음/sub/x.md');
  assert.equal(b.rootOf('mdv:/d1/sub/x.md'), 'mdv:/d1/');
  assert.ok(b.canResolveRelative('mdv:/d1/sub/x.md'));
  // 이미 연 폴더 안의 파일을 다시 끌어다 놓으면 같은 위치가 된다 (FR-FILE-03).
  const [again] = await b.takeDrop(dataTransfer([{ handle: x }]));
  assert.equal(again.path, 'mdv:/d1/sub/x.md');
  await assert.rejects(b.request('file.read', { path: 'mdv:/d1/없음.md' }), (e: HostError) => e.code === 'ENOENT');
  await assert.rejects(b.request('file.read', { path: 'mdv:/d1/sub' }), (e: HostError) => e.code === 'EISDIR');
  await assert.rejects(b.request('file.read', { path: 'mdv:/d9/a.md' }), (e: HostError) => e.code === 'ENOENT');
});

test('파일 핸들 브리지: 단독 파일은 상대 경로를 못 따라가고, 폴더를 열면 그 기준으로 옮긴다 (FR-REN-03, SDD 7.2)', async () => {
  const b = new LocalBridge();
  const { root, x } = tree();
  const [one] = await b.takeDrop(dataTransfer([{ handle: x }]));
  assert.equal(one.path, 'mdv:/f1/x.md');
  assert.equal(b.canResolveRelative(one.path), false);
  assert.equal(b.displayPath(one.path), 'x.md');
  const [dir] = await b.takeDrop(dataTransfer([{ handle: root }]));
  const moved = await b.request('file.relocate', { path: one.path, dir: dir.path });
  assert.equal(moved.path, 'mdv:/d2/sub/x.md');
  const other = await b.request('file.relocate', { path: one.path, dir: (await b.takeDrop(dataTransfer([{ handle: new FakeDir('빈 폴더') }])))[0].path });
  assert.equal(other.path, null, '파일을 품지 않은 폴더');
});

test('파일 핸들 브리지: input으로 고른 폴더(showDirectoryPicker가 없는 브라우저) 기준으로도 옮긴다 (SDD 7.2)', async () => {
  const b = new LocalBridge();
  const inFolder = (rel: string, text: string) => {
    const f = new File([enc(text)], rel.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    return f;
  };
  const [one] = await b.takeDrop(dataTransfer([{ handle: new FakeFile('x.md', enc('# 엑스\n')) }]));
  const [mem] = await b.takeDrop(dataTransfer([{ file: new File([enc('# 메모')], '메모.md') }]));
  const [dir] = (b as any).addFiles([inFolder('문서/sub/x.md', '# 엑스\n'), inFolder('문서/메모.md', '# 메모'), inFolder('문서/a.md', '# A')], true);
  assert.equal(dir.path, 'mdv:/u3/');
  assert.equal((await b.request('file.relocate', { path: one.path, dir: dir.path })).path, 'mdv:/u3/sub/x.md', '핸들 파일');
  assert.equal((await b.request('file.relocate', { path: mem.path, dir: dir.path })).path, 'mdv:/u3/메모.md', '핸들 없는 파일');
  const [twice] = (b as any).addFiles([inFolder('둘/x.md', '# 엑스\n'), inFolder('둘/c/x.md', '# 엑스\n')], true);
  assert.equal((await b.request('file.relocate', { path: one.path, dir: twice.path })).path, null, '같은 이름·크기가 둘이면 고르지 않는다');
});

test('파일 핸들 브리지: 핸들 없는 파일(끌어다 놓기·input)은 읽기만 한다', async () => {
  const b = new LocalBridge();
  const [e] = await b.takeDrop(dataTransfer([{ file: new File([enc('# 메모')], '메모.md') }]));
  assert.equal(e.path, 'mdv:/u1/메모.md');
  assert.equal((await b.request('file.read', { path: e.path })).text, '# 메모');
  await assert.rejects(b.request('shell.reveal', { path: e.path }), (err: HostError) => err.code === 'ENOTSUP');
  await assert.rejects(b.request('shell.openExternal', { url: 'file:///etc/passwd' }), (err: HostError) => err.code === 'EINVAL');
});

/** 옛 항목 API(webkitGetAsEntry)의 파일·폴더 흉내 */
function oldFileEntry(name: string, text: string) {
  return { isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(new File([enc(text)], name)) };
}
function oldDirEntry(name: string, children: any[]): any {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let done = false;
      return { readEntries: (ok: (e: unknown[]) => void) => ok(done ? [] : ((done = true), children)) };
    },
    getFile(rel: string, _o: object, ok: (e: unknown) => void, fail: (e: unknown) => void) {
      const hit = children.find((c) => c.isFile && c.name === rel);
      if (hit) ok(hit);
      else fail(Object.assign(new Error(rel), { name: 'NotFoundError' }));
    },
    getDirectory(rel: string, _o: object, ok: (e: unknown) => void, fail: (e: unknown) => void) {
      const hit = children.find((c) => c.isDirectory && c.name === rel);
      if (hit) ok(hit);
      else fail(Object.assign(new Error(rel), { name: 'NotFoundError' }));
    },
  };
}

test('파일 핸들 브리지: 핸들이 오지 않는 폴더 끌어다 놓기는 옛 항목 API로 연다', async () => {
  const b = new LocalBridge({ handleWaitMs: 30 });
  const dir = oldDirEntry('옛 폴더', [oldFileEntry('a.md', '# 옛\n'), oldFileEntry('b.png', 'x')]);
  const dt = {
    items: [{ kind: 'file', getAsFileSystemHandle: () => new Promise(() => {}), webkitGetAsEntry: () => dir, getAsFile: () => null }],
    files: [],
  } as unknown as DataTransfer;
  const t0 = Date.now();
  const [e] = await b.takeDrop(dt);
  assert.ok(Date.now() - t0 < 1000, '기다림이 제한된다');
  assert.deepEqual(e, { path: 'mdv:/e1/', isDir: true });
  assert.deepEqual((await b.request('dir.list', { path: e.path })).entries, [{ name: 'a.md', isDir: false }]);
  assert.equal((await b.request('file.read', { path: 'mdv:/e1/a.md' })).text, '# 옛\n');
});

/** IndexedDB 흉내: put·delete·clear는 바로 반영하고, 읽기 요청은 다음 틱에 onsuccess를 부른다. */
function fakeIndexedDB() {
  const rows = new Map<string, any>();
  const later = (result: unknown) => {
    const req: any = {};
    setTimeout(() => ((req.result = result), req.onsuccess?.()), 0);
    return req;
  };
  const store = {
    put: (r: any) => rows.set(r.id, r),
    delete: (k: string) => rows.delete(k),
    clear: () => rows.clear(),
    getAll: () => later([...rows.values()]),
    getAllKeys: () => later([...rows.keys()]),
  };
  const db = { transaction: () => ({ objectStore: () => store }), createObjectStore: () => store };
  const open = () => {
    const req: any = { result: db };
    setTimeout(() => (req.onupgradeneeded?.(), req.onsuccess?.()), 0);
    return req;
  };
  return { rows, open };
}

async function withIndexedDB(fn: (rows: Map<string, any>) => Promise<void>) {
  const fake = fakeIndexedDB();
  (globalThis as any).indexedDB = { open: fake.open };
  try {
    await fn(fake.rows);
  } finally {
    delete (globalThis as any).indexedDB;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('파일 핸들 브리지: 권한 기억을 끄면 저장한 핸들을 지우고, 켜면 파일·폴더 핸들만 넣는다 (SDD 8.4)', () =>
  withIndexedDB(async (rows) => {
    const b = new LocalBridge();
    await b.request('handles.remember', { on: true });
    await b.takeDrop(dataTransfer([{ handle: tree().root }]));
    await b.takeDrop(dataTransfer([{ file: new File([enc('x')], 'mem.md') }]));
    await settle();
    assert.deepEqual([...rows.keys()], ['d1']);
    await b.request('handles.remember', { on: false });
    assert.equal(rows.size, 0, '끄면 잊는다');
    await b.request('handles.remember', { on: true });
    assert.deepEqual([...rows.keys()], ['d1'], '다시 켜면 넣는다(핸들 없는 파일이 있어도 비우지 않는다)');
  }));

test('파일 핸들 브리지: 저장소는 세션이 가리키는 핸들만 남기고, 권한을 기다리는 위치는 세션에서 빠지지 않게 알린다 (SDD 7.4)', () =>
  withIndexedDB(async (rows) => {
    const session = (...paths: string[]) => ({ name: 'session', data: JSON.stringify({ tabs: paths.map((path) => ({ path })) }) });
    const a = new LocalBridge();
    await a.takeDrop(dataTransfer([{ handle: tree().root }]));
    await a.takeDrop(dataTransfer([{ handle: new FakeFile('x.md', enc('# x')) }]));
    await settle();
    assert.deepEqual([...rows.keys()].sort(), ['d1', 'f2']);
    await a.request('store.save', session('mdv:/d1/a.md'));
    await settle();
    assert.deepEqual([...rows.keys()], ['d1'], '세션이 안 가리키는 핸들은 지운다');

    // 다음에 열면 저장된 핸들은 권한을 다시 받기 전까지 잠겨 있다.
    const b = new LocalBridge();
    const ready = await b.request('app.ready');
    assert.equal(ready.restorable, 1);
    assert.equal(b.isPending('mdv:/d1/a.md'), true);
    assert.equal(b.isPending('mdv:/f9/x.md'), false);
    await b.request('store.save', session('mdv:/d1/a.md'));
    await settle();
    assert.deepEqual([...rows.keys()], ['d1'], '아직 못 연 위치도 세션이 가리키면 남긴다');
    await b.request('store.save', session());
    await settle();
    assert.equal(rows.size, 0);
    await b.request('store.save', session('mdv:/d1/a.md'));
    await settle();
    assert.deepEqual([...rows.keys()], ['d1'], '세션이 다시 가리키면 되살린다');
  }));

test('파일 핸들 브리지: 열린 파일을 폴링해 변경·삭제를 알린다 (FR-WATCH-01~02)', async () => {
  const b = new LocalBridge({ pollMs: 20 });
  const { root, x } = tree();
  await b.takeDrop(dataTransfer([{ handle: root }]));
  const events: string[] = [];
  b.on('file.changed', (p) => events.push('changed ' + p.path));
  b.on('file.deleted', (p) => events.push('deleted ' + p.path));
  await b.request('watch.set', { paths: ['mdv:/d1/sub/x.md'] });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(60);
  assert.deepEqual(events, [], '처음에는 알리지 않는다');
  x.content = enc('# 바뀜\n');
  x.lastModified = 2;
  await wait(80);
  x.deleted = true;
  await wait(80);
  x.deleted = false;
  x.lastModified = 3;
  await wait(80);
  await b.request('watch.set', { paths: [] });
  assert.deepEqual(events, ['changed mdv:/d1/sub/x.md', 'deleted mdv:/d1/sub/x.md', 'changed mdv:/d1/sub/x.md']);
});

test('파일 핸들 브리지: 시작 정보는 독립 모드이고 저장소가 없어도 동작한다 (FR-SESS-01)', async () => {
  const r = await new LocalBridge().request('app.ready');
  assert.equal(r.mode, 'standalone');
  assert.deepEqual(r.args, []);
  assert.equal(r.restorable, 0);
});

// ---------------------------------------------------------------- 실행기 브리지

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', body: init.body as string | undefined };
    calls.push(c);
    const path = new URL(url, 'http://127.0.0.1:7787').pathname;
    const h = routes[path];
    if (!h) throw new TypeError('network');
    return h(c);
  };
  return calls;
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, (e: { data: string }) => void>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers.set(type, fn);
  }
  fire(type: string, data: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(data) });
  }
}

test('실행기 브리지: 주소의 토큰·인자, API 호출, 오류 코드 (FR-LAUNCH-01, SDD 6.2)', async () => {
  const calls = mockFetch({
    '/api/ready': () => Response.json({ version: '1.0.0', roots: ['/home/me', '/home/me/repo'], pathStyle: 'posix' }),
    '/api/read': (c) =>
      new URL(c.url, 'http://x').searchParams.get('path') === '/home/me/repo/없음.md'
        ? Response.json({ code: 'EACCES', message: 'outside' }, { status: 403 })
        : new Response(enc('# 실행기\n'), { headers: { 'x-mdv-mtime': '42' } }),
    '/api/list': () => Response.json([{ name: 'z.md', isDir: false }, { name: '.git', isDir: true }, { name: 'docs', isDir: true }]),
    '/api/watch': () => new Response(null, { status: 204 }),
  });
  const b = new ServerBridge(new LocalBridge(), new URLSearchParams('t=TOK&f=/home/me/repo/README.md&d=/home/me/repo/docs'));
  const ready = await b.request('app.ready');
  assert.equal(ready.mode, 'launcher');
  assert.deepEqual(ready.args, [{ path: '/home/me/repo/README.md', isDir: false }, { path: '/home/me/repo/docs', isDir: true }]);
  const doc = await b.request('file.read', { path: '/home/me/repo/README.md' });
  assert.deepEqual([doc.text, doc.mtime], ['# 실행기\n', 42]);
  const read = new URL(calls.find((c) => c.url.startsWith('/api/read?'))!.url, 'http://x');
  assert.equal(read.searchParams.get('t'), 'TOK');
  assert.equal(read.searchParams.get('path'), '/home/me/repo/README.md');
  assert.deepEqual((await b.request('dir.list', { path: '/home/me/repo' })).entries, [{ name: 'docs', isDir: true }, { name: 'z.md', isDir: false }]);
  await assert.rejects(b.request('file.read', { path: '/home/me/repo/없음.md' }), (e: HostError) => e.code === 'EACCES');
  await b.request('watch.set', { paths: ['/home/me/repo/README.md', 'mdv:/d1/a.md'] });
  assert.deepEqual(JSON.parse(calls.at(-1)!.body!).paths, ['/home/me/repo/README.md'], 'mdv: 위치는 실행기로 보내지 않는다');
  assert.equal(b.rootOf('/home/me/repo/docs/a.md'), '/home/me/repo', '가장 깊은 루트');
  assert.equal(b.rootOf('/etc/x'), null);
  assert.equal(b.imageUrl('/home/me/repo/a b.png'), '/api/file?t=TOK&path=%2Fhome%2Fme%2Frepo%2Fa+b.png');
  assert.equal(b.imageUrl('mdv:/d1/a.png'), null);
  mockFetch({});
  await assert.rejects(b.request('file.read', { path: '/home/me/x.md' }), (e: HostError) => e.code === 'EOFFLINE');
});

test('실행기 브리지: SSE 이벤트를 받고 끊김·재연결을 알린다 (FR-WATCH-01, SDD 7.3)', async () => {
  (globalThis as any).EventSource = FakeEventSource;
  const calls = mockFetch({ '/api/watch': () => new Response(null, { status: 204 }) });
  const b = new ServerBridge(new LocalBridge(), new URLSearchParams('t=TOK'));
  const seen: string[] = [];
  b.on('file.changed', (p) => seen.push('changed ' + p.path));
  b.on('file.deleted', (p) => seen.push('deleted ' + p.path));
  b.on('bridge.offline', () => seen.push('offline'));
  b.on('bridge.online', () => seen.push('online'));
  await b.request('watch.set', { paths: ['/a.md'] });
  b.connect();
  const es = FakeEventSource.last!;
  assert.match(es.url, /^\/api\/events\?t=TOK&client=/);
  es.fire('file.changed', { path: '/a.md' });
  es.onerror!();
  es.onopen!();
  es.fire('file.deleted', { path: '/a.md' });
  assert.deepEqual(seen, ['changed /a.md', 'offline', 'online', 'deleted /a.md']);
  assert.equal(calls.filter((c) => c.url.startsWith('/api/watch')).length, 2, '다시 붙으면 감시 목록을 다시 보낸다');
});

test('파일 핸들 브리지: 핸들 없는 파일은 고른 폴더에서 이름·크기로 찾고, 세션에는 핸들 위치만 남긴다 (SDD 7.2, 7.4)', async () => {
  const b = new LocalBridge();
  const { root } = tree();
  const [mem] = await b.takeDrop(dataTransfer([{ file: new File([enc('# 엑스\n')], 'x.md') }]));
  const [dir] = await b.takeDrop(dataTransfer([{ handle: root }]));
  assert.equal((await b.request('file.relocate', { path: mem.path, dir: dir.path })).path, `${dir.path}sub/x.md`);
  const [other] = await b.takeDrop(dataTransfer([{ file: new File([enc('다른 내용')], 'x.md') }]));
  assert.equal((await b.request('file.relocate', { path: other.path, dir: dir.path })).path, null, '크기가 다르면 다른 파일');
  assert.ok(b.isRestorable(`${dir.path}sub/x.md`), '폴더 핸들 위치는 다시 열 수 있다');
  assert.ok(!b.isRestorable(mem.path), '핸들 없는 파일은 다시 열 수 없다');
  await b.request('handles.remember', { on: false });
  assert.ok(!b.isRestorable(`${dir.path}sub/x.md`), '기억하지 않기로 하면 세션에 남기지 않는다');
});
