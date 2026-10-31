import { createBridge, HostError, type HostDoc, type PathEntry, type ReadyInfo } from './bridge';
import { markChangedBlocks, stepChange } from './changes';
import { CommandRegistry } from './commands';
import { DocStore, encodingLabel, formatSize, type DocModel, type Encoding } from './docs';
import { locationText, previewSelectionLines } from './locref';
import { EditController } from './edit';
import { DiagramRenderer } from './render/diagrams';
import { createMarkdown, DIAGRAM_CLASS, renderMarkdown, scanHeadings, type Heading } from './render/markdown';
import { basename, dirname, docKey, isUntitledPath } from './render/paths';
import { Slugger } from './render/slug';
import { createSanitizer, isViewablePath } from './render/sanitize';
import {
  Debouncer, LIST_MIN, MAX_RECENT_FILES, MAX_RECENT_FOLDERS, PANEL_MAX, PANEL_MIN, parseSession, parseSettings, pushRecent, SCHEMA_VERSION,
  defaultSession, defaultSettings, ZOOM_MAX, ZOOM_MIN, type OpenFilesView, type SessionData, type Settings, type Theme,
} from './session';
import { TabManager, type Tab, type ViewMode } from './tabs';
import { TocPanel } from './panels/toc';
import { WorkspacePanel } from './panels/workspace';
import { addCodeTools, chunkBlocks, PreviewView, type LinkAction } from './views/preview';
import type { SourceView } from './views/source';
import { ScrollSync } from './views/sync';
import type { FindQuery, FindStatus } from './views/find';
import { MenuBar, type MenuDef, type MenuEntry } from './ui/menubar';
import { TabBar } from './ui/tabbar';
import { StatusBar } from './ui/statusbar';
import { FindBar } from './ui/findbar';
import { promptText, showDialog, toast } from './ui/dialog';
import { applyPageStrings, S } from './strings';

interface Rendered {
  docId: string;
  version: number;
  allowRemote: boolean;
  /** 다이어그램을 그린 테마. 다이어그램이 있는 문서만 테마가 바뀌면 다시 그린다 (FR-REN-07). */
  dark: boolean;
  hasDiagrams: boolean;
  headings: Heading[];
  /** 정제된 문서 노드. 보이는 동안은 미리보기로 옮겨 가 비어 있다. */
  frag?: DocumentFragment;
  message?: { text: string; action?: { label: string; run: () => void } };
  /** 폴더 접근이 없어 따라갈 수 없는 상대 경로 이미지·링크가 있는지 (독립 모드 단독 파일, SDD 7.2-6) */
  needsFolder?: boolean;
}

const ENCODINGS: { id: Encoding; label: string }[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'cp949', label: 'CP949 (EUC-KR)' },
];

const RENDER_DEBOUNCE_MS = 120;
/** 렌더링 결과를 남겨 둘 문서 수 (보이는 문서 제외). 메모리 목표(NFR-PERF-06) 때문에 작게 둔다. */
const RENDER_CACHE_SIZE = 6;
/** 인쇄할 때 그리는 중인 다이어그램을 기다리는 최대 시간 */
const PRINT_DIAGRAM_WAIT_MS = 3000;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(S.error.missingElement(id));
  return el;
}

export class App {
  readonly bridge = createBridge();
  readonly cmds = new CommandRegistry();
  readonly docs = new DocStore();
  readonly tabs = new TabManager();
  settings: Settings = defaultSettings();
  session: SessionData = defaultSession();
  info: ReadyInfo | null = null;

  private md = createMarkdown();
  private sanitizer = createSanitizer(window);
  readonly preview = new PreviewView();
  readonly diagrams = new DiagramRenderer({
    clean: (svg, id) => this.sanitizer.sanitizeDiagram(svg, id),
    width: () => this.preview.contentWidth(),
    // 다이어그램 구문 오류는 문서의 문제이고 화면에 안내도 하므로 앱 오류가 아닌 경고로 남긴다.
    // 고치는 중인 문서는 쓰다 만 구문이 많으므로 로그에 남기지 않는다 (SDD 8.1).
    onFailed: (line, msg) => {
      const doc = this.activeDoc();
      if (!doc?.dirty) this.logWarn(S.log.diagramFailed(doc?.path ?? '', line, msg));
    },
    onLoadFailed: (msg) => this.logError(S.log.diagramModuleFailed(msg)),
    // 원문 코드가 다이어그램으로 바뀌었으므로 열려 있는 찾기를 다시 돈다.
    onIdle: () => this.findbar.refresh(),
  });
  /** 원문 보기는 처음 쓸 때 실행한다 (시작할 때 CodeMirror를 실행하지 않아 NFR-PERF-01을 맞춘다, loadSourceBundle 참고). */
  source: SourceView | null = null;
  private sourceLoading: Promise<SourceView> | null = null;
  private toc = new TocPanel();
  private workspace = new WorkspacePanel(this.bridge);
  private menubar!: MenuBar;
  private tabbar!: TabBar;
  private statusbar!: StatusBar;
  private findbar = new FindBar();
  private sync!: ScrollSync;
  /** 편집 조정자 (FR-EDIT-01~10, SDD 7.7) */
  readonly edit = new EditController(
    {
      bridge: this.bridge,
      docs: this.docs,
      tabs: this.tabs,
      source: () => this.source,
      autoSave: () => this.settings.autoSave,
      roots: () => this.info?.roots ?? [],
      workspace: () => this.session.workspace,
      readDoc: (path, enc) => this.readDoc(path, enc),
      edited: (doc) => this.onEdited(doc),
      moved: (oldId, doc) => this.onMoved(oldId, doc),
      closeTab: (id) => void this.tabs.close(id),
      log: (msg) => this.logError(msg),
    },
    $('edit-bar'),
  );
  /** 마지막으로 보인 탭의 문서. 탭을 옮길 때 떠나는 문서를 자동 저장한다 (FR-EDIT-10). */
  private lastActiveDoc: string | null = null;

