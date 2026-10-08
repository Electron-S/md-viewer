// 실행기 로그 (NFR-REL-03): UTF-8, 1 MB에서 순환하며 3개(mdview.log, .1, .2)를 남긴다.
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info';

export class Logger {
  readonly file: string;

  constructor(
    dir: string,
    private maxBytes = 1024 * 1024,
    private keep = 3,
  ) {
    this.file = path.join(dir, 'mdview.log');
  }

  write(level: LogLevel, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg.replace(/\r?\n/g, ' ')}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        // 아직 로그가 없다.
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, 'utf8');
    } catch {
      // 로그를 못 남겨도 실행기는 계속 돈다.
    }
  }

  private rotate(): void {
    const oldest = `${this.file}.${this.keep - 1}`;
    fs.rmSync(oldest, { force: true });
    for (let i = this.keep - 2; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    fs.renameSync(this.file, `${this.file}.1`);
  }
}
