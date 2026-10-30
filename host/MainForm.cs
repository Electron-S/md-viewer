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
    /// <summary>
    /// 메인 창 (SDD 4장). WebView2를 띄우고 탐색·리소스·창 상태를 관리한다.
    /// 화면(viewer.html)과 문서 바이트·그림은 https://app.mdview/ 아래 주소로 직접 응답한다(실제 네트워크는 쓰지 않는다).
    /// </summary>
    public sealed class MainForm : Form
    {
        const string AppUrl = "https://app.mdview/index.html";
        const string AppPrefix = "https://app.mdview/";
        static readonly HashSet<string> AllowedContextItems = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "copy", "selectAll", "copyLinkLocation", "copyImage", "copyImageLocation",
        };

        readonly WebView2 web;
        readonly Bridge bridge;
        public readonly WatchService Watch;
        readonly List<string> pendingArgs;
        readonly object argsGate = new object();
        /// <summary>첫 화면용 시작 정보(인자·설정·세션). 시작하자마자 WebView2 준비와 병렬로 만든다.</summary>
        readonly Task<string> bootTask;
        readonly List<string> bootArgs;
        /// <summary>화면 HTML(viewer.html). EXE 리소스에서 한 번 읽는다.</summary>
        readonly Task<byte[]> viewerTask;
        bool bootServed;
        bool frontendReady;
        bool quitConfirmed;
        bool closingRequested;
        /// <summary>화면에 저장하지 않은 문서가 있는지 (app.setDirty, FR-EDIT-08)</summary>
        bool dirty;
        Timer closeTimer;
        Rectangle normalBounds;
        CoreWebView2Environment env;
        /// <summary>창을 띄우기 전에 시작해 둔 WebView2 환경 생성 (NFR-PERF-01)</summary>
        readonly Task<CoreWebView2Environment> envTask;

        public MainForm(string[] startPaths)
        {
            pendingArgs = new List<string>(startPaths);
            bootArgs = new List<string>(startPaths);
            bootTask = Task.Run(() => BuildBootJson(bootArgs));
            viewerTask = Task.Run(() => Embedded.Read("viewer.html"));
            envTask = CoreWebView2Environment.CreateAsync(null, Storage.WebViewDir, new CoreWebView2EnvironmentOptions());
            Text = Strings.AppName;
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
                MessageBox.Show(this, Strings.WebView2StartFailed(ex.Message), Strings.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                quitConfirmed = true;
                Close();
            }
        }

        /// <summary>https://app.mdview/ 아래 요청: 화면 HTML, 문서 바이트(/api/read), 문서 그림(/api/file).</summary>
        void OnResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            string uri = e.Request.Uri;
            if (!uri.StartsWith(AppPrefix, StringComparison.OrdinalIgnoreCase)) return;
            string rest = uri.Substring(AppPrefix.Length);
            int hash = rest.IndexOf('#');
            if (hash >= 0) rest = rest.Substring(0, hash);
            int q = rest.IndexOf('?');
            string route = q >= 0 ? rest.Substring(0, q) : rest;
            string query = q >= 0 ? rest.Substring(q + 1) : "";
            if (route == "" || route == "index.html")
            {
                ServeIndex(e);
                return;
            }
            if (route == "api/read")
            {
                string path = QueryValue(query, "path");
                Respond(e, () =>
                {
                    double mtime;
                    byte[] data = FileService.ReadBytes(path, out mtime);
                    var headers = "Content-Type: application/octet-stream\r\nCache-Control: no-store\r\nx-mdv-mtime: " + Math.Round(mtime).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    return new ApiResult(data, headers);
                });
                return;
            }
            if (route == "api/write")
            {
                ServeWrite(e, query);
                return;
            }
            if (route == "api/file")
            {
                string path = QueryValue(query, "path");
                Respond(e, () =>
                {
                    string full = FileService.Normalize(path);
                    string mime = FileService.ImageMime(full);
                    if (mime == null) throw new BridgeException("EINVAL", Strings.NotImage);
                    if (!FileService.ImageAllowed(full)) throw new BridgeException("EACCES", Strings.AccessDenied);
                    byte[] data = FileService.ReadImage(full);
                    if (data == null) throw new BridgeException("ENOENT", Strings.FileNotFound);
                    string headers = "Content-Type: " + mime + "\r\nCache-Control: no-store";
                    if (mime == "image/svg+xml") headers += "\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'";
                    return new ApiResult(data, headers);
                });
                return;
            }
            e.Response = ErrorResponse("ENOENT", Strings.NoApi);
        }

        /// <summary>
        /// 문서 쓰기 (FR-EDIT-04, SDD 6.4). 실행기의 POST /api/write와 같은 모양이다. 화면 출처의 POST·octet-stream만 받고,
        /// 본문은 UI 스레드에서 메모리로 옮긴 뒤 쓰기는 뒤에서 한다.
        /// </summary>
        void ServeWrite(CoreWebView2WebResourceRequestedEventArgs e, string query)
        {
            var req = e.Request;
            string origin = req.Headers.Contains("Origin") ? req.Headers.GetHeader("Origin") : "";
            string type = req.Headers.Contains("Content-Type") ? req.Headers.GetHeader("Content-Type") : "";
            if (req.Method != "POST" || origin.TrimEnd('/') != Bridge.Origin.TrimEnd('/'))
            {
                e.Response = ErrorResponse("EFORBIDDEN", Strings.Forbidden);
                return;
            }
            if (!type.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase) || req.Content == null)
            {
                e.Response = ErrorResponse("EINVAL", Strings.BadRequest);
                return;
            }
            byte[] body;
            using (var ms = new MemoryStream())
            {
                req.Content.CopyTo(ms);
                body = ms.ToArray();
            }
            string path = QueryValue(query, "path");
            double? baseMtime = QueryNumber(query, "baseMtime");
            double? baseSize = QueryNumber(query, "baseSize");
            bool create = QueryValue(query, "create") == "1";
            bool overwrite = QueryValue(query, "overwrite") == "1";
            Respond(e, () =>
            {
                var r = FileService.WriteBytes(path, body, baseMtime, baseSize.HasValue ? (long?)(long)baseSize.Value : null, create, overwrite);
                return new ApiResult(Storage.Utf8.GetBytes(new JavaScriptSerializer().Serialize(r)), "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store");
            });
        }

        static double? QueryNumber(string query, string name)
        {
            string v = QueryValue(query, name);
            double n;
            if (string.IsNullOrEmpty(v) || !double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out n)) return null;
            return n;
        }

        sealed class ApiResult
        {
            public readonly byte[] Data;
            public readonly string Headers;

            public ApiResult(byte[] data, string headers)
            {
                Data = data;
                Headers = headers;
            }
        }

        /// <summary>쿼리 문자열에서 이름의 값을 꺼낸다. 화면은 encodeURIComponent로 만들므로 '+'는 공백이 아니다.</summary>
        static string QueryValue(string query, string name)
        {
            foreach (var part in query.Split('&'))
            {
                int eq = part.IndexOf('=');
                if (eq > 0 && part.Substring(0, eq) == name) return Uri.UnescapeDataString(part.Substring(eq + 1));
            }
            return null;
        }

        /// <summary>파일 일은 뒤에서 하고 응답은 UI 스레드에서 준다. BridgeException은 화면이 알아보는 코드·문구로 답한다.</summary>
        void Respond(CoreWebView2WebResourceRequestedEventArgs e, Func<ApiResult> work)
        {
            var deferral = e.GetDeferral();
            string uri = e.Request.Uri;
            Task.Run(work).ContinueWith(t =>
            {
                try
                {
                    if (!t.IsFaulted)
                    {
                        e.Response = env.CreateWebResourceResponse(new MemoryStream(t.Result.Data), 200, "OK", t.Result.Headers);
                        return;
                    }
                    Exception ex = t.Exception.GetBaseException();
                    var be = ex as BridgeException;
                    if (be != null) e.Response = ErrorResponse(be.Code, be.Message);
                    else if (ex is UnauthorizedAccessException) e.Response = ErrorResponse("EACCES", Strings.AccessDenied);
                    else if (ex is FileNotFoundException || ex is DirectoryNotFoundException) e.Response = ErrorResponse("ENOENT", Strings.FileNotFound);
                    else
                    {
                        Log.Error(Strings.LogRequestError(uri.Split('?')[0], ex));
                        e.Response = ErrorResponse("EIO", ex.Message);
                    }
                }
                finally
                {
                    deferral.Complete();
                }
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        /// <summary>실행기(launcher/server.ts)와 같은 모양의 오류 응답: 상태 코드와 {code, message}</summary>
        CoreWebView2WebResourceResponse ErrorResponse(string code, string message)
        {
            int status;
            switch (code)
            {
                case "EINVAL": status = 400; break;
                case "EACCES": status = 403; break;
                case "EFORBIDDEN": status = 403; break;
                case "ENOENT": status = 404; break;
                case "EISDIR": status = 409; break;
                case "ECONFLICT": status = 409; break;
                case "EEXIST": status = 409; break;
                case "ETOOBIG": status = 413; break;
                default: status = 500; break;
            }
            var d = new Dictionary<string, object>();
            d["code"] = code;
            d["message"] = message;
            byte[] body = Storage.Utf8.GetBytes(new JavaScriptSerializer().Serialize(d));
            return env.CreateWebResourceResponse(new MemoryStream(body), status, "Error", "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store");
        }

        /// <summary>
        /// 화면 HTML. 처음 한 번은 시작 정보를 실행되지 않는 JSON 블록으로 넣는다. 화면이 chrome.webview에 처음 닿으면
        /// 수백 ms 멈추므로 첫 화면은 이 정보와 /api/read로 그린다 (NFR-PERF-01). 다시 읽을 때(렌더러 복구 등)는 app.ready로 묻는다.
        /// </summary>
        void ServeIndex(CoreWebView2WebResourceRequestedEventArgs e)
        {
            bool withBoot = !bootServed;
            bootServed = true;
            var deferral = e.GetDeferral();
            Task.Run(() =>
            {
                byte[] html = viewerTask.Result;
                if (html == null || !withBoot) return html;
                string boot = null;
                try
                {
                    boot = bootTask.Wait(1500) ? bootTask.Result : null;
                }
                catch (Exception ex)
                {
                    Log.Error(Strings.LogBootDataFailed(ex.GetBaseException().Message));
                }
                if (boot == null) return html;
                string text = Storage.Utf8.GetString(html);
                int head = text.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
                if (head < 0) return html;
                text = text.Substring(0, head) + "<script type=\"application/json\" id=\"mdv-boot\">" + boot + "</script>\n" + text.Substring(head);
                // 시작 인자는 시작 정보로 넘겼으니 app.ready에서 다시 주지 않는다.
                lock (argsGate)
                {
                    foreach (var a in bootArgs) pendingArgs.Remove(a);
                }
                return Storage.Utf8.GetBytes(text);
            }).ContinueWith(t =>
            {
                try
                {
                    byte[] data = t.IsFaulted ? null : t.Result;
                    e.Response = data == null
                        ? ErrorResponse("ENOENT", Strings.NoApi)
                        : env.CreateWebResourceResponse(new MemoryStream(data), 200, "OK", "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
                }
                finally
                {
                    deferral.Complete();
                }
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        string BuildBootJson(List<string> args)
        {
            // JSON 안의 '<'는 문자열 안에만 있으므로 \u003c로 바꿔 HTML이 태그로 읽지 않게 한다.
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(StartInfo(args)).Replace("<", "\\u003c");
        }

        /// <summary>화면의 ReadyInfo(web/src/bridge/host.ts의 Boot)와 같은 모양</summary>
        static Dictionary<string, object> StartInfo(List<string> args)
        {
            var d = new Dictionary<string, object>();
            d["args"] = FileService.Entries(args);
            d["settings"] = Storage.ReadText("settings");
            d["session"] = Storage.ReadText("session");
            d["version"] = BuildInfo.Version;
            d["dataDir"] = Storage.ConfigDir;
            d["registered"] = OpenWith.IsRegistered(Application.ExecutablePath);
            return d;
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

        /// <summary>화면이 메시지를 받기 시작했다(첫 화면을 그린 뒤). 그사이 다른 인스턴스가 넘긴 위치를 돌려준다.</summary>
        public List<object> Attach()
        {
            List<string> args;
            lock (argsGate)
            {
                frontendReady = true;
                args = pendingArgs.ToList();
                pendingArgs.Clear();
            }
            return FileService.Entries(args);
        }

        public Dictionary<string, object> ReadyInfo()
        {
            List<string> args;
            lock (argsGate)
            {
                frontendReady = true;
                args = pendingArgs.ToList();
                pendingArgs.Clear();
            }
            return StartInfo(args);
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

        /// <summary>다른 이름으로 저장할 위치 (FR-EDIT-05). 고른 경로는 쓰기 허용 집합에 넣는다. 덮어쓸지는 대화상자가 묻는다.</summary>
        public string PickSave(string suggestedName, string dir)
        {
            using (var dlg = new SaveFileDialog())
            {
                dlg.Title = Strings.SaveDialogTitle;
                dlg.Filter = Strings.SaveDialogFilter;
                dlg.FilterIndex = FileService.IsText(suggestedName ?? "") ? 2 : 1;
                dlg.OverwritePrompt = true;
                dlg.AddExtension = true;
                dlg.DefaultExt = "md";
                if (!string.IsNullOrEmpty(suggestedName)) dlg.FileName = Path.GetFileName(suggestedName);
                try
                {
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) dlg.InitialDirectory = dir;
                }
                catch (Exception) { }
                if (dlg.ShowDialog(this) != DialogResult.OK) return null;
                string path = FileService.Normalize(dlg.FileName);
                if (!FileService.IsDocument(path)) throw new BridgeException("EACCES", Strings.NotDocument);
                FileService.AllowWrite(path);
                return path;
            }
        }

        /// <summary>화면에 저장하지 않은 문서가 있는지 (FR-EDIT-08). 있는 동안에는 닫기를 강제로 끝내지 않는다.</summary>
        public void SetDirty(bool on)
        {
            dirty = on;
        }

        /// <summary>화면이 닫기를 취소했다(저장 확인에서 취소). 다음 닫기를 다시 받는다.</summary>
        public void CancelClose()
        {
            closingRequested = false;
            if (closeTimer != null)
            {
                closeTimer.Dispose();
                closeTimer = null;
            }
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
            // Windows 종료 때만 기다리지 않는다. 작업 관리자의 "작업 끝내기"·taskkill(/f 없이)처럼 다른 프로세스가 보낸 WM_CLOSE는
            // TaskManagerClosing으로 오는데, 그때도 1초 안에서 저장할 기회를 준다.
            // 저장하지 않은 문서가 있으면 Windows 종료도 일반 닫기처럼 화면에 묻는다 (FR-EDIT-08). Windows는 종료를 막는 앱으로 보여 준다.
            bool shutdown = e.CloseReason == CloseReason.WindowsShutDown;
            if (quitConfirmed || (shutdown && !dirty) || web.CoreWebView2 == null || !frontendReady)
            {
                SaveWindow();
                Watch.Dispose();
                return;
            }
            e.Cancel = true;
            if (closingRequested) return;
            closingRequested = true;
            bridge.Emit("app.closing", null);
            // 고친 문서가 있으면 화면이 저장할지 묻고 app.quit·app.cancelClose로 답한다. 기다린다.
            if (dirty) return;
            // 화면이 세션을 저장할 시간을 준다 (SDD 7.3). 1초 안에 응답이 없으면 그냥 닫는다.
            closeTimer = new Timer { Interval = 1000 };
            closeTimer.Tick += (s, a) =>
            {
                if (closeTimer != null) closeTimer.Dispose();
                closeTimer = null;
                QuitConfirmed();
            };
            closeTimer.Start();
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
