using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace MdViewer
{
    /// <summary>
    /// 화면 파일(web\) 응답 (SDD 3장). 폴더 매핑(SetVirtualHostNameToFolderMapping)은 시작 직후 하위 리소스 응답이
    /// 수백 ms씩 묶여 늦어져서, 시작하자마자 WebView2 준비와 병렬로 메모리에 읽어 두고 직접 응답한다 (NFR-PERF-01).
    /// </summary>
    public static class AppResources
    {
        static Task<Dictionary<string, byte[]>> loading;
        static readonly Dictionary<string, string> Mimes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" },
            { ".css", "text/css; charset=utf-8" }, { ".svg", "image/svg+xml" }, { ".png", "image/png" },
            { ".ico", "image/x-icon" }, { ".woff2", "font/woff2" }, { ".json", "application/json" },
        };

        public static void Preload(string root)
        {
            loading = Task.Run(() =>
            {
                var files = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
                foreach (var f in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
                {
                    string rel = f.Substring(root.Length).TrimStart('\\').Replace('\\', '/');
                    files[rel] = File.ReadAllBytes(f);
                }
                return files;
            });
        }

        /// <summary>요청 경로(예: "app.js")의 내용과 MIME. 없으면 false.</summary>
        public static bool TryGet(string rel, out byte[] data, out string mime)
        {
            data = null;
            mime = null;
            if (loading == null) return false;
            Dictionary<string, byte[]> files;
            try
            {
                files = loading.Result;
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogWebFilesFailed(ex.GetBaseException().Message));
                return false;
            }
            if (rel == "") rel = "index.html";
            if (!files.TryGetValue(rel, out data)) return false;
            if (!Mimes.TryGetValue(Path.GetExtension(rel), out mime)) mime = "application/octet-stream";
            return true;
        }
    }
}
