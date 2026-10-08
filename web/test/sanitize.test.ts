import { dom } from './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSanitizer, type SanitizeContext } from '../src/render/sanitize';
import { createMarkdown, renderMarkdown } from '../src/render/markdown';

const s = createSanitizer(dom.window as unknown as Window);
const api = (p: string) => '/api/file?path=' + encodeURIComponent(p);
const ctx: SanitizeContext = { docDir: 'C:\\docs\\guide', allowRemoteImages: true, imageUrl: api };

function clean(html: string, c: SanitizeContext = ctx): HTMLElement {
  const div = dom.window.document.createElement('div');
  div.append(s.sanitize(html, c));
  return div as unknown as HTMLElement;
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<svg onload=alert(1)><circle r=1></circle></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<iframe src="https://evil.example"></iframe>',
  '<object data="x.swf"></object><embed src="x.swf">',
  '<style>body{display:none}</style>',
  '<div style="position:fixed;inset:0">덮기</div>',
  '<form action="https://evil.example"><input name=q><button>go</button></form>',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<details open ontoggle=alert(1)>x</details>',
  '<video><source onerror=alert(1)></video>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<img src="x" srcset="javascript:alert(1) 1x">',
  '<img src="a.png" srcset="http://127.0.0.1:7787/api/file?path=/etc/x 1x">',
  '<table background="http://127.0.0.1:7787/x"><tr><td background="http://evil.example/y">x</td></tr></table>',
  '<video poster="http://evil.example/p.png"></video><audio src="http://evil.example/a.mp3"></audio><picture><source srcset="http://evil.example/s.png"></picture>',
  '<body onload=alert(1)>',
  '<link rel=stylesheet href="https://evil.example/x.css">',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<input type="text" autofocus onfocus=alert(1)>',
];

test('XSS 페이로드에서 실행 가능한 요소·속성이 남지 않는다 (NFR-SEC-01)', () => {
  for (const p of PAYLOADS) {
    const root = clean(p);
    const all = [root, ...Array.from(root.querySelectorAll('*'))];
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      assert.ok(!['script', 'iframe', 'object', 'embed', 'style', 'form', 'base', 'meta', 'link', 'body', 'video', 'audio', 'source', 'picture'].includes(tag), `${p} → <${tag}>`);
      for (const attr of Array.from(el.attributes)) {
        assert.ok(!/^on/i.test(attr.name), `${p} → ${attr.name}`);
        assert.ok(!['style', 'srcset', 'background', 'poster', 'ping'].includes(attr.name), `${p} → ${attr.name}`);
        assert.ok(!/^\s*(javascript|vbscript|data:text)/i.test(attr.value), `${p} → ${attr.name}=${attr.value}`);
      }
      if (tag === 'input') assert.equal(el.getAttribute('type'), 'checkbox', p);
    }
  }
});

test('마크다운 원문 HTML도 같은 정제를 거친다', () => {
  const { html } = renderMarkdown(createMarkdown(), '# 제목\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n');
  const root = clean(html);
  assert.equal(root.querySelector('[onerror]'), null);
  assert.equal(root.querySelector('a[href^="javascript"]'), null);
  assert.equal(root.querySelector('h1')?.id, '제목');
});

test('링크 변환: 로컬 문서·조각·외부 (FR-NAV-03)', () => {
  const root = clean(
    '<a href="../api/설치.md#빠른-시작">a</a><a href="#intro">b</a><a href="https://example.com/x">c</a>' +
      '<a href="mailto:me@example.com">d</a><a href="file:///D:/notes/x.md">e</a><a href="a%20b.md">f</a>',
  );
  const a = Array.from(root.querySelectorAll('a'));
  assert.equal(a[0].getAttribute('data-mdv-path'), 'C:\\docs\\api\\설치.md');
  assert.equal(a[0].getAttribute('data-mdv-frag'), '빠른-시작');
  assert.equal(a[1].getAttribute('data-mdv-frag'), 'intro');
  assert.equal(a[1].hasAttribute('data-mdv-path'), false);
  assert.equal(a[2].getAttribute('data-mdv-ext'), 'https://example.com/x');
  assert.equal(a[3].getAttribute('data-mdv-ext'), 'mailto:me@example.com');
  assert.equal(a[4].hasAttribute('data-mdv-path'), false, 'file: 스킴은 열지 않는다 (SRS 4.3)');
  assert.equal(a[4].hasAttribute('href'), false);
  assert.equal(a[5].getAttribute('data-mdv-path'), 'C:\\docs\\guide\\a b.md');
});

test('이미지 변환: 로컬은 브리지 주소, 원격은 설정에 따라 (FR-REN-03, NFR-SEC-03)', () => {
  const html = '<img src="img/그림 1.png"><img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml,<svg/>">';
  let imgs = Array.from(clean(html).querySelectorAll('img'));
  assert.equal(imgs[0].getAttribute('src'), api('C:\\docs\\guide\\img\\그림 1.png'));
  assert.equal(imgs[1].getAttribute('src'), 'https://example.com/a.png');
  assert.equal(imgs[2].getAttribute('src'), 'data:image/png;base64,AAAA');
  assert.equal(imgs[3].hasAttribute('src'), false);
  imgs = Array.from(clean(html, { ...ctx, allowRemoteImages: false }).querySelectorAll('img'));
  assert.equal(imgs[1].hasAttribute('src'), false);
  assert.equal(imgs[1].getAttribute('data-mdv-blocked'), 'https://example.com/a.png');
  // 파일 핸들 브리지는 주소를 나중에 준다: 위치만 data-mdv-src로 남긴다.
  imgs = Array.from(clean('<img src="../img/a.png">', { ...ctx, docDir: 'mdv:/d1/guide', imageUrl: () => null }).querySelectorAll('img'));
  assert.equal(imgs[0].hasAttribute('src'), false);
  assert.equal(imgs[0].getAttribute('data-mdv-src'), 'mdv:/d1/img/a.png');
});

