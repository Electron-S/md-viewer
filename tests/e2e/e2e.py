# MD Viewer E2E 테스트 (SDD 9.3). Windows Python + Playwright로 실제 mdview.exe를 조종한다.
#   python e2e.py <mdview.exe 경로> <결과 폴더>
# CP949 문제를 피하려고 모든 파일은 encoding='utf-8'로 읽고 쓰며, 출력도 UTF-8로 고정한다.
import base64
import ctypes
import faulthandler
import ctypes.wintypes as wt
import json
import os
import pathlib
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import traceback

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
faulthandler.dump_traceback_later(1200, exit=True)  # 어디서 멈췄는지 남기고 끝낸다
EXE = sys.argv[1]
OUT = pathlib.Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
PORT = 9333
WORK = pathlib.Path(tempfile.mkdtemp(prefix='mdv-e2e-'))
DOCS = WORK / '문서 모음'
PROFILE = WORK / 'profile'
RESULTS = []
PNG_1PX = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')

user32 = ctypes.windll.user32
SPAWNED = []


def kill_spawned():
    for p in SPAWNED:
        if p.poll() is None:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)


# ---------------------------------------------------------------- 문서 준비

def write(path: pathlib.Path, text: str, encoding='utf-8'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode(encoding))
    return path


def prepare():
    readme = write(DOCS / 'README.md', '\n'.join([
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
        '[다른 문서의 둘째 절](other.md#둘째-절) · [외부](https://example.com) · [메모](notes.txt)',
        '',
        '![로컬 그림](img/dot.png) ![원격](https://example.com/remote.png)',
        '',
        '각주도 있습니다[^1].',
        '',
        '[^1]: 각주 내용',
        '',
        *[f'## 긴 절 {i}\n\n' + '본문 문장입니다. ' * 40 + '\n' for i in range(1, 15)],
    ]))
    (DOCS / 'img').mkdir(exist_ok=True)
    (DOCS / 'img' / 'dot.png').write_bytes(PNG_1PX)
    write(DOCS / 'other.md', '# 다른 문서\n\n' + ('채우기 문단입니다.\n\n' * 60) + '## 둘째 절\n\n여기로 와야 합니다.\n\n' + ('끝 문단.\n\n' * 40))
    write(DOCS / 'notes.txt', '일반 텍스트 메모\n두 번째 줄\n')
    write(DOCS / 'cp949.md', '# 한글 문서\n\n완성형 인코딩으로 저장한 문서입니다.\n', encoding='cp949')
    write(DOCS / 'xss.md', '\n\n'.join([
        '# XSS',
        '<script>window.__xss = 1; alert(1)</script>',
        '<img src=x onerror="window.__xss = 2; alert(2)">',
        '[클릭](javascript:window.__xss=3)',
        '<a href="javascript:window.__xss=4">a</a>',
        '<svg onload="window.__xss=5"><circle r=1></circle></svg>',
        '<iframe src="https://example.com"></iframe>',
        '<div style="position:fixed;inset:0;background:red">덮기</div>',
        '<details open ontoggle="window.__xss=6">x</details>',
        '<math><mtext><table><mglyph><style><img src=x onerror="window.__xss=7">',
    ]))
    (DOCS / 'binary.md').write_bytes(b'PK\x03\x04\x00\x00\x10binary')
    big = '\n'.join(f'## 큰 절 {i}\n\n' + '큰 파일 본문 줄입니다 lorem ipsum. ' * 20 for i in range(7000))
    write(DOCS / 'big.md', big)  # 약 6 MB: 미리보기 자동 렌더링 생략 대상
    one_mb = []
    i = 0
    while sum(len(s) for s in one_mb) < 1_000_000:
        one_mb.append(f'## 절 {i}\n\n본문 문단 **강조** 와 `코드` 와 [링크](other.md) 사과 문장입니다. ' * 3 + '\n\n- 항목 하나\n- 항목 둘\n\n')
        i += 1
    write(DOCS / 'one-mb.md', ''.join(one_mb))
    ten = ('## 열 메가 절\n\n' + '열 메가 본문 줄입니다. ' * 30 + '\n\n') * 1
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
    return readme


# ---------------------------------------------------------------- 앱 조종

def hwnd_of(pid):
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


def window_title(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def window_rect(hwnd):
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def app_env(debug=True, profile=None):
    env = dict(os.environ, MDVIEW_PROFILE_DIR=str(profile or PROFILE))
    if debug:
        env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = f'--remote-debugging-port={PORT}'
    else:
        env.pop('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', None)
    return env


class App:
    def __init__(self, pw, args, profile=None):
        self.proc = subprocess.Popen([EXE, *map(str, args)], env=app_env(profile=profile))
        SPAWNED.append(self.proc)
        self.browser = None
        for _ in range(150):
            try:
                self.browser = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
                break
            except Exception:
                time.sleep(0.1)
        if not self.browser:
            raise RuntimeError('CDP 연결 실패')
        # sync API는 time.sleep 동안 이벤트를 처리하지 않으므로 Playwright 대기로 이벤트를 돌린다.
        self.page = None
        deadline = time.time() + 20
        while time.time() < deadline and not self.page:
            pages = [pg for c in self.browser.contexts for pg in c.pages]
            hit = [pg for pg in pages if 'app.mdview' in pg.url]
            if hit:
                self.page = hit[0]
            elif pages:
                pages[0].wait_for_timeout(100)
            elif self.browser.contexts:
                try:
                    self.browser.contexts[0].wait_for_event('page', timeout=500)
                except Exception:
                    pass
            else:
                time.sleep(0.1)
        if not self.page:
            raise RuntimeError('앱 페이지를 찾지 못함')
        self.dialogs = []
        self.errors = []
        self.page.on('dialog', lambda d: (self.dialogs.append(d.message), d.dismiss()))
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.wait_for_selector('body[data-ready="1"]', timeout=20000)

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
        time.sleep(0.15)

    def wait(self, js, timeout=5000, arg=None):
        self.page.wait_for_function(js, arg=arg, timeout=timeout)

    def open(self, path, **opts):
        self.ev('async ([p, o]) => { await __mdv.openFile(p, o); }', [str(path), opts])
        self.settle()

    def settle(self):
        self.ev('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        time.sleep(0.05)

    def status(self):
        return self.page.locator('#statusbar').inner_text().replace('\n', ' | ')

    def close(self, timeout=6):
        try:
            self.ev('() => window.close()')
        except Exception:
            pass
        try:
            self.proc.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return False

    def kill(self):
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(self.proc.pid)], capture_output=True)
        self.proc.wait(timeout=10)


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


