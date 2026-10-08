# 시작 단계별 시간: MDVIEW_TRACE=1로 10회 실행해 각 단계의 중앙값을 낸다.
import os, statistics, subprocess, sys, tempfile, time, pathlib, re
sys.stdout.reconfigure(encoding='utf-8')
EXE = sys.argv[1]
work = pathlib.Path(tempfile.mkdtemp(prefix='mdv-perf-'))
doc = work / 'README.md'
variant = sys.argv[2] if len(sys.argv) > 2 else 'plain'
body = '# 시작 시간\n\n' + '본문 문단입니다.\n\n' * 50
if variant == 'remote':
    body += '\n![원격](https://example.com/remote.png)\n'
if variant == 'local':
    (work / 'img').mkdir()
    (work / 'img' / 'dot.png').write_bytes(bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000') + bytes(30))
    body += '\n![로컬](img/dot.png)\n'
doc.write_text(body, encoding='utf-8')
prof = work / 'profile'
env = dict(os.environ, MDVIEW_PROFILE_DIR=str(prof), MDVIEW_TRACE='1')
if len(sys.argv) > 3 and sys.argv[3]:
    env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = sys.argv[3]
phases = {}
for i in range(11):
    log = prof / 'logs' / 'mdview.log'
    if log.exists():
        log.unlink()
    p = subprocess.Popen([EXE, '--new-window', str(doc)], env=env)
    t0 = time.time()
    while time.time() - t0 < 15:
        if log.exists() and 'first-paint' in log.read_text(encoding='utf-8'):
            break
        time.sleep(0.02)
    time.sleep(0.2)
    subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
    p.wait()
    time.sleep(1.5)
    if i == 0:
        continue
    for line in log.read_text(encoding='utf-8').splitlines():
        m = re.search(r'\[trace\] (.+) (\d+)$', line)
        if not m:
            continue
        name = m.group(1)
        if name.startswith('script '):
            for kv in name.split()[1:]:
                k, v = kv.split('=', 1)
                if k == 'res':
                    for item in v.split(','):
                        if not item:
                            continue
                        rn, span = item.rsplit(':', 1)
                        a, b = span.split('-')
                        phases.setdefault('  res ' + rn + ' start', []).append(int(a))
                        phases.setdefault('  res ' + rn + ' end', []).append(int(b))
                    continue
                if v != '-':
                    phases.setdefault('  page ' + k, []).append(int(v))
            name = 'script'
        phases.setdefault(name, []).append(int(m.group(2)))
for k, v in sorted(phases.items(), key=lambda kv: statistics.median(kv[1])):
    print(f'{k:40s} 중앙값 {statistics.median(v):6.0f} ms  (최소 {min(v)}, 최대 {max(v)}, {len(v)}회)')
