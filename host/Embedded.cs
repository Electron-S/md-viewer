using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using Microsoft.Web.WebView2.Core;

namespace MdViewer
{
    /// <summary>
    /// EXE 하나로 배포하려고 넣어 둔 파일들. 빌드가 viewer.html과 WebView2 SDK DLL 세 개를 리소스로 넣는다.
    /// 관리 DLL(Core·WinForms)은 메모리에서 바로 읽고, 네이티브 로더(WebView2Loader.dll)만 사용자 폴더에 풀어 쓴다.
    /// </summary>
    public static class Embedded
    {
        static readonly Assembly Self = typeof(Embedded).Assembly;

        /// <summary>네이티브 로더를 푸는 폴더. 버전마다 따로 두어 다른 버전의 EXE와 섞이지 않게 한다.</summary>
        public static string LoaderDir
        {
            get
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(local, "MdViewer", "bin", BuildInfo.Version + "-" + BuildInfo.WebView2Version);
            }
        }

        public static byte[] Read(string name)
        {
            using (var s = Self.GetManifestResourceStream(name))
            {
                if (s == null) return null;
                var ms = new MemoryStream((int)s.Length);
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }

        /// <summary>WebView2 관리 DLL을 리소스에서 찾게 한다. WebView2 형식을 쓰는 메서드보다 먼저 불러야 한다.</summary>
        public static void InstallResolver()
        {
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
            {
                string name = new AssemblyName(e.Name).Name;
                if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
                byte[] data = Read(name + ".dll");
                return data == null ? null : Assembly.Load(data);
            };
        }

        static bool loaderSet;

        /// <summary>네이티브 로더를 풀고 WebView2가 그 폴더에서 찾게 한다. WebView2의 다른 API보다 먼저, 한 번만 부를 수 있다.</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static void PrepareLoader()
        {
            if (loaderSet) return;
            string dir = ExtractLoader();
            if (dir == null) return;
            CoreWebView2Environment.SetLoaderDllFolderPath(dir);
            loaderSet = true;
        }

        /// <summary>WebView2Loader.dll을 LoaderDir에 푼다. 이미 같은 크기로 있으면 그대로 둔다. 리소스가 없으면 null.</summary>
        public static string ExtractLoader()
        {
            string dir = LoaderDir;
            string path = Path.Combine(dir, "WebView2Loader.dll");
            byte[] data = Read("WebView2Loader.dll");
            if (data == null) return null;
            var fi = new FileInfo(path);
            if (!fi.Exists || fi.Length != data.LongLength)
            {
                Directory.CreateDirectory(dir);
                // 다른 인스턴스가 같은 파일을 동시에 풀 수 있으므로 임시 이름에 쓰고 옮긴다. 이미 있으면 그 파일을 쓴다.
                string tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllBytes(tmp, data);
                try
                {
                    if (File.Exists(path)) File.Delete(path);
                    File.Move(tmp, path);
                }
                catch (IOException)
                {
                    File.Delete(tmp);
                }
                catch (UnauthorizedAccessException)
                {
                    File.Delete(tmp);
                }
            }
            return dir;
        }
    }
}
