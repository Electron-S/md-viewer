import markdownit, { type MarkdownIt, type StateBlock, type Token } from 'markdown-it';
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

/** Mermaid 다이어그램 상자 (FR-REN-07). 그리기 전에는 `pre`를, 그린 뒤에는 정제한 `svg`를 담는다. */
export const DIAGRAM_CLASS = 'mdv-mermaid';

function isMermaidInfo(info: string): boolean {
  return (info || '').trim().split(/\s+/)[0].toLowerCase() === 'mermaid';
}

const WWW_TAIL = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?:[/?#][^\s<]*)?/u;

/** GFM 규칙: 끝의 문장부호, 짝이 안 맞는 닫는 괄호, 엔티티 모양(`&hl;`) 꼬리는 링크에서 뺀다. */
function trimAutolink(s: string): string {
  let out = s;
  for (;;) {
    const last = out[out.length - 1];
    if (/[?!.,:*_~'"]/.test(last)) out = out.slice(0, -1);
    else if (last === ')' && (out.match(/\)/g)?.length ?? 0) > (out.match(/\(/g)?.length ?? 0)) out = out.slice(0, -1);
    else if (last === ';' && /&[a-z0-9]+;$/i.test(out)) out = out.replace(/&[a-z0-9]+;$/i, '');
    else return out;
  }
}

/**
 * GFM 확장 이메일 자동 링크의 글자 규칙: 이름은 영숫자·`.`·`+`·`-`·`_`, 도메인은 영숫자·`-`·`_`를 마침표로 나눈 것(`+` 없음).
 * 끝 글자가 `-`·`_`인 주소(`a@b.c-`)는 이 정규식이 아니라 linkify-it이 애초에 링크로 잡지 않는다(GFM 스펙 예제로 확인).
 */
const GFM_EMAIL = /^mailto:[A-Za-z0-9.+_-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

/** GFM tagfilter: 이 태그들은 여는 태그·닫는 태그 모두 지우지 않고 `<`를 `&lt;`로 바꿔 글자로 보여준다. */
const TAGFILTER = /<(?=\/?(title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)[\s/>])/gi;

/**
 * 문서 맨 앞 YAML 앞머리(front matter)의 닫는 줄 번호. 첫 줄이 `---`이고 뒤에 `---`나 `...` 줄이 있어야 한다. 없으면 -1.
 * 앞머리가 아니면 CommonMark대로 `---`는 구분선, 그 아래 글은 `---`를 밑줄 삼은 제목이 된다.
 */
function frontMatterClose(count: number, line: (i: number) => string): number {
  if (count < 2 || !/^---[ \t]*$/.test(line(0))) return -1;
  for (let i = 1; i < count; i++) if (/^(?:---|\.\.\.)[ \t]*$/.test(line(i))) return i;
  return -1;
}

function frontMatter(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.level !== 0) return false;
  const line = (i: number) => state.src.slice(state.bMarks[i], state.eMarks[i]);
  const close = frontMatterClose(endLine, line);
  if (close < 0) return false;
  if (silent) return true;
  const t = state.push('front_matter', '', 0);
  t.block = true;
  t.markup = '---';
  t.map = [0, close + 1];
  t.content = Array.from({ length: close - 1 }, (_, k) => line(k + 1)).join('\n');
  state.line = close + 1;
  return true;
}

/** 한 단계짜리 `키: 값` 줄로만 된 앞머리면 [키, 값] 목록. 들여 쓴 줄·목록처럼 그 밖의 YAML이 있으면 null. */
function flatYaml(src: string): [string, string][] | null {
  const rows: [string, string][] = [];
  for (const raw of src.split('\n')) {
    if (/^\s*(?:#.*)?$/.test(raw)) continue;
    const m = /^([^\s#'"][^:]*?):(?:[ \t]+(.*?))?[ \t]*$/.exec(raw);
    if (!m) return null;
    let value = m[2] ?? '';
    if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    else if (/^"[^"\\]*"$/.test(value)) value = value.slice(1, -1);
    rows.push([m[1], value]);
  }
  return rows;
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
    // 앞머리는 본문과 떼어 접을 수 있는 상자에 키·값 표로 보여준다 (FR-REN-08). 표로 못 옮기는 YAML은 줄을 지킨 원문으로.
    md.block.ruler.before('table', 'front_matter', frontMatter);
    md.renderer.rules.front_matter = (tokens, idx, _options, _env, self) => {
      const t = tokens[idx];
      const esc = md.utils.escapeHtml;
      const rows = flatYaml(t.content);
      if (rows?.length === 0) return '';
      const body = rows
        ? `<table>\n<tbody>\n${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>\n`).join('')}</tbody>\n</table>\n`
        : `<pre class="mdv-plain">${esc(t.content)}</pre>\n`;
      return `<details class="mdv-front-matter"${self.renderAttrs(t)} open>\n<summary>${esc(S.preview.frontMatter)}</summary>\n${body}</details>\n`;
    };
    // Mermaid 펜스는 원문 코드를 상자에 담아 둔다. 미리보기가 그린 뒤 상자 안을 다이어그램으로 바꾼다 (FR-REN-07, render/diagrams.ts).
    // 상자가 data-line을 가져 스크롤 동기화의 기준점이 되고, 그리기 전·실패 때는 원문이 보인다.
    const fence = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const t = tokens[idx];
      if (!isMermaidInfo(t.info)) return fence(tokens, idx, options, env, self);
      const line = t.attrGet('data-line');
      const attr = line == null ? '' : ` data-line="${md.utils.escapeHtml(String(line))}"`;
      return `<div class="${DIAGRAM_CLASS}"${attr}><pre><code class="language-mermaid">${md.utils.escapeHtml(t.content)}</code></pre></div>\n`;
    };
    md.core.ruler.push('mdv_gfm', (state) => {
      for (const t of state.tokens) {
        if (t.type === 'html_block') t.content = t.content.replace(TAGFILTER, '&lt;');
        for (let i = 0; i < (t.children?.length ?? 0); i++) {
          const c = t.children![i];
          if (c.type === 'html_inline') c.content = c.content.replace(TAGFILTER, '&lt;');
          // GFM은 취소선을 <del>로 낸다.
          if (c.type === 's_open' || c.type === 's_close') c.tag = 'del';
          // 도메인 규칙에 맞지 않는 이메일 자동 링크는 글자로 되돌린다.
          const href = String(c.attrGet('href') ?? '');
          if (c.type === 'link_open' && c.markup === 'linkify' && /^mailto:/i.test(href) && !GFM_EMAIL.test(href)) {
            const end = t.children!.findIndex((x, k) => k > i && x.type === 'link_close');
            t.children!.splice(i, 1);
            if (end > 0) t.children!.splice(end - 1, 1);
          }
        }
      }
    });
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
  // 표 열 정렬은 style 대신 align 속성으로 낸다. 정제가 style 속성을 모두 지우기 때문이며, GFM 스펙 출력과도 같다 (SDD 8.1).
  md.core.ruler.push('mdv_table_align', (state) => {
    for (const t of state.tokens) {
      if (t.type !== 'th_open' && t.type !== 'td_open') continue;
      const m = /^text-align:(left|center|right)$/.exec(String(t.attrGet('style') ?? ''));
      if (!m) continue;
      t.attrs = (t.attrs ?? []).filter(([name]) => name !== 'style');
      t.attrSet('align', m[1]);
    }
  });
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
  // 앞머리 안의 `# 주석`은 제목이 아니다.
  for (let i = frontMatterClose(lines.length, (k) => lines[k]) + 1; i < lines.length; i++) {
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
