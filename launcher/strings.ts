/**
 * 실행기 문자열 (NFR-USE-02). 실행기 코드에는 문자열을 직접 쓰지 않고 여기서 가져다 쓴다.
 * 다른 언어를 더하려면 `LauncherStrings` 형식에 맞춘 표를 만들고 `L`이 그 표를 가리키게 한다.
 */
const ko = {
  help: [
    'MD Viewer 실행기',
    '',
    '사용법: mdview [옵션] [파일 또는 폴더 ...]',
    '  파일은 탭으로, 폴더는 작업 공간으로 브라우저의 뷰어에서 연다.',
    '',
    '옵션:',
    '  --root <폴더>          뷰어가 읽을 수 있는 폴더(기본: 파일이 든 git 저장소 루트 또는 파일 폴더)',
    '  --no-open              브라우저를 열지 않고 주소만 출력',
    '  --port <번호>          실행기가 먼저 시도할 포트',
    '  --status               실행기 상태 출력',
    '  --stop                 실행기 멈추기',
    '  --install-skill [폴더] Claude Code 스킬 설치(기본: ~/.claude/skills/mdview)',
    '  --version              버전 출력',
    '  --help                 이 도움말',
    '',
    'WSL에서는 Windows 경로(C:\\…, \\\\wsl.localhost\\…)를 WSL 경로로 바꿔 연다.',
    '네트워크 공유(\\\\서버\\공유)는 Windows에서 실행한 실행기만 열 수 있다.',
  ].join('\n'),

  // ---- 명령줄
  opening: (n: number) => `문서 ${n}개를 브라우저의 뷰어에서 엽니다.`,
  openingFolder: (n: number) => `폴더 ${n}개를 작업 공간으로 엽니다.`,
  openingEmpty: '빈 뷰어를 엽니다.',
  noOpen: '브라우저를 열지 않았습니다. 아래 주소를 브라우저에서 여세요.',
  browserFailed: '브라우저를 열지 못했습니다. 아래 주소를 브라우저에서 직접 여세요.',
  notFound: (p: string) => `파일이나 폴더가 없습니다: ${p}`,
  badOption: (o: string) => `알 수 없는 옵션입니다: ${o}`,
  needValue: (o: string) => `${o} 다음에 값이 필요합니다.`,
  badPort: (v: string) => `포트 번호가 아닙니다: ${v}`,
  serverFailed: (log: string) => `실행기를 시작하지 못했습니다. 로그를 확인하세요: ${log}`,
  stopped: '실행기를 멈췄습니다.',
  notRunning: '실행 중인 실행기가 없습니다.',
  status: (port: number, pid: number) => `실행 중: 127.0.0.1:${port} (pid ${pid})`,
  installed: (dir: string) => `Claude Code 스킬을 설치했습니다: ${dir}`,
  installMissing: (f: string) => `스킬 파일이 없습니다: ${f}`,
  shimWritten: (f: string) => `mdview 명령을 만들었습니다: ${f}`,
  onPath: (dir: string) => `${dir} 폴더가 PATH에 있어 어디서나 mdview로 실행할 수 있습니다.`,
  notOnPath: (dir: string) => `${dir} 폴더를 PATH에 더하면 어디서나 mdview로 실행할 수 있습니다.`,
  uncUnsupported: (p: string) => `WSL에서 실행한 실행기는 네트워크 공유를 열 수 없습니다. Windows에서 실행한 실행기를 쓰세요: ${p}`,
  wslpathFailed: (p: string) => `Windows 경로를 WSL 경로로 바꾸지 못했습니다: ${p}`,
  lockBusy: (f: string) => `다른 실행기가 시작하는 중입니다. 잠시 뒤 다시 시도하세요: ${f}`,
  versionRestart: (old: string) => `다른 버전(${old || '?'})의 실행기를 멈추고 새로 띄웁니다.`,

  // ---- 서버 오류 응답(화면은 code로 자기 문구를 고르고, message는 대신 쓸 글)
  err: {
    forbidden: '접근이 거부되었습니다',
    noApi: '없는 API입니다',
    badRequest: '잘못된 요청입니다',
    outside: '허용된 폴더 밖입니다',
    noFile: '파일이 없습니다',
    isDir: '폴더입니다',
    notDir: '폴더가 아닙니다',
    tooBig: '파일이 너무 큽니다',
    notImage: '이미지 파일이 아닙니다',
    denied: '접근 권한이 없습니다',
    internal: '실행기 내부 오류',
    viewerMissing: 'viewer.html이 없습니다',
  },

  // ---- 로그
  log: {
    started: (port: number, pid: number) => `실행기 시작: 127.0.0.1:${port} (pid ${pid})`,
    stopping: (why: string) => `실행기 종료: ${why}`,
    idle: '연결된 뷰어 없이 유휴 시간이 지남',
    stopRequest: '종료 요청',
    signal: (s: string) => `신호 ${s}`,
    requestFailed: (url: string, msg: string) => `요청 처리 오류 ${url}: ${msg}`,
    watchFallback: (dir: string, msg: string) => `폴더 감시를 만들지 못해 폴링으로 대신함: ${dir} ${msg}`,
    rootAdded: (root: string) => `허용 폴더 추가: ${root}`,
    viewer: (msg: string) => `[뷰어] ${msg}`,
    uncaught: (msg: string) => `처리되지 않은 오류: ${msg}`,
  },
};

export type LauncherStrings = typeof ko;

export const L: LauncherStrings = ko;
