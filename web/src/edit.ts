// 편집 조정자 (SDD 4장·7.7, FR-EDIT-01~10). 원문 보기(편집기)·문서 모델·브리지 사이를 잇는다.
// 원문 보기(CodeMirror)는 처음 쓸 때 불러오므로(SDD 7.5) 여기서 가져오지 않고, 콜백과 메서드로만 다룬다.
import { HostError, type Bridge, type HostDoc } from './bridge';
import type { DocModel, DocStore } from './docs';
import { encodeText, findUnencodable, saveEolOf, type Encoding, type SaveEol } from './encoding';
import { basename, dirname, docKey, isAbsolutePath, isDocumentPath, isMarkdownPath, joinPath, normalizePath, untitledPath } from './render/paths';
import { S } from './strings';
import type { TabManager } from './tabs';
import { promptText, showDialog, toast } from './ui/dialog';
import type { SourceView } from './views/source';

/** 입력이 멈춘 뒤 편집기 본문을 문서 모델에 반영하기까지의 최소 시간. 미리보기를 그리는 데 오래 걸린 문서는 더 기다린다 (SDD 8.1). */
const SYNC_MIN_MS = 200;
/** 자동 저장: 입력이 멈추고 이만큼 지나면 저장한다 (FR-EDIT-10) */
const AUTOSAVE_MS = 1000;

/** 편집 조정자가 앱에 기대는 것 */
export interface EditHost {
  readonly bridge: Bridge;
  readonly docs: DocStore;
  readonly tabs: TabManager;
  source(): SourceView | null;
  autoSave(): boolean;
  /** 실행기 허용 폴더(경로 입력의 기본 위치) */
  roots(): string[];
  workspace(): string | null;
  readDoc(path: string, encoding?: Encoding): Promise<HostDoc>;
  /** 편집기 본문을 문서 모델에 반영했다. 활성 탭이면 미리보기·목차·상태 표시줄을 고친다. */
  edited(doc: DocModel): void;
  /** 다른 이름으로 저장해 문서가 새 위치로 옮겨졌다. 탭·감시·세션을 옮긴다. */
  moved(oldId: string, doc: DocModel): void;
  /** 확인 없이 탭을 닫는다. */
  closeTab(id: number): void;
  log(msg: string): void;
}

/** 저장할 바이트와 그 형식 */
interface Prepared {
  text: string;
  enc: Encoding;
  bom: boolean;
  eol: SaveEol;
  bytes: Uint8Array;
}

export class EditController {
  /** 미리보기를 마지막으로 그린 시간(ms). 반영 지연을 정한다. */
  lastRenderMs = 0;
  /** Windows 앱 창을 닫기로 했다. 이때는 브라우저 확인 창(beforeunload)을 띄우지 않는다. */
  quitting = false;
  private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private saving = new Map<string, Promise<boolean>>();
  /** 고친 채 밖에서 바뀐 문서 → 그때 디스크에서 읽은 내용 (FR-EDIT-09) */
  private conflicts = new Map<string, HostDoc>();
  /** 자동 저장을 멈춘 문서(권한 없음·충돌·인코딩 확인이 필요함) */
  private autoOff = new Set<string>();
  /** 대체 문자로 저장해도 된다고 답한 문서 */
  private lossyOk = new Set<string>();
  private untitledSeq = 0;
  private reportedDirty = false;
  private closing = false;

  constructor(
    private host: EditHost,
    private barEl: HTMLElement,
  ) {
    host.docs.subscribe(() => this.reportDirty());
  }

  private get docs() {
    return this.host.docs;
  }

  private get bridge() {
    return this.host.bridge;
  }

  // ------------------------------------------------------------------ 입력 → 문서 모델 (SDD 7.7-1~2)

