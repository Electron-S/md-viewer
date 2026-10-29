import createDOMPurify from 'dompurify';
import { classifyUrl, isInternalUrl, isMarkdownPath, isTextPath, resolveLocalUrl } from './paths';

export interface SanitizeContext {
  /** 문서 폴더. 상대 경로 이미지·링크의 기준 */
  docDir: string;
  /** `/x` 링크·이미지의 기준(실행기 루트, 핸들 폴더). 없으면 문서 위치의 루트 */
  docRoot?: string | null;
  allowRemoteImages: boolean;
  /** 로컬 이미지 주소를 브리지가 만든다. null이면 data-mdv-src만 남기고 그린 뒤에 채운다 (SDD 8.1). */
  imageUrl: (path: string) => string | null;
  /** 이 페이지의 origin. 문서가 직접 쓴 이 origin의 이미지 주소는 지운다. 링크는 눌러야 열리므로 둔다 (SDD 8.4). */
  selfOrigin?: string;
}

// NFR-SEC-01: 실행되거나 앱 UI를 덮을 수 있는 태그·속성은 모두 지운다.
const FORBID_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'button', 'select',
  'textarea', 'option', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track', 'picture', 'dialog',
  'template', 'portal', 'noscript',
  // SVG 안의 외부 참조(원격 이미지 설정을 우회할 수 있다)
  'image', 'feimage', 'use',
];
const FORBID_ATTR = ['style', 'srcset', 'formaction', 'action', 'background', 'ping'];

