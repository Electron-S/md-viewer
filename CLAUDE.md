# md-viewer 작업 규칙

## 변경 순서 (항상 지킨다)

기능 추가·수정은 모두 **SRS → SDD → 구현 → 검증** 순서로 한다. 앞 단계를 건너뛰지 않는다. 검증이 끝나면 따로 묻지 않고 **커밋 → 푸시 → 배포 → 스킬 재설치**까지 이어서 한다.

1. **SRS**: `docs/SRS.md`를 먼저 고친다.
   - 요구사항 ID를 더하거나 고친다.
   - 바이라인 날짜·버전과 1.5 변경 이력을 고친다.
   - 해당되면 4장(화면·단축키), 7장(릴리스 범위), 9장(결정 사항)도 고친다.
2. **SDD**: 같은 변경을 `docs/SDD.md`에 옮긴다.
   - 2장 검토 결과, 4장 모듈 표, 5장 데이터, 6장 인터페이스·명령, 9장 빌드·테스트, 10장 추적표 가운데 해당하는 곳.
   - 바이라인 날짜.
3. **구현**:
   - 코드 주석과 테스트 이름에 SRS ID를 그대로 쓴다. UI 문자열은 `web/src/strings.ts`에만 둔다.
   - 새 동작에는 단위 테스트나 E2E 검사를 더한다.
   - 마지막에 버전을 올린다. 대상은 `package.json`·`package-lock.json`, 그리고 README의 버전·크기다. 기능 추가는 minor, 버그 수정은 patch를 올린다.
4. **검증**: `node tools/build.mjs`로 빌드한 그 결과물로 아래를 모두 통과시킨다.
   - `node tools/test.mjs`(화면·실행기 단위 + Windows 앱 단위)
   - `./tools/e2e.sh` 전체
   - 실패하면 원인을 밝혀 고치고 다시 돌린다. 시험 코드를 고쳤다면 그 이유를 커밋 메시지와 보고에 적는다.
   - 결과와 측정값은 `RELEASE_NOTES.md`의 새 절에 적는다.
   - zip에 README가 들어가므로, 빌드 뒤 README를 고쳤으면 다시 빌드한다.
5. **커밋**: main에 한국어 메시지로 커밋한다. 메시지 끝에는 Co-Authored-By 줄을 붙인다.
6. **푸시**: `git push origin main`을 하고, 태그 `v<버전>`을 만들어 푸시한다.
7. **배포**:
   - `gh release create v<버전>`으로 다음 넷을 올린다.
     - `dist/md-viewer-<버전>.zip`: EXE·viewer.html·스킬 폴더·README·LICENSE·제3자 고지를 모두 담은 zip
     - `dist/MDViewer.exe`
     - `dist/viewer.html`
     - `dist/THIRD-PARTY-NOTICES.txt`
   - 본문은 `RELEASE_NOTES.md`의 그 버전 절이다. 문서 안 앵커 링크는 태그 기준 절대 주소로 바꾼다.
   - 올린 zip·EXE를 다시 내려받아 `cmp`로 로컬 파일과 같은지 확인한다.
   - HTML만 내거나 EXE만 내는 릴리스는 하지 않는다.
8. **스킬 재설치**:
   - `node dist/mdview/mdview.mjs --install-skill`로 설치한다.
   - `~/.claude/skills/mdview`의 SKILL.md·mdview.mjs·viewer.html이 `dist/mdview`와 같은지 `cmp`로 확인한다.
   - `mdview --version`이 새 버전인지 확인한다.

## 참고

- SRS·SDD는 저장소의 `docs/`에 Markdown으로 두고, 그 변경은 코드와 같은 커밋에 넣는다. 그림은 Mermaid 코드 블록으로 그리고 이 뷰어로 그려지는지 본다. 2026-10-31에 Claude Docs에서 옮겼고(SRS v0.7까지), Claude Docs의 원본은 더 고치지 않는다.
- E2E는 WSL에서 Windows Python + Playwright로 Edge와 MDViewer.exe를 조종한다. 두 E2E나 빌드를 동시에 돌리지 않는다(측정값이 흔들린다).
- Python 코드는 Windows의 CP949 문제를 피하려고 파일을 바이트나 `encoding='utf-8'`로만 읽고 쓴다.
