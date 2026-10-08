// 실행기 테스트 공용 도구: 임시 MDVIEW_HOME, 작은 viewer.html, 루프백 요청, SSE 읽기.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const VIEWER_CSP = "default-src 'none'; img-src 'self'";

const created: string[] = [];
// 테스트가 만든 임시 폴더는 테스트 프로세스가 끝날 때 지운다.
process.on('exit', () => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix = 'mdv-launcher-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

export function makeViewer(dir: string): string {
  const file = path.join(dir, 'viewer.html');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}"><title>viewer</title>`, 'utf8');
  return file;
}

export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json(): any;
}

/** Host 헤더를 마음대로 정할 수 있는 요청 (fetch는 Host를 바꿀 수 없다). */
export function request(
  port: number,
  pathAndQuery: string,
  opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        agent: false,
        method: opts.method ?? 'GET',
        path: pathAndQuery,
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function postJson(port: number, token: string, api: string, value: unknown): Promise<Res> {
  return request(port, `${api}?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

export const q = (token: string, extra: Record<string, string> = {}) => '?' + new URLSearchParams({ t: token, ...extra });

/** SSE 연결. next(event)로 그 이름의 다음 이벤트를 기다린다. */
export function openEvents(port: number, token: string, client: string) {
  const queue: { event: string; data: any }[] = [];
  const waiters: (() => void)[] = [];
  let buf = '';
  let req!: http.ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, agent: false, path: `/api/events${q(token, { client })}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) {
            queue.push({ event: ev, data: JSON.parse(data) });
            for (const w of waiters.splice(0)) w();
          }
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
  return {
    ready,
    close: () => req.destroy(),
    async next(event: string, timeoutMs = 3000): Promise<any> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex((e) => e.event === event);
        if (i >= 0) return queue.splice(i, 1)[0].data;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no ${event} event`);
        await new Promise<void>((r) => {
          const t = setTimeout(r, left);
          waiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
    drain() {
      queue.length = 0;
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