  private renderCache = new Map<string, Rendered>();
  private shown: { docId: string; version: number; allowRemote: boolean; dark: boolean } | null = null;
  private headings: Heading[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** 문서를 처음 보일 때 옮겨 갈 조각(#제목). 뒤에서 연 탭(가운데 클릭 등)은 보일 때까지 기다린다. */
  private pendingFragments = new Map<string, string>();
  /** 위치를 붙여 연 실행기 인자 문서. 이전 뷰어 탭이 넘긴 줄로 덮지 않는다 (FR-LAUNCH-06). */
  private locatedArgs = new Set<string>();
  /** 바뀐 곳 이동의 현재 번호. 문서 버전이 바뀌면(다시 읽으면) 처음부터 센다 (FR-WATCH-05). */
  private changeNav: { docId: string; version: number; index: number } | null = null;
  /** 인쇄하는 동안 밝은 색으로 그린다 (FR-EXP-01). */
  private printLight = false;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private saveSession = new Debouncer(() => this.persistSession(), 500);
  private saveSettings = new Debouncer(() => this.persistSettings(), 300);
  private systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  private started = false;
  /** 독립 모드에서 권한을 다시 받아야 하는 저장된 루트 수 */
  private restorable = 0;
  /** 이 뷰어 탭의 id. 같은 origin의 뷰어 탭끼리 세션 주인과 자리 넘기기를 가린다. */
  private readonly viewerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  /** 새 뷰어 탭에 자리를 넘기고 물러났는지 */
  private retired = false;

  private viewsEl = $('views');
  private emptyEl = $('empty');
  private sideEl = $('side');
  private tocEl = $('toc-side');

  // ------------------------------------------------------------------ 시작

  async start() {
    applyPageStrings(document);
    this.buildLayout();
    this.registerCommands();
    this.menubar = new MenuBar($('menubar'), this.cmds, this.menus());
    this.tabbar = new TabBar($('tabbar'), this.tabs, (id) => this.docs.get(id), (p) => this.displayPath(p));
    this.tabbar.onClose = (id) => void this.closeTab(id);
    this.tabbar.onOpenDialog = () => this.cmds.run('file.open');
    this.statusbar = new StatusBar($('statusbar'));
    this.statusbar.onEncodingClick = () => this.menubar.open(this.menuIndex(S.menu.encoding), true);
    this.statusbar.onChangesClick = () => this.cmds.run('nav.nextChange');
    this.bindEvents();

    // 1) 첫 탭까지 그린다 (SDD 7.5, NFR-PERF-01).
    let ready: ReadyInfo;
    try {
      ready = await this.bridge.request<ReadyInfo>('app.ready');
    } catch (err) {
      toast(S.toast.hostInitFailed((err as Error).message), 'error');
      ready = { mode: this.bridge.mode, args: [], settings: null, session: null, version: '?', roots: [], restorable: 0 };
    }
    this.restorable = ready.restorable;
    this.info = ready;
    this.settings = parseSettings(ready.settings);
    this.session = parseSession(ready.session);
    this.applyTheme();
    this.applyZoom();
    this.applySidePanel();
    this.applyTocPanel();
    this.applyOpenFiles();
    this.claimSession();
    this.applyRememberHandles();
    if (this.session.workspace) this.workspace.setRoot(this.session.workspace);

    const args = ready.args ?? [];
    const firstArg = [...args].reverse().find((e) => !e.isDir);
    const sess = this.session;
    const firstPath = firstArg?.path ?? sess.tabs[sess.activeIndex]?.path;
    let firstOpened = false;
    if (firstPath) {
      const fromSession = sess.tabs.find((t) => docKey(t.path) === docKey(firstPath));
      const h = await this.readDoc(firstPath).catch(() => null);
      if (h) {
        const doc = this.docs.upsert(h);
        // 실행기로 다시 연 문서도 지난 보기 모드·위치를 이어 간다. 위치를 붙여 열었으면 그 위치로 간다 (FR-FILE-04, FR-LAUNCH-06).
        const init = { mode: fromSession?.mode ?? this.defaultMode(doc), line: firstArg?.line ?? fromSession?.line ?? 0 };
        if (firstArg?.fragment) this.pendingFragments.set(doc.id, firstArg.fragment);
        if (firstArg && (firstArg.line != null || firstArg.fragment)) this.locatedArgs.add(doc.id);
        this.tabs.open(doc.id, doc.path, init, true);
        if (firstArg) this.session.recentFiles = pushRecent(this.session.recentFiles, doc.path, MAX_RECENT_FILES);
        firstOpened = true;
      }
    }
    this.started = true;
    this.showActive();
    this.tabbar.render();
    document.body.dataset.ready = '1';
    await nextPaint();
    // 첫 탭을 그린 시각(페이지 탐색 시작 기준 ms). 시작 시간 계측에 쓴다 (NFR-PERF-01).
    (window as any).__mdvReadyAt = performance.now();

    // 2) 실행기 이벤트에 붙고 나머지(세션의 다른 탭, 다른 인자)를 연다.
    this.bridge.connect();
    await this.restoreTabs(sess, firstPath).catch((err) => this.logError(S.log.restoreFailed((err as Error).message)));
    // 첫 인자는 이미 열었다. 다시 열면 그 위치로 또 옮겨 가므로 나머지만 연다.
    const rest = firstOpened ? args.filter((e) => e !== firstArg) : args;
    if (rest.length) await this.openEntries(rest, !firstOpened);
    this.updateWatch();
    this.saveSession.trigger();
    if (!this.tabs.active()) this.renderRecentList();
    this.joinViewers();
    document.body.dataset.restored = '1';
  }

  // ------------------------------------------------------------------ 뷰어 탭 여럿 (SDD 7.3)

  /** 세션은 마지막으로 쓴(보고 있는) 뷰어 탭만 저장한다. 여러 탭이 같은 저장소를 번갈아 덮지 않게 한다. */
  private claimSession() {
    let prev: string | null = null;
    try {
      prev = localStorage.getItem('mdv.sessionOwner');
      localStorage.setItem('mdv.sessionOwner', this.viewerId);
    } catch {
      // 저장소가 없으면 세션도 없다.
      return;
    }
    // 다른 뷰어 탭이 저장한 세션을 이 탭의 상태로 덮는다. 읽기만 하고 닫아도 다음에 이 탭의 문서가 열리게 한다.
    if (this.started && prev !== this.viewerId) this.saveSession.trigger();
  }

  private ownsSession(): boolean {
    try {
      const owner = localStorage.getItem('mdv.sessionOwner');
      return !owner || owner === this.viewerId;
    } catch {
      return true;
    }
  }

  /**
   * 실행기 모드: 같은 origin에 뷰어 탭은 하나만 둔다. 새 탭이 뜨면 이전 탭은 열린 문서 목록을 넘기고 물러난다.
   * 탭마다 실행기 연결(SSE)을 하나씩 잡으면 브라우저의 호스트당 연결 한도(6개)를 금방 다 쓰기 때문이다.
   */
  private joinViewers() {
    if (this.bridge.mode !== 'launcher' || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('mdview-viewers');
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.from === this.viewerId || this.retired) return;
      if (m.type === 'hello') {
        // 저장하지 않은 문서가 있으면 물러나지 않는다. 새 탭은 저장된 세션으로 연다 (FR-EDIT-08, FR-FILE-04).
        if (this.edit.hasDirty()) {
          toast(S.edit.handoverBlocked);
          return;
        }
        ch.postMessage({ type: 'handover', from: this.viewerId, to: m.from, tabs: this.sessionData().tabs, workspace: this.session.workspace });
        this.retire();
        ch.close();
      } else if (m.type === 'handover' && m.to === this.viewerId) {
        void this.adoptTabs(m.tabs ?? [], m.workspace ?? null);
      }
    };
    ch.postMessage({ type: 'hello', from: this.viewerId });
  }

  /**
   * 이전 뷰어 탭이 넘긴 문서를 연다. 지금 보는 탭은 그대로 둔다. 이미 연 문서(다시 연 인자, 세션에서 연 탭)는
   * 이전 탭이 넘긴 보기 모드·위치가 가장 새것이므로 그것으로 맞춘다. 위치를 붙여 연 인자는 그 위치를 지킨다 (FR-FILE-04).
   */
  private async adoptTabs(tabs: { path: string; mode: ViewMode; line: number }[], workspace: string | null) {
    const active = this.tabs.activeId;
    for (const t of tabs) {
      const open = this.tabs.byDoc(docKey(t.path));
      if (!open) await this.openFile(t.path, { activate: false, mode: t.mode, line: t.line });
      else if (!this.locatedArgs.has(open.docId)) this.restoreTabView(open, t.mode, t.line);
    }
    if (workspace && !this.session.workspace) this.setWorkspace(workspace);
    if (active != null) this.tabs.activate(active);
    else if (this.tabs.tabs[0]) this.tabs.activate(this.tabs.tabs[0].id);
    this.updateWatch();
  }

  /** 탭의 보기 모드·위치를 바꾸고, 보이는 탭이면 다시 맞춘다. */
  private restoreTabView(tab: Tab, mode: ViewMode, line: number) {
    if (tab.mode === mode && Math.abs(tab.line - line) < 0.01) return;
    this.tabs.setMode(tab.id, mode);
    this.tabs.setLine(tab.id, line);
    if (this.tabs.activeId === tab.id) this.showActive();
  }

  /** 새 뷰어 탭에 자리를 넘겼다. 연결과 세션 저장을 멈추고, 닫을 수 있으면 닫는다. */
  private retire() {
    this.retired = true;
    this.bridge.disconnect();
    void this.bridge.request('watch.set', { paths: [] }).catch(() => {});
    window.close();
    // 스크립트로 닫을 수 없는 탭이면 물러났다는 안내만 남긴다. 메뉴·탭 줄도 감춰 이 탭에서 문서를 더 열지 않게 한다.
    for (const t of [...this.tabs.tabs]) this.tabs.close(t.id);
    for (const id of ['menubar', 'tabbar', 'side', 'resizer', 'toc-side', 'toc-resizer', 'statusbar']) $(id).hidden = true;
    this.viewsEl.hidden = true;
    this.emptyEl.hidden = false;
    this.emptyEl.replaceChildren(Object.assign(document.createElement('p'), { className: 'retired', textContent: S.retired.text }));
    document.title = S.retired.title;
  }

  private buildLayout() {
    $('toc-body').append(this.toc.el);
    $('ws-body').append(this.workspace.el);
    $('find-slot').append(this.findbar.el);
    this.viewsEl.querySelector('.pane.preview')!.append(this.preview.el);

    this.toc.onSelect = (h) => this.gotoHeading(h);
    this.workspace.onOpen = (p) => void this.openFile(p);
    this.workspace.onPickFolder = () => this.cmds.run('file.openFolder');
    this.workspace.onClose = () => this.setWorkspace(null);
    this.preview.onLink = (a) => void this.onLink(a);
    this.preview.onCopyCode = (text) => void this.copyText(text);

    this.findbar.onQuery = (q) => this.runFind(q);
    this.findbar.onStep = (d) => this.stepFind(d);
    this.findbar.onReplace = (q, rep, all) => this.runReplace(q, rep, all);
    this.findbar.onClose = () => {
      this.preview.clearFind();
      this.source?.clearFind();
    };

    this.sync = new ScrollSync(
      this.preview,
      () => this.tabs.active()?.mode === 'split',
      (side) => {
        const m = this.tabs.active()?.mode;
        return m === 'split' || m === side;
      },
      (line) => {
        const tab = this.tabs.active();
        if (!tab) return;
        this.tabs.setLine(tab.id, line);
        this.toc.setCurrentLine(line);
      },
    );

    this.bindResizers();
    $('empty-open').addEventListener('click', () => this.cmds.run('file.open'));
    $('empty-folder').addEventListener('click', () => this.cmds.run('file.openFolder'));
    $('empty-restore').addEventListener('click', () => this.cmds.run('file.restoreSession'));
  }

  private bindEvents() {
    window.addEventListener('keydown', (e) => {
      if (this.retired || document.querySelector('dialog[open]')) return;
      if (this.menubar.handleKeyDown(e)) return;
      this.cmds.handleKey(e);
    }, true);
    window.addEventListener('keyup', (e) => {
      if (document.querySelector('dialog[open]')) return;
      this.menubar.handleKeyUp(e);
    }, true);
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.cmds.run(e.deltaY < 0 ? 'view.zoomIn' : 'view.zoomOut');
    }, { passive: false });