// 다이어그램(Mermaid SVG)만은 style 요소·속성을 둔다. 대신 바깥을 불러오는 것은 모두 지운다 (FR-REN-07, NFR-SEC-01 예외).
// 이미지·미디어·SVG 애니메이션(SMIL로 href를 바꿀 수 있다)·use는 다이어그램에 필요 없으므로 함께 지운다.
const DIAGRAM_FORBID_TAGS = [
  ...FORBID_TAGS.filter((t) => t !== 'style'),
  'img', 'input', 'animate', 'animatemotion', 'animatetransform', 'animatecolor', 'set', 'discard',
];
const DIAGRAM_FORBID_ATTR = FORBID_ATTR.filter((a) => a !== 'style').concat('poster');
/** CSS 값에서 바깥 자원을 부를 수 있는 함수. url()은 따로 `#조각`만 허용한다. */
const CSS_FETCHING = /(?:image-set|cross-fade|element|image)\(/i;
const CSS_URL = /url\(\s*(['"]?)\s*([^'")\s]*)/gi;

/** 값 안의 url()이 모두 문서 안 `#조각`을 가리키고, 바깥을 부르는 함수가 없으면 참 */
export function isLocalCssValue(value: string): boolean {
  if (CSS_FETCHING.test(value)) return false;
  for (const m of value.matchAll(CSS_URL)) if (!m[2].startsWith('#')) return false;
  return true;
}

function cleanDeclarations(style: CSSStyleDeclaration) {
  const bad: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style[i];
    if (!isLocalCssValue(style.getPropertyValue(name))) bad.push(name);
  }
  for (const name of bad) style.removeProperty(name);
}

/**
 * 다이어그램 스타일시트를 브라우저의 CSS 파서로 읽어 다시 쓴다.
 *  - 선택자가 모두 `#scope`(그 다이어그램의 svg id)로 시작하는 규칙만 남긴다. mermaid는 모든 규칙을 이렇게 가두므로,
 *    문서가 classDef 등으로 끼워 넣은 규칙이 다이어그램 밖(미리보기의 다른 블록)을 꾸미지 못한다.
 *  - 바깥 자원을 부르는 선언(url(), image-set() 등)을 지운다. 파서를 거치므로 이스케이프(`u\72l(`)는 풀린 뒤에 검사된다.
 *  - 스타일·키프레임·조건부 규칙만 남기고 @import·@font-face 같은 나머지 규칙은 버린다.
 */
export function cleanDiagramCss(css: string, scope: string, win: Window = window): string {
  const sheet = new (win as unknown as typeof globalThis).CSSStyleSheet();
  sheet.replaceSync(css);
  const scoped = new RegExp(`^#${scope.replace(/[^\w-]/g, '')}(?![\\w-])`);
  cleanRules(sheet.cssRules, (i) => sheet.deleteRule(i), scoped);
  return Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
}

const KEEP_RULES = new Set(['CSSStyleRule', 'CSSKeyframesRule', 'CSSKeyframeRule', 'CSSMediaRule', 'CSSSupportsRule', 'CSSNestedDeclarations']);

type AnyRule = CSSRule & { style?: CSSStyleDeclaration; cssRules?: CSSRuleList; selectorText?: string; deleteRule?: (i: number) => void };

/** 선택자 목록을 괄호 밖의 쉼표로 나눈다(`:not(a, b)` 안의 쉼표는 나누지 않는다). */
function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** scoped가 있으면 이 단계의 스타일 규칙은 모든 선택자가 그 범위 안이어야 한다. 중첩 규칙은 바깥 규칙 안이므로 검사하지 않는다. */
function cleanRules(list: CSSRuleList, remove: (i: number) => void, scoped: RegExp | null) {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i] as AnyRule;
    const kind = r.constructor.name;
    if (!KEEP_RULES.has(kind) || (scoped && kind === 'CSSStyleRule' && !splitSelectors(r.selectorText ?? '').every((s) => scoped.test(s)))) {
      remove(i);
      continue;
    }
    if (r.style) cleanDeclarations(r.style);
    // 키프레임 묶음 안에는 키프레임만 있어 지울 일이 없다. 조건부 규칙은 같은 범위 검사를, 중첩 규칙은 검사 없이 번호로 지운다.
    if (r.cssRules) cleanRules(r.cssRules, (j) => r.deleteRule?.(j), kind === 'CSSStyleRule' ? null : scoped);
  }
}

/**
 * DOMPurify로 정제한 뒤 링크·이미지 주소를 앱 규칙으로 바꾼다 (SDD 8.1 5~6단계).
 * 결과 링크 속성:
 *  - data-mdv-ext: http·https·mailto (브라우저 새 탭으로 연다)
 *  - data-mdv-path / data-mdv-frag: 로컬 파일과 조각
 * 결과 이미지 속성:
 *  - data-mdv-src: 아직 주소를 받지 못한 로컬 이미지의 위치
 */
export function createSanitizer(win: Window) {
  const purify = createDOMPurify(win as unknown as Parameters<typeof createDOMPurify>[0]);
  // data-mdv-* 는 앱이 링크·이미지 처리 결과로만 붙인다. 문서가 직접 쓴 것은 지운다.
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName.toLowerCase().startsWith('data-mdv-')) data.keepAttr = false;
  });

  function rewriteLinks(root: ParentNode, ctx: SanitizeContext) {
    for (const a of Array.from(root.querySelectorAll('a'))) {
      a.removeAttribute('target');
      const href = a.getAttribute('href');
      if (href == null) continue;
      const kind = classifyUrl(href);
      if (kind === 'fragment') {
        a.setAttribute('data-mdv-frag', safeDecode(href.slice(1)));
      } else if (kind === 'external') {
        a.setAttribute('data-mdv-ext', href.trim());
        if (!a.title) a.title = href.trim();
      } else if (kind === 'local') {
        const loc = resolveLocalUrl(href, ctx.docDir, ctx.docRoot);
        if (!loc) {
          a.removeAttribute('href');
          continue;
        }
        a.setAttribute('data-mdv-path', loc.path);
        if (loc.fragment) a.setAttribute('data-mdv-frag', loc.fragment);
        if (!a.title) a.title = loc.path;
      } else {
        a.removeAttribute('href');
      }
    }
  }

  function rewriteImages(root: ParentNode, ctx: SanitizeContext) {
    for (const img of Array.from(root.querySelectorAll('img'))) {
      img.setAttribute('loading', 'lazy');
      const src = img.getAttribute('src');
      if (src == null) continue;
      if (isInternalUrl(src, ctx.selfOrigin)) {
        img.removeAttribute('src');
        continue;
      }
      const kind = classifyUrl(src);
      if (kind === 'data-image') continue;
      if (kind === 'external' && /^https?:/i.test(src.trim())) {
        if (!ctx.allowRemoteImages) {
          img.removeAttribute('src');
          img.setAttribute('data-mdv-blocked', src.trim());
          img.classList.add('mdv-blocked');
        }
        continue;
      }
      if (kind === 'local') {
        const loc = resolveLocalUrl(src, ctx.docDir, ctx.docRoot);
        if (loc) {
          const url = ctx.imageUrl(loc.path);
          if (url) img.setAttribute('src', url);
          else {
            img.removeAttribute('src');
            img.setAttribute('data-mdv-src', loc.path);
          }
          continue;
        }
      }
      img.removeAttribute('src');
    }
  }

  function fixInputs(root: ParentNode) {
    for (const input of Array.from(root.querySelectorAll('input'))) {
      if ((input.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
        input.remove();
        continue;
      }
      input.setAttribute('disabled', '');
      input.removeAttribute('name');
    }
  }

  // 다이어그램 전용 인스턴스. 훅·설정이 문서 정제와 섞이지 않게 따로 둔다.
  const diagramPurify = createDOMPurify(win as unknown as Parameters<typeof createDOMPurify>[0]);
  diagramPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName.toLowerCase().startsWith('data-mdv-')) data.keepAttr = false;
  });

  /**
   * 다이어그램 안의 style·href·url()을 검사한다. 바깥을 가리키면 그 선언·속성을 지운다.
   * 스타일시트는 svg 바로 아래의 것(mermaid가 넣는 것)만 남긴다. 라벨 HTML에 끼운 <style>은 범위를 가둘 수 없으므로 지운다.
   */
  function confineDiagram(svg: Element) {
    for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
      if (el.localName === 'style') {
        if (el.parentNode === svg) el.textContent = cleanDiagramCss(el.textContent ?? '', svg.id, win);
        else el.remove();
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name === 'style') {
          // 파서가 읽은 선언만 화면에 적용되므로 그것만 검사하면 된다. 지운 것이 있으면 속성 글자도 다시 쓰인다.
          cleanDeclarations((el as HTMLElement | SVGElement).style);
        } else if (name === 'href' || name.endsWith(':href')) {
          if (!attr.value.trim().startsWith('#')) el.removeAttributeNode(attr);
        } else if (/url\(/i.test(attr.value) && !isLocalCssValue(attr.value)) {
          el.removeAttributeNode(attr);
        }
      }
    }
  }

  return {
    /**
     * Mermaid가 그린 SVG를 정제한다 (FR-REN-07). mermaid가 strict 수준으로 한 번 정제한 결과를 한 번 더 거른다.
     * 문서 정제와 달리 style 요소·속성과 foreignObject 안의 HTML 라벨을 남기고, 링크는 `#조각`만 남긴다.
     * 결과는 id가 `id`인 svg 요소 하나다. 그런 모양이 아니면 null.
     */
    sanitizeDiagram(svg: string, id: string): SVGSVGElement | null {
      const frag = diagramPurify.sanitize(svg, {
        RETURN_DOM_FRAGMENT: true,
        // 미리보기(Shadow DOM)에만 들어가며, 마커·그림자 참조(url(#id))와 style의 #id 선택자가 id를 쓴다.
        SANITIZE_DOM: false,
        USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { 'annotation-xml': true, foreignobject: true },
        FORBID_TAGS: DIAGRAM_FORBID_TAGS,
        FORBID_ATTR: DIAGRAM_FORBID_ATTR,
      }) as DocumentFragment;
      const root = frag.firstElementChild;
      if (!root || root.localName !== 'svg' || root.id !== id || frag.childElementCount !== 1) return null;
      confineDiagram(root);
      return root as SVGSVGElement;
    },

    sanitize(html: string, ctx: SanitizeContext): DocumentFragment {
      const frag = purify.sanitize(html, {
        RETURN_DOM_FRAGMENT: true,
        // 결과는 Shadow DOM에만 들어가 window 이름 속성을 덮어쓸 수 없으므로 제목 id를 지키려고 끈다.
        SANITIZE_DOM: false,
        FORBID_TAGS,
        FORBID_ATTR,
      }) as DocumentFragment;
      rewriteLinks(frag, ctx);
      rewriteImages(frag, ctx);
      fixInputs(frag);
      return frag;
    },
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 링크 대상이 앱 안에서 열 문서인지 */
export function isViewablePath(p: string): boolean {
  return isMarkdownPath(p) || isTextPath(p);
}