  /** 사용자가 편집기에서 본문을 고쳤다. 수정됨은 곧바로 켜고, 모델 반영은 입력이 멈춘 뒤에 한다. */
  onSourceChange(docId: string) {
    const doc = this.docs.get(docId);
    if (!doc) return;
    if (!doc.dirty) this.docs.update(docId, { dirty: true });
    const old = this.syncTimers.get(docId);
    if (old) clearTimeout(old);
    const delay = Math.max(SYNC_MIN_MS, Math.round(this.lastRenderMs));
    this.syncTimers.set(docId, setTimeout(() => this.sync(docId), delay));
  }

  /** 편집기 본문을 문서 모델에 반영한다. 반영할 것이 없으면 지금 모델을 돌려준다. */
  sync(docId: string): DocModel | undefined {
    const t = this.syncTimers.get(docId);
    if (t) clearTimeout(t);
    this.syncTimers.delete(docId);
    const text = this.host.source()?.textOf(docId);
    if (text == null) return this.docs.get(docId);
    const before = this.docs.get(docId);
    const doc = this.docs.applyEdit(docId, text);
    if (!doc) return undefined;
    this.host.source()?.syncVersion(docId, doc.version);
    if (doc !== before) this.host.edited(doc);
    if (doc.dirty) this.scheduleAutoSave(docId);
    return doc;
  }

  /** 기다리는 반영을 모두 지금 한다(저장·탭 전환·닫기 전에). */
  flush() {
    for (const id of [...this.syncTimers.keys()]) this.sync(id);
  }

  /** 열린 탭 중 저장하지 않은 문서가 있는지 */
  hasDirty(): boolean {
    return this.host.tabs.tabs.some((t) => this.docs.get(t.docId)?.dirty);
  }

  /** Windows 앱에 알린다: 고친 문서가 있는 동안 창 닫기를 강제로 끝내지 않는다 (FR-EDIT-08, SDD 6.4). */
  private reportDirty() {
    if (this.bridge.mode !== 'desktop') return;
    const dirty = this.hasDirty();
    if (dirty === this.reportedDirty) return;
    this.reportedDirty = dirty;
    void this.bridge.request('app.setDirty', { dirty }).catch(() => {});
  }

  // ------------------------------------------------------------------ 저장 (SDD 7.7-3~4)

  /** 저장(Ctrl+S). 쓸 곳이 없는 문서(새 문서·핸들 없는 문서)는 다른 이름으로 저장으로 넘긴다. 저장했으면 true. */
  save(docId: string, opts: { as?: boolean; auto?: boolean } = {}): Promise<boolean> {
    const prev = this.saving.get(docId);
    const run = (async () => {
      if (prev) await prev.catch(() => false);
      return this.doSave(docId, opts);
    })();
    this.saving.set(docId, run);
    const clear = () => {
      if (this.saving.get(docId) === run) this.saving.delete(docId);
    };
    run.then(clear, clear);
    return run;
  }

  private async doSave(docId: string, opts: { as?: boolean; auto?: boolean }): Promise<boolean> {
    const auto = !!opts.auto;
    const doc = this.sync(docId);
    if (!doc) return false;
    if (doc.binary) {
      if (!auto) toast(S.edit.binary, 'error');
      return false;
    }
    if (opts.as || doc.untitled) return auto ? false : this.saveAs(doc);
    if (!doc.dirty && doc.state !== 'deleted' && !this.conflicts.has(doc.id)) return true;
    const p = await this.prepare(doc, auto);
    if (!p) return false;
    const deleted = doc.state === 'deleted';
    const write = (base: boolean) =>
      this.bridge.request<{ mtime: number; size: number }>('file.write', {
        path: doc.path, bytes: p.bytes, create: deleted, overwrite: deleted, prompt: !auto,
        ...(base && !deleted ? { baseMtime: doc.mtime, baseSize: doc.size } : {}),
      });
    let r: { mtime: number; size: number };
    try {
      r = await write(true);
    } catch (err) {
      const code = err instanceof HostError ? err.code : '';
      const name = basename(doc.path);
      if (auto) {
        this.pauseAuto(doc, code === 'EACCES' && /^mdv:/i.test(doc.path) ? S.edit.writeDenied : (err as Error).message);
        return false;
      }
      if (code === 'ENOTSUP') return this.saveAs(doc);
      if (code === 'ECONFLICT') {
        if (!(await this.ask(S.edit.conflictTitle, S.edit.conflictBody(name), S.edit.overwrite))) return false;
        try {
          r = await write(false);
        } catch (err2) {
          toast(S.edit.saveFailed(name, (err2 as Error).message), 'error');
          return false;
        }
      } else {
        // 파일 핸들(mdv:)의 EACCES는 브라우저 쓰기 권한이 없다는 뜻이다. 다시 저장하면 권한을 묻는다.
        toast(S.edit.saveFailed(name, code === 'EACCES' && /^mdv:/i.test(doc.path) ? S.edit.writeDenied : (err as Error).message), 'error');
        return false;
      }
    }
    this.applySaved(doc.id, p, r);
    if (!auto) this.autoOff.delete(doc.id);
    if (doc.eol === 'Mixed' && !auto) toast(S.edit.mixedEol(p.eol));
    return true;
  }

