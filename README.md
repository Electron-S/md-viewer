# MD Viewer

설치 없이 쓰는 Markdown 뷰어이자 편집기입니다. HTML 파일 하나(`viewer.html`)를 브라우저로 열어 쓰거나, Windows 앱(`MDViewer.exe`)으로 탐색기에서 문서를 바로 열거나, Claude Code에서 "이 문서 열어줘"라고 하면 스킬이 브라우저에 띄워 줍니다. 여러 문서를 위쪽 탭이나 왼쪽 목록으로 열어 두고, 미리보기·원문·분할 보기를 오가며 읽고, 오른쪽 목차와 왼쪽 작업 공간 트리로 이동합니다. 원문·분할 보기에서는 바로 고쳐 원래 인코딩 그대로 저장합니다(v2.0). ```` ```mermaid ```` 블록은 다이어그램으로 그려 보여 줍니다.

- 버전: v2.0.1 ([릴리스 노트](RELEASE_NOTES.md))
- 뷰어: Edge·Chrome 최근 버전(모든 기능), Firefox·Safari 최신판(열기·렌더링·찾기·보기 모드)
- Windows 앱: Windows 10/11 x64. WebView2 런타임과 .NET Framework 4.8이 필요하며 둘 다 Windows에 기본으로 들어 있습니다.
- 실행기·스킬: Node.js 18 이상(Windows 10/11, WSL2, macOS, Linux)
- 크기: `viewer.html` 약 2.8 MB, `MDViewer.exe` 약 3.8 MB, 배포 zip 약 5.7 MB (Mermaid가 약 2 MB를 차지한다)
- 요구사항: [SRS](https://claude.ai/code/artifact/de92e02f-5cc5-40f2-a3ca-80b6b2894cf1) · 설계: [SDD](https://claude.ai/code/artifact/80e2d190-46f7-4ac1-8d38-7a1954577b38) (비공개 문서. 요구사항 ID는 코드 주석과 테스트 이름에 그대로 쓴다)

## 쓰는 방법

[릴리스](https://github.com/Electron-S/md-viewer/releases)에서 받거나 [빌드](#빌드)하면 `dist/`에 `viewer.html`, `MDViewer.exe`, `mdview/`(스킬 폴더)와 이 셋을 모두 담은 `md-viewer-<버전>.zip`이 만들어집니다.

### 1. HTML 파일만 쓰기 (독립 모드)

`viewer.html`을 브라우저로 엽니다(더블클릭 또는 브라우저 창에 끌어다 놓기). 그다음 문서를 끌어다 놓거나 Ctrl+O로 엽니다.

- 파일 여러 개는 각각 탭으로, 폴더는 왼쪽 작업 공간 트리로 엽니다.
- Edge·Chrome에서는 연 파일을 1초마다 확인해, 밖에서 고치면 다시 그립니다. 다음에 열 때는 브라우저가 권한을 다시 물으며, 빈 화면의 "이전 문서 다시 열기" 버튼으로 이어 봅니다.
- 파일 하나만 열면 브라우저가 그 폴더를 읽지 못해 상대 경로 그림·링크를 따라가지 못합니다. 이때 뜨는 "폴더 열기"로 문서가 든 폴더를 고르면 그 기준으로 다시 엽니다.
- file:// 로 연 페이지의 저장소는 같은 브라우저의 다른 로컬 HTML 파일과 함께 쓰입니다. 연 파일·폴더 권한을 남기고 싶지 않으면 메뉴의 "연 파일·폴더 접근 권한 기억"을 끄세요.

### 2. Windows 앱 (MDViewer.exe)

`MDViewer.exe`를 아무 폴더에 두고 실행합니다. 설치하지 않으며 파일 하나로 동작합니다. 자기 창에 뷰어가 뜨고, 문서는 창에 끌어다 놓거나 Ctrl+O로 엽니다. EXE 아이콘에 문서를 끌어다 놓거나 `MDViewer.exe 문서.md 폴더\`처럼 인자로 넘겨도 됩니다.

탐색기에서 .md를 더블클릭해 열려면 한 번 등록합니다.

1. 메뉴 **설정 → 탐색기 연결 프로그램 목록에 MD Viewer 등록**을 누릅니다(`MDViewer.exe --register`와 같습니다. 관리자 권한은 필요 없습니다).
2. 탐색기에서 .md 파일을 오른쪽 클릭 → **연결 프로그램 → 다른 앱 선택 → MD Viewer**를 고르고 "항상 이 앱을 사용"을 켭니다. Windows는 기본 앱을 프로그램이 바꾸지 못하게 하므로 이 선택은 사용자가 합니다. 오른쪽 클릭 메뉴에는 "MD Viewer로 열기"도 생깁니다.

- 이미 떠 있으면 같은 창의 새 탭으로 엽니다(`--new-window`를 주면 새 창).
- 밖에서 파일을 고치면 0.5초 안에 다시 그리고, 창을 닫았다 다시 열면 탭·보기 모드·스크롤 위치를 복원합니다. 파일 경로를 그대로 읽으므로 브라우저처럼 권한을 묻지 않고, 상대 경로 그림·링크도 바로 따라갑니다.
- 문서 안 http(s) 링크는 기본 브라우저로 엽니다. 설정·세션은 `%APPDATA%\MdViewer`, 로그와 WebView2 데이터는 `%LOCALAPPDATA%\MdViewer`에 둡니다.
- 지우려면 메뉴에서 등록을 다시 눌러 해제(`--unregister`)한 뒤 EXE와 위 두 폴더를 지웁니다.
- 코드 서명을 하지 않은 EXE라 처음 실행할 때 Windows가 "Windows의 PC 보호" 경고를 띄울 수 있습니다. "추가 정보 → 실행"으로 엽니다. 회사 보안 정책에 따라서는 서명 없는 EXE 실행이 막힐 수 있습니다.

### 3. Claude Code에서 열기 (실행기 모드)

배포 zip(`md-viewer-<버전>.zip`)을 풀고, 푼 폴더에서 한 번 설치합니다.

```bash
node mdview/mdview.mjs --install-skill
```

`~/.claude/skills/mdview`에 스킬이 들어가고, 터미널에서 바로 쓸 수 있는 `mdview` 명령(POSIX는 `~/.local/bin/mdview`, Windows는 `%USERPROFILE%\.mdview\bin\mdview.cmd`)도 만들어집니다. 그다음 Claude Code에서 "README 열어줘", "방금 만든 보고서 뷰어로 보여줘"처럼 말하면 기본 브라우저에 뷰어가 뜹니다.

터미널에서 직접 쓸 수도 있습니다.

```bash
mdview README.md docs/        # 파일은 탭으로, 폴더는 작업 공간으로
mdview --root . report.md     # 문서가 따라갈 수 있는 폴더를 지정(기본: git 저장소 루트)
mdview --no-open README.md    # 브라우저를 열지 않고 주소만 출력
mdview --status | --stop
```

- 실행기는 이 컴퓨터 안(127.0.0.1)에서만 접속되는 작은 서버입니다. 주소에 든 토큰이 있어야 하고, 허용한 폴더 밖의 파일은 내주지 않습니다. 바깥으로는 통신하지 않습니다.
- 이미 떠 있으면 그 서버를 다시 쓰고, 열린 뷰어 탭이 없는 채로 10분이 지나면 스스로 끝납니다.
- 밖에서 파일을 고치면 0.5초 안에 다시 그립니다. 브라우저 탭을 닫거나 새로 고쳐도 탭·보기 모드·스크롤 위치를 복원합니다.
- WSL에서 실행하면 Windows 기본 브라우저로 엽니다. `C:\…`나 `\\wsl.localhost\…` 같은 Windows 경로도 받습니다.

### 편집과 저장 (v2.0)

원문 보기(Ctrl+2)와 분할 보기(Ctrl+3)에서 문서를 바로 고칩니다. 미리보기(Ctrl+1)는 읽기 전용입니다. 세 쓰는 방법 모두 같습니다.

- 고친 문서는 탭·창 제목에 ●, 상태 표시줄에 "수정됨"이 붙습니다. 실행 취소(Ctrl+Z)로 저장한 내용과 같아지면 표시가 사라집니다. 다시 실행은 Ctrl+Y(또는 Ctrl+Shift+Z)입니다.
- 분할 보기의 미리보기와 목차는 입력을 멈추면 따라 바뀝니다. 목록에서 Enter를 누르면 기호를 이어 쓰고, Tab으로 들여 씁니다.
- **저장(Ctrl+S)** 은 읽은 형식 그대로 씁니다. 인코딩(UTF-8·BOM·UTF-16·CP949)과 줄 끝(CRLF·LF)을 지킵니다. CP949 문서에 CP949로 쓸 수 없는 글자(이모지 등)를 넣었으면 UTF-8로 저장할지 묻습니다.
- **다른 이름으로 저장(Ctrl+Shift+S)**, **새 문서(Alt+Shift+N)**, **찾아 바꾸기(Ctrl+H)** 를 씁니다. 모두 바꾸기는 실행 취소 한 번으로 되돌립니다.
- 저장하지 않은 탭을 닫거나 창을 닫으면 저장·저장 안 함·취소를 묻습니다. 브라우저 탭을 닫거나 새로 고치면 브라우저가 확인 창을 띄웁니다.
- 고치는 중에 밖(Claude Code 등)에서 같은 파일이 바뀌면 덮지 않고 위쪽 띠로 알립니다. 거기서 디스크 내용을 다시 읽을지, 내 것을 둘지 고릅니다. 고치지 않은 문서는 지금처럼 자동으로 다시 읽습니다.
- **설정 → 자동 저장** 을 켜면 입력을 멈추고 1초 뒤, 그리고 다른 탭으로 옮길 때 저장합니다(기본 끔).

어디에 쓸 수 있는지는 방법마다 다릅니다.

| 방법 | 저장 | 다른 이름으로 저장 |
| --- | --- | --- |
| HTML 파일(독립 모드) | 파일 핸들로 연 문서. 처음 저장할 때 브라우저가 쓰기 권한을 묻습니다 | 브라우저 저장 대화상자. 없는 브라우저(Firefox·Safari)는 내려받기 |
| Windows 앱 | 연 파일과 저장 대화상자로 고른 파일 | Windows 저장 대화상자 |
| 실행기·Claude Code | 실행기가 허용한 폴더(연 파일의 저장소·폴더, `--root`) 안 | 경로를 입력합니다. 허용한 폴더 밖이면 그 폴더를 `mdview`로 열거나 `--root`로 허용한 뒤 저장합니다 |

Markdown·텍스트 확장자(.md, .markdown, .txt 등) 파일에만 씁니다. 같은 폴더의 임시 파일에 쓴 뒤 바꿔 넣어, 쓰다 실패해도 원래 파일이 깨지지 않습니다.

### Mermaid 다이어그램

````` ```mermaid ````` 펜스 블록을 다이어그램으로 그립니다(flowchart, sequence, class, state, ER, gantt, pie, mindmap, git graph 등 Mermaid 12.2가 그리는 것 모두, ELK 레이아웃 포함). 세 쓰는 방법 모두 같고, 바깥과 통신하지 않습니다.

