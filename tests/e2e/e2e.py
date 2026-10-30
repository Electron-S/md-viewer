# MD Viewer E2E 테스트 (SDD 9.3). Windows Python + Playwright로 Edge를 조종한다.
#   실행기 모드: WSL에서 띄운 실행기(--no-open)가 낸 주소를 Edge로 연다. 문서는 WSL 디스크에 두고 \\wsl.localhost로 고친다.
#   독립 모드: Windows 디스크의 viewer.html을 file://로 열고, 끌어다 놓기(CDP)·파일 입력으로 문서를 연다.
#   Windows 앱: MDViewer.exe를 원격 디버깅 포트(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)로 띄워 그 WebView2에 CDP로 붙는다.
#   python e2e.py --distro <WSL 배포판> --node <WSL의 node> --work <WSL 작업 폴더> --viewer <viewer.html> --exe <MDViewer.exe> --out <결과 폴더> [--headed]
# CP949 문제를 피하려고 파일은 바이트나 encoding='utf-8'로만 읽고 쓰며, 표준 출력과 하위 프로세스 출력도 UTF-8로 다룬다.
import argparse
import base64
import ctypes
import ctypes.wintypes as wt
import faulthandler
import http.client
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
import winreg
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
faulthandler.dump_traceback_later(2400, exit=True)  # 어디서 멈췄는지 남기고 끝낸다

ap = argparse.ArgumentParser()
ap.add_argument('--distro', required=True)
ap.add_argument('--node', required=True)
ap.add_argument('--work', required=True, help='WSL 쪽 작업 폴더(POSIX 경로)')
ap.add_argument('--viewer', required=True, help='독립 모드로 열 viewer.html(Windows 경로)')
ap.add_argument('--exe', required=True, help='Windows 앱 MDViewer.exe(Windows 경로)')
ap.add_argument('--out', required=True)
ap.add_argument('--headed', action='store_true')
ap.add_argument('--only', choices=['desktop'], help='이 시나리오만 돌린다(디버깅용)')
ARGS = ap.parse_args()

DISTRO = ARGS.distro
NODE = ARGS.node
WORK_P = ARGS.work.rstrip('/')
WORK = pathlib.Path('\\\\wsl.localhost\\' + DISTRO + WORK_P.replace('/', '\\'))
MJS = WORK_P + '/app/mdview.mjs'
VIEWER = pathlib.Path(ARGS.viewer)
EXE = pathlib.Path(ARGS.exe)
OUT = pathlib.Path(ARGS.out)
OUT.mkdir(parents=True, exist_ok=True)
HEADLESS = not ARGS.headed
LOCAL = pathlib.Path(tempfile.mkdtemp(prefix='mdv-e2e-'))  # Windows 쪽: 브라우저 프로필, 독립 모드 문서
DOCS = WORK / '문서 모음'
SA = LOCAL / '독립 문서'
RESULTS = []
LAUNCHERS = []
PNG_1PX = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
RETIRED_TITLE = 'MD Viewer (새 탭으로 옮겨짐)'


def P(path: pathlib.Path) -> str:
    """\\wsl.localhost 아래 경로를 WSL(실행기·뷰어)이 쓰는 POSIX 경로로 바꾼다."""
    return WORK_P + '/' + path.relative_to(WORK).as_posix()


# ---------------------------------------------------------------- 결과 기록

def check(rid, name, cond, detail: object = ''):
    RESULTS.append({'id': rid, 'name': name, 'ok': bool(cond), 'detail': str(detail)})
    print(('ok    ' if cond else 'FAIL  ') + f'{rid} {name}' + (f' — {detail}' if detail != '' else ''), flush=True)


def guard(rid, name, fn):
    try:
        fn()
    except Exception as e:
        check(rid, name, False, f'예외: {e}\n{traceback.format_exc(limit=4)}')


def shot(v, name):
    try:
        v.page.screenshot(path=str(OUT / f'{name}.png'))
    except Exception:
        pass


def settled(get, timeout=3.0):
    """get() 값이 0.3초 동안 그대로일 때까지 기다려 그 값을 돌려준다.
    늦게 그려지는 블록이 위치를 밀 수 있으므로, 허용치에 처음 들어온 값이 아니라 멈춘 값으로 판정한다."""
    end = time.time() + timeout
    last, since = get(), time.time()
    while time.time() < end:
        time.sleep(0.1)
        v = get()
        if v is not None and last is not None and abs(v - last) < 0.05:
            if time.time() - since >= 0.3:
                return v
        else:
            since = time.time()
        last = v
    return last


# ---------------------------------------------------------------- 문서 준비

def write(path: pathlib.Path, text: str, encoding='utf-8'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode(encoding))
    return path


def replace_file(src: pathlib.Path, dst: pathlib.Path) -> int:
    """임시 파일로 대상을 바꾼다(원자적 저장). \\\\wsl.localhost 너머의 교체는 Windows 쪽의 다른 프로세스가 방금 쓴 파일을
    잠깐 열고 있으면 액세스 거부(WinError 5)로 실패하므로 잠시 뒤 다시 한다. 다시 한 횟수를 돌려준다."""
    for n in range(20):
        try:
            os.replace(src, dst)
            return n
        except PermissionError:
            time.sleep(0.05)
    os.replace(src, dst)
    return 20


def readme_text():
    return '\n'.join([
        '# 사용 설명서',
        '',
        '이 문서는 **E2E** 테스트용입니다. 찾기 대상 단어: 사과, 사과, 사과.',
        '',
        '## 표와 목록',
        '',
        '| 항목 | 값 |',
        '| --- | --- |',
        '| 시작 | 1.5초 |',
        '',
        '- [x] 완료한 일',
        '- [ ] 남은 일',
        '',
        '## 코드',
        '',
        '```python',
        'def hello():',
        '    return "안녕"',
        '```',
        '',
        '## 링크와 그림',
        '',
        '[다른 문서의 둘째 절](other.md#둘째-절) · [외부](https://example.com) · [메모](notes.txt) · [로컬 서버](http://localhost:3000)',
        '',
        '![로컬 그림](img/dot.png) ![루트 그림](/img/dot.png) ![원격](https://example.com/remote.png)',
        '',
        '각주도 있습니다[^1].',
        '',
        '[^1]: 각주 내용',
        '',
        *[f'## 긴 절 {i}\n\n' + '본문 문장입니다. ' * 40 + '\n' for i in range(1, 15)],
    ])


def diagrams_text(tag=''):
    """Mermaid 시험 문서 (FR-REN-07): 정상 6개(한글 라벨, ELK 레이아웃 포함)와 깨진 1개, 위아래 긴 본문.
    tag(영문자)를 주면 원문이 달라져 앞에서 그린 캐시를 쓰지 않는다."""
    blocks = [
        f'flowchart LR\n  A[한글 시작{tag}] --> B{{판단}}\n  B -->|예| C[끝]',
        f'sequenceDiagram\n  Alice->>Bob: 안녕하세요{tag}\n  Bob-->>Alice: 반갑습니다',
        f'classDiagram\n  class Animal{tag} {{\n    +String 이름\n  }}\n  Animal{tag} <|-- Dog',
        f'stateDiagram-v2\n  [*] --> Idle{tag}\n  Idle{tag} --> Run : 시작\n  Run --> [*]',
        f'mindmap\n  root((중심{tag}))\n    가지 하나\n    가지 둘',
        f'---\nconfig:\n  layout: elk\n---\nflowchart TD\n  P[엘크{tag}] --> Q[아래]\n  P --> R[옆]',
        'flowchart LR\n  A -->',
    ]
    body = '본문 문장입니다. ' * 30
    parts = ['# 다이어그램', *[f'## 앞 절 {i}\n\n{body}' for i in range(6)]]
    parts += [f'```mermaid\n{b}\n```' for b in blocks]
    parts += ['## 아래 절', *[f'## 뒤 절 {i}\n\n{body}' for i in range(20)]]
    return '\n\n'.join(parts) + '\n'


# 다이어그램을 다 그렸는지: 그리는 중이 아니고 원문 코드 상자가 남지 않았다.
DIAGRAMS_DONE = "() => !__mdv.diagrams.busy && !__mdv.preview.article.querySelector('.mdv-mermaid > pre')"
# 그린 다이어그램 요약. 라벨(foreignObject)이 상자보다 넓으면 무대와 미리보기의 글자 폭이 다른 것이다.
DIAGRAM_REPORT = '''() => {
    const root = __mdv.preview.article;
    const svgs = [...root.querySelectorAll('.mdv-mermaid > svg')];
    const over = [...root.querySelectorAll('.mdv-mermaid foreignObject')]
        .filter(f => f.firstElementChild && f.firstElementChild.scrollWidth > Math.ceil(+f.getAttribute('width')) + 1)
        .map(f => f.textContent.trim().slice(0, 20));
    return {
        n: svgs.length,
        ids: svgs.map(s => s.id),
        widths: svgs.map(s => Math.round(s.getBoundingClientRect().width)),
        pending: root.querySelectorAll('.mdv-mermaid > pre').length,
        errors: [...root.querySelectorAll('.mdv-block-error p')].map(p => p.textContent),
        over,
        text: svgs.map(s => s.textContent).join(' '),
        stage: document.querySelector('iframe.mdv-mermaid-stage')?.contentDocument?.body?.childElementCount ?? -1,
    };
}'''


# NFR-SEC-01 검사. 미리보기에는 style 속성·요소가 없어야 하고, 예외는 Mermaid 다이어그램 svg 안뿐이다(FR-REN-07).
XSS_REPORT = '''() => {
    const root = __mdv.preview.article;
    const inDiagram = (el) => !!el.closest('.mdv-mermaid > svg');
    const bad = [...root.querySelectorAll('*')].filter(el => [...el.attributes].some(at =>
        /^on/i.test(at.name) || (at.name === 'style' && !inDiagram(el)) || at.name === 'srcset' || /^\\s*javascript:/i.test(at.value)));
    const banned = [...root.querySelectorAll('iframe,script,style,video,form,button')]
        .filter(el => !(el.localName === 'style' && el.parentElement?.matches('.mdv-mermaid > svg'))).length;
    const css = [...root.querySelectorAll('.mdv-mermaid style')].map(x => x.textContent)
        .concat([...root.querySelectorAll('.mdv-mermaid [style]')].map(x => x.getAttribute('style'))).join('\\n');
    const srcs = [...root.querySelectorAll('img')].map(i => i.getAttribute('src')).filter(Boolean);
    // 다이어그램 안의 요소가 상자 밖(앱 화면)으로 나가 그려지지 않는다(contain: layout paint).
    const escaped = [...root.querySelectorAll('.mdv-mermaid')].flatMap(box => {
        const b = box.getBoundingClientRect();
        return [...box.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect();
            return r.width > 0 && (r.left < b.left - 1 || r.top < b.top - 1 || r.right > b.right + 1 || r.bottom > b.bottom + 1); });
    }).length;
    return { xss: window.__xss ?? null, bad: bad.length, banned, srcs, escaped,
             leak: css.match(/url\\((?!\\s*["']?#)[^)]*\\)/g) || [], diagrams: root.querySelectorAll('.mdv-mermaid > svg').length };
}'''


def diagrams_ok(r):
    return (r['n'] == 6 and min(r['widths'] or [0]) > 0 and r['pending'] == 0 and r['stage'] == 0
            and len(r['errors']) == 1 and 'Parse error' in r['errors'][0])


