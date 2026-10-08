#!/usr/bin/env bash
# 호스트 단위 테스트(build/mdview-tests.exe)를 Windows 로컬 디스크에서 실행한다.
set -euo pipefail
cd "$(dirname "$0")/.."
LOCALAPPDATA_WIN=$(cd /mnt/c && cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')
RUN=$(wslpath -u "$LOCALAPPDATA_WIN")/MdViewer-build/out
cp build/mdview-tests.exe "$RUN/"
cd "$RUN"
set +e
./mdview-tests.exe | tr -d '\r'
code=${PIPESTATUS[0]}
exit $code
