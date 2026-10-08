import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAs, decodeBytes, detectEol } from '../src/encoding';
import { toHostDoc } from '../src/bridge/listing';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16 = (s: string, be: boolean) => {
  const out = new Uint8Array(2 + s.length * 2);
  out.set(be ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = be ? c >> 8 : c & 0xff;
    out[3 + i * 2] = be ? c & 0xff : c >> 8;
  }
  return out;
};

test('인코딩 판별: UTF-8, BOM, UTF-16, CP949 (NFR-ENC-01)', () => {
  const s = '한글 문서입니다 abc ✓';
  let r = decodeBytes(utf8(s));
  assert.deepEqual([r.encoding, r.text, r.hasBom, r.decodeWarning], ['utf-8', s, false, false]);
  r = decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(s)]));
  assert.deepEqual([r.encoding, r.text, r.hasBom], ['utf-8', s, true]);
  r = decodeBytes(utf16(s, false));
  assert.deepEqual([r.encoding, r.text, r.hasBom], ['utf-16le', s, true]);
  r = decodeBytes(utf16(s, true));
  assert.deepEqual([r.encoding, r.text, r.hasBom], ['utf-16be', s, true]);
  // '한글 문서입니다. 가나다라'를 CP949(EUC-KR 범위)로 인코딩한 바이트
  r = decodeBytes(hex('c7d1b1db20b9aebcadc0d4b4cfb4d92e20b0a1b3aab4d9b6f3'));
  assert.deepEqual([r.encoding, r.text, r.decodeWarning], ['cp949', '한글 문서입니다. 가나다라', false]);
  // '똠'(0x8C63)은 CP949 확장 영역이다. 브라우저(WHATWG euc-kr = windows-949)는 풀지만 Node의 ICU는 못 푼다.
  // 그런 디코더에서도 CP949로 잘못 판정하지 않는지만 본다. 브라우저 동작은 E2E가 본다.
  const uhc = hex('c7d1b1db208c63b9e6');
  r = decodeBytes(uhc);
  if (new TextDecoder('euc-kr').decode(hex('8c63')) === '똠') assert.deepEqual([r.encoding, r.text], ['cp949', '한글 똠방']);
  else assert.notEqual(r.encoding, 'cp949');
  assert.equal(decodeBytes(utf8('# plain ascii\n')).encoding, 'utf-8', 'ascii는 utf-8');
});

test('깨진 바이트·바이너리에서 멈추지 않는다 (NFR-ENC-02, NFR-REL-01)', () => {
  let r = decodeBytes(Uint8Array.from([0x41, 0x80, 0x42, 0xff]));
  assert.ok(r.decodeWarning, '경고 켜짐');
  assert.ok(r.text.includes('\uFFFD'), '대체 문자');
  r = decodeBytes(hex('636166e9206175206c616974')); // 'café au lait' (Windows-1252)
  assert.ok(r.decodeWarning && r.encoding === 'utf-8', 'Windows-1252는 CP949로 오판하지 않는다');
  r = decodeBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x10]));
  assert.ok(r.binary, 'NUL이 있으면 바이너리');
  r = decodeBytes(new Uint8Array(0));
  assert.deepEqual([r.text, r.encoding, r.binary, r.eol], ['', 'utf-8', false, 'None'], '빈 파일');
  r = decodeAs(Uint8Array.from([0xff, 0xfe, 0x41]), 'utf-16le');
  assert.ok(r.decodeWarning && r.hasBom, '홀수 바이트 UTF-16');
  r = decodeBytes(utf8('한글'), 'cp949');
  assert.equal(r.encoding, 'cp949', '수동 지정은 그대로 따른다');
  assert.ok(r.decodeWarning);
});

test('줄 끝 판별', () => {
  assert.equal(detectEol('a\r\nb\r\n'), 'CRLF');
  assert.equal(detectEol('a\nb'), 'LF');
  assert.equal(detectEol('a\rb'), 'CR');
  assert.equal(detectEol('a\r\nb\n'), 'Mixed');
  assert.equal(detectEol('ab'), 'None');
});

test('파일 읽기 결과: 종류·줄 끝·BOM·바이너리 (FR-FILE-08, NFR-ENC-03)', () => {
  let d = toHostDoc('/docs/한글 문서.md', Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('# 제목\r\n본문\r\n')]), 5);
  assert.deepEqual([d.text, d.kind, d.eol, d.hasBom, d.binary, d.size, d.mtime], ['# 제목\r\n본문\r\n', 'markdown', 'CRLF', true, false, 21, 5]);
  d = toHostDoc('C:\\메모.txt', hex('b8deb8f00a'), 0);
  assert.deepEqual([d.kind, d.encoding, d.text], ['text', 'cp949', '메모\n']);
  d = toHostDoc('C:\\메모.txt', hex('b8deb8f00a'), 0, 'utf-8');
  assert.equal(d.decodeWarning, true, '강제 utf-8은 경고');
  d = toHostDoc('/x.md', Uint8Array.from([1, 0, 2]), 0);
  assert.deepEqual([d.binary, d.text, d.eol], [true, '', 'None']);
});
