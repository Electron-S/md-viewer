import type { Mermaid } from 'mermaid';
import { S } from '../strings';
import { DIAGRAM_CLASS } from './markdown';

/** markdown.css 본문 글꼴. 무대에서 잰 라벨 크기와 미리보기에 그린 크기가 같아야 한다. */
const FONT_FAMILY = '"Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
/** 그린 다이어그램을 남겨 둘 수와 SVG 글자 수 합계 (NFR-PERF-06) */
const CACHE_ENTRIES = 64;
const CACHE_CHARS = 8 * 1024 * 1024;

type Entry = { svg: SVGSVGElement; size: number } | { error: string; size: number };

/** 불러온 Mermaid와 그것이 그릴 자리(격리된 iframe의 body). frame이 있으면 무대 폭을 거기에 준다. */
export interface DiagramLibrary {
  mermaid: Mermaid;
  stage: HTMLElement;
  frame?: HTMLElement;
}

export interface DiagramOptions {
  /** mermaid가 낸 SVG를 정제한다(sanitizer.sanitizeDiagram). 모양이 틀리면 null */
  clean: (svg: string, id: string) => SVGSVGElement | null;
  /** 무대 폭(미리보기 본문 폭). 간트처럼 컨테이너 폭에 맞춰 그리는 다이어그램이 쓴다. */
  width: () => number;
  /** 다이어그램 하나를 그리지 못했을 때 (줄은 0부터) */
  onFailed: (line: number, message: string) => void;
  /** 라이브러리를 불러오지 못했을 때. 한 번만 부른다. */
  onLoadFailed: (message: string) => void;
  /** 남은 다이어그램을 다 그렸을 때 */
  onIdle: () => void;
  /** 라이브러리를 불러오는 방법. 시험에서만 바꾼다. */
  load?: () => Promise<DiagramLibrary>;
}

/**
 * Mermaid 다이어그램 (FR-REN-07, SDD 8.1). 렌더러가 남긴 상자(`.mdv-mermaid > pre`)를 정제한 SVG로 바꾼다.
 * mermaid는 화면 밖의 숨은 iframe(무대)에서 실행하고 그린다. 그 iframe은 바깥 자원을 하나도 부르지 못하는 CSP를 따로 가져,
 * 문서가 init·front matter의 themeCSS나 라벨 <img>, 이미지 노드로 넣은 바깥 주소를 그리는 동안(정제 전)에도 요청하지 못한다.
 * 결과 SVG 글자만 정제해 미리보기로 옮긴다. 결과는 테마와 원문으로 캐시해, 파일 감시로 문서를 다시 그릴 때는
 * 그리기 전에 바로 끼운다(깜빡임·스크롤 밀림 없음).
 */
export class DiagramRenderer {
  private cache = new Map<string, Entry>();
  private cacheSize = 0;
  private lib: Promise<DiagramLibrary> | null = null;
  private failed = false;
  /** mermaid에 설정해 둔 테마 */
  private theme: string | null = null;
  private dark = false;
  private seq = 0;
  private root: (Node & ParentNode) | null = null;
  private running: Promise<void> | null = null;

  constructor(private opts: DiagramOptions) {}

  setDark(dark: boolean) {
    this.dark = dark;
  }

  get busy(): boolean {
    return this.running != null;
  }

  /** 캐시에 있는 다이어그램을 바로 바꿔 끼운다. 문서를 미리보기에 넣기 전에 부른다. */
  applyCached(root: ParentNode) {
    for (const box of pendingBoxes(root)) {
      const entry = this.cache.get(this.key(sourceOf(box)));
      if (entry) this.swap(box, entry);
    }
  }

  /** root 안의 남은 다이어그램을 화면에 가까운 것부터 하나씩 그린다. 이미 돌고 있으면 그 작업이 새 root를 이어받는다. */
  renderPending(root: Node & ParentNode): Promise<void> {
    this.root = root;
    if (this.failed) return Promise.resolve();
    this.running ??= this.work().finally(() => {
      this.running = null;
      this.opts.onIdle();
    });
    return this.running;
  }

