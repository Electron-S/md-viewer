/** GitHub 방식 제목 id: 소문자, 문장부호 제거(한글 유지), 공백은 `-`, 중복은 `-1`, `-2`. */
export class Slugger {
  private seen = new Map<string, number>();

  slug(text: string): string {
    let base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    if (!base) base = 'section';
    let n = this.seen.get(base);
    if (n === undefined) {
      this.seen.set(base, 0);
      return base;
    }
    let id: string;
    do {
      n++;
      id = `${base}-${n}`;
    } while (this.seen.has(id));
    this.seen.set(base, n);
    this.seen.set(id, 0);
    return id;
  }
}
