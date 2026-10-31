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
    tocTitle: '목차',
    workspaceTitle: '작업 공간',
    openFilesTitle: '열린 파일',
    resizer: '패널 너비',
    splitter: '목록 높이',
    emptyHint: 'Ctrl+O로 파일을 열거나, 파일·폴더를 끌어다 놓으세요.',
    emptyOpen: '파일 열기',
    emptyFolder: '폴더 열기',
    emptyRecent: '최근 파일',
    emptyRestore: '이전 문서 다시 열기',
  },

  mode: { preview: '미리보기', source: '원문 보기', split: '분할 보기' },

  cmd: {
    fileNew: '새 문서',
    fileSave: '저장',
    fileSaveAs: '다른 이름으로 저장…',
    editUndo: '실행 취소',
    editRedo: '다시 실행',
    editReplace: '찾아 바꾸기…',
    autoSave: '자동 저장',
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
    openWith: '탐색기 연결 프로그램 목록에 MD Viewer 등록',
    reserved: '다음 버전에서 지원할 기능',
    gotoLine: '줄로 이동…',
    nextChange: '다음 바뀐 곳',
    prevChange: '이전 바뀐 곳',
    copyLocation: '위치 복사 (Claude에 붙여 넣기)',
    viewWordWrap: '자동 줄 바꿈 (원문 보기)',
    viewZoomIn: '확대',
    viewZoomOut: '축소',
    viewZoomReset: '원래 크기',
    viewSidePanel: '왼쪽 패널',
    viewToc: '목차 패널',
    openFilesTabs: '위쪽 탭',
    openFilesList: '왼쪽 목록',
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
    edit: '편집',
    view: '보기',
    find: '찾기',
    go: '이동',
    encoding: '인코딩',
    settings: '설정',
    help: '도움말',
    recentFiles: '최근 파일',
    recentFolders: '최근 폴더',
    theme: '테마',
    openFiles: '열린 파일 표시',
    none: '(없음)',
    empty: '(비어 있음)',
    currentEncoding: (label: string) => `현재: ${label}`,
  },

  dialog: {
    ok: '확인',
    cancel: '취소',
    version: (v: string) => `버전 ${v}`,
    modeStandalone: '독립 모드: 브라우저에서 직접 연 뷰어',
    modeLauncher: '실행기 모드: mdview 실행기가 띄운 뷰어',
    modeDesktop: 'Windows 앱: MDViewer.exe',
    storage: '설정·세션 위치: 이 브라우저의 저장소',
    storageDesktop: (dir: string) => `설정·세션 위치: ${dir}`,
  },

  picker: { documents: 'Markdown·텍스트 문서' },

  toast: {
    hostInitFailed: (msg: string) => `뷰어를 시작하지 못했습니다: ${msg}`,
    cannotOpen: (name: string, msg: string) => `열 수 없습니다: ${name} — ${msg}`,
    copied: '복사했습니다',
    copiedLocation: (loc: string) => `위치를 복사했습니다: ${loc}`,
    notInFolder: '고른 폴더에 이 문서가 없습니다. 문서가 든 폴더를 고르세요.',
    restoreNone: '다시 열 수 있는 문서가 없습니다.',
    notYet: (name: string) => `${name}: 다음 버전에서 지원할 기능입니다.`,
    notViewable: (name: string) => `문서가 아닌 파일은 뷰어에서 열지 않습니다: ${name}`,
    openWithOn: '등록했습니다. 탐색기에서 .md 파일을 오른쪽 클릭 → 연결 프로그램에서 MD Viewer를 고르세요.',
    openWithOff: '연결 프로그램 목록에서 뺐습니다.',
  },

  /** 아직 없는 기능의 이름. 그 단축키를 누르면 알린다 (SRS 4.2). */
  later: {
    back: '뒤로 가기',
    forward: '앞으로 가기',
    quickOpen: '빠른 열기',
    findInFolder: '폴더에서 찾기',
  },

  /** 줄로 이동 (FR-NAV-05) */
  gotoLine: {
    title: '줄로 이동',
    label: (total: number) => `줄 번호 (1~${total})`,
    invalid: (v: string) => `줄 번호가 아닙니다: ${v}`,
  },

  preview: {
    /** 코드 블록 복사 버튼 (FR-REN-09) */
    copyCode: '복사',
    copyCodeTitle: '코드 복사',
    binary: '바이너리 파일이라 내용을 표시하지 않습니다.',
    largeFile: (size: string) => `큰 파일(${size})이라 미리보기를 자동으로 그리지 않았습니다.`,
    renderLarge: '미리보기 그리기',
    docFailed: (msg: string) => `이 문서를 렌더링하지 못해 원문을 표시합니다: ${msg}`,
    blockFailed: (msg: string) => `이 블록을 렌더링하지 못해 원문을 표시합니다: ${msg}`,
    /** Mermaid 다이어그램을 그리지 못했을 때 (FR-REN-07) */
    diagramFailed: (msg: string) => `이 다이어그램을 그리지 못해 원문을 표시합니다: ${msg}`,
    /** 문서 앞머리(YAML front matter) 상자의 제목 (FR-REN-08) */
    frontMatter: '메타데이터',
    needFolder: '이 문서의 상대 경로 이미지·링크를 보려면 문서가 든 폴더를 여세요.',
    openFolder: '폴더 열기',
  },

  /** 편집과 저장 (FR-EDIT-01~10) */
  edit: {
    untitled: (n: number) => `제목 없음 ${n}.md`,
    closeTitle: '저장하지 않은 변경',
    closeBody: (name: string) => `${name}의 변경 내용을 저장할까요?`,
    save: '저장',
    dontSave: '저장 안 함',
    cancel: '취소',
    conflictTitle: '파일이 바뀜',
    conflictBody: (name: string) => `${name}을(를) 읽은 뒤 다른 프로그램이 파일을 바꿨습니다. 내 내용으로 덮어쓸까요?`,
    existsBody: (name: string) => `${name}이(가) 이미 있습니다. 바꿀까요?`,
    overwrite: '덮어쓰기',
    encodingTitle: '인코딩',
    unencodableBody: (enc: string, chars: string) => `${enc}로 나타낼 수 없는 글자(${chars})가 있습니다. UTF-8로 바꿔 저장할까요?`,
    saveUtf8: 'UTF-8로 저장',
    lossyBody: '이 문서는 읽을 때 잘못된 바이트가 있었습니다. 저장하면 그 자리가 대체 문자(�)로 바뀝니다. 저장할까요?',
    mixedEol: (eol: string) => `줄 끝이 섞여 있어 ${eol}로 맞춰 저장했습니다.`,
    downloaded: (name: string) => `내려받기 폴더에 저장했습니다: ${name}`,
    saveFailed: (name: string, msg: string) => `저장하지 못했습니다: ${name} — ${msg}`,
    writeDenied: '쓰기 권한이 없습니다. 다시 저장하면(Ctrl+S) 브라우저가 권한을 묻습니다.',
    autoSavePaused: (name: string, msg: string) => `자동 저장을 멈췄습니다: ${name} — ${msg}`,
    binary: '바이너리 파일은 편집·저장하지 않습니다.',
    discardTitle: '변경 내용 버리기',
    discardBody: (name: string) => `${name}의 저장하지 않은 변경을 버리고 디스크에서 다시 읽을까요?`,
    discard: '버리고 다시 읽기',
    changedBar: '밖에서 파일이 바뀌었습니다. 이 탭에는 저장하지 않은 변경이 있습니다.',
    reloadDisk: '디스크 내용으로 다시 읽기',
    keepMine: '내 것 유지',
    saveAsTitle: '다른 이름으로 저장',
    saveAsLabel: '저장할 파일 경로',
    saveAsHint: (roots: string) => `실행기가 허용한 폴더 안에만 저장할 수 있습니다: ${roots}`,
    outsideRoots: '허용된 폴더 밖입니다. 그 폴더를 mdview로 열거나 mdview --root <폴더>로 허용한 뒤 저장하세요.',
    notDocument: 'Markdown·텍스트 확장자(.md, .txt 등)로 저장하세요.',
    alreadyOpenDirty: (name: string) => `${name}이(가) 다른 탭에서 저장하지 않은 채 열려 있어 그 이름으로 저장할 수 없습니다.`,
    handoverBlocked: '새 뷰어 탭이 열렸지만, 저장하지 않은 문서가 있어 이 탭을 그대로 둡니다.',
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
    replacePlaceholder: '바꿀 내용',
    replaceLabel: '바꿀 내용',
    replaceOne: '바꾸기',
    replaceAll: '모두 바꾸기',
    replaceOneTitle: '바꾸기 (Enter)',
    replaceAllTitle: '모두 바꾸기 (Ctrl+Alt+Enter)',
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
    modified: '수정됨',
    /** 밖에서 바뀐 곳 (FR-WATCH-05). index는 옮겨 간 바뀐 곳(0부터) */
    changes: (n: number, index: number | null) => (index == null ? `바뀐 곳 ${n}` : `바뀐 곳 ${index + 1}/${n}`),
    changesTitle: '밖에서 바뀐 곳. 누르면 다음 바뀐 곳으로 갑니다 (Alt+F5, 이전은 Shift+Alt+F5)',
  },

  tab: {
    deletedTooltip: '(디스크에서 삭제됨)',
    deletedSuffix: ' (삭제됨)',
    dirtyMark: '● ',
    dirtyTooltip: '(저장하지 않은 변경)',
    closeTooltip: '탭 닫기 (Alt+W)',
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
    conflict: '파일을 읽은 뒤 다른 프로그램이 바꿨습니다',
    exists: '같은 이름의 파일이 이미 있습니다',
    offline: '실행기에 연결할 수 없습니다. mdview로 다시 열어 주세요.',
    sourceModuleMissing: '원문 보기 모듈이 없습니다',
    diagramModuleMissing: '다이어그램(Mermaid) 모듈이 없습니다',
    diagramInvalid: '다이어그램 결과가 올바른 SVG가 아닙니다',
    missingElement: (id: string) => `#${id} 없음`,
  },

  /** 로그(실행기 모드는 실행기 로그, 독립 모드는 브라우저 콘솔)로 보내는 화면 오류 */
  log: {
    restoreFailed: (msg: string) => `세션 복원 실패: ${msg}`,
    reloadFailed: (path: string, msg: string) => `다시 읽기 실패: ${path} ${msg}`,
    renderFailed: (path: string, msg: string) => `렌더링 실패: ${path} ${msg}`,
    blockFailed: (path: string, line: number, msg: string) => `블록 렌더링 실패: ${path}:${line + 1} ${msg}`,
    diagramFailed: (path: string, line: number, msg: string) => `다이어그램 실패: ${path}:${line + 1} ${msg}`,
    diagramModuleFailed: (msg: string) => `다이어그램 모듈을 불러오지 못함: ${msg}`,
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
