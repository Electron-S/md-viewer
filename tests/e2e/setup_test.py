# 설치 프로그램·포터블판 검증 (NFR-PORT-01, SRS 4.3).
#   python setup_test.py <setup.exe> <portable.zip>
# 실제 파일 연결을 건드리지 않도록 레지스트리는 HKCU\Software\MdViewerTest 아래에, 설치·바로 가기는 임시 폴더에 둔다.
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import winreg
import zipfile

sys.stdout.reconfigure(encoding='utf-8')
SETUP, PORTABLE = sys.argv[1], sys.argv[2]
ROOT = r'Software\MdViewerTest'
work = pathlib.Path(tempfile.mkdtemp(prefix='mdv-setup-'))
install = work / '설치 폴더'
shortcuts = work / 'shortcuts'
env = dict(os.environ, MDVIEW_SETUP_REGROOT=ROOT, MDVIEW_SETUP_SHORTCUT_DIR=str(shortcuts))
results = []


def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('ok    ' if cond else 'FAIL  ') + name + (f' — {detail}' if detail else ''), flush=True)


def reg(path, name=''):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def reg_has_value(path, name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            winreg.QueryValueEx(k, name)
            return True
    except OSError:
        return False


def delete_tree(path):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_ALL_ACCESS) as k:
            while True:
                try:
                    sub = winreg.EnumKey(k, 0)
                except OSError:
                    break
                delete_tree(path + '\\' + sub)
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
    except OSError:
        pass


def first_paint(exe, extra_env, doc):
    log_dir = pathlib.Path(extra_env.get('MDVIEW_PROFILE_DIR') or (pathlib.Path(exe).parent / 'data')) / 'logs'
    p = subprocess.Popen([exe, '--new-window', str(doc)], env={**os.environ, **extra_env, 'MDVIEW_TRACE': '1'})
    ms = None
    t0 = time.time()
    while time.time() - t0 < 20 and ms is None:
        time.sleep(0.1)
        log = log_dir / 'mdview.log'
        if log.exists():
            for line in log.read_text(encoding='utf-8').splitlines():
                if '[trace] first-paint ' in line:
                    ms = int(line.rsplit(' ', 1)[1])
    subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
    p.wait(timeout=10)
    return ms


doc = work / '문서.md'
doc.write_text('# 설치 확인\n\n본문\n', encoding='utf-8')
try:
    r = subprocess.run([SETUP, '/silent', f'/dir:{install}'], env=env, timeout=120)
    exe = install / 'mdview.exe'
    check('setup.exe /silent 설치 성공', r.returncode == 0, f'exit={r.returncode}')
    check('파일 배치(mdview.exe, web, WebView2, uninstall.exe)',
          all((install / f).exists() for f in ['mdview.exe', 'web/index.html', 'web/source.js', 'WebView2Loader.dll', 'Microsoft.Web.WebView2.Core.dll', 'uninstall.exe']))
    size = sum(f.stat().st_size for f in install.rglob('*') if f.is_file()) / 1048576
    check('설치 크기 30 MB 이하 (NFR-PORT-03)', size <= 30, f'{size:.1f} MB, setup.exe {pathlib.Path(SETUP).stat().st_size / 1048576:.1f} MB')
    cmd = reg(ROOT + r'\Classes\MdViewer.Markdown\shell\open\command')
    check('ProgID 등록', cmd == f'"{exe}" "%1"', cmd)
    check('.md 연결 프로그램 목록(OpenWithProgids)', reg_has_value(ROOT + r'\Classes\.md\OpenWithProgids', 'MdViewer.Markdown'))
    ctx = reg(ROOT + r'\Classes\SystemFileAssociations\.md\shell\MdViewer')
    check('탐색기 우클릭 메뉴', ctx == 'MD Viewer로 열기', ctx)
    un = reg(ROOT + r'\Microsoft\Windows\CurrentVersion\Uninstall\MdViewer', 'UninstallString')
    check('앱 목록(제거) 등록', un == f'"{install / "uninstall.exe"}" /uninstall', un)
    check('시작 메뉴 바로 가기', (shortcuts / 'MD Viewer.lnk').exists())
    ms = first_paint(str(exe), {'MDVIEW_PROFILE_DIR': str(work / 'profile')}, doc)
    check('설치본 실행', ms is not None, f'첫 프레임 {ms} ms')

    r = subprocess.run([str(install / 'uninstall.exe'), '/uninstall', '/silent'], env=env, timeout=60)
    time.sleep(5)
    check('제거 성공', r.returncode == 0, f'exit={r.returncode}')
    check('레지스트리 정리', reg(ROOT + r'\Classes\MdViewer.Markdown\shell\open\command') is None
          and not reg_has_value(ROOT + r'\Classes\.md\OpenWithProgids', 'MdViewer.Markdown')
          and reg(ROOT + r'\Classes\SystemFileAssociations\.md\shell\MdViewer') is None
          and reg(ROOT + r'\Microsoft\Windows\CurrentVersion\Uninstall\MdViewer', 'UninstallString') is None)
    check('바로 가기·설치 폴더 정리', not (shortcuts / 'MD Viewer.lnk').exists() and not install.exists(),
          [p.name for p in install.iterdir()] if install.exists() else '')

    # 다른 파일이 있는 폴더에 설치했다가 제거해도 그 파일들은 남아야 한다 (리뷰 #3).
    shared = work / '공용 도구'
    (shared / 'web').mkdir(parents=True)
    (shared / '다른 프로그램.txt').write_text('지우면 안 됨', encoding='utf-8')
    (shared / 'web' / '내 파일.txt').write_text('지우면 안 됨', encoding='utf-8')
    r1 = subprocess.run([SETUP, '/silent', f'/dir:{shared}', '/noshortcut', '/noassoc', '/nocontext'], env=env, timeout=120)
    r2 = subprocess.run([str(shared / 'uninstall.exe'), '/uninstall', '/silent'], env=env, timeout=60)
    time.sleep(5)
    check('공용 폴더에 설치·제거해도 남의 파일은 남는다', r1.returncode == 0 and r2.returncode == 0
          and (shared / '다른 프로그램.txt').exists() and (shared / 'web' / '내 파일.txt').exists()
          and not (shared / 'mdview.exe').exists() and not (shared / 'web' / 'index.html').exists() and not (shared / 'uninstall.exe').exists(),
          sorted(str(p.relative_to(shared)) for p in shared.rglob('*')))

    # 포터블판: data\ 에 설정을 저장한다.
    pdir = work / 'portable'
    with zipfile.ZipFile(PORTABLE) as z:
        z.extractall(pdir)
    pexe = pdir / 'MdViewer' / 'mdview.exe'
    check('포터블 zip 구성(portable.txt)', (pdir / 'MdViewer' / 'portable.txt').exists())
    ms = first_paint(str(pexe), {}, doc)
    check('포터블판 실행·설정은 실행 폴더 data\\', ms is not None and (pdir / 'MdViewer' / 'data' / 'logs' / 'mdview.log').exists(), f'첫 프레임 {ms} ms')
finally:
    delete_tree(ROOT)
    shutil.rmtree(work, ignore_errors=True)
print(f'# pass {sum(results)}')
print(f'# fail {len(results) - sum(results)}')
sys.exit(0 if all(results) else 1)
