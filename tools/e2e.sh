#!/usr/bin/env bash
# E2E (SDD 9.3): 빌드 결과를 Windows 로컬 디스크에 복사하고 Windows Python + Playwright로 실제 앱을 조종한다.
# 준비(한 번): python -m venv %LOCALAPPDATA%\MdViewer-dev\venv && venv\Scripts\pip install playwright==1.55.0
# Microsoft Store Python은 AppData 쓰기를 패키지 캐시로 돌리므로 venv 실제 위치를 찾아 쓴다.
set -euo pipefail
cd "$(dirname "$0")/.."
WIN_LOCAL=$(wslpath -u "$(cd /mnt/c && cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")
WIN_TEMP=$(wslpath -u "$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")
PY=$(ls "$WIN_LOCAL"/Packages/PythonSoftwareFoundation.Python.*/LocalCache/Local/MdViewer-dev/venv/Scripts/python.exe "$WIN_LOCAL"/MdViewer-dev/venv/Scripts/python.exe 2>/dev/null | head -1 || true)
[ -n "$PY" ] || { echo "Playwright venv가 없습니다 (스크립트 머리말 참고)"; exit 2; }
APP="$WIN_LOCAL/MdViewer-dev/app"
RUN="$WIN_TEMP/mdv-e2e-run"
# 지난 실행이 남긴 테스트용 앱(이 개발 폴더에서 뜬 것만)을 정리한다.
(cd /mnt/c && powershell.exe -NoProfile -Command "Get-Process mdview -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like '*MdViewer-dev*' } | Stop-Process -Force" >/dev/null 2>&1) || true
sleep 1
rm -rf "$APP" "$RUN"
mkdir -p "$APP" "$RUN/out"
cp -r build/MdViewer/* "$APP/"
cp tests/e2e/e2e.py "$RUN/"
set +e
(cd /mnt/c && WSLENV=PYTHONUTF8 PYTHONUTF8=1 "$PY" "$(wslpath -w "$RUN/e2e.py")" "$(wslpath -w "$APP/mdview.exe")" "$(wslpath -w "$RUN/out")") | tr -d '\r'
code=${PIPESTATUS[0]}
set -e
mkdir -p build/e2e
cp "$RUN"/out/* build/e2e/ 2>/dev/null || true
exit $code