def prepare_launcher_docs():
    readme = write(DOCS / 'README.md', readme_text())
    (DOCS / 'img').mkdir(exist_ok=True)
    (DOCS / 'img' / 'dot.png').write_bytes(PNG_1PX)
    write(DOCS / 'other.md', '# 다른 문서\n\n' + ('채우기 문단입니다.\n\n' * 60) + '## 둘째 절\n\n여기로 와야 합니다.\n\n' + ('끝 문단.\n\n' * 40))
    write(DOCS / 'notes.txt', '일반 텍스트 메모\n두 번째 줄\n')
    write(DOCS / 'diagrams.md', diagrams_text())
    # '똠'(0x8C63)은 CP949 확장 영역. 브라우저의 euc-kr(windows-949) 디코더로 읽혀야 한다 (NFR-ENC-01).
    write(DOCS / 'cp949.md', '# 한글 문서\n\n완성형 인코딩으로 저장한 문서입니다. 똠방각하\n', encoding='cp949')
    (DOCS / 'binary.md').write_bytes(b'PK\x03\x04\x00\x00\x10binary')
    big = '\n'.join(f'## 큰 절 {i}\n\n' + '큰 파일 본문 줄입니다 lorem ipsum. ' * 20 for i in range(7000))
    write(DOCS / 'big.md', big)  # 약 6 MB: 미리보기 자동 렌더링 생략 대상
    one_mb, i = [], 0
    while sum(len(s) for s in one_mb) < 1_000_000:
        one_mb.append(f'## 절 {i}\n\n본문 문단 **강조** 와 `코드` 와 [링크](other.md) 사과 문장입니다. ' * 3 + '\n\n- 항목 하나\n- 항목 둘\n\n')
        i += 1
    write(DOCS / 'one-mb.md', ''.join(one_mb))
    ten = '## 열 메가 절\n\n' + '열 메가 본문 줄입니다. ' * 30 + '\n\n'
    write(DOCS / 'ten-mb.md', ten * (10 * 1024 * 1024 // len(ten.encode('utf-8')) + 1))
    for n in range(20):
        write(DOCS / 'many' / f'탭{n:02d}.md', f'# 탭 문서 {n}\n\n' + ('내용 문단입니다. ' * 50 + '\n\n') * 40)
    for n in range(10):  # 세션 복원 인수 시험(SRS 8장)용: 스크롤할 만큼 긴 문서 10개
        write(DOCS / '세션' / f'세션 문서 {n:02d}.md', f'# 세션 문서 {n}\n\n'
              + ''.join(f'## 절 {k}\n\n' + f'{n}번 문서의 {k}번 문단입니다. ' * 10 + '\n\n' for k in range(80)))
    ws = DOCS / '작업 공간'
    write(ws / '하위' / '깊은 문서.md', '# 깊은 문서\n')
    write(ws / '첫 문서.md', '# 첫 문서\n')
    write(ws / '설명.txt', 'txt\n')
    (ws / 'node_modules').mkdir(exist_ok=True)
    (ws / 'image.png').write_bytes(PNG_1PX)
    # 비정상 입력 (NFR-REL-01)
    odd = DOCS / '비정상'
    write(odd / '깊은 인용.md', '> ' * 3000 + '깊은 인용\n')
    write(odd / '깊은 목록.md', '\n'.join('  ' * k + '- 항목' for k in range(1500)) + '\n')
    write(odd / '깊은 HTML.md', '<div>' * 5000 + '안쪽' + '</div>' * 5000 + '\n')
    write(odd / '만 행 표.md', '| 번호 | 값 | 끝 |\n| - | - | - |\n' + ''.join(f'| {k} | 값 {k} | 끝 |\n' for k in range(10000)))
    write(odd / '긴 한 줄.md', '한' * 100000 + '\n')
    write(odd / '빈 파일.md', '')
    # 편집과 저장 (FR-EDIT, NFR-ENC-05)
    ed = DOCS / '편집'
    ed.mkdir(exist_ok=True)
    (ed / '고칠 문서.md').write_bytes(b'\xef\xbb\xbf' + '# 편집 시험\r\n\r\n사과 사과 사과\r\n'.encode('utf-8'))
    write(ed / '완성형.md', '# 완성형\n\n똠방각하 본문\n', encoding='cp949')
    write(ed / '충돌.md', '# 충돌\n\n원래 내용\n')
    write(ed / '닫기.md', '# 닫기\n\n원래\n')
    write(ed / '자동.md', '# 자동 저장\n')
    write(ed / '바꾸기.md', '# 바꾸기\n\n사과 하나, 사과 둘, 사과 셋\n')
    hundred, i = [], 0
    while sum(len(x.encode('utf-8')) for x in hundred) < 100_000:
        hundred.append(f'## 백 킬로 절 {i}\n\n' + '백 킬로 문서의 본문 문장입니다. ' * 8 + '\n\n')
        i += 1
    write(ed / '백 킬로.md', ''.join(hundred))
    return readme


def write_xss(port):
    return write(DOCS / 'xss.md', '\n\n'.join([
        '# XSS',
        # Mermaid (FR-REN-07). 아래 <math> 줄은 닫히지 않은 요소로 뒤 블록을 삼키므로 그 앞에 둔다.
        # themeCSS는 문서가 init으로 바꿀 수 있는 설정이라 바깥 주소 CSS·position:fixed가 그대로 SVG <style>에 들어온다.
        # 이 바깥 주소들은 mermaid가 그리는 동안(정제 전) 무대에 들어간다. 무대 iframe의 CSP가 보내기 전에 막아야 한다(NFR-SEC-04).
        '```mermaid\n%%{init: {"themeCSS": ".node rect { fill: url(https://example.com/leak.png) !important; position: fixed; top: 0 } '
        'foreignObject div { position: fixed; inset: 0; z-index: 9999; background: red }", '
        '"fontFamily": "x; background: url(https://example.com/leak-font.png)"}}%%\nflowchart LR\n'
        '  A["<img src=x onerror=window.__xss=8>"] --> B["<style>.markdown-body{display:none}</style>라벨"]\n'
        '  B --> C["<img src=\'https://example.com/leak-label.png\'>"]\n'
        '  click A href "javascript:window.__xss=9"\n  click B call alert(10)\n```',
        '```mermaid\nflowchart LR\n  I@{ img: "https://example.com/leak-node.png", label: "i", w: 40, h: 40 } --> J\n```',
        '```mermaid\n%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  C --> D\n  click C call alert(11)\n  click D href "javascript:window.__xss=12"\n```',
        '<script>window.__xss = 1; alert(1)</script>',
        '<img src=x onerror="window.__xss = 2; alert(2)">',
        '[클릭](javascript:window.__xss=3)',
        '<a href="javascript:window.__xss=4">a</a>',
        '<svg onload="window.__xss=5"><circle r=1></circle></svg>',
        '<iframe src="https://example.com"></iframe>',
        '<div style="position:fixed;inset:0;background:red">덮기</div>',
        '<details open ontoggle="window.__xss=6">x</details>',
        '<math><mtext><table><mglyph><style><img src=x onerror="window.__xss=7">',
        '<img srcset="http://127.0.0.1:9/srcset.png 1x" alt="srcset">',
        '<video src="http://127.0.0.1:9/v.mp4" poster="http://127.0.0.1:9/p.png"></video>',
        f'![실행기 주소](http://127.0.0.1:{port}/api/stop?t=x) ![로컬 서비스](http://localhost:9/x.png) ![IPv6](http://[::1]:9/y.png)',
        '<form action="http://127.0.0.1:9/f"><button>보내기</button></form>',
    ]))


def prepare_standalone_docs():
    write(SA / 'a.md', '# 독립 문서\n\n![그림](img/dot.png)\n\n[옆 문서](b.md)\n')
    write(SA / 'b.md', '# 옆 문서\n')
    (SA / 'img').mkdir(exist_ok=True)
    (SA / 'img' / 'dot.png').write_bytes(PNG_1PX)
    write(SA / 'sub' / 'c.md', '# 하위 문서\n\n![위 그림](../img/dot.png)\n')
    write(LOCAL / '끌어온 폴더' / '첫째.md', '# 첫째\n\n[둘째로](둘째.md)\n\n![그림](그림.png)\n')
    write(LOCAL / '끌어온 폴더' / '둘째.md', '# 둘째\n')
    (LOCAL / '끌어온 폴더' / '그림.png').write_bytes(PNG_1PX)
    write(LOCAL / '고른 파일' / '하나.md', '# 하나\n')
    write(LOCAL / '고른 파일' / '둘.md', '# 둘\n')


# ---------------------------------------------------------------- 실행기 조종 (wsl.exe)

def wsl(*cmd, timeout=60):
    # WSL 안 명령의 출력은 UTF-8이지만 wsl.exe 자신의 오류 문구는 기본이 UTF-16LE다. WSL_UTF8=1로 그것도 UTF-8로 받는다.
    p = subprocess.run(['wsl.exe', '-d', DISTRO, '-e', *map(str, cmd)], capture_output=True, timeout=timeout, env={**os.environ, 'WSL_UTF8': '1'})
    return p.returncode, p.stdout.decode('utf-8', 'replace').replace('\r', ''), p.stderr.decode('utf-8', 'replace').replace('\r', '')


class Launcher:
    """MDVIEW_HOME을 따로 둔 실행기 하나. 사용자의 ~/.mdview는 건드리지 않는다."""

    def __init__(self, name, port, env=None):
        self.name = name
        self.home = f'{WORK_P}/{name}'
        self.port = port
        self.env = env or {}
        self.token = None
        self.base = None
        LAUNCHERS.append(self)

    def run(self, *args, timed=False, timeout=60):
        inner = ['env', f'MDVIEW_HOME={self.home}', *[f'{k}={v}' for k, v in self.env.items()], NODE, MJS, *map(str, args)]
        if timed:  # 실행기 명령만의 시간(wsl.exe를 띄우는 시간 제외)을 WSL 안에서 잰다
            inner = ['sh', '-c', 's=$(date +%s%N); "$@"; c=$?; e=$(date +%s%N); echo "@ms $(( (e - s) / 1000000 ))"; exit $c', 'sh', *inner]
        return wsl(*inner, timeout=timeout)

    def open(self, *paths, root=None, timed=False):
        code, out, err = self.run('--no-open', '--port', self.port, *(['--root', root] if root else []), *paths, timed=timed)
        lines = [ln for ln in out.splitlines() if ln.strip()]
        ms = int(lines.pop().split()[1]) if timed and lines and lines[-1].startswith('@ms ') else None
        if code != 0 or not lines or not lines[-1].startswith('http://127.0.0.1:'):
            raise RuntimeError(f'실행기 실패({code}): {out} {err}')
        url = lines[-1]
        self.token = parse_qs(urlparse(url).query)['t'][0]
        self.base = url.split('?')[0]
        self.last_out = out
        return (url, ms) if timed else url

    def url(self):
        return f'{self.base}?t={self.token}'

    def pid(self):
        _, out, _ = self.run('--status')
        m = re.search(r'pid (\d+)', out)
        return int(m.group(1)) if m else None

    def stop(self):
        self.run('--stop')

    def logs(self):
        d = WORK / self.name / 'logs'
        return ''.join(f.read_text(encoding='utf-8', errors='replace') for f in sorted(d.glob('*'))) if d.exists() else ''


def get(port, path, host=None):
    """토큰·Host 검사를 보려고 직접 요청한다(리디렉션을 따르지 않음)."""
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    c.request('GET', path, headers={'Host': host or f'127.0.0.1:{port}'})
    r = c.getresponse()
    body = r.read()
    headers = {k.lower(): v for k, v in r.getheaders()}
    c.close()
    return r.status, headers, body


def post(port, path, body: bytes, headers: dict):
    """쓰기 거부 검사용 POST(Origin·형식을 마음대로 정한다)."""
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    c.request('POST', path, body=body, headers={'Host': f'127.0.0.1:{port}', **headers})
    r = c.getresponse()
    r.read()
    c.close()
    return r.status


# ---------------------------------------------------------------- 브라우저 조종

def launch(pw, name):
    return pw.chromium.launch_persistent_context(
        str(LOCAL / name), channel='msedge', headless=HEADLESS, viewport={'width': 1280, 'height': 860}, locale='ko-KR')


class Viewer:
    def __init__(self, page):
        self.page = page
        self.errors = []
        self.dialogs = []
        page.on('pageerror', lambda e: self.errors.append(str(e)))
        page.on('dialog', lambda d: (self.dialogs.append(d.message), d.dismiss()))

    @classmethod
    def open(cls, ctx, url, restored=True):
        v = cls(ctx.new_page())
        v.page.goto(url)
        v.page.wait_for_selector('body[data-ready="1"]', timeout=30000)
        if restored:
            v.page.wait_for_selector('body[data-restored="1"]', timeout=30000)
        return v

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg)

    def state(self):
        return self.ev('''() => ({
            tabs: __mdv.tabs.tabs.map(t => ({ path: t.path, mode: t.mode, line: t.line })),
            active: __mdv.tabs.active()?.path ?? null,
            mode: __mdv.tabs.active()?.mode ?? null,
        })''')

    def key(self, k):
        self.page.keyboard.press(k)
        self.page.wait_for_timeout(150)

    def wait(self, js, timeout=5000, arg=None):
        self.page.wait_for_function(js, arg=arg, timeout=timeout)

    def open_file(self, path, **opts):
        self.ev('async ([p, o]) => { await __mdv.openFile(p, o); }', [path, opts])
        self.settle()

    def settle(self):
        self.ev('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        self.page.wait_for_timeout(50)

    def h1(self):
        return self.ev("() => __mdv.preview.article.querySelector('h1')?.textContent ?? null")

    def status(self):
        return self.page.locator('#statusbar').inner_text().replace('\n', ' | ')

    def retired(self, timeout=6.0):
        """새 뷰어 탭에 자리를 넘겼는지: 스스로 닫혔거나 물러났다는 안내를 띄웠다."""
        end = time.time() + timeout
        while time.time() < end:
            if self.page.is_closed():
                return 'closed'
            try:
                if self.page.title() == RETIRED_TITLE:
                    return 'retired'
                self.page.wait_for_timeout(100)
            except Exception:
                if self.page.is_closed():
                    return 'closed'
        return None


def crash_renderer(v):
    """뷰어 탭의 렌더러를 실제로 죽인다(pagehide 없이 끝남). CDP Page.crash는 응답이 오지 않아 동기 호출이 멈추므로,
    Playwright의 이벤트 루프에 보내기만 맡기고 crash 이벤트를 기다린다(내부 속성 _loop·_impl_obj를 쓴다)."""
    cdp = v.page.context.new_cdp_session(v.page)
    task = v.page._loop.create_task(cdp._impl_obj.send('Page.crash', None))
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    v.page.wait_for_event('crash', timeout=10000)


def cdp_drop(v, paths):
    """OS에서 끌어다 놓은 것처럼 실제 파일 경로로 drop을 보낸다. 파일은 진짜 파일 핸들로 들어온다."""
    cdp = v.page.context.new_cdp_session(v.page)
    data = {'items': [], 'files': [str(p) for p in paths], 'dragOperationsMask': 1}
    v.page.mouse.move(640, 400)
    for t in ('dragEnter', 'dragOver', 'drop'):
        cdp.send('Input.dispatchDragEvent', {'type': t, 'x': 640, 'y': 400, 'data': data})
    cdp.detach()


# ---------------------------------------------------------------- 편집 (FR-EDIT)

def ed_source(v):
    """활성 탭을 원문 보기로 바꾸고 편집기가 그 문서를 보일 때까지 기다린다."""
    if v.ev('() => __mdv.tabs.active().mode') != 'source':
        v.ev("() => __mdv.cmds.run('view.source')")
    v.wait('() => !!__mdv.source && __mdv.source.docId === __mdv.activeDoc()?.id', 8000)


def ed_type(v, text):
    """편집기 끝에 실제 키 입력으로 글을 친다."""
    v.page.locator('.pane.source .cm-content').click()
    v.key('Control+End')
    v.page.keyboard.type(text)


def ed_dirty(v, want=True, timeout=5000):
    try:
        v.wait('(w) => !!__mdv.activeDoc()?.dirty === w', timeout, arg=want)
    except Exception:
        # 저장이 실패했으면 그 이유가 알림에 있다.
        dlg = v.ev('() => document.querySelector("dialog[open]")?.textContent ?? null')
        raise RuntimeError(f'수정됨이 {want}가 되지 않음. 알림: {v.page.locator(".toast").all_inner_texts()[-3:]} 대화상자: {dlg}')


def ed_text(v):
    return v.ev('() => __mdv.source.textOf(__mdv.activeDoc().id)')


def ed_dialog(v, label, timeout=5000):
    """뷰어 대화상자의 단추를 누르고 대화상자 본문을 돌려준다."""
    dlg = v.page.locator('dialog.mdv-dialog[open]')
    dlg.wait_for(timeout=timeout)
    body = dlg.locator('.dialog-body').inner_text()
    dlg.get_by_role('button', name=label, exact=True).click()
    v.page.wait_for_timeout(200)
    return body


def ed_prompt(v, value, timeout=5000):
    """경로 입력 대화상자(실행기 모드의 다른 이름으로 저장)에 값을 넣고 Enter. 원래 값을 돌려준다."""
    dlg = v.page.locator('dialog.mdv-dialog[open]')
    dlg.wait_for(timeout=timeout)
    inp = dlg.locator('input')
    old = inp.input_value()
    inp.fill(value)
    inp.press('Enter')
    v.page.wait_for_timeout(200)
    return old


# 편집 뒤 미리보기에 표지가 보이기까지(입력이 멈춘 때부터)의 시간 (NFR-PERF-08)
EDIT_TO_PREVIEW = '''async (m) => {
    const v = __mdv.source.view;
    const t0 = performance.now();
    v.dispatch({ changes: { from: v.state.doc.length, insert: '\\n\\n' + m }, userEvent: 'input.type' });
    while (!__mdv.preview.article.textContent.includes(m)) await new Promise(r => requestAnimationFrame(r));
    return performance.now() - t0;
}'''
# 키 입력 하나가 화면에 반영되기까지(다음 프레임) 10회
KEY_LATENCY = '''async () => {
    const v = __mdv.source.view;
    const out = [];
    for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        v.dispatch({ changes: { from: v.state.selection.main.head, insert: 'x' }, userEvent: 'input.type' });
        await new Promise(r => requestAnimationFrame(r));
        out.push(performance.now() - t0);
    }
    return out;
}'''
# 고친 내용을 버리고 탭을 닫는다(확인 없이, 시험 정리용)
ED_DISCARD_CLOSE = '''() => { const t = __mdv.tabs.active(); __mdv.edit.discard(t.docId); __mdv.tabs.close(t.id); }'''


# ---------------------------------------------------------------- 실행기 모드: 기능

def run_launcher(pw, L, ctx):
    readme = DOCS / 'README.md'
    url = L.open(P(readme), root=P(DOCS))
    port = int(urlparse(url).port)
    write_xss(port)
    reqs = []
    ctx.on('request', lambda r: reqs.append(r))
    a = Viewer.open(ctx, url)
    cur = [a]  # 두 번째 실행부터 뷰어 탭이 바뀐다

    def t_open():
        a = cur[0]
        st = a.state()
        check('FR-LAUNCH-01', '실행기 명령(--no-open)이 낸 주소로 연 뷰어에 파일이 탭으로 열린다',
              len(st['tabs']) == 1 and st['active'] == P(readme) and 'f=' in url, st)
        check('FR-REN-01', '미리보기 렌더링', a.h1() == '사용 설명서')
        check('NFR-USE-02', '페이지 제목·UI 한국어', a.page.title() == 'README.md - MD Viewer', a.page.title())
        check('NFR-PORT-01', 'Edge에서 실행기 모드로 동작', a.ev('() => __mdv.bridge.mode') == 'launcher')
        check('FR-LAUNCH-01', '주소창에는 토큰만 남는다(새로 고쳐도 같은 파일을 또 열지 않음)', 'f=' not in a.page.url and 't=' in a.page.url, a.page.url)
        shot(a, '01-preview')
    guard('FR-FILE-01', '파일 열기', t_open)

    def t_render():
        a = cur[0]
        a.wait('''() => [...__mdv.preview.root.querySelectorAll('img[alt$="그림"]')].every(i => i.complete && i.naturalWidth > 0)''', 8000)
        r = a.ev('''() => {
            const root = __mdv.preview.root;
            const img = root.querySelector('img[alt="로컬 그림"]');
            const rimg = root.querySelector('img[alt="루트 그림"]');
            const lb = [...root.querySelectorAll('a')].find(x => x.textContent === '로컬 서버');
            return {
                table: !!root.querySelector('table th'),
                task: root.querySelectorAll('input[type=checkbox][disabled]').length,
                hl: !!root.querySelector('pre code .hljs-keyword'),
                fn: !!root.querySelector('.footnote-ref'),
                imgSrc: img?.getAttribute('src'), imgW: img?.naturalWidth,
                rootSrc: rimg?.getAttribute('src'), rootW: rimg?.naturalWidth,
                remote: root.querySelector('img[alt="원격"]')?.getAttribute('src'),
                ext: root.querySelector('a[data-mdv-ext]')?.getAttribute('data-mdv-ext'),
                local: root.querySelector('a[data-mdv-path]')?.getAttribute('data-mdv-path'),
                loopLink: lb?.getAttribute('data-mdv-ext'),
            };
        }''')
        check('FR-REN-01', 'GFM 표·작업 목록', r['table'] and r['task'] == 2, r)
        check('FR-REN-02', '코드 강조', r['hl'])
        check('FR-REN-05', '각주', r['fn'])
        check('FR-REN-03', '상대 경로·루트 기준 이미지를 실행기(/api/file)로 읽는다',
              r['imgW'] == 1 and r['rootW'] == 1 and (r['imgSrc'] or '').startswith('/api/file?') and (r['rootSrc'] or '').startswith('/api/file?'), r)
        check('FR-NAV-03', '링크 분류(외부·로컬), 루프백 링크는 링크로 둔다',
              r['ext'] == 'https://example.com' and (r['local'] or '').endswith('/other.md') and (r['loopLink'] or '').startswith('http://localhost:3000'), r)
    guard('FR-REN', '렌더링', t_render)

    def t_toc():
        a = cur[0]
        items = a.page.locator('.toc-item')
        n = items.count()
        heads = a.ev('() => __mdv.preview.root.querySelectorAll("h1,h2,h3,h4,h5,h6").length')
        items.nth(8).click()
        a.page.wait_for_timeout(300)
        line = a.ev('() => __mdv.tabs.active().line')
        target = a.ev('() => __mdv.headings[8].line')
        cur_item = a.page.locator('.toc-item.current').inner_text()
        check('FR-NAV-01', '목차 생성·클릭 이동·현재 제목 강조', n == heads and abs(line - target) < 1.5 and cur_item == a.ev('() => __mdv.headings[8].text'),
              f'items={n} heads={heads} line={line} target={target} current={cur_item}')
        a.ev('() => { __mdv.preview.el.scrollTop = 0; }')
        a.page.wait_for_timeout(200)
    guard('FR-NAV-01', '목차', t_toc)

    def t_link():
        a = cur[0]
        a.ev('''() => __mdv.preview.root.querySelector('a[data-mdv-path$="other.md"]').click()''')
        a.wait('() => __mdv.tabs.active()?.path.endsWith("other.md")')
        a.page.wait_for_timeout(400)
        st = a.state()
        top = a.ev('() => __mdv.preview.topLine()')
        target = a.ev('() => __mdv.headings.find(h => h.id === "둘째-절").line')
        check('FR-NAV-03', '로컬 .md 링크는 새 탭으로, #조각으로 이동', len(st['tabs']) == 2 and abs(top - target) < 2, f'top={top} target={target}')
        a.open_file(P(readme))
        check('FR-FILE-03', '이미 열린 파일은 새 탭을 만들지 않는다', len(a.state()['tabs']) == 2)
    guard('FR-NAV-03', '링크 이동', t_link)

    def t_modes():
        a = cur[0]
        a.page.locator('.preview-scroll').click()
        a.key('Control+2')
        a.wait('() => !!document.querySelector(".pane.source .cm-content")', 8000)
        src_visible = a.page.locator('.pane.source').is_visible() and not a.page.locator('.pane.preview').is_visible()
        gutters = a.page.locator('.cm-lineNumbers .cm-gutterElement').count()
        check('FR-VIEW-02', '원문 보기: 줄 번호와 Markdown 강조', src_visible and gutters > 5 and a.page.locator('.cm-content [class*="ͼ"]').count() > 0, f'gutters={gutters}')
        check('ARCH-02', '원문 보기는 편집기 컴포넌트이고 v2.0부터 편집할 수 있다(FR-EDIT-01)', a.ev('() => __mdv.source.view.state.readOnly') is False)
        a.key('Control+3')
        both = a.page.locator('.pane.source').is_visible() and a.page.locator('.pane.preview').is_visible()
        check('FR-VIEW-01', '미리보기·원문·분할 전환', both and a.state()['mode'] == 'split')
        a.ev('() => { __mdv.preview.el.scrollTop = __mdv.preview.el.scrollHeight * 0.5; }')
        a.page.wait_for_timeout(500)
        p_line = settled(lambda: a.ev('() => __mdv.preview.topLine()'))
        s_line = a.ev('() => __mdv.source.topLine()')
        check('FR-VIEW-05', '분할 보기 스크롤 동기화', p_line > 10 and abs(p_line - s_line) < 3, f'preview={p_line:.1f} source={s_line:.1f}')
        shot(a, '02-split')
        wrap0 = a.ev('() => __mdv.settings.wordWrap')
        a.key('Alt+z')
        wrap1 = a.ev('() => __mdv.settings.wordWrap')
        check('FR-VIEW-02', '자동 줄 바꿈 Alt+Z', wrap0 != wrap1)
        a.key('Alt+z')
        a.key('Control+1')
        check('FR-VIEW-01', 'Ctrl+1로 미리보기 복귀', a.state()['mode'] == 'preview')
    guard('FR-VIEW', '보기 모드', t_modes)

    def t_find():
        a = cur[0]
        a.ev('() => { __mdv.preview.el.scrollTop = 0; }')
        a.key('Control+f')
        bar = a.page.locator('.findbar')
        a.page.locator('.findbar .find-row input').fill('사과')
        a.page.wait_for_timeout(400)
        count = a.page.locator('.find-count').inner_text()
        marks = a.ev('() => __mdv.preview.root.querySelectorAll("mark.mdv-hit").length')
        a.key('F3')
        cur_n = a.page.locator('.find-count').inner_text()
        check('FR-FIND-01', '찾기·다음·일치 개수', bar.is_visible() and count == '3개' and cur_n == '1/3' and marks == 3, f'{count} {cur_n} marks={marks}')
        a.page.locator('.find-toggle[data-opt="regex"]').click()
        a.page.locator('.findbar .find-row input').fill('긴 절 1[0-3]')
        a.page.wait_for_timeout(400)
        rcount = a.page.locator('.find-count').inner_text()
        a.page.locator('.find-toggle[data-opt="regex"]').click()
        a.page.locator('.find-toggle[data-opt="wholeWord"]').click()
        a.page.locator('.findbar .find-row input').fill('문장')
        a.page.wait_for_timeout(400)
        wcount = a.page.locator('.find-count').inner_text()
        a.page.locator('.find-toggle[data-opt="wholeWord"]').click()
        check('FR-FIND-02', '정규식·단어 단위 옵션', rcount == '4개' and wcount == '결과 없음', f'regex={rcount} word={wcount}')
        a.key('Control+2')
        a.key('Control+f')
        a.page.locator('.findbar .find-row input').fill('def')
        a.page.wait_for_timeout(400)
        scount = a.page.locator('.find-count').inner_text()
        hl = a.page.locator('.cm-searchMatch').count()
        check('FR-FIND-03', '원문 보기에서도 찾고 강조', scount == '1개' and hl >= 1, f'{scount} hl={hl}')
        a.page.locator('.findbar .find-row input').press('Escape')
        a.page.wait_for_timeout(200)
        a.key('Control+1')
        check('FR-FIND-01', 'Esc로 닫으면 강조 해제', not bar.is_visible() and a.ev('() => __mdv.preview.root.querySelectorAll("mark").length') == 0)
    guard('FR-FIND', '찾기', t_find)

    def t_zoom_theme():
        a = cur[0]
        a.key('Control+=')
        a.key('Control+=')
        z = a.page.locator('[data-field="zoom"]').inner_text()
        a.key('Control+0')
        z0 = a.page.locator('[data-field="zoom"]').inner_text()
        check('FR-VIEW-03', '확대·원래대로', z == '120%' and z0 == '100%', f'{z} → {z0}')
        a.ev("() => __mdv.cmds.run('view.theme.dark')")
        a.page.wait_for_timeout(200)
        dark = a.ev('() => document.documentElement.dataset.theme')
        shot(a, '03-dark')
        a.ev("() => __mdv.cmds.run('view.theme.light')")
        check('FR-VIEW-04', '다크·라이트 테마', dark == 'dark' and a.ev('() => document.documentElement.dataset.theme') == 'light')
    guard('FR-VIEW-03', '확대·테마', t_zoom_theme)

    def t_browser_keys():
        # 4.2의 키는 뷰어가 먼저 받아 브라우저 기본 동작(새로 고침·인쇄·뒤로 가기 등)을 막는다 (NFR-USE-01).
        a = cur[0]
        a.ev('''() => {
            window.__keys = []; window.__alive = 1; window.__printed = 0;
            window.print = () => { window.__printed++; };
            // 뷰어의 처리기(window, 캡처 단계) 다음에 불리도록 같은 자리에 붙인다. 뷰어는 처리한 키의 전파를 멈춘다.
            window.addEventListener('keydown', e => { if (!['Control', 'Shift', 'Alt'].includes(e.key)) window.__keys.push([e.key, e.defaultPrevented]); }, true);
        }''')
        url0 = a.page.url
        keys = ['F5', 'Control+p', 'Control+b', 'Control+b', 'Control+2', 'Control+1', 'Control+=', 'Control+-', 'Control+0',
                'Alt+ArrowLeft', 'Alt+ArrowRight', 'Control+g', 'Control+Shift+O', 'Control+Shift+F', 'F3', 'Shift+F3', 'Control+s', 'Control+h']
        for k in keys:
            a.key(k)
        a.page.wait_for_timeout(300)
        r = a.ev('() => ({ keys: window.__keys, alive: window.__alive, printed: window.__printed })')
        missed = [k for k, prevented in r['keys'] if not prevented]
        check('NFR-USE-01', '4.2 단축키가 브라우저 기본 동작(새로 고침·인쇄·뒤로 가기)을 막는다',
              r['alive'] == 1 and a.page.url == url0 and not missed and len(r['keys']) == len(keys), f'막지 못한 키={missed} 받은 키={len(r["keys"])}/{len(keys)}')
        check('FR-EXP-01', 'Ctrl+P는 뷰어의 인쇄(window.print)를 부른다', r['printed'] == 1, r['printed'])
        toast = a.page.locator('.toast').all_inner_texts()
        check('NFR-USE-01', '다음 버전 단축키는 안내만 띄운다', any('다음 버전' in t for t in toast), toast[-3:])
    guard('NFR-USE-01', '브라우저 단축키 충돌', t_browser_keys)

    def t_encoding():
        a = cur[0]
        a.open_file(P(DOCS / 'cp949.md'))
        enc = a.page.locator('[data-field="encoding"]').inner_text()
        text = a.ev('() => __mdv.preview.article.textContent')
        check('NFR-ENC-01', 'CP949 자동 판별(확장 글자 똠 포함)', enc == 'CP949' and a.h1() == '한글 문서' and '똠방각하' in text, f'{enc} {text[:40]}')
        a.ev("() => __mdv.cmds.run('encoding.reopen.utf-8')")
        a.wait("() => __mdv.activeDoc().encoding === 'utf-8'")
        a.page.wait_for_timeout(300)
        check('FR-INFO-02', '인코딩을 골라 다시 읽기, 깨진 바이트 경고', a.page.locator('[data-field="warning"]').count() == 1, a.status())
        a.ev("() => __mdv.cmds.run('encoding.reopen.cp949')")
        a.wait("() => document.querySelector('[data-field=encoding]')?.textContent === 'CP949'")
        st = a.status()
        check('FR-INFO-01', '상태 표시줄: 인코딩·줄 끝·줄·단어·글자·크기', all(s in st for s in ['CP949', 'LF', '줄', '단어', '자', ' B']), st)
    guard('NFR-ENC', '인코딩', t_encoding)

    def t_text_binary_large():
        a = cur[0]
        a.open_file(P(DOCS / 'notes.txt'))
        check('FR-FILE-08', '.txt는 원문 보기로 열린다', a.state()['mode'] == 'source')
        a.open_file(P(DOCS / 'binary.md'))
        msg = a.ev("() => __mdv.preview.article.textContent")
        check('NFR-REL-01', '바이너리 파일은 내용 대신 안내', '바이너리' in msg, msg[:60])
        ed_source(a)
        check('FR-EDIT-01', '바이너리 파일은 원문 보기에서도 읽기 전용', a.ev('() => __mdv.source.view.state.readOnly') is True)
        a.key('Control+1')
        t0 = time.time()
        a.open_file(P(DOCS / 'big.md'))
        dt = time.time() - t0
        check('NFR-PERF-03', '5 MB 넘는 파일은 원문 보기로 열고 미리보기는 수동', a.state()['mode'] == 'source' and dt < 2.0, f'{dt:.2f}s')
        a.key('Control+1')
        msg = a.ev("() => __mdv.preview.article.textContent")
        check('NFR-PERF-03', '큰 파일 미리보기 안내와 버튼', '미리보기 그리기' in msg, msg[:80])
    guard('NFR-PERF-03', '텍스트·바이너리·큰 파일', t_text_binary_large)

    def t_diagrams():
        a = cur[0]
        p = P(DOCS / 'diagrams.md')
        # 이 뷰어 탭에서 처음 그리는 다이어그램이다: 번들 풀기·실행·첫 그리기까지 잰다.
        first = a.ev('''async (p) => {
            const t0 = performance.now();
            await __mdv.openFile(p);
            while (!__mdv.preview.article.querySelector('.mdv-mermaid > svg')) {
                if (performance.now() - t0 > 15000) return -1;
                await new Promise(r => setTimeout(r, 10));
            }
            return performance.now() - t0;
        }''', p)
        a.wait(DIAGRAMS_DONE, 20000)
        r = a.ev(DIAGRAM_REPORT)
        check('FR-REN-07', 'Mermaid: flowchart·sequence·class·state·mindmap·ELK를 SVG로 그리고 깨진 것은 원문과 오류로',
              diagrams_ok(r) and not a.errors, {k: r[k] for k in ('n', 'widths', 'pending', 'errors', 'stage')})
        check('FR-REN-07', 'Mermaid: 한글 라벨이 그대로 나오고 상자를 넘치지 않는다', not r['over'] and '판단' in r['text'] and '안녕하세요' in r['text'], r['over'])
        check('FR-REN-07', 'Mermaid: 첫 다이어그램 표시 1.5초 이내(번들 풀기·실행 포함)', 0 < first <= 1500, f'{first:.0f} ms')
        shot(a, '20-diagrams')

        hits = a.ev('''() => {
            const out = {};
            for (const t of ['판단', '안녕하세요', '가지 하나']) {
                const n = __mdv.preview.find({ text: t, caseSensitive: false, wholeWord: false, regex: false }).count;
                const els = [...__mdv.preview.article.querySelectorAll('.mdv-mermaid .mdv-hit')];
                out[t] = { n, svg: els.filter(e => e.localName === 'tspan').length, visible: els.every(e => e.getBoundingClientRect().width > 0) };
            }
            __mdv.preview.clearFind();
            return out;
        }''')
        check('FR-FIND-03', 'Mermaid: 다이어그램 안 한글 라벨도 찾아 보이게 강조한다(SVG 글자는 tspan)',
              all(h['n'] >= 1 and h['visible'] for h in hits.values()) and any(h['svg'] for h in hits.values()), hits)

        fill = "() => getComputedStyle(__mdv.preview.article.querySelector('.mdv-mermaid > svg .node rect, .mdv-mermaid > svg .node path')).fill"
        light = a.ev(fill)
        a.ev("() => __mdv.cmds.run('view.theme.dark')")
        a.wait("(ids) => { const s = [...__mdv.preview.article.querySelectorAll('.mdv-mermaid > svg')]; return s.length === 6 && s.every(x => !ids.includes(x.id)); }", 20000, arg=r['ids'])
        a.wait(DIAGRAMS_DONE, 20000)
        dark = a.ev(fill)
        shot(a, '21-diagrams-dark')
        a.ev("() => __mdv.cmds.run('view.theme.light')")
        back = a.ev("() => __mdv.preview.article.querySelectorAll('.mdv-mermaid > svg').length")
        check('FR-REN-07', 'Mermaid: 다크 테마면 다시 그리고, 라이트로 돌아오면 캐시로 바로 끼운다', light != dark and back == 6, f'채움 {light} → {dark}, 돌아온 직후 {back}개')

        write(DOCS / 'diagrams.md', diagrams_text() + '\n추가 문단입니다.\n')
        a.wait("() => __mdv.preview.article.textContent.includes('추가 문단입니다')", 5000)
        rr = a.ev("() => ({ svgs: __mdv.preview.article.querySelectorAll('.mdv-mermaid > svg').length, pending: __mdv.preview.article.querySelectorAll('.mdv-mermaid > pre').length })")
        check('FR-WATCH-01', 'Mermaid: 다이어그램 밖을 고쳐 다시 그려도 다이어그램은 캐시로 바로 끼운다(원문 코드로 깜빡이지 않음)', rr == {'svgs': 6, 'pending': 0}, rr)

        # 아래 절로 연 뒤 위쪽 다이어그램이 늦게 커져도 보던 줄을 지킨다(스크롤 앵커링). 캐시를 피하려고 원문을 바꾼다.
        text = diagrams_text('Z')
        target = text.split('\n').index('## 아래 절')
        p2 = write(DOCS / 'diagrams-scroll.md', text)
        a.ev('async ([p, l]) => { await __mdv.openFile(p, { line: l }); }', [P(p2), target])
        a.wait(DIAGRAMS_DONE, 20000)
        top = settled(lambda: a.ev('() => __mdv.preview.topLine()'))
        check('FR-REN-07', 'Mermaid: 위쪽 다이어그램이 늦게 그려져도 보던 줄을 지킨다(±1줄)', top is not None and abs(top - target) <= 1, f'목표 {target}, 실제 {top}')
    guard('FR-REN-07', 'Mermaid 다이어그램', t_diagrams)

    def t_xss():
        a = cur[0]
        a.open_file(P(DOCS / 'xss.md'))
        a.page.wait_for_timeout(800)
        a.wait(DIAGRAMS_DONE, 15000)
        r = a.ev(XSS_REPORT)
        loop = [s for s in r['srcs'] if re.search(r'127\.0\.0\.1|localhost|\[::1\]', s)]
        check('NFR-SEC-01', 'XSS 페이로드 문서에서 실행 0건', r['xss'] is None and r['bad'] == 0 and r['banned'] == 0 and not a.dialogs, f'{r} dialogs={a.dialogs}')
        check('NFR-SEC-01', 'Mermaid: 공격 다이어그램도 실행 0건, style은 다이어그램 svg 안에만, 그 CSS에 바깥 주소 없음, 상자 밖으로 안 나감',
              r['diagrams'] == 2 and not r['leak'] and r['escaped'] == 0, f'다이어그램 {r["diagrams"]} 바깥 url {r["leak"]} 상자 밖 {r["escaped"]}')
        shot(a, '22-xss-diagrams')
        check('NFR-SEC-02', '문서가 쓴 실행기·로컬 주소 이미지는 지운다', not loop, loop)
    guard('NFR-SEC-01', 'XSS', t_xss)

    def t_remote_images():
        a = cur[0]
        a.open_file(P(readme))
        a.ev("() => __mdv.cmds.run('view.remoteImages')")
        a.page.wait_for_timeout(300)
        blocked = a.ev('''() => __mdv.preview.root.querySelector('img[alt="원격"]').getAttribute('data-mdv-blocked')''')
        a.ev("() => __mdv.cmds.run('view.remoteImages')")
        a.page.wait_for_timeout(300)
        src = a.ev('''() => __mdv.preview.root.querySelector('img[alt="원격"]').getAttribute('src')''')
        check('NFR-SEC-03', '원격 이미지 차단 설정', blocked == 'https://example.com/remote.png' and src == 'https://example.com/remote.png', f'{blocked} / {src}')
    guard('NFR-SEC-03', '원격 이미지', t_remote_images)

    def t_watch():
        a = cur[0]
        path = DOCS / 'other.md'
        a.open_file(P(path))
        a.ev('() => { __mdv.preview.el.scrollTop = 600; }')
        a.page.wait_for_timeout(400)
        line_before = a.ev('() => __mdv.tabs.active().line')
        text = path.read_bytes().decode('utf-8').replace('# 다른 문서', '# 다른 문서 (수정됨)')
        t0 = time.time()
        write(path, text)
        a.wait("() => __mdv.preview.article.querySelector('h1')?.textContent === '다른 문서 (수정됨)'", 3000)
        dt = time.time() - t0
        a.page.wait_for_timeout(300)
        line_after = a.ev('() => __mdv.tabs.active().line')
        check('FR-WATCH-01', '외부 변경 자동 반영, 스크롤 줄 유지', abs(line_after - line_before) < 1.5, f'line {line_before:.1f}→{line_after:.1f}')
        check('NFR-PERF-04', '저장부터 화면 반영 0.5초 이내(실행기 모드)', dt < 0.5, f'{dt * 1000:.0f} ms')
        backup = path.read_bytes()
        path.unlink()
        a.wait('() => __mdv.activeDoc()?.state === "deleted"', 3000)
        tab_deleted = a.page.locator('.tab.active.deleted').count() == 1
        kept = a.h1()
        check('FR-WATCH-02', '삭제되면 탭에 표시하고 내용 유지', tab_deleted and kept == '다른 문서 (수정됨)', kept)
        path.write_bytes(backup)
        a.wait('() => __mdv.activeDoc()?.state === "ok"', 3000)
        check('FR-WATCH-02', '다시 생기면 복구', True)
        v0 = a.ev('() => { window.__alive = 1; return __mdv.activeDoc().version; }')
        a.key('F5')
        a.wait('(v) => __mdv.activeDoc().version > v', 3000, arg=v0)
        check('FR-WATCH-03', 'F5는 페이지가 아니라 문서를 다시 읽는다', a.ev('() => window.__alive') == 1)
    guard('FR-WATCH', '파일 감시', t_watch)

    def t_watch_100():
        # SRS 8장 인수 기준: 외부 편집기로 같은 파일을 100회 저장 → 매번 반영, 스크롤 유지 (FR-WATCH-01).
        # 홀수 회는 제자리 저장(메모장 방식), 짝수 회는 임시 파일에 쓴 뒤 교체(vim 등 원자적 저장 방식).
        a = cur[0]
        path = DOCS / 'other.md'
        tmp = DOCS / 'other.md.tmp~'
        a.open_file(P(path))
        a.ev('() => { __mdv.preview.el.scrollTop = 600; }')
        a.page.wait_for_timeout(400)
        line0 = a.ev('() => __mdv.tabs.active().line')
        body = path.read_bytes().decode('utf-8').split('\n', 1)[1]
        lat, drift, not_ok, reflected, retries = [], 0.0, 0, 0, 0
        for i in range(1, 101):
            marker = f'저장 {i:03d}'
            t0 = time.time()
            if i % 2:
                write(path, f'# {marker}\n' + body)
            else:
                write(tmp, f'# {marker}\n' + body)
                retries += replace_file(tmp, path)
            try:
                a.wait('(m) => __mdv.preview.article.querySelector("h1")?.textContent === m', 3000, arg=marker)
                lat.append((time.time() - t0) * 1000)
                reflected += 1
            except Exception:
                pass
            st = a.ev('() => ({ line: __mdv.tabs.active().line, state: __mdv.activeDoc().state })')
            drift = max(drift, abs(st['line'] - line0))
            not_ok += st['state'] != 'ok'
        med = statistics.median(lat) if lat else 9999
        check('FR-WATCH-01', '외부 편집기로 100회 저장: 매번 반영', reflected == 100,
              f'{reflected}/100 반영, 지연 중앙값 {med:.0f} ms, 최대 {max(lat or [0]):.0f} ms (제자리 저장 50·교체 저장 50, 교체 재시도 {retries}회)')
        check('FR-WATCH-01', '100회 저장 동안 스크롤 줄 유지, 삭제 표시 없음', drift < 1.5 and not_ok == 0, f'줄 {line0:.1f}, 최대 차이 {drift:.2f}, 삭제 표시 {not_ok}회')
        check('NFR-PERF-04', '저장부터 화면 반영 0.5초 이내(100회 중앙값, 실행기 모드)', med < 500, f'{med:.0f} ms')
        renamed = DOCS / 'other 이름 변경.md'
        os.rename(path, renamed)
        try:
            a.wait('() => __mdv.activeDoc()?.state === "deleted"', 3000)
            tab_deleted = a.page.locator('.tab.active.deleted').count() == 1
            check('FR-WATCH-02', '이름이 바뀌면 탭에 삭제 표시하고 내용 유지', tab_deleted and a.h1() == '저장 100', a.h1())
        finally:
            os.rename(renamed, path)
        a.wait('() => __mdv.activeDoc()?.state === "ok"', 3000)
        check('FR-WATCH-02', '원래 이름으로 돌아오면 복구', a.page.locator('.tab.active.deleted').count() == 0 and a.h1() == '저장 100', a.h1())
    guard('FR-WATCH-01', '파일 감시 100회 저장·이름 변경', t_watch_100)

    def t_tabs():
        a = cur[0]
        n0 = len(a.state()['tabs'])
        a.key('Alt+w')
        n1 = len(a.state()['tabs'])
        a.key('Alt+Shift+T')
        a.page.wait_for_timeout(400)
        st = a.state()
        check('FR-FILE-05', 'Alt+W 닫기, Alt+Shift+T 다시 열기', n1 == n0 - 1 and len(st['tabs']) == n0 and st['active'].endswith('other.md'), f'{n0}→{n1}→{len(st["tabs"])}')
        before = a.state()['active']
        a.key('Alt+PageDown')
        after = a.state()['active']
        a.key('Alt+PageUp')
        check('FR-FILE-05', 'Alt+PageDown·PageUp 다음·이전 탭', before != after and a.state()['active'] == before, f'{before} → {after}')
        a.ev('() => __mdv.tabs.move(__mdv.tabs.activeId, 0)')
        check('FR-FILE-05', '탭 순서 이동', a.state()['tabs'][0]['path'] == before)
    guard('FR-FILE-05', '탭', t_tabs)

    def t_menu_shortcuts():
        a = cur[0]
        a.key('Alt+f')
        opened = a.page.locator('.menu-dropdown').is_visible()
        labels = a.page.locator('.menu-dropdown .menu-label').all_inner_texts()
        a.key('Escape')
        closed = a.page.locator('.menu-dropdown').count() == 0
        check('NFR-USE-01', '메뉴: Alt+F 열기·Esc 닫기', opened and closed and '열기…' in labels and '인쇄…' in labels, labels[:8])
        a.key('F1')
        rows = a.page.locator('.shortcut-table tr').count()
        a.key('Escape')
        check('NFR-USE-01', 'F1 단축키 목록', rows >= 15 and a.page.locator('dialog[open]').count() == 0, f'rows={rows}')
        keys = a.ev('() => __mdv.cmds.all().flatMap(c => c.keys ?? [])')
        need = ['Ctrl+O', 'Alt+W', 'Alt+Shift+T', 'Alt+PageDown', 'Alt+PageUp', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Alt+Z', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0',
                'Ctrl+B', 'Alt+Left', 'Alt+Right', 'Ctrl+G', 'Ctrl+Shift+O', 'Ctrl+F', 'F3', 'Shift+F3', 'Ctrl+Shift+F', 'F5', 'Ctrl+P']
        reserved = ['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+Shift+T', 'Ctrl+PageUp', 'Ctrl+PageDown']
        missing = [k for k in need if k not in keys]
        clash = [k for k in reserved if k in keys]
        check('NFR-USE-01', 'SRS 4.2 단축키 등록, 브라우저 예약 키는 쓰지 않음', not missing and not clash, f'없음={missing} 예약 키={clash}')
        vis = a.ev('() => !document.getElementById("side").hidden')
        a.key('Control+b')
        hid = a.ev('() => document.getElementById("side").hidden')
        a.key('Control+b')
        check('FR-NAV-01', 'Ctrl+B 왼쪽 패널', vis and hid)
    guard('NFR-USE-01', '메뉴·단축키', t_menu_shortcuts)

    def t_panels():
        # 목차는 문서 오른쪽 패널, 왼쪽 패널은 작업 공간이고 '왼쪽 목록' 설정이면 그 위에 열린 파일 목록을 둔다.
        a = cur[0]
        side, main, toc = (a.page.locator(s).bounding_box() for s in ('#side', '#main', '#toc-side'))
        check('FR-NAV-01', '목차는 문서 오른쪽, 작업 공간은 왼쪽 패널',
              side['x'] + side['width'] <= main['x'] + 1 and toc['x'] >= main['x'] + main['width'] - 1 and a.page.locator('#toc-side .toc-item').count() > 0
              and a.page.locator('#side #ws-body .workspace').count() == 1, f'side={side} main={main} toc={toc}')
        a.key('Control+Alt+b')
        hid = a.ev('() => document.getElementById("toc-side").hidden')
        a.key('Control+Alt+b')
        check('FR-NAV-01', 'Ctrl+Alt+B 목차 패널', hid and not a.ev('() => document.getElementById("toc-side").hidden'))
        n = len(a.state()['tabs'])
        a.ev('() => __mdv.cmds.run("view.openFiles.list")')
        a.settle()
        r = a.ev('''() => ({
            list: !!document.querySelector('#side #open-files:not([hidden]) #tabbar.vertical'),
            items: document.querySelectorAll('#open-files .tab').length,
            listBottom: document.getElementById('open-files').getBoundingClientRect().bottom,
            wsTop: document.getElementById('ws-section').getBoundingClientRect().top,
            saved: __mdv.settings.openFiles,
        })''')
        item = a.page.locator('#open-files .tab:not(.active):not(.deleted)').first
        name = item.locator('.tab-name').inner_text()
        item.click()
        a.settle()
        picked = a.state()['active'].endswith('/' + name)
        shot(a, '04-open-files-list')
        a.ev('() => __mdv.cmds.run("view.openFiles.tabs")')
        a.settle()
        back = a.ev('''() => { const bar = document.getElementById('tabbar');
            return bar.parentElement.id === 'app' && !bar.classList.contains('vertical') && document.getElementById('open-files').hidden; }''')
        check('FR-FILE-05', '열린 파일 표시: 왼쪽 패널 위 목록(아래 작업 공간)에서 고르기 ↔ 위쪽 탭',
              r['list'] and r['items'] == n and r['listBottom'] <= r['wsTop'] + 1 and r['saved'] == 'list' and picked and back,
              f'{r} 고른 파일={name} 열림={picked} 탭 복귀={back}')
    guard('FR-FILE-05', '패널 배치·열린 파일 목록', t_panels)

    def t_second_launch():
        # 실행 중에 다시 부르면 같은 실행기를 쓰고, 새 뷰어 탭이 이전 탭의 문서를 넘겨받는다 (FR-FILE-04, SDD 7.3).
        a = cur[0]
        before = a.state()
        pid0 = L.pid()
        ws = DOCS / '작업 공간'
        url2 = L.open(P(ws), P(DOCS / 'many' / '탭00.md'), root=P(DOCS))
        pid1 = L.pid()
        b = Viewer.open(ctx, url2)
        how = a.retired()
        st = b.state()
        kept = all(t['path'] in [x['path'] for x in st['tabs']] for t in before['tabs'])
        check('FR-FILE-04', '두 번째 실행은 같은 실행기를 쓴다(실행기는 하나)', pid0 and pid0 == pid1, f'pid {pid0} → {pid1}')
        check('FR-FILE-04', '새 뷰어 탭이 이전 탭의 문서를 넘겨받고 이전 탭은 물러난다',
              how is not None and kept and st['active'].endswith('탭00.md'), f'이전 탭={how} 탭 {len(before["tabs"])}→{len(st["tabs"])} 활성={st["active"]}')
        cur[0] = b
        b.wait('() => document.querySelectorAll(".ws-item").length >= 3', 5000)
        items = b.page.locator('.ws-item').all_inner_texts()
        check('FR-NAV-02', '작업 공간 트리: 폴더 먼저, 문서만', items[:3] == ['▸ 하위', '설명.txt', '첫 문서.md'] and not any('node_modules' in i or 'image.png' in i for i in items), items)
        b.page.locator('.ws-item', has_text='하위').click()
        b.wait('() => [...document.querySelectorAll(".ws-item")].some(e => e.textContent.includes("깊은 문서.md"))', 5000)
        b.page.locator('.ws-item', has_text='깊은 문서.md').click()
        b.wait('() => __mdv.tabs.active()?.path.endsWith("깊은 문서.md")', 5000)
        check('FR-NAV-02', '트리에서 파일 열기·현재 문서 강조', b.page.locator('.ws-item.active').inner_text() == '깊은 문서.md')
        shot(b, '04-workspace')
    guard('FR-FILE-04', '두 번째 실행·작업 공간', t_second_launch)

    def t_merge_viewers():
        # 실행을 거듭해도 살아 있는 뷰어 탭은 하나다. 탭마다 실행기 연결을 잡으면 호스트당 연결 한도(6개)를 넘는다 (SDD 7.3).
        olds = []
        for n in range(1, 6):
            prev = cur[0]
            url_n = L.open(P(DOCS / 'many' / f'탭{n:02d}.md'), root=P(DOCS))
            nxt = Viewer.open(ctx, url_n)
            if not prev.retired():
                raise RuntimeError(f'{n}번째 실행 뒤 이전 탭이 물러나지 않음')
            olds.append(prev)
            cur[0] = nxt
        b = cur[0]
        # 넘겨받은 문서는 시작을 마친 뒤 비동기로 열리므로 다 열릴 때까지 기다린다.
        names = [f'탭{n:02d}.md' for n in range(6)]
        try:
            b.wait('(names) => names.every(n => __mdv.tabs.tabs.some(t => t.path.endsWith("/" + n)))', 8000, arg=names)
        except Exception:
            pass
        st = b.state()
        has_all = all(any(t['path'].endswith('/' + n) for t in st['tabs']) for n in names)
        path = DOCS / 'many' / '탭03.md'
        b.open_file(P(path))
        t0 = time.time()
        write(path, '# 합친 뒤 고침\n')
        done = "() => __mdv.preview.article.querySelector('h1')?.textContent === '합친 뒤 고침'"
        try:
            b.wait(done, 3000)
        except Exception:
            # 실패하면 원인을 가릴 정보를 남기고, 늦게라도 반영되는지 더 기다려 본다.
            diag = b.ev('''() => ({ active: __mdv.tabs.active()?.path, h1: __mdv.preview.article.querySelector('h1')?.textContent,
                state: __mdv.activeDoc()?.state, version: __mdv.activeDoc()?.version, es: __mdv.bridge.source?.readyState ?? null,
                tabs: __mdv.tabs.tabs.length, retired: document.title })''')
            try:
                b.wait(done, 7000)
                late = f'{time.time() - t0:.1f}s 뒤 반영'
            except Exception:
                late = '10초 안에 반영 안 됨'
            raise RuntimeError(f'3초 안에 반영 안 됨({late}) {diag} 오류={b.errors[:3]}')
        dt = time.time() - t0
        check('FR-FILE-04', '실행 7번: 마지막 뷰어 탭 하나가 모든 문서를 갖고 감시도 동작', has_all and dt < 1.0, f'탭 {len(st["tabs"])}개, 반영 {dt * 1000:.0f} ms')
        for o in olds:
            if not o.page.is_closed():
                o.page.close()
    guard('FR-FILE-04', '뷰어 탭 합치기', t_merge_viewers)

    def t_perf_in_app():
        a = cur[0]
        open_js = '''async (p) => {
            const ex = __mdv.tabs.tabs.find(t => t.path === p);
            if (ex) __mdv.closeTab(ex.id);
            const t0 = performance.now();
            await __mdv.openFile(p);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return performance.now() - t0;
        }'''
        renders = [a.ev(open_js, P(DOCS / 'one-mb.md')) for _ in range(10)]
        med = statistics.median(renders)
        check('NFR-PERF-02', '1 MB 문서 열기+미리보기 렌더링 1초 이내(10회 중앙값)', med < 1000, f'{med:.0f} ms (min {min(renders):.0f}, max {max(renders):.0f})')
        finds = [a.ev('''() => {
            const t0 = performance.now();
            __mdv.preview.find({ text: '사과', caseSensitive: false, wholeWord: false, regex: false });
            const dt = performance.now() - t0;
            __mdv.preview.clearFind();
            return dt;
        }''') for _ in range(10)]
        check('NFR-PERF-05', '1 MB 문서 찾기 강조 0.3초 이내(10회 중앙값)', statistics.median(finds) < 300, f'{statistics.median(finds):.0f} ms')
        tens = [a.ev(open_js, P(DOCS / 'ten-mb.md')) for _ in range(3)]
        responsive = a.ev('() => 1') == 1
        check('NFR-PERF-03', '10 MB 파일 원문 표시 2초 이내', statistics.median(tens) < 2000 and a.state()['mode'] == 'source' and responsive, f'{statistics.median(tens):.0f} ms')
    guard('NFR-PERF', '뷰어 안 성능', t_perf_in_app)

    def t_stale_reopen():
        a = cur[0]
        p = write(DOCS / 'stale.md', '# 예전 내용\n')
        a.open_file(P(p))
        a.ev('() => { for (const t of [...__mdv.tabs.tabs]) __mdv.closeTab(t.id); }')
        a.settle()
        write(p, '# 새 내용\n')
        a.page.wait_for_timeout(300)
        a.key('Alt+Shift+T')
        a.wait('() => __mdv.tabs.active()?.path.endsWith("stale.md")')
        a.settle()
        check('FR-FILE-05', '모든 탭을 닫고 파일이 바뀐 뒤 다시 열면 새 내용', a.h1() == '새 내용', a.h1())
    guard('FR-FILE-05', '닫은 탭 다시 열기', t_stale_reopen)

    ED = DOCS / '편집'

    def t_edit_save():
        a = cur[0]
        f = ED / '고칠 문서.md'
        a.open_file(P(f))
        ed_source(a)
        ed_type(a, '추가 줄')
        ed_dirty(a)
        st = a.status()
        check('FR-EDIT-02', '고치면 탭·창 제목·상태 표시줄에 수정됨 표시', a.page.locator('.tab.active.dirty').count() == 1 and a.page.title().startswith('●') and '수정됨' in st,
              f'{a.page.title()} | {st}')
        for _ in range(8):
            if '추가' not in ed_text(a):
                break
            a.key('Control+z')
        ed_dirty(a, False)
        check('FR-EDIT-01', '실행 취소(Ctrl+Z)로 저장한 내용과 같아지면 수정됨이 꺼진다', a.page.locator('.tab.active.dirty').count() == 0 and not a.page.title().startswith('●'), a.page.title())
        a.key('Control+y')
        ed_dirty(a)
        check('FR-EDIT-01', '다시 실행(Ctrl+Y)', '추가 줄' in ed_text(a))
        a.key('Control+s')
        ed_dirty(a, False)
        want = b'\xef\xbb\xbf' + '# 편집 시험\r\n\r\n사과 사과 사과\r\n추가 줄'.encode('utf-8')
        got = f.read_bytes()
        check('FR-EDIT-04', 'Ctrl+S: 원래 인코딩·BOM·줄 끝(UTF-8 BOM, CRLF)으로 제자리에 저장한다', got == want, got[:60])
        ver = a.ev('() => __mdv.activeDoc().version')
        a.page.wait_for_timeout(1500)
        check('FR-EDIT-09', '자기 저장의 감시 알림으로 다시 읽거나 충돌 띠를 띄우지 않는다',
              not a.page.locator('#edit-bar').is_visible() and a.ev('() => __mdv.activeDoc().version') == ver and not a.ev('() => __mdv.activeDoc().dirty'))
    guard('FR-EDIT-04', '편집·저장', t_edit_save)

    def t_edit_cp949():
        a = cur[0]
        f = ED / '완성형.md'
        a.open_file(P(f))
        ed_source(a)
        ed_type(a, '가나')
        ed_dirty(a)
        a.key('Control+s')
        ed_dirty(a, False)
        got = f.read_bytes()
        check('NFR-ENC-05', 'CP949 문서(확장 글자 똠 포함)를 CP949로 저장한다', got == '# 완성형\n\n똠방각하 본문\n가나'.encode('cp949'), got)
        ed_type(a, ' 😀')
        ed_dirty(a)
        a.key('Control+s')
        body = ed_dialog(a, 'UTF-8로 저장')
        ed_dirty(a, False)
        got = f.read_bytes().decode('utf-8', errors='replace')
        enc = a.page.locator('[data-field="encoding"]').inner_text()
        check('FR-EDIT-04', 'CP949에 없는 글자(😀)가 있으면 UTF-8로 저장할지 묻고 UTF-8로 쓴다', '😀' in body and got.endswith('가나 😀') and enc == 'UTF-8', f'{body} | {got[-10:]} | {enc}')
    guard('NFR-ENC-05', '인코딩 지켜 저장', t_edit_cp949)

    def t_edit_conflict():
        a = cur[0]
        f = ED / '충돌.md'
        a.open_file(P(f))
        ed_source(a)
        ed_type(a, '내 수정')
        ed_dirty(a)
        write(f, '# 충돌\n\n밖에서 고침\n')
        a.wait('() => !document.getElementById("edit-bar").hidden', 6000)
        bar = a.page.locator('#edit-bar').inner_text()
        check('FR-EDIT-09', '고친 채 밖에서 바뀌면 덮지 않고 알림 띠를 띄운다', '내 수정' in ed_text(a) and '밖에서' in bar, bar)
        a.page.locator('#edit-bar button', has_text='내 것 유지').click()
        a.key('Control+s')
        body = ed_dialog(a, '덮어쓰기')
        ed_dirty(a, False)
        check('FR-EDIT-09', '내 것을 두고 저장하면 디스크가 바뀌었다고 묻고, 고르면 덮어쓴다', '바꿨습니다' in body and f.read_bytes().decode('utf-8').endswith('내 수정'), body)
        ed_type(a, ' 둘째')
        ed_dirty(a)
        write(f, '# 충돌\n\n밖에서 또 고침\n')
        a.wait('() => !document.getElementById("edit-bar").hidden', 6000)
        a.page.locator('#edit-bar button', has_text='디스크 내용으로 다시 읽기').click()
        a.wait('() => !__mdv.activeDoc().dirty && __mdv.source.textOf(__mdv.activeDoc().id)?.includes("또 고침")', 6000)
        check('FR-EDIT-09', '다시 읽기를 고르면 고친 내용을 버리고 디스크 내용을 보인다', not a.page.locator('#edit-bar').is_visible() and '둘째' not in ed_text(a))
    guard('FR-EDIT-09', '외부 변경 충돌', t_edit_conflict)

    def t_edit_close():
        a = cur[0]
        f = ED / '닫기.md'
        orig = f.read_bytes()
        a.open_file(P(f))
        ed_source(a)
        ed_type(a, '버릴 내용')
        ed_dirty(a)
        n0 = len(a.state()['tabs'])
        a.key('Alt+w')
        body = ed_dialog(a, '취소')
        kept = len(a.state()['tabs']) == n0 and a.state()['active'] == P(f)
        a.key('Alt+w')
        ed_dialog(a, '저장 안 함')
        a.wait('(n) => __mdv.tabs.tabs.length === n - 1', 3000, arg=n0)
        check('FR-EDIT-08', '고친 탭을 닫으면 묻는다: 취소는 남기고, 저장 안 함은 버리고 닫는다', kept and '닫기.md' in body and f.read_bytes() == orig, body)
        a.open_file(P(f))
        check('FR-EDIT-08', '저장 안 함으로 닫은 문서를 다시 열면 디스크 내용이다', '버릴' not in a.ev('() => __mdv.activeDoc().text'))
        ed_source(a)
        ed_type(a, '저장할 내용')
        ed_dirty(a)
        a.key('Alt+w')
        ed_dialog(a, '저장')
        a.wait('(n) => __mdv.tabs.tabs.length === n - 1', 5000, arg=n0)
        check('FR-EDIT-08', '닫기 확인에서 저장을 고르면 저장하고 닫는다', f.read_bytes().decode('utf-8').endswith('저장할 내용'))
    guard('FR-EDIT-08', '닫기 확인', t_edit_close)

    def t_edit_new_saveas():
        a = cur[0]
        a.key('Alt+Shift+n')
        a.wait('() => __mdv.activeDoc()?.untitled === true && __mdv.tabs.active().mode === "source"', 8000)
        a.wait('() => !!__mdv.source && __mdv.source.docId === __mdv.activeDoc().id', 8000)
        name = a.ev('() => __mdv.tabs.active().path')
        a.page.locator('.pane.source .cm-content').click()
        a.page.keyboard.type('# 새로 만든 문서\n\n본문')
        ed_dirty(a)
        a.key('Control+s')
        target = ED / '새로 만든 문서.md'
        default = ed_prompt(a, P(target))
        a.wait('(p) => __mdv.tabs.active()?.path === p && !__mdv.activeDoc().dirty', 6000, arg=P(target))
        check('FR-EDIT-06', '새 문서(Alt+Shift+N)를 원문 보기로 열고, 처음 저장할 때 경로를 물어 그 파일로 저장한다',
              '제목 없음' in name and default.endswith('.md') and target.read_bytes() == '# 새로 만든 문서\n\n본문'.encode('utf-8'), f'{name} | {default}')
        f = ED / '고칠 문서.md'
        a.open_file(P(f))
        before = f.read_bytes()
        n0 = len(a.state()['tabs'])
        a.key('Control+Shift+s')
        other = ED / '다른 이름.md'
        ed_prompt(a, P(other))
        a.wait('(p) => __mdv.tabs.active()?.path === p', 6000, arg=P(other))
        check('FR-EDIT-05', '다른 이름으로 저장(Ctrl+Shift+S): 같은 형식으로 새 파일에 쓰고 탭이 새 파일을 가리킨다',
              other.read_bytes() == before and f.read_bytes() == before and len(a.state()['tabs']) == n0, other.read_bytes()[:20])
        outside = pathlib.Path('\\\\wsl.localhost\\' + DISTRO + '\\tmp\\mdv-e2e-outside.md')
        a.key('Control+Shift+s')
        ed_prompt(a, '/tmp/mdv-e2e-outside.md')
        a.page.wait_for_timeout(500)
        toasts = a.page.locator('.toast').all_inner_texts()
        check('NFR-SEC-05', '실행기 허용 폴더 밖으로는 다른 이름으로 저장하지 않는다', any('허용된 폴더 밖' in t for t in toasts) and not outside.exists(), toasts[-2:])
    guard('FR-EDIT-05', '새 문서·다른 이름으로 저장', t_edit_new_saveas)

    def t_edit_replace():
        a = cur[0]
        f = ED / '바꾸기.md'
        a.open_file(P(f))
        ed_source(a)
        a.key('Control+h')
        a.page.locator('.findbar .find-row input').fill('사과')
        a.page.locator('.findbar .replace-input').fill('배')
        a.page.locator('.findbar .replace-button', has_text='모두 바꾸기').click()
        a.page.wait_for_timeout(200)
        t1 = ed_text(a)
        a.page.locator('.pane.source .cm-content').click()
        a.key('Control+z')
        t2 = ed_text(a)
        ed_dirty(a, False)
        check('FR-EDIT-07', '찾아 바꾸기(Ctrl+H): 모두 바꾸기 뒤 실행 취소 한 번으로 돌아온다',
              t1.count('배') == 3 and '사과' not in t1 and t2.count('사과') == 3 and a.page.locator('.findbar .replace-row').is_visible(), f'{t1!r} → {t2!r}')
        a.page.locator('.findbar .find-row input').press('Escape')
    guard('FR-EDIT-07', '찾아 바꾸기', t_edit_replace)

    def t_edit_autosave():
        a = cur[0]
        f = ED / '자동.md'
        a.open_file(P(f))
        ed_source(a)
        a.ev("() => __mdv.cmds.run('settings.autoSave')")
        t0 = time.time()
        ed_type(a, '자동으로')
        ed_dirty(a)
        ed_dirty(a, False, 6000)
        dt = time.time() - t0
        got = f.read_bytes().decode('utf-8')
        a.ev("() => __mdv.cmds.run('settings.autoSave')")
        check('FR-EDIT-10', '자동 저장을 켜면 입력이 멈추고 약 1초 뒤 저장한다', got.endswith('자동으로') and a.ev('() => __mdv.settings.autoSave') is False, f'{dt:.1f}s')
    guard('FR-EDIT-10', '자동 저장', t_edit_autosave)

    def t_edit_perf():
        a = cur[0]
        a.open_file(P(ED / '백 킬로.md'))
        a.ev("() => __mdv.cmds.run('view.split')")
        a.wait('() => !!__mdv.source && __mdv.source.docId === __mdv.activeDoc().id', 8000)
        a.page.wait_for_timeout(300)
        lat = [a.ev(EDIT_TO_PREVIEW, f'표지백{i}') for i in range(5)]
        a.ev(ED_DISCARD_CLOSE)
        med100 = statistics.median(lat)
        check('NFR-PERF-08', '100 KB 문서 분할 보기: 입력이 멈춘 뒤 미리보기 반영 0.5초 이하(5회 중앙값)', med100 <= 500, f'{med100:.0f} ms (max {max(lat):.0f})')
        a.open_file(P(DOCS / 'one-mb.md'))
        a.ev("() => __mdv.cmds.run('view.split')")
        a.wait('() => !!__mdv.source && __mdv.source.docId === __mdv.activeDoc().id', 8000)
        a.page.wait_for_timeout(500)
        lat1 = [a.ev(EDIT_TO_PREVIEW, f'표지메가{i}') for i in range(3)]
        med1 = statistics.median(lat1)
        a.ev("() => __mdv.cmds.run('view.source')")
        a.page.wait_for_timeout(300)
        keys = a.ev(KEY_LATENCY)
        medk = statistics.median(keys)
        a.ev(ED_DISCARD_CLOSE)
        check('NFR-PERF-08', '1 MB 문서 분할 보기: 입력이 멈춘 뒤 미리보기 반영 2초 이하(3회 중앙값)', med1 <= 2000, f'{med1:.0f} ms (max {max(lat1):.0f})')
        check('NFR-PERF-08', '1 MB 문서 원문 보기: 키 입력 반영 50 ms 이하(10회 중앙값)', medk <= 50, f'{medk:.1f} ms (max {max(keys):.1f})')
        check('FR-EDIT-01', '편집 시험 뒤 화면 스크립트 오류 없음', not a.errors, a.errors[:3])
    guard('NFR-PERF-08', '편집 반응', t_edit_perf)

    def t_abnormal():
        # 깊은 중첩, 1만 행 표, 10만 자 한 줄, 빈 파일 (NFR-REL-01)
        a = cur[0]
        res = []
        for f in sorted((DOCS / '비정상').iterdir()):
            t0 = time.time()
            a.open_file(P(f))
            a.wait('(p) => __mdv.tabs.active()?.path === p', 10000, arg=P(f))
            a.page.wait_for_timeout(300)  # 렌더링 디바운스가 지나 실제로 그리게 한다
            a.settle()
            dt = time.time() - t0
            t1 = time.time()
            alive = a.ev('() => 1') == 1
            res.append((f.name, round(dt, 2), alive and time.time() - t1 < 1.0))
        a.open_file(P(DOCS / '비정상' / '긴 한 줄.md'))
        a.key('Control+2')
        a.wait('() => !!document.querySelector(".pane.source .cm-content")', 8000)
        a.key('Control+1')
        bad = [r for r in res if not r[2] or r[1] > 5]
        check('NFR-REL-01', '비정상 입력: 멈춤·크래시 없이 열린다', not bad and not a.errors, f'{res} 오류={a.errors[:3]}')
    guard('NFR-REL-01', '비정상 입력', t_abnormal)

    a = cur[0]
    check('NFR-REL-01', '실행 중 화면 스크립트 오류 없음', not a.errors, a.errors[:3])
    # CSP가 보내기 전에 막은 요청(다이어그램 무대 iframe 등)은 밖으로 나가지 않았으므로 세지 않는다.
    requests = [r.url for r in reqs if 'csp' not in (r.failure or '').lower()]
    blocked = sorted({r.url for r in reqs if 'csp' in (r.failure or '').lower()})
    others = [u for u in requests if not (u.startswith(f'http://127.0.0.1:{port}/') or u.startswith('data:') or u.startswith('blob:')
                                         or u == 'https://example.com/remote.png')]
    stop_calls = [u for u in requests if '/api/stop' in u or 'localhost' in u or ':9/' in u]
    check('NFR-SEC-04', '실행기와 원격 이미지 외 요청 0건(문서가 쓴 루프백 주소 요청 없음)', not others and not stop_calls, (others + stop_calls)[:5])
    check('NFR-SEC-04', 'Mermaid: 다이어그램이 부르려던 바깥 주소는 무대의 CSP가 보내기 전에 막는다',
          any('leak' in u for u in blocked) and not any('leak' in u for u in requests), blocked[:6])
    a.page.close()


# ---------------------------------------------------------------- 실행기 모드: 세션 (SRS 8장)

MODE_CMD = {'preview': 'view.preview', 'source': 'view.source', 'split': 'view.split'}


def set_tab(a, i, mode, px):
    """i번째 탭을 열어 보기 모드를 바꾸고, 사용자가 스크롤한 것처럼 px만큼 내린다. 기록된 줄을 돌려준다."""
    a.ev('(i) => __mdv.tabs.activate(__mdv.tabs.tabs[i].id)', i)
    a.settle()
    a.ev('(c) => __mdv.cmds.run(c)', MODE_CMD[mode])
    if mode != 'preview':
        a.wait('() => !!__mdv.source && !!document.querySelector(".pane.source .cm-content")', 8000)
    a.settle()
    a.page.wait_for_timeout(300)
    if mode == 'source':
        a.ev('(px) => { __mdv.source.view.scrollDOM.scrollTop = px; }', px)
    else:
        a.ev('(px) => { __mdv.preview.el.scrollTop = px; }', px)
    a.page.wait_for_timeout(400)
    return a.ev('() => __mdv.tabs.active().line')


def view_line(a, mode):
    return a.ev('() => __mdv.source?.topLine() ?? null' if mode == 'source' else '() => __mdv.preview.topLine()')


def compare_session(a, before, rid, how):
    """다시 연 뷰어의 탭·모드·줄·활성 탭을 이전 상태와 맞춰 보고, 탭마다 실제 화면 위치도 잰다."""
    after = a.state()
    paths_ok = [t['path'] for t in after['tabs']] == [t['path'] for t in before['tabs']]
    modes_ok = [t['mode'] for t in after['tabs']] == [t['mode'] for t in before['tabs']]
    line_diff = max((abs(x['line'] - y['line']) for x, y in zip(after['tabs'], before['tabs'])), default=99) if paths_ok else 99
    active_ok = after['active'] == before['active']
    check(rid, f'{how} 뒤 다시 열기: 탭 10개 순서·보기 모드·줄·활성 탭 복원',
          len(after['tabs']) == 10 and paths_ok and modes_ok and line_diff < 2 and active_ok,
          f'tabs={len(after["tabs"])} 순서={paths_ok} 모드={modes_ok} 줄 최대 차이={line_diff:.2f} 활성={active_ok}')
    diffs, notes = [], []
    for i, t in enumerate(before['tabs']):
        a.ev('(i) => __mdv.tabs.activate(__mdv.tabs.tabs[i].id)', i)
        got = settled(lambda: view_line(a, t['mode']))
        diffs.append(abs(got - t['line']) if got is not None else 99)
        if diffs[-1] >= 2:  # 늦게 맞는지(시간 문제), 계속 어긋나는지 가린다
            a.page.wait_for_timeout(2000)
            late = view_line(a, t['mode'])
            info = a.ev('() => ({ st: __mdv.source?.view.scrollDOM.scrollTop, settling: __mdv.source?.settling, pv: __mdv.preview.topLine(), h: __mdv.source?.view.contentHeight })')
            notes.append(f'탭{i}({t["mode"]}) 저장 {t["line"]:.1f} 잰 값 {got:.1f} 2초 뒤 {late:.1f} {info}')
    a.ev('(i) => __mdv.tabs.activate(__mdv.tabs.tabs[i].id)', [t['path'] for t in before['tabs']].index(before['active']))
    a.settle()
    check(rid, f'{how} 뒤 다시 열기: 탭마다 화면 위치가 저장한 줄과 일치', max(diffs) < 2, '차이 ' + ', '.join(f'{d:.1f}' for d in diffs) + ''.join(' / ' + n for n in notes))


def shuffle(a, modes, shift, base, step, active):
    lines = []
    for i in range(10):
        mode, px = modes[(i + shift) % 3], base + i * step
        line = set_tab(a, i, mode, px)
        # 보기 모드·패널 너비에 따라 글줄 폭이 달라, 다른 탭이 거의 같은 줄에 설 수 있다.
        # 그러면 복원이 탭끼리 뒤섞여도 가려내지 못하므로 조금 더 내려 다른 줄을 잡는다.
        for _ in range(5):
            if all(abs(line - x) >= 1 for x in lines):
                break
            px += 90
            line = set_tab(a, i, mode, px)
        lines.append(line)
    a.ev('(i) => __mdv.tabs.activate(__mdv.tabs.tabs[i].id)', active)
    a.settle()
    a.page.wait_for_timeout(1200)  # 세션 자동 저장(500 ms 디바운스)이 끝날 시간
    return lines


def run_session10(pw, ctx):
    """SRS 8장 인수 기준: 탭 10개를 서로 다른 보기 모드로 두고 새로 고침·탭 닫기·렌더러 충돌·실행기 재시작 뒤
    다시 열면 탭·모드·스크롤 위치가 일치한다 (FR-SESS-01~02, NFR-REL-02). 다른 포트(=다른 저장소)를 쓴다."""
    L = Launcher('home-session', 17817)
    paths = [P(DOCS / '세션' / f'세션 문서 {n:02d}.md') for n in range(10)]
    modes = ['preview', 'source', 'split']
    url = L.open(root=P(DOCS))
    check('FR-LAUNCH-01', '파일 없이 부르면 빈 뷰어를 연다', '빈 뷰어' in L.last_out, L.last_out.strip().splitlines()[0])
    a = Viewer.open(ctx, url)
    for p in paths:
        a.open_file(p)
    lines = shuffle(a, modes, 0, 400, 260, 4)
    box = a.page.locator('#resizer').bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    a.page.mouse.move(x, y)
    a.page.mouse.down()
    a.page.mouse.move(x + 90, y, steps=6)
    a.page.mouse.up()
    width = a.ev('() => __mdv.session.sidePanel.width')
    box = a.page.locator('#toc-resizer').bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    a.page.mouse.move(x, y)
    a.page.mouse.down()
    a.page.mouse.move(x - 70, y, steps=6)
    a.page.mouse.up()
    toc_width = a.ev('() => __mdv.session.tocPanel.width')
    a.page.wait_for_timeout(800)
    before = a.state()
    check('FR-SESS-01', '세션 시험 준비: 탭 10개, 서로 다른 줄', len(before['tabs']) == 10 and len({round(v, 1) for v in lines}) == 10 and min(lines) > 3,
          'lines=' + ', '.join(f'{v:.1f}' for v in lines))

    # 1) 새로 고침
    a.page.reload()
    a.page.wait_for_selector('body[data-restored="1"]', timeout=30000)
    compare_session(a, before, 'FR-SESS-01', '새로 고침')
    side = a.ev('() => ({ visible: !document.getElementById("side").hidden, width: Math.round(document.getElementById("side").getBoundingClientRect().width) })')
    check('FR-SESS-02', '사이드 패널 열림 상태·너비 기억', side['visible'] and abs(side['width'] - width) <= 1, f'{width} → {side}')
    toc = a.ev('() => ({ visible: !document.getElementById("toc-side").hidden, width: Math.round(document.getElementById("toc-side").getBoundingClientRect().width) })')
    check('FR-SESS-02', '목차 패널 열림 상태·너비 기억', toc['visible'] and toc_width > 240 and abs(toc['width'] - toc_width) <= 1, f'{toc_width} → {toc}')

    # 2) 브라우저 탭 닫기 → 토큰만 있는 주소로 다시 열기
    shuffle(a, modes, 1, 300, 310, 7)
    a.key('Control+b')
    a.key('Control+Alt+b')
    a.page.wait_for_timeout(800)
    before = a.state()
    a.page.close()
    a = Viewer.open(ctx, L.url())
    compare_session(a, before, 'FR-SESS-01', '브라우저 탭 닫기')
    check('FR-SESS-02', '사이드 패널 닫힘 상태 기억', a.ev('() => document.getElementById("side").hidden') is True)
    check('FR-SESS-02', '목차 패널 닫힘 상태 기억', a.ev('() => document.getElementById("toc-side").hidden') is True)

    # 3) 렌더러 충돌: 마지막 자동 저장만 믿는다 (NFR-REL-02)
    shuffle(a, modes, 2, 500, 200, 2)
    before = a.state()
    crash_renderer(a)
    a.page.close()
    a = Viewer.open(ctx, L.url())
    compare_session(a, before, 'NFR-REL-02', '렌더러 충돌')

    # 4) 실행기 재시작: 열린 뷰어는 끊김을 알리고, 다시 뜬 실행기(같은 포트·토큰)에 스스로 다시 붙는다
    shuffle(a, modes, 0, 350, 280, 9)
    before = a.state()
    pid0, tok0 = L.pid(), L.token
    L.stop()
    a.wait("() => document.getElementById('statusbar').textContent.includes('연결 끊김')", 8000)
    offline = True
    url2 = L.open(root=P(DOCS))
    pid1 = L.pid()
    a.wait("() => !document.getElementById('statusbar').textContent.includes('연결 끊김')", 15000)
    path = DOCS / '세션' / '세션 문서 09.md'
    original = path.read_bytes()
    write(path, original.decode('utf-8').replace('# 세션 문서 9', '# 세션 문서 9 (재시작 뒤)', 1))
    a.wait("(p) => __mdv.docs.byPath(p)?.text.startsWith('# 세션 문서 9 (재시작 뒤)')", 5000, arg=P(path))
    path.write_bytes(original)
    a.page.wait_for_timeout(600)
    check('NFR-REL-02', '실행기가 끝나면 끊김 표시, 다시 뜨면 같은 주소로 다시 붙어 감시를 잇는다',
          offline and pid0 != pid1 and parse_qs(urlparse(str(url2)).query)['t'][0] == tok0, f'pid {pid0} → {pid1}')
    a.page.close()
    a = Viewer.open(ctx, L.url())
    compare_session(a, before, 'FR-SESS-01', '실행기 재시작')

    # 5) 열린 파일 표시 설정은 다시 열어도 남고, 목록으로 바꾸면 숨겨 둔 왼쪽 패널을 연다
    a.ev('() => __mdv.cmds.run("view.openFiles.list")')
    shown = a.ev('() => !document.getElementById("side").hidden')
    a.page.wait_for_timeout(800)
    a.page.reload()
    a.page.wait_for_selector('body[data-restored="1"]', timeout=30000)
    kept = a.ev('() => document.querySelectorAll("#open-files:not([hidden]) #tabbar.vertical .tab").length')
    check('FR-SESS-02', '열린 파일 표시(왼쪽 목록) 설정 기억', shown and kept == 10, f'패널 열림={shown} 목록 항목={kept}')
    a.page.close()
    L.stop()


# ---------------------------------------------------------------- 실행기 모드: 보안·유휴 종료

def run_security(L):
    port = int(urlparse(L.base).port)
    tok = L.token
    doc = quote(P(DOCS / 'README.md'))
    code, out, err = wsl('ln', '-sfn', '/etc', P(DOCS) + '/밖으로')
    cases = {
        '토큰 없는 페이지': get(port, '/'),
        '틀린 토큰 페이지': get(port, '/?t=wrong'),
        '토큰 없는 API': get(port, f'/api/read?path={doc}'),
        '다른 Host(DNS 리바인딩)': get(port, f'/api/read?t={tok}&path={doc}', host=f'evil.example:{port}'),
        '허용 폴더 밖': get(port, f'/api/read?t={tok}&path={quote("/etc/passwd")}'),
        '.. 로 빠져나가기': get(port, f'/api/read?t={tok}&path={quote(P(DOCS) + "/../../../etc/passwd")}'),
        '심볼릭 링크로 빠져나가기': get(port, f'/api/read?t={tok}&path={quote(P(DOCS) + "/밖으로/passwd")}'),
        '허용 폴더 밖 이미지': get(port, f'/api/file?t={tok}&path={quote("/usr/share/pixmaps/debian-logo.png")}'),
    }
    codes = {k: v[0] for k, v in cases.items()}
    check('NFR-SEC-02', '무토큰·외부 Host·허용 폴더 밖 요청은 모두 403', all(c == 403 for c in codes.values()), codes)
    st, h, _ = get(port, f'/?t={tok}')
    csp = h.get('content-security-policy', '')
    check('NFR-SEC-02', '뷰어 페이지: CSP(frame-ancestors 포함)·리퍼러 차단 헤더', st == 200 and "frame-ancestors 'none'" in csp and "script-src 'sha256-" in csp
          and h.get('referrer-policy') == 'no-referrer', f'{st} {csp[:80]}…')
    st, h, _ = get(port, f'/?t={tok}', host=f'localhost:{port}')
    check('NFR-SEC-02', 'localhost로 오면 127.0.0.1로 돌려보낸다(저장소를 한 origin에)', st == 302 and h.get('location', '').startswith(f'http://127.0.0.1:{port}/'), f'{st} {h.get("location")}')
    st, _, body = get(port, f'/api/read?t={tok}&path={doc}')
    check('NFR-SEC-02', '정상 요청은 통과(대조군)', st == 200 and body.startswith('# 사용 설명서'.encode('utf-8')), st)
    # 쓰기 (NFR-SEC-02·05): 토큰·Origin·형식·허용 폴더·확장자
    origin = {'Origin': f'http://127.0.0.1:{port}', 'Content-Type': 'application/octet-stream'}
    before = (DOCS / 'README.md').read_bytes()
    w = {
        '토큰 없는 쓰기': post(port, f'/api/write?path={doc}', b'x', origin),
        '다른 Origin': post(port, f'/api/write?t={tok}&path={doc}', b'x', {**origin, 'Origin': 'http://evil.example'}),
        'Origin 없음': post(port, f'/api/write?t={tok}&path={doc}', b'x', {'Content-Type': 'application/octet-stream'}),
        '허용 폴더 밖': post(port, f'/api/write?t={tok}&path={quote("/tmp/mdv-e2e-w.md")}&create=1', b'x', origin),
        '심볼릭 링크로 빠져나가기': post(port, f'/api/write?t={tok}&path={quote(P(DOCS) + "/밖으로/mdv-e2e.md")}&create=1', b'x', origin),
        '문서가 아닌 확장자': post(port, f'/api/write?t={tok}&path={quote(P(DOCS) + "/run.sh")}&create=1', b'x', origin),
    }
    form = post(port, f'/api/write?t={tok}&path={doc}', b'x', {**origin, 'Content-Type': 'text/plain'})
    check('NFR-SEC-05', '쓰기: 무토큰·다른 Origin·허용 폴더 밖·문서가 아닌 확장자는 403, 단순 요청 형식은 400, 파일은 그대로',
          all(c == 403 for c in w.values()) and form == 400 and (DOCS / 'README.md').read_bytes() == before and not (DOCS / 'run.sh').exists(), {**w, 'text/plain': form})


def run_idle(pw, ctx):
    """FR-LAUNCH-03: 연결된 뷰어가 있으면 버티고, 없으면 유휴 시간 뒤 스스로 끝난다(시험은 3초로 줄인다)."""
    L = Launcher('home-idle', 17797, env={'MDVIEW_IDLE_MS': '3000'})
    url = L.open(P(DOCS / 'README.md'), root=P(DOCS))
    v = Viewer.open(ctx, url)
    v.page.wait_for_timeout(5000)
    alive = L.pid()
    v.page.close()
    t0 = time.time()
    gone = None
    while time.time() - t0 < 20:
        if L.pid() is None:
            gone = time.time() - t0
            break
        time.sleep(0.5)
    check('FR-LAUNCH-03', '뷰어가 열려 있으면 유휴 시간이 지나도 버틴다', alive is not None, alive)
    check('FR-LAUNCH-03', '뷰어를 닫으면 유휴 시간 뒤 스스로 끝난다', gone is not None and '유휴' in L.logs(), f'{gone:.1f}s' if gone else '끝나지 않음')


# ---------------------------------------------------------------- 성능: 시작·메모리

def run_startup(pw, ctx):
    """NFR-PERF-01: 실행기 명령부터(브라우저를 띄우는 시간 제외) 첫 탭을 그릴 때까지. 실행기를 매번 멈춘 콜드 스타트, 10회 중앙값."""
    L = Launcher('home-perf', 17807)
    readme = P(DOCS / 'README.md')
    cli, page_ms = [], []
    for i in range(11):
        L.stop()
        url, ms = L.open(readme, root=P(DOCS), timed=True)
        v = Viewer.open(ctx, url, restored=False)
        v.wait('() => window.__mdvReadyAt !== undefined', 10000)  # 첫 탭을 그린 다음 프레임에 적힌다
        ready = v.ev('() => window.__mdvReadyAt')
        v.page.close()
        if i > 0:  # 첫 회는 준비 실행
            cli.append(ms)
            page_ms.append(ready)
    total = [c + p for c, p in zip(cli, page_ms)]
    check('NFR-PERF-01', '뷰어 페이지 열기~첫 탭 렌더링 1초 이내(10회 중앙값)', statistics.median(page_ms) <= 1000,
          f'{statistics.median(page_ms):.0f} ms (min {min(page_ms):.0f}, max {max(page_ms):.0f})')
    check('NFR-PERF-01', '실행기 명령(콜드)+페이지 2초 이내(10회 중앙값)', statistics.median(total) <= 2000,
          f'{statistics.median(total):.0f} ms = 실행기 {statistics.median(cli):.0f} + 페이지 {statistics.median(page_ms):.0f}')
    L.stop()


def run_memory(pw, ctx):
    """NFR-PERF-06: 일반 문서 탭 20개를 연 뷰어 페이지의 JS 힙 사용량(가비지 수집 뒤). 세션이 섞이지 않게 실행기를 따로 둔다."""
    L = Launcher('home-mem', 17827)
    v = Viewer.open(ctx, L.open(P(DOCS / 'many' / '탭00.md'), root=P(DOCS)))
    for n in range(1, 20):
        v.open_file(P(DOCS / 'many' / f'탭{n:02d}.md'))
    for _ in range(20):  # 모든 탭을 한 번씩 보여 렌더링 캐시까지 채운 상태로 잰다
        v.key('Alt+PageDown')
    v.page.wait_for_timeout(1000)
    cdp = ctx.new_cdp_session(v.page)
    cdp.send('HeapProfiler.collectGarbage')
    heap = cdp.send('Runtime.getHeapUsage')
    used, total = heap['usedSize'] / 1048576, heap['totalSize'] / 1048576
    tabs = len(v.state()['tabs'])
    check('NFR-PERF-06', f'일반 문서 탭 {tabs}개: JS 힙 200 MB 이하', tabs == 20 and used <= 200, f'사용 {used:.1f} MB (할당 {total:.1f} MB)')
    v.page.close()
    L.stop()


# ---------------------------------------------------------------- 독립 모드 (file://)

# ---------------------------------------------------------------- Windows 앱 (MDViewer.exe)

user32 = ctypes.windll.user32
APP_PORT = 9333
WM_SYSCOMMAND = 0x0112
SC_CLOSE = 0xF060


def app_window(pid):
    """그 프로세스의 보이는 최상위 창"""
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


class App:
    """MDViewer.exe 하나. 프로필(설정·세션·WebView2)과 레지스트리 등록 위치를 시험용으로 따로 둔다."""

    def __init__(self, pw, args, profile, regroot):
        self.env = dict(os.environ, MDVIEW_PROFILE_DIR=str(profile), MDVIEW_REGROOT=regroot,
                        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f'--remote-debugging-port={APP_PORT}')
        self.t0 = time.time()
        self.proc = subprocess.Popen([str(EXE), *map(str, args)], env=self.env)
        self.browser = None
        for _ in range(150):
            try:
                self.browser = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{APP_PORT}')
                break
            except Exception:
                time.sleep(0.1)
        if not self.browser:
            raise RuntimeError('CDP 연결 실패')
        # sync API는 time.sleep 동안 이벤트를 처리하지 않으므로 Playwright 대기로 이벤트를 돌린다.
        page = None
        deadline = time.time() + 20
        while time.time() < deadline and not page:
            pages = [pg for c in self.browser.contexts for pg in c.pages]
            hit = [pg for pg in pages if 'app.mdview' in pg.url]
            if hit:
                page = hit[0]
            elif pages:
                pages[0].wait_for_timeout(100)
            elif self.browser.contexts:
                try:
                    self.browser.contexts[0].wait_for_event('page', timeout=500)
                except Exception:
                    pass
            else:
                time.sleep(0.1)
        if not page:
            raise RuntimeError('앱 페이지를 찾지 못함')
        self.v = Viewer(page)
        page.wait_for_selector('body[data-ready="1"]', timeout=20000)

    def run(self, *args):
        """같은 프로필로 EXE를 한 번 더 실행한다(첫 인스턴스에 넘기고 바로 끝나야 한다)."""
        return subprocess.run([str(EXE), *map(str, args)], env=self.env, timeout=30).returncode

    def close(self, timeout=10):
        """사용자가 닫기 단추를 누른 것처럼(SC_CLOSE) 끝낸다. 닫기 전에 화면이 세션을 저장한다."""
        hwnd = app_window(self.proc.pid)
        if hwnd:
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_CLOSE, 0)
        try:
            return self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            return None
        finally:
            try:
                self.browser.close()
            except Exception:
                pass

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()


def reg_exists(root, sub):
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, root + '\\' + sub))
        return True
    except OSError:
        return False


