using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace MdViewer
{
    /// <summary>메인 창 (SDD 4장). WebView2를 띄우고 탐색·리소스·창 상태를 관리한다.</summary>
    public sealed class MainForm : Form
    {
        const string AppUrl = "https://app.mdview/index.html";
        const string AppPrefix = "https://app.mdview/";
        const string FilePrefix = "https://file.mdview/";
        static readonly HashSet<string> AllowedContextItems = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "copy", "selectAll", "copyLinkLocation", "copyImage", "copyImageLocation",
        };

        readonly WebView2 web;
        readonly Bridge bridge;
        public readonly WatchService Watch;
        readonly string webview2Version;
        readonly List<string> pendingArgs;
        readonly object argsGate = new object();
        /// <summary>첫 화면용 데이터(설정·세션·첫 문서). 시작하자마자 WebView2 준비와 병렬로 만든다.</summary>
        readonly Task<string> bootTask;
        readonly List<string> bootArgs;
        bool bootServed;
        const long BootDocMaxBytes = 2 * 1024 * 1024;
        bool frontendReady;
        bool quitConfirmed;
        bool closingRequested;
        Rectangle normalBounds;
        CoreWebView2Environment env;
        /// <summary>창을 띄우기 전에 시작해 둔 WebView2 환경 생성 (NFR-PERF-01)</summary>
        readonly Task<CoreWebView2Environment> envTask;

        public MainForm(string[] startPaths, string webview2Version)
        {
            this.webview2Version = webview2Version;
            pendingArgs = new List<string>(startPaths);
            bootArgs = new List<string>(startPaths);
            bootTask = Task.Run(() => BuildBootJson(bootArgs));
            envTask = CoreWebView2Environment.CreateAsync(null, Storage.WebViewDir, new CoreWebView2EnvironmentOptions());
            Text = "MD Viewer";
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception) { }
            MinimumSize = new Size(480, 320);
            StartPosition = FormStartPosition.Manual;
            RestoreWindow();
            bool dark = InitialDark();
            BackColor = dark ? Color.FromArgb(30, 31, 34) : Color.White;

            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            bridge = new Bridge(this);
            Watch = new WatchService(
                p => bridge.Emit("file.changed", PathPayload(p)),
                p => bridge.Emit("file.deleted", PathPayload(p)));

            HandleCreated += (s, e) => SetDark(dark);
            Load += async (s, e) => await InitWebView();
            FormClosing += OnFormClosing;
            Resize += (s, e) => TrackBounds();
            Move += (s, e) => TrackBounds();
        }

        static Dictionary<string, object> PathPayload(string p)
        {
            var d = new Dictionary<string, object>();
            d["path"] = p;
            return d;
        }

        // ------------------------------------------------------------ WebView2

        async Task InitWebView()
        {
            try
            {
                Trace.Mark("load");
                env = await envTask;
                Trace.Mark("env");
                await web.EnsureCoreWebView2Async(env);
                Trace.Mark("controller");
                var core = web.CoreWebView2;
                var st = core.Settings;
                st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("MDVIEW_DEVTOOLS") == "1";
                st.AreHostObjectsAllowed = false;
                st.IsStatusBarEnabled = false;
                st.IsZoomControlEnabled = false;
                st.AreBrowserAcceleratorKeysEnabled = false;
                st.IsGeneralAutofillEnabled = false;
                st.IsPasswordAutosaveEnabled = false;
                st.IsSwipeNavigationEnabled = false;
                st.AreDefaultScriptDialogsEnabled = true;

                core.AddWebResourceRequestedFilter(AppPrefix + "*", CoreWebView2WebResourceContext.All);
                core.AddWebResourceRequestedFilter(FilePrefix + "*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += OnResourceRequested;
                core.NavigationStarting += (s, e) =>
                {
                    if (!e.Uri.StartsWith(Bridge.Origin, StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
                };
                core.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true;
                    Shell.TryOpenExternal(e.Uri);
                };
                core.DocumentTitleChanged += (s, e) =>
                {
                    Text = core.DocumentTitle;
                    Trace.Mark("title " + core.DocumentTitle);
                };
                core.NavigationCompleted += (s, e) => Trace.Mark("navigated");
                core.WindowCloseRequested += (s, e) => Close();
                core.ContextMenuRequested += OnContextMenu;
                core.ProcessFailed += (s, e) =>
                {
                    Log.Error(Strings.LogProcessFailed(e.ProcessFailedKind));
                    if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited
                        || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                        core.Reload();
                };
                bridge.Attach(core);
                core.Navigate(AppUrl);
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogWebView2InitFailed(ex));
                MessageBox.Show(this, Strings.WebView2StartFailed(ex.Message), "MD Viewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                quitConfirmed = true;
                Close();
            }
        }

        /// <summary>문서 안 로컬 이미지만 응답한다 (SDD 8.4).</summary>
        void OnResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            string uri = e.Request.Uri;
            if (uri.StartsWith(AppPrefix, StringComparison.OrdinalIgnoreCase))
            {
                string rel = uri.Substring(AppPrefix.Length);
                int q = rel.IndexOfAny(new[] { '?', '#' });
                if (q >= 0) rel = rel.Substring(0, q);
                if ((rel == "" || rel == "index.html") && !bootServed)
                {
                    bootServed = true;
                    ServeIndexWithBoot(e);
                    return;
                }
                byte[] data;
                string appMime;
                e.Response = AppResources.TryGet(Uri.UnescapeDataString(rel), out data, out appMime)
                    ? env.CreateWebResourceResponse(new MemoryStream(data), 200, "OK", "Content-Type: " + appMime + "\r\nCache-Control: no-store")
                    : env.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            if (!uri.StartsWith(FilePrefix, StringComparison.OrdinalIgnoreCase)) return;
            string raw = uri.Substring(FilePrefix.Length);
            int cut = raw.IndexOfAny(new[] { '?', '#' });
            if (cut >= 0) raw = raw.Substring(0, cut);
            string path;
            try
            {
                path = FileService.Normalize(Uri.UnescapeDataString(raw));
            }
            catch (Exception)
            {
                e.Response = env.CreateWebResourceResponse(null, 400, "Bad Request", "");
                return;
            }
            string mime = FileService.ImageMime(path);
            if (mime == null || !FileService.ImageAllowed(path))
            {
                e.Response = env.CreateWebResourceResponse(null, 403, "Forbidden", "");
                return;
            }
            var deferral = e.GetDeferral();
            Task.Run(() => FileService.ReadImage(path)).ContinueWith(t =>
            {
                try
                {
                    if (t.IsFaulted || t.Result == null)
                    {
                        e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                        return;
                    }
                    string headers = "Content-Type: " + mime + "\r\nCache-Control: no-store";
                    if (mime == "image/svg+xml") headers += "\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'";
                    e.Response = env.CreateWebResourceResponse(new MemoryStream(t.Result), 200, "OK", headers);
                }
                finally
                {
                    deferral.Complete();
                }
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        /// <summary>
        /// 첫 index.html에 부트 데이터를 실행되지 않는 JSON 블록으로 넣는다.
        /// 화면이 chrome.webview에 처음 닿을 때 수백 ms 멈추므로, 첫 화면은 이 데이터로 그린다 (NFR-PERF-01).
        /// </summary>
        void ServeIndexWithBoot(CoreWebView2WebResourceRequestedEventArgs e)
        {
            var deferral = e.GetDeferral();
            Task.Run(() =>
            {
                try
                {
                    return bootTask.Wait(1500) ? bootTask.Result : null;
                }
                catch (Exception ex)
                {
                    Log.Error(Strings.LogBootDataFailed(ex.GetBaseException().Message));
                    return null;
                }
            }).ContinueWith(t =>
            {
                try
                {
                    byte[] data;
                    string mime;
                    if (!AppResources.TryGet("index.html", out data, out mime))
                    {
                        e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                        return;
                    }
                    string boot = t.Result;
                    if (boot != null)
                    {
                        string html = Storage.Utf8.GetString(data);
                        int head = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
                        if (head > 0)
                        {
                            html = html.Substring(0, head) + "<script type=\"application/json\" id=\"mdv-boot\">" + boot + "</script>\n" + html.Substring(head);
                            data = Storage.Utf8.GetBytes(html);
                            // 시작 인자는 부트 데이터로 넘겼으니 app.ready에서 다시 주지 않는다.
                            lock (argsGate)
                            {
                                foreach (var a in bootArgs) pendingArgs.Remove(a);
                            }
                        }
                    }
                    e.Response = env.CreateWebResourceResponse(new MemoryStream(data), 200, "OK", "Content-Type: " + mime + "\r\nCache-Control: no-store");
                }
                finally
                {
                    deferral.Complete();
                }
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        string BuildBootJson(List<string> args)
        {
            var ready = new Dictionary<string, object>();
            string session = Storage.ReadText("session");
            ready["args"] = FileService.Entries(args);
            ready["settings"] = Storage.ReadText("settings");
            ready["session"] = session;
            ready["portable"] = Storage.Portable;
            ready["version"] = Program.Version;
            ready["webview2"] = webview2Version;
            ready["dataDir"] = Storage.ConfigDir;
            ready["trace"] = Environment.GetEnvironmentVariable("MDVIEW_TRACE") == "1";
            var boot = new Dictionary<string, object>();
            boot["ready"] = ready;
            string first = FirstDocPath(args, session);
            if (first != null)
            {
                try
                {
                    var fi = new FileInfo(first);
                    if (fi.Exists && fi.Length <= BootDocMaxBytes) boot["doc"] = FileService.Read(first, null);
                }
                catch (Exception ex)
                {
                    Log.Info(Strings.LogBootDocFailed(first, ex.Message));
                }
            }
            // JSON 안의 '<'는 문자열 안에만 있으므로 \u003c로 바꿔 HTML이 태그로 읽지 않게 한다.
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(boot).Replace("<", "\\u003c");
        }

        /// <summary>화면과 같은 규칙: 시작 인자의 마지막 파일, 없으면 세션의 활성 탭.</summary>
        static string FirstDocPath(List<string> args, string session)
        {
            for (int i = args.Count - 1; i >= 0; i--)
            {
                if (File.Exists(args[i])) return args[i];
            }
            if (session == null) return null;
            try
            {
                var d = new JavaScriptSerializer().DeserializeObject(session) as IDictionary<string, object>;
                var tabs = d == null ? null : (d.ContainsKey("tabs") ? d["tabs"] as object[] : null);
                if (tabs == null || tabs.Length == 0) return null;
                int idx = d.ContainsKey("activeIndex") ? Convert.ToInt32(d["activeIndex"]) : 0;
                var t = tabs[Math.Max(0, Math.Min(tabs.Length - 1, idx))] as IDictionary<string, object>;
                return t != null && t.ContainsKey("path") ? t["path"] as string : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        void OnContextMenu(object sender, CoreWebView2ContextMenuRequestedEventArgs e)
        {
            var items = e.MenuItems;
            for (int i = items.Count - 1; i >= 0; i--)
            {
                var it = items[i];
                if (it.Kind == CoreWebView2ContextMenuItemKind.Separator) continue;
                if (!AllowedContextItems.Contains(it.Name)) items.RemoveAt(i);
            }
            // 남은 구분선 정리
            for (int i = items.Count - 1; i >= 0; i--)
            {
                bool sep = items[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
                bool edge = i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator;
                if (sep && edge) items.RemoveAt(i);
            }
            if (items.Count == 0) e.Handled = true;
        }

        // ------------------------------------------------------------ 브리지에서 부르는 동작

        public Dictionary<string, object> ReadyInfo()
        {
            List<string> args;
            lock (argsGate)
            {
                frontendReady = true;
                args = pendingArgs.ToList();
                pendingArgs.Clear();
            }
            var d = new Dictionary<string, object>();
            d["args"] = FileService.Entries(args);
            d["settings"] = Storage.ReadText("settings");
            d["session"] = Storage.ReadText("session");
            d["portable"] = Storage.Portable;
            d["version"] = Program.Version;
            d["webview2"] = webview2Version;
            d["dataDir"] = Storage.ConfigDir;
            d["trace"] = Environment.GetEnvironmentVariable("MDVIEW_TRACE") == "1";
            return d;
        }

        /// <summary>두 번째 인스턴스가 넘긴 경로 (파이프 스레드에서 불린다).</summary>
        public void OpenFromOtherInstance(string[] paths)
        {
            if (!IsHandleCreated) return;
            BeginInvoke(new Action(() =>
            {
                if (WindowState == FormWindowState.Minimized) NativeMethods.ShowWindow(Handle, NativeMethods.SW_RESTORE);
                Activate();
                NativeMethods.SetForegroundWindow(Handle);
                lock (argsGate)
                {
                    if (!frontendReady)
                    {
                        pendingArgs.AddRange(paths);
                        return;
                    }
                }
                var d = new Dictionary<string, object>();
                d["paths"] = FileService.Entries(paths);
                bridge.Emit("open.paths", d);
            }));
        }

        public string[] PickFiles()
        {
            using (var dlg = new OpenFileDialog())
            {
                dlg.Title = Strings.OpenDialogTitle;
                dlg.Multiselect = true;
                dlg.Filter = Strings.OpenDialogFilter;
                return dlg.ShowDialog(this) == DialogResult.OK ? dlg.FileNames : new string[0];
            }
        }

        public string PickFolder()
        {
            return FolderPicker.Show(Handle, Strings.OpenFolderTitle);
        }

        /// <summary>제목 표시줄을 테마에 맞춘다 (Windows 10 20H1+는 20, 그 이전은 19).</summary>
        public void SetDark(bool dark)
        {
            if (!IsHandleCreated) return;
            int v = dark ? 1 : 0;
            if (NativeMethods.DwmSetWindowAttribute(Handle, 20, ref v, sizeof(int)) != 0)
                NativeMethods.DwmSetWindowAttribute(Handle, 19, ref v, sizeof(int));
            BackColor = dark ? Color.FromArgb(30, 31, 34) : Color.White;
        }

        public void QuitConfirmed()
        {
            if (quitConfirmed) return;
            quitConfirmed = true;
            BeginInvoke(new Action(Close));
        }

        // ------------------------------------------------------------ 종료와 창 상태

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            bool system = e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing;
            if (quitConfirmed || system || web.CoreWebView2 == null || !frontendReady)
            {
                SaveWindow();
                Watch.Dispose();
                return;
            }
            // 화면이 세션을 저장할 시간을 준다 (SDD 7.3). 1초 안에 응답이 없으면 그냥 닫는다.
            e.Cancel = true;
            if (closingRequested) return;
            closingRequested = true;
            bridge.Emit("app.closing", null);
            var timer = new Timer { Interval = 1000 };
            timer.Tick += (s, a) =>
            {
                timer.Dispose();
                QuitConfirmed();
            };
            timer.Start();
        }

        void TrackBounds()
        {
            if (WindowState == FormWindowState.Normal) normalBounds = Bounds;
        }

        void RestoreWindow()
        {
            var fallback = new Rectangle(0, 0, 1200, 820);
            var area = Screen.PrimaryScreen.WorkingArea;
            fallback.X = area.X + Math.Max(0, (area.Width - fallback.Width) / 2);
            fallback.Y = area.Y + Math.Max(0, (area.Height - fallback.Height) / 2);
            Rectangle r = fallback;
            bool maximized = false;
            try
            {
                string text = Storage.ReadText("window");
                var d = text == null ? null : new JavaScriptSerializer().DeserializeObject(text) as IDictionary<string, object>;
                if (d != null)
                {
                    var saved = new Rectangle(Convert.ToInt32(d["x"]), Convert.ToInt32(d["y"]), Convert.ToInt32(d["w"]), Convert.ToInt32(d["h"]));
                    // 모니터 구성이 바뀌어 화면 밖이면 기본 위치로 (FR-SESS-02)
                    if (saved.Width >= 300 && saved.Height >= 200 && Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(saved))) r = saved;
                    object m;
                    maximized = d.TryGetValue("maximized", out m) && m is bool && (bool)m;
                }
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogWindowRestoreFailed(ex.Message));
            }
            Bounds = r;
            normalBounds = r;
            if (maximized) WindowState = FormWindowState.Maximized;
        }

        void SaveWindow()
        {
            try
            {
                var b = WindowState == FormWindowState.Normal ? Bounds : normalBounds;
                var d = new Dictionary<string, object>();
                d["schemaVersion"] = 1;
                d["x"] = b.X;
                d["y"] = b.Y;
                d["w"] = b.Width;
                d["h"] = b.Height;
                d["maximized"] = WindowState == FormWindowState.Maximized;
                Storage.WriteText("window", new JavaScriptSerializer().Serialize(d));
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogWindowSaveFailed(ex.Message));
            }
        }

        /// <summary>첫 화면이 하얗게 번쩍이지 않도록 저장된 테마를 미리 본다.</summary>
        static bool InitialDark()
        {
            string s = Storage.ReadText("settings") ?? "";
            if (s.Contains("\"theme\": \"dark\"") || s.Contains("\"theme\":\"dark\"")) return true;
            if (s.Contains("\"theme\": \"light\"") || s.Contains("\"theme\":\"light\"")) return false;
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object v = k == null ? null : k.GetValue("AppsUseLightTheme");
                    return v is int && (int)v == 0;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