- 문서에 다이어그램이 처음 나올 때 뷰어 안에 압축해 둔 Mermaid를 풀어 실행합니다. 그리는 동안에는 원문 코드가 보입니다.
- 다이어그램 안의 글자도 찾기(Ctrl+F)와 복사가 됩니다. 테마를 바꾸면 그 색으로 다시 그립니다.
- 구문이 틀린 다이어그램은 오류 한 줄과 원문을 보여 줍니다.
- 보안 수준은 Mermaid의 `strict`로 고정합니다(`%%{init}%%`로 바꿀 수 없음). 다이어그램 안의 링크(`click … href`)·콜백·이미지는 따르거나 불러오지 않습니다.

### 화면 배치

- 목차는 문서 오른쪽 패널에, 작업 공간 트리는 왼쪽 패널에 있습니다. 왼쪽 패널은 Ctrl+B, 목차 패널은 Ctrl+Alt+B로 숨기거나 보입니다. 패널 경계선을 끌어 너비를 바꿉니다.
- 열린 파일은 위쪽 탭 줄이나 왼쪽 목록으로 보입니다. **보기 → 열린 파일 표시**에서 고릅니다. "왼쪽 목록"을 고르면 Notepad++의 문서 목록처럼 왼쪽 패널 위 칸에 한 줄에 하나씩 늘어서고, 아래 칸에는 작업 공간이 남습니다. 두 칸 사이 경계선을 끌어 높이를 바꿉니다.

