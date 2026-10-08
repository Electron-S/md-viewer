import { createBridge, HostError } from './bridge';
import { CommandRegistry } from './commands';
import { DocStore, encodingLabel, formatSize, type DocModel, type Encoding, type HostDoc } from './docs';
import { createMarkdown, renderMarkdown, scanHeadings, type Heading } from './render/markdown';
import { basename, dirname, docKey } from './render/paths';
import { createSanitizer, isViewablePath } from './render/sanitize';
import {
  Debouncer, MAX_RECENT_FILES, MAX_RECENT_FOLDERS, parseSession, parseSettings, pushRecent, SCHEMA_VERSION,
  defaultSession, defaultSettings, ZOOM_MAX, ZOOM_MIN, type SessionData, type Settings, type Theme,
} from './session';
import { TabManager, type Tab, type ViewMode } from './tabs';
import { TocPanel } from './panels/toc';
import { WorkspacePanel } from './panels/workspace';
import { PreviewView, type LinkAction } from './views/preview';
import type { SourceView } from './views/source';
import { ScrollSync } from './views/sync';
import type { FindQuery, FindStatus } from './views/find';
import { MenuBar, type MenuDef, type MenuEntry } from './ui/menubar';
import { TabBar } from './ui/tabbar';
import { StatusBar } from './ui/statusbar';
import { FindBar } from './ui/findbar';
import { showDialog, toast } from './ui/dialog';
import { applyPageStrings, S } from './strings';

interface PathEntry {
  path: string;
  isDir: boolean;
}

interface ReadyInfo {
  args: PathEntry[];
  settings: string | null;
  session: string | null;
  portable: boolean;
  version: string;
  webview2: string;
  dataDir?: string;
  trace?: boolean;
}

interface Rendered {
  docId: string;
  version: number;
  allowRemote: boolean;
  headings: Heading[];
  /** 정제된 문서 노드. 보이는 동안은 미리보기로 옮겨 가 비어 있다. */
  frag?: DocumentFragment;
  message?: { text: string; action?: { label: string; run: () => void } };
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
  /** 원문 보기는 처음 쓸 때 불러온다 (시작 번들을 줄여 NFR-PERF-01을 맞춘다). */
  source: SourceView | null = null;
  private sourceLoading: Promise<SourceView> | null = null;
  private toc = new TocPanel();
  private workspace = new WorkspacePanel(this.bridge);
  private menubar!: MenuBar;
  private tabbar!: TabBar;
  private statusbar!: StatusBar;
  private findbar = new FindBar();
  private sync!: ScrollSync;

