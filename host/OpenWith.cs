using System;
using System.IO;
using Microsoft.Win32;

namespace MdViewer
{
    /// <summary>
    /// 탐색기 연결 프로그램 등록 (사용자 단위, 관리자 권한 없음). Markdown 확장자의 "연결 프로그램" 목록과
    /// 오른쪽 클릭 메뉴("MD Viewer로 열기")에 이 EXE를 넣는다. 기본 앱은 Windows가 사용자에게 직접 고르게 하므로 바꾸지 않는다.
    /// </summary>
    public static class OpenWith
    {
        const string ProgId = "MdViewer.Document";
        const string MenuKey = "MdViewer";
        static readonly string[] Extensions = { ".md", ".markdown", ".mdown", ".mkd" };

        /// <summary>등록 위치(HKCU 아래). 테스트는 MDVIEW_REGROOT로 다른 키를 쓴다.</summary>
        static string ClassesKey
        {
            get { return (Environment.GetEnvironmentVariable("MDVIEW_REGROOT") ?? "Software") + @"\Classes"; }
        }

        static string Command(string exe)
        {
            return "\"" + exe + "\" \"%1\"";
        }

        public static void Register(string exe)
        {
            exe = Path.GetFullPath(exe);
            string cmd = Command(exe);
            using (var classes = Registry.CurrentUser.CreateSubKey(ClassesKey))
            {
                using (var k = classes.CreateSubKey(ProgId))
                {
                    k.SetValue("", Strings.DocTypeName);
                    k.SetValue("FriendlyTypeName", Strings.DocTypeName);
                    using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", "\"" + exe + "\",0");
                    using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", cmd);
                }
                using (var app = classes.CreateSubKey(@"Applications\" + Path.GetFileName(exe)))
                {
                    app.SetValue("FriendlyAppName", Strings.AppName);
                    using (var c = app.CreateSubKey(@"shell\open\command")) c.SetValue("", cmd);
                    using (var t = app.CreateSubKey("SupportedTypes")) foreach (var ext in Extensions) t.SetValue(ext, "");
                }
                foreach (var ext in Extensions)
                {
                    using (var k = classes.CreateSubKey(ext + @"\OpenWithProgids")) k.SetValue(ProgId, new byte[0], RegistryValueKind.None);
                    using (var k = classes.CreateSubKey(@"SystemFileAssociations\" + ext + @"\shell\" + MenuKey))
                    {
                        k.SetValue("", Strings.OpenWithMenu(Strings.AppName));
                        k.SetValue("Icon", "\"" + exe + "\"");
                        using (var c = k.CreateSubKey("command")) c.SetValue("", cmd);
                    }
                }
            }
            Notify();
        }

        public static void Unregister(string exe)
        {
            using (var classes = Registry.CurrentUser.OpenSubKey(ClassesKey, true))
            {
                if (classes != null)
                {
                    classes.DeleteSubKeyTree(ProgId, false);
                    classes.DeleteSubKeyTree(@"Applications\" + Path.GetFileName(exe), false);
                    foreach (var ext in Extensions)
                    {
                        using (var k = classes.OpenSubKey(ext + @"\OpenWithProgids", true))
                        {
                            if (k != null) k.DeleteValue(ProgId, false);
                        }
                        classes.DeleteSubKeyTree(@"SystemFileAssociations\" + ext + @"\shell\" + MenuKey, false);
                    }
                }
            }
            Notify();
        }

        /// <summary>지금 이 위치의 EXE로 등록돼 있는지. EXE를 옮겼으면 아니다(다시 등록하면 새 위치로 바뀐다).</summary>
        public static bool IsRegistered(string exe)
        {
            exe = Path.GetFullPath(exe);
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(ClassesKey + @"\" + ProgId + @"\shell\open\command"))
                {
                    return k != null && string.Equals(k.GetValue("") as string, Command(exe), StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        static void Notify()
        {
            // 탐색기가 연결 정보를 다시 읽게 한다 (SHCNE_ASSOCCHANGED).
            NativeMethods.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        }
    }
}
