import MarkdownIt from 'markdown-it';
import notes from '../../../RELEASE_NOTES.md';
import { S } from '../strings';

/** 릴리스 노트 원본을 빌드에 포함해 오프라인에서도 버전별로 읽는다. */
export function releaseHistory(version: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'release-history';
  box.append(Object.assign(document.createElement('p'), { textContent: S.dialog.currentVersion(version) }));
  const md = new MarkdownIt({ html: false });
  // 내장 이력은 읽기 전용이다. 저장소 상대 링크로 앱을 벗어나지 않게 링크는 글자로 표시한다.
  md.renderer.rules.link_open = () => '';
  md.renderer.rules.link_close = () => '';
  for (const section of notes.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) {
    const newline = section.indexOf('\n');
    const title = section.slice(0, newline).trim();
    const details = document.createElement('details');
    details.open = title.split(' ')[0] === `v${version}`;
    const summary = document.createElement('summary');
    summary.textContent = title + (details.open ? S.dialog.currentVersionTag : '');
    const body = document.createElement('div');
    body.innerHTML = md.render(section.slice(newline + 1));
    details.append(summary, body);
    box.append(details);
  }
  return box;
}
