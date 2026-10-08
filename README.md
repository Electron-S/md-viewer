# MD Viewer

설치 없이 브라우저에서 여는 Markdown 뷰어입니다. HTML 파일 하나(`viewer.html`)로 동작하고, Claude Code에서 "이 문서 열어줘"라고 하면 스킬이 브라우저에 띄워 줍니다. 탭으로 여러 문서를 열고, 미리보기·원문·분할 보기를 오가며 읽고, 목차와 작업 공간 트리로 이동합니다.

- 버전: v1.0.0 ([릴리스 노트](RELEASE_NOTES.md))
- 뷰어: Edge·Chrome 최근 버전(모든 기능), Firefox·Safari 최신판(열기·렌더링·찾기·보기 모드)
- 실행기·스킬: Node.js 18 이상(Windows 10/11, WSL2, macOS, Linux)
- 크기: `viewer.html` 약 0.75 MB, 스킬 묶음 zip 약 0.27 MB
- 요구사항: [SRS](https://claude.ai/code/artifact/de92e02f-5cc5-40f2-a3ca-80b6b2894cf1) · 설계: [SDD](https://claude.ai/code/artifact/80e2d190-46f7-4ac1-8d38-7a1954577b38) (비공개 문서. 요구사항 ID는 코드 주석과 테스트 이름에 그대로 쓴다)

## 쓰는 방법

[빌드](#빌드)하면 `dist/`에 `viewer.html`, `mdview/`(스킬 폴더), `mdview-<버전>.zip`이 만들어집니다.

### 1. HTML 파일만 쓰기 (독립 모드)

`viewer.html`을 브라우저로 엽니다(더블클릭 또는 브라우저 창에 끌어다 놓기). 그다음 문서를 끌어다 놓거나 Ctrl+O로 엽니다.

- 파일 여러 개는 각각 탭으로, 폴더는 왼쪽 작업 공간 트리로 엽니다.
- Edge·Chrome에서는 연 파일을 1초마다 확인해, 밖에서 고치면 다시 그립니다. 다음에 열 때는 브라우저가 권한을 다시 물으며, 빈 화면의 "이전 문서 다시 열기" 버튼으로 이어 봅니다.
- 파일 하나만 열면 브라우저가 그 폴더를 읽지 못해 상대 경로 그림·링크를 따라가지 못합니다. 이때 뜨는 "폴더 열기"로 문서가 든 폴더를 고르면 그 기준으로 다시 엽니다.
- file:// 로 연 페이지의 저장소는 같은 브라우저의 다른 로컬 HTML 파일과 함께 쓰입니다. 연 파일·폴더 권한을 남기고 싶지 않으면 메뉴의 "연 파일·폴더 접근 권한 기억"을 끄세요.

### 2. Claude Code에서 열기 (실행기 모드)

스킬 묶음(`dist/mdview-<버전>.zip`)을 풀고 한 번 설치합니다.

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

단축키 목록은 뷰어에서 F1. 브라우저가 가로채는 키(Ctrl+W, Ctrl+Tab 등)를 피해 탭 닫기는 Alt+W, 닫은 탭 다시 열기는 Alt+Shift+T, 다음·이전 탭은 Alt+PageDown/PageUp입니다.

## 구조

| 경로 | 내용 |
| --- | --- |
| `web/src/` | 화면(TypeScript). 렌더링(markdown-it + DOMPurify), 탭, 목차, 찾기, 명령 레지스트리, 브리지(파일 핸들·실행기) |
| `web/static/` | index.html, CSS |
| `launcher/` | 실행기(Node.js 표준 라이브러리만). 명령, 127.0.0.1 서버, 파일 감시, OS 연동 |
| `skill/` | Claude Code 스킬(SKILL.md) |
| `tests/` | E2E(Windows Python + Playwright + Edge), 샘플 |
| `tools/` | 빌드·테스트 스크립트 |

UI 문자열은 `web/src/strings.ts`와 `launcher/strings.ts` 두 표에만 둡니다(NFR-USE-02). 그 밖의 코드에 한글 문자열을 쓰면 단위 테스트가 실패합니다.

## 빌드

준비물은 Node.js 20 이상입니다(만든 실행기는 Node.js 18에서 돈다).

```bash
npm ci
node tools/build.mjs   # 타입 검사 → dist/viewer.html, dist/mdview/, dist/mdview-<버전>.zip, 크기 검사
node tools/test.mjs    # 단위 테스트 88개(화면 56, 실행기 32. CommonMark 스펙 652개·GFM 확장 24개, XSS, 문자열 분리 등)
./tools/e2e.sh         # E2E (WSL + Windows Edge. 준비는 tools/e2e.sh 머리말 참고)
```

E2E는 WSL에서 실행기를 띄우고 Windows의 Python + Playwright로 Edge를 조종합니다. Python은 `PYTHONUTF8=1`로 실행하고 파일은 바이트나 `encoding='utf-8'`로만 다뤄, Windows 기본 코드 페이지(CP949) 문제를 피합니다.

## 진단

- 실행기 로그: `~/.mdview/logs/mdview.log`(UTF-8, 1 MB에서 순환). 실행기 모드의 뷰어 오류도 여기 남습니다.
- 환경 변수: `MDVIEW_HOME`(상태·로그 폴더), `MDVIEW_BROWSER`(브라우저를 여는 명령), `MDVIEW_IDLE_MS`(유휴 종료 시간), `MDVIEW_MAX_BYTES`(읽을 파일 크기 상한), `MDVIEW_VIEWER`(다른 viewer.html).

## 라이선스

[MIT](LICENSE).

- `tests/samples/commonmark-spec.json`은 [CommonMark Spec](https://spec.commonmark.org/0.31.2/)(John MacFarlane), `tests/samples/gfm-extensions.json`은 [GitHub Flavored Markdown Spec](https://github.github.com/gfm/)의 확장 예제를 뽑은 것이며, 두 파일에는 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)이 적용됩니다.
- `viewer.html`에는 npm 의존성(markdown-it·markdown-it-footnote·CodeMirror MIT, markdown-it-task-lists ISC, highlight.js BSD-3-Clause, DOMPurify MPL-2.0 또는 Apache-2.0)이 묶여 들어갑니다.
