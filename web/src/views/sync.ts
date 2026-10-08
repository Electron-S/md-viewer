import type { PreviewView } from './preview';
import type { SourceView } from './source';

type Side = 'preview' | 'source';

/**
 * 분할 보기 스크롤 동기화 (FR-VIEW-05). 사용자가 스크롤한 쪽의 원문 줄로 다른 쪽을 옮긴다.
 * 프로그램이 일으킨 스크롤은 잠금으로 되받지 않는다.
 */
export class ScrollSync {
  private leader: Side | null = null;
  private unlock: ReturnType<typeof setTimeout> | null = null;
  /** 프로그램이 스크롤을 옮기는 동안 사용자 스크롤로 치지 않는다. */
  suspended = false;

  private source: SourceView | null = null;

  constructor(
    private preview: PreviewView,
    private isSplit: () => boolean,
    private isVisible: (side: Side) => boolean,
    private onLine: (line: number) => void,
  ) {
    preview.el.addEventListener('scroll', () => this.onScroll('preview'), { passive: true });
  }

  /** 원문 보기는 나중에 불러오므로 그때 붙인다. */
  attachSource(source: SourceView) {
    this.source = source;
    source.view.scrollDOM.addEventListener('scroll', () => this.onScroll('source'), { passive: true });
  }

  private onScroll(side: Side) {
    if (this.suspended || !this.isVisible(side)) return;
    if (side === 'preview' && this.preview.settling) return;
    if (this.leader && this.leader !== side) return;
    const source = this.source;
    if (side === 'source' && !source) return;
    const line = side === 'preview' ? this.preview.topLine() : source!.topLine();
    this.onLine(line);
    if (!this.isSplit()) return;
    this.leader = side;
    if (this.unlock) clearTimeout(this.unlock);
    this.unlock = setTimeout(() => (this.leader = null), 150);
    if (side === 'preview') source?.scrollToLine(line);
    else this.preview.scrollToLine(line);
  }
}