  /** 그리는 중이면 끝날 때까지 최대 ms 기다린다 (인쇄 전). */
  async idle(ms: number): Promise<void> {
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, ms))]);
  }

  private key(source: string): string {
    return `${this.dark ? 'dark' : 'light'}\n${source}`;
  }

  private async work() {
    for (;;) {
      const box = this.root && !this.failed ? nearest(pendingBoxes(this.root)) : null;
      if (!box) return;
      await this.renderBox(box);
      // mermaid.render는 한 번에 하나만 부를 수 있다. 다이어그램 사이에 한 번씩 화면을 그리게 둔다.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  private async renderBox(box: HTMLElement) {
    const source = sourceOf(box);
    const key = this.key(source);
    let entry = this.cache.get(key);
    if (!entry) {
      let lib: DiagramLibrary;
      try {
        lib = await this.library();
      } catch (err) {
        this.failed = true;
        this.opts.onLoadFailed(messageOf(err));
        return;
      }
      entry = await this.draw(lib, source);
      this.remember(key, entry);
      if ('error' in entry) this.opts.onFailed(Number(box.getAttribute('data-line') ?? 0), entry.error);
    }
    // 그리는 동안 다른 문서로 바뀌었거나 테마가 바뀌었으면 끼우지 않는다. 결과는 캐시에 남아 다음에 쓴다.
    if (this.root?.contains(box) && key === this.key(source)) this.swap(box, entry);
  }

  private library(): Promise<DiagramLibrary> {
    this.lib ??= (this.opts.load ?? loadIsolated)();
    return this.lib;
  }

  private configure(mermaid: Mermaid) {
    const theme = this.dark ? 'dark' : 'default';
    if (this.theme === theme) return;
    // strict: 라벨의 HTML을 정제하고 click 콜백·링크를 막는다. 문서의 %%{init}%%는 securityLevel을 바꾸지 못한다(mermaid secure 목록).
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
      fontFamily: FONT_FAMILY,
      themeVariables: { fontFamily: FONT_FAMILY },
    });
    this.theme = theme;
  }

  private async draw({ mermaid, stage, frame }: DiagramLibrary, source: string): Promise<Entry> {
    this.configure(mermaid);
    const id = `mdv-mmd-${++this.seq}`;
    // 간트처럼 컨테이너 폭에 맞춰 그리는 다이어그램이 미리보기 본문 폭으로 그려지게 한다.
    (frame ?? stage).style.width = `${Math.max(320, Math.round(this.opts.width()))}px`;
    try {
      const { svg } = await mermaid.render(id, source, stage);
      const el = this.opts.clean(svg, id);
      if (!el) throw new Error(S.error.diagramInvalid);
      return { svg: el, size: svg.length };
    } catch (err) {
      return { error: summarize(messageOf(err)), size: source.length };
    } finally {
      // 실패하면 mermaid가 무대에 임시 요소를 남길 수 있다.
      stage.replaceChildren();
    }
  }

  private remember(key: string, entry: Entry) {
    this.cache.set(key, entry);
    this.cacheSize += entry.size;
    for (const [k, e] of this.cache) {
      if (this.cache.size <= CACHE_ENTRIES && this.cacheSize <= CACHE_CHARS) break;
      if (k === key) continue;
      this.cache.delete(k);
      this.cacheSize -= e.size;
    }
  }

  private swap(box: HTMLElement, entry: Entry) {
    if ('svg' in entry) {
      box.replaceChildren(entry.svg.cloneNode(true));
      return;
    }
    // FR-REN-04와 같은 모양: 안내 한 줄과 원문
    const out = document.createElement('div');
    out.className = 'mdv-block-error';
    const line = box.getAttribute('data-line');
    if (line != null) out.setAttribute('data-line', line);
    const p = document.createElement('p');
    p.className = 'mdv-render-error';
    p.textContent = S.preview.diagramFailed(entry.error);
    const pre = document.createElement('pre');
    pre.className = 'mdv-plain';
    pre.textContent = sourceOf(box);
    out.append(p, pre);
    box.replaceWith(out);
  }
}

