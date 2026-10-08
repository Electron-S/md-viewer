using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

namespace MdViewer
{
    /// <summary>
    /// 브리지 (SDD 6장). 화면이 보낸 JSON 요청을 허용 목록 메서드로만 보내고 응답·이벤트를 돌려준다.
    /// 메시지는 https://app.mdview 출처에서 온 것만 받는다 (SDD 8.4).
    /// </summary>
    public sealed class Bridge
    {
        public const string Origin = "https://app.mdview/";
        readonly MainForm form;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        CoreWebView2 core;

        public Bridge(MainForm form)
        {
            this.form = form;
        }

        public void Attach(CoreWebView2 core)
        {
            this.core = core;
            core.WebMessageReceived += OnMessage;
        }

        static Dictionary<string, object> Obj(string key, object value)
        {
            var d = new Dictionary<string, object>();
            d[key] = value;
            return d;
        }

        static Dictionary<string, object> Empty() { return new Dictionary<string, object>(); }

        static string Str(IDictionary<string, object> p, string key)
        {
            object v;
            return p.TryGetValue(key, out v) ? v as string : null;
        }

        static bool Bool(IDictionary<string, object> p, string key)
        {
            object v;
            return p.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        static List<string> StrList(IDictionary<string, object> p, string key)
        {
            object v;
            var arr = p.TryGetValue(key, out v) ? v as object[] : null;
            return arr == null ? new List<string>() : arr.OfType<string>().ToList();
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!e.Source.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
            IDictionary<string, object> msg;
            try
            {
                msg = json.DeserializeObject(e.WebMessageAsJson) as IDictionary<string, object>;
            }
            catch (Exception)
            {
                return;
            }
            if (msg == null || Str(msg, "t") != "req" || !msg.ContainsKey("id")) return;
            object id = msg["id"];
            string method = Str(msg, "m") ?? "";
            object rawParams;
            var p = (msg.TryGetValue("p", out rawParams) ? rawParams as IDictionary<string, object> : null) ?? new Dictionary<string, object>();
            List<string> dropped = null;
            if (method == "drop.paths")
            {
                dropped = new List<string>();
                if (e.AdditionalObjects != null)
                {
                    foreach (object o in e.AdditionalObjects)
                    {
                        var f = o as CoreWebView2File;
                        if (f != null) dropped.Add(f.Path);
                    }
                }
            }
            try
            {
                Dispatch(id, method, p, dropped);
            }
            catch (BridgeException ex)
            {
                Fail(id, ex.Code, ex.Message);
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogMethodError(method, ex));
                Fail(id, "EHOST", ex.Message);
            }
        }

        void Dispatch(object id, string method, IDictionary<string, object> p, List<string> dropped)
        {
            switch (method)
            {
                case "app.ready":
                    Trace.Mark("app.ready");
                    Reply(id, form.ReadyInfo());
                    break;
                case "file.read":
                {
                    string path = Str(p, "path");
                    string encoding = Str(p, "encoding");
                    RunAsync(id, () => FileService.Read(path, encoding));
                    break;
                }
                case "dir.list":
                {
                    string path = Str(p, "path");
                    RunAsync(id, () => Obj("entries", FileService.ListDir(path)));
                    break;
                }
                case "dialog.openFiles":
                    Reply(id, Obj("paths", form.PickFiles()));
                    break;
                case "dialog.openFolder":
                    Reply(id, Obj("path", form.PickFolder()));
                    break;
                case "drop.paths":
                    Reply(id, Obj("entries", FileService.Entries(dropped ?? new List<string>())));
                    break;
                case "watch.set":
                {
                    // WSL 파일 상태 확인이 UI 스레드를 막지 않게 뒤에서 한다.
                    var paths = StrList(p, "paths");
                    RunAsync(id, () =>
                    {
                        form.Watch.SetPaths(paths);
                        return Empty();
                    });
                    break;
                }
                case "store.save":
                {
                    string name = Str(p, "name");
                    if (name != "session" && name != "settings") throw new BridgeException("EINVAL", Strings.NotStorable);
                    string data = Str(p, "data") ?? "";
                    RunAsync(id, () =>
                    {
                        Storage.WriteText(name, data);
                        return Empty();
                    });
                    break;
                }
                case "shell.openExternal":
                    Shell.OpenExternal(Str(p, "url"));
                    Reply(id, Empty());
                    break;
                case "shell.reveal":
                    Shell.Reveal(FileService.Normalize(Str(p, "path")));
                    Reply(id, Empty());
                    break;
                case "window.setTheme":
                    form.SetDark(Bool(p, "dark"));
                    Reply(id, Empty());
                    break;
                case "app.quit":
                    Reply(id, Empty());
                    form.QuitConfirmed();
                    break;
                case "app.log":
                    if (Str(p, "level") == "trace")
                    {
                        object at;
                        if (p.TryGetValue("at", out at) && at != null) Trace.MarkAt(Str(p, "msg") ?? "", Convert.ToDouble(at));
                        else Trace.Mark(Str(p, "msg") ?? "");
                    }
                    else Log.Write(Str(p, "level") ?? "info", Str(p, "msg") ?? "");
                    Reply(id, Empty());
                    break;
                default:
                    throw new BridgeException("ENOMETHOD", Strings.UnknownMethod(method));
            }
        }

        /// <summary>파일 작업은 백그라운드에서 돌리고, 응답은 UI 스레드에서 보낸다 (SDD 6.1).</summary>
        void RunAsync(object id, Func<object> work)
        {
            Task.Run(work).ContinueWith(t =>
            {
                if (!t.IsFaulted)
                {
                    Reply(id, t.Result);
                    return;
                }
                Exception ex = t.Exception.GetBaseException();
                var be = ex as BridgeException;
                if (be != null) Fail(id, be.Code, be.Message);
                else if (ex is UnauthorizedAccessException) Fail(id, "EACCES", Strings.AccessDenied);
                else if (ex is FileNotFoundException || ex is DirectoryNotFoundException) Fail(id, "ENOENT", Strings.FileNotFound);
                else if (ex is IOException) Fail(id, "EIO", ex.Message);
                else
                {
                    Log.Error(Strings.LogTaskError(ex));
                    Fail(id, "EHOST", ex.Message);
                }
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        void Reply(object id, object result)
        {
            var d = new Dictionary<string, object>();
            d["t"] = "res";
            d["id"] = id;
            d["ok"] = true;
            d["r"] = result;
            Post(d);
        }

        void Fail(object id, string code, string message)
        {
            var e = new Dictionary<string, object>();
            e["code"] = code;
            e["msg"] = message;
            var d = new Dictionary<string, object>();
            d["t"] = "res";
            d["id"] = id;
            d["ok"] = false;
            d["e"] = e;
            Post(d);
        }

        /// <summary>호스트 → 화면 이벤트. 어느 스레드에서 불러도 된다.</summary>
        public void Emit(string name, object payload)
        {
            var d = new Dictionary<string, object>();
            d["t"] = "evt";
            d["n"] = name;
            d["p"] = payload ?? Empty();
            Post(d);
        }

        void Post(Dictionary<string, object> d)
        {
            string s = json.Serialize(d);
            Action send = () =>
            {
                if (core != null) core.PostWebMessageAsJson(s);
            };
            if (form.InvokeRequired)
            {
                if (form.IsHandleCreated && !form.IsDisposed) form.BeginInvoke(send);
            }
            else send();
        }
    }
}
