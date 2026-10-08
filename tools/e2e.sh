#!/usr/bin/env bash
# E2E (SDD 9.3): WSL에서 띄운 실행기와 Windows Edge를 Windows Python + Playwright로 조종한다.
# 준비(한 번, Windows): python -m venv %LOCALAPPDATA%\MdViewer-dev\venv && venv\Scripts\pip install playwright==1.55.0
#   브라우저는 설치된 Edge(channel msedge)를 쓰므로 playwright install은 필요 없다.
# Microsoft Store Python은 AppData 쓰기를 패키지 캐시로 돌리므로 venv 실제 위치를 찾아 쓴다.
# --headed를 주면 Edge 창을 띄워 보이게 돈다.
set -euo pipefail
cd "$(dirname "$0")/.."
DISTRO=${WSL_DISTRO_NAME:?WSL 안에서 실행하세요}
NODE=$(command -v node)
[ -f dist/viewer.html ] && [ -f dist/mdview/mdview.mjs ] || node tools/build.mjs
WIN_LOCAL=$(wslpath -u "$(cd /mnt/c && cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")
WIN_TEMP=$(wslpath -u "$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")
PY=$(ls "$WIN_LOCAL"/Packages/PythonSoftwareFoundation.Python.*/LocalCache/Local/MdViewer-dev/venv/Scripts/python.exe "$WIN_LOCAL"/MdViewer-dev/venv/Scripts/python.exe 2>/dev/null | head -1 || true)
[ -n "$PY" ] || { echo "Playwright venv가 없습니다 (스크립트 머리말 참고)"; exit 2; }

# 문서와 실행기 홈은 WSL 디스크에, 테스트 스크립트와 독립 모드용 viewer.html은 Windows 디스크에 둔다.
WORK=$(mktemp -d /tmp/mdv-e2e.XXXXXX)
RUN="$WIN_TEMP/mdv-e2e-run"
cleanup() {
  # 테스트가 띄운 실행기(이 작업 폴더의 mdview.mjs)만 정리한다.
  pkill -f "$WORK/app/mdview.mjs" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
cp -r dist/mdview "$WORK/app"
rm -rf "$RUN"
mkdir -p "$RUN/out"
cp tests/e2e/e2e.py dist/viewer.html "$RUN/"

set +e
(cd /mnt/c && WSLENV=PYTHONUTF8 PYTHONUTF8=1 "$PY" "$(wslpath -w "$RUN/e2e.py")" \
  --distro "$DISTRO" --node "$NODE" --work "$WORK" \
  --viewer "$(wslpath -w "$RUN/viewer.html")" --out "$(wslpath -w "$RUN/out")" "$@") | sed -u 's/\r$//'
code=${PIPESTATUS[0]}
set -e
mkdir -p build/e2e
cp "$RUN"/out/* build/e2e/ 2>/dev/null || true
exit $code
