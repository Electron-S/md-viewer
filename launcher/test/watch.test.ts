import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDrvfsPath, isUncPath, isWindowsPathArg, needsPolling } from '../os';
import { Watcher, type WatchEvent } from '../watch';
import { sleep, tempDir } from './helpers';

async function waitFor(events: WatchEvent[], type: WatchEvent['type'], timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const i = events.findIndex((e) => e.type === type);
    if (i >= 0) return events.splice(i, 1)[0];
    await sleep(30);
  }
  throw new Error(`no ${type}`);
}

test('OS 판별은 os.ts 한 곳에: drvfs·UNC·Windows 경로 인자, 폴링 대상 (NFR-PORT-02)', () => {
  assert.equal(isDrvfsPath('/mnt/c/Users/a.md', true), true);
  assert.equal(isDrvfsPath('/mnt/c', true), true);
  assert.equal(isDrvfsPath('/mnt/c/Users/a.md', false), false);
  assert.equal(isDrvfsPath('/mnt/data/a.md', true), false);
  assert.equal(isUncPath('\\\\srv\\share\\a.md'), true);
  assert.equal(isUncPath('//srv/share/a.md'), true);
  assert.equal(isUncPath('/home/a.md'), false);
  assert.equal(needsPolling('/mnt/d/x.md', { wsl: true }), true);
  assert.equal(needsPolling('/home/me/a.md', { wsl: true }), false);
  assert.equal(isWindowsPathArg('C:\\Users\\a.md'), true);
  assert.equal(isWindowsPathArg('c:/Users/a.md'), true);
  assert.equal(isWindowsPathArg('\\\\wsl.localhost\\Ubuntu\\home\\a.md'), true);
  assert.equal(isWindowsPathArg('\\\\wsl$\\Ubuntu\\home\\a.md'), true);
  assert.equal(isWindowsPathArg('\\\\srv\\share\\a.md'), false);
  assert.equal(isWindowsPathArg('docs/a.md'), false);
});

test('폴링으로도 변경·삭제·되살리기를 알린다 (WSL Windows 드라이브용)', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'v1', 'utf8');
  const events: WatchEvent[] = [];
  const w = new Watcher((e) => events.push(e), { poll: () => true, pollMs: 50, debounceMs: 20 });
  w.setPaths([file]);
  await sleep(120);
  fs.writeFileSync(file, 'v2-longer', 'utf8');
  assert.deepEqual(await waitFor(events, 'changed'), { type: 'changed', path: file });
  fs.rmSync(file);
  assert.deepEqual(await waitFor(events, 'deleted'), { type: 'deleted', path: file });
  fs.writeFileSync(file, 'back', 'utf8');
  assert.deepEqual(await waitFor(events, 'changed'), { type: 'changed', path: file });
  w.setPaths([]);
  assert.deepEqual(w.watching, []);
  w.close();
});

test('같은 폴더의 두 파일은 감시 하나를 나눠 쓰고, 다른 파일 변경은 알리지 않는다', async () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  fs.writeFileSync(a, '1', 'utf8');
  fs.writeFileSync(b, '1', 'utf8');
  const events: WatchEvent[] = [];
  const w = new Watcher((e) => events.push(e), { debounceMs: 20 });
  w.setPaths([a, b]);
  await sleep(50);
  fs.writeFileSync(path.join(dir, 'other.md'), 'x', 'utf8');
  fs.writeFileSync(b, '22', 'utf8');
  assert.deepEqual(await waitFor(events, 'changed'), { type: 'changed', path: b });
  await sleep(150);
  assert.deepEqual(events, [], 'a는 바뀌지 않았다');
  w.close();
});
