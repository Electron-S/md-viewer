import createDOMPurify from 'dompurify';
import { classifyUrl, fileResourceUrl, isInternalUrl, isMarkdownPath, isTextPath, resolveLocalUrl } from './paths';

export interface SanitizeContext {
  /** 문서 폴더. 상대 경로 이미지·링크의 기준 */
  docDir: string;
  allowRemoteImages: boolean;
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
 *  - data-mdv-ext: http·https·mailto (기본 브라우저로 연다)
 *  - data-mdv-path / data-mdv-frag: 로컬 파일과 조각
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
      if (isInternalUrl(href)) {
        a.removeAttribute('href');
        continue;
      }
      const kind = classifyUrl(href);
      if (kind === 'fragment') {
        a.setAttribute('data-mdv-frag', safeDecode(href.slice(1)));
      } else if (kind === 'external') {
        a.setAttribute('data-mdv-ext', href.trim());
        if (!a.title) a.title = href.trim();
      } else if (kind === 'local') {
        const loc = resolveLocalUrl(href, ctx.docDir);
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
      if (isInternalUrl(src)) {
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
        const loc = resolveLocalUrl(src, ctx.docDir);
        if (loc) {
          img.setAttribute('src', fileResourceUrl(loc.path));
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