  /**
   * 저장할 바이트를 만든다 (FR-EDIT-04, SDD 8.3). 원래 인코딩·BOM·줄 끝을 지키되, 읽을 때 잘못된 바이트가 있었거나
   * 원래 인코딩에 없는 글자가 있으면 먼저 묻는다. 자동 저장은 묻지 않고 그 문서의 자동 저장을 멈춘다.
   */
  private async prepare(doc: DocModel, auto: boolean): Promise<Prepared | null> {
    const text = doc.text;
    if (doc.decodeWarning && !this.lossyOk.has(doc.id)) {
      if (auto) return this.pauseAuto(doc, S.edit.lossyBody);
      if (!(await this.ask(S.edit.encodingTitle, S.edit.lossyBody, S.edit.save))) return null;
      this.lossyOk.add(doc.id);
    }
    let enc = doc.encoding;
    let bom = doc.hasBom;
    if (enc === 'cp949') {
      const bad = findUnencodable(text, enc);
      if (bad.length) {
        if (auto) return this.pauseAuto(doc, S.edit.unencodableBody('CP949', bad.join(' ')));
        if (!(await this.ask(S.edit.encodingTitle, S.edit.unencodableBody('CP949', bad.join(' ')), S.edit.saveUtf8))) return null;
        enc = 'utf-8';
        bom = false;
      }
    }
    const eol = saveEolOf(doc.eol, doc.eolCounts);
    return { text, enc, bom, eol, bytes: encodeText(text, enc, bom, eol) };
  }

  private applySaved(docId: string, p: Prepared, r: { mtime: number; size: number }) {
    let n = 0;
    for (let i = p.text.indexOf('\n'); i >= 0; i = p.text.indexOf('\n', i + 1)) n++;
    const eol = n ? p.eol : 'None';
    this.docs.markSaved(docId, {
      text: p.text, mtime: r.mtime, size: r.size, encoding: p.enc, hasBom: p.bom, eol,
      eolCounts: { crlf: eol === 'CRLF' ? n : 0, lf: eol === 'LF' ? n : 0, cr: eol === 'CR' ? n : 0 },
    });
    this.conflicts.delete(docId);
    this.updateBar();
  }

