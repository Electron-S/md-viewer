using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace MdViewer
{
    /// <summary>파일 읽기·폴더 목록·문서 이미지 (SDD 4장 파일 서비스).</summary>
    public static class FileService
    {
        public const long MaxFileBytes = 200L * 1024 * 1024;
        const long MaxImageBytes = 50L * 1024 * 1024;
        const int MaxDirEntries = 5000;
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        static readonly HashSet<string> MarkdownExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdwn", ".mdtxt", ".mdtext",
        };
        static readonly HashSet<string> SkipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "node_modules", "__pycache__",
        };
        static readonly Dictionary<string, string> ImageMimes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".png", "image/png" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".gif", "image/gif" },
            { ".webp", "image/webp" }, { ".svg", "image/svg+xml" }, { ".bmp", "image/bmp" }, { ".ico", "image/x-icon" },
            { ".avif", "image/avif" },
        };
        static readonly Regex AbsolutePath = new Regex(@"^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/])");
        /// <summary>사용자가 연 문서·폴더가 있는 네트워크 공유. 문서 이미지는 이 공유에서만 읽는다 (SDD 8.4).</summary>
        static readonly HashSet<string> TrustedShares = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        /// <summary>\\server\share 형태의 공유 루트. 로컬 경로면 null.</summary>
        public static string ShareRoot(string path)
        {
            if (path == null || !path.StartsWith(@"\\")) return null;
            var parts = path.Substring(2).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            return parts.Length < 2 ? null : @"\\" + parts[0] + @"\" + parts[1];
        }

        public static void TrustShare(string path)
        {
            string root = ShareRoot(path);
            if (root == null) return;
            lock (TrustedShares) TrustedShares.Add(root);
        }

        /// <summary>문서 이미지로 읽어도 되는 경로인지. 로컬은 항상, 네트워크는 사용자가 연 공유만.</summary>
        public static bool ImageAllowed(string path)
        {
            string root = ShareRoot(path);
            if (root == null) return true;
            lock (TrustedShares) return TrustedShares.Contains(root);
        }

        public static bool IsMarkdown(string path) { return MarkdownExt.Contains(Path.GetExtension(path)); }

        public static bool IsText(string path) { return string.Equals(Path.GetExtension(path), ".txt", StringComparison.OrdinalIgnoreCase); }

        /// <summary>절대 경로만 받는다. 드라이브 상대(`\x`, `C:x`)는 거부한다.</summary>
        public static string Normalize(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new BridgeException("EINVAL", Strings.NoPath);
            if (!AbsolutePath.IsMatch(path)) throw new BridgeException("EINVAL", Strings.NotAbsolutePath(path));
            try
            {
                return Path.GetFullPath(path);
            }
            catch (Exception ex)
            {
                throw new BridgeException("EINVAL", Strings.InvalidPath(ex.Message));
            }
        }

        public static Dictionary<string, object> Read(string path, string encoding)
        {
            path = Normalize(path);
            TrustShare(path);
            if (Directory.Exists(path)) throw new BridgeException("EISDIR", Strings.IsFolder);
            var fi = new FileInfo(path);
            if (!fi.Exists) throw new BridgeException("ENOENT", Strings.FileNotFound);
            if (fi.Length > MaxFileBytes) throw new BridgeException("ETOOBIG", Strings.FileTooBig);
            byte[] bytes = ReadAllBytesShared(path);
            DecodeResult r = string.IsNullOrEmpty(encoding) ? EncodingDetector.Detect(bytes) : EncodingDetector.DecodeAs(bytes, encoding);
            fi.Refresh();
            var d = new Dictionary<string, object>();
            d["path"] = path;
            d["text"] = r.Binary ? "" : r.Text;
            d["encoding"] = r.Encoding;
            d["hasBom"] = r.HasBom;
            d["eol"] = r.Binary ? "None" : EncodingDetector.DetectEol(r.Text);
            d["size"] = bytes.LongLength;
            d["mtime"] = (fi.LastWriteTimeUtc - Epoch).TotalMilliseconds;
            d["decodeWarning"] = r.Warning;
            d["kind"] = IsMarkdown(path) ? "markdown" : "text";
            d["binary"] = r.Binary;
            return d;
        }

        /// <summary>다른 프로그램이 쓰는 중이어도 읽는다. 공유 위반은 잠깐 기다렸다 다시 시도한다.</summary>
        public static byte[] ReadAllBytesShared(string path)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.SequentialScan))
                    {
                        var ms = new MemoryStream(fs.CanSeek ? (int)Math.Min(fs.Length, int.MaxValue) : 65536);
                        fs.CopyTo(ms);
                        return ms.ToArray();
                    }
                }
                catch (FileNotFoundException)
                {
                    throw new BridgeException("ENOENT", Strings.FileNotFound);
                }
                catch (DirectoryNotFoundException)
                {
                    throw new BridgeException("ENOENT", Strings.FileNotFound);
                }
                catch (UnauthorizedAccessException)
                {
                    throw new BridgeException("EACCES", Strings.AccessDenied);
                }
                catch (IOException)
                {
                    if (attempt >= 3) throw;
                    Thread.Sleep(60);
                }
            }
        }

        /// <summary>작업 공간 트리용 목록 (FR-NAV-02). 폴더 먼저, 이름순. 숨김·.으로 시작·node_modules 제외.</summary>
        public static List<object> ListDir(string path)
        {
            path = Normalize(path);
            TrustShare(path);
            if (!Directory.Exists(path)) throw new BridgeException("ENOENT", Strings.FolderNotFound);
            var di = new DirectoryInfo(path);
            var dirs = new List<string>();
            var files = new List<string>();
            try
            {
                foreach (var d in di.EnumerateDirectories())
                {
                    if (Hidden(d) || d.Name.StartsWith(".") || SkipDirs.Contains(d.Name)) continue;
                    dirs.Add(d.Name);
                    if (dirs.Count >= MaxDirEntries) break;
                }
                foreach (var f in di.EnumerateFiles())
                {
                    if (Hidden(f) || !(IsMarkdown(f.Name) || IsText(f.Name))) continue;
                    files.Add(f.Name);
                    if (files.Count >= MaxDirEntries) break;
                }
            }
            catch (UnauthorizedAccessException)
            {
                throw new BridgeException("EACCES", Strings.AccessDenied);
            }
            var list = new List<object>();
            foreach (var n in dirs.OrderBy(x => x, StringComparer.CurrentCultureIgnoreCase)) list.Add(Entry(n, true));
            foreach (var n in files.OrderBy(x => x, StringComparer.CurrentCultureIgnoreCase)) list.Add(Entry(n, false));
            return list;
        }

        static bool Hidden(FileSystemInfo i)
        {
            try
            {
                return (i.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        static Dictionary<string, object> Entry(string name, bool isDir)
        {
            var d = new Dictionary<string, object>();
            d["name"] = name;
            d["isDir"] = isDir;
            return d;
        }

        /// <summary>경로 목록을 화면에 넘길 {path, isDir} 목록으로 바꾼다.</summary>
        public static List<object> Entries(IEnumerable<string> paths)
        {
            var list = new List<object>();
            foreach (var p in paths)
            {
                string full;
                try
                {
                    full = Normalize(p);
                }
                catch (BridgeException)
                {
                    continue;
                }
                var d = new Dictionary<string, object>();
                d["path"] = full;
                d["isDir"] = Directory.Exists(full);
                list.Add(d);
            }
            return list;
        }

        /// <summary>문서 이미지 MIME. 이미지가 아니면 null (SDD 8.4).</summary>
        public static string ImageMime(string path)
        {
            string mime;
            return ImageMimes.TryGetValue(Path.GetExtension(path), out mime) ? mime : null;
        }

        public static byte[] ReadImage(string path)
        {
            var fi = new FileInfo(path);
            if (!fi.Exists || fi.Length > MaxImageBytes) return null;
            return ReadAllBytesShared(path);
        }
    }
}