  private renderCache = new Map<string, Rendered>();
  private shown: { docId: string; version: number; allowRemote: boolean } | null = null;
  private headings: Heading[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFragment: { docId: string; fragment: string } | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private saveSession = new Debouncer(() => this.persistSession(), 500);
  private saveSettings = new Debouncer(() => this.persistSettings(), 300);
  private systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  private started = false;

  private viewsEl = $('views');
  private emptyEl = $('empty');
  private sideEl = $('side');

  // ------------------------------------------------------------------ 시작

  async start() {
    applyPageStrings(document);
    this.buildLayout();
    this.registerCommands();
    this.menubar = new MenuBar($('menubar'), this.cmds, this.menus());
    this.tabbar = new TabBar($('tabbar'), this.tabs, (id) => this.docs.get(id));
    this.tabbar.onClose = (id) => this.closeTab(id);
    this.tabbar.onOpenDialog = () => this.cmds.run('file.open');
    this.statusbar = new StatusBar($('statusbar'));
    this.statusbar.onEncodingClick = () => this.menubar.open(this.menuIndex(S.menu.encoding), true);
    this.bindEvents();
    this.trace('script');

    // 1) 첫 화면: 호스트가 index.html에 넣어 준 부트 데이터로 그린다 (SDD 7.4, NFR-PERF-01).
    //    부트 데이터가 없으면(새로 고침 등) 바로 연결해 app.ready로 받는다.
    const boot = readBoot();
    if (!boot) this.bridge.connect();
    let ready: ReadyInfo;
    try {
      ready = boot?.ready ?? (await this.bridge.request<ReadyInfo>('app.ready'));
    } catch (err) {
      toast(S.toast.hostInitFailed((err as Error).message), 'error');
      ready = { args: [], settings: null, session: null, portable: false, version: '?', webview2: '?' };
    }
    this.info = ready;
    this.settings = parseSettings(ready.settings);
    this.session = parseSession(ready.session);
    this.applyTheme();
    this.applyZoom();
    this.applySidePanel();
    if (this.session.workspace) this.workspace.setRoot(this.session.workspace);

    const args = ready.args ?? [];
    const firstArg = [...args].reverse().find((e) => !e.isDir);
    const sess = this.session;
    const firstPath = firstArg?.path ?? sess.tabs[sess.activeIndex]?.path;
    if (firstPath) {
      const fromSession = sess.tabs.find((t) => docKey(t.path) === docKey(firstPath));
      const h = boot?.doc && docKey(boot.doc.path) === docKey(firstPath) ? boot.doc : await this.readDoc(firstPath).catch(() => null);
      if (h) {
        const doc = this.docs.upsert(h);
        const init = fromSession && !firstArg ? { mode: fromSession.mode, line: fromSession.line } : { mode: this.defaultMode(doc) };
        this.tabs.open(doc.id, doc.path, init, true);
        if (firstArg) this.session.recentFiles = pushRecent(this.session.recentFiles, doc.path, MAX_RECENT_FILES);
      }
    }
    this.started = true;
    this.showActive();
    this.tabbar.render();
    document.body.dataset.ready = '1';
    await nextPaint();
    this.trace('first-paint');

    // 2) 호스트와 연결하고 나머지(세션의 다른 탭, 다른 인자, 그사이 들어온 인자)를 연다.
    this.bridge.connect();
    let later: PathEntry[] = [];
    if (boot) {
      try {
        later = (await this.bridge.request<ReadyInfo>('app.ready')).args ?? [];
      } catch (err) {
        this.logError(S.log.appReadyFailed((err as Error).message));
      }
    }
    await this.restoreTabs(sess, firstPath).catch((err) => this.logError(S.log.restoreFailed((err as Error).message)));
    if (args.length) await this.openEntries(args);
    if (later.length) await this.openEntries(later);
    this.updateWatch();
    this.saveSession.trigger();
    document.body.dataset.restored = '1';
  }

  private buildLayout() {
    const sideContent = $('side-content');
    sideContent.append(this.toc.el, this.workspace.el);
    $('find-slot').append(this.findbar.el);
    this.viewsEl.querySelector('.pane.preview')!.append(this.preview.el);

    this.toc.onSelect = (h) => this.gotoHeading(h);
    this.workspace.onOpen = (p) => void this.openFile(p);
    this.workspace.onPickFolder = () => this.cmds.run('file.openFolder');
    this.workspace.onClose = () => this.setWorkspace(null);
    this.preview.onLink = (a) => void this.onLink(a);

    this.findbar.onQuery = (q) => this.runFind(q);
    this.findbar.onStep = (d) => this.stepFind(d);
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

    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.side-tab'))) {
      b.addEventListener('click', () => this.showSideTab(b.dataset.tab === 'workspace' ? 'workspace' : 'toc'));
    }
    this.bindResizer();
    $('empty-open').addEventListener('click', () => this.cmds.run('file.open'));
    $('empty-folder').addEventListener('click', () => this.cmds.run('file.openFolder'));
  }

