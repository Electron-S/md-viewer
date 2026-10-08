#!/usr/bin/env bash
# MD Viewer 전체 빌드 (SDD 9.2). WSL에서 실행한다.
#   1) 화면 번들  2) WebView2 SDK 준비  3) csc.exe로 호스트·테스트·설치 프로그램 컴파일  4) 포터블 zip·setup.exe
# C# 소스는 UTF-8이므로 csc에 -codepage:65001을 꼭 넘긴다 (Windows 기본 CP949로 읽으면 한글이 깨진다).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(node -p "require('./package.json').version")
WV2_VERSION=1.0.4258.31
CSC=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
FW=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319

LOCALAPPDATA_WIN=$(cd /mnt/c && cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r')
STAGE=$(wslpath -u "$LOCALAPPDATA_WIN")/MdViewer-build
OUT="$ROOT/build/MdViewer"
DIST="$ROOT/dist"

echo "== 1. 화면 번들"
npx tsc --noEmit -p .
node tools/bundle.mjs

echo "== 2. WebView2 SDK $WV2_VERSION"
if [ ! -f lib/Microsoft.Web.WebView2.Core.dll ]; then
  mkdir -p lib
  tmp=$(mktemp -d)
  curl -sSL -o "$tmp/wv2.nupkg" "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WV2_VERSION/microsoft.web.webview2.$WV2_VERSION.nupkg"
  python3 - "$tmp/wv2.nupkg" lib <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
want = {
    'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll': 'WebView2Loader.dll',
    'LICENSE.txt': 'WebView2-LICENSE.txt',
}
for src, dst in want.items():
    with z.open(src) as f, open(f"{sys.argv[2]}/{dst}", 'wb') as o:
        o.write(f.read())
PY
  rm -rf "$tmp"
fi

echo "== 3. 호스트 컴파일 ($STAGE)"
rm -rf "$STAGE"
mkdir -p "$STAGE/src" "$STAGE/tests" "$STAGE/setup" "$STAGE/out"
cp host/*.cs host/app.manifest "$STAGE/src/"
cp tests/host/*.cs "$STAGE/tests/"
cp setup/*.cs "$STAGE/setup/"
cp lib/*.dll "$STAGE/"
[ -f host/app.ico ] && cp host/app.ico "$STAGE/src/"

csc() {
  (cd "$STAGE" && "$CSC" -nologo -codepage:65001 -utf8output -langversion:5 -optimize+ -warn:4 "$@") | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
REFS="-r:System.dll -r:System.Core.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll -r:System.Web.Extensions.dll"
ICON=""
[ -f "$STAGE/src/app.ico" ] && ICON="-win32icon:src\\app.ico"

csc -target:winexe -platform:x64 -out:out\\mdview.exe -win32manifest:src\\app.manifest $ICON $REFS \
  -r:Microsoft.Web.WebView2.Core.dll -r:Microsoft.Web.WebView2.WinForms.dll src\\*.cs
csc -target:exe -platform:x64 -out:out\\mdview-tests.exe $REFS \
  src\\Strings.cs src\\EncodingDetector.cs src\\Storage.cs src\\FileService.cs src\\WatchService.cs tests\\*.cs

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$STAGE/out/mdview.exe" host/mdview.exe.config lib/Microsoft.Web.WebView2.Core.dll lib/Microsoft.Web.WebView2.WinForms.dll lib/WebView2Loader.dll "$OUT/"
cp -r build/web "$OUT/web"
cp lib/WebView2-LICENSE.txt "$OUT/"
cp "$STAGE/out/mdview-tests.exe" "$ROOT/build/"

echo "== 4. 포터블 zip, setup.exe"
mkdir -p "$DIST"
PORTABLE="$DIST/MdViewer-$VERSION-portable.zip"
PAYLOAD="$STAGE/payload.zip"
python3 - "$OUT" "$PORTABLE" "$PAYLOAD" <<'PY'
import os, sys, zipfile
src, portable, payload = sys.argv[1:4]
def pack(path, extra):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(src):
            for f in files:
                full = os.path.join(base, f)
                z.write(full, os.path.join('MdViewer', os.path.relpath(full, src)) if extra else os.path.relpath(full, src))
        if extra:
            z.writestr('MdViewer/portable.txt', '이 파일이 있으면 설정을 실행 폴더의 data\\ 에 저장합니다.\n'.encode('utf-8'))
pack(portable, True)
pack(payload, False)
PY
csc -target:winexe -platform:x64 -out:out\\setup.exe -win32manifest:src\\app.manifest $ICON $REFS \
  -r:System.IO.Compression.dll -r:System.IO.Compression.FileSystem.dll -r:Microsoft.CSharp.dll \
  -resource:payload.zip,payload.zip setup\\*.cs
cp "$STAGE/out/setup.exe" "$DIST/MdViewer-$VERSION-setup.exe"

echo "== 완료"
ls -la "$OUT" "$DIST"
du -sh "$OUT"
