// 테스트용 jsdom 전역. DOM이 필요한 모듈을 import하기 전에 불러야 한다.
import { JSDOM } from 'jsdom';

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
const w = dom.window as any;
for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'DocumentFragment', 'Text', 'CSS']) {
  if (!(key in g) || key === 'window' || key === 'document') g[key] = key === 'window' ? w : w[key];
}
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
w.HTMLElement.prototype.scrollIntoView = function () {};
if (!w.CSS) w.CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
g.CSS = w.CSS;
