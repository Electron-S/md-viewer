using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace MdViewer.Tests
{
    /// <summary>호스트 단위 테스트 (SDD 9.3). 결과는 UTF-8로 출력하고, 실패가 있으면 종료 코드 1.</summary>
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
            tmp = Path.Combine(Path.GetTempPath(), "mdview-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tmp);
            Environment.SetEnvironmentVariable("MDVIEW_PROFILE_DIR", Path.Combine(tmp, "profile"));
            Storage.Init();

            Test("인코딩 판별: UTF-8, BOM, UTF-16, CP949 (NFR-ENC-01)", () =>
            {
                const string s = "한글 문서입니다 abc ✓";
                var r = EncodingDetector.Detect(new UTF8Encoding(false).GetBytes(s));
                Eq(r.Encoding, "utf-8", "utf-8");
                Eq(r.Text, s, "utf-8 text");
                Check(!r.HasBom && !r.Warning, "utf-8 bom/warn");

                r = EncodingDetector.Detect(new UTF8Encoding(true).GetPreamble().Concat(Encoding.UTF8.GetBytes(s)).ToArray());
                Check(r.Encoding == "utf-8" && r.HasBom && r.Text == s, "utf-8 bom");

                r = EncodingDetector.Detect(Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes(s)).ToArray());
                Check(r.Encoding == "utf-16le" && r.HasBom && r.Text == s, "utf-16le");

                r = EncodingDetector.Detect(Encoding.BigEndianUnicode.GetPreamble().Concat(Encoding.BigEndianUnicode.GetBytes(s)).ToArray());
                Check(r.Encoding == "utf-16be" && r.HasBom && r.Text == s, "utf-16be");

                const string k = "한글 문서입니다. 가나다라 똠방각하";
                r = EncodingDetector.Detect(Encoding.GetEncoding(949).GetBytes(k));
                Eq(r.Encoding, "cp949", "cp949");
                Eq(r.Text, k, "cp949 text");

                r = EncodingDetector.Detect(Encoding.ASCII.GetBytes("# plain ascii\n"));
                Eq(r.Encoding, "utf-8", "ascii는 utf-8");
            });

            Test("깨진 바이트·바이너리에서 멈추지 않는다 (NFR-ENC-02, NFR-REL-01)", () =>
            {
                var r = EncodingDetector.Detect(new byte[] { 0x41, 0x80, 0x42, 0xFF });
                Check(r.Warning, "경고 켜짐");
                Check(r.Text.Contains('\uFFFD'), "대체 문자");
                r = EncodingDetector.Detect(Encoding.GetEncoding(1252).GetBytes("café au lait"));
                Check(r.Warning && r.Encoding == "utf-8", "Windows-1252는 CP949로 오판하지 않는다");
                r = EncodingDetector.Detect(new byte[] { 0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x10 });
                Check(r.Binary, "NUL이 있으면 바이너리");
                r = EncodingDetector.Detect(new byte[0]);
                Check(r.Text == "" && r.Encoding == "utf-8" && !r.Binary, "빈 파일");
                r = EncodingDetector.DecodeAs(new byte[] { 0xFF, 0xFE, 0x41 }, "utf-16le");
                Check(r.Warning && r.HasBom, "홀수 바이트 UTF-16");
                r = EncodingDetector.DecodeAs(Encoding.UTF8.GetBytes("한글"), "cp949");
                Eq(r.Encoding, "cp949", "수동 지정은 그대로 따른다");
                Eq(Code(() => EncodingDetector.DecodeAs(new byte[0], "euc-jp")), "EINVAL", "모르는 인코딩");
            });

            Test("줄 끝 판별", () =>
            {
                Eq(EncodingDetector.DetectEol("a\r\nb\r\n"), "CRLF", "crlf");
                Eq(EncodingDetector.DetectEol("a\nb"), "LF", "lf");
                Eq(EncodingDetector.DetectEol("a\rb"), "CR", "cr");
                Eq(EncodingDetector.DetectEol("a\r\nb\n"), "Mixed", "mixed");
                Eq(EncodingDetector.DetectEol("ab"), "None", "none");
            });

            Test("경로: 절대 경로만, 정규화", () =>
            {
                Eq(Code(() => FileService.Normalize("foo.md")), "EINVAL", "상대 경로");
                Eq(Code(() => FileService.Normalize(@"\foo.md")), "EINVAL", "드라이브 상대");
                Eq(Code(() => FileService.Normalize("")), "EINVAL", "빈 경로");
                Eq(FileService.Normalize(@"C:/x/../y/./z.md"), @"C:\y\z.md", "정규화");
                Eq(FileService.Normalize(@"\\wsl.localhost\Ubuntu\home\a.md"), @"\\wsl.localhost\Ubuntu\home\a.md", "UNC");
            });

            Test("파일 읽기: 한글 이름, 종류, 오류 코드 (FR-FILE-01, FR-FILE-08)", () =>
            {
                string dir = Path.Combine(tmp, "문서 폴더");
                Directory.CreateDirectory(dir);
                string md = Path.Combine(dir, "한글 문서.md");
                File.WriteAllText(md, "# 제목\r\n본문\r\n", new UTF8Encoding(true));
                var d = FileService.Read(md, null);
                Eq(d["text"], "# 제목\r\n본문\r\n", "text");
                Eq(d["kind"], "markdown", "kind");
                Eq(d["eol"], "CRLF", "eol");
                Eq(d["hasBom"], true, "bom");
                Eq(d["binary"], false, "binary");
                string txt = Path.Combine(dir, "메모.txt");
                File.WriteAllBytes(txt, Encoding.GetEncoding(949).GetBytes("메모\n"));
                d = FileService.Read(txt, null);
                Check((string)d["kind"] == "text" && (string)d["encoding"] == "cp949", "txt cp949");
                d = FileService.Read(txt, "utf-8");
                Eq(d["decodeWarning"], true, "강제 utf-8은 경고");
                Eq(Code(() => FileService.Read(dir, null)), "EISDIR", "폴더");
                Eq(Code(() => FileService.Read(Path.Combine(dir, "없음.md"), null)), "ENOENT", "없는 파일");
            });

            Test("네트워크 공유: 사용자가 연 공유의 이미지만 응답 (SDD 8.4)", () =>
            {
                Eq(FileService.ShareRoot(@"\\nas\docs\a\b.png"), @"\\nas\docs", "공유 루트");
                Eq(FileService.ShareRoot(@"C:\a.png"), null, "로컬");
                Check(FileService.ImageAllowed(@"C:\x\a.png"), "로컬 이미지는 허용");
                Check(!FileService.ImageAllowed(@"\\evil\share\a.png"), "모르는 공유는 거부");
                FileService.TrustShare(@"\\nas\docs\guide\readme.md");
                Check(FileService.ImageAllowed(@"\\NAS\Docs\img\a.png"), "연 문서의 공유는 허용");
                Check(!FileService.ImageAllowed(@"\\nas\other\a.png"), "같은 서버라도 다른 공유는 거부");
            });

            Test("10 MB 파일 읽기 2초 이내 (NFR-PERF-03)", () =>
            {
                string big = Path.Combine(tmp, "big.md");
                var sb = new StringBuilder();
                while (sb.Length < 10 * 1024 * 1024) sb.Append("## 제목\n본문 줄입니다 lorem ipsum dolor sit amet.\n");
                File.WriteAllText(big, sb.ToString(), new UTF8Encoding(false));
                var sw = Stopwatch.StartNew();
                FileService.Read(big, null);
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

            try
            {
                Directory.Delete(tmp, true);
            }
            catch (Exception) { }
            Console.WriteLine("# pass " + passed);
            Console.WriteLine("# fail " + failed);
            return failed == 0 ? 0 : 1;
        }
    }
}