    // 파일 끌어다 놓기 (FR-FILE-01)
    document.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      if (this.retired) return;
      // 끌어다 놓은 항목은 이 처리기 안에서만 꺼낼 수 있다.
      void this.bridge
        .takeDrop(e.dataTransfer)
        .then((entries) => this.openEntries(entries))
        .catch((err) => this.reportError(err));
    });

    this.viewsEl.addEventListener('focusin', (e) => {
      const tab = this.tabs.active();
      if (!tab) return;
      const inSource = !!this.source?.el.contains(e.target as Node);
      this.tabs.setFindTarget(tab.id, inSource ? 'source' : 'preview');
    });

    this.tabs.onChange((kind) => {
      if (kind === 'structure') {
        // 새 문서는 파일이 없어 다시 열 수 없으므로 닫은 탭 목록에 남기지 않는다 (FR-EDIT-06).
        this.tabs.forgetClosed((p) => !isUntitledPath(p));
        this.tabbar?.render();
        this.updateWatch();
        this.dropUnusedDocs();
      }
      if (kind === 'active') {
        const prev = this.lastActiveDoc;
        if (prev && prev !== this.tabs.active()?.docId) this.edit.onLeave(prev);
        this.tabbar?.render();
        if (this.started) this.showActive();
      }
      if (this.started) this.saveSession.trigger();
    });

    this.docs.subscribe((doc, kind) => {
      const tab = this.tabs.active();
      // 디스크에서 읽은 본문만 화면 전체를 다시 맞춘다. 편집기에서 고친 본문은 편집 조정자가 미리보기만 고친다 (SDD 7.7).
      if (kind === 'content' && tab?.docId === doc.id) this.scheduleRefresh();
      if (kind === 'flags' && tab?.docId === doc.id && this.started && !this.retired) {
        this.renderStatus(doc, tab);
        document.title = this.titleOf(doc);
      }
      this.tabbar?.render();
    });

    this.systemDark.addEventListener('change', () => this.applyTheme());

    this.bridge.on('file.changed', (p: { path: string }) => void this.edit.onFileChanged(p.path));
    this.bridge.on('file.deleted', (p: { path: string }) => {
      this.docs.markDeleted(p.path);
    });
    this.bridge.on('bridge.offline', () => this.statusbar.setOffline(true));
    this.bridge.on('bridge.online', () => this.statusbar.setOffline(false));
    // 브라우저 탭을 닫거나 새로 고칠 때 마지막 상태를 바로 저장한다 (NFR-REL-02).
    const flush = () => {
      this.saveSession.flush();
      this.saveSettings.flush();
    };
    // Windows 앱: 앱을 다시 실행해 넘긴 위치를 이 창에서 열고, 창을 닫기 전에 저장한 뒤 닫아도 된다고 알린다.
    this.bridge.on('open.paths', (p: { paths?: PathEntry[] }) => void this.openEntries(p.paths ?? []));
    // 저장하지 않은 문서가 있으면 저장할지 묻고 닫는다 (FR-EDIT-08).
    this.bridge.on('app.closing', () => void this.edit.onAppClosing(flush, (d) => this.focusDoc(d)));
    window.addEventListener('pagehide', flush);
    // 브라우저 탭을 닫거나 새로 고칠 때는 비동기 저장을 끝낼 수 없으므로 브라우저 확인 창으로 막는다 (FR-EDIT-08).
    window.addEventListener('beforeunload', (e) => {
      if (this.retired || this.edit.quitting) return;
      this.edit.flush();
      if (!this.edit.hasDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // 다시 보이거나 포커스를 얻으면 작업 공간의 펼친 폴더를 다시 읽는다. 그사이 Claude 등이 만든 파일이 트리에 나타난다 (FR-WATCH-04).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
      else if (!this.retired) {
        this.claimSession();
        void this.workspace.refresh();
      }
    });
    window.addEventListener('focus', () => {
      if (this.retired) return;
      this.claimSession();
      void this.workspace.refresh();
    });

    this.cmds.onError = (err) => this.reportError(err);
    window.addEventListener('error', (e) => this.logError(e.message));
    window.addEventListener('unhandledrejection', (e) => this.logError(String(e.reason)));
  }

  // ------------------------------------------------------------------ 열기·닫기

  private async readDoc(path: string, encoding?: Encoding): Promise<HostDoc> {
    return this.bridge.request<HostDoc>('file.read', encoding ? { path, encoding } : { path });
  }

  private defaultMode(doc: DocModel): ViewMode {
    if (doc.binary) return 'preview';
    if (doc.kind === 'text') return 'source';
    if (doc.size > this.settings.largeFileMB * 1024 * 1024) return 'source';
    return 'preview';
  }

  /** 위치들을 연다. 파일은 탭으로, 폴더는 작업 공간으로. 위치(#제목·줄)가 붙은 파일은 그 위치로 간다 (FR-LAUNCH-06). */
  async openEntries(entries: PathEntry[], activateLast = true) {
    let lastFile: Tab | undefined;
    for (const e of entries) {
      if (e.isDir) this.setWorkspace(e.path, true);
      else lastFile = (await this.openFile(e.path, { activate: false, fragment: e.fragment, line: e.line })) ?? lastFile;
    }
    if (lastFile && activateLast) this.tabs.activate(lastFile.id);
  }

  async openFile(path: string, opts: { fragment?: string; activate?: boolean; mode?: ViewMode; line?: number } = {}): Promise<Tab | undefined> {
    const existing = this.tabs.byDoc(docKey(path));
    if (existing) {
      // 옮겨 갈 위치를 먼저 걸어 두고 보인다. 보이는 탭이면 지금 다시 맞추고, 뒤에서 연 탭은 보일 때 옮겨 간다.
      if (opts.fragment) this.pendingFragments.set(existing.docId, opts.fragment);
      else if (opts.line != null) this.tabs.setLine(existing.id, opts.line);
      if (opts.activate !== false) {
        if (this.tabs.activeId === existing.id) {
          if (opts.fragment || opts.line != null) this.showActive();
        } else {
          this.tabs.activate(existing.id);
        }
      }
      return existing;
    }
    let h: HostDoc;
    try {
      h = await this.readDoc(path);
    } catch (err) {
      if (err instanceof HostError && err.code === 'EISDIR') {
        this.setWorkspace(path, true);
        return undefined;
      }
      toast(S.toast.cannotOpen(basename(path), (err as Error).message), 'error');
      return undefined;
    }
    const doc = this.docs.upsert(h);
    // 탭을 여는 순간 showActive가 돌기 때문에 이동할 조각을 먼저 걸어 둔다.
    if (opts.fragment) this.pendingFragments.set(doc.id, opts.fragment);
    const tab = this.tabs.open(doc.id, doc.path, { mode: opts.mode ?? this.defaultMode(doc), line: opts.line ?? 0 }, opts.activate !== false);
    this.session.recentFiles = pushRecent(this.session.recentFiles, doc.path, MAX_RECENT_FILES);
    this.saveSession.trigger();
    return tab;
  }

  /**
   * 세션 복원 (FR-SESS-01). 첫 문서는 이미 열려 있으므로 나머지 탭을 읽어 세션 순서대로 끼워 넣는다.
   */
  private async restoreTabs(s: SessionData, skipPath?: string) {
    const skip = skipPath ? docKey(skipPath) : '';
    const rest = s.tabs.filter((t) => docKey(t.path) !== skip);
    const results = await Promise.all(rest.map((t) => this.readDoc(t.path).catch(() => null)));
    results.forEach((h, k) => {
      if (!h) return;
      const doc = this.docs.upsert(h);
      if (this.tabs.byDoc(doc.id)) return;
      this.tabs.open(doc.id, doc.path, { mode: rest[k].mode, line: rest[k].line }, false);
    });
    const order = new Map(s.tabs.map((t, i) => [docKey(t.path), i] as const));
    const sorted = [...this.tabs.tabs].sort((a, b) => (order.get(a.docId) ?? Infinity) - (order.get(b.docId) ?? Infinity));
    sorted.forEach((t, i) => {
      if (this.tabs.tabs[i] !== t) this.tabs.move(t.id, i);
    });
  }

  /** 탭을 닫는다. 고친 문서면 저장할지 먼저 묻는다 (FR-EDIT-08). 닫았으면 true. */
  async closeTab(id: number): Promise<boolean> {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (!(await this.edit.confirmClose([tab.docId], (d) => this.focusDoc(d)))) return false;
    this.tabs.close(id);
    return true;
  }

  /** 문서의 탭을 앞으로 가져온다(닫기 확인이 어느 문서를 묻는지 보이게). */
  private focusDoc(docId: string) {
    const t = this.tabs.byDoc(docId);
    if (t) this.tabs.activate(t.id);
  }

  /** 탭이 없는 문서·렌더링·편집 상태를 버린다. */
  private dropUnusedDocs() {
    const used = new Set(this.tabs.tabs.map((t) => t.docId));
    for (const id of [...this.renderCache.keys()]) if (!used.has(id)) this.renderCache.delete(id);
    for (const d of this.docs.all()) if (!used.has(d.id)) this.docs.remove(d.id);
    this.source?.prune(used);
  }

  private async reloadPath(path: string) {
    const doc = this.docs.byPath(path);
    if (!doc) return;
    try {
      this.docs.upsert(await this.readDoc(doc.path, doc.forcedEncoding), false, true);
    } catch (err) {
      if (err instanceof HostError && err.code === 'ENOENT') this.docs.markDeleted(path);
      else this.logError(S.log.reloadFailed(path, (err as Error).message));
    }
  }

  private async reopenWithEncoding(enc: Encoding) {
    const doc = this.activeDoc();
    if (!doc || doc.untitled) return;
    if (!(await this.edit.confirmDiscard(doc.id))) return;
    this.docs.update(doc.id, { forcedEncoding: enc });
    this.docs.upsert(await this.readDoc(doc.path, enc));
  }

  setWorkspace(path: string | null, show = false) {
    this.session.workspace = path;
    this.workspace.setRoot(path);
    if (path) this.session.recentFolders = pushRecent(this.session.recentFolders, path, MAX_RECENT_FOLDERS);
    if (show && path) this.showSidePanel();
    this.saveSession.trigger();
  }

  private updateWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      const paths = [...new Set(this.tabs.tabs.map((t) => t.path).filter((p) => !isUntitledPath(p)))];
      void this.bridge.request('watch.set', { paths }).catch((err) => this.logError(String(err)));
    }, 50);
  }

  // ------------------------------------------------------------------ 표시

  activeDoc(): DocModel | undefined {
    const tab = this.tabs.active();
    return tab ? this.docs.get(tab.docId) : undefined;
  }

  private scheduleRefresh() {
    if (!this.started) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.showActive();
    }, RENDER_DEBOUNCE_MS);
  }

  /** 활성 탭을 화면에 맞춘다. 내용이 같으면 다시 그리지 않고, 저장한 원문 줄로 돌아간다. */
  showActive() {
    if (this.retired) return;
    const tab = this.tabs.active();
    const doc = tab ? this.docs.get(tab.docId) : undefined;
    if (!tab || !doc) {
      this.stashShown();
      this.preview.setContent(null);
      this.emptyEl.hidden = false;
      this.viewsEl.hidden = true;
      this.renderRecentList();
      this.headings = [];
      this.toc.setHeadings([]);
      this.statusbar.render(null, null, this.settings.zoom);
      this.workspace.setActive('');
      document.title = S.appName;
      this.findbar.refresh();
      this.edit.updateBar();
      this.lastActiveDoc = null;
      return;
    }
    this.lastActiveDoc = doc.id;
    this.emptyEl.hidden = true;
    this.viewsEl.hidden = false;
    this.viewsEl.dataset.mode = tab.mode;
    this.sync.suspended = true;
    if (tab.mode !== 'preview') {
      if (!this.source) {
        void this.loadSource()
          .then(() => this.showActive())
          .catch((err) => {
            this.sync.suspended = false;
            this.reportError(err);
          });
        return;
      }
      // 문서마다 편집 상태를 갈아 끼운다. 바이너리 문서는 읽기 전용이다 (FR-EDIT-01).
      this.source.show(doc.id, doc.version, doc.binary ? '' : doc.text, !doc.binary);
      this.source.setChanges(doc.changes ?? null);
    }
    const r = this.getRendered(doc);
    this.headings = r.headings;
    if (tab.mode !== 'source') this.showPreview(r);
    this.toc.setHeadings(this.headings);
    this.renderStatus(doc, tab);
    this.workspace.setActive(doc.path);
    document.title = this.titleOf(doc);
    this.edit.updateBar();
    const line = tab.line;
    const fragment = this.pendingFragments.get(doc.id) ?? null;
    this.pendingFragments.delete(doc.id);
    requestAnimationFrame(() => {
      if (fragment) this.gotoFragment(tab, fragment);
      else this.scrollVisible(tab, line);
      this.toc.setCurrentLine(tab.line);
      requestAnimationFrame(() => (this.sync.suspended = false));
    });
    this.findbar.refresh();
  }

  /**
   * 편집기 본문을 문서 모델에 반영한 뒤 (SDD 7.7-2). 편집기는 건드리지 않고(상태 교체·스크롤 맞추기 없음)
   * 분할 보기의 미리보기와 목차·상태 표시줄만 고친다 (FR-EDIT-03). 원문 보기만 보일 때는 렌더링하지 않는다.
   */
  private onEdited(doc: DocModel) {
    const tab = this.tabs.active();
    if (!tab || tab.docId !== doc.id || this.retired) return;
    this.renderStatus(doc, tab);
    document.title = this.titleOf(doc);
    if (tab.mode !== 'source') {
      const t0 = performance.now();
      const r = this.getRendered(doc);
      this.headings = r.headings;
      this.sync.suspended = true;
      this.showPreview(r);
      this.preview.scrollToLine(tab.line);
      requestAnimationFrame(() => requestAnimationFrame(() => (this.sync.suspended = false)));
      this.edit.lastRenderMs = performance.now() - t0;
    } else if (doc.kind === 'markdown') {
      this.headings = scanHeadings(doc.text);
    }
    this.toc.setHeadings(this.headings);
    this.toc.setCurrentLine(tab.line);
    // 미리보기에서 찾던 중이면 새로 그린 본문에서 다시 찾는다. 원문에서 찾던(바꾸던) 중이면 편집기가 일치를 스스로 고친다.
    if (this.findbar.isOpen && this.findTarget() === 'preview') this.findbar.refresh();
  }

  /** 다른 이름으로 저장해 문서가 새 위치로 옮겨졌다 (FR-EDIT-05): 탭·편집 상태·렌더링·감시·세션을 옮긴다. */
  private onMoved(oldId: string, doc: DocModel) {
    const tab = this.tabs.byDoc(oldId);
    this.source?.rekey(oldId, doc.id, doc.version);
    this.stashShown();
    this.renderCache.delete(oldId);
    if (tab) this.tabs.retarget(tab.id, doc.id, doc.path);
    if (this.bridge.isRestorable(doc.path)) this.session.recentFiles = pushRecent(this.session.recentFiles, doc.path, MAX_RECENT_FILES);
    this.saveSession.trigger();
    if (tab && this.tabs.activeId === tab.id) this.showActive();
    // 새 이름의 파일이 작업 공간 트리에 나타나게 한다 (FR-WATCH-04).
    void this.workspace.refresh();
  }

  /** 상태 표시줄. 바뀐 곳으로 옮겨 간 중이면 몇 번째인지도 보인다 (FR-WATCH-05). */
  private renderStatus(doc: DocModel, tab: Tab) {
    const nav = this.changeNav;
    this.statusbar.changeIndex = nav && nav.docId === doc.id && nav.version === doc.version ? nav.index : null;
    this.statusbar.render(doc, tab.mode, this.settings.zoom);
  }

  /** 창 제목. 저장하지 않은 문서면 앞에 표시를 단다 (FR-EDIT-02). */
  private titleOf(doc: DocModel): string {
    return (doc.dirty ? S.tab.dirtyMark : '') + S.windowTitle(basename(doc.path));
  }

  /** 화면에 보일 위치. 새 문서는 이름만 보인다. */
  private displayPath(p: string): string {
    return isUntitledPath(p) ? basename(p) : this.bridge.displayPath(p);
  }

  /** 원문 보기 모듈을 불러와 붙인다. 여러 번 불러도 한 번만 만든다. */
  loadSource(): Promise<SourceView> {
    if (!this.sourceLoading) {
      this.sourceLoading = loadSourceBundle().then((SourceViewCtor) => {
        const view = new SourceViewCtor();
        view.onChange = (id) => this.edit.onSourceChange(id);
        view.setWrap(this.settings.wordWrap);
        view.setDark(this.isDark());
        this.viewsEl.querySelector('.pane.source')!.append(view.el);
        this.sync.attachSource(view);
        this.source = view;
        return view;
      });
      this.sourceLoading.catch(() => (this.sourceLoading = null));
    }
    return this.sourceLoading;
  }

  private scrollVisible(tab: Tab, line: number) {
    if (tab.mode !== 'source') this.preview.scrollToLine(line);
    if (tab.mode !== 'preview') this.source?.scrollToLine(line);
  }

  private showPreview(r: Rendered) {
    const s = this.shown;
    if (s && s.docId === r.docId && s.version === r.version && s.allowRemote === r.allowRemote && s.dark === r.dark) return;
    this.stashShown();
    if (r.message) this.preview.setMessage(r.message.text, r.message.action);
    else this.preview.setContent(r.frag!);
    if (r.hasDiagrams) void this.diagrams.renderPending(this.preview.article);
    const openFolder = () => void this.openFolderForActive().catch((err) => this.reportError(err));
    this.preview.setNotice(r.needsFolder ? { text: S.preview.needFolder, action: { label: S.preview.openFolder, run: openFolder } } : null);
    this.shown = { docId: r.docId, version: r.version, allowRemote: r.allowRemote, dark: r.dark };
  }

  /** 브리지가 나중에 주소를 주는 로컬 이미지(data-mdv-src)를 채운다 (SDD 8.1). */
  private loadImages(root: ParentNode) {
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-mdv-src]'))) {
      const path = img.getAttribute('data-mdv-src')!;
      void this.bridge.loadImage(path).then((url) => {
        if (!url) return;
        img.src = url;
        img.removeAttribute('data-mdv-src');
      });
    }
  }

  /** 단독 파일로 연 문서를 그 문서가 든 폴더 기준으로 다시 연다 (SDD 7.2-6). 대화상자·옮기기 오류는 부른 쪽이 알린다. */
  private async openFolderForActive() {
    const tab = this.tabs.active();
    const doc = this.activeDoc();
    if (!tab || !doc) return;
    // 폴더 기준 위치로 다시 열면 디스크에서 읽으므로 고친 내용은 먼저 저장하거나 버린다 (FR-EDIT-08).
    if (!(await this.edit.confirmClose([doc.id]))) return;
    const r = await this.bridge.request<{ path: string | null }>('dialog.openFolder');
    if (!r.path) return;
    this.setWorkspace(r.path, true);
    const moved = await this.bridge.request<{ path: string | null }>('file.relocate', { path: doc.path, dir: r.path });
    if (!moved.path) {
      toast(S.toast.notInFolder, 'error');
      return;
    }
    const { mode, line } = tab;
    await this.openFile(moved.path, { mode, line });
    this.tabs.close(tab.id);
  }

  /** 보이던 문서 노드를 캐시로 되돌린다 (복제하지 않고 옮긴다). */
  private stashShown() {
    const s = this.shown;
    if (!s) return;
    const prev = this.renderCache.get(s.docId);
    const content = this.preview.takeContent();
    if (prev && !prev.message && prev.version === s.version && prev.allowRemote === s.allowRemote && prev.dark === s.dark) prev.frag = content;
    this.shown = null;
  }

  /** 렌더링 결과를 캐시에서 꺼내거나 새로 만든다 (SDD 8.1). */
  private getRendered(doc: DocModel): Rendered {
    const allowRemote = this.settings.allowRemoteImages;
    const dark = this.isDark();
    const cached = this.renderCache.get(doc.id);
    if (cached && cached.version === doc.version && cached.allowRemote === allowRemote && (!cached.hasDiagrams || cached.dark === dark)) {
      this.renderCache.delete(doc.id);
      this.renderCache.set(doc.id, cached);
      return cached;
    }
    const r: Rendered = { docId: doc.id, version: doc.version, allowRemote, dark, hasDiagrams: false, headings: [] };
    if (doc.binary) {
      r.message = { text: S.preview.binary };
    } else if (doc.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'mdv-plain';
      pre.setAttribute('data-line', '0');
      pre.textContent = doc.text;
      r.frag = document.createDocumentFragment();
      r.frag.append(pre);
      if (doc.changes) markChangedBlocks(r.frag, doc.changes);
    } else if (doc.size > this.settings.largeFileMB * 1024 * 1024 && !doc.forcePreview) {
      r.headings = scanHeadings(doc.text);
      r.message = {
        text: S.preview.largeFile(formatSize(doc.size)),
        action: { label: S.preview.renderLarge, run: () => this.docs.update(doc.id, { forcePreview: true }) && this.forceRerender(doc.id) },
      };
    } else {
      try {
        const out = renderMarkdown(this.md, doc.text);
        r.headings = out.headings;
        for (const e of out.errors) this.logError(S.log.blockFailed(doc.path, e.line, e.message));
        const clean = this.sanitizer.sanitize(out.html, {
          docDir: dirname(doc.path),
          docRoot: this.bridge.rootOf(doc.path),
          allowRemoteImages: allowRemote,
          imageUrl: (p) => this.bridge.imageUrl(p),
          selfOrigin: /^https?:/.test(location.protocol) ? location.origin : undefined,
        });
        r.frag = chunkBlocks(clean);
        addCodeTools(r.frag, { copy: S.preview.copyCode, copyTitle: S.preview.copyCodeTitle });
        // 밖에서 바뀌어 다시 읽은 문서면 바뀐 블록을 표시한다. 표시는 이 버전의 렌더링에만 든다 (FR-WATCH-05).
        if (doc.changes) markChangedBlocks(r.frag, doc.changes);
        this.loadImages(r.frag);
        r.hasDiagrams = !!r.frag.querySelector(`.${DIAGRAM_CLASS}`);
        if (r.hasDiagrams) this.diagrams.applyCached(r.frag);
        r.needsFolder = !doc.untitled && !this.bridge.canResolveRelative(doc.path) && !!r.frag.querySelector('img[data-mdv-src], a[data-mdv-path]');
      } catch (err) {
        // FR-REN-04: 블록 하나의 실패는 renderMarkdown이 그 블록만 바꾼다. 여기는 파싱·정제 자체가 실패했을 때다.
        this.logError(S.log.renderFailed(doc.path, (err as Error).message));
        const banner = document.createElement('div');
        banner.className = 'mdv-render-error';
        banner.textContent = S.preview.docFailed((err as Error).message);
        const pre = document.createElement('pre');
        pre.className = 'mdv-plain';
        pre.textContent = doc.text;
        r.frag = document.createDocumentFragment();
        r.frag.append(banner, pre);
        r.headings = scanHeadings(doc.text);
      }
    }
    this.renderCache.delete(doc.id);
    this.renderCache.set(doc.id, r);
    this.trimRenderCache();
    return r;
  }

  private trimRenderCache() {
    const keep = this.shown?.docId;
    for (const id of [...this.renderCache.keys()]) {
      if (this.renderCache.size <= RENDER_CACHE_SIZE + 1) break;
      if (id !== keep) this.renderCache.delete(id);
    }
  }

  private forceRerender(docId: string) {
    this.stashShown();
    this.renderCache.delete(docId);
    this.showActive();
  }

  private gotoHeading(h: Heading) {
    const tab = this.tabs.active();
    if (!tab) return;
    this.sync.suspended = true;
    this.tabs.setLine(tab.id, h.line);
    if (tab.mode !== 'source') {
      if (!this.preview.scrollToFragment(h.id)) this.preview.scrollToLine(h.line);
    }
    if (tab.mode !== 'preview') this.source?.scrollToLine(h.line);
    this.toc.setCurrentLine(h.line);
    requestAnimationFrame(() => requestAnimationFrame(() => (this.sync.suspended = false)));
  }

  /**
   * 조각(#…)으로 간다. 제목 id가 같거나, 실행기 인자처럼 제목 글을 그대로 준 경우(`#3.2 결과`)도 그 제목의 id로 맞춰 찾는다 (FR-LAUNCH-06).
   */
  private gotoFragment(tab: Tab, fragment: string) {
    const want = decodeFragment(fragment);
    const slug = new Slugger().slug(want);
    const h =
      this.headings.find((x) => x.id === want || x.id === want.toLowerCase()) ??
      this.headings.find((x) => x.id === slug || x.text.trim() === want.trim());
    if (h) {
      this.gotoHeading(h);
      return;
    }
    if (tab.mode !== 'source' && this.preview.scrollToFragment(fragment)) {
      this.tabs.setLine(tab.id, this.preview.topLine());
    }
  }

  private async onLink(a: LinkAction) {
    const tab = this.tabs.active();
    if (!tab) return;
    if (a.kind === 'fragment') {
      this.gotoFragment(tab, a.fragment);
    } else if (a.kind === 'external') {
      await this.bridge.request('shell.openExternal', { url: a.url }).catch((err) => this.reportError(err));
    } else if (isViewablePath(a.path)) {
      // 가운데 클릭은 지금 탭에 머문 채 새 탭으로 연다 (FR-NAV-03).
      await this.openFile(a.path, { fragment: a.fragment, activate: !a.background });
    } else if (this.canReveal(a.path)) {
      // 문서가 아닌 로컬 파일은 실행하지 않고 탐색기에서 위치만 보여준다 (SRS 4.3).
      await this.bridge.request('shell.reveal', { path: a.path }).catch((err) => this.reportError(err));
    } else {
      // 탐색기를 띄울 수 없는 위치(독립 모드, 브라우저 핸들로 연 파일)는 열지 않는다는 것만 알린다.
      toast(S.toast.notViewable(basename(a.path)));
    }
  }

  /** 탐색기에서 위치를 열 수 있는지: 실행기 모드의 OS 경로만 (FR-INFO-03) */
  private canReveal(path: string): boolean {
    return this.bridge.caps.reveal && !/^mdv:/i.test(path);
  }

  // ------------------------------------------------------------------ 찾기

  private findTarget(): 'preview' | 'source' | null {
    const tab = this.tabs.active();
    if (!tab) return null;
    return tab.mode === 'split' ? tab.findTarget : tab.mode;
  }

  private runFind(q: FindQuery): FindStatus {
    const target = this.findTarget();
    this.preview.clearFind();
    this.source?.clearFind();
    if (!target) return { count: 0, index: -1 };
    if (target === 'source') return this.source ? this.source.find(q) : { count: 0, index: -1 };
    return this.preview.find(q);
  }

  private stepFind(dir: 1 | -1): FindStatus {
    const target = this.findTarget();
    if (!target) return { count: 0, index: -1 };
    if (target === 'source') return this.source ? this.source.step(dir) : { count: 0, index: -1 };
    return this.preview.step(dir);
  }

  /** 찾아 바꾸기 (FR-EDIT-07). 원문(편집기)에서만 바꾼다. */
  private runReplace(q: FindQuery, replacement: string, all: boolean): FindStatus {
    const tab = this.tabs.active();
    if (!tab || tab.mode === 'preview' || !this.source) return { count: 0, index: -1 };
    this.tabs.setFindTarget(tab.id, 'source');
    this.preview.clearFind();
    return this.source.replace(q, replacement, all);
  }

  private findPrefill(): string {
    if (this.findTarget() === 'source') return this.source?.selectionText() ?? '';
    return window.getSelection()?.toString() ?? '';
  }

  // ------------------------------------------------------------------ 설정·테마·패널

  private isDark(): boolean {
    if (this.printLight) return false;
    return this.settings.theme === 'dark' || (this.settings.theme === 'system' && this.systemDark.matches);
  }

  private applyTheme() {
    const dark = this.isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    this.source?.setDark(dark);
    this.diagrams.setDark(dark);
    // 다이어그램은 테마 색을 SVG에 담아 그리므로, 보이는 문서에 다이어그램이 있으면 다시 그린다. 나머지 문서는 꺼낼 때 다시 그린다.
    const shown = this.shown;
    if (shown && shown.dark !== dark && this.renderCache.get(shown.docId)?.hasDiagrams) this.forceRerender(shown.docId);
    // Windows 앱의 제목 표시줄도 맞춘다. 시작할 때는 호스트가 저장된 설정을 보고 이미 맞췄다.
    if (this.started && this.bridge.mode === 'desktop' && !this.printLight) void this.bridge.request('window.setTheme', { dark }).catch((err) => this.logError(String(err)));
  }

  private setTheme(theme: Theme) {
    this.settings.theme = theme;
    this.applyTheme();
    this.saveSettings.trigger();
  }

  private applyZoom() {
    const z = this.settings.zoom;
    document.documentElement.style.setProperty('--mdv-zoom', String(z / 100));
    this.preview.setZoom(z);
    const tab = this.tabs.active();
    if (tab && this.started) {
      this.sync.suspended = true;
      requestAnimationFrame(() => {
        this.scrollVisible(tab, tab.line);
        requestAnimationFrame(() => (this.sync.suspended = false));
      });
      this.statusbar.render(this.activeDoc() ?? null, tab.mode, z);
    }
  }

  private zoomBy(delta: number) {
    const z = delta === 0 ? 100 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.settings.zoom + delta));
    if (z === this.settings.zoom) return;
    this.settings.zoom = z;
    this.applyZoom();
    if (!this.tabs.active()) this.statusbar.render(null, null, z);
    this.saveSettings.trigger();
  }

  /** 왼쪽 패널: 열린 파일 목록(설정이 목록일 때)과 작업 공간 */
  private applySidePanel() {
    const sp = this.session.sidePanel;
    this.sideEl.hidden = !sp.visible;
    $('resizer').hidden = !sp.visible;
    this.sideEl.style.width = `${sp.width}px`;
    $('open-files').style.height = `${sp.listHeight}px`;
  }

  /** 오른쪽 패널: 목차 */
  private applyTocPanel() {
    const tp = this.session.tocPanel;
    this.tocEl.hidden = !tp.visible;
    $('toc-resizer').hidden = !tp.visible;
    this.tocEl.style.width = `${tp.width}px`;
  }

  /** 왼쪽 패널이 숨겨져 있으면 연다. */
  private showSidePanel() {
    if (this.session.sidePanel.visible) return;
    this.session.sidePanel.visible = true;
    this.applySidePanel();
    this.saveSession.trigger();
  }

  /** 열린 파일을 위쪽 탭 줄로 보일지 왼쪽 패널 위 칸의 목록으로 보일지 맞춘다. 탭 줄 요소 하나를 옮겨 쓴다. */
  private applyOpenFiles() {
    const list = this.settings.openFiles === 'list';
    const bar = $('tabbar');
    if (list) $('open-files').append(bar);
    else $('app').insertBefore(bar, $('body'));
    $('open-files').hidden = !list;
    $('side-split').hidden = !list;
    this.tabbar.setVertical(list);
    // 옮기면 스크롤 위치가 처음으로 돌아가므로 활성 탭이 보이게 다시 그린다.
    this.tabbar.render();
  }

  private setOpenFiles(v: OpenFilesView) {
    if (this.settings.openFiles === v) return;
    this.settings.openFiles = v;
    this.applyOpenFiles();
    // 목록은 왼쪽 패널에 있으므로 숨겨져 있으면 연다.
    if (v === 'list') this.showSidePanel();
    this.saveSettings.trigger();
  }

  private bindResizers() {
    const width = (w: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
    const save = () => this.saveSession.trigger();
    dragSize($('resizer'), 'x', 1, () => this.sideEl.getBoundingClientRect().width, (w) => {
      this.session.sidePanel.width = width(w);
      this.sideEl.style.width = `${this.session.sidePanel.width}px`;
    }, save);
    // 목차 패널은 오른쪽에 있으므로 경계선을 왼쪽으로 끌수록 넓어진다.
    dragSize($('toc-resizer'), 'x', -1, () => this.tocEl.getBoundingClientRect().width, (w) => {
      this.session.tocPanel.width = width(w);
      this.tocEl.style.width = `${this.session.tocPanel.width}px`;
    }, save);
    const list = $('open-files');
    dragSize($('side-split'), 'y', 1, () => list.getBoundingClientRect().height, (h) => {
      list.style.height = `${Math.round(Math.max(LIST_MIN, h))}px`;
      // 아래 작업 공간을 남기는 상한은 CSS(max-height)가 정하므로 실제로 그려진 높이를 기억한다.
      this.session.sidePanel.listHeight = Math.round(list.getBoundingClientRect().height);
    }, save);
  }

  private renderRecentList() {
    const list = $('empty-recent');
    list.replaceChildren();
    for (const p of this.session.recentFiles.slice(0, 8)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'link-button';
      // 독립 모드의 위치(mdv:/d1/…)는 메뉴·탭 줄처럼 화면용 이름으로 보인다.
      const shown = this.bridge.displayPath(p);
      b.textContent = basename(p);
      b.title = shown;
      b.addEventListener('click', () => void this.openFile(p));
      li.append(b, Object.assign(document.createElement('span'), { className: 'recent-dir', textContent: shown }));
      list.append(li);
    }
    $('empty-recent-title').hidden = !this.session.recentFiles.length;
    $('empty-restore').hidden = this.restorable <= 0;
  }

  /** 독립 모드: 저장해 둔 핸들에 권한을 다시 받아 지난 세션을 연다 (SDD 7.4). 클릭 처리기에서 부른다. */
  private async restoreSession() {
    const r = await this.bridge.request<{ restored: number; remaining: number }>('session.restore');
    // 거절·실패한 위치가 남으면 복원 버튼·메뉴를 남겨 다시 시도하게 한다.
    this.restorable = r.remaining;
    if (!r.restored) {
      toast(S.toast.restoreNone);
      this.renderRecentList();
      return;
    }
    if (this.session.workspace) this.workspace.setRoot(this.session.workspace);
    await this.restoreTabs(this.session);
    // 일부 위치만 권한을 받았으면 탭 순서가 세션과 달라지므로, 번호가 아니라 위치로 지난 활성 탭을 찾는다.
    const activePath = this.session.tabs[this.session.activeIndex]?.path;
    const t = activePath ? this.tabs.byDoc(docKey(activePath)) : undefined;
    if (t) this.tabs.activate(t.id);
    this.updateWatch();
    if (!this.tabs.active()) this.renderRecentList();
  }

  // ------------------------------------------------------------------ 저장·종료

  /** 저장할 세션. 다음에 다시 열 수 없는 위치(핸들 없는 파일 등)는 탭·최근 목록에서 뺀다. */
  private sessionData(): SessionData {
    const keep = (p: string) => !isUntitledPath(p) && this.bridge.isRestorable(p);
    const tabs = this.tabs.tabs.filter((t) => keep(t.path));
    const live = tabs.map((t) => ({ path: t.path, mode: t.mode, line: Math.round(t.line * 100) / 100 }));
    // 독립 모드: 권한을 다시 받지 못해 아직 못 연 지난 세션의 탭은 "이전 문서 다시 열기"를 누를 때까지 남겨 둔다.
    // 그러지 않으면 열자마자 빈 세션이 저장돼, 복원하기 전에 새로 고치면 지난 탭을 잃는다.
    const pending = this.session.tabs.filter((t) => this.bridge.isPending(t.path) && !live.some((x) => docKey(x.path) === docKey(t.path)));
    // 열린 탭이 없으면 권한을 기다리는 지난 활성 탭을 가리킨다.
    const active = live.length
      ? tabs.findIndex((t) => t.id === this.tabs.activeId)
      : pending.indexOf(this.session.tabs[this.session.activeIndex]);
    return {
      ...this.session,
      schemaVersion: SCHEMA_VERSION,
      tabs: [...live, ...pending],
      activeIndex: Math.max(0, active),
      workspace: this.session.workspace && keep(this.session.workspace) ? this.session.workspace : null,
      recentFiles: this.session.recentFiles.filter(keep),
      recentFolders: this.session.recentFolders.filter(keep),
    };
  }

  private persistSession() {
    if (this.retired || !this.ownsSession()) return;
    const data = JSON.stringify(this.sessionData(), null, 2);
    void this.bridge.request('store.save', { name: 'session', data }).catch((err) => this.logError(String(err)));
  }

  private persistSettings() {
    const data = { ...this.settings, schemaVersion: SCHEMA_VERSION };
    void this.bridge.request('store.save', { name: 'settings', data: JSON.stringify(data, null, 2) }).catch((err) => this.logError(String(err)));
  }

  /** 연 파일·폴더 핸들을 브라우저 저장소에 기억할지 브리지에 알린다 (SDD 8.4). */
  private applyRememberHandles() {
    void this.bridge.request('handles.remember', { on: this.settings.rememberHandles }).catch((err) => this.logError(String(err)));
  }

  private reportError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(msg, 'error');
    this.logError(msg);
  }

  private logError(msg: string) {
    void this.bridge.request('app.log', { level: 'error', msg }).catch(() => {});
  }

  private logWarn(msg: string) {
    void this.bridge.request('app.log', { level: 'warn', msg }).catch(() => {});
  }

  // ------------------------------------------------------------------ 명령·메뉴

  private setMode(mode: ViewMode) {
    const tab = this.tabs.active();
    if (!tab || tab.mode === mode) return;
    // 기다리는 편집을 먼저 반영해 미리보기가 고친 본문으로 그려지게 한다 (FR-EDIT-03).
    this.edit.flush();
    this.tabs.setMode(tab.id, mode);
    this.showActive();
  }

  /**
   * 인쇄 (FR-EXP-01). 화면 테마와 관계없이 밝은 색으로 인쇄한다. 글자색은 인쇄 CSS가 되돌리지만, 다이어그램은 테마 색을 SVG에 담으므로
   * 다크 테마면 잠시 밝은 테마로 다시 그리고, 인쇄가 끝나면 되돌린다.
   */
  private print() {
    this.edit.flush();
    const tab = this.tabs.active();
    const doc = this.activeDoc();
    if (!tab || !doc) return;
    const swap = this.isDark();
    if (swap) this.setPrintLight(true);
    if (tab.mode === 'source') this.showPreview(this.getRendered(doc));
    document.body.classList.add('printing');
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      document.body.classList.remove('printing');
      window.removeEventListener('afterprint', done);
      if (swap) this.setPrintLight(false);
    };
    window.addEventListener('afterprint', done);
    // 인쇄 미리보기는 print()를 부를 때 문서를 떠 두므로, 돌아온 뒤 되돌려도 된다. afterprint가 오지 않는 환경도 있다.
    const go = () => {
      window.print();
      setTimeout(done, 0);
    };
    // 아직 그리는 다이어그램이 있으면 잠시 기다려 원문 코드 대신 다이어그램이 인쇄되게 한다 (FR-REN-07).
    if (swap || this.diagrams.busy) void this.diagrams.idle(PRINT_DIAGRAM_WAIT_MS).then(go);
    else go();
  }

  private setPrintLight(on: boolean) {
    this.printLight = on;
    this.applyTheme();
  }

  /** 줄(0부터)로 간다 (FR-NAV-05). 원문 보기에서 cursor면 커서도 옮긴다. */
  private gotoLine(tab: Tab, line: number, cursor = false) {
    this.sync.suspended = true;
    this.tabs.setLine(tab.id, line);
    if (tab.mode !== 'source') this.preview.scrollToLine(line);
    if (tab.mode !== 'preview' && this.source) {
      this.source.scrollToLine(line);
      if (cursor) {
        this.source.setCursorLine(line);
        this.source.focus();
      }
    }
    this.toc.setCurrentLine(line);
    requestAnimationFrame(() => requestAnimationFrame(() => (this.sync.suspended = false)));
  }

  /** 줄로 이동 대화상자 (Ctrl+G, FR-NAV-05). 줄은 1부터 센다. */
  private async promptGotoLine() {
    const tab = this.tabs.active();
    const doc = this.activeDoc();
    if (!tab || !doc) return;
    const total = doc.text.split('\n').length;
    const v = await promptText(S.gotoLine.title, S.gotoLine.label(total), String(Math.floor(tab.line) + 1));
    if (v == null || this.tabs.active() !== tab) return;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < 1) {
      toast(S.gotoLine.invalid(v.trim()), 'error');
      return;
    }
    this.gotoLine(tab, Math.min(n, total) - 1, true);
  }

  /** 다음(1)·이전(-1) 바뀐 곳으로 간다 (FR-WATCH-05). */
  private gotoChange(dir: 1 | -1) {
    const tab = this.tabs.active();
    const doc = this.activeDoc();
    const ranges = doc?.changes;
    if (!tab || !doc || !ranges?.length) return;
    const nav = this.changeNav;
    const current = nav && nav.docId === doc.id && nav.version === doc.version ? nav.index : null;
    const index = stepChange(ranges, current, tab.line, dir);
    this.changeNav = { docId: doc.id, version: doc.version, index };
    this.gotoLine(tab, ranges[index].start);
    this.renderStatus(doc, tab);
  }

  /**
   * 위치 복사 (FR-INFO-04): 고른 부분을 Claude Code 대화에 붙여 넣을 '경로:줄' 한 줄과 인용문으로 복사한다.
   * 분할 보기는 마지막으로 포커스를 둔 쪽에서 고른 부분을 쓴다. 고른 것이 없으면 지금 줄을 쓴다.
   */
  private async copyLocation() {
    this.edit.flush();
    const tab = this.tabs.active();
    const doc = this.activeDoc();
    if (!tab || !doc) return;
    const side = tab.mode === 'split' ? tab.findTarget : tab.mode;
    let start = Math.floor(tab.line);
    let end = start;
    let quote = '';
    if (side === 'source' && this.source) {
      ({ start, end, text: quote } = this.source.selectionLines());
    } else {
      const range = this.previewRange();
      const r = range ? previewSelectionLines(this.preview.article, range, doc.text.split('\n')) : null;
      if (r && range) {
        ({ start, end } = r);
        quote = range.toString();
      }
    }
    const text = locationText(this.locationPath(doc.path), start, end, quote);
    await this.copyText(text, S.toast.copiedLocation(text.split('\n')[0]));
  }

  /** 미리보기 안에서 고른 범위. 미리보기는 Shadow DOM이라 그 루트의 선택을 먼저 본다. 고른 것이 없거나 밖이면 null */
  private previewRange(): Range | null {
    const root = this.preview.root as ShadowRoot & { getSelection?: () => Selection | null };
    const sel = root.getSelection?.() ?? document.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return this.preview.article.contains(range.startContainer) && this.preview.article.contains(range.endContainer) ? range : null;
  }

  /** 위치 복사에 쓸 경로. 실행기·Windows 앱은 절대 경로, 독립 모드(mdv:)는 열린 폴더 기준 이름, 새 문서는 이름 */
  private locationPath(path: string): string {
    if (isUntitledPath(path)) return basename(path);
    return /^mdv:/i.test(path) ? this.bridge.displayPath(path) : path;
  }

  private async copyText(text: string, done: string = S.toast.copied) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(done);
  }

  private registerCommands() {
    const c = this.cmds;
    const hasTab = () => !!this.tabs.active();
    const modeIs = (m: ViewMode) => () => this.tabs.active()?.mode === m;

    c.register({
      id: 'file.open', title: S.cmd.fileOpen, keys: ['Ctrl+O'],
      run: async () => {
        const r = await this.bridge.request<{ paths: string[] }>('dialog.openFiles', {});
        await this.openEntries(r.paths.map((path) => ({ path, isDir: false })));
      },
    });
    c.register({
      id: 'file.openFolder', title: S.cmd.fileOpenFolder,
      run: async () => {
        const r = await this.bridge.request<{ path: string | null }>('dialog.openFolder', {});
        if (r.path) this.setWorkspace(r.path, true);
      },
    });
    c.register({
      id: 'file.reload', title: S.cmd.fileReload, keys: ['F5'], enabled: hasTab,
      run: async () => {
        const doc = this.activeDoc();
        if (!doc || doc.untitled) return;
        // 고친 문서는 버리고 다시 읽을지 먼저 묻는다 (FR-WATCH-03, FR-EDIT-09).
        if (!(await this.edit.confirmDiscard(doc.id))) return;
        await this.reloadPath(doc.path);
      },
    });
    c.register({ id: 'file.closeTab', title: S.cmd.fileCloseTab, keys: ['Alt+W'], enabled: hasTab, run: () => this.closeTab(this.tabs.activeId!) });
    c.register({
      id: 'file.closeOthers', title: S.cmd.fileCloseOthers, enabled: () => this.tabs.tabs.length > 1,
      run: async () => {
        const keep = this.tabs.activeId!;
        const others = this.tabs.tabs.filter((t) => t.id !== keep).map((t) => t.docId);
        if (!(await this.edit.confirmClose(others, (d) => this.focusDoc(d)))) return;
        this.tabs.activate(keep);
        this.tabs.closeOthers(keep);
      },
    });
    c.register({
      id: 'file.reopenClosed', title: S.cmd.fileReopenClosed, keys: ['Alt+Shift+T'], enabled: () => this.tabs.closed.length > 0,
      run: async () => {
        const t = this.tabs.popClosed();
        if (t) await this.openFile(t.path, { mode: t.mode, line: t.line });
      },
    });
    c.register({
      id: 'file.copyPath', title: S.cmd.fileCopyPath, enabled: () => hasTab() && !this.activeDoc()?.untitled,
      run: () => this.copyText(this.bridge.displayPath(this.activeDoc()!.path)),
    });
    c.register({
      id: 'file.reveal', title: S.cmd.fileReveal, enabled: () => hasTab() && this.canReveal(this.activeDoc()!.path),
      run: () => this.bridge.request('shell.reveal', { path: this.activeDoc()!.path }),
    });
    c.register({ id: 'file.print', title: S.cmd.filePrint, keys: ['Ctrl+P'], enabled: hasTab, run: () => this.print() });
    c.register({
      id: 'file.clearRecent', title: S.cmd.fileClearRecent,
      run: () => {
        this.session.recentFiles = [];
        this.session.recentFolders = [];
        this.saveSession.trigger();
        if (!this.tabs.active()) this.renderRecentList();
      },
    });
    c.register({ id: 'file.restoreSession', title: S.cmd.fileRestoreSession, enabled: () => this.restorable > 0, run: () => this.restoreSession() });

    // 편집과 저장 (FR-EDIT-01~10, SRS 4.2). Ctrl+N은 브라우저가 넘기지 않고 Alt+N은 인코딩 메뉴라 새 문서는 Alt+Shift+N이다.
    const editable = () => {
      const tab = this.tabs.active();
      return !!tab && tab.mode !== 'preview' && !this.activeDoc()?.binary;
    };
    c.register({
      id: 'file.new', title: S.cmd.fileNew, keys: ['Alt+Shift+N'],
      run: async () => {
        const doc = this.edit.newDocument();
        this.tabs.open(doc.id, doc.path, { mode: 'source' }, true);
        await this.loadSource();
        requestAnimationFrame(() => this.source?.focus());
      },
    });
    c.register({ id: 'file.save', title: S.cmd.fileSave, keys: ['Ctrl+S'], enabled: hasTab, run: () => this.edit.save(this.tabs.active()!.docId) });
    c.register({
      id: 'file.saveAs', title: S.cmd.fileSaveAs, keys: ['Ctrl+Shift+S'], enabled: () => hasTab() && !this.activeDoc()?.binary,
      run: () => this.edit.save(this.tabs.active()!.docId, { as: true }),
    });
    // 실행 취소·다시 실행 키는 편집기(와 입력 칸)가 직접 받는다. 메뉴에는 키를 보이기만 한다 (SDD 6.3).
    c.register({
      id: 'edit.undo', title: S.cmd.editUndo, keyHint: ['Ctrl+Z'], enabled: editable,
      run: () => {
        this.source?.undo();
        this.source?.focus();
      },
    });
    c.register({
      id: 'edit.redo', title: S.cmd.editRedo, keyHint: ['Ctrl+Y', 'Ctrl+Shift+Z'], enabled: editable,
      run: () => {
        this.source?.redo();
        this.source?.focus();
      },
    });
    c.register({
      id: 'edit.replace', title: S.cmd.editReplace, keys: ['Ctrl+H'], enabled: editable,
      run: () => {
        const tab = this.tabs.active()!;
        this.tabs.setFindTarget(tab.id, 'source');
        this.findbar.open(this.source?.selectionText() ?? '', true);
      },
    });
    c.register({
      id: 'settings.autoSave', title: S.cmd.autoSave, checked: () => this.settings.autoSave,
      run: () => {
        this.settings.autoSave = !this.settings.autoSave;
        if (this.settings.autoSave) this.edit.resetAuto();
        this.saveSettings.trigger();
      },
    });

    c.register({ id: 'view.preview', title: S.mode.preview, keys: ['Ctrl+1'], enabled: hasTab, checked: modeIs('preview'), run: () => this.setMode('preview') });
    c.register({ id: 'view.source', title: S.mode.source, keys: ['Ctrl+2'], enabled: hasTab, checked: modeIs('source'), run: () => this.setMode('source') });
    c.register({ id: 'view.split', title: S.mode.split, keys: ['Ctrl+3'], enabled: hasTab, checked: modeIs('split'), run: () => this.setMode('split') });
    c.register({
      id: 'view.wordWrap', title: S.cmd.viewWordWrap, keys: ['Alt+Z'], checked: () => this.settings.wordWrap,
      run: () => {
        this.settings.wordWrap = !this.settings.wordWrap;
        this.source?.setWrap(this.settings.wordWrap);
        this.saveSettings.trigger();
      },
    });
    c.register({ id: 'view.zoomIn', title: S.cmd.viewZoomIn, keys: ['Ctrl+=', 'Ctrl+Shift+='], run: () => this.zoomBy(10) });
    c.register({ id: 'view.zoomOut', title: S.cmd.viewZoomOut, keys: ['Ctrl+-'], run: () => this.zoomBy(-10) });
    c.register({ id: 'view.zoomReset', title: S.cmd.viewZoomReset, keys: ['Ctrl+0'], run: () => this.zoomBy(0) });
    c.register({
      id: 'view.sidePanel', title: S.cmd.viewSidePanel, keys: ['Ctrl+B'], checked: () => this.session.sidePanel.visible,
      run: () => {
        this.session.sidePanel.visible = !this.session.sidePanel.visible;
        this.applySidePanel();
        this.saveSession.trigger();
      },
    });
    c.register({
      id: 'view.toc', title: S.cmd.viewToc, keys: ['Ctrl+Alt+B'], checked: () => this.session.tocPanel.visible,
      run: () => {
        this.session.tocPanel.visible = !this.session.tocPanel.visible;
        this.applyTocPanel();
        this.saveSession.trigger();
      },
    });
    c.register({ id: 'view.openFiles.tabs', title: S.cmd.openFilesTabs, checked: () => this.settings.openFiles === 'tabs', run: () => this.setOpenFiles('tabs') });
    c.register({ id: 'view.openFiles.list', title: S.cmd.openFilesList, checked: () => this.settings.openFiles === 'list', run: () => this.setOpenFiles('list') });
    c.register({ id: 'view.theme.light', title: S.cmd.themeLight, checked: () => this.settings.theme === 'light', run: () => this.setTheme('light') });
    c.register({ id: 'view.theme.dark', title: S.cmd.themeDark, checked: () => this.settings.theme === 'dark', run: () => this.setTheme('dark') });
    c.register({ id: 'view.theme.system', title: S.cmd.themeSystem, checked: () => this.settings.theme === 'system', run: () => this.setTheme('system') });
    c.register({
      id: 'view.remoteImages', title: S.cmd.viewRemoteImages, checked: () => this.settings.allowRemoteImages,
      run: () => {
        this.settings.allowRemoteImages = !this.settings.allowRemoteImages;
        this.stashShown();
        this.renderCache.clear();
        this.showActive();
        this.saveSettings.trigger();
      },
    });

    c.register({
      id: 'view.rememberHandles', title: S.cmd.rememberHandles, checked: () => this.settings.rememberHandles,
      run: () => {
        this.settings.rememberHandles = !this.settings.rememberHandles;
        this.applyRememberHandles();
        this.saveSettings.trigger();
        this.saveSession.trigger();
      },
    });
    c.register({
      id: 'app.openWith', title: S.cmd.openWith, checked: () => !!this.info?.registered,
      run: async () => {
        const on = !this.info?.registered;
        await this.bridge.request('app.register', { on });
        if (this.info) this.info.registered = on;
        toast(on ? S.toast.openWithOn : S.toast.openWithOff);
      },
    });
    // 아직 없는 기능의 단축키(SRS 4.2). 키를 잡아 브라우저 기본 동작(뒤로 가기·즐겨찾기 등)으로 빠지지 않게 하고, 누르면 기능 이름과 함께 알린다.
    const later: [string, string, string][] = [
      ['nav.back', 'Alt+Left', S.later.back], ['nav.forward', 'Alt+Right', S.later.forward],
      ['nav.quickOpen', 'Ctrl+Shift+O', S.later.quickOpen], ['find.inFolder', 'Ctrl+Shift+F', S.later.findInFolder],
    ];
    for (const [id, key, name] of later) c.register({ id, title: S.cmd.reserved, keys: [key], reserved: true, run: () => toast(S.toast.notYet(name)) });

    // Claude Code 보고서 흐름 (v2.1): 줄로 이동, 바뀐 곳 이동, 위치 복사
    c.register({ id: 'nav.gotoLine', title: S.cmd.gotoLine, keys: ['Ctrl+G'], enabled: hasTab, run: () => this.promptGotoLine() });
    const hasChanges = () => !!this.activeDoc()?.changes?.length;
    c.register({ id: 'nav.nextChange', title: S.cmd.nextChange, keys: ['Alt+F5'], enabled: hasChanges, run: () => this.gotoChange(1) });
    c.register({ id: 'nav.prevChange', title: S.cmd.prevChange, keys: ['Alt+Shift+F5'], enabled: hasChanges, run: () => this.gotoChange(-1) });
    c.register({ id: 'edit.copyLocation', title: S.cmd.copyLocation, keys: ['Ctrl+Alt+C'], enabled: hasTab, run: () => this.copyLocation() });

    c.register({ id: 'tab.next', title: S.cmd.tabNext, keys: ['Alt+PageDown'], enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.cycle(1) });
    c.register({ id: 'tab.prev', title: S.cmd.tabPrev, keys: ['Alt+PageUp'], enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.cycle(-1) });

    c.register({ id: 'find.open', title: S.cmd.findOpen, keys: ['Ctrl+F'], enabled: hasTab, run: () => this.findbar.open(this.findPrefill(), false) });
    c.register({ id: 'find.next', title: S.cmd.findNext, keys: ['F3'], enabled: hasTab, run: () => this.findbar.step(1) });
    c.register({ id: 'find.prev', title: S.cmd.findPrev, keys: ['Shift+F3'], enabled: hasTab, run: () => this.findbar.step(-1) });

    for (const e of ENCODINGS) {
      c.register({
        id: `encoding.reopen.${e.id}`, title: S.cmd.reopenWithEncoding(e.label), enabled: hasTab,
        checked: () => this.activeDoc()?.encoding === e.id,
        run: () => this.reopenWithEncoding(e.id),
      });
    }

    c.register({ id: 'help.shortcuts', title: S.cmd.helpShortcuts, keys: ['F1'], run: () => this.showShortcuts() });
    c.register({ id: 'help.about', title: S.cmd.helpAbout, run: () => this.showAbout() });
  }

  private menus(): MenuDef[] {
    const recentFiles = (): MenuEntry[] =>
      this.session.recentFiles.length
        ? this.session.recentFiles.map((p) => ({ label: this.bridge.displayPath(p), run: () => void this.openFile(p) }))
        : [{ label: S.menu.none, disabled: true }];
    const recentFolders = (): MenuEntry[] =>
      this.session.recentFolders.length
        ? this.session.recentFolders.map((p) => ({ label: this.bridge.displayPath(p), run: () => this.setWorkspace(p, true) }))
        : [{ label: S.menu.none, disabled: true }];
    return [
      {
        label: S.menu.file, key: 'F',
        items: () => [
          { cmd: 'file.new' }, { cmd: 'file.open' }, { cmd: 'file.openFolder' }, { cmd: 'file.restoreSession' },
          { label: S.menu.recentFiles, sub: recentFiles }, { label: S.menu.recentFolders, sub: recentFolders }, { cmd: 'file.clearRecent' },
          { sep: true }, { cmd: 'file.save' }, { cmd: 'file.saveAs' },
          { sep: true }, { cmd: 'file.reload' },
          { sep: true }, { cmd: 'file.closeTab' }, { cmd: 'file.closeOthers' }, { cmd: 'file.reopenClosed' },
          { sep: true }, { cmd: 'file.copyPath' }, { cmd: 'file.reveal' },
          { sep: true }, { cmd: 'file.print' },
        ],
      },
      {
        label: S.menu.edit, key: 'E',
        items: () => [{ cmd: 'edit.undo' }, { cmd: 'edit.redo' }, { sep: true }, { cmd: 'edit.replace' }, { sep: true }, { cmd: 'edit.copyLocation' }],
      },
      {
        label: S.menu.view, key: 'V',
        items: () => [
          { cmd: 'view.preview' }, { cmd: 'view.source' }, { cmd: 'view.split' },
          { sep: true }, { cmd: 'view.wordWrap' },
          { sep: true }, { cmd: 'view.zoomIn' }, { cmd: 'view.zoomOut' }, { cmd: 'view.zoomReset' },
          { sep: true }, { cmd: 'view.sidePanel' }, { cmd: 'view.toc' },
          { label: S.menu.openFiles, sub: () => [{ cmd: 'view.openFiles.tabs' }, { cmd: 'view.openFiles.list' }] },
          { sep: true }, { label: S.menu.theme, sub: () => [{ cmd: 'view.theme.light' }, { cmd: 'view.theme.dark' }, { cmd: 'view.theme.system' }] },
        ],
      },
      { label: S.menu.find, key: 'S', items: () => [{ cmd: 'find.open' }, { cmd: 'find.next' }, { cmd: 'find.prev' }] },
      {
        label: S.menu.go, key: 'G',
        items: () => [
          { cmd: 'tab.next' }, { cmd: 'tab.prev' },
          { sep: true }, { cmd: 'nav.gotoLine' },
          { sep: true }, { cmd: 'nav.nextChange' }, { cmd: 'nav.prevChange' },
        ],
      },
      {
        label: S.menu.encoding, key: 'N',
        items: () => {
          const doc = this.activeDoc();
          return [
            { label: S.menu.currentEncoding(doc ? encodingLabel(doc) : '-'), disabled: true },
            { sep: true },
            ...ENCODINGS.map((e) => ({ cmd: `encoding.reopen.${e.id}` })),
          ];
        },
      },
      {
        label: S.menu.settings, key: 'T',
        items: () => [
          { cmd: 'settings.autoSave' },
          { cmd: 'view.remoteImages' },
          ...(this.bridge.mode === 'standalone' ? [{ cmd: 'view.rememberHandles' }] : []),
          ...(this.bridge.mode === 'desktop' ? [{ cmd: 'app.openWith' }] : []),
        ],
      },
      { label: S.menu.help, key: 'H', items: () => [{ cmd: 'help.shortcuts' }, { cmd: 'help.about' }] },
    ];
  }

  private menuIndex(label: string): number {
    return Math.max(0, this.menus().findIndex((m) => m.label === label));
  }

  private showShortcuts() {
    const table = document.createElement('table');
    table.className = 'shortcut-table';
    for (const cmd of this.cmds.all()) {
      const keys = [...(cmd.keys ?? []), ...(cmd.keyHint ?? [])];
      if (!keys.length || cmd.reserved) continue;
      const tr = document.createElement('tr');
      tr.append(
        Object.assign(document.createElement('td'), { textContent: cmd.title.replace(/…$/, '') }),
        Object.assign(document.createElement('td'), { textContent: keys.join(', ') }),
      );
      table.append(tr);
    }
    void showDialog(S.cmd.helpShortcuts, table);
  }

  private showAbout() {
    const i = this.info;
    const body = document.createElement('div');
    const lines = [
      S.dialog.version(i?.version ?? '?'),
      this.bridge.mode === 'desktop' ? S.dialog.modeDesktop : this.bridge.mode === 'launcher' ? S.dialog.modeLauncher : S.dialog.modeStandalone,
      this.bridge.mode === 'desktop' ? S.dialog.storageDesktop(i?.dataDir ?? '?') : S.dialog.storage,
    ];
    for (const l of lines) body.append(Object.assign(document.createElement('p'), { textContent: l }));
    void showDialog(S.cmd.helpAbout, body);
  }
}