  private bindEvents() {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return;
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
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;
      e.preventDefault();
      void this.bridge
        .request<{ entries: PathEntry[] }>('drop.paths', {}, Array.from(files))
        .then((r) => this.openEntries(r.entries))
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
        this.tabbar?.render();
        this.updateWatch();
        this.dropUnusedDocs();
      }
      if (kind === 'active') {
        this.tabbar?.render();
        if (this.started) this.showActive();
      }
      if (this.started) this.saveSession.trigger();
    });

    this.docs.subscribe((doc) => {
      const tab = this.tabs.active();
      if (tab?.docId === doc.id) this.scheduleRefresh();
      this.tabbar?.render();
    });

    this.systemDark.addEventListener('change', () => this.applyTheme());

    this.bridge.on('open.paths', (p: { paths: PathEntry[] }) => void this.openEntries(p.paths));
    this.bridge.on('file.changed', (p: { path: string }) => void this.reloadPath(p.path));
    this.bridge.on('file.deleted', (p: { path: string }) => {
      this.docs.markDeleted(p.path);
    });
    this.bridge.on('app.closing', () => void this.quit());

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

  async openEntries(entries: PathEntry[]) {
    let lastFile: Tab | undefined;
    for (const e of entries) {
      if (e.isDir) this.setWorkspace(e.path, true);
      else lastFile = (await this.openFile(e.path, { activate: false })) ?? lastFile;
    }
    if (lastFile) this.tabs.activate(lastFile.id);
  }

  async openFile(path: string, opts: { fragment?: string; activate?: boolean; mode?: ViewMode; line?: number } = {}): Promise<Tab | undefined> {
    const existing = this.tabs.byDoc(docKey(path));
    if (existing) {
      if (opts.activate !== false) this.tabs.activate(existing.id);
      if (opts.fragment) this.gotoFragment(existing, opts.fragment);
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
    if (opts.fragment) this.pendingFragment = { docId: doc.id, fragment: opts.fragment };
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

  closeTab(id: number) {
    this.tabs.close(id);
  }

  private dropUnusedDocs() {
    const used = new Set(this.tabs.tabs.map((t) => t.docId));
    for (const id of [...this.renderCache.keys()]) if (!used.has(id)) this.renderCache.delete(id);
    for (const t of this.tabs.closed) {
      const id = docKey(t.path);
      if (!used.has(id)) this.docs.remove(id);
    }
  }

  private async reloadPath(path: string) {
    const doc = this.docs.byPath(path);
    if (!doc) return;
    try {
      this.docs.upsert(await this.readDoc(doc.path, doc.forcedEncoding));
    } catch (err) {
      if (err instanceof HostError && err.code === 'ENOENT') this.docs.markDeleted(path);
      else this.logError(S.log.reloadFailed(path, (err as Error).message));
    }
  }

  private async reopenWithEncoding(enc: Encoding) {
    const doc = this.activeDoc();
    if (!doc) return;
    this.docs.update(doc.id, { forcedEncoding: enc });
    this.docs.upsert(await this.readDoc(doc.path, enc));
  }

  setWorkspace(path: string | null, show = false) {
    this.session.workspace = path;
    this.workspace.setRoot(path);
    if (path) this.session.recentFolders = pushRecent(this.session.recentFolders, path, MAX_RECENT_FOLDERS);
    if (show && path) this.showSideTab('workspace');
    this.saveSession.trigger();
  }

  private updateWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      const paths = [...new Set(this.tabs.tabs.map((t) => t.path))];
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
      return;
    }
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
      if (this.source.docId !== doc.id || this.source.docVersion !== doc.version) {
        this.source.setText(doc.id, doc.version, doc.binary ? '' : doc.text);
      }
    }
    const r = this.getRendered(doc);
    this.headings = r.headings;
    if (tab.mode !== 'source') this.showPreview(r);
    this.toc.setHeadings(this.headings);
    this.statusbar.render(doc, tab.mode, this.settings.zoom);
    this.workspace.setActive(doc.path);
    document.title = S.windowTitle(basename(doc.path));
    const line = tab.line;
    const fragment = this.pendingFragment?.docId === doc.id ? this.pendingFragment.fragment : null;
    this.pendingFragment = null;
    requestAnimationFrame(() => {
      if (fragment) this.gotoFragment(tab, fragment);
      else this.scrollVisible(tab, line);
      this.toc.setCurrentLine(tab.line);
      requestAnimationFrame(() => (this.sync.suspended = false));
    });
    this.findbar.refresh();
  }

  /** 원문 보기 모듈을 불러와 붙인다. 여러 번 불러도 한 번만 만든다. */
  loadSource(): Promise<SourceView> {
    if (!this.sourceLoading) {
      this.sourceLoading = loadSourceBundle().then((SourceViewCtor) => {
        const view = new SourceViewCtor();
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
    if (s && s.docId === r.docId && s.version === r.version && s.allowRemote === r.allowRemote) return;
    this.stashShown();
    if (r.message) this.preview.setMessage(r.message.text, r.message.action);
    else this.preview.setContent(r.frag!);
    this.shown = { docId: r.docId, version: r.version, allowRemote: r.allowRemote };
  }

  /** 보이던 문서 노드를 캐시로 되돌린다 (복제하지 않고 옮긴다). */
  private stashShown() {
    const s = this.shown;
    if (!s) return;
    const prev = this.renderCache.get(s.docId);
    const content = this.preview.takeContent();
    if (prev && !prev.message && prev.version === s.version && prev.allowRemote === s.allowRemote) prev.frag = content;
    this.shown = null;
  }

  /** 렌더링 결과를 캐시에서 꺼내거나 새로 만든다 (SDD 8.1). */
  private getRendered(doc: DocModel): Rendered {
    const allowRemote = this.settings.allowRemoteImages;
    const cached = this.renderCache.get(doc.id);
    if (cached && cached.version === doc.version && cached.allowRemote === allowRemote) {
      this.renderCache.delete(doc.id);
      this.renderCache.set(doc.id, cached);
      return cached;
    }
    const r: Rendered = { docId: doc.id, version: doc.version, allowRemote, headings: [] };
    if (doc.binary) {
      r.message = { text: S.preview.binary };
    } else if (doc.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'mdv-plain';
      pre.setAttribute('data-line', '0');
      pre.textContent = doc.text;
      r.frag = document.createDocumentFragment();
      r.frag.append(pre);
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
        r.frag = this.sanitizer.sanitize(out.html, { docDir: dirname(doc.path), allowRemoteImages: allowRemote });
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

  private gotoFragment(tab: Tab, fragment: string) {
    const h = this.headings.find((x) => x.id === fragment || x.id === fragment.toLowerCase());
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
      await this.openFile(a.path, { fragment: a.fragment });
    } else {
      // 문서가 아닌 로컬 파일은 실행하지 않고 탐색기에서 위치만 보여준다 (SRS 4.3).
      await this.bridge.request('shell.reveal', { path: a.path }).catch((err) => this.reportError(err));
    }
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

  private findPrefill(): string {
    if (this.findTarget() === 'source') return this.source?.selectionText() ?? '';
    return window.getSelection()?.toString() ?? '';
  }

  // ------------------------------------------------------------------ 설정·테마·패널

  private isDark(): boolean {
    return this.settings.theme === 'dark' || (this.settings.theme === 'system' && this.systemDark.matches);
  }

  private applyTheme() {
    const dark = this.isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    this.source?.setDark(dark);
    void this.bridge.request('window.setTheme', { dark }).catch(() => {});
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

  private applySidePanel() {
    const sp = this.session.sidePanel;
    this.sideEl.hidden = !sp.visible;
    $('resizer').hidden = !sp.visible;
    this.sideEl.style.width = `${sp.width}px`;
    this.selectSideTab(sp.tab);
  }

  /** 패널 탭을 고르고, 숨겨져 있으면 연다. */
  private showSideTab(tab: 'toc' | 'workspace', save = true) {
    if (!this.session.sidePanel.visible) {
      this.session.sidePanel.visible = true;
      this.sideEl.hidden = false;
      $('resizer').hidden = false;
    }
    this.selectSideTab(tab);
    if (save) this.saveSession.trigger();
  }

  private selectSideTab(tab: 'toc' | 'workspace') {
    this.session.sidePanel.tab = tab;
    this.toc.el.hidden = tab !== 'toc';
    this.workspace.el.hidden = tab !== 'workspace';
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('.side-tab'))) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  private bindResizer() {
    const resizer = $('resizer');
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.sideEl.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        const w = Math.round(Math.min(600, Math.max(160, startW + ev.clientX - startX)));
        this.sideEl.style.width = `${w}px`;
        this.session.sidePanel.width = w;
      };
      const up = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        this.saveSession.trigger();
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
    });
  }

  private renderRecentList() {
    const list = $('empty-recent');
    list.replaceChildren();
    for (const p of this.session.recentFiles.slice(0, 8)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'link-button';
      b.textContent = basename(p);
      b.title = p;
      b.addEventListener('click', () => void this.openFile(p));
      li.append(b, Object.assign(document.createElement('span'), { className: 'recent-dir', textContent: p }));
      list.append(li);
    }
    $('empty-recent-title').hidden = !this.session.recentFiles.length;
  }

  // ------------------------------------------------------------------ 저장·종료

  private sessionData(): SessionData {
    const tabs = this.tabs.tabs;
    return {
      ...this.session,
      schemaVersion: SCHEMA_VERSION,
      tabs: tabs.map((t) => ({ path: t.path, mode: t.mode, line: Math.round(t.line * 100) / 100 })),
      activeIndex: Math.max(0, tabs.findIndex((t) => t.id === this.tabs.activeId)),
    };
  }

  private persistSession() {
    const data = JSON.stringify(this.sessionData(), null, 2);
    void this.bridge.request('store.save', { name: 'session', data }).catch((err) => this.logError(String(err)));
  }

  private persistSettings() {
    const data = { ...this.settings, schemaVersion: SCHEMA_VERSION };
    void this.bridge.request('store.save', { name: 'settings', data: JSON.stringify(data, null, 2) }).catch((err) => this.logError(String(err)));
  }

  private async quit() {
    this.saveSettings.flush();
    try {
      await this.bridge.request('store.save', { name: 'session', data: JSON.stringify(this.sessionData(), null, 2) });
    } finally {
      await this.bridge.request('app.quit').catch(() => {});
    }
  }

  private reportError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(msg, 'error');
    this.logError(msg);
  }

  /** 시작 단계 계측 (MDVIEW_TRACE=1). 연결 전에는 줄 세워 두므로 화면 시각(epoch ms)을 함께 보낸다. */
  private trace(msg: string) {
    if (this.info && !this.info.trace) return;
    const at = performance.timeOrigin + performance.now();
    void this.bridge.request('app.log', { level: 'trace', msg, at }).catch(() => {});
  }

  private logError(msg: string) {
    void this.bridge.request('app.log', { level: 'error', msg }).catch(() => {});
  }

  // ------------------------------------------------------------------ 명령·메뉴

  private setMode(mode: ViewMode) {
    const tab = this.tabs.active();
    if (!tab || tab.mode === mode) return;
    this.tabs.setMode(tab.id, mode);
    this.showActive();
  }

  private print() {
    const tab = this.tabs.active();
    const doc = this.activeDoc();
    if (!tab || !doc) return;
    if (tab.mode === 'source') this.showPreview(this.getRendered(doc));
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  }

  private async copyText(text: string) {
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
    toast(S.toast.copied);
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
        if (doc) await this.reloadPath(doc.path);
      },
    });
    c.register({ id: 'file.closeTab', title: S.cmd.fileCloseTab, keys: ['Ctrl+W', 'Ctrl+F4'], enabled: hasTab, run: () => this.closeTab(this.tabs.activeId!) });
    c.register({
      id: 'file.closeOthers', title: S.cmd.fileCloseOthers, enabled: () => this.tabs.tabs.length > 1,
      run: () => this.tabs.closeOthers(this.tabs.activeId!),
    });
    c.register({
      id: 'file.reopenClosed', title: S.cmd.fileReopenClosed, keys: ['Ctrl+Shift+T'], enabled: () => this.tabs.closed.length > 0,
      run: async () => {
        const t = this.tabs.popClosed();
        if (t) await this.openFile(t.path, { mode: t.mode, line: t.line });
      },
    });
    c.register({ id: 'file.copyPath', title: S.cmd.fileCopyPath, enabled: hasTab, run: () => this.copyText(this.activeDoc()!.path) });
    c.register({
      id: 'file.reveal', title: S.cmd.fileReveal, enabled: hasTab,
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
    c.register({ id: 'app.exit', title: S.cmd.appExit, run: () => window.close() });

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
    c.register({ id: 'view.toc', title: S.cmd.viewToc, checked: () => this.session.sidePanel.visible && this.session.sidePanel.tab === 'toc', run: () => this.showSideTab('toc') });
    c.register({
      id: 'view.workspace', title: S.cmd.viewWorkspace,
      checked: () => this.session.sidePanel.visible && this.session.sidePanel.tab === 'workspace',
      run: () => this.showSideTab('workspace'),
    });
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

    c.register({ id: 'tab.next', title: S.cmd.tabNext, keys: ['Ctrl+Tab', 'Ctrl+PageDown'], enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.cycle(1) });
    c.register({ id: 'tab.prev', title: S.cmd.tabPrev, keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], enabled: () => this.tabs.tabs.length > 1, run: () => this.tabs.cycle(-1) });

    c.register({ id: 'find.open', title: S.cmd.findOpen, keys: ['Ctrl+F'], enabled: hasTab, run: () => this.findbar.open(this.findPrefill()) });
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
        ? this.session.recentFiles.map((p) => ({ label: p, run: () => void this.openFile(p) }))
        : [{ label: S.menu.none, disabled: true }];
    const recentFolders = (): MenuEntry[] =>
      this.session.recentFolders.length
        ? this.session.recentFolders.map((p) => ({ label: p, run: () => this.setWorkspace(p, true) }))
        : [{ label: S.menu.none, disabled: true }];
    return [
      {
        label: S.menu.file, key: 'F',
        items: () => [
          { cmd: 'file.open' }, { cmd: 'file.openFolder' },
          { label: S.menu.recentFiles, sub: recentFiles }, { label: S.menu.recentFolders, sub: recentFolders }, { cmd: 'file.clearRecent' },
          { sep: true }, { cmd: 'file.reload' },
          { sep: true }, { cmd: 'file.closeTab' }, { cmd: 'file.closeOthers' }, { cmd: 'file.reopenClosed' },
          { sep: true }, { cmd: 'file.copyPath' }, { cmd: 'file.reveal' },
          { sep: true }, { cmd: 'file.print' },
          { sep: true }, { cmd: 'app.exit' },
        ],
      },
      {
        label: S.menu.view, key: 'V',
        items: () => [
          { cmd: 'view.preview' }, { cmd: 'view.source' }, { cmd: 'view.split' },
          { sep: true }, { cmd: 'view.wordWrap' },
          { sep: true }, { cmd: 'view.zoomIn' }, { cmd: 'view.zoomOut' }, { cmd: 'view.zoomReset' },
          { sep: true }, { cmd: 'view.sidePanel' },
          { sep: true }, { label: S.menu.theme, sub: () => [{ cmd: 'view.theme.light' }, { cmd: 'view.theme.dark' }, { cmd: 'view.theme.system' }] },
        ],
      },
      { label: S.menu.find, key: 'S', items: () => [{ cmd: 'find.open' }, { cmd: 'find.next' }, { cmd: 'find.prev' }] },
      {
        label: S.menu.go, key: 'G',
        items: () => [{ cmd: 'tab.next' }, { cmd: 'tab.prev' }, { sep: true }, { cmd: 'view.toc' }, { cmd: 'view.workspace' }],
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
      { label: S.menu.settings, key: 'T', items: () => [{ cmd: 'view.remoteImages' }] },
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
      if (!cmd.keys?.length) continue;
      const tr = document.createElement('tr');
      tr.append(
        Object.assign(document.createElement('td'), { textContent: cmd.title.replace(/…$/, '') }),
        Object.assign(document.createElement('td'), { textContent: cmd.keys.join(', ') }),
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
      S.dialog.webview2(i?.webview2 ?? '?'),
      i?.portable ? S.dialog.portable : S.dialog.installed,
      i?.dataDir ? S.dialog.dataDir(i.dataDir) : '',
    ].filter(Boolean);
    for (const l of lines) body.append(Object.assign(document.createElement('p'), { textContent: l }));
    void showDialog(S.cmd.helpAbout, body);
  }
}

/** 원문 보기 번들(source.js)을 한 번만 불러온다. */
function loadSourceBundle(): Promise<typeof SourceView> {
  const w = window as any;
  if (w.__mdvSourceView) return Promise.resolve(w.__mdvSourceView);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'source.js';
    s.onload = () => (w.__mdvSourceView ? resolve(w.__mdvSourceView) : reject(new Error(S.error.sourceModuleMissing)));
    s.onerror = () => reject(new Error(S.error.sourceModuleLoad));
    document.head.append(s);
  });
}

interface Boot {
  ready: ReadyInfo;
  doc?: HostDoc;
}

/** 호스트가 index.html에 넣어 준 부트 데이터를 한 번만 읽는다. */
function readBoot(): Boot | null {
  const el = document.getElementById('mdv-boot');
  if (!el) return null;
  el.remove();
  try {
    const v = JSON.parse(el.textContent ?? '');
    return v && typeof v === 'object' && v.ready ? (v as Boot) : null;
  } catch {
    return null;
  }
}

function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
