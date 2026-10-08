using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace MdViewer
{
    /// <summary>OS 연동 (SRS 4.3). 외부 링크는 http·https·mailto만 연다.</summary>
    public static class Shell
    {
        public static void OpenExternal(string url)
        {
            Uri u;
            if (string.IsNullOrEmpty(url) || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out u)
                || !(u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeMailto))
                throw new BridgeException("EINVAL", Strings.UrlNotAllowed);
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }

        public static void TryOpenExternal(string url)
        {
            try
            {
                OpenExternal(url);
            }
            catch (Exception ex)
            {
                Log.Info(Strings.LogExternalOpenSkipped(url, ex.Message));
            }
        }

        /// <summary>탐색기에서 파일을 선택한 채로 연다. 실행은 하지 않는다.</summary>
        public static void Reveal(string path)
        {
            if (File.Exists(path) || Directory.Exists(path))
            {
                Process.Start("explorer.exe", "/select,\"" + path + "\"");
                return;
            }
            string dir = Path.GetDirectoryName(path);
            if (dir != null && Directory.Exists(dir))
            {
                Process.Start("explorer.exe", "\"" + dir + "\"");
                return;
            }
            throw new BridgeException("ENOENT", Strings.FileNotFound);
        }
    }

    static class NativeMethods
    {
        public const int ASFW_ANY = -1;
        public const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int dwProcessId);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
    }

    /// <summary>Windows Vista 이후의 폴더 선택 대화상자 (IFileOpenDialog + FOS_PICKFOLDERS).</summary>
    static class FolderPicker
    {
        const uint FOS_NOCHANGEDIR = 0x8;
        const uint FOS_PICKFOLDERS = 0x20;
        const uint FOS_FORCEFILESYSTEM = 0x40;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogCoClass { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, out IntPtr ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        public static string Show(IntPtr owner, string title)
        {
            var dlg = (IFileDialog)new FileOpenDialogCoClass();
            try
            {
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR);
                dlg.SetTitle(title);
                int hr = dlg.Show(owner);
                if (hr == ERROR_CANCELLED) return null;
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                IShellItem item;
                dlg.GetResult(out item);
                IntPtr p;
                item.GetDisplayName(SIGDN_FILESYSPATH, out p);
                try
                {
                    return Marshal.PtrToStringUni(p);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(p);
                    Marshal.ReleaseComObject(item);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(dlg);
            }
        }
    }
}
