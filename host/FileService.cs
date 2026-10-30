using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace MdViewer
{
    /// <summary>파일 읽기·폴더 목록·문서 그림 (SDD 4장 파일 서비스).</summary>
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

        /// <summary>쓸 수 있는 문서 확장자인지 (NFR-SEC-05)</summary>
        public static bool IsDocument(string path) { return IsMarkdown(path) || IsText(path); }

        /// <summary>
        /// 쓰기 허용 집합 (NFR-SEC-05). 이 앱은 읽기에 허용 폴더가 없으므로, 쓰기는 화면에 /api/read로 내준 문서와
        /// 저장 대화상자로 사용자가 고른 경로로 좁힌다.
        /// </summary>
        static readonly HashSet<string> Writable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static void AllowWrite(string path)
        {
            lock (Writable) Writable.Add(path);
        }

        static bool CanWrite(string path)
        {
            lock (Writable) return Writable.Contains(path);
        }

        /// <summary>
        /// 문서를 원자적으로 쓴다 (FR-EDIT-04, NFR-SEC-05). 같은 폴더의 임시 파일에 쓰고 File.Replace로 바꿔 넣어 원본의 권한·속성을 지킨다.
        /// baseMtime·baseSize가 있으면 디스크가 읽은 뒤 바뀌었는지 먼저 본다(ECONFLICT). 수정 시각·크기를 돌려준다.
        /// </summary>
        public static Dictionary<string, object> WriteBytes(string path, byte[] data, double? baseMtime, long? baseSize, bool create, bool overwrite)
        {
            path = Normalize(path);
            if (!IsDocument(path)) throw new BridgeException("EACCES", Strings.NotDocument);
            if (!CanWrite(path)) throw new BridgeException("EACCES", Strings.WriteNotAllowed);
            if (data.LongLength > MaxFileBytes) throw new BridgeException("ETOOBIG", Strings.FileTooBig);
            if (Directory.Exists(path)) throw new BridgeException("EISDIR", Strings.IsFolder);
            var fi = new FileInfo(path);
            bool exists = fi.Exists;
            if (!exists && !create) throw new BridgeException("ENOENT", Strings.FileNotFound);
            if (exists && create && !overwrite) throw new BridgeException("EEXIST", Strings.FileExists);
            if (exists && baseMtime.HasValue)
            {
                double mt = Math.Round((fi.LastWriteTimeUtc - Epoch).TotalMilliseconds);
                if (mt != Math.Round(baseMtime.Value) || (baseSize.HasValue && fi.Length != baseSize.Value))
                    throw new BridgeException("ECONFLICT", Strings.ChangedOnDisk);
            }
            string dir = Path.GetDirectoryName(path);
            if (dir == null || !Directory.Exists(dir)) throw new BridgeException("ENOENT", Strings.FolderNotFound);
            string tmp = Path.Combine(dir, "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N").Substring(0, 8) + ".tmp");
            try
            {
                using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536))
                {
                    fs.Write(data, 0, data.Length);
                    fs.Flush(true);
                }
                ReplaceWithRetry(tmp, path);
            }
            catch (UnauthorizedAccessException)
            {
                TryDelete(tmp);
                throw new BridgeException("EACCES", Strings.AccessDenied);
            }
            catch (Exception)
            {
                TryDelete(tmp);
                throw;
            }
            fi.Refresh();
            var d = new Dictionary<string, object>();
            d["mtime"] = Math.Round((fi.LastWriteTimeUtc - Epoch).TotalMilliseconds);
            d["size"] = fi.Length;
            return d;
        }

        /// <summary>
        /// 임시 파일을 원본 자리에 바꿔 넣는다. 백신·인덱서가 잠깐 잡은 파일은 몇 번 다시 시도한다.
        /// File.Replace를 지원하지 않는 위치(WSL·일부 네트워크 공유)는 내용을 복사해 바꾼다.
        /// </summary>
        static void ReplaceWithRetry(string tmp, string path)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    if (!File.Exists(path)) File.Move(tmp, path);
                    else File.Replace(tmp, path, null, true);
                    return;
                }
                catch (IOException)
                {
                    if (attempt < 5)
                    {
                        Thread.Sleep(50);
                        continue;
                    }
                    if (!File.Exists(path)) throw;
                    File.Copy(tmp, path, true);
                    File.Delete(tmp);
                    return;
                }
            }
        }

        static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception) { }
        }

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

        /// <summary>문서 바이트와 수정 시각(Unix epoch ms). 인코딩 판별은 화면이 한다 (실행기와 같은 방식).</summary>
        public static byte[] ReadBytes(string path, out double mtime)
        {
            path = Normalize(path);
            TrustShare(path);
            if (Directory.Exists(path)) throw new BridgeException("EISDIR", Strings.IsFolder);
            var fi = new FileInfo(path);
            if (!fi.Exists) throw new BridgeException("ENOENT", Strings.FileNotFound);
            if (fi.Length > MaxFileBytes) throw new BridgeException("ETOOBIG", Strings.FileTooBig);
            byte[] bytes = ReadAllBytesShared(path);
            fi.Refresh();
            mtime = (fi.LastWriteTimeUtc - Epoch).TotalMilliseconds;
            // 화면에 내준 문서는 고쳐 저장할 수 있다 (NFR-SEC-05).
            if (IsDocument(path)) AllowWrite(path);
            return bytes;
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
