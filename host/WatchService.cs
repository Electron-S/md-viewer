using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace MdViewer
{
    /// <summary>
    /// 열린 파일 감시 (FR-WATCH-01~02). 폴더마다 FileSystemWatcher를 두고 150 ms 디바운스한다.
    /// WSL(\\wsl.localhost, \\wsl$)은 변경 알림이 오지 않으므로 500 ms 간격으로 상태를 비교한다.
    /// </summary>
    public sealed class WatchService : IDisposable
    {
        const int TickMs = 50;
        const int DebounceMs = 150;
        const int PollEveryTicks = 10;

        struct Stamp
        {
            public bool Exists;
            public long Length;
            public DateTime WriteUtc;

            public bool Same(Stamp o) { return Exists == o.Exists && Length == o.Length && WriteUtc == o.WriteUtc; }
        }

        readonly Action<string> onChanged;
        readonly Action<string> onDeleted;
        readonly object gate = new object();
        readonly Dictionary<string, string> files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, FileSystemWatcher> watchers = new Dictionary<string, FileSystemWatcher>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> pollDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, Stamp> stamps = new Dictionary<string, Stamp>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, DateTime> due = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        readonly Timer ticker;
        int ticks;
        int busy;
        bool disposed;

        public WatchService(Action<string> onChanged, Action<string> onDeleted)
        {
            this.onChanged = onChanged;
            this.onDeleted = onDeleted;
            ticker = new Timer(Tick, null, TickMs, TickMs);
        }

        static bool NeedsPolling(string dir)
        {
            return dir.StartsWith(@"\\wsl.localhost\", StringComparison.OrdinalIgnoreCase)
                || dir.StartsWith(@"\\wsl$\", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>감시 대상을 통째로 바꾼다.</summary>
        public void SetPaths(IEnumerable<string> paths)
        {
            lock (gate)
            {
                if (disposed) return;
                files.Clear();
                foreach (var p in paths)
                {
                    try
                    {
                        string full = FileService.Normalize(p);
                        files[full] = full;
                    }
                    catch (BridgeException) { }
                }
                var dirs = new HashSet<string>(files.Keys.Select(Path.GetDirectoryName).Where(d => d != null), StringComparer.OrdinalIgnoreCase);
                foreach (var dir in watchers.Keys.ToList())
                {
                    if (dirs.Contains(dir)) continue;
                    watchers[dir].Dispose();
                    watchers.Remove(dir);
                }
                pollDirs.RemoveWhere(d => !dirs.Contains(d));
                foreach (var dir in dirs)
                {
                    if (watchers.ContainsKey(dir) || pollDirs.Contains(dir)) continue;
                    if (NeedsPolling(dir) || !TryWatch(dir)) pollDirs.Add(dir);
                }
                foreach (var key in stamps.Keys.ToList())
                {
                    if (!files.ContainsKey(key) || !pollDirs.Contains(Path.GetDirectoryName(key))) stamps.Remove(key);
                }
                foreach (var f in files.Keys)
                {
                    if (pollDirs.Contains(Path.GetDirectoryName(f)) && !stamps.ContainsKey(f)) stamps[f] = Read(f);
                }
                foreach (var key in due.Keys.ToList()) if (!files.ContainsKey(key)) due.Remove(key);
            }
        }

        bool TryWatch(string dir)
        {
            try
            {
                var w = new FileSystemWatcher(dir)
                {
                    IncludeSubdirectories = false,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime,
                    InternalBufferSize = 64 * 1024,
                };
                w.Changed += (s, e) => Mark(e.FullPath);
                w.Created += (s, e) => Mark(e.FullPath);
                w.Deleted += (s, e) => Mark(e.FullPath);
                w.Renamed += (s, e) =>
                {
                    Mark(e.OldFullPath);
                    Mark(e.FullPath);
                };
                w.Error += (s, e) =>
                {
                    // 버퍼 넘침 등: 그 폴더의 열린 파일을 모두 다시 확인한다.
                    lock (gate)
                    {
                        foreach (var f in files.Keys.Where(f => string.Equals(Path.GetDirectoryName(f), dir, StringComparison.OrdinalIgnoreCase)))
                            due[f] = DateTime.UtcNow.AddMilliseconds(DebounceMs);
                    }
                };
                w.EnableRaisingEvents = true;
                watchers[dir] = w;
                return true;
            }
            catch (Exception ex)
            {
                Log.Info(Strings.LogWatchFallback(dir, ex.Message));
                return false;
            }
        }

        void Mark(string path)
        {
            lock (gate)
            {
                if (files.ContainsKey(path)) due[path] = DateTime.UtcNow.AddMilliseconds(DebounceMs);
            }
        }

        static Stamp Read(string path)
        {
            try
            {
                var fi = new FileInfo(path);
                return fi.Exists ? new Stamp { Exists = true, Length = fi.Length, WriteUtc = fi.LastWriteTimeUtc } : new Stamp();
            }
            catch (Exception)
            {
                return new Stamp();
            }
        }

        void Tick(object state)
        {
            if (Interlocked.Exchange(ref busy, 1) == 1) return;
            try
            {
                var fire = new List<string>();
                List<string> poll = null;
                lock (gate)
                {
                    if (disposed) return;
                    var now = DateTime.UtcNow;
                    foreach (var kv in due) if (kv.Value <= now) fire.Add(kv.Key);
                    foreach (var f in fire) due.Remove(f);
                    if (++ticks % PollEveryTicks == 0 && stamps.Count > 0) poll = stamps.Keys.ToList();
                }
                if (poll != null)
                {
                    foreach (var f in poll)
                    {
                        var s = Read(f);
                        lock (gate)
                        {
                            Stamp old;
                            if (!stamps.TryGetValue(f, out old) || old.Same(s)) continue;
                            stamps[f] = s;
                        }
                        if (!fire.Contains(f, StringComparer.OrdinalIgnoreCase)) fire.Add(f);
                    }
                }
                foreach (var f in fire)
                {
                    string original;
                    lock (gate)
                    {
                        if (!files.TryGetValue(f, out original)) continue;
                    }
                    if (File.Exists(original)) onChanged(original);
                    else onDeleted(original);
                }
            }
            catch (Exception ex)
            {
                Log.Error(Strings.LogWatchError(ex));
            }
            finally
            {
                Interlocked.Exchange(ref busy, 0);
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                foreach (var w in watchers.Values) w.Dispose();
                watchers.Clear();
            }
            ticker.Dispose();
        }
    }
}
