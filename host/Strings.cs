namespace MdViewer
{
    /// <summary>
    /// 호스트 UI 문자열 표 (NFR-USE-02). 코드에는 한글 문자열을 두지 않고 모두 여기서 가져다 쓴다.
    /// 다른 언어를 더할 때는 이 표만 옮기면 된다(같은 이름의 멤버를 가진 언어별 표로 나누고 시작할 때 고른다).
    /// 오류 코드(EINVAL 등)는 화면이 판단에 쓰는 값이라 번역 대상이 아니다.
    /// </summary>
    public static class Strings
    {
        // ---- 창·대화상자
        public const string WebView2Required = "MD Viewer를 실행하려면 Microsoft Edge WebView2 런타임이 필요합니다.\n다운로드 페이지를 열까요?";
        public static string WebView2StartFailed(string detail) { return "화면 엔진(WebView2)을 시작하지 못했습니다.\n\n" + detail; }
        public const string OpenDialogTitle = "열기";
        public const string OpenDialogFilter = "Markdown 문서 (*.md;*.markdown;*.mdown;*.mkd)|*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdwn;*.mdtxt;*.mdtext|텍스트 파일 (*.txt)|*.txt|모든 파일 (*.*)|*.*";
        public const string OpenFolderTitle = "폴더 열기";

        // ---- 브리지 오류 메시지 (화면이 그대로 보여준다)
        public const string NoPath = "경로가 없습니다";
        public static string NotAbsolutePath(string path) { return "절대 경로가 아닙니다: " + path; }
        public static string InvalidPath(string detail) { return "잘못된 경로입니다: " + detail; }
        public const string IsFolder = "폴더입니다";
        public const string FileNotFound = "파일이 없습니다";
        public const string FolderNotFound = "폴더가 없습니다";
        public const string FileTooBig = "200 MB를 넘는 파일은 열 수 없습니다";
        public const string AccessDenied = "접근 권한이 없습니다";
        public static string UnsupportedEncoding(string name) { return "지원하지 않는 인코딩입니다: " + name; }
        public const string NotStorable = "저장할 수 없는 항목입니다";
        public static string UnknownStoreName(string name) { return "알 수 없는 저장 항목: " + name; }
        public static string UnknownMethod(string method) { return "알 수 없는 메서드: " + method; }
        public const string UrlNotAllowed = "열 수 없는 주소입니다";

        // ---- 로그
        public static string LogUiException(object ex) { return "UI 예외: " + ex; }
        public static string LogUnhandledException(object ex) { return "처리되지 않은 예외: " + ex; }
        public static string LogRuntimeCheckFailed(string detail) { return "WebView2 런타임 확인 실패: " + detail; }
        public static string LogWebFilesFailed(string detail) { return "화면 파일 읽기 실패: " + detail; }
        public static string LogProcessFailed(object kind) { return "WebView2 프로세스 실패: " + kind; }
        public static string LogWebView2InitFailed(object ex) { return "WebView2 초기화 실패: " + ex; }
        public static string LogBootDataFailed(string detail) { return "부트 데이터 만들기 실패: " + detail; }
        public static string LogBootDocFailed(string path, string detail) { return "부트 문서를 읽지 못함: " + path + " " + detail; }
        public static string LogWindowRestoreFailed(string detail) { return "창 위치 복원 실패: " + detail; }
        public static string LogWindowSaveFailed(string detail) { return "창 위치 저장 실패: " + detail; }
        public const string LogSendToPrimaryFailed = "첫 인스턴스에 경로를 넘기지 못했습니다";
        public static string LogPipeServerError(string detail) { return "파이프 서버 오류: " + detail; }
        public static string LogMethodError(string method, object ex) { return method + " 처리 오류: " + ex; }
        public static string LogTaskError(object ex) { return "작업 오류: " + ex; }
        public static string LogWatchFallback(string dir, string detail) { return "감시를 만들지 못해 폴링으로 대신합니다: " + dir + " " + detail; }
        public static string LogWatchError(object ex) { return "감시 처리 오류: " + ex; }
        public static string LogReadFailed(string path, string detail) { return "읽기 실패 " + path + ": " + detail; }
        public static string LogExternalOpenSkipped(string url, string detail) { return "외부 주소를 열지 않음: " + url + " " + detail; }
    }
}