단축키 목록은 뷰어에서 F1. 브라우저가 가로채는 키(Ctrl+W, Ctrl+N, Ctrl+Tab 등)를 피해 탭 닫기는 Alt+W, 닫은 탭 다시 열기는 Alt+Shift+T, 다음·이전 탭은 Alt+PageDown/PageUp, 새 문서는 Alt+Shift+N입니다.

## 구조

| 경로 | 내용 |
| --- | --- |
| `web/src/` | 화면(TypeScript). 렌더링(markdown-it + DOMPurify, Mermaid 다이어그램), 탭, 목차, 찾기·바꾸기, 편집 조정자(`edit.ts`: 저장·충돌·닫기 확인), 명령 레지스트리, 브리지(파일 핸들·실행기·Windows 앱) |
| `web/static/` | index.html, CSS |
| `launcher/` | 실행기(Node.js 표준 라이브러리만). 명령, 127.0.0.1 서버(읽기·허용 폴더 안 쓰기), 파일 감시, OS 연동 |
| `host/` | Windows 앱(C# 5, .NET Framework 4.8 + WebView2). 창, 브리지, 파일·감시·저장, 연결 프로그램 등록. 빌드가 viewer.html과 WebView2 DLL을 EXE 안에 넣는다 |
| `skill/` | Claude Code 스킬(SKILL.md) |
| `tests/` | E2E(Windows Python + Playwright + Edge·WebView2), Windows 앱 단위 테스트(`tests/host`), 샘플 |
| `tools/` | 빌드·테스트 스크립트 |

UI 문자열은 `web/src/strings.ts`, `launcher/strings.ts`, `host/Strings.cs` 세 표에만 둡니다(NFR-USE-02). 그 밖의 코드에 한글 문자열을 쓰면 단위 테스트가 실패합니다.

## 빌드

준비물은 Node.js 20 이상입니다(만든 실행기는 Node.js 18에서 돈다). Windows 앱은 Windows나 WSL에서만 만들 수 있습니다. Windows에 들어 있는 .NET Framework 4.8의 `csc.exe`로 컴파일하고, WebView2 SDK는 처음 빌드할 때 NuGet에서 `lib/`로 받습니다. 그 밖의 곳에서는 EXE 단계를 건너뜁니다.

```bash
npm ci
node tools/build.mjs   # 타입 검사 → dist/viewer.html, dist/mdview/, dist/MDViewer.exe, dist/THIRD-PARTY-NOTICES.txt, 크기 검사, dist/md-viewer-<버전>.zip
node tools/test.mjs    # 단위 테스트 135개(화면 89, 실행기 46. CommonMark 스펙 652개·GFM 확장 24개, XSS, 다이어그램 정제, 저장 인코딩 왕복, 쓰기 거부, 문자열 분리 등)
                       # + Windows 앱 단위 테스트 12개(확인 67개, Windows·WSL에서만)
./tools/e2e.sh         # E2E (WSL + Windows Edge + MDViewer.exe. 준비는 tools/e2e.sh 머리말 참고)
```

E2E는 WSL에서 실행기를 띄우고 Windows의 Python + Playwright로 Edge를 조종합니다. Windows 앱은 원격 디버깅 포트로 띄워 그 WebView2에 붙습니다(`./tools/e2e.sh --only desktop`으로 Windows 앱만 돌릴 수 있다). Python은 `PYTHONUTF8=1`로 실행하고 파일은 바이트나 `encoding='utf-8'`로만 다뤄, Windows 기본 코드 페이지(CP949) 문제를 피합니다.

## 진단

- 실행기 로그: `~/.mdview/logs/mdview.log`(UTF-8, 1 MB에서 순환). 실행기 모드의 뷰어 오류도 여기 남습니다.
- 환경 변수: `MDVIEW_HOME`(상태·로그 폴더), `MDVIEW_BROWSER`(브라우저를 여는 명령), `MDVIEW_IDLE_MS`(유휴 종료 시간), `MDVIEW_MAX_BYTES`(읽을 파일 크기 상한), `MDVIEW_VIEWER`(다른 viewer.html).
- Windows 앱 로그: `%LOCALAPPDATA%\MdViewer\logs\mdview.log`. 환경 변수 `MDVIEW_DEVTOOLS=1`(개발자 도구), `MDVIEW_TRACE=1`(시작 단계 시간을 로그에 남김), `MDVIEW_PROFILE_DIR`(설정·로그·WebView2 데이터를 한 폴더로, 시험용).

## 라이선스

[MIT](LICENSE).

- `tests/samples/commonmark-spec.json`은 [CommonMark Spec](https://spec.commonmark.org/0.31.2/)(John MacFarlane), `tests/samples/gfm-extensions.json`은 [GitHub Flavored Markdown Spec](https://github.github.com/gfm/)의 확장 예제를 뽑은 것이며, 두 파일에는 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)이 적용됩니다.
- `viewer.html`에는 npm 의존성(markdown-it·markdown-it-footnote·CodeMirror·Mermaid MIT, markdown-it-task-lists ISC, highlight.js BSD-3-Clause, DOMPurify MPL-2.0 또는 Apache-2.0, 그리고 Mermaid가 쓰는 d3·dagre·cytoscape·KaTeX 등)이 묶여 들어갑니다. ELK 레이아웃(elkjs)은 EPL-2.0이며 소스는 https://github.com/kieler/elkjs 에 있습니다.
- `MDViewer.exe`에는 Microsoft Edge WebView2 SDK의 DLL이 들어갑니다(BSD 형식 라이선스).
- 빌드가 묶인 npm 패키지 전부의 라이선스 전문을 저장소의 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)(WebView2) 뒤에 붙여 `dist/THIRD-PARTY-NOTICES.txt`로 만들고, 릴리스와 스킬 묶음에 넣습니다.
- `tests/samples/mermaid-svg.json`은 Mermaid 12.2.0이 그린 SVG 결과로, 정제 시험에 씁니다.