/** 아직 그리지 않은 다이어그램 상자 */
function pendingBoxes(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`.${DIAGRAM_CLASS} > pre:first-child`), (pre) => pre.parentElement!);
}

function sourceOf(box: Element): string {
  return box.querySelector('pre')?.textContent ?? '';
}

/** 화면 가운데에 가장 가까운 상자 */
function nearest(boxes: HTMLElement[]): HTMLElement | null {
  if (boxes.length <= 1) return boxes[0] ?? null;
  const center = window.innerHeight / 2;
  let best = boxes[0];
  let bestDist = Infinity;
  for (const box of boxes) {
    const r = box.getBoundingClientRect();
    const dist = Math.abs(r.top + r.height / 2 - center);
    if (dist < bestDist) {
      best = box;
      bestDist = dist;
    }
  }
  return best;
}

/** mermaid는 무대 iframe에서 돌아 그 오류는 이 창의 Error가 아니다(instanceof가 거짓). message로 가린다. */
function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(err);
}

/**
 * mermaid 구문 오류는 "Parse error on line N:", 원문 줄, 위치 표시(---^), 기대한 토큰 순으로 여러 줄이다.
 * 안내에는 첫 줄과 마지막 줄만 쓴다.
 */
export function summarize(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? '';
  return `${lines[0]} ${lines[lines.length - 1]}`;
}

/** base64로 적은 gzip 바이트를 풀어 글자로 돌려준다. */
export async function gunzipBase64(b64: string): Promise<string> {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * 무대 iframe의 문서. srcdoc 문서는 이 페이지의 CSP를 물려받아(script-src 해시 포함) 그 위에 아래 CSP가 더해진다.
 * 이미지·글꼴·연결·미디어를 모두 막아 mermaid가 그리는 동안 바깥으로 요청하지 못한다. 글꼴·줄 간격은 미리보기 본문
 * (markdown.css .markdown-body)과 같게 맞춰 여기서 잰 라벨 크기가 미리보기에서도 맞게 한다.
 */
const STAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="img-src data:; font-src data:; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'">` +
  `<style>body{margin:0;font:15px/1.65 ${FONT_FAMILY}}foreignObject *{line-height:1.5}</style>` +
  '</head><body></body></html>';

/**
 * Mermaid 번들을 처음 쓸 때 무대 iframe 안에서 실행한다 (SDD 7.5). 빌드가 번들을 gzip·base64로 `#mdv-mermaid` 데이터 블록에
 * 넣고 번들 원문의 sha256을 CSP script-src에 넣어 둔다. 풀어서 인라인 스크립트로 붙이면 해시가 맞아 실행된다(eval 없음).
 * frame-src 'none'은 srcdoc iframe을 막지 않는다(요청 없이 만들어지는 문서다).
 */
async function loadIsolated(): Promise<DiagramLibrary> {
  const data = document.getElementById('mdv-mermaid');
  if (!data?.textContent) throw new Error(S.error.diagramModuleMissing);
  const code = await gunzipBase64(data.textContent);
  const frame = document.createElement('iframe');
  frame.className = 'mdv-mermaid-stage';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.srcdoc = STAGE_HTML;
  const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  if (!doc) throw new Error(S.error.diagramModuleMissing);
  const script = doc.createElement('script');
  script.textContent = code;
  doc.head.append(script);
  script.remove();
  const mermaid = (frame.contentWindow as (Window & { __mdvMermaid?: Mermaid }) | null)?.__mdvMermaid;
  if (!mermaid) throw new Error(S.error.diagramModuleMissing);
  // 실행한 뒤에는 수 MB짜리 원문을 들고 있을 이유가 없다.
  data.remove();
  return { mermaid, stage: doc.body, frame };
}