  /** 다른 이름으로 저장 (FR-EDIT-05). 저장했으면 탭이 새 위치를 가리킨다. */
  async saveAs(doc: DocModel): Promise<boolean> {
    let target: string | null;
    let confirmed = false;
    if (this.bridge.mode === 'launcher' && (doc.untitled || !/^mdv:/i.test(doc.path))) {
      // 실행기 모드는 OS 경로가 있어야 감시·상대 경로 그림이 이어진다. 브라우저 저장 대화상자로는 그 경로를 얻지 못하므로 묻는다.
      target = await this.promptPath(doc);
    } else {
      try {
        const osDir = doc.untitled || /^mdv:/i.test(doc.path) ? undefined : dirname(doc.path);
        target = (await this.bridge.request<{ path: string | null }>('dialog.saveFile', { suggestedName: basename(doc.path), dir: osDir })).path;
        confirmed = true;
      } catch (err) {
        if (err instanceof HostError && err.code === 'ENOTSUP') return this.download(doc);
        throw err;
      }
    }
    if (!target) return false;
    const name = basename(target);
    if (!isDocumentPath(target)) {
      toast(S.edit.notDocument, 'error');
      return false;
    }
    const newId = docKey(target);
    const otherTab = newId !== doc.id ? this.host.tabs.byDoc(newId) : undefined;
    if (otherTab && this.docs.get(otherTab.docId)?.dirty) {
      toast(S.edit.alreadyOpenDirty(name), 'error');
      return false;
    }
    const p = await this.prepare(doc, false);
    if (!p) return false;
    const write = (overwrite: boolean) => this.bridge.request<{ mtime: number; size: number }>('file.write', { path: target, bytes: p.bytes, create: true, overwrite });
    let r: { mtime: number; size: number };
    try {
      r = await write(confirmed);
    } catch (err) {
      const code = err instanceof HostError ? err.code : '';
      if (code === 'EEXIST' && (await this.ask(S.edit.saveAsTitle, S.edit.existsBody(name), S.edit.overwrite))) {
        try {
          r = await write(true);
        } catch (err2) {
          toast(S.edit.saveFailed(name, (err2 as Error).message), 'error');
          return false;
        }
      } else {
        if (code !== 'EEXIST') toast(code === 'EACCES' && this.bridge.mode === 'launcher' ? S.edit.outsideRoots : S.edit.saveFailed(name, (err as Error).message), 'error');
        return false;
      }
    }
    let id = doc.id;
    if (newId !== doc.id) {
      if (otherTab) this.host.closeTab(otherTab.id);
      this.docs.remove(newId);
      this.host.source()?.drop(newId);
      const moved = this.docs.rekey(doc.id, normalizePath(target), isMarkdownPath(target) ? 'markdown' : 'text');
      if (!moved) return false;
      this.conflicts.delete(doc.id);
      this.host.moved(doc.id, moved);
      id = moved.id;
    }
    this.applySaved(id, p, r);
    return true;
  }

  /** 실행기 모드: 저장할 OS 경로를 묻는다. 기본은 문서 폴더(새 문서는 작업 공간이나 첫 허용 폴더)와 이름이다. */
  private async promptPath(doc: DocModel): Promise<string | null> {
    const ws = this.host.workspace();
    const base = doc.untitled ? (ws && !/^mdv:/i.test(ws) ? ws : this.host.roots()[0] ?? '') : dirname(doc.path);
    const def = base ? joinPath(base, basename(doc.path)) : basename(doc.path);
    const roots = this.host.roots();
    const v = await promptText(S.edit.saveAsTitle, S.edit.saveAsLabel, def, roots.length ? S.edit.saveAsHint(roots.join(', ')) : undefined);
    const p = v?.trim();
    if (!p) return null;
    if (!isAbsolutePath(p)) {
      toast(S.error.badPath, 'error');
      return null;
    }
    return normalizePath(p);
  }

