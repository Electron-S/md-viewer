using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace MdViewer.Tests
{
    /// <summary>
    /// Windows 앱 단위 테스트 (SDD 9.3). 창·WebView2 화면 없이 도는 부분을 본다. 결과는 UTF-8로 출력하고, 실패가 있으면 종료 코드 1.
    /// WebView2 DLL은 EXE 안의 리소스에서만 찾도록, 이 실행 파일은 DLL이 없는 폴더에서 돌린다(tools/test.mjs).
    /// </summary>
    static class HostTests
    {
        static int passed, failed;
        static string tmp;

        static void Check(bool ok, string name)
        {
            if (ok) passed++;
            else
            {
                failed++;
                Console.WriteLine("FAIL " + name);
            }
        }

        static void Eq(object actual, object expected, string name)
        {
            Check(Equals(actual, expected), name + " — 기대 [" + expected + "] 실제 [" + actual + "]");
        }

        static string Code(Action a)
        {
            try
            {
                a();
                return "OK";
            }
            catch (BridgeException ex)
            {
                return ex.Code;
            }
        }

        static void Test(string name, Action body)
        {
            int before = failed;
            try
            {
                body();
            }
            catch (Exception ex)
            {
                failed++;
                Console.WriteLine("FAIL " + name + " 예외: " + ex);
            }
            Console.WriteLine((failed == before ? "ok   " : "not ok ") + name);
        }

        static int Main()
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            Embedded.InstallResolver();
            tmp = Path.Combine(Path.GetTempPath(), "mdview-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tmp);
            Environment.SetEnvironmentVariable("MDVIEW_PROFILE_DIR", Path.Combine(tmp, "profile"));
            Storage.Init();
            Run();
            try
            {
                Directory.Delete(tmp, true);
            }
            catch (Exception) { }
            Console.WriteLine("# pass " + passed);
            Console.WriteLine("# fail " + failed);
            return failed == 0 ? 0 : 1;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Run()
        {
            Test("EXE 하나: 화면 HTML과 WebView2 DLL을 리소스에서 꺼내 런타임을 찾는다", () =>
            {
                byte[] html = Embedded.Read("viewer.html");
                Check(html != null && Encoding.UTF8.GetString(html).Contains("</head>"), "viewer.html 리소스");
                Check(!File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Microsoft.Web.WebView2.Core.dll")), "실행 폴더에 DLL이 없다(리소스에서 읽어야 한다)");
                Embedded.PrepareLoader();
                Check(File.Exists(Path.Combine(Embedded.LoaderDir, "WebView2Loader.dll")), "로더를 사용자 폴더에 푼다");
                string runtime = RuntimeVersion();
                Console.WriteLine("     WebView2 런타임 " + runtime);
                Check(!string.IsNullOrEmpty(runtime), "런타임 버전");
                var before = File.GetLastWriteTimeUtc(Path.Combine(Embedded.LoaderDir, "WebView2Loader.dll"));
                Eq(Embedded.ExtractLoader(), Embedded.LoaderDir, "다시 풀어도 같은 폴더");
                Eq(File.GetLastWriteTimeUtc(Path.Combine(Embedded.LoaderDir, "WebView2Loader.dll")), before, "이미 푼 파일은 다시 쓰지 않는다");
                Check(Directory.GetFiles(Embedded.LoaderDir, "*.tmp").Length == 0, "임시 파일이 남지 않는다");
                Embedded.PrepareLoader();
            });

            Test("경로: 절대 경로만, 정규화", () =>
            {
                Eq(Code(() => FileService.Normalize("foo.md")), "EINVAL", "상대 경로");
                Eq(Code(() => FileService.Normalize(@"\foo.md")), "EINVAL", "드라이브 상대");
                Eq(Code(() => FileService.Normalize("")), "EINVAL", "빈 경로");
                Eq(FileService.Normalize(@"C:/x/../y/./z.md"), @"C:\y\z.md", "정규화");
                Eq(FileService.Normalize(@"\\wsl.localhost\Ubuntu\home\a.md"), @"\\wsl.localhost\Ubuntu\home\a.md", "UNC");
            });

            Test("파일 읽기: 한글 이름, 바이트 그대로, 오류 코드 (FR-FILE-01)", () =>
            {
                string dir = Path.Combine(tmp, "문서 폴더");
                Directory.CreateDirectory(dir);
                string md = Path.Combine(dir, "한글 문서.md");
                byte[] want = new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes("# 제목\r\n본문\r\n")).ToArray();
                File.WriteAllBytes(md, want);
                double mtime;
                byte[] got = FileService.ReadBytes(md, out mtime);
                Check(got.SequenceEqual(want), "BOM까지 바이트 그대로(판별은 화면이 한다)");
                double expect = (File.GetLastWriteTimeUtc(md) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                Check(Math.Abs(mtime - expect) < 1, "수정 시각(Unix ms)");
                Eq(Code(() => FileService.ReadBytes(dir, out mtime)), "EISDIR", "폴더");
                Eq(Code(() => FileService.ReadBytes(Path.Combine(dir, "없음.md"), out mtime)), "ENOENT", "없는 파일");
                Eq(Code(() => FileService.ReadBytes("상대.md", out mtime)), "EINVAL", "상대 경로");
            });

            Test("네트워크 공유: 사용자가 연 공유의 그림만 응답 (SDD 8.4)", () =>
            {
                Eq(FileService.ShareRoot(@"\\nas\docs\a\b.png"), @"\\nas\docs", "공유 루트");
                Eq(FileService.ShareRoot(@"C:\a.png"), null, "로컬");
                Check(FileService.ImageAllowed(@"C:\x\a.png"), "로컬 그림은 허용");
                Check(!FileService.ImageAllowed(@"\\evil\share\a.png"), "모르는 공유는 거부");
                FileService.TrustShare(@"\\nas\docs\guide\readme.md");
                Check(FileService.ImageAllowed(@"\\NAS\Docs\img\a.png"), "연 문서의 공유는 허용");
                Check(!FileService.ImageAllowed(@"\\nas\other\a.png"), "같은 서버라도 다른 공유는 거부");
                Eq(FileService.ImageMime(@"C:\a.SVG"), "image/svg+xml", "그림 MIME");
                Eq(FileService.ImageMime(@"C:\a.md"), null, "그림이 아님");
            });

            Test("10 MB 파일 읽기 2초 이내 (NFR-PERF-03)", () =>
            {
                string big = Path.Combine(tmp, "big.md");
                var sb = new StringBuilder();
                while (sb.Length < 10 * 1024 * 1024) sb.Append("## 제목\n본문 줄입니다 lorem ipsum dolor sit amet.\n");
                File.WriteAllText(big, sb.ToString(), new UTF8Encoding(false));
                var sw = Stopwatch.StartNew();
                double mtime;
                FileService.ReadBytes(big, out mtime);
                Console.WriteLine("     10 MB 읽기 " + sw.ElapsedMilliseconds + " ms");
                Check(sw.ElapsedMilliseconds < 2000, "2초 이내");
            });

            Test("폴더 목록: 문서만, 폴더 먼저, 숨김·node_modules 제외 (FR-NAV-02)", () =>
            {
                string root = Path.Combine(tmp, "ws");
                Directory.CreateDirectory(Path.Combine(root, "sub"));
                Directory.CreateDirectory(Path.Combine(root, "node_modules"));
                Directory.CreateDirectory(Path.Combine(root, ".git"));
                File.WriteAllText(Path.Combine(root, "b.md"), "");
                File.WriteAllText(Path.Combine(root, "A.txt"), "");
                File.WriteAllText(Path.Combine(root, "c.png"), "");
                string hidden = Path.Combine(root, "h.md");
                File.WriteAllText(hidden, "");
                File.SetAttributes(hidden, FileAttributes.Hidden);
                var names = FileService.ListDir(root).Cast<Dictionary<string, object>>().Select(e => (string)e["name"] + ((bool)e["isDir"] ? "/" : "")).ToList();
                Eq(string.Join(",", names), "sub/,A.txt,b.md", "목록");
                var entries = FileService.Entries(new[] { root, Path.Combine(root, "b.md"), "상대" }).Cast<Dictionary<string, object>>().ToList();
                Eq(entries.Count, 2, "상대 경로는 뺀다");
                Check((bool)entries[0]["isDir"] && !(bool)entries[1]["isDir"], "폴더 여부");
            });

            Test("저장: 원자적 쓰기와 UTF-8 (NFR-ENC-04, NFR-REL-02)", () =>
            {
                Storage.WriteText("session", "{\"한글\": 1}");
                Storage.WriteText("session", "{\"한글\": 2}");
                Eq(Storage.ReadText("session"), "{\"한글\": 2}", "다시 읽기");
                Check(!File.Exists(Path.Combine(Storage.ConfigDir, "session.json.tmp")), "임시 파일 없음");
                byte[] raw = File.ReadAllBytes(Path.Combine(Storage.ConfigDir, "session.json"));
                Check(raw[0] == (byte)'{', "BOM 없음");
                Eq(Code(() => Storage.WriteText("../evil", "x")), "EINVAL", "허용 목록 밖 이름");
            });

            Test("외부 주소: http·https·mailto만 연다 (SRS 4.3)", () =>
            {
                Eq(Code(() => Shell.OpenExternal("javascript:alert(1)")), "EINVAL", "javascript");
                Eq(Code(() => Shell.OpenExternal("file:///C:/Windows/notepad.exe")), "EINVAL", "file");
                Eq(Code(() => Shell.OpenExternal("")), "EINVAL", "빈 주소");
                Eq(Code(() => Shell.Reveal(Path.Combine(tmp, "없는 폴더", "a.md"))), "ENOENT", "없는 위치는 탐색기를 열지 않는다");
            });

            Test("탐색기 연결 프로그램: 사용자 단위로 등록·확인·해제 (Windows 앱)", () =>
            {
                string root = @"Software\MdViewer-test-" + Guid.NewGuid().ToString("N");
                Environment.SetEnvironmentVariable("MDVIEW_REGROOT", root);
                try
                {
                    string exe = Path.Combine(tmp, "앱", "MDViewer.exe");
                    Check(!OpenWith.IsRegistered(exe), "처음에는 등록 안 됨");
                    OpenWith.Register(exe);
                    Check(OpenWith.IsRegistered(exe), "등록됨");
                    Check(!OpenWith.IsRegistered(Path.Combine(tmp, "다른 곳", "MDViewer.exe")), "EXE를 옮기면 등록 안 된 것으로 본다");
                    using (var k = Registry.CurrentUser.OpenSubKey(root + @"\Classes\.md\OpenWithProgids"))
                        Check(k != null && k.GetValueNames().Contains("MdViewer.Document"), ".md 연결 프로그램 목록");
                    using (var k = Registry.CurrentUser.OpenSubKey(root + @"\Classes\Applications\MDViewer.exe\shell\open\command"))
                        Eq(k == null ? null : k.GetValue(""), "\"" + exe + "\" \"%1\"", "열기 명령");
                    using (var k = Registry.CurrentUser.OpenSubKey(root + @"\Classes\SystemFileAssociations\.markdown\shell\MdViewer\command"))
                        Check(k != null, "오른쪽 클릭 메뉴");
                    OpenWith.Unregister(exe);
                    Check(!OpenWith.IsRegistered(exe), "해제됨");
                    using (var k = Registry.CurrentUser.OpenSubKey(root + @"\Classes\.md\OpenWithProgids"))
                        Check(k == null || !k.GetValueNames().Contains("MdViewer.Document"), "목록에서 빠짐");
                }
                finally
                {
                    Registry.CurrentUser.DeleteSubKeyTree(root, false);
                    Environment.SetEnvironmentVariable("MDVIEW_REGROOT", null);
                }
            });

            Test("로그 순환 (NFR-REL-03)", () =>
            {
                string line = new string('x', 2000);
                for (int i = 0; i < 1200; i++) Log.Info(line);
                Check(File.Exists(Path.Combine(Storage.LogDir, "mdview.1.log")), "mdview.1.log 생성");
                Check(new FileInfo(Path.Combine(Storage.LogDir, "mdview.log")).Length < 1024 * 1024, "현재 로그 1 MB 미만");
            });

            Test("감시: 변경·삭제를 알린다 (FR-WATCH-01~02, NFR-PERF-04)", () =>
            {
                string f = Path.Combine(tmp, "감시.md");
                File.WriteAllText(f, "1");
                var changed = new ManualResetEventSlim();
                var deleted = new ManualResetEventSlim();
                var sw = new Stopwatch();
                long changedMs = -1;
                using (var w = new WatchService(p =>
                {
                    if (changedMs < 0) changedMs = sw.ElapsedMilliseconds;
                    changed.Set();
                }, p => deleted.Set()))
                {
                    w.SetPaths(new[] { f });
                    Thread.Sleep(100);
                    sw.Start();
                    File.WriteAllText(f, "2");
                    Check(changed.Wait(3000), "변경 알림");
                    Console.WriteLine("     변경 감지 " + changedMs + " ms");
                    Check(changedMs >= 0 && changedMs < 500, "0.5초 이내");
                    File.Delete(f);
                    Check(deleted.Wait(3000), "삭제 알림");
                }
            });
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static string RuntimeVersion()
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
    }
}
