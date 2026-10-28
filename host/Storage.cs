using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace MdViewer
{
    public sealed class BridgeException : Exception
    {
        public readonly string Code;

        public BridgeException(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    /// <summary>설정·세션·로그 위치와 저장 (SDD 5.3). 모든 파일은 BOM 없는 UTF-8.</summary>
    public static class Storage
    {
        public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        public static string ConfigDir;
        public static string LogDir;
        public static string WebViewDir;
        public static bool Portable;
        /// <summary>단일 인스턴스 Mutex·파이프 이름에 쓰는 키</summary>
        public static string InstanceKey;

        public static void Init()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string profile = Environment.GetEnvironmentVariable("MDVIEW_PROFILE_DIR");
            Portable = File.Exists(Path.Combine(exeDir, "portable.txt"));
            if (!string.IsNullOrEmpty(profile))
            {
                // 테스트 격리용: 모든 저장 위치를 한 폴더로 모은다.
                ConfigDir = Path.GetFullPath(profile);
                LogDir = Path.Combine(ConfigDir, "logs");
                WebViewDir = Path.Combine(ConfigDir, "WebView2");
            }
            else if (Portable)
            {
                ConfigDir = Path.Combine(exeDir, "data");
                LogDir = Path.Combine(ConfigDir, "logs");
                WebViewDir = Path.Combine(ConfigDir, "WebView2");
            }
            else
            {
                ConfigDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MdViewer");
                string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MdViewer");
                LogDir = Path.Combine(local, "logs");
                WebViewDir = Path.Combine(local, "WebView2");
            }
            Directory.CreateDirectory(ConfigDir);
            Directory.CreateDirectory(LogDir);
            string sid = WindowsIdentity.GetCurrent().User.Value;
            bool isolated = !string.IsNullOrEmpty(profile) || Portable;
            InstanceKey = isolated ? sid + "-" + ShortHash(ConfigDir.ToLowerInvariant()) : sid;
        }

        static string ShortHash(string s)
        {
            using (var sha = SHA256.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                return BitConverter.ToString(h, 0, 6).Replace("-", "");
            }
        }

        static string PathFor(string name)
        {
            if (name != "session" && name != "settings" && name != "window")
                throw new BridgeException("EINVAL", Strings.UnknownStoreName(name));
            return Path.Combine(ConfigDir, name + ".json");
        }

        public static string ReadText(string name)
        {
            string p = PathFor(name);
            try
            {
                return File.Exists(p) ? File.ReadAllText(p, Utf8) : null;
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogReadFailed(p, ex.Message));
                return null;
            }
        }

        /// <summary>임시 파일에 쓴 뒤 교체해, 쓰는 도중 강제 종료돼도 원본이 깨지지 않게 한다 (NFR-REL-02).</summary>
        public static void WriteText(string name, string text)
        {
            WriteAtomic(PathFor(name), text);
        }

        static readonly object WriteGate = new object();

        public static void WriteAtomic(string path, string text)
        {
            // 디바운스 저장과 종료 저장이 겹쳐도 같은 임시 파일을 동시에 쓰지 않게 한다.
            lock (WriteGate) WriteAtomicLocked(path, text);
        }

        static void WriteAtomicLocked(string path, string text)
        {
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, text, Utf8);
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    if (File.Exists(path)) File.Replace(tmp, path, null, true);
                    else File.Move(tmp, path);
                    return;
                }
                catch (IOException)
                {
                    if (attempt >= 5) throw;
                    Thread.Sleep(40);
                }
                catch (UnauthorizedAccessException)
                {
                    if (attempt >= 5) throw;
                    Thread.Sleep(40);
                }
            }
        }
    }

    /// <summary>시작 단계 계측. MDVIEW_TRACE=1일 때만 프로세스 시작 기준 경과 시간을 로그에 남긴다.</summary>
    public static class Trace
    {
        static readonly bool Enabled = Environment.GetEnvironmentVariable("MDVIEW_TRACE") == "1";
        static readonly DateTime Start = System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime();

        public static void Mark(string name)
        {
            if (Enabled) Log.Write("trace", name + " " + (int)(DateTime.UtcNow - Start).TotalMilliseconds);
        }

        /// <summary>화면이 잰 시각(Unix epoch ms)으로 기록한다. 메시지 전달 지연을 빼기 위해서다.</summary>
        public static void MarkAt(string name, double epochMs)
        {
            if (!Enabled) return;
            var at = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(epochMs);
            Log.Write("trace", name + " " + (int)(at - Start).TotalMilliseconds);
        }
    }

    /// <summary>오류 로그 (NFR-REL-03). 1 MB에서 순환하고 3개를 남긴다.</summary>
    public static class Log
    {
        static readonly object Gate = new object();
        const long MaxBytes = 1024 * 1024;
        const int Keep = 3;

        public static void Error(string msg) { Write("error", msg); }
        public static void Info(string msg) { Write("info", msg); }

        public static void Write(string level, string msg)
        {
            lock (Gate)
            {
                try
                {
                    if (Storage.LogDir == null) return;
                    string p = Path.Combine(Storage.LogDir, "mdview.log");
                    Rotate(p);
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + msg + Environment.NewLine;
                    File.AppendAllText(p, line, Storage.Utf8);
                }
                catch (Exception)
                {
                    // 로그 실패로 앱을 멈추지 않는다.
                }
            }
        }

        static string Numbered(string p, int i)
        {
            return Path.Combine(Path.GetDirectoryName(p), "mdview." + i + ".log");
        }

        static void Rotate(string p)
        {
            var fi = new FileInfo(p);
            if (!fi.Exists || fi.Length < MaxBytes) return;
            string oldest = Numbered(p, Keep - 1);
            if (File.Exists(oldest)) File.Delete(oldest);
            for (int i = Keep - 2; i >= 1; i--)
            {
                if (File.Exists(Numbered(p, i))) File.Move(Numbered(p, i), Numbered(p, i + 1));
            }
            File.Move(p, Numbered(p, 1));
        }
    }
}
