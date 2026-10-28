using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace MdViewer
{
    static class Program
    {
        const string RuntimeDownload = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

        [STAThread]
        static int Main(string[] args)
        {
            // 설정 파일(.exe.config) 없이 EXE 하나로 내므로 긴 경로 지원을 여기서 켠다. 경로 API를 쓰기 전이어야 한다.
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            // WebView2 DLL은 EXE 안에 있다. 그 형식을 쓰는 Run보다 먼저 찾는 법을 알려 둔다.
            Embedded.InstallResolver();
            return Run(args);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static int Run(string[] args)
        {
            bool newWindow = false;
            bool? register = null;
            var paths = new List<string>();
            foreach (var a in args)
            {
                if (a == "--new-window") newWindow = true;
                else if (a == "--register") register = true;
                else if (a == "--unregister") register = false;
                else if (a.StartsWith("--")) continue;
                else
                {
                    try
                    {
                        paths.Add(Path.GetFullPath(a));
                    }
                    catch (Exception) { }
                }
            }

            Storage.Init();
            Trace.Mark("main");
            // 탐색기 연결 프로그램 등록만 하고 끝낸다(창을 띄우지 않는다). 성공하면 0.
            if (register.HasValue)
            {
                try
                {
                    if (register.Value) OpenWith.Register(Application.ExecutablePath);
                    else OpenWith.Unregister(Application.ExecutablePath);
                    return 0;
                }
                catch (Exception ex)
                {
                    Log.Error(Strings.LogRegisterFailed(ex.Message));
                    return 1;
                }
            }

            SingleInstance instance = null;
            if (!newWindow)
            {
                instance = new SingleInstance();
                // 첫 인스턴스에 넘기는 데 실패하면 새 창으로 띄운다.
                if (!instance.IsPrimary && instance.SendToPrimary(paths)) return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += (s, e) => Log.Error(Strings.LogUiException(e.Exception));
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Error(Strings.LogUnhandledException(e.ExceptionObject));

            string runtime = null;
            try
            {
                Embedded.PrepareLoader();
                runtime = CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogRuntimeCheckFailed(ex.Message));
            }
            if (string.IsNullOrEmpty(runtime))
            {
                var answer = MessageBox.Show(Strings.WebView2Required, Strings.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (answer == DialogResult.Yes) Process.Start(new ProcessStartInfo(RuntimeDownload) { UseShellExecute = true });
                return 1;
            }

            Trace.Mark("runtime-checked");
            var form = new MainForm(paths.ToArray());
            if (instance != null && instance.IsPrimary) instance.StartServer(form.OpenFromOtherInstance);
            Application.Run(form);
            if (instance != null) instance.Dispose();
            return 0;
        }
    }
}
