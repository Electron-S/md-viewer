using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace MdViewer
{
    /// <summary>
    /// 단일 인스턴스 (FR-FILE-04, SDD 7.2). 사용자별 Mutex로 첫 인스턴스를 가리고,
    /// 두 번째 실행은 Named Pipe로 경로를 넘기고 끝난다.
    /// </summary>
    public sealed class SingleInstance : IDisposable
    {
        readonly Mutex mutex;
        readonly string pipeName;
        readonly bool primary;
        volatile bool stopping;

        public SingleInstance()
        {
            bool created;
            mutex = new Mutex(true, @"Local\MdViewer-" + Storage.InstanceKey, out created);
            primary = created;
            pipeName = "MdViewer-" + Storage.InstanceKey;
        }

        public bool IsPrimary { get { return primary; } }

        public bool SendToPrimary(IList<string> paths)
        {
            // 첫 인스턴스가 창을 앞으로 가져올 수 있게 허락한다.
            NativeMethods.AllowSetForegroundWindow(NativeMethods.ASFW_ANY);
            byte[] data = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(paths));
            for (int attempt = 0; attempt < 25; attempt++)
            {
                try
                {
                    using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
                    {
                        client.Connect(200);
                        client.Write(data, 0, data.Length);
                        client.Flush();
                    }
                    return true;
                }
                catch (TimeoutException) { }
                catch (IOException)
                {
                    Thread.Sleep(100);
                }
            }
            Log.Error(Strings.LogSendToPrimaryFailed);
            return false;
        }

        public void StartServer(Action<string[]> onPaths)
        {
            var t = new Thread(() =>
            {
                while (!stopping)
                {
                    try
                    {
                        using (var server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                        {
                            server.WaitForConnection();
                            if (stopping) break;
                            var ms = new MemoryStream();
                            server.CopyTo(ms);
                            var arr = new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(ms.ToArray())) as object[];
                            if (arr != null) onPaths(arr.OfType<string>().ToArray());
                        }
                    }
                    catch (Exception ex)
                    {
                        if (stopping) break;
                        Log.Error(Strings.LogPipeServerError(ex.Message));
                        Thread.Sleep(200);
                    }
                }
            });
            t.IsBackground = true;
            t.Name = "MdViewer pipe";
            t.Start();
        }

        public void Dispose()
        {
            stopping = true;
            if (primary)
            {
                try
                {
                    mutex.ReleaseMutex();
                }
                catch (Exception) { }
            }
            mutex.Dispose();
        }
    }
}