# ---------------------------------------------------------------- 결과 기록

def check(rid, name, cond, detail=''):
    RESULTS.append({'id': rid, 'name': name, 'ok': bool(cond), 'detail': str(detail)})
    print(('ok    ' if cond else 'FAIL  ') + f'{rid} {name}' + (f' — {detail}' if detail else ''), flush=True)


def guard(rid, name, fn):
    try:
        fn()
    except Exception as e:
        check(rid, name, False, f'예외: {e}\n{traceback.format_exc(limit=3)}')


def shot(app, name):
    app.page.screenshot(path=str(OUT / f'{name}.png'))


# ---------------------------------------------------------------- 시나리오

def run(pw, readme):
    app = App(pw, [readme])
    a = app

    def t_open():
        st = a.state()
        check('FR-FILE-01', '명령줄 인자로 연 파일이 탭으로 열린다', len(st['tabs']) == 1 and st['active'].endswith('README.md'), st)
        check('FR-REN-01', '미리보기 렌더링', a.ev("() => __mdv.preview.article.querySelector('h1')?.textContent") == '사용 설명서')
        check('NFR-USE-02', '창 제목·UI 한국어', a.page.title() == 'README.md - MD Viewer', a.page.title())
        shot(a, '01-preview')
    guard('FR-FILE-01', '파일 열기', t_open)

    def t_render():
        r = a.ev('''() => {
            const root = __mdv.preview.root;
            const img = root.querySelector('img[alt="로컬 그림"]');
            const remote = root.querySelector('img[alt="원격"]');
            return {
                table: !!root.querySelector('table th'),
                task: root.querySelectorAll('input[type=checkbox][disabled]').length,
                hl: !!root.querySelector('pre code .hljs-keyword'),
                fn: !!root.querySelector('.footnote-ref'),
                imgSrc: img?.getAttribute('src'), imgW: img?.naturalWidth, imgDone: img?.complete,
                remote: remote?.getAttribute('src'),
                ext: root.querySelector('a[data-mdv-ext]')?.getAttribute('data-mdv-ext'),
                local: root.querySelector('a[data-mdv-path]')?.getAttribute('data-mdv-path'),
            };
        }''')
        check('FR-REN-01', 'GFM 표·작업 목록', r['table'] and r['task'] == 2, r)
        check('FR-REN-02', '코드 강조', r['hl'])
        check('FR-REN-05', '각주', r['fn'])
        a.wait('''() => { const i = __mdv.preview.root.querySelector('img[alt="로컬 그림"]'); return i && i.complete && i.naturalWidth > 0; }''', 5000)
        w = a.ev('''() => __mdv.preview.root.querySelector('img[alt="로컬 그림"]').naturalWidth''')
        check('FR-REN-03', '상대 경로 이미지가 file.mdview로 로드된다', w == 1 and r['imgSrc'].startswith('https://file.mdview/'), r['imgSrc'])
        check('FR-NAV-03', '링크 분류(외부·로컬)', r['ext'] == 'https://example.com' and r['local'].endswith('other.md'), r)
    guard('FR-REN', '렌더링', t_render)

    def t_toc():
        items = a.page.locator('.toc-item')
        n = items.count()
        heads = a.ev('() => __mdv.preview.root.querySelectorAll("h1,h2,h3,h4,h5,h6").length')
        items.nth(8).click()
        time.sleep(0.3)
        line = a.ev('() => __mdv.tabs.active().line')
        target = a.ev('() => __mdv.headings[8].line')
        cur = a.page.locator('.toc-item.current').inner_text()
        check('FR-NAV-01', '목차 생성·클릭 이동·현재 제목 강조', n == heads and abs(line - target) < 1.5 and cur == a.ev('() => __mdv.headings[8].text'),
              f'items={n} heads={heads} line={line} target={target} current={cur}')
        a.ev('() => { __mdv.preview.el.scrollTop = 0; }')
        time.sleep(0.2)
    guard('FR-NAV-01', '목차', t_toc)

    def t_link():
        a.page.evaluate('''() => __mdv.preview.root.querySelector('a[data-mdv-path$="other.md"]').click()''')
        a.wait('() => __mdv.tabs.active()?.path.endsWith("other.md")')
        time.sleep(0.4)
        st = a.state()
        top = a.ev('() => __mdv.preview.topLine()')
        target = a.ev('() => __mdv.headings.find(h => h.id === "둘째-절").line')
        check('FR-NAV-03', '로컬 .md 링크는 새 탭으로, #조각으로 이동', len(st['tabs']) == 2 and abs(top - target) < 2, f'top={top} target={target}')
        a.open(DOCS / 'README.md')
        check('FR-FILE-03', '이미 열린 파일은 새 탭을 만들지 않는다', len(a.state()['tabs']) == 2)
    guard('FR-NAV-03', '링크 이동', t_link)

    def t_modes():
        a.page.locator('.preview-scroll').click()
        a.key('Control+2')
        src_visible = a.page.locator('.pane.source').is_visible() and not a.page.locator('.pane.preview').is_visible()
        gutters = a.page.locator('.cm-lineNumbers .cm-gutterElement').count()
        check('FR-VIEW-02', '원문 보기: 줄 번호와 Markdown 강조', src_visible and gutters > 5 and a.page.locator('.cm-content [class*="ͼ"]').count() > 0, f'gutters={gutters}')
        ro = a.ev('() => __mdv.source.view.state.readOnly')
        check('ARCH-02', '원문 보기는 편집기 컴포넌트의 읽기 전용 모드', ro is True)
        a.key('Control+3')
        both = a.page.locator('.pane.source').is_visible() and a.page.locator('.pane.preview').is_visible()
        check('FR-VIEW-01', '미리보기·원문·분할 전환', both and a.state()['mode'] == 'split')
        a.ev('() => { __mdv.preview.el.scrollTop = __mdv.preview.el.scrollHeight * 0.5; }')
        time.sleep(0.5)
        p_line = a.ev('() => __mdv.preview.topLine()')
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
        a.ev('() => { __mdv.preview.el.scrollTop = 0; }')
        a.key('Control+f')
        bar = a.page.locator('.findbar')
        a.page.locator('.findbar input').fill('사과')
        time.sleep(0.4)
        count = a.page.locator('.find-count').inner_text()
        marks = a.ev('() => __mdv.preview.root.querySelectorAll("mark.mdv-hit").length')
        a.key('F3')
        cur = a.page.locator('.find-count').inner_text()
        check('FR-FIND-01', '찾기·다음·일치 개수', bar.is_visible() and count == '3개' and cur == '1/3' and marks == 3, f'{count} {cur} marks={marks}')
        a.page.locator('.find-toggle[data-opt="regex"]').click()
        a.page.locator('.findbar input').fill('긴 절 1[0-3]')
        time.sleep(0.4)
        rcount = a.page.locator('.find-count').inner_text()
        a.page.locator('.find-toggle[data-opt="regex"]').click()
        a.page.locator('.find-toggle[data-opt="wholeWord"]').click()
        a.page.locator('.findbar input').fill('문장')
        time.sleep(0.4)
        wcount = a.page.locator('.find-count').inner_text()
        a.page.locator('.find-toggle[data-opt="wholeWord"]').click()
        check('FR-FIND-02', '정규식·단어 단위 옵션', rcount == '4개' and wcount == '결과 없음', f'regex={rcount} word={wcount}')
        a.key('Control+2')
        a.key('Control+f')
        a.page.locator('.findbar input').fill('def')
        time.sleep(0.4)
        scount = a.page.locator('.find-count').inner_text()
        hl = a.page.locator('.cm-searchMatch').count()
        check('FR-FIND-03', '원문 보기에서도 찾고 강조', scount == '1개' and hl >= 1, f'{scount} hl={hl}')
        a.page.locator('.findbar input').press('Escape')
        time.sleep(0.2)
        a.key('Control+1')
        check('FR-FIND-01', 'Esc로 닫으면 강조 해제', not bar.is_visible() and a.ev('() => __mdv.preview.root.querySelectorAll("mark").length') == 0)
    guard('FR-FIND', '찾기', t_find)

    def t_zoom_theme():
        a.key('Control+=')
        a.key('Control+=')
        z = a.page.locator('[data-field="zoom"]').inner_text()
        a.key('Control+0')
        z0 = a.page.locator('[data-field="zoom"]').inner_text()
        check('FR-VIEW-03', '확대·원래대로', z == '120%' and z0 == '100%', f'{z} → {z0}')
        a.ev("() => __mdv.cmds.run('view.theme.dark')")
        time.sleep(0.2)
        dark = a.ev('() => document.documentElement.dataset.theme')
        shot(a, '03-dark')
        a.ev("() => __mdv.cmds.run('view.theme.light')")
        check('FR-VIEW-04', '다크·라이트 테마', dark == 'dark' and a.ev('() => document.documentElement.dataset.theme') == 'light')
    guard('FR-VIEW-03', '확대·테마', t_zoom_theme)

    def t_encoding():
        a.open(DOCS / 'cp949.md')
        enc = a.page.locator('[data-field="encoding"]').inner_text()
        h1 = a.ev("() => __mdv.preview.article.querySelector('h1')?.textContent")
        check('NFR-ENC-01', 'CP949 자동 판별', enc == 'CP949' and h1 == '한글 문서', f'{enc} {h1}')
        a.ev("() => __mdv.cmds.run('encoding.reopen.utf-8')")
        a.wait("() => __mdv.activeDoc().encoding === 'utf-8'")
        time.sleep(0.3)
        warn = a.page.locator('[data-field="warning"]').count()
        check('FR-INFO-02', '인코딩을 골라 다시 읽기, 깨진 바이트 경고', warn == 1, a.status())
        a.ev("() => __mdv.cmds.run('encoding.reopen.cp949')")
        a.wait("() => document.querySelector('[data-field=encoding]')?.textContent === 'CP949'")
        st = a.status()
        check('FR-INFO-01', '상태 표시줄: 인코딩·줄 끝·줄·단어·글자·크기', all(s in st for s in ['CP949', 'LF', '줄', '단어', '자', ' B']), st)
    guard('NFR-ENC', '인코딩', t_encoding)

    def t_text_binary_large():
        a.open(DOCS / 'notes.txt')
        check('FR-FILE-08', '.txt는 원문 보기로 열린다', a.state()['mode'] == 'source')
        a.open(DOCS / 'binary.md')
        msg = a.ev("() => __mdv.preview.article.textContent")
        check('NFR-REL-01', '바이너리 파일은 내용 대신 안내', '바이너리' in msg, msg[:60])
        t0 = time.time()
        a.open(DOCS / 'big.md')
        dt = time.time() - t0
        msg = a.ev("() => __mdv.preview.article.textContent")
        check('NFR-PERF-03', '5 MB 넘는 파일은 원문 보기로 열고 미리보기는 수동', a.state()['mode'] == 'source' and dt < 2.0, f'{dt:.2f}s')
        a.key('Control+1')
        msg = a.ev("() => __mdv.preview.article.textContent")
        check('NFR-PERF-03', '큰 파일 미리보기 안내와 버튼', '미리보기 그리기' in msg, msg[:80])
    guard('NFR-PERF-03', '텍스트·바이너리·큰 파일', t_text_binary_large)

    def t_xss():
        a.open(DOCS / 'xss.md')
        time.sleep(0.8)
        r = a.ev('''() => {
            const root = __mdv.preview.article;
            const bad = [...root.querySelectorAll('*')].filter(el => [...el.attributes].some(at => /^on/i.test(at.name) || at.name === 'style' || /^\\s*javascript:/i.test(at.value)));
            return { xss: window.__xss ?? null, bad: bad.length, iframe: root.querySelectorAll('iframe,script,style').length };
        }''')
        check('NFR-SEC-01', 'XSS 페이로드 문서에서 실행 0건', r['xss'] is None and r['bad'] == 0 and r['iframe'] == 0 and not a.dialogs, f'{r} dialogs={a.dialogs}')
    guard('NFR-SEC-01', 'XSS', t_xss)

    def t_remote_images():
        a.open(DOCS / 'README.md')
        a.ev("() => __mdv.cmds.run('view.remoteImages')")
        time.sleep(0.3)
        blocked = a.ev('''() => __mdv.preview.root.querySelector('img[alt="원격"]').getAttribute('data-mdv-blocked')''')
        a.ev("() => __mdv.cmds.run('view.remoteImages')")
        time.sleep(0.3)
        src = a.ev('''() => __mdv.preview.root.querySelector('img[alt="원격"]').getAttribute('src')''')
        check('NFR-SEC-03', '원격 이미지 차단 설정', blocked == 'https://example.com/remote.png' and src == 'https://example.com/remote.png', f'{blocked} / {src}')
    guard('NFR-SEC-03', '원격 이미지', t_remote_images)

    def t_watch():
        a.open(DOCS / 'other.md')
        a.ev('() => { __mdv.preview.el.scrollTop = 600; }')
        time.sleep(0.4)
        line_before = a.ev('() => __mdv.tabs.active().line')
        path = DOCS / 'other.md'
        text = path.read_text(encoding='utf-8').replace('# 다른 문서', '# 다른 문서 (수정됨)')
        t0 = time.time()
        path.write_text(text, encoding='utf-8')
        a.wait("() => __mdv.preview.article.querySelector('h1')?.textContent === '다른 문서 (수정됨)'", 3000)
        dt = time.time() - t0
        time.sleep(0.3)
        line_after = a.ev('() => __mdv.tabs.active().line')
        check('FR-WATCH-01', '외부 변경 자동 반영, 스크롤 줄 유지', abs(line_after - line_before) < 1.5, f'line {line_before:.1f}→{line_after:.1f}')
        check('NFR-PERF-04', '저장부터 화면 반영 0.5초 이내', dt < 0.5, f'{dt * 1000:.0f} ms')
        backup = path.read_bytes()
        path.unlink()
        a.wait('() => __mdv.activeDoc()?.state === "deleted"', 3000)
        tab_deleted = a.page.locator('.tab.active.deleted').count() == 1
        kept = a.ev("() => __mdv.preview.article.querySelector('h1')?.textContent")
        check('FR-WATCH-02', '삭제되면 탭에 표시하고 내용 유지', tab_deleted and kept == '다른 문서 (수정됨)', kept)
        path.write_bytes(backup)
        a.wait('() => __mdv.activeDoc()?.state === "ok"', 3000)
        check('FR-WATCH-02', '다시 생기면 복구', True)
        a.key('F5')
        check('FR-WATCH-03', 'F5 새로 고침', a.ev('() => __mdv.activeDoc().version') >= 3)
    guard('FR-WATCH', '파일 감시', t_watch)

    def t_watch_100():
        # SRS 8장 인수 기준: 외부 편집기로 같은 파일을 100회 저장 → 매번 반영, 스크롤 유지 (FR-WATCH-01).
        # 홀수 회는 제자리 저장(메모장·Notepad++ 방식), 짝수 회는 임시 파일에 쓴 뒤 교체(vim 등 원자적 저장 방식).
        path = DOCS / 'other.md'
        tmp = DOCS / 'other.md.tmp~'
        a.open(path)
        a.ev('() => { __mdv.preview.el.scrollTop = 600; }')
        time.sleep(0.4)
        line0 = a.ev('() => __mdv.tabs.active().line')
        body = path.read_text(encoding='utf-8').split('\n', 1)[1]
        lat, drift, not_ok, reflected = [], 0.0, 0, 0
        for i in range(1, 101):
            marker = f'저장 {i:03d}'
            t0 = time.time()
            if i % 2:
                write(path, f'# {marker}\n' + body)
            else:
                write(tmp, f'# {marker}\n' + body)
                os.replace(tmp, path)
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
              f'{reflected}/100 반영, 지연 중앙값 {med:.0f} ms, 최대 {max(lat or [0]):.0f} ms (제자리 저장 50·교체 저장 50)')
        check('FR-WATCH-01', '100회 저장 동안 스크롤 줄 유지, 삭제 표시 없음', drift < 1.5 and not_ok == 0,
              f'줄 {line0:.1f}, 최대 차이 {drift:.2f}, 삭제 표시 {not_ok}회')
        check('NFR-PERF-04', '저장부터 화면 반영 0.5초 이내(100회 중앙값)', med < 500, f'{med:.0f} ms')

        # 이름 변경은 원래 경로의 삭제로 다룬다 (FR-WATCH-02, SDD 6.3)
        renamed = DOCS / 'other 이름 변경.md'
        os.rename(path, renamed)
        try:
            a.wait('() => __mdv.activeDoc()?.state === "deleted"', 3000)
            tab_deleted = a.page.locator('.tab.active.deleted').count() == 1
            kept = a.ev("() => __mdv.preview.article.querySelector('h1')?.textContent")
            check('FR-WATCH-02', '이름이 바뀌면 탭에 삭제 표시하고 내용 유지', tab_deleted and kept == '저장 100', kept)
        finally:
            os.rename(renamed, path)
        a.wait('() => __mdv.activeDoc()?.state === "ok"', 3000)
        h1 = a.ev("() => __mdv.preview.article.querySelector('h1')?.textContent")
        check('FR-WATCH-02', '원래 이름으로 돌아오면 복구', a.page.locator('.tab.active.deleted').count() == 0 and h1 == '저장 100', h1)
    guard('FR-WATCH-01', '파일 감시 100회 저장·이름 변경', t_watch_100)

    def t_tabs():
        n0 = len(a.state()['tabs'])
        a.key('Control+w')
        n1 = len(a.state()['tabs'])
        a.key('Control+Shift+T')
        time.sleep(0.4)
        st = a.state()
        check('FR-FILE-05', 'Ctrl+W 닫기, Ctrl+Shift+T 다시 열기', n1 == n0 - 1 and len(st['tabs']) == n0 and st['active'].endswith('other.md'), f'{n0}→{n1}→{len(st["tabs"])}')
        before = a.state()['active']
        a.key('Control+Tab')
        after = a.state()['active']
        a.key('Control+Shift+Tab')
        check('FR-FILE-05', 'Ctrl+Tab 다음 탭', before != after and a.state()['active'] == before, f'{before} → {after}')
        a.ev('() => __mdv.tabs.move(__mdv.tabs.activeId, 0)')
        check('FR-FILE-05', '탭 순서 이동', a.state()['tabs'][0]['path'] == before)
    guard('FR-FILE-05', '탭', t_tabs)

    def t_menu_shortcuts():
        a.key('Alt+f')
        opened = a.page.locator('.menu-dropdown').is_visible()
        labels = a.page.locator('.menu-dropdown .menu-label').all_inner_texts()
        a.key('Escape')
        closed = a.page.locator('.menu-dropdown').count() == 0
        check('NFR-USE-01', '메뉴: Alt+F 열기·Esc 닫기', opened and closed and '열기…' in labels and '인쇄…' in labels, labels[:6])
        a.key('F1')
        dlg = a.page.locator('dialog[open]')
        rows = a.page.locator('.shortcut-table tr').count()
        a.key('Escape')
        check('NFR-USE-01', 'F1 단축키 목록', rows >= 15 and a.page.locator('dialog[open]').count() == 0, f'rows={rows}')
        keys = a.ev('() => __mdv.cmds.all().flatMap(c => c.keys ?? [])')
        need = ['Ctrl+O', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+Tab', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Alt+Z', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0', 'Ctrl+B', 'Ctrl+F', 'F3', 'Shift+F3', 'F5', 'Ctrl+P']
        missing = [k for k in need if k not in keys]
        check('NFR-USE-01', 'SRS 4.2 v1.0 단축키 등록', not missing, missing)
        vis = a.ev('() => !document.getElementById("side").hidden')
        a.key('Control+b')
        hid = a.ev('() => document.getElementById("side").hidden')
        a.key('Control+b')
        check('FR-NAV-01', 'Ctrl+B 사이드 패널', vis and hid)
    guard('NFR-USE-01', '메뉴·단축키', t_menu_shortcuts)

    def t_single_instance_workspace():
        ws = DOCS / '작업 공간'
        t0 = time.time()
        p2 = subprocess.run([EXE, str(ws), str(DOCS / 'many' / '탭00.md')], env=app_env(debug=False), timeout=20)
        dt = time.time() - t0
        a.wait('() => __mdv.tabs.active()?.path.endsWith("탭00.md")', 5000)
        check('FR-FILE-04', '두 번째 실행은 기존 창의 새 탭으로', p2.returncode == 0 and dt < 5, f'exit={p2.returncode} {dt:.1f}s')
        a.wait('() => document.querySelectorAll(".ws-item").length >= 3', 5000)
        items = a.page.locator('.ws-item').all_inner_texts()
        check('FR-NAV-02', '작업 공간 트리: 폴더 먼저, 문서만', items[:3] == ['▸ 하위', '설명.txt', '첫 문서.md'] and not any('node_modules' in i or 'image.png' in i for i in items), items)
        a.page.locator('.ws-item', has_text='하위').click()
        a.wait('() => [...document.querySelectorAll(".ws-item")].some(e => e.textContent.includes("깊은 문서.md"))', 5000)
        a.page.locator('.ws-item', has_text='깊은 문서.md').click()
        a.wait('() => __mdv.tabs.active()?.path.endsWith("깊은 문서.md")', 5000)
        active_item = a.page.locator('.ws-item.active').inner_text()
        check('FR-NAV-02', '트리에서 파일 열기·현재 문서 강조', active_item == '깊은 문서.md', active_item)
        shot(a, '04-workspace')
    guard('FR-FILE-04', '단일 인스턴스·작업 공간', t_single_instance_workspace)

    def t_perf_in_app():
        renders = []
        for _ in range(10):
            r = a.ev('''async (p) => {
                const ex = __mdv.tabs.tabs.find(t => t.path.toLowerCase() === p.toLowerCase());
                if (ex) __mdv.closeTab(ex.id);
                const t0 = performance.now();
                await __mdv.openFile(p);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                return performance.now() - t0;
            }''', str(DOCS / 'one-mb.md'))
            renders.append(r)
        med = statistics.median(renders)
        check('NFR-PERF-02', '1 MB 문서 열기+미리보기 렌더링 1초 이내(10회 중앙값)', med < 1000, f'{med:.0f} ms (min {min(renders):.0f}, max {max(renders):.0f})')
        finds = []
        for _ in range(10):
            finds.append(a.ev('''() => {
                const t0 = performance.now();
                __mdv.preview.find({ text: '사과', caseSensitive: false, wholeWord: false, regex: false });
                const dt = performance.now() - t0;
                __mdv.preview.clearFind();
                return dt;
            }'''))
        fmed = statistics.median(finds)
        check('NFR-PERF-05', '1 MB 문서 찾기 강조 0.3초 이내(10회 중앙값)', fmed < 300, f'{fmed:.0f} ms')
        tens = []
        for _ in range(3):
            tens.append(a.ev('''async (p) => {
                const ex = __mdv.tabs.tabs.find(t => t.path.toLowerCase() === p.toLowerCase());
                if (ex) __mdv.closeTab(ex.id);
                const t0 = performance.now();
                await __mdv.openFile(p);
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                return performance.now() - t0;
            }''', str(DOCS / 'ten-mb.md')))
        check('NFR-PERF-03', '10 MB 파일 원문 표시 2초 이내', statistics.median(tens) < 2000 and a.state()['mode'] == 'source', f'{statistics.median(tens):.0f} ms')
    guard('NFR-PERF', '앱 안 성능', t_perf_in_app)

    def t_stale_reopen():
        # 마지막 탭을 닫고 파일이 바뀐 뒤 다시 열면 새 내용이 보여야 한다 (리뷰 #4)
        p = write(DOCS / 'stale.md', '# 예전 내용\n')
        a.open(p)
        a.ev('() => { for (const t of [...__mdv.tabs.tabs]) __mdv.closeTab(t.id); }')
        a.settle()
        p.write_text('# 새 내용\n', encoding='utf-8')
        a.key('Control+Shift+T')
        a.wait('() => __mdv.tabs.active()?.path.endsWith("stale.md")')
        a.settle()
        h1 = a.ev("() => __mdv.preview.article.querySelector('h1')?.textContent")
        check('FR-FILE-05', '모든 탭을 닫고 파일이 바뀐 뒤 다시 열면 새 내용', h1 == '새 내용', h1)
    guard('FR-FILE-05', '닫은 탭 다시 열기', t_stale_reopen)

    # 세션 저장을 위해 상태를 만든 뒤 정상 종료한다.
    a.open(DOCS / 'README.md')
    a.key('Control+3')
    a.ev('() => { __mdv.preview.el.scrollTop = 900; }')
    time.sleep(0.6)
    hwnd = hwnd_of(a.proc.pid)
    user32.ShowWindow(hwnd, 9)
    user32.MoveWindow(hwnd, 120, 90, 1100, 760, True)
    time.sleep(0.3)
    before = a.state()
    rect_before = window_rect(hwnd)
    errors = list(a.errors)
    closed = a.close()
    check('FR-SESS-01', '창 닫기 → 세션 저장 후 1초 안에 종료', closed)
    check('NFR-REL-01', '실행 중 화면 스크립트 오류 없음', not errors, errors[:3])
    return before, rect_before


def run_restore(pw, before, rect_before):
    a = App(pw, [])
    a.page.wait_for_selector('body[data-restored="1"]', timeout=20000)
    after = a.state()
    same_tabs = [t['path'].lower() for t in after['tabs']] == [t['path'].lower() for t in before['tabs']]
    act = after['active'] == before['active'] and after['mode'] == 'split'
    line_b = next(t['line'] for t in before['tabs'] if t['path'] == before['active'])
    line_a = a.ev('() => __mdv.tabs.active().line')
    check('FR-SESS-01', '다시 실행하면 탭·활성 탭·보기 모드·줄 복원', same_tabs and act and abs(line_a - line_b) < 2, f'tabs={len(after["tabs"])} active={act} line {line_b:.1f}→{line_a:.1f}')
    rect_after = window_rect(hwnd_of(a.proc.pid))
    check('FR-SESS-02', '창 위치·크기 기억', rect_after == rect_before, f'{rect_before} → {rect_after}')
    recent = a.ev('() => __mdv.session.recentFiles.length')
    check('FR-FILE-06', '최근 파일 기억', recent >= 10, recent)
    # 강제 종료에도 마지막 상태가 남는가 (NFR-REL-02)
    a.open(DOCS / 'notes.txt')
    time.sleep(1.0)
    a.kill()
    a2 = App(pw, [])
    a2.page.wait_for_selector('body[data-restored="1"]', timeout=20000)
    st = a2.state()
    check('NFR-REL-02', '강제 종료 뒤에도 마지막 세션 복원', st['active'] and st['active'].endswith('notes.txt'), st['active'])
    a2.close()


MODE_CMD = {'preview': 'view.preview', 'source': 'view.source', 'split': 'view.split'}


def set_tab(a, i, mode, px):
    """i번째 탭을 열어 보기 모드를 바꾸고, 사용자가 스크롤한 것처럼 px만큼 내린다. 기록된 줄을 돌려준다."""
    a.ev('(i) => __mdv.tabs.activate(__mdv.tabs.tabs[i].id)', i)
    a.settle()
    a.ev('(c) => __mdv.cmds.run(c)', MODE_CMD[mode])
    if mode != 'preview':
        a.wait('() => !!__mdv.source && !!document.querySelector(".pane.source .cm-content")', 5000)
    a.settle()
    time.sleep(0.3)
    if mode == 'source':
        a.ev('(px) => { __mdv.source.view.scrollDOM.scrollTop = px; }', px)
    else:
        a.ev('(px) => { __mdv.preview.el.scrollTop = px; }', px)
    time.sleep(0.4)
    return a.ev('() => __mdv.tabs.active().line')


def view_line(a, mode):
    """보이는 화면 맨 위의 원문 줄. 분할 보기는 미리보기 쪽으로 잰다."""
    return a.ev('() => __mdv.source?.topLine() ?? null' if mode == 'source' else '() => __mdv.preview.topLine()')


def compare_session(a, before, rid, how):
    """재실행한 앱의 탭·모드·줄·활성 탭을 종료 전 상태와 맞춰 보고, 탭마다 실제 화면 위치도 잰다."""
    a.page.wait_for_selector('body[data-restored="1"]', timeout=20000)
    after = a.state()
    paths_ok = [t['path'].lower() for t in after['tabs']] == [t['path'].lower() for t in before['tabs']]
    modes_ok = [t['mode'] for t in after['tabs']] == [t['mode'] for t in before['tabs']]
    line_diff = max((abs(x['line'] - y['line']) for x, y in zip(after['tabs'], before['tabs'])), default=99) if paths_ok else 99
    active_ok = (after['active'] or '').lower() == (before['active'] or '').lower()
    check(rid, f'{how} 후 재실행: 탭 10개 순서·보기 모드·줄·활성 탭 복원',
          len(after['tabs']) == 10 and paths_ok and modes_ok and line_diff < 2 and active_ok,
          f'tabs={len(after["tabs"])} 순서={paths_ok} 모드={modes_ok} 줄 최대 차이={line_diff:.2f} 활성={active_ok}')
    diffs = []
    for i, t in enumerate(before['tabs']):
        a.ev('(i) => __mdv.tabs.activate(__mdv.tabs.tabs[i].id)', i)
        got = settled(lambda: view_line(a, t['mode']))
        diffs.append(abs(got - t['line']) if got is not None else 99)
    check(rid, f'{how} 후 재실행: 탭마다 화면 위치가 저장한 줄과 일치', max(diffs) < 2,
          '차이 ' + ', '.join(f'{d:.1f}' for d in diffs))


def run_session10(pw):
    """SRS 8장 인수 기준: 탭 10개를 서로 다른 보기 모드로 두고 정상 종료·강제 종료 후 재실행하면
    탭·모드·스크롤 위치가 일치한다 (FR-SESS-01~02, NFR-REL-02). 앞 시나리오와 섞이지 않게 프로필을 따로 쓴다."""
    prof = WORK / 'profile-session'
    paths = [DOCS / '세션' / f'세션 문서 {n:02d}.md' for n in range(10)]
    modes = ['preview', 'source', 'split']

    # 1) 정상 종료: 미리보기 4·원문 3·분할 3, 탭마다 다른 위치, 활성 탭은 가운데, 패널 너비 변경
    a = App(pw, [], profile=prof)
    for p in paths:
        a.open(p)
    lines = [set_tab(a, i, modes[i % 3], 400 + i * 260) for i in range(10)]
    a.ev('() => __mdv.tabs.activate(__mdv.tabs.tabs[4].id)')
    a.settle()
    box = a.page.locator('#resizer').bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    a.page.mouse.move(x, y)
    a.page.mouse.down()
    a.page.mouse.move(x + 90, y, steps=6)
    a.page.mouse.up()
    width = a.ev('() => __mdv.session.sidePanel.width')
    time.sleep(0.8)
    before = a.state()
    check('FR-SESS-01', '세션 시험 준비: 탭 10개, 서로 다른 줄', len(before['tabs']) == 10 and len({round(v, 1) for v in lines}) == 10 and min(lines) > 3,
          'lines=' + ', '.join(f'{v:.1f}' for v in lines) + ' modes=' + ','.join(t['mode'] for t in before['tabs']))
    closed = a.close()
    check('FR-SESS-01', '탭 10개 상태에서 창 닫기 → 정상 종료', closed)

    a2 = App(pw, [], profile=prof)
    compare_session(a2, before, 'FR-SESS-01', '정상 종료')
    side = a2.ev('() => ({ visible: !document.getElementById("side").hidden, width: Math.round(document.getElementById("side").getBoundingClientRect().width) })')
    check('FR-SESS-02', '사이드 패널 열림 상태·너비 기억', side['visible'] and abs(side['width'] - width) <= 1, f'{width} → {side}')

    # 2) 강제 종료: 모드를 한 칸씩 돌리고 위치·활성 탭·패널 상태를 바꾼 뒤 마지막 자동 저장만 믿고 죽인다
    lines2 = [set_tab(a2, i, modes[(i + 1) % 3], 300 + i * 310) for i in range(10)]
    a2.ev('() => __mdv.tabs.activate(__mdv.tabs.tabs[7].id)')
    a2.settle()
    a2.key('Control+b')
    time.sleep(1.2)  # 세션 자동 저장(500 ms 디바운스)이 끝날 시간
    before2 = a2.state()
    a2.kill()

    a3 = App(pw, [], profile=prof)
    compare_session(a3, before2, 'NFR-REL-02', '강제 종료')
    hidden = a3.ev('() => document.getElementById("side").hidden')
    check('FR-SESS-02', '강제 종료 뒤에도 사이드 패널 닫힘 상태 기억', hidden is True,
          'lines=' + ', '.join(f'{v:.1f}' for v in lines2))
    a3.close()


def measure_memory(pw):
    """NFR-PERF-06: 새 프로필에서 일반 문서 탭 20개를 연 상태의 메모리 (하위 WebView2 프로세스 포함)."""
    a = App(pw, [DOCS / 'many' / '탭00.md'], profile=WORK / 'profile-mem')
    for n in range(1, 20):
        a.open(DOCS / 'many' / f'탭{n:02d}.md')
    for n in range(20):  # 모든 탭을 한 번씩 보여 렌더링 캐시까지 채운 상태로 잰다
        a.key('Control+Tab')
    time.sleep(2.0)
    ps = ('$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize; '
          f'$ids = @({a.proc.pid}); do {{ $n = $ids.Count; $ids = @($ids + ($all | Where-Object {{ $ids -contains $_.ParentProcessId }} | ForEach-Object ProcessId) | Select-Object -Unique) }} while ($ids.Count -gt $n); '
          '$ws = ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum; '
          '$priv = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains $_.IDProcess } | Measure-Object WorkingSetPrivate -Sum).Sum; '
          '"$ws $priv $($ids.Count)"')
    out = subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, text=True, encoding='utf-8')
    ws, priv, procs = (out.stdout.strip().split() + ['0', '0', '0'])[:3]
    ws_mb, priv_mb = int(ws) / 1048576, int(priv) / 1048576
    tabs = len(a.state()['tabs'])
    check('NFR-PERF-06', f'일반 문서 탭 {tabs}개: 메모리(개인 작업 집합) 500 MB 이하',
          tabs == 20 and 0 < priv_mb <= 500, f'개인 작업 집합 {priv_mb:.0f} MB, 전체 작업 집합 {ws_mb:.0f} MB, 프로세스 {procs}개')
    a.kill()


