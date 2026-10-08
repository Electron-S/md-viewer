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
  /** 이 페이지의 origin. 문서가 직접 쓴 같은 origin 주소는 지운다 (SDD 8.4). */
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

  return {
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
