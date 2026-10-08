import type { PreviewView } from './preview';
import type { SourceView } from './source';

type Side = 'preview' | 'source';

/** 두 쪽 줄 차이가 이보다 작으면 맞은 것으로 본다. */
const LINE_EPS = 0.25;
/** 따라간 뒤 다시 맞추는 최대 프레임 수와, 끝내기 전에 연속으로 맞아야 하는 프레임 수 */
const SETTLE_FRAMES = 20;
const SETTLE_STABLE = 3;
/** 사용자가 직접 움직였다는 신호 */
const USER_INPUT = ['wheel', 'pointerdown', 'keydown', 'touchstart'];

/**
 * 분할 보기 스크롤 동기화 (FR-VIEW-05). 사용자가 스크롤한 쪽의 원문 줄로 다른 쪽을 옮긴다.
 * 프로그램이 일으킨 스크롤은 잠금으로 되받지 않는다.
 */
export class ScrollSync {
  private leader: Side | null = null;
  private unlock: ReturnType<typeof setTimeout> | null = null;
  private settleId = 0;
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
    for (const ev of USER_INPUT) preview.el.addEventListener(ev, () => this.onUserInput('preview'), { passive: true });
  }

  /** 원문 보기는 나중에 불러오므로 그때 붙인다. */
  attachSource(source: SourceView) {
    this.source = source;
    source.view.scrollDOM.addEventListener('scroll', () => this.onScroll('source'), { passive: true });
    for (const ev of USER_INPUT) source.view.scrollDOM.addEventListener(ev, () => this.onUserInput('source'), { passive: true });
  }

  /** 따라가던 쪽을 사용자가 직접 움직이기 시작하면 다시 맞추기를 멈추고 잠금을 푼다. */
  private onUserInput(side: Side) {
    if (this.leader === side) return;
    this.settleId++;
    this.leader = null;
  }

  private onScroll(side: Side) {
    if (this.suspended || !this.isVisible(side)) return;
    if (side === 'preview' && this.preview.settling) return;
    if (side === 'source' && this.source?.settling) return;
    if (this.leader && this.leader !== side) return;
    if (side === 'source' && !this.source) return;
    const line = this.lineOf(side);
    this.onLine(line);
    if (!this.isSplit()) return;
    this.lead(side);
    this.follow(side, line);
    this.settle(side, line);
  }

  private lineOf(side: Side): number {
    return side === 'preview' ? this.preview.topLine() : this.source!.topLine();
  }

  /** side를 앞선 쪽으로 잠근다. 잠금은 마지막 호출 150 ms 뒤에 풀린다. */
  private lead(side: Side) {
    this.leader = side;
    if (this.unlock) clearTimeout(this.unlock);
    this.unlock = setTimeout(() => (this.leader = null), 150);
  }

  private follow(side: Side, line: number) {
    if (side === 'preview') this.source?.scrollToLine(line);
    else this.preview.scrollToLine(line);
  }

  /**
   * 따라간 뒤 몇 프레임 동안 앞선 쪽의 현재 줄로 다시 맞춘다.
   * 미리보기의 화면 밖 블록(content-visibility)과 원문의 줄 바꿈 줄은 처음에 추정 높이로 배치됐다가
   * 그려진 뒤 실제 높이로 바뀐다. 그러면 앞선 쪽의 줄도, 한 번 맞춘 다른 쪽 위치도 스크롤 이벤트 없이 어긋난다.
   */
  private settle(side: Side, line: number) {
    const id = ++this.settleId;
    const other: Side = side === 'preview' ? 'source' : 'preview';
    let last = line;
    let frames = 0;
    let stable = 0;
    const step = () => {
      if (id !== this.settleId || this.suspended || !this.isSplit() || this.leader !== side) return;
      const now = this.lineOf(side);
      if (Math.abs(now - last) > LINE_EPS) this.onLine(now);
      if (Math.abs(now - this.lineOf(other)) > LINE_EPS) {
        this.follow(side, now);
        stable = 0;
      } else {
        stable++;
      }
      last = now;
      this.lead(side);
      if (++frames < SETTLE_FRAMES && stable < SETTLE_STABLE) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