  /** 저장 대화상자가 없는 브라우저(Firefox·Safari): 내려받기로 저장한다. 문서는 그대로 두고 수정됨만 끈다. */
  private async download(doc: DocModel): Promise<boolean> {
    const p = await this.prepare(doc, false);
    if (!p) return false;
    const url = URL.createObjectURL(new Blob([p.bytes as BlobPart], { type: doc.kind === 'markdown' ? 'text/markdown' : 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: basename(doc.path) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.docs.update(doc.id, { savedText: p.text, dirty: false });
    toast(S.edit.downloaded(basename(doc.path)));
    return true;
  }

  // ------------------------------------------------------------------ 새 문서 (FR-EDIT-06)

  newDocument(): DocModel {
    let k = ++this.untitledSeq;
    while (this.docs.get(docKey(untitledPath(k, S.edit.untitled(k))))) k = ++this.untitledSeq;
    return this.docs.create(untitledPath(k, S.edit.untitled(k)));
  }

  // ------------------------------------------------------------------ 밖의 변경 (FR-EDIT-09, SDD 7.7-5)

  /**
   * 감시가 알린 변경. 다시 읽은 내용이 마지막으로 읽거나 저장한 것과 같으면(자기 저장의 메아리, 실행기 재연결) 무시한다.
   * 고치지 않은 문서는 다시 읽고, 고친 문서는 덮지 않고 알림 띠를 띄운다.
   */
  async onFileChanged(path: string) {
    const first = this.docs.byPath(path);
    if (!first || first.untitled) return;
    await this.saving.get(first.id)?.catch(() => false);
    let h: HostDoc;
    try {
      h = await this.host.readDoc(first.path, first.forcedEncoding);
    } catch (err) {
      if (err instanceof HostError && err.code === 'ENOENT') this.docs.markDeleted(path);
      else this.host.log(S.log.reloadFailed(path, (err as Error).message));
      return;
    }
    const cur = this.docs.byPath(path);
    if (!cur) return;
    if (h.text === cur.savedText && h.encoding === cur.encoding && h.hasBom === cur.hasBom && h.eol === cur.eol) {
      if (cur.mtime !== h.mtime || cur.size !== h.size || cur.state === 'deleted') this.docs.update(cur.id, { mtime: h.mtime, size: h.size, state: 'ok' });
      if (this.conflicts.delete(cur.id)) this.updateBar();
      return;
    }
    const now = this.sync(cur.id) ?? cur;
    if (!now.dirty) {
      // 바뀐 곳을 남겨 미리보기·원문 보기에 표시한다 (FR-WATCH-05).
      this.docs.upsert(h, false, true);
      if (this.conflicts.delete(now.id)) this.updateBar();
      return;
    }
    this.conflicts.set(now.id, h);
    this.updateBar();
  }

  /** 고친 문서를 버리고 디스크에서 다시 읽어도 되는지 묻는다(F5·인코딩 바꿔 다시 읽기). 고치지 않았으면 묻지 않는다. */
  async confirmDiscard(docId: string): Promise<boolean> {
    const doc = this.sync(docId);
    if (!doc?.dirty) return true;
    if (!(await this.ask(S.edit.discardTitle, S.edit.discardBody(basename(doc.path)), S.edit.discard))) return false;
    this.discard(docId);
    return true;
  }

  /** 고친 내용을 버린다: 편집 상태(실행 취소 기록 포함)를 지우고 수정됨을 끈다. 부른 쪽이 디스크에서 다시 읽는다. */
  discard(docId: string) {
    this.host.source()?.drop(docId);
    this.conflicts.delete(docId);
    this.autoOff.delete(docId);
    const doc = this.docs.get(docId);
    if (doc?.dirty) this.docs.update(docId, { dirty: false });
    this.updateBar();
  }

  /** 알림 띠: 활성 탭의 문서가 고친 채 밖에서 바뀌었을 때만 보인다. */
  updateBar() {
    const tab = this.host.tabs.active();
    const id = tab?.docId;
    const h = id ? this.conflicts.get(id) : undefined;
    this.barEl.hidden = !h;
    this.barEl.replaceChildren();
    if (!h || !id) return;
    const btn = (label: string, run: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', run);
      return b;
    };
    this.barEl.append(
      Object.assign(document.createElement('span'), { textContent: S.edit.changedBar }),
      btn(S.edit.reloadDisk, () => void this.reloadFromDisk(id)),
      btn(S.edit.keepMine, () => {
        // 내 것을 두면 다음 저장에서 디스크와 다르다는 것(ECONFLICT)을 다시 묻는다.
        this.conflicts.delete(id);
        this.updateBar();
      }),
    );
  }

  private async reloadFromDisk(docId: string) {
    const doc = this.docs.get(docId);
    if (!doc) return;
    let h = this.conflicts.get(docId);
    try {
      h = await this.host.readDoc(doc.path, doc.forcedEncoding);
    } catch {
      // 그사이 지워졌으면 알렸던 내용을 쓴다.
    }
    this.discard(docId);
    if (h) this.docs.upsert(h, true, true);
  }

  // ------------------------------------------------------------------ 닫기 확인 (FR-EDIT-08, SDD 7.7-6)

  /**
   * 문서들을 닫아도 되는지 묻는다. 고친 문서마다 [저장][저장 안 함][취소]. 저장을 고르면 저장하고(실패하거나 다른 이름으로 저장을
   * 취소하면 닫지 않음), 저장 안 함이면 고친 내용을 버린다. 모두 닫아도 되면 true.
   */
  async confirmClose(docIds: string[], focus?: (docId: string) => void): Promise<boolean> {
    this.flush();
    const drop: string[] = [];
    for (const id of docIds) {
      const doc = this.docs.get(id);
      if (!doc?.dirty) continue;
      focus?.(id);
      const v = await showDialog(S.edit.closeTitle, S.edit.closeBody(basename(doc.path)), [
        { label: S.edit.save, value: 'save', primary: true },
        { label: S.edit.dontSave, value: 'discard' },
        { label: S.edit.cancel, value: 'cancel' },
      ]);
      if (v === 'save') {
        if (!(await this.save(id))) return false;
      } else if (v === 'discard') {
        drop.push(id);
      } else {
        return false;
      }
    }
    // 뒤의 문서에서 취소하면 앞의 "저장 안 함"도 없던 일이 되도록, 모두 닫기로 정해진 뒤에 버린다.
    for (const id of drop) this.discard(id);
    return true;
  }

  /** Windows 앱 창 닫기: 고친 문서가 있으면 호스트의 닫기를 멈추고 묻는다. 닫기로 하면 저장한 뒤 app.quit (SDD 6.4). */
  async onAppClosing(flushSession: () => void, focus: (docId: string) => void) {
    if (this.closing) return;
    this.flush();
    if (!this.hasDirty()) {
      this.quitting = true;
      flushSession();
      void this.bridge.request('app.quit').catch(() => {});
      return;
    }
    this.closing = true;
    try {
      await this.bridge.request('app.cancelClose').catch(() => {});
      if (!(await this.confirmClose(this.host.tabs.tabs.map((t) => t.docId), focus))) return;
      this.quitting = true;
      flushSession();
      await this.bridge.request('app.quit').catch(() => {});
    } finally {
      this.closing = false;
    }
  }

  // ------------------------------------------------------------------ 자동 저장 (FR-EDIT-10, SDD 7.7-7)

  private scheduleAutoSave(docId: string) {
    if (!this.host.autoSave() || this.autoOff.has(docId)) return;
    const doc = this.docs.get(docId);
    if (!doc || doc.untitled || doc.binary) return;
    const old = this.autoTimers.get(docId);
    if (old) clearTimeout(old);
    this.autoTimers.set(docId, setTimeout(() => {
      this.autoTimers.delete(docId);
      void this.save(docId, { auto: true });
    }, AUTOSAVE_MS));
  }

  /** 다른 탭으로 옮길 때: 떠나는 문서를 자동 저장한다. */
  onLeave(docId: string) {
    const doc = this.sync(docId);
    if (!doc?.dirty || !this.host.autoSave() || this.autoOff.has(docId) || doc.untitled || doc.binary) return;
    void this.save(docId, { auto: true });
  }

  /** 자동 저장을 다시 켤 때 멈춘 문서를 풀어 준다. */
  resetAuto() {
    this.autoOff.clear();
  }

  private pauseAuto(doc: DocModel, why: string): null {
    if (!this.autoOff.has(doc.id)) toast(S.edit.autoSavePaused(basename(doc.path), why), 'error');
    this.autoOff.add(doc.id);
    return null;
  }

  // ------------------------------------------------------------------ 도우미

  private async ask(title: string, body: string, ok: string): Promise<boolean> {
    const v = await showDialog(title, body, [
      { label: ok, value: 'ok', primary: true },
      { label: S.edit.cancel, value: 'cancel' },
    ]);
    return v === 'ok';
  }
}