/**
 * 원문 보기(CodeMirror)를 처음 쓸 때 실행한다 (SDD 7.5). 빌드가 그 번들을 `__mdvLoadSource` 함수로 감싸
 * 같은 스크립트에 넣어 두므로, 시작할 때는 구문만 훑고 실제 실행은 이때 한다.
 */
function loadSourceBundle(): Promise<typeof SourceView> {
  const w = window as any;
  if (!w.__mdvSourceView && typeof w.__mdvLoadSource === 'function') w.__mdvLoadSource();
  return w.__mdvSourceView ? Promise.resolve(w.__mdvSourceView) : Promise.reject(new Error(S.error.sourceModuleMissing));
}

/** 경계선을 끌어 패널 크기를 바꾼다. dir은 끄는 방향과 크기가 느는 방향이 같으면 1, 반대면 -1이다. */
function dragSize(handle: HTMLElement, axis: 'x' | 'y', dir: 1 | -1, start: () => number, set: (size: number) => void, done: () => void) {
  const pos = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const from = pos(e);
    const size = start();
    const move = (ev: PointerEvent) => set(size + dir * (pos(ev) - from));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      done();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

/** 퍼센트 인코딩된 조각을 푼다. 풀 수 없으면 그대로 */
function decodeFragment(f: string): string {
  try {
    return decodeURIComponent(f);
  } catch {
    return f;
  }
}

function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
