# 스모크: 앱을 원격 디버깅 포트로 띄우고 첫 렌더링과 콘솔 오류를 확인한다.
import os, subprocess, sys, time, tempfile, pathlib
from playwright.sync_api import sync_playwright

APP = sys.argv[1]
SHOT = sys.argv[2]
work = pathlib.Path(tempfile.mkdtemp(prefix='mdv-smoke-'))
doc = work / '한글 폴더' / 'README.md'
doc.parent.mkdir(parents=True)
doc.write_text('# 스모크 테스트\n\n본문 **굵게**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n## 둘째 제목\n\n- [x] 할 일\n', encoding='utf-8')
env = dict(os.environ, MDVIEW_PROFILE_DIR=str(work / 'profile'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333')
t0 = time.time()
proc = subprocess.Popen([APP, str(doc)], env=env)
try:
    with sync_playwright() as p:
        browser = None
        for _ in range(100):
            try:
                browser = p.chromium.connect_over_cdp('http://127.0.0.1:9333')
                break
            except Exception:
                time.sleep(0.1)
        page = None
        for _ in range(100):
            pages = [pg for c in browser.contexts for pg in c.pages if 'app.mdview' in pg.url]
            if pages:
                page = pages[0]
                break
            time.sleep(0.1)
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.wait_for_selector('body[data-ready="1"]', timeout=15000)
        print('ready after', round(time.time() - t0, 2), 's')
        print('title', page.title())
        print('tabs', page.locator('.tab').count())
        print('h1 in preview', page.evaluate("() => __mdv.preview.article.querySelector('h1')?.textContent"))
        print('status', page.locator('#statusbar').inner_text().replace('\n', ' | '))
        page.screenshot(path=SHOT)
        print('console errors', errors)
finally:
    proc.kill()
