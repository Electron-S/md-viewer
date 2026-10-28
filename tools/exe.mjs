// Windows 앱(MDViewer.exe) 빌드. .NET Framework 4.8의 csc.exe(C# 5)로 host/*.cs를 컴파일하고
// viewer.html과 WebView2 SDK DLL을 리소스로 넣어 EXE 하나로 만든다. Windows나 WSL에서만 할 수 있다.
// C# 소스는 UTF-8이므로 csc에 -codepage:65001을 꼭 넘긴다(Windows 기본 CP949로 읽으면 한글이 깨진다).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const WV2_VERSION = '1.0.4258.31';
const WV2_FILES = {
  'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll',
  'lib/net462/Microsoft.Web.WebView2.WinForms.dll': 'Microsoft.Web.WebView2.WinForms.dll',
  'runtimes/win-x64/native/WebView2Loader.dll': 'WebView2Loader.dll',
  'LICENSE.txt': 'WebView2-LICENSE.txt',
};
const REFS = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'];
const WSL = process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));

/** csc.exe 위치. 없으면(Windows·WSL이 아님) null */
export function findCsc() {
  if (process.platform === 'win32') {
    const p = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    return existsSync(p) ? p : null;
  }
  const p = '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
  return WSL && existsSync(p) ? p : null;
}

/** csc가 읽고 쓸 Windows 쪽 작업 폴더. WSL에서는 Windows 디스크(%LOCALAPPDATA%)에 둔다(UNC 경로를 피한다). */
function stageDir(name) {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA, name);
  const win = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
  return join(execFileSync('wslpath', ['-u', win], { encoding: 'utf8' }).trim(), name);
}

/** WebView2 SDK(NuGet 패키지)에서 필요한 파일을 lib/에 꺼내 둔다. 이미 있으면 그대로 쓴다. */
async function ensureWebView2() {
  if (Object.values(WV2_FILES).every((f) => existsSync(join('lib', f)))) return;
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WV2_VERSION}/microsoft.web.webview2.${WV2_VERSION}.nupkg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WebView2 SDK를 받지 못했습니다: ${res.status} ${url}`);
  const entries = readZip(Buffer.from(await res.arrayBuffer()));
  mkdirSync('lib', { recursive: true });
  for (const [src, dst] of Object.entries(WV2_FILES)) {
    const data = entries.get(src);
    if (!data) throw new Error(`WebView2 SDK 패키지에 ${src} 이 없습니다`);
    writeFileSync(join('lib', dst), data);
  }
}

/** zip(NuGet 패키지)의 파일을 이름 → 내용으로 읽는다. 중앙 디렉터리만 믿는다. */
function readZip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('zip 끝 레코드가 없습니다');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 버전과 파일 속성(자세히 탭)에 보일 정보 */
function buildInfo(version) {
  const v4 = `${version.split('-')[0]}.0`;
  return `// 빌드(tools/exe.mjs)가 만든 파일. 고치지 마세요.
using System.Reflection;
[assembly: AssemblyTitle("MD Viewer")]
[assembly: AssemblyProduct("MD Viewer")]
[assembly: AssemblyCopyright("MIT License")]
[assembly: AssemblyVersion("${v4}")]
[assembly: AssemblyFileVersion("${v4}")]
[assembly: AssemblyInformationalVersion("${version}")]
namespace MdViewer
{
    static class BuildInfo
    {
        public const string Version = "${version}";
        public const string WebView2Version = "${WV2_VERSION}";
    }
}
`;
}

function csc(cscPath, cwd, args) {
  try {
    const out = execFileSync(cscPath, ['-nologo', '-codepage:65001', '-utf8output', '-langversion:5', '-optimize+', '-warn:4', ...args], { cwd, encoding: 'utf8' });
    if (out.trim()) console.log(out.replace(/\r/g, '').trim());
  } catch (e) {
    throw new Error(`csc 컴파일 실패\n${String(e.stdout ?? '').replace(/\r/g, '')}`);
  }
}

/**
 * MDViewer.exe를 만들어 out에 둔다. tests가 참이면 C# 단위 테스트 실행 파일(작업 폴더의 MDViewer-tests.exe)도 만든다.
 * csc가 없으면 null을 돌려준다(Windows·WSL이 아닌 곳). 작업 폴더는 빌드와 테스트가 겹치지 않게 이름을 따로 준다.
 */
export async function buildExe({ version, viewer, out, tests = false, stageName = 'MdViewer-build' }) {
  const cscPath = findCsc();
  if (!cscPath) return null;
  await ensureWebView2();
  const stage = stageDir(stageName);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'src'), { recursive: true });
  for (const f of readdirSync('host')) copyFileSync(join('host', f), join(stage, 'src', f));
  writeFileSync(join(stage, 'src', 'BuildInfo.cs'), buildInfo(version));
  for (const f of Object.values(WV2_FILES)) copyFileSync(join('lib', f), join(stage, f));
  copyFileSync(viewer, join(stage, 'viewer.html'));
  const sources = readdirSync(join(stage, 'src')).filter((f) => f.endsWith('.cs')).map((f) => `src\\${f}`);
  const refs = [...REFS, 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'].map((r) => `-r:${r}`);
  const resources = ['viewer.html', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'].map((r) => `-resource:${r},${r}`);
  csc(cscPath, stage, ['-target:winexe', '-platform:x64', '-out:MDViewer.exe', '-win32manifest:src\\app.manifest', '-win32icon:src\\app.ico', ...refs, ...resources, ...sources]);
  copyFileSync(join(stage, 'MDViewer.exe'), out);
  if (tests) {
    mkdirSync(join(stage, 'tests'), { recursive: true });
    for (const f of readdirSync('tests/host')) copyFileSync(join('tests/host', f), join(stage, 'tests', f));
    // 테스트는 창·WebView2 화면 없이 도는 부분만 본다. 앱 진입점(Program), 창(MainForm), 창에 붙은 브리지(Bridge)는 빼고 묶는다.
    const testable = sources.filter((s) => !/\\(Program|MainForm|Bridge)\.cs$/.test(s));
    const testSources = readdirSync(join(stage, 'tests')).filter((f) => f.endsWith('.cs')).map((f) => `tests\\${f}`);
    csc(cscPath, stage, ['-target:exe', '-platform:x64', '-out:MDViewer-tests.exe', ...refs, ...resources, ...testable, ...testSources]);
  }
  return { stage, exe: out, tests: tests ? join(stage, 'MDViewer-tests.exe') : null };
}
