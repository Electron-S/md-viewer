/**
 * 화면 UI 문자열 (NFR-USE-02). 화면 코드에는 문자열을 직접 쓰지 않고 여기서 가져다 쓴다.
 * 다른 언어를 더하려면 `Strings` 형식에 맞춘 표(예: en)를 만들고 `S`가 그 표를 가리키게 한다.
 * 이 파일 밖에 한글 문자열이 생기면 web/test/strings.test.ts가 잡아낸다.
 */
const ko = {
  appName: 'MD Viewer',
  windowTitle: (name: string) => `${name} - MD Viewer`,

  /** index.html의 data-s 키 */
  page: {
    tocTab: '목차',
    workspaceTab: '작업 공간',
    resizer: '패널 너비',
    emptyHint: 'Ctrl+O로 파일을 열거나, 파일·폴더를 끌어다 놓으세요.',
    emptyOpen: '파일 열기',
    emptyFolder: '폴더 열기',
    emptyRecent: '최근 파일',
    emptyRestore: '이전 문서 다시 열기',
  },

  mode: { preview: '미리보기', source: '원문 보기', split: '분할 보기' },

  cmd: {
    fileOpen: '열기…',
    fileOpenFolder: '폴더 열기…',
    fileReload: '새로 고침',
    fileCloseTab: '탭 닫기',
    fileCloseOthers: '다른 탭 모두 닫기',
    fileReopenClosed: '닫은 탭 다시 열기',
    fileCopyPath: '파일 경로 복사',
    fileReveal: '탐색기에서 파일 위치 열기',
    filePrint: '인쇄…',
    fileClearRecent: '최근 목록 지우기',
    fileRestoreSession: '이전 문서 다시 열기',
    rememberHandles: '연 파일·폴더 접근 권한 기억 (독립 모드)',
    reserved: '다음 버전에서 지원할 기능',
    viewWordWrap: '자동 줄 바꿈 (원문 보기)',
    viewZoomIn: '확대',
    viewZoomOut: '축소',
    viewZoomReset: '원래 크기',
    viewSidePanel: '사이드 패널',
    viewToc: '목차',
    viewWorkspace: '작업 공간',
    themeLight: '라이트',
    themeDark: '다크',
    themeSystem: '시스템 설정 따르기',
    viewRemoteImages: '원격 이미지 불러오기',
    tabNext: '다음 탭',
    tabPrev: '이전 탭',
    findOpen: '찾기…',
    findNext: '다음 찾기',
    findPrev: '이전 찾기',
    reopenWithEncoding: (label: string) => `${label}로 다시 읽기`,
    helpShortcuts: '단축키 목록',
    helpAbout: 'MD Viewer 정보',
  },

  menu: {
    file: '파일',
    view: '보기',
    find: '찾기',
    go: '이동',
    encoding: '인코딩',
    settings: '설정',
    help: '도움말',
    recentFiles: '최근 파일',
    recentFolders: '최근 폴더',
    theme: '테마',
    none: '(없음)',
    empty: '(비어 있음)',
    currentEncoding: (label: string) => `현재: ${label}`,
  },

  dialog: {
    ok: '확인',
    version: (v: string) => `버전 ${v}`,
    modeStandalone: '독립 모드: 브라우저에서 직접 연 뷰어',
    modeLauncher: '실행기 모드: mdview 실행기가 띄운 뷰어',
    storage: '설정·세션 위치: 이 브라우저의 저장소',
  },

  picker: { documents: 'Markdown·텍스트 문서' },

  toast: {
    hostInitFailed: (msg: string) => `호스트 초기화 실패: ${msg}`,
    cannotOpen: (name: string, msg: string) => `열 수 없습니다: ${name} — ${msg}`,
    copied: '복사했습니다',
    notInFolder: '고른 폴더에 이 문서가 없습니다. 문서가 든 폴더를 고르세요.',
    restoreNone: '다시 열 수 있는 문서가 없습니다.',
    notYet: '이 단축키의 기능은 다음 버전에서 지원합니다.',
  },

  preview: {
    binary: '바이너리 파일이라 내용을 표시하지 않습니다.',
    largeFile: (size: string) => `큰 파일(${size})이라 미리보기를 자동으로 그리지 않았습니다.`,
    renderLarge: '미리보기 그리기',
    docFailed: (msg: string) => `이 문서를 렌더링하지 못해 원문을 표시합니다: ${msg}`,
    blockFailed: (msg: string) => `이 블록을 렌더링하지 못해 원문을 표시합니다: ${msg}`,
    needFolder: '이 문서의 상대 경로 이미지·링크를 보려면 문서가 든 폴더를 여세요.',
    openFolder: '폴더 열기',
  },

  /** 실행기 모드에서 새 뷰어 탭이 열려 이 탭이 물러났을 때 (SDD 7.3) */
  retired: {
    title: 'MD Viewer (새 탭으로 옮겨짐)',
    text: '이 뷰어의 문서는 새로 연 뷰어 탭으로 옮겨졌습니다. 이 탭은 닫아도 됩니다.',
  },

  toc: { label: '목차', empty: '제목이 없습니다', untitled: '(제목 없음)' },

  workspace: {
    refresh: '새로 고침',
    close: '작업 공간 닫기',
    noFolder: '폴더가 열려 있지 않습니다',
    openFolder: '폴더 열기',
    loading: '읽는 중…',
    unreadable: '읽을 수 없습니다',
    noDocs: '표시할 문서가 없습니다',
  },

  find: {
    placeholder: '찾기',
    inputLabel: '찾을 내용',
    caseSensitive: '대소문자 구분',
    wholeWordButton: '단어',
    wholeWord: '단어 단위로',
    regex: '정규식',
    prev: '이전 찾기 (Shift+F3)',
    next: '다음 찾기 (F3)',
    close: '닫기 (Esc)',
    noResult: '결과 없음',
    count: (n: number) => `${n}개`,
    regexError: '정규식 오류',
  },

  status: {
    reopenEncoding: '다른 인코딩으로 다시 읽기',
    noEol: '줄 끝 없음',
    lines: (n: string) => `${n}줄`,
    words: (n: string) => `${n}단어`,
    chars: (n: string) => `${n}자`,
    decodeWarning: '⚠ 읽지 못한 문자가 있음',
    deleted: '디스크에서 삭제됨',
    offline: '⚠ 실행기 연결 끊김',
  },

  tab: {
    deletedTooltip: '(디스크에서 삭제됨)',
    deletedSuffix: ' (삭제됨)',
    closeTooltip: '탭 닫기 (Ctrl+W)',
    close: '탭 닫기',
  },

  error: {
    host: '파일을 읽지 못했습니다',
    noFile: '파일이 없습니다',
    accessDenied: '접근 권한이 없습니다',
    isFolder: '폴더입니다',
    tooBig: '200 MB를 넘는 파일은 열 수 없습니다',
    notSupported: '이 방식으로 연 파일에서는 할 수 없습니다. 파일을 다시 열어 주세요.',
    badPath: '열 수 없는 위치입니다',
    offline: '실행기에 연결할 수 없습니다. mdview로 다시 열어 주세요.',
    sourceModuleMissing: '원문 보기 모듈이 없습니다',
    sourceModuleLoad: '원문 보기 모듈을 불러오지 못했습니다',
    missingElement: (id: string) => `#${id} 없음`,
  },

  /** 호스트 로그로 보내는 화면 오류 */
  log: {
    restoreFailed: (msg: string) => `세션 복원 실패: ${msg}`,
    reloadFailed: (path: string, msg: string) => `다시 읽기 실패: ${path} ${msg}`,
    renderFailed: (path: string, msg: string) => `렌더링 실패: ${path} ${msg}`,
    blockFailed: (path: string, line: number, msg: string) => `블록 렌더링 실패: ${path}:${line + 1} ${msg}`,
  },

};

export type Strings = typeof ko;

export const S: Strings = ko;

/** index.html에서 data-s(글자)·data-s-title(툴팁) 키가 붙은 요소를 채운다. 첫 그리기 전에 부른다. */
export function applyPageStrings(root: ParentNode) {
  const page: Record<string, string> = S.page;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-s]'))) el.textContent = page[el.dataset.s!] ?? '';
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-s-title]'))) el.title = page[el.dataset.sTitle!] ?? '';
}