test('POSIX 문서: /x는 실행기 루트 기준, 다른 형식의 경로는 막는다 (SDD 5.2)', () => {
  const c = { ...ctx, docDir: '/home/me/repo/docs', docRoot: '/home/me/repo' };
  const root = clean('<img src="/img/a.png"><img src="C:\\x.png"><a href="../README.md">r</a>', c);
  const imgs = Array.from(root.querySelectorAll('img'));
  assert.equal(imgs[0].getAttribute('src'), api('/home/me/repo/img/a.png'));
  assert.equal(imgs[1].hasAttribute('src'), false);
  assert.equal(root.querySelector('a')?.getAttribute('data-mdv-path'), '/home/me/repo/README.md');
});

test('문서가 쓴 루프백·실행기 주소 이미지는 지우고, 링크는 눌러야 열리는 외부 링크로 둔다 (NFR-SEC-02, SDD 8.4)', () => {
  const root = clean(
    '<img src="http://127.0.0.1:7787/api/file?path=/etc/passwd"><img src="http://[::1]/a.png"><img src="http://2130706433/x.png">' +
      '<a href="http://localhost:7787/api/stop">a</a><a href="http://10.0.0.9:7787/x">b</a>',
    { ...ctx, selfOrigin: 'http://10.0.0.9:7787' },
  );
  assert.ok(Array.from(root.querySelectorAll('img')).every((i) => !i.hasAttribute('src')));
  const links = Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('data-mdv-ext'));
  assert.deepEqual(links, ['http://localhost:7787/api/stop', 'http://10.0.0.9:7787/x'], '토큰 없이 새 탭으로 열리므로 위험하지 않다');
});

test('표 열 정렬은 정제 뒤에도 남는다 (FR-REN-01)', () => {
  const { html } = renderMarkdown(createMarkdown(), '| 왼 | 가운데 | 오른 |\n| :-- | :-: | --: |\n| a | b | c |\n');
  const ths = Array.from(clean(html).querySelectorAll('th'));
  assert.deepEqual(ths.map((t) => t.getAttribute('align')), ['left', 'center', 'right']);
});

test('작업 목록 체크박스는 비활성으로 남는다', () => {
  const { html } = renderMarkdown(createMarkdown(), '- [x] 완료\n');
  const box = clean(html).querySelector('input');
  assert.equal(box?.getAttribute('type'), 'checkbox');
  assert.ok(box?.hasAttribute('disabled'));
  assert.ok(box?.hasAttribute('checked'));
});

test('다른 네트워크 공유는 막고, 같은 공유는 허용 (리뷰 #1)', () => {
  const html = '<img src="//evil-host/share/a.png"><img src="\\\\evil\\s\\b.png"><a href="//evil/share/x.md">a</a>';
  const root = clean(html);
  const imgs = Array.from(root.querySelectorAll('img'));
  assert.ok(imgs.every((i) => !i.hasAttribute('src')), imgs.map((i) => i.getAttribute('src')).join(' | '));
  const links = Array.from(root.querySelectorAll('a'));
  assert.ok(links.every((a) => !a.hasAttribute('data-mdv-path') && !a.hasAttribute('data-mdv-ext') && !a.hasAttribute('href')));
  const unc = clean('<img src="img/a.png"><a href="../b.md">b</a>', { ...ctx, docDir: '\\\\nas\\docs\\guide' });
  assert.equal(unc.querySelector('img')?.getAttribute('src'), api('\\\\nas\\docs\\guide\\img\\a.png'));
  assert.equal(unc.querySelector('a')?.getAttribute('data-mdv-path'), '\\\\nas\\docs\\b.md');
});

test('문서가 직접 쓴 data-mdv-* 속성은 지운다 (리뷰 #2)', () => {
  const root = clean('<a data-mdv-path="\\\\evil\\s\\x.md">a</a><a href="foo.md" data-mdv-ext="https://phish.example">b</a><img src="x.png" data-mdv-blocked="y">');
  const [a, b] = Array.from(root.querySelectorAll('a'));
  assert.equal(a.hasAttribute('data-mdv-path'), false);
  assert.equal(b.getAttribute('data-mdv-ext'), null);
  assert.equal(b.getAttribute('data-mdv-path'), 'C:\\docs\\guide\\foo.md');
  assert.equal(root.querySelector('img')?.hasAttribute('data-mdv-blocked'), false);
});

test('SVG 안 외부 참조(image, use)는 지운다', () => {
  const root = clean('<svg><image href="https://example.com/t.png"></image><use href="https://example.com/s.svg#a"></use><circle r="1"></circle></svg>');
  assert.equal(root.querySelector('image, use'), null);
  assert.ok(root.querySelector('circle'));
});

test('그리지 못한 블록의 오류 상자는 정제를 거쳐도 남는다 (FR-REN-04)', () => {
  const md = createMarkdown();
  md.renderer.rules.fence = () => {
    throw new Error('x');
  };
  const div = clean(renderMarkdown(md, '앞\n\n```\n<img src=x onerror=alert(1)>\n```\n').html);
  const box = div.querySelector('div.mdv-block-error[data-line="2"]')!;
  assert.ok(box.querySelector('p.mdv-render-error'));
  assert.equal(box.querySelector('pre.mdv-plain')!.textContent, '```\n<img src=x onerror=alert(1)>\n```');
  assert.equal(div.querySelector('img'), null);
});
