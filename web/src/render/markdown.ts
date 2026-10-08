import markdownit, { type MarkdownIt, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import { S } from '../strings';
import { Slugger } from './slug';

export interface Heading {
  level: number;
  text: string;
  id: string;
  /** 원문 줄(0부터) */
  line: number;
}

interface RenderEnv {
  [key: string | symbol]: unknown;
  slugger: Slugger;
  headings: Heading[];
}

export interface MarkdownOptions {
  /** 블록마다 `data-line`을 붙일지 (ARCH-03). 스펙 적합성 테스트에서만 끈다. */
  sourceMap?: boolean;
  /** GFM 확장(작업 목록, 각주, 자동 링크)과 제목 id */
  extensions?: boolean;
  /** 코드 강조. 스펙 적합성 테스트에서만 끈다. */
  highlight?: boolean;
}

/** 강조 중 예외는 그대로 던진다. renderMarkdown이 그 블록만 원문과 오류로 바꾼다 (FR-REN-04). */
function highlight(code: string, info: string): string {
  const lang = (info || '').trim().split(/\s+/)[0].toLowerCase();
  if (!lang || !hljs.getLanguage(lang)) return '';
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

const WWW_TAIL = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?:[/?#][^\s<]*)?/u;

/** GFM 규칙: 끝의 문장부호와 짝이 안 맞는 닫는 괄호는 링크에서 뺀다. */
function trimAutolink(s: string): string {
  let out = s;
  for (;;) {
    const last = out[out.length - 1];
    if (/[?!.,:*_~'"]/.test(last)) out = out.slice(0, -1);
    else if (last === ')' && (out.match(/\)/g)?.length ?? 0) > (out.match(/\(/g)?.length ?? 0)) out = out.slice(0, -1);
    else return out;
  }
}

export function createMarkdown(opts: MarkdownOptions = {}): MarkdownIt {
  const { sourceMap = true, extensions = true } = opts;
  const md = markdownit({
    html: true,
    xhtmlOut: true,
    linkify: extensions,
    typographer: false,
    highlight: opts.highlight === false ? null : highlight,
  });
  if (extensions) {
    // GFM 확장 자동 링크는 `www.`로 시작할 때만. 맨 도메인(README.md 같은 파일 이름)은 링크로 만들지 않는다.
    md.linkify.set({ fuzzyLink: false });
    md.linkify.add('www.', {
      validate(text: string, pos: number) {
        const m = WWW_TAIL.exec(text.slice(pos));
        if (!m) return 0;
        return trimAutolink(m[0]).length;
      },
      normalize(match: { url: string }) {
        match.url = 'http://' + match.url;
      },
    });
    md.use(footnote).use(taskLists, { enabled: false, label: false });
    md.core.ruler.push('mdv_headings', (state) => {
      const env = state.env as Partial<RenderEnv>;
      if (!env.slugger || !env.headings) return;
      const tokens = state.tokens;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'heading_open') continue;
        const inline = tokens[i + 1];
        const text = (inline?.children ?? [])
          .filter((c) => c.type === 'text' || c.type === 'code_inline')
          .map((c) => c.content)
          .join('');
        const id = env.slugger.slug(text);
        t.attrSet('id', id);
        env.headings.push({ level: Number(t.tag.slice(1)), text, id, line: t.map ? t.map[0] : 0 });
      }
    });
  }
  if (sourceMap) {
    md.core.ruler.push('mdv_source_map', (state) => {
      for (const t of state.tokens) {
        if (t.map && t.nesting !== -1 && t.type !== 'inline') t.attrSet('data-line', String(t.map[0]));
      }
    });
  }
  return md;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  /** 그리지 못해 원문으로 바꾼 블록 (FR-REN-04) */
  errors: { line: number; message: string }[];
}

/**
 * 최상위 블록마다 따로 그린다. 한 블록이 실패하면 그 블록만 원문과 오류 안내로 바꾸고 나머지는 그대로 둔다 (FR-REN-04).
 * 결과는 md.render와 같다. 파싱 자체가 실패하면 예외를 던지고, 호출한 쪽이 문서 전체를 원문으로 보여준다.
 */
export function renderMarkdown(md: MarkdownIt, text: string): RenderResult {
  const env: RenderEnv = { slugger: new Slugger(), headings: [] };
  const tokens = md.parse(text, env);
  const errors: RenderResult['errors'] = [];
  let lines: string[] | null = null;
  let html = '';
  for (let i = 0; i < tokens.length; ) {
    const end = blockEnd(tokens, i);
    try {
      html += md.renderer.render(tokens.slice(i, end), md.options, env);
    } catch (err) {
      const range = blockLines(tokens, i, end);
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ line: range ? range[0] : 0, message });
      lines ??= text.split(/\r\n|\r|\n/);
      html += failedBlock(md, message, range, lines);
    }
    i = end;
  }
  return { html, headings: env.headings, errors };
}

/** i에서 시작하는 최상위 블록의 끝(포함하지 않음). 여는 토큰이면 짝이 맞는 닫는 토큰까지다. */
function blockEnd(tokens: Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    depth += tokens[j].nesting;
    if (depth <= 0) return j + 1;
  }
  return tokens.length;
}

/** 블록이 차지하는 원문 줄 범위 [시작, 끝). 줄 정보가 없는 블록(각주 묶음 등)은 null. */
function blockLines(tokens: Token[], start: number, end: number): [number, number] | null {
  let range: [number, number] | null = null;
  for (let k = start; k < end; k++) {
    const m = tokens[k].map;
    if (m) range = range ? [Math.min(range[0], m[0]), Math.max(range[1], m[1])] : [m[0], m[1]];
  }
  return range;
}

function failedBlock(md: MarkdownIt, message: string, range: [number, number] | null, lines: string[]): string {
  const esc = md.utils.escapeHtml;
  const src = range ? lines.slice(range[0], range[1]).join('\n') : '';
  const line = range ? ` data-line="${range[0]}"` : '';
  return (
    `<div class="mdv-block-error"${line}><p class="mdv-render-error">${esc(S.preview.blockFailed(message))}</p>` +
    (src ? `<pre class="mdv-plain">${esc(src)}</pre>` : '') +
    '</div>\n'
  );
}

/** 미리보기를 그리지 않는 큰 문서용 목차: 펜스 밖의 ATX 제목만 훑는다. */
export function scanHeadings(text: string): Heading[] {
  const slugger = new Slugger();
  const out: Heading[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) {
      const text = h[2].replace(/[*_`]/g, '');
      out.push({ level: h[1].length, text, id: slugger.slug(text), line: i });
    }
  }
  return out;
}