def measure_startup(readme):
    """NFR-PERF-01: 실행부터 첫 탭이 그려진 첫 프레임까지. 디버깅 포트 없이 10회 중앙값.
    앱의 시작 계측(MDVIEW_TRACE=1)이 남기는 first-paint(프로세스 시작 기준 ms)를 쓴다."""
    prof = WORK / 'profile-startup'
    log = prof / 'logs' / 'mdview.log'
    times = []
    for i in range(11):
        if log.exists():
            log.unlink()
        env = app_env(debug=False, profile=prof)
        env['MDVIEW_TRACE'] = '1'
        p = subprocess.Popen([EXE, '--new-window', str(readme)], env=env)
        SPAWNED.append(p)
        ms = None
        t0 = time.time()
        while time.time() - t0 < 15 and ms is None:
            time.sleep(0.05)
            if log.exists():
                for line in log.read_text(encoding='utf-8').splitlines():
                    if '[trace] first-paint ' in line:
                        ms = int(line.rsplit(' ', 1)[1])
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
        p.wait(timeout=10)
        if i > 0 and ms is not None:
            times.append(ms / 1000)  # 첫 회는 WebView2 프로필을 만드는 준비 실행
        time.sleep(1.5)
    med = statistics.median(times) if times else 99
    check('NFR-PERF-01', '콜드 스타트 1.5초 이내(첫 프레임까지, 10회 중앙값, 첫 회 제외)', len(times) == 10 and med <= 1.5,
          f'{med:.2f}s (min {min(times):.2f}, max {max(times):.2f}, {len(times)}회)')


def main():
    readme = prepare()
    print('작업 폴더:', WORK, flush=True)
    try:
        measure_startup(readme)  # 무거운 시나리오 전에, 시스템이 조용할 때 잰다
        with sync_playwright() as pw:
            before, rect = run(pw, readme)
            run_restore(pw, before, rect)
            guard('FR-SESS-01', '탭 10개 세션 복원', lambda: run_session10(pw))
            kill_spawned()  # 실패해 남은 앱이 있으면 디버깅 포트가 겹치지 않게 정리한다
            measure_memory(pw)
    finally:
        kill_spawned()
    log = PROFILE / 'logs' / 'mdview.log'
    log_text = log.read_text(encoding='utf-8') if log.exists() else ''
    check('NFR-REL-03', '오류 로그에 예상치 못한 오류 없음', '[error]' not in log_text, log_text[-500:])
    passed = sum(r['ok'] for r in RESULTS)
    print(f'# pass {passed}')
    print(f'# fail {len(RESULTS) - passed}')
    (OUT / 'e2e-results.json').write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.rmtree(WORK, ignore_errors=True)
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == '__main__':
    main()
