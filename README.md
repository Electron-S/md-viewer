# MD Viewer

Notepad++처럼 가볍게 뜨는 Windows용 Markdown 뷰어입니다. 탭으로 여러 문서를 열고, 미리보기·원문·분할 보기를 오가며 읽고, 목차와 작업 공간 트리로 이동합니다. 편집 기능은 v2.0에서 붙일 수 있게 구조를 잡아 두었습니다.

- 요구사항: [SRS](https://claude.ai/code/artifact/de92e02f-5cc5-40f2-a3ca-80b6b2894cf1) · 설계: [SDD](https://claude.ai/code/artifact/80e2d190-46f7-4ac1-8d38-7a1954577b38) (원본은 Claude Docs, 요구사항 ID는 코드 주석과 테스트 이름에 그대로 쓴다)
- 실행 환경: Windows 10 22H2 / 11 x64, Microsoft Edge WebView2 런타임(Windows 11 기본 탑재)
- 설치 크기: 약 2 MB (setup.exe 0.7 MB)

## 쓰기

- 설치: `dist/MdViewer-<버전>-setup.exe` 실행. 관리자 권한 없이 `%LOCALAPPDATA%\Programs\MdViewer`에 설치하고, 시작 메뉴·연결 프로그램 목록·탐색기 우클릭 메뉴를 등록합니다. 제거는 Windows 설정의 앱 목록에서 합니다.
- 포터블: `dist/MdViewer-<버전>-portable.zip`을 풀고 `mdview.exe` 실행. 설정은 같은 폴더의 `data\`에 저장됩니다.
- 명령줄: `mdview [파일 또는 폴더 ...]`. 이미 실행 중이면 기존 창의 새 탭으로 엽니다. `--new-window`는 새 창.
- 단축키 목록은 앱에서 F1.

## 구조

| 경로 | 내용 |
| --- | --- |
| `host/` | C# 호스트(.NET Framework 4.8 WinForms + WebView2). 창, 파일 읽기·인코딩 판별, 감시, 저장, 단일 인스턴스 |
| `web/src/` | TypeScript 화면. 렌더링(markdown-it + DOMPurify), 탭, 목차, 찾기, 명령 레지스트리 |
| `web/static/` | index.html, CSS |
| `setup/` | 설치 프로그램 |
| `tests/` | 호스트 단위 테스트, E2E(Windows Python + Playwright), 샘플 |
| `tools/` | 빌드·테스트 스크립트 |

UI 문자열은 `web/src/strings.ts`, `host/Strings.cs`, `setup/SetupStrings.cs` 세 표에만 둡니다(NFR-USE-02). 그 밖의 코드에 한글 문자열을 쓰면 화면 단위 테스트가 실패합니다.

## 빌드 (WSL)

```bash
npm ci
./tools/build.sh        # 화면 번들 → csc.exe로 호스트·테스트·setup 컴파일 → build/, dist/
node tools/test-web.mjs # 화면 단위 테스트 (CommonMark 스펙 652개, XSS 등)
./tools/test-host.sh    # 호스트 단위 테스트 (인코딩, 파일, 감시, 저장)
./tools/e2e.sh          # 실제 앱 E2E (준비: tools/e2e.sh 머리말 참고)
```

C# 소스는 UTF-8이고 `csc.exe`에 `-codepage:65001`을 넘깁니다. Windows 기본 코드 페이지(CP949)로 읽으면 한글 문자열이 깨집니다. E2E용 Python도 `PYTHONUTF8=1`로 실행하고 파일은 항상 `encoding='utf-8'`로 엽니다.

## 진단

- `MDVIEW_TRACE=1`: 시작 단계별 시각을 로그(`%LOCALAPPDATA%\MdViewer\logs\mdview.log`)에 남깁니다.
- `MDVIEW_DEVTOOLS=1`: 개발자 도구를 켭니다.
- `MDVIEW_PROFILE_DIR=<폴더>`: 설정·로그·WebView2 데이터를 한 폴더로 모읍니다(테스트 격리용).
