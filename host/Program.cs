using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace MdViewer
{
    static class Program
    {
        public const string Version = "1.0.0";
        const string RuntimeDownload = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

        [STAThread]
        static int Main(string[] args)
        {
            bool newWindow = false;
            var paths = new List<string>();
            foreach (var a in args)
            {
                if (a == "--new-window")
                {
                    newWindow = true;
                    continue;
                }
                if (a.StartsWith("--")) continue;
                try
                {
                    paths.Add(Path.GetFullPath(a));
                }
                catch (Exception) { }
            }

            Storage.Init();
            Trace.Mark("main");
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
                runtime = CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogRuntimeCheckFailed(ex.Message));
            }
            if (string.IsNullOrEmpty(runtime))
            {
                var answer = MessageBox.Show(
                    Strings.WebView2Required,
                    "MD Viewer", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (answer == DialogResult.Yes) Process.Start(new ProcessStartInfo(RuntimeDownload) { UseShellExecute = true });
                return 1;
            }

            Trace.Mark("runtime-checked");
            AppResources.Preload(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web"));
            var form = new MainForm(paths.ToArray(), runtime);
            if (instance != null && instance.IsPrimary) instance.StartServer(form.OpenFromOtherInstance);
            Application.Run(form);
            if (instance != null) instance.Dispose();
            return 0;
        }
    }
}
