using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MdViewer.Setup
{
    /// <summary>
    /// 사용자 단위 설치 프로그램 (NFR-PORT-01, SRS 4.3). 관리자 권한 없이 %LOCALAPPDATA%\Programs\MdViewer 에 설치하고
    /// 시작 메뉴 바로 가기, 파일 연결(열기 목록), 탐색기 우클릭 메뉴를 HKCU에 등록한다.
    ///   setup.exe [/silent] [/dir:경로] [/noassoc] [/nocontext] [/noshortcut]
    ///   uninstall.exe /uninstall [/silent]
    /// 테스트용 환경 변수: MDVIEW_SETUP_REGROOT(기본 Software), MDVIEW_SETUP_SHORTCUT_DIR
    /// </summary>
    static class Setup
    {
        const string AppName = "MD Viewer";
        const string Version = "1.0.0";
        const string ProgId = "MdViewer.Markdown";
        const string ExeName = "mdview.exe";
        /// <summary>설치한 파일 목록. 제거는 이 목록에 있는 것만 지운다(설치 폴더에 다른 파일이 있어도 안전).</summary>
        const string ManifestName = "install.manifest";
        static readonly string[] FallbackFiles =
        {
            "mdview.exe", "mdview.exe.config", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll",
            "WebView2Loader.dll", "WebView2-LICENSE.txt", @"web\index.html", @"web\source.js",
        };
        static readonly string[] Extensions = { ".md", ".markdown", ".mdown", ".mkd" };

        static string RegRoot
        {
            get { return Environment.GetEnvironmentVariable("MDVIEW_SETUP_REGROOT") ?? "Software"; }
        }

        static string ClassesKey { get { return RegRoot + @"\Classes"; } }

        static string UninstallKey { get { return RegRoot + @"\Microsoft\Windows\CurrentVersion\Uninstall\MdViewer"; } }

        static string ShortcutPath
        {
            get
            {
                string dir = Environment.GetEnvironmentVariable("MDVIEW_SETUP_SHORTCUT_DIR")
                    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
                return Path.Combine(dir, AppName + ".lnk");
            }
        }

        static string DefaultDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "MdViewer"); }
        }

        [STAThread]
        static int Main(string[] args)
        {
            bool silent = args.Contains("/silent");
            string dir = DefaultDir;
            foreach (var a in args) if (a.StartsWith("/dir:")) dir = Path.GetFullPath(a.Substring(5));
            Application.EnableVisualStyles();
            try
            {
                if (args.Contains("/uninstall"))
                {
                    string installDir = Path.GetDirectoryName(Application.ExecutablePath);
                    if (!silent && MessageBox.Show(SetupStrings.ConfirmUninstall(AppName), AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 1;
                    Uninstall(installDir);
                    if (!silent) MessageBox.Show(SetupStrings.Uninstalled(AppName), AppName);
                    return 0;
                }
                var opts = new Options { Dir = dir, Assoc = !args.Contains("/noassoc"), Context = !args.Contains("/nocontext"), Shortcut = !args.Contains("/noshortcut") };
                if (silent)
                {
                    Install(opts);
                    return 0;
                }
                using (var form = new SetupForm(opts)) return form.ShowDialog() == DialogResult.OK ? 0 : 1;
            }
            catch (Exception ex)
            {
                if (!silent) MessageBox.Show(SetupStrings.InstallFailed(ex.Message), AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                else Console.Error.WriteLine(ex);
                return 2;
            }
        }

        public sealed class Options
        {
            public string Dir;
            public bool Assoc;
            public bool Context;
            public bool Shortcut;
        }

        public static void Install(Options o)
        {
            Directory.CreateDirectory(o.Dir);
            string exe = Path.Combine(o.Dir, ExeName);
            if (File.Exists(exe) && IsLocked(exe)) throw new IOException(SetupStrings.AppRunning);
            // 이전 버전이 설치한 파일만 지우고(업데이트 때 남는 파일 정리) 새 파일을 푼다.
            DeleteInstalledFiles(o.Dir, null);
            var installed = new List<string>();
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (var entry in zip.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    string target = Path.GetFullPath(Path.Combine(o.Dir, entry.FullName));
                    if (!target.StartsWith(Path.GetFullPath(o.Dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                    installed.Add(entry.FullName.Replace('/', '\\'));
                }
            }
            installed.Add("uninstall.exe");
            installed.Add(ManifestName);
            File.WriteAllLines(Path.Combine(o.Dir, ManifestName), installed, new System.Text.UTF8Encoding(false));
            string uninstaller = Path.Combine(o.Dir, "uninstall.exe");
            if (!string.Equals(Path.GetFullPath(Application.ExecutablePath), uninstaller, StringComparison.OrdinalIgnoreCase))
                File.Copy(Application.ExecutablePath, uninstaller, true);

            string cmd = "\"" + exe + "\" \"%1\"";
            using (var classes = Registry.CurrentUser.CreateSubKey(ClassesKey))
            {
                using (var k = classes.CreateSubKey(ProgId))
                {
                    k.SetValue("", SetupStrings.DocTypeName);
                    k.SetValue("FriendlyTypeName", SetupStrings.DocTypeName);
                    using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", "\"" + exe + "\",0");
                    using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", cmd);
                }
                using (var app = classes.CreateSubKey(@"Applications\" + ExeName))
                {
                    app.SetValue("FriendlyAppName", AppName);
                    using (var c = app.CreateSubKey(@"shell\open\command")) c.SetValue("", cmd);
                    using (var t = app.CreateSubKey("SupportedTypes")) foreach (var ext in Extensions) t.SetValue(ext, "");
                }
                foreach (var ext in Extensions)
                {
                    if (o.Assoc)
                    {
                        using (var k = classes.CreateSubKey(ext + @"\OpenWithProgids")) k.SetValue(ProgId, new byte[0], RegistryValueKind.None);
                    }
                    if (o.Context)
                    {
                        using (var k = classes.CreateSubKey(@"SystemFileAssociations\" + ext + @"\shell\MdViewer"))
                        {
                            k.SetValue("", SetupStrings.OpenWith(AppName));
                            k.SetValue("Icon", "\"" + exe + "\"");
                            using (var c = k.CreateSubKey("command")) c.SetValue("", cmd);
                        }
                    }
                }
            }
            using (var u = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                u.SetValue("DisplayName", AppName);
                u.SetValue("DisplayVersion", Version);
                u.SetValue("Publisher", AppName);
                u.SetValue("InstallLocation", o.Dir);
                u.SetValue("DisplayIcon", "\"" + exe + "\",0");
                u.SetValue("UninstallString", "\"" + uninstaller + "\" /uninstall");
                u.SetValue("QuietUninstallString", "\"" + uninstaller + "\" /uninstall /silent");
                u.SetValue("NoModify", 1, RegistryValueKind.DWord);
                u.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                long kb = new DirectoryInfo(o.Dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024;
                u.SetValue("EstimatedSize", (int)kb, RegistryValueKind.DWord);
            }
            if (o.Shortcut) CreateShortcut(ShortcutPath, exe);
            Notify();
        }

        public static void Uninstall(string installDir)
        {
            using (var classes = Registry.CurrentUser.OpenSubKey(ClassesKey, true))
            {
                if (classes != null)
                {
                    classes.DeleteSubKeyTree(ProgId, false);
                    classes.DeleteSubKeyTree(@"Applications\" + ExeName, false);
                    foreach (var ext in Extensions)
                    {
                        using (var k = classes.OpenSubKey(ext + @"\OpenWithProgids", true))
                        {
                            if (k != null) k.DeleteValue(ProgId, false);
                        }
                        classes.DeleteSubKeyTree(@"SystemFileAssociations\" + ext + @"\shell\MdViewer", false);
                    }
                }
            }
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            if (File.Exists(ShortcutPath)) File.Delete(ShortcutPath);
            Notify();

            string self = Path.GetFullPath(Application.ExecutablePath);
            DeleteInstalledFiles(installDir, self);
            // 실행 중인 uninstall.exe와 (비었다면) 설치 폴더는 끝난 뒤 지운다.
            if (string.Equals(Path.GetDirectoryName(self), installDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\" & rmdir \"" + installDir + "\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
            }
        }

        /// <summary>
        /// 설치 목록(install.manifest)에 있는 파일만 지우고, 그 때문에 빈 폴더가 되면 폴더도 지운다.
        /// 목록이 없으면 알려진 파일 이름만 지운다. keep은 지우지 않을 파일(실행 중인 uninstall.exe).
        /// </summary>
        static void DeleteInstalledFiles(string dir, string keep)
        {
            string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            string manifest = Path.Combine(dir, ManifestName);
            var names = File.Exists(manifest) ? File.ReadAllLines(manifest).Where(l => l.Trim().Length > 0).ToList() : FallbackFiles.ToList();
            if (keep == null) names.Remove("uninstall.exe");
            var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in names)
            {
                string f = Path.GetFullPath(Path.Combine(dir, name));
                if (!f.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                if (keep != null && string.Equals(f, keep, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    if (File.Exists(f)) File.Delete(f);
                }
                catch (Exception) { }
                for (string d = Path.GetDirectoryName(f); d != null && d.Length >= root.Length; d = Path.GetDirectoryName(d)) dirs.Add(d);
            }
            foreach (var d in dirs.OrderByDescending(x => x.Length))
            {
                try
                {
                    if (Directory.Exists(d) && !Directory.EnumerateFileSystemEntries(d).Any()) Directory.Delete(d);
                }
                catch (Exception) { }
            }
        }

        static bool IsLocked(string path)
        {
            try
            {
                using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) return false;
            }
            catch (IOException)
            {
                return true;
            }
        }

        static void CreateShortcut(string lnk, string target)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(lnk));
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(t);
            try
            {
                dynamic s = shell.CreateShortcut(lnk);
                s.TargetPath = target;
                s.WorkingDirectory = Path.GetDirectoryName(target);
                s.Description = SetupStrings.ShortcutDescription;
                s.Save();
                Marshal.ReleaseComObject(s);
            }
            finally
            {
                Marshal.ReleaseComObject(shell);
            }
        }

        [DllImport("shell32.dll")]
        static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

        static void Notify()
        {
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        }

        public static bool WebView2Installed()
        {
            foreach (var path in new[]
            {
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            })
            {
                foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
                {
                    using (var k = hive.OpenSubKey(path))
                    {
                        var v = k == null ? null : k.GetValue("pv") as string;
                        if (!string.IsNullOrEmpty(v) && v != "0.0.0.0") return true;
                    }
                }
            }
            return false;
        }
    }

    sealed class SetupForm : Form
    {
        readonly Setup.Options opts;
        readonly CheckBox assoc;
        readonly CheckBox context;
        readonly CheckBox shortcut;
        readonly Button install;
        readonly Label status;

        public SetupForm(Setup.Options opts)
        {
            this.opts = opts;
            Text = SetupStrings.FormTitle;
            Font = new Font("Segoe UI", 9.5f);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(460, 250);
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception) { }

            var title = new Label { Text = "MD Viewer 1.0.0", Font = new Font("Segoe UI", 13f, FontStyle.Bold), AutoSize = true, Location = new Point(20, 16) };
            var where = new Label { Text = SetupStrings.InstallDir(opts.Dir), AutoSize = false, Location = new Point(22, 52), Size = new Size(420, 36) };
            assoc = new CheckBox { Text = SetupStrings.AssocOption, Checked = opts.Assoc, AutoSize = true, Location = new Point(22, 92) };
            context = new CheckBox { Text = SetupStrings.ContextOption, Checked = opts.Context, AutoSize = true, Location = new Point(22, 118) };
            shortcut = new CheckBox { Text = SetupStrings.ShortcutOption, Checked = opts.Shortcut, AutoSize = true, Location = new Point(22, 144) };
            status = new Label { AutoSize = false, Location = new Point(22, 176), Size = new Size(420, 22), ForeColor = Color.DimGray };
            if (!Setup.WebView2Installed()) status.Text = SetupStrings.WebView2Missing;
            install = new Button { Text = SetupStrings.Install, Location = new Point(270, 208), Size = new Size(84, 30) };
            var cancel = new Button { Text = SetupStrings.Cancel, Location = new Point(360, 208), Size = new Size(84, 30), DialogResult = DialogResult.Cancel };
            install.Click += (s, e) => DoInstall();
            AcceptButton = install;
            CancelButton = cancel;
            Controls.AddRange(new Control[] { title, where, assoc, context, shortcut, status, install, cancel });
        }

        void DoInstall()
        {
            opts.Assoc = assoc.Checked;
            opts.Context = context.Checked;
            opts.Shortcut = shortcut.Checked;
            install.Enabled = false;
            status.Text = SetupStrings.Installing;
            Refresh();
            try
            {
                Setup.Install(opts);
            }
            catch (Exception ex)
            {
                status.Text = "";
                install.Enabled = true;
                MessageBox.Show(this, ex.Message, SetupStrings.FormTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (MessageBox.Show(this, SetupStrings.InstallDoneRunNow, SetupStrings.FormTitle, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                Process.Start(Path.Combine(opts.Dir, "mdview.exe"));
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}