def reg_delete_tree(root):
    try:
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, root, 0, winreg.KEY_ALL_ACCESS)
    except OSError:
        return
    while True:
        try:
            name = winreg.EnumKey(k, 0)
        except OSError:
            break
        reg_delete_tree(root + '\\' + name)
    winreg.CloseKey(k)
    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, root)


def run_desktop(pw):
    docs = LOCAL / '앱 문서'
    (docs / 'img').mkdir(parents=True, exist_ok=True)
    (docs / 'img' / 'dot.png').write_bytes(PNG_1PX)
    body = '\n\n![점](img/dot.png)\n\n[셋째로](셋째.md)\n\n' + '\n\n'.join(f'## 절 {i}\n\n' + '앱 본문 문장입니다. ' * 30 for i in range(30)) + '\n'
    write(docs / '첫 문서.md', '# 앱 첫 문서' + body)
    write(docs / '둘째.md', '# 둘째 문서\n')
    write(docs / '셋째.md', '# 셋째 문서\n')
    write(docs / '끌어 놓기.md', '# 끌어 놓은 문서\n')
    write(docs / '완성형.md', '# 완성형 문서\n\n똠방각하\n', encoding='cp949')
    write(docs / '작업 폴더' / '하나.md', '# 하나\n')
    write(docs / '작업 폴더' / '메모.txt', '메모\n')
    shutil.copy(DOCS / 'one-mb.md', docs / 'one-mb.md')
    if not (DOCS / 'xss.md').exists():
        write_xss(17787)
    shutil.copy(DOCS / 'xss.md', docs / 'xss.md')
    write(docs / 'diagrams.md', diagrams_text())
    profile = LOCAL / 'app-profile'
    regroot = 'Software\\MdViewer-e2e-' + uuid.uuid4().hex
    first = str(docs / '첫 문서.md')
    app = App(pw, [first], profile, regroot)
    cur = [app]
    startup = {}
    try:
        def t_start():
            v = cur[0].v
            v.wait('() => __mdv.preview.article.querySelector("img")?.naturalWidth > 0', 5000)
            v.wait('() => window.__mdvReadyAt !== undefined', 10000)
            st = v.ev('''() => ({ mode: __mdv.bridge.mode, title: document.title, tabs: __mdv.tabs.tabs.map(t => t.path),
                readyEpoch: performance.timeOrigin + window.__mdvReadyAt })''')
            check('FR-FILE-01', 'Windows 앱: 시작 인자로 연 문서를 그린다(한글 경로, 상대 경로 그림)',
                  st['mode'] == 'desktop' and st['tabs'] == [first] and v.h1() == '앱 첫 문서' and st['title'] == '첫 문서.md - MD Viewer', st)
            # 처음 실행(새 프로필·새 EXE)은 WebView2 프로필을 만들고 백신이 새 EXE를 검사해 더 걸린다. 판정은 다시 실행할 때 한다.
            startup['first'] = st['readyEpoch'] / 1000 - cur[0].t0
            shot(v, '20-desktop')
        guard('FR-FILE-01', 'Windows 앱 시작', t_start)

        def t_second_instance():
            v = cur[0].v
            t0 = time.time()
            code = cur[0].run(docs / '둘째.md')
            v.wait('(p) => __mdv.tabs.active()?.path === p', 5000, arg=str(docs / '둘째.md'))
            dt = time.time() - t0
            check('FR-FILE-04', 'Windows 앱: 다시 실행하면 첫 창의 새 탭으로 열고 바로 끝난다',
                  code == 0 and len(v.state()['tabs']) == 2 and v.h1() == '둘째 문서' and cur[0].proc.poll() is None, f'종료 코드 {code}, {dt:.2f}s')
        guard('FR-FILE-04', 'Windows 앱 두 번째 실행', t_second_instance)

        def t_link():
            v = cur[0].v
            v.open_file(first)
            v.ev('''() => [...__mdv.preview.root.querySelectorAll('a')].find(a => a.textContent === '셋째로').click()''')
            v.wait('() => __mdv.tabs.active()?.path.endsWith("셋째.md")', 5000)
            check('FR-NAV-03', 'Windows 앱: 문서 안 상대 링크를 새 탭으로 연다', v.h1() == '셋째 문서', v.state()['active'])
        guard('FR-NAV-03', 'Windows 앱 링크', t_link)

        def t_watch():
            v = cur[0].v
            v.open_file(first)
            v.ev('() => { __mdv.preview.el.scrollTop = 900; }')
            v.page.wait_for_timeout(300)
            line0 = v.ev('() => __mdv.tabs.active().line')
            lat = []
            for i in range(10):
                t0 = time.time()
                write(docs / '첫 문서.md', f'# 앱 저장 {i}' + body)
                v.wait('(m) => __mdv.preview.article.querySelector("h1")?.textContent === m', 3000, arg=f'앱 저장 {i}')
                lat.append((time.time() - t0) * 1000)
                v.page.wait_for_timeout(150)
            med = statistics.median(lat)
            line1 = settled(lambda: v.ev('() => __mdv.tabs.active().line'))
            check('FR-WATCH-01', 'Windows 앱: 밖에서 저장하면 다시 그리고 스크롤 줄을 지킨다', abs(line1 - line0) < 1.5, f'줄 {line0:.1f}→{line1:.1f}')
            check('NFR-PERF-04', 'Windows 앱: 저장부터 화면 반영 0.5초 이내(10회 중앙값)', med < 500, f'{med:.0f} ms (max {max(lat):.0f})')
            backup = (docs / '첫 문서.md').read_bytes()
            (docs / '첫 문서.md').unlink()
            v.wait('() => __mdv.activeDoc()?.state === "deleted"', 3000)
            (docs / '첫 문서.md').write_bytes(backup)
            v.wait('() => __mdv.activeDoc()?.state === "ok"', 3000)
            check('FR-WATCH-02', 'Windows 앱: 삭제 표시와 복구', True)
        guard('FR-WATCH-01', 'Windows 앱 파일 감시', t_watch)

        def t_folder():
            v = cur[0].v
            cur[0].run(docs / '작업 폴더')
            v.wait('() => document.querySelectorAll(".ws-item").length >= 2', 5000)
            items = v.page.locator('.ws-item').all_inner_texts()
            check('FR-NAV-02', 'Windows 앱: 폴더를 넘기면 작업 공간 트리로 연다', items == ['메모.txt', '하나.md'], items)
        guard('FR-NAV-02', 'Windows 앱 작업 공간', t_folder)

        def t_encoding():
            v = cur[0].v
            v.open_file(str(docs / '완성형.md'))
            text = v.ev('() => __mdv.preview.article.textContent')
            enc = v.ev('() => __mdv.activeDoc().encoding')
            check('NFR-ENC-01', 'Windows 앱: CP949 문서를 판별해 읽는다', v.h1() == '완성형 문서' and '똠방각하' in text and enc == 'cp949', f'{enc} {text[:30]}')
        guard('NFR-ENC-01', 'Windows 앱 인코딩', t_encoding)

        def t_drop():
            v = cur[0].v
            cdp_drop(v, [docs / '끌어 놓기.md'])
            v.wait('(p) => __mdv.tabs.active()?.path === p', 8000, arg=str(docs / '끌어 놓기.md'))
            check('FR-FILE-01', 'Windows 앱: 끌어다 놓은 파일을 OS 경로로 연다', v.h1() == '끌어 놓은 문서', v.state()['active'])
        guard('FR-FILE-01', 'Windows 앱 끌어다 놓기', t_drop)

        def t_shell_guards():
            v = cur[0].v
            r = v.ev('''async (p) => {
                const code = async (m, a) => { try { await __mdv.bridge.request(m, a); return 'OK'; } catch (e) { return e.code; } };
                return { js: await code('shell.openExternal', { url: 'javascript:alert(1)' }), file: await code('shell.openExternal', { url: 'file:///C:/Windows/notepad.exe' }),
                         reveal: await code('shell.reveal', { path: p }), store: await code('store.save', { name: '../x', data: '' }), unknown: await code('app.nope', {}) };
            }''', str(docs / '없는 폴더' / 'a.md'))
            check('NFR-SEC-03', 'Windows 앱: 외부 주소는 http·https·mailto만, 없는 위치는 탐색기를 열지 않고, 모르는 메서드는 거부',
                  r == {'js': 'EINVAL', 'file': 'EINVAL', 'reveal': 'ENOENT', 'store': 'EINVAL', 'unknown': 'ENOMETHOD'}, r)
            bad = v.ev('''async () => { const r = await fetch('/api/read?path=' + encodeURIComponent('상대.md')); return [r.status, (await r.json()).code]; }''')
            check('NFR-SEC-03', 'Windows 앱: 상대 경로 읽기는 거부한다', bad == [400, 'EINVAL'], bad)
        guard('NFR-SEC-03', 'Windows 앱 OS 연동 거부', t_shell_guards)

        def t_register():
            v = cur[0].v
            v.ev("() => __mdv.cmds.run('app.openWith')")
            v.wait('() => __mdv.info.registered === true', 5000)
            on = reg_exists(regroot, 'Classes\\.md\\OpenWithProgids') and reg_exists(regroot, 'Classes\\Applications\\MDViewer.exe\\shell\\open\\command')
            v.ev("() => __mdv.cmds.run('app.openWith')")
            v.wait('() => __mdv.info.registered === false', 5000)
            off = not reg_exists(regroot, 'Classes\\Applications\\MDViewer.exe')
            check('FR-FILE-01', 'Windows 앱: 설정 메뉴로 탐색기 연결 프로그램 목록에 등록·해제(사용자 단위)', on and off, f'등록 {on}, 해제 {off}')
        guard('FR-FILE-01', 'Windows 앱 연결 프로그램', t_register)

        def t_xss():
            v = cur[0].v
            v.open_file(str(docs / 'xss.md'))
            v.page.wait_for_timeout(800)
            v.wait(DIAGRAMS_DONE, 15000)
            r = v.ev(XSS_REPORT)
            got = {k: r[k] for k in ('xss', 'bad', 'banned', 'leak', 'escaped', 'diagrams')}
            check('NFR-SEC-01', 'Windows 앱: XSS 페이로드 문서에서 실행 0건(Mermaid 포함)',
                  got == {'xss': None, 'bad': 0, 'banned': 0, 'leak': [], 'escaped': 0, 'diagrams': 2} and not v.dialogs, f'{r} {v.dialogs}')
        guard('NFR-SEC-01', 'Windows 앱 XSS', t_xss)

        def t_diagrams():
            v = cur[0].v
            v.open_file(str(docs / 'diagrams.md'))
            v.wait(DIAGRAMS_DONE, 20000)
            r = v.ev(DIAGRAM_REPORT)
            check('FR-REN-07', 'Windows 앱: Mermaid 다이어그램을 그리고 깨진 것은 원문과 오류로, 라벨이 넘치지 않는다',
                  diagrams_ok(r) and not r['over'] and not v.errors, {k: r[k] for k in ('n', 'widths', 'pending', 'errors', 'over')})
            shot(v, '31-desktop-diagrams')
        guard('FR-REN-07', 'Windows 앱 Mermaid', t_diagrams)

        def t_perf():
            v = cur[0].v
            p = str(docs / 'one-mb.md')
            renders = [v.ev('''async (p) => {
                const ex = __mdv.tabs.tabs.find(t => t.path === p);
                if (ex) __mdv.closeTab(ex.id);
                const t0 = performance.now();
                await __mdv.openFile(p);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                return performance.now() - t0;
            }''', p) for _ in range(10)]
            med = statistics.median(renders)
            check('NFR-PERF-02', 'Windows 앱: 1 MB 문서 열기+미리보기 렌더링 1초 이내(10회 중앙값)', med < 1000, f'{med:.0f} ms (min {min(renders):.0f}, max {max(renders):.0f})')
        guard('NFR-PERF-02', 'Windows 앱 1 MB', t_perf)

        def t_theme():
            v = cur[0].v
            v.ev("() => __mdv.cmds.run('view.theme.dark')")
            v.page.wait_for_timeout(200)
            dark = v.ev('() => document.documentElement.dataset.theme')
            v.ev("() => __mdv.cmds.run('view.theme.system')")
            v.page.wait_for_timeout(200)
            check('FR-VIEW-04', 'Windows 앱: 테마를 바꾸면 화면과 제목 표시줄에 알린다(오류 없음)', dark == 'dark' and not v.errors, v.errors)
        guard('FR-VIEW-04', 'Windows 앱 테마', t_theme)

        def t_edit():
            v = cur[0].v
            f = docs / '고칠 앱 문서.md'
            f.write_bytes('# 앱 편집\r\n\r\n본문\r\n'.encode('utf-8'))
            never = write(docs / '읽지 않은 문서.md', '# 그대로\n')
            v.open_file(str(f))
            ed_source(v)
            ed_type(v, '앱에서 고침')
            ed_dirty(v)
            v.key('Control+s')
            ed_dirty(v, False)
            check('FR-EDIT-04', 'Windows 앱: 고쳐 Ctrl+S로 저장하면 원래 형식(CRLF)으로 디스크에 쓴다',
                  f.read_bytes() == '# 앱 편집\r\n\r\n본문\r\n앱에서 고침'.encode('utf-8'), f.read_bytes()[-30:])
            r = v.ev('''async (p) => {
                const w = async (path, q = '', method = 'POST') => {
                    const r = await fetch('/api/write?path=' + encodeURIComponent(path) + q, { method, headers: { 'content-type': 'application/octet-stream' }, body: method === 'POST' ? new Uint8Array([120]) : undefined });
                    return [r.status, (await r.json()).code];
                };
                return { never: await w(p.never), ext: await w(p.ext, '&create=1'), get: await w(p.doc, '', 'GET') };
            }''', {'never': str(never), 'ext': str(docs / 'run.cmd'), 'doc': str(f)})
            check('NFR-SEC-05', 'Windows 앱: 읽어 준 적 없는 파일·문서가 아닌 확장자에는 쓰지 않고, POST만 받는다',
                  r == {'never': [403, 'EACCES'], 'ext': [403, 'EACCES'], 'get': [403, 'EFORBIDDEN']} and never.read_bytes() == '# 그대로\n'.encode('utf-8') and not (docs / 'run.cmd').exists(), r)
            # 고친 채 창을 닫으면 묻는다: 취소하면 창이 남고, 저장하면 저장하고 닫힌다 (FR-EDIT-08).
            ed_type(v, ' 닫기 전')
            ed_dirty(v)
            v.page.wait_for_timeout(300)  # app.setDirty가 호스트에 닿게 한다
            hwnd = app_window(cur[0].proc.pid)
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_CLOSE, 0)
            body = ed_dialog(v, '취소')
            v.page.wait_for_timeout(1500)
            alive = cur[0].proc.poll() is None and v.ev('() => 1') == 1
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_CLOSE, 0)
            # 저장을 누르면 저장하고 곧바로 앱이 끝나므로 누른 뒤 페이지를 기다리지 않는다.
            dlg = v.page.locator('dialog.mdv-dialog[open]')
            dlg.wait_for(timeout=5000)
            try:
                dlg.get_by_role('button', name='저장', exact=True).click(no_wait_after=True)
            except Exception:
                pass
            try:
                code = cur[0].proc.wait(10)
            except subprocess.TimeoutExpired:
                code = None
            check('FR-EDIT-08', 'Windows 앱: 고친 채 창을 닫으면 묻고, 취소하면 창이 남고 저장하면 저장한 뒤 닫힌다',
                  '고칠 앱 문서.md' in body and alive and code == 0 and f.read_bytes().decode('utf-8').endswith('닫기 전'), f'{body} alive={alive} code={code}')
            try:
                cur[0].browser.close()
            except Exception:
                pass
            cur[0] = App(pw, [], profile, regroot)
            cur[0].v.page.wait_for_selector('body[data-restored="1"]', timeout=20000)
        def t_edit_safe():
            try:
                t_edit()
            except Exception:
                # 고친 채 남으면 뒤의 닫기 시험이 확인 대화상자에서 멈추므로 버린다.
                try:
                    cur[0].v.ev('() => { document.querySelector("dialog[open]")?.close(); for (const d of __mdv.docs.all()) __mdv.edit.discard(d.id); }')
                except Exception:
                    pass
                raise
        guard('FR-EDIT-08', 'Windows 앱 편집·저장', t_edit_safe)

        def t_close_restore():
            v = cur[0].v
            v.open_file(first)
            v.ev('() => { __mdv.preview.el.scrollTop = 1500; }')
            v.page.wait_for_timeout(400)
            before = v.state()
            line = next(t['line'] for t in before['tabs'] if t['path'] == first)
            check('NFR-REL-01', 'Windows 앱: 화면 스크립트 오류 없음', not v.errors, v.errors)
            code = cur[0].close()
            saved = json.loads((profile / 'session.json').read_text(encoding='utf-8'))
            check('FR-SESS-01', 'Windows 앱: 창을 닫으면 마지막 상태를 저장하고 끝난다',
                  code == 0 and [t['path'] for t in saved['tabs']] == [t['path'] for t in before['tabs']], f'종료 코드 {code}, 저장 {[(pathlib.Path(t["path"]).name, round(t["line"], 1)) for t in saved["tabs"]]} 활성 {saved.get("activeIndex")}, 닫기 전 {[(pathlib.Path(t["path"]).name, round(t["line"], 1)) for t in before["tabs"]]}')
            cur[0] = App(pw, [], profile, regroot)
            v = cur[0].v
            v.wait('() => window.__mdvReadyAt !== undefined', 10000)  # 첫 탭을 그린 다음 프레임에 적힌다
            dt = v.ev('() => performance.timeOrigin + window.__mdvReadyAt') / 1000 - cur[0].t0
            check('NFR-PERF-01', 'Windows 앱: 다시 실행 → 첫 탭 렌더링 2초 이내(원격 디버깅 켬)', dt <= 2.0,
                  f'{dt * 1000:.0f} ms (처음 실행 {startup.get("first", 0) * 1000:.0f} ms)')
            v.page.wait_for_selector('body[data-restored="1"]', timeout=20000)
            after = v.state()
            got = settled(lambda: v.ev('() => __mdv.tabs.active().line'))
            check('FR-SESS-01', 'Windows 앱: 다시 실행하면 탭·활성 탭·줄을 복원한다',
                  [t['path'] for t in after['tabs']] == [t['path'] for t in before['tabs']] and after['active'] == first and abs(got - line) < 1.0,
                  f'탭 {len(after["tabs"])}개, 줄 {line:.1f}→{got:.1f}')
        guard('FR-SESS-01', 'Windows 앱 세션', t_close_restore)
    finally:
        cur[0].close(5)
        cur[0].kill()
        reg_delete_tree(regroot)
    log = '\n'.join(f.read_text(encoding='utf-8', errors='replace') for f in sorted((profile / 'logs').glob('*.log')))
    check('NFR-REL-03', 'Windows 앱 로그는 UTF-8이고 오류가 없다', '[error]' not in log, log[-400:])


