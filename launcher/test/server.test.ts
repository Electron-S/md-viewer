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
  srv = await startServer({ home, viewerPath: makeViewer(home), version: 't', port: 0, idleMs: 60_000, maxBytes: 1024, platform, logger: new Logger(path.join(home, 'logs')) });
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
