import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../log';
import { startServer, type RunningServer } from '../server';
import { readState } from '../state';
import { makeViewer, openEvents, postJson, q, request, sleep, tempDir, VIEWER_CSP } from './helpers';

let home: string;
let docs: string;
let outside: string;
let srv: RunningServer;
const platform = { platform: process.platform, wsl: false, env: {} };
/** 시험 중에 탐색기를 띄우지 않도록 바꿔 끼우는 위치 열기 */
let revealImpl: (file: string) => Promise<boolean> = async () => true;

before(async () => {
  home = tempDir();
  docs = path.join(tempDir('mdv-docs-'), '문서 모음');
  fs.mkdirSync(path.join(docs, 'img'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'README.md'), '# 제목\n', 'utf8');
  fs.writeFileSync(path.join(docs, 'big.md'), Buffer.alloc(2048, 0x61));
  fs.writeFileSync(path.join(docs, 'img', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(docs, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  outside = tempDir('mdv-outside-');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret', 'utf8');
  fs.symlinkSync(outside, path.join(docs, 'escape'));
  srv = await startServer({
    home, viewerPath: makeViewer(home), version: 't', port: 0, idleMs: 60_000, maxBytes: 1024, platform, logger: new Logger(path.join(home, 'logs')),
    reveal: (f) => revealImpl(f),
  });
  srv.addRoot(docs);
});

after(async () => {
  await srv.close('test');
});

const api = (p: string, extra: Record<string, string> = {}) => request(srv.port, p + q(srv.token, extra));

test('Host가 루프백 이름이 아니면 403, 토큰이 없거나 틀리면 403 (NFR-SEC-02)', async () => {
  assert.equal((await request(srv.port, '/', { host: 'evil.example:80' })).status, 403);
  assert.equal((await request(srv.port, `/api/ping${q(srv.token)}`, { host: `attacker.test:${srv.port}` })).status, 403);
  assert.equal((await request(srv.port, '/api/ping')).status, 403);
  const bad = await request(srv.port, '/api/ping?t=wrong');
  assert.equal(bad.status, 403);
  assert.equal(bad.json().code, 'EFORBIDDEN');
  assert.equal((await request(srv.port, `/api/ping${q(srv.token)}`, { host: `localhost:${srv.port}` })).status, 200);
});

test('뷰어 HTML도 토큰이 있어야 주고, localhost는 127.0.0.1로 보낸다. CSP에 frame-ancestors를 더한다', async () => {
  assert.equal((await request(srv.port, '/')).status, 403);
  assert.equal((await request(srv.port, '/?t=wrong')).json().code, 'EFORBIDDEN');
  const moved = await request(srv.port, `/${q(srv.token, { f: '/x y.md' })}`, { host: `localhost:${srv.port}` });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.location, `http://127.0.0.1:${srv.port}/${q(srv.token, { f: '/x y.md' })}`);
  const r = await request(srv.port, `/${q(srv.token)}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-security-policy'], `${VIEWER_CSP}; frame-ancestors 'none'`);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.match(r.body.toString('utf8'), /<title>viewer<\/title>/);
});

test('뷰어 HTML을 읽지 못하면 500으로 답하고 원인을 로그에 남긴다', async () => {
  const h = tempDir();
  const s = await startServer({ home: h, viewerPath: path.join(h, 'none.html'), version: 't', port: 0, idleMs: 60_000, platform, logger: new Logger(path.join(h, 'logs')) });
  try {
    const r = await request(s.port, `/${q(s.token)}`);
    assert.deepEqual([r.status, r.json().code], [500, 'EIO']);
    assert.match(fs.readFileSync(path.join(h, 'logs', 'mdview.log'), 'utf8'), /\[error\] .*none\.html.*ENOENT/);
  } finally {
    await s.close('test');
  }
});

test('ready·ping: 버전, 루트, 경로 형식', async () => {
  const r = (await api('/api/ready')).json();
  assert.equal(r.version, 't');
  assert.deepEqual(r.roots, [path.resolve(docs)]);
  assert.equal(r.pathStyle, process.platform === 'win32' ? 'win' : 'posix');
  assert.equal((await api('/api/ping')).json().pid, process.pid);
});

test('읽기: 바이트와 수정 시각, 폴더 409, 크기 초과 413, 없는 파일 404, 상대 경로 400', async () => {
  const r = await api('/api/read', { path: path.join(docs, 'README.md') });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString('utf8'), '# 제목\n');
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.ok(Number(r.headers['x-mdv-mtime']) > 0);
  assert.equal((await api('/api/read', { path: docs })).json().code, 'EISDIR');
  assert.equal((await api('/api/read', { path: docs })).status, 409);
  const big = await api('/api/read', { path: path.join(docs, 'big.md') });
  assert.deepEqual([big.status, big.json().code], [413, 'ETOOBIG']);
  const none = await api('/api/read', { path: path.join(docs, '없음.md') });
  assert.deepEqual([none.status, none.json().code], [404, 'ENOENT']);
  assert.equal((await api('/api/read', { path: 'README.md' })).status, 400);
});

test('경로 검사 순서: 형식 400 → 허용 폴더 403 → 존재 404 (없는 바깥 파일도 403)', async () => {
  assert.equal((await api('/api/read', { path: 'relative/없음.md' })).status, 400);
  const missingOutside = await api('/api/read', { path: path.join(outside, '없는 폴더', '없음.md') });
  assert.deepEqual([missingOutside.status, missingOutside.json().code], [403, 'EACCES']);
  const missingInside = await api('/api/read', { path: path.join(docs, '없는 폴더', '없음.md') });
  assert.deepEqual([missingInside.status, missingInside.json().code], [404, 'ENOENT']);
  assert.equal((await api('/api/read', { path: path.join(docs, 'escape', '없음.md') })).status, 403, '링크 너머의 없는 파일');
});

test('허용 폴더 밖과 심볼릭 링크로 빠져나가기는 403 (SDD 8.4)', async () => {
  const out = await api('/api/read', { path: path.join(outside, 'secret.md') });
  assert.deepEqual([out.status, out.json().code], [403, 'EACCES']);
  const esc = await api('/api/read', { path: path.join(docs, 'escape', 'secret.md') });
  assert.deepEqual([esc.status, esc.json().code], [403, 'EACCES']);
  const dots = await api('/api/read', { path: path.join(docs, '..', path.basename(outside), 'secret.md') });
  assert.equal(dots.status, 403);
  assert.equal((await api('/api/list', { path: path.join(docs, 'escape') })).status, 403);
});

test('예상하지 못한 파일 시스템 오류(심볼릭 링크 순환)는 500으로 답하고 토큰 없이 로그에 남긴다 (NFR-REL-03)', { skip: process.platform === 'win32' }, async () => {
  const loop = path.join(docs, 'loop.md');
  fs.symlinkSync(loop, loop);
  try {
    const r = await api('/api/read', { path: loop });
    assert.deepEqual([r.status, r.json().code], [500, 'EIO']);
    const log = fs.readFileSync(path.join(home, 'logs', 'mdview.log'), 'utf8');
    assert.match(log, /\[error\] .*\/api\/read: ELOOP/);
    assert.ok(!log.includes(srv.token), '주소의 토큰은 로그에 남기지 않는다');
  } finally {
    fs.rmSync(loop, { force: true });
  }
});

test('목록: 이름과 폴더 여부를 그대로 준다 (거르기는 화면이 한다)', async () => {
  const r = await api('/api/list', { path: docs });
  const names = (r.json() as { name: string; isDir: boolean }[]).map((e) => `${e.name}:${e.isDir}`).sort();
  assert.deepEqual(names, ['README.md:false', 'big.md:false', 'escape:true', 'img:true']);
  assert.equal((await api('/api/list', { path: path.join(docs, 'README.md') })).status, 400);
});

test('이미지: 이미지 확장자만, SVG에는 스크립트를 막는 CSP', async () => {
  const png = await api('/api/file', { path: path.join(docs, 'img', 'dot.png') });
  assert.deepEqual([png.status, png.headers['content-type']], [200, 'image/png']);
  const svg = await api('/api/file', { path: path.join(docs, 'img', 'logo.svg') });
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.equal(svg.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
  const md = await api('/api/file', { path: path.join(docs, 'README.md') });
  assert.deepEqual([md.status, md.json().code], [415, 'EINVAL']);
});

test('POST는 JSON만, 64 KB까지', async () => {
  const wrongType = await request(srv.port, `/api/log${q(srv.token)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 400);
  const huge = await request(srv.port, `/api/log${q(srv.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(huge.status, 413);
  assert.equal((await postJson(srv.port, srv.token, '/api/log', { level: 'error', msg: '뷰어 오류' })).status, 204);
  const log = fs.readFileSync(path.join(home, 'logs', 'mdview.log'), 'utf8');
  assert.match(log, /\[error\] \[뷰어\] 뷰어 오류/);
  assert.equal((await postJson(srv.port, srv.token, '/api/roots', { root: 'relative' })).status, 400);
  assert.equal((await request(srv.port, `/api/nothing${q(srv.token)}`)).status, 404);
});

test('탐색기에서 위치 열기: 허용 폴더 안만 열고, 띄우지 못하면 오류로 답한다 (FR-INFO-03)', async () => {
  const file = path.join(docs, 'README.md');
  const opened: string[] = [];
  revealImpl = async (f) => (opened.push(f), true);
  assert.equal((await postJson(srv.port, srv.token, '/api/reveal', { path: file })).status, 204);
  assert.deepEqual(opened, [fs.realpathSync.native(file)]);
  assert.equal((await postJson(srv.port, srv.token, '/api/reveal', { path: path.join(outside, 'secret.md') })).status, 403);
  assert.equal(opened.length, 1, '허용 폴더 밖은 열지 않는다');
  revealImpl = async () => false;
  const missing = await postJson(srv.port, srv.token, '/api/reveal', { path: file });
  assert.deepEqual([missing.status, missing.json().code], [500, 'EIO'], '탐색기 명령이 없으면 204로 넘기지 않는다');
  revealImpl = async () => {
    throw new Error('wslpath failed');
  };
  assert.equal((await postJson(srv.port, srv.token, '/api/reveal', { path: file })).status, 500);
  assert.match(fs.readFileSync(path.join(home, 'logs', 'mdview.log'), 'utf8'), /\[warn\] .*wslpath failed/, '원인은 로그에 남긴다');
  revealImpl = async () => true;
});

test('감시: 변경·교체 저장·삭제·이름 변경·되살리기를 SSE로 알린다 (FR-WATCH-01~02)', async () => {
  const file = path.join(docs, 'watch.md');
  fs.writeFileSync(file, 'v1', 'utf8');
  const ev = openEvents(srv.port, srv.token, 'c1');
  await ev.ready;
  assert.equal((await postJson(srv.port, srv.token, '/api/watch', { client: 'c1', paths: [file, path.join(outside, 'secret.md')] })).status, 204);
  await sleep(150);
  fs.writeFileSync(file, 'v2', 'utf8');
  assert.deepEqual(await ev.next('file.changed'), { path: file });
  // 편집기식 저장: 임시 파일에 쓰고 이름을 바꾼다.
  fs.writeFileSync(file + '.tmp', 'v3-longer', 'utf8');
  fs.renameSync(file + '.tmp', file);
  assert.deepEqual(await ev.next('file.changed'), { path: file });
  fs.renameSync(file, file + '.moved');
  assert.deepEqual(await ev.next('file.deleted'), { path: file });
  fs.renameSync(file + '.moved', file);
  assert.deepEqual(await ev.next('file.changed'), { path: file });
  fs.rmSync(file);
  assert.deepEqual(await ev.next('file.deleted'), { path: file });
  ev.close();
});

test('감시: 심볼릭 링크 뒤의 .. 로 허용 폴더 밖 파일을 보지 못한다 (SDD 8.4)', async () => {
  // docs/deep → outside/deep. 'docs/deep/../x.md'는 글자로는 docs/x.md지만, OS는 링크를 먼저 따라가 outside/x.md로 푼다.
  const o = tempDir('mdv-outside-');
  fs.mkdirSync(path.join(o, 'deep'));
  fs.symlinkSync(path.join(o, 'deep'), path.join(docs, 'deep'));
  const inside = path.join(docs, 'x.md');
  const beyond = path.join(o, 'x.md');
  fs.writeFileSync(inside, 'in', 'utf8');
  fs.writeFileSync(beyond, 'out', 'utf8');
  const ev = openEvents(srv.port, srv.token, 'c-dotdot');
  await ev.ready;
  const tricky = `${docs}${path.sep}deep${path.sep}..${path.sep}x.md`;
  assert.equal((await postJson(srv.port, srv.token, '/api/watch', { client: 'c-dotdot', paths: [tricky] })).status, 204);
  await sleep(150);
  fs.writeFileSync(beyond, 'out-changed', 'utf8');
  await assert.rejects(ev.next('file.changed', 600), '허용 폴더 밖 파일의 변경은 알리지 않는다');
  fs.writeFileSync(inside, 'in-changed', 'utf8');
  assert.deepEqual(await ev.next('file.changed'), { path: inside }, '검사한 경로(.. 을 접은 경로)를 감시한다');
  ev.close();
});

test('연결된 뷰어 없이 유휴 시간이 지나면 끝나고, 포트·토큰은 다음 서버가 다시 쓴다 (FR-LAUNCH-03)', async () => {
  const h = tempDir();
  const viewer = makeViewer(h);
  const a = await startServer({ home: h, viewerPath: viewer, version: 't', port: 0, idleMs: 200, platform });
  const ev = openEvents(a.port, a.token, 'x');
  await ev.ready;
  await sleep(400);
  assert.equal((await request(a.port, `/api/ping${q(a.token)}`)).status, 200, '뷰어가 붙어 있으면 끝나지 않는다');
  ev.close();
  await Promise.race([a.closed, sleep(3000).then(() => assert.fail('끝나지 않음'))]);
  const st = readState(h)!;
  assert.deepEqual([st.port, st.token, st.pid], [a.port, a.token, null]);
  const b = await startServer({ home: h, viewerPath: viewer, version: 't', idleMs: 60_000, platform });
  assert.deepEqual([b.port, b.token], [a.port, a.token]);
  await b.close('test');
});

test('토큰이 맞는 요청은 유휴 시간을 새로 센다: 오래 쉬던 실행기를 다시 써도 낸 주소가 바로 끊기지 않는다 (FR-LAUNCH-03)', async () => {
  const h = tempDir();
  const a = await startServer({ home: h, viewerPath: makeViewer(h), version: 't', port: 0, idleMs: 400, platform });
  for (let i = 1; i <= 5; i++) {
    await sleep(100);
    assert.equal((await request(a.port, `/api/ping${q(a.token, { use: '1' })}`)).status, 200, `${i * 100} ms`);
  }
  await Promise.race([a.closed, sleep(3000).then(() => assert.fail('요청이 끊긴 뒤에도 끝나지 않음'))]);
});

test('상태만 묻는 ping(use 없음)은 유휴 시간을 새로 세지 않는다: 지켜보는 것만으로 실행기가 남지 않는다 (FR-LAUNCH-03)', async () => {
  const h = tempDir();
  const a = await startServer({ home: h, viewerPath: makeViewer(h), version: 't', port: 0, idleMs: 300, platform });
  let closed = false;
  void a.closed.then(() => (closed = true));
  const t0 = Date.now();
  while (!closed && Date.now() - t0 < 3000) {
    await request(a.port, `/api/ping${q(a.token)}`).catch(() => null);
    await sleep(50);
  }
  assert.ok(closed, '상태만 묻는 동안 끝나지 않음');
});

test('setTimeout 상한을 넘는 유휴 시간(MDVIEW_IDLE_MS)이어도 바로 끝나지 않는다', async () => {
  const h = tempDir();
  const a = await startServer({ home: h, viewerPath: makeViewer(h), version: 't', port: 0, idleMs: 3_000_000_000, platform });
  await sleep(100);
  assert.equal((await request(a.port, `/api/ping${q(a.token)}`)).status, 200);
  await a.close('test');
});

test('명령에 준 포트(--port)가 state.json의 지난 포트보다 앞선다', async () => {
  const h = tempDir();
  const viewer = makeViewer(h);
  const a = await startServer({ home: h, viewerPath: viewer, version: 't', port: 0, idleMs: 60_000, platform });
  await a.close('test');
  const free = await startServer({ home: tempDir(), viewerPath: viewer, version: 't', port: 0, idleMs: 60_000, platform });
  const want = free.port;
  await free.close('test');
  const b = await startServer({ home: h, viewerPath: viewer, version: 't', port: want, idleMs: 60_000, platform });
  assert.equal(b.port, want);
  assert.notEqual(b.port, a.port);
  assert.equal(b.token, a.token, '토큰은 이어 쓴다');
  await b.close('test');
  const c = await startServer({ home: h, viewerPath: viewer, version: 't', idleMs: 60_000, platform });
  assert.equal(c.port, want, '포트를 주지 않으면 지난 포트');
  await c.close('test');
});

test('선호 포트를 다른 프로그램이 쓰면 빈 포트를 고른다', async () => {
  const h = tempDir();
  const b = await startServer({ home: h, viewerPath: makeViewer(h), version: 't', port: srv.port, idleMs: 60_000, platform });
  assert.notEqual(b.port, srv.port);
  await b.close('test');
});

/** 이 환경에서 1024 아래 포트를 열면 EACCES가 나는지 (root이거나 sysctl로 낮췄으면 아니다) */
function lowPortsDenied(): boolean {
  if (process.platform === 'win32' || process.getuid?.() === 0) return false;
  try {
    return Number(fs.readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')) > 1;
  } catch {
    return false;
  }
}

test('선호 포트를 쓸 권한이 없으면(EACCES) 빈 포트를 고른다', { skip: !lowPortsDenied() }, async () => {
  const h = tempDir();
  const b = await startServer({ home: h, viewerPath: makeViewer(h), version: 't', port: 1, idleMs: 60_000, platform });
  assert.notEqual(b.port, 1);
  assert.equal(readState(h)!.port, b.port, '고른 포트를 다음 실행이 먼저 쓴다');
  await b.close('test');
});

test('허용 폴더는 state.json에 남아 다시 뜬 서버가 이어 받는다. 사라진 폴더는 버리고 100개까지만 둔다', async () => {
  const h = tempDir();
  const viewer = makeViewer(h);
  const keep = path.join(tempDir('mdv-root-'), '유지');
  const gone = path.join(tempDir('mdv-root-'), '사라짐');
  fs.mkdirSync(keep);
  fs.mkdirSync(gone);
  fs.writeFileSync(path.join(keep, 'a.md'), '# a', 'utf8');
  const a = await startServer({ home: h, viewerPath: viewer, version: 't', port: 0, idleMs: 60_000, platform });
  assert.equal((await postJson(a.port, a.token, '/api/roots', { root: keep })).status, 204);
  assert.equal((await postJson(a.port, a.token, '/api/roots', { root: gone })).status, 204);
  assert.deepEqual(readState(h)!.roots, [keep, gone]);
  await a.close('test');
  fs.rmSync(gone, { recursive: true });
  const b = await startServer({ home: h, viewerPath: viewer, version: 't', idleMs: 60_000, platform });
  assert.deepEqual((await request(b.port, `/api/ready${q(b.token)}`)).json().roots, [keep]);
  const read = await request(b.port, `/api/read${q(b.token, { path: path.join(keep, 'a.md') })}`);
  assert.equal(read.body.toString('utf8'), '# a', '다시 뜬 서버가 전에 연 문서를 준다');
  const many = tempDir('mdv-many-');
  for (let i = 0; i < 105; i++) {
    fs.mkdirSync(path.join(many, `r${i}`));
    b.addRoot(path.join(many, `r${i}`));
  }
  const roots = readState(h)!.roots;
  assert.equal(roots.length, 100);
  assert.equal(roots.at(-1), path.join(many, 'r104'));
  assert.ok(!roots.includes(keep), '가장 오래된 것부터 버린다');
  await b.close('test');
});

test('홈 폴더는 0700, state.json은 0600으로 만든다', { skip: process.platform === 'win32' }, async () => {
  const h = path.join(tempDir(), 'new-home');
  const a = await startServer({ home: h, viewerPath: makeViewer(tempDir()), version: 't', port: 0, idleMs: 60_000, platform });
  assert.equal(fs.statSync(h).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(h, 'state.json')).mode & 0o777, 0o600);
  await a.close('test');
});

/** 뷰어 페이지가 보내는 모양의 쓰기 요청 */
const write = (file: string, body: string | Buffer, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  request(srv.port, `/api/write${q(srv.token, { path: file, ...extra })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', origin: `http://127.0.0.1:${srv.port}`, ...headers },
    body,
  });

test('쓰기: 바이트를 그대로 원자적으로 쓰고 수정 시각·크기를 돌려준다. 임시 파일이 남지 않는다 (FR-EDIT-04, NFR-SEC-05)', async () => {
  const file = path.join(docs, '쓰기 시험.md');
  fs.writeFileSync(file, 'old', 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('# 새 내용\r\n본문\r\n', 'utf8')]);
  const r = await write(file, bytes);
  assert.equal(r.status, 200);
  const st = fs.statSync(file);
  assert.deepEqual(r.json(), { mtime: Math.round(st.mtimeMs), size: bytes.length });
  assert.deepEqual(fs.readFileSync(file), bytes, 'BOM·CRLF까지 바이트가 같다');
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o640, '원래 권한을 지킨다');
  assert.deepEqual(fs.readdirSync(docs).filter((n) => n.endsWith('.tmp')), [], '임시 파일이 남지 않는다');
  // 읽은 그대로의 기준(수정 시각·크기)이면 덮어쓴다.
  const again = await write(file, 'v2', { baseMtime: String(r.json().mtime), baseSize: String(bytes.length) });
  assert.equal(again.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2');
});

test('쓰기: 읽은 뒤 바뀌었으면 409 ECONFLICT, 새 파일 자리에 파일이 있으면 409 EEXIST (FR-EDIT-05·09)', async () => {
  const file = path.join(docs, 'conflict.md');
  fs.writeFileSync(file, 'base', 'utf8');
  const base = fs.statSync(file);
  fs.writeFileSync(file, 'changed outside', 'utf8');
  const c = await write(file, 'mine', { baseMtime: String(Math.round(base.mtimeMs)), baseSize: String(base.size) });
  assert.deepEqual([c.status, c.json().code], [409, 'ECONFLICT']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed outside', '덮어쓰지 않는다');
  const exists = await write(file, 'new', { create: '1' });
  assert.deepEqual([exists.status, exists.json().code], [409, 'EEXIST']);
  assert.equal((await write(file, 'new', { create: '1', overwrite: '1' })).status, 200);
  const fresh = path.join(docs, '새 문서.md');
  assert.equal((await write(fresh, '# 새 문서\n', { create: '1' })).status, 200);
  assert.equal(fs.readFileSync(fresh, 'utf8'), '# 새 문서\n');
  assert.deepEqual([(await write(path.join(docs, 'none.md'), 'x')).status], [404], 'create 없이 없는 파일에는 쓰지 않는다');
  assert.equal((await write(path.join(docs, '없는 폴더', 'a.md'), 'x', { create: '1' })).status, 404, '상위 폴더가 없으면 404');
  assert.deepEqual([(await write(path.join(docs, 'img'), 'x')).status], [403], '확장자가 문서가 아니면(폴더 포함) 거부');
});

test('쓰기 거부: 토큰·Origin·형식·허용 폴더 밖·심볼릭 링크 탈출·문서가 아닌 확장자·크기 상한 (NFR-SEC-02·05)', async () => {
  const file = path.join(docs, 'README.md');
  const before = fs.readFileSync(file);
  const noToken = await request(srv.port, `/api/write?path=${encodeURIComponent(file)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: `http://127.0.0.1:${srv.port}` }, body: 'x',
  });
  assert.equal(noToken.status, 403);
  assert.equal((await write(file, 'x', {}, { origin: 'http://evil.example' })).status, 403, '다른 출처');
  assert.equal((await write(file, 'x', {}, { origin: '' })).status, 403, 'Origin 없음');
  assert.equal((await write(file, 'x', {}, { 'content-type': 'text/plain' })).status, 400, 'octet-stream만');
  assert.equal((await write(file, 'x', {}, { 'content-type': 'application/json' })).status, 400);
  assert.deepEqual([(await write(path.join(outside, 'secret.md'), 'x')).status], [403], '허용 폴더 밖');
  assert.deepEqual([(await write(path.join(docs, 'escape', 'secret.md'), 'x')).status], [403], '심볼릭 링크로 빠져나가기');
  assert.deepEqual([(await write(path.join(docs, '..', path.basename(outside), 'secret.md'), 'x')).status], [403], '.. 로 빠져나가기');
  assert.deepEqual([(await write(path.join(docs, 'run.sh'), 'x', { create: '1' })).status], [403], '문서가 아닌 확장자');
  assert.equal(fs.existsSync(path.join(docs, 'run.sh')), false);
  assert.deepEqual([(await write(path.join(docs, 'img', 'dot.png'), 'x')).status], [403]);
  assert.equal((await write(file, Buffer.alloc(2048, 0x61))).status, 413, '크기 상한(maxBytes)');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'secret');
  assert.deepEqual(fs.readFileSync(file), before, '거부한 요청은 파일을 바꾸지 않는다');
});