def run_standalone(pw):
    ctx = launch(pw, 'profile-standalone')
    try:
        v = Viewer.open(ctx, VIEWER.as_uri())
        check('NFR-PORT-01', 'file://로 연 viewer.html이 독립 모드로 동작', v.ev('() => __mdv.bridge.mode') == 'standalone')
        v.wait('() => window.__mdvReadyAt !== undefined', 10000)
        ready = v.ev('() => window.__mdvReadyAt')
        check('NFR-PERF-01', '독립 모드 페이지 열기 1초 이내', ready <= 1000, f'{ready:.0f} ms')

        def t_drop_file():
            cdp_drop(v, [SA / 'a.md'])
            v.wait('() => __mdv.tabs.active()?.path.endsWith("/a.md")', 8000)
            v.settle()
            path = v.state()['active']
            notice = v.page.locator('.preview-notice')
            img = v.ev('''() => { const i = __mdv.preview.root.querySelector('img'); return { src: i?.getAttribute('src'), pending: i?.getAttribute('data-mdv-src') }; }''')
            check('FR-FILE-01', '끌어다 놓은 파일이 탭으로 열린다(파일 핸들)', path.startswith('mdv:/f') and v.h1() == '독립 문서' and v.page.title() == 'a.md - MD Viewer', f'{path} {v.page.title()}')
            check('FR-REN-03', '단독 파일은 상대 경로 그림 대신 폴더 열기 안내를 띄운다', notice.is_visible() and not img['src'], f'{notice.inner_text() if notice.is_visible() else "안내 없음"} {img}')
            lat = []
            body = '\n\n![그림](img/dot.png)\n\n[옆 문서](b.md)\n'
            for i in range(10):
                t0 = time.time()
                write(SA / 'a.md', f'# 독립 저장 {i}\n' + body)
                v.wait('(m) => __mdv.preview.article.querySelector("h1")?.textContent === m', 5000, arg=f'독립 저장 {i}')
                lat.append((time.time() - t0) * 1000)
                v.page.wait_for_timeout(200)
            med = statistics.median(lat)
            check('NFR-PERF-04', '독립 모드: 저장부터 화면 반영 1.5초 이내(폴링, 10회 중앙값)', med <= 1500, f'{med:.0f} ms (max {max(lat):.0f})')
            backup = (SA / 'a.md').read_bytes()
            (SA / 'a.md').unlink()
            v.wait('() => __mdv.activeDoc()?.state === "deleted"', 5000)
            (SA / 'a.md').write_bytes(backup)
            v.wait('() => __mdv.activeDoc()?.state === "ok"', 5000)
            check('FR-WATCH-02', '독립 모드: 삭제 표시와 복구', True)
            shot(v, '10-standalone-file')
        guard('FR-FILE-01', '독립 모드 파일 끌어다 놓기', t_drop_file)

        def t_open_folder_fallback():
            # showDirectoryPicker가 없는 브라우저(Firefox·Safari)처럼: 안내의 '폴더 열기' → 폴더 입력 → 그 폴더 기준으로 다시 연다.
            v.ev("() => Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true, writable: true })")
            with v.page.expect_file_chooser(timeout=5000) as fc:
                v.page.locator('.preview-notice button').click()
            fc.value.set_files(str(SA))
            v.wait('() => __mdv.tabs.active()?.path.startsWith("mdv:/u") && __mdv.tabs.active()?.path.endsWith("/a.md")', 8000)
            v.wait('''() => { const i = __mdv.preview.root.querySelector('img'); return i && i.complete && i.naturalWidth === 1; }''', 8000)
            src = v.ev('''() => __mdv.preview.root.querySelector('img').getAttribute('src')''')
            hidden = not v.page.locator('.preview-notice').is_visible()
            check('FR-REN-03', '폴더를 고르면 그 기준으로 옮겨 상대 경로 그림을 보인다(폴더 입력 대체 경로)', src.startswith('blob:') and hidden, src[:30])
            v.ev('''() => __mdv.preview.root.querySelector('a[data-mdv-path$="b.md"]').click()''')
            v.wait('() => __mdv.tabs.active()?.path.endsWith("/b.md")', 5000)
            check('FR-NAV-03', '독립 모드: 같은 폴더의 상대 링크 이동', v.h1() == '옆 문서')
        guard('FR-REN-03', '독립 모드 폴더 기준 다시 열기', t_open_folder_fallback)

        def t_input_fallback():
            v.ev("() => Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true, writable: true })")
            n0 = len(v.state()['tabs'])
            with v.page.expect_file_chooser(timeout=5000) as fc:
                v.key('Control+o')
            fc.value.set_files([str(LOCAL / '고른 파일' / '하나.md'), str(LOCAL / '고른 파일' / '둘.md')])
            v.wait('(n) => __mdv.tabs.tabs.length === n + 2', 5000, arg=n0)
            names = [t['path'].rsplit('/', 1)[1] for t in v.state()['tabs'][-2:]]
            check('FR-FILE-01', 'Ctrl+O(파일 입력 대체 경로)로 여러 파일을 탭으로 연다', sorted(names) == ['둘.md', '하나.md'], names)
        guard('FR-FILE-01', '독립 모드 파일 입력', t_input_fallback)

        def t_synthetic_drop():
            v.ev('''() => {
                const dt = new DataTransfer();
                dt.items.add(new File(['# 합성 문서\\n'], '합성.md', { type: 'text/markdown' }));
                document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
            }''')
            v.wait('() => __mdv.tabs.active()?.path.endsWith("/합성.md")', 5000)
            check('FR-FILE-01', '핸들 없는 파일(합성 drop)도 탭으로 연다', v.h1() == '합성 문서')
        guard('FR-FILE-01', '독립 모드 합성 끌어다 놓기', t_synthetic_drop)

        def t_diagrams():
            # file://에서도 데이터 블록을 풀어 CSP 해시로 실행한다 (FR-REN-07).
            v.ev('''(text) => {
                const dt = new DataTransfer();
                dt.items.add(new File([text], '다이어그램.md', { type: 'text/markdown' }));
                document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
            }''', diagrams_text())
            v.wait('() => __mdv.tabs.active()?.path.endsWith("/다이어그램.md")', 5000)
            v.wait(DIAGRAMS_DONE, 20000)
            r = v.ev(DIAGRAM_REPORT)
            check('FR-REN-07', '독립 모드(file://): Mermaid 번들을 풀어 실행하고 다이어그램을 그린다', diagrams_ok(r) and not r['over'] and not v.errors,
                  {k: r[k] for k in ('n', 'widths', 'pending', 'errors', 'over')})
        guard('FR-REN-07', '독립 모드 Mermaid', t_diagrams)

        def t_edit_standalone():
            # 핸들 없는 문서는 저장 대화상자가 없는 브라우저(Firefox·Safari)처럼 내려받기로 저장한다 (FR-EDIT-05).
            v.ev('''() => {
                const dt = new DataTransfer();
                dt.items.add(new File(['# 내려받을 문서\\n'], '내려받기.md', { type: 'text/markdown' }));
                document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
            }''')
            v.wait('() => __mdv.tabs.active()?.path.endsWith("/내려받기.md")', 5000)
            v.ev("() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true, writable: true })")
            ed_source(v)
            ed_type(v, '고침')
            ed_dirty(v)
            with v.page.expect_download(timeout=8000) as d:
                v.key('Control+s')
            data = pathlib.Path(d.value.path()).read_bytes()
            ed_dirty(v, False)
            check('FR-EDIT-05', '독립 모드: 핸들 없는 문서는 저장 대화상자가 없으면 내려받기로 저장한다',
                  d.value.suggested_filename == '내려받기.md' and data == '# 내려받을 문서\n고침'.encode('utf-8'), f'{d.value.suggested_filename} {data[:40]}')
            v.ev(ED_DISCARD_CLOSE)
            # 파일 핸들 문서: 쓰기 권한을 거절하면 저장하지 않고 알린다(권한 창은 수동 점검). 고친 내용은 남는다.
            cdp_drop(v, [SA / 'b.md'])
            v.wait('() => __mdv.tabs.active()?.path.startsWith("mdv:/f") && __mdv.tabs.active()?.path.endsWith("/b.md")', 8000)
            v.ev('''() => {
                const p = FileSystemHandle.prototype;
                p.queryPermission = async () => 'prompt';
                p.requestPermission = async () => 'denied';
            }''')
            ed_source(v)
            ed_type(v, '권한 없음')
            ed_dirty(v)
            v.key('Control+s')
            v.page.wait_for_timeout(500)
            toasts = v.page.locator('.toast').all_inner_texts()
            check('FR-EDIT-04', '독립 모드: 쓰기 권한이 없으면 파일을 바꾸지 않고 알리며, 고친 내용은 남는다',
                  any('쓰기 권한' in t for t in toasts) and v.ev('() => __mdv.activeDoc().dirty') and (SA / 'b.md').read_bytes() == '# 옆 문서\n'.encode('utf-8'), toasts[-2:])
            v.ev(ED_DISCARD_CLOSE)
        guard('FR-EDIT-05', '독립 모드 편집·저장', t_edit_standalone)

        def t_reload():
            # 핸들이 있는 위치만 세션에 남는다. 다시 열면 권한에 따라 바로 복원되거나 복원 버튼이 뜬다 (SDD 7.4).
            cdp_drop(v, [SA / 'sub' / 'c.md'])  # 파일 핸들 탭 하나를 세션에 남긴다
            v.wait('() => __mdv.tabs.active()?.path.endsWith("/c.md")', 8000)
            v.page.wait_for_timeout(800)
            saved = json.loads(v.ev("() => localStorage.getItem('mdv.session')") or '{}')
            kinds = sorted({re.match(r'mdv:/([a-z])', t['path']).group(1) for t in saved.get('tabs', [])})
            check('FR-SESS-01', '독립 모드 세션에는 다시 열 수 있는 위치(파일·폴더 핸들)만 남는다', kinds and set(kinds) <= {'d', 'f'}, kinds)
            v.page.reload()
            v.page.wait_for_selector('body[data-restored="1"]', timeout=30000)
            tabs = v.state()['tabs']
            button = v.page.locator('#empty-restore').is_visible()
            check('FR-SESS-01', '독립 모드 새로 고침: 탭을 복원하거나 권한 복원 버튼을 띄운다', len(tabs) > 0 or button, f'tabs={len(tabs)} 복원 버튼={button}')
            if button:
                # 복원 버튼을 누르기 전에 다시 새로 고쳐도 지난 탭을 잃지 않는다(권한을 기다리는 탭은 세션에 남는다).
                v.page.wait_for_timeout(800)
                v.page.reload()
                v.page.wait_for_selector('body[data-restored="1"]', timeout=30000)
                again = json.loads(v.ev("() => localStorage.getItem('mdv.session')") or '{}')
                kept = [t['path'] for t in again.get('tabs', [])]
                check('FR-SESS-01', '독립 모드: 복원하기 전에 다시 새로 고쳐도 지난 탭이 세션에 남는다',
                      v.page.locator('#empty-restore').is_visible() and any(p.endswith('/c.md') for p in kept), kept)
        guard('FR-SESS-01', '독립 모드 새로 고침', t_reload)

        check('NFR-REL-01', '독립 모드 화면 스크립트 오류 없음', not v.errors, v.errors[:3])
    finally:
        ctx.close()


