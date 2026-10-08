namespace MdViewer.Setup
{
    /// <summary>
    /// 설치 프로그램 UI 문자열 표 (NFR-USE-02). 코드에는 한글 문자열을 두지 않고 모두 여기서 가져다 쓴다.
    /// 다른 언어를 더할 때는 이 표만 옮기면 된다(같은 이름의 멤버를 가진 언어별 표로 나누고 시작할 때 고른다).
    /// </summary>
    static class SetupStrings
    {
        // ---- 설치 창
        public const string FormTitle = "MD Viewer 설치";
        public static string InstallDir(string dir) { return "설치 위치: " + dir; }
        public const string AssocOption = "Markdown 파일(.md 등)의 '연결 프로그램' 목록에 추가";
        public const string ContextOption = "탐색기 우클릭 메뉴에 'MD Viewer로 열기' 추가";
        public const string ShortcutOption = "시작 메뉴 바로 가기 만들기";
        public const string WebView2Missing = "WebView2 런타임이 없습니다. 설치 후 실행할 때 안내합니다.";
        public const string Install = "설치";
        public const string Cancel = "취소";
        public const string Installing = "설치하는 중…";
        public const string InstallDoneRunNow = "설치를 마쳤습니다. 지금 실행할까요?";

        // ---- 메시지
        public static string ConfirmUninstall(string app) { return app + "를 제거할까요?"; }
        public static string Uninstalled(string app) { return app + "를 제거했습니다. 설정 파일은 %APPDATA%\\MdViewer 에 남아 있습니다."; }
        public static string InstallFailed(string detail) { return "설치 중 오류가 났습니다.\n\n" + detail; }
        public const string AppRunning = "MD Viewer가 실행 중입니다. 닫은 뒤 다시 설치해 주세요.";

        // ---- 레지스트리·바로 가기에 남는 이름
        public const string DocTypeName = "Markdown 문서";
        public static string OpenWith(string app) { return app + "로 열기"; }
        public const string ShortcutDescription = "Markdown 문서 뷰어";
    }
}