# ---------------------------------------------------------------- 진입점

def main():
    global VIEWER
    print('작업 폴더:', WORK, LOCAL, flush=True)
    prepare_launcher_docs()
    prepare_standalone_docs()
    shutil.copy(VIEWER, LOCAL / 'viewer.html')
    VIEWER = LOCAL / 'viewer.html'
    main_launcher = Launcher('home', 17787)
    if ARGS.only == 'desktop':
        try:
            with sync_playwright() as pw:
                guard('FR-FILE-01', 'Windows 앱', lambda: run_desktop(pw))
        finally:
            shutil.rmtree(LOCAL, ignore_errors=True)
        passed = sum(r['ok'] for r in RESULTS)
        print(f'# pass {passed}')
        print(f'# fail {len(RESULTS) - passed}')
        sys.exit(0 if passed == len(RESULTS) else 1)
    try:
        with sync_playwright() as pw:
            ctx = launch(pw, 'profile')
            try:
                guard('NFR-PERF-01', '시작 시간', lambda: run_startup(pw, ctx))  # 무거운 시나리오 전에 잰다
                guard('NFR-PERF-06', '메모리', lambda: run_memory(pw, ctx))
                # 실행기가 뜨지 못하는 등으로 예외가 나도 실패로 기록하고 나머지 시나리오와 결과 기록을 잇는다.
                guard('FR-LAUNCH-01', '실행기 모드', lambda: run_launcher(pw, main_launcher, ctx))
                guard('NFR-SEC-02', '실행기 거부 요청', lambda: run_security(main_launcher))
                guard('FR-SESS-01', '탭 10개 세션 복원', lambda: run_session10(pw, ctx))
                guard('FR-LAUNCH-03', '유휴 종료', lambda: run_idle(pw, ctx))
            finally:
                ctx.close()
            guard('NFR-PORT-01', '독립 모드', lambda: run_standalone(pw))
            guard('FR-FILE-01', 'Windows 앱', lambda: run_desktop(pw))
        log = main_launcher.logs()
        check('NFR-REL-03', '실행기 로그는 UTF-8이고 예상치 못한 오류가 없다', '[error]' not in log and '실행기 시작' in log, log[-400:])
    finally:
        for L in LAUNCHERS:
            try:
                L.stop()
            except Exception:
                pass
        shutil.rmtree(LOCAL, ignore_errors=True)
    passed = sum(r['ok'] for r in RESULTS)
    print(f'# pass {passed}')
    print(f'# fail {len(RESULTS) - passed}')
    (OUT / 'e2e-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2), encoding='utf-8')
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == '__main__':
    main()
