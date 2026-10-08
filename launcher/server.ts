// 실행기 서버 (SDD 6.2, 7.3, 8.4). 127.0.0.1에서만 듣고, 토큰·Host·허용 폴더를 검사한 요청에만 파일을 내준다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Logger, type LogLevel } from './log';
import { caseInsensitiveFs, currentPlatform, needsPolling, reveal, type Platform } from './os';
import { logsDir, MAX_ROOTS, readState, writeState } from './state';
import { L } from './strings';
import { Watcher } from './watch';

export const DEFAULT_PORT = 7787;
const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 25_000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export interface ServerOptions {
  home: string;
  viewerPath: string;
  version: string;
  /** 먼저 시도할 포트. 없으면 state.json의 포트, 그것도 없으면 DEFAULT_PORT. 0이면 빈 포트 */
  port?: number;
  /** 연결된 뷰어 없이 이만큼 지나면 끝난다 */
  idleMs?: number;
  maxBytes?: number;
  logger?: Logger;
  platform?: Platform;
  /** 끝날 때 프로세스도 끝낼지 (실행 파일은 true, 테스트는 false) */
  exitOnClose?: boolean;
}

export interface RunningServer {
  port: number;
  token: string;
  /** 끝났을 때 풀린다 */
  closed: Promise<void>;
  close(why?: string): Promise<void>;
  addRoot(root: string): void;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isAbsolute = (p: string, win: boolean) => (win ? /^[a-zA-Z]:[\\/]|^\\\\[^\\]/.test(p) : p.startsWith('/'));

/** 없는 파일이면 가장 가까운 있는 상위 폴더의 실제 경로에 나머지를 붙인다. 심볼릭 링크로 루트를 빠져나가지 못하게 한다. */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function fsError(e: unknown): ApiError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new ApiError(404, 'ENOENT', L.err.noFile);
  if (code === 'EACCES' || code === 'EPERM') return new ApiError(403, 'EACCES', L.err.denied);
  if (code === 'EISDIR') return new ApiError(409, 'EISDIR', L.err.isDir);
  return new ApiError(500, 'EIO', (e as Error)?.message ?? L.err.internal);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const platform = opts.platform ?? currentPlatform();
  const win = platform.platform === 'win32';
  const logger = opts.logger ?? new Logger(logsDir(opts.home));
  const log = (level: LogLevel, msg: string) => logger.write(level, msg);
  const prev = readState(opts.home);
  const token = prev?.token ?? crypto.randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const idleMs = opts.idleMs ?? 600_000;
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;

  /** 허용 폴더: 사용자가 준 경로(화면에 보이는 형태) → 실제 경로. 오래전에 더한 것이 앞이다. */
  const roots = new Map<string, string>();
  // 지난 서버가 기억한 허용 폴더를 이어 받는다. 사라진 폴더는 버린다.
  for (const given of prev?.roots ?? []) {
    try {
      const real = fs.realpathSync.native(given);
      if (fs.statSync(real).isDirectory()) roots.set(given, real);
    } catch {
      // 없어진 폴더
    }
  }
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  const inside = (child: string, dir: string) => {
    const c = norm(child);
    const d = norm(dir);
    return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
  };

  /** 요청 경로를 검사해 실제로 읽을 경로를 돌려준다 */
  const allowed = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || !isAbsolute(raw, win)) throw new ApiError(400, 'EINVAL', L.err.badRequest);
    let real: string;
    try {
      real = realpathLoose(path.resolve(raw));
    } catch (e) {
      throw fsError(e);
    }
    for (const r of roots.values()) if (inside(real, r)) return real;
    throw new ApiError(403, 'EACCES', L.err.outside);
  };

  // ---- SSE 연결과 감시
  const connections = new Map<string, Set<http.ServerResponse>>();
  const watchSets = new Map<string, Set<string>>();
  const watcher = new Watcher(
    (e) => {
      const data = `event: file.${e.type}\ndata: ${JSON.stringify({ path: e.path })}\n\n`;
      for (const [client, set] of watchSets) {
        if (!set.has(e.path)) continue;
        for (const res of connections.get(client) ?? []) res.write(data);
      }
    },
    {
      poll: (f) => needsPolling(f, platform),
      ignoreCase: caseInsensitiveFs(platform),
      onError: (dir, err) => log('warn', L.log.watchFallback(dir, err.message)),
    },
  );
  const rewatch = () => {
    const all = new Set<string>();
    for (const s of watchSets.values()) for (const p of s) all.add(p);
    watcher.setPaths(all);
  };

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closing: Promise<void> | null = null;
  const connectionCount = () => [...connections.values()].reduce((n, s) => n + s.size, 0);
  const touchIdle = () => {
    if (closing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (connectionCount() === 0) idleTimer = setTimeout(() => void close(L.log.idle), idleMs);
  };
  const heartbeat = setInterval(() => {
    for (const set of connections.values()) for (const res of set) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // ---- 뷰어 HTML (바뀌면 다시 읽는다)
  let viewer: { mtime: number; body: Buffer; csp: string | null } | null = null;
  const loadViewer = () => {
    const st = fs.statSync(opts.viewerPath);
    if (!viewer || viewer.mtime !== st.mtimeMs) {
      const body = fs.readFileSync(opts.viewerPath);
      const m = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])(.*?)\1/i.exec(body.toString('utf8'));
      viewer = { mtime: st.mtimeMs, body, csp: m ? m[2] : null };
    }
    return viewer;
  };

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, value: unknown) =>
    send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
  const sendError = (res: http.ServerResponse, e: ApiError) => json(res, e.status, { code: e.code, message: e.message });

  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        reject(new ApiError(400, 'EINVAL', L.err.badRequest));
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY && !failed) {
          failed = true;
          reject(new ApiError(413, 'ETOOBIG', L.err.tooBig));
        }
        if (!failed) chunks.push(c);
      });
      req.on('end', () => {
        if (failed) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          reject(new ApiError(400, 'EINVAL', L.err.badRequest));
        }
      });
      req.on('error', reject);
    });

  const tokenOk = (t: string | null) => {
    if (!t) return false;
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };

  let port = 0;

  /** state.json에 포트·토큰·pid·허용 폴더를 적는다. 다시 뜬 서버가 이어 받는다. */
  const persist = () => {
    if (!closing) writeState(opts.home, { schemaVersion: 2, port, token, pid: process.pid, version: opts.version, roots: [...roots.keys()] });
  };
  /** 허용 폴더를 더하거나 맨 뒤(최근)로 옮기고, MAX_ROOTS개를 넘으면 오래된 것부터 버린다. */
  const rememberRoot = (given: string, real: string) => {
    if (!roots.has(given)) log('info', L.log.rootAdded(given));
    roots.delete(given);
    roots.set(given, real);
    while (roots.size > MAX_ROOTS) roots.delete(roots.keys().next().value!);
    if (port) persist();
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const host = req.headers.host ?? '';
    // DNS 리바인딩 차단: 루프백 이름으로 온 요청만 받는다 (SDD 8.4).
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ApiError(403, 'EFORBIDDEN', L.err.forbidden);
    const url = new URL(req.url ?? '/', `http://${host}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /') {
      // 뷰어의 저장소(localStorage)는 origin에 묶이므로 한 이름(127.0.0.1)으로 모은다.
      if (host.startsWith('localhost:')) {
        send(res, 302, '', { location: `http://127.0.0.1:${port}${req.url ?? '/'}` });
        return;
      }
      if (!tokenOk(url.searchParams.get('t'))) throw new ApiError(403, 'EFORBIDDEN', L.err.forbidden);
      let v;
      try {
        v = loadViewer();
      } catch {
        throw new ApiError(500, 'EIO', L.err.viewerMissing);
      }
      const csp = v.csp ? `${v.csp.replace(/;\s*$/, '')}; frame-ancestors 'none'` : "frame-ancestors 'none'";
      send(res, 200, v.body, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'content-security-policy': csp });
      return;
    }
    if (route === 'GET /favicon.ico') {
      send(res, 204, '');
      return;
    }
    if (!url.pathname.startsWith('/api/')) throw new ApiError(404, 'ENOENT', L.err.noApi);
    if (!tokenOk(url.searchParams.get('t'))) throw new ApiError(403, 'EFORBIDDEN', L.err.forbidden);
    const q = (k: string) => url.searchParams.get(k);

    switch (route) {
      case 'GET /api/ping':
        return json(res, 200, { version: opts.version, pid: process.pid });
      case 'GET /api/ready':
        return json(res, 200, { version: opts.version, roots: [...roots.keys()], pathStyle: win ? 'win' : 'posix' });
      case 'GET /api/read': {
        const real = allowed(q('path'));
        let st: fs.Stats;
        try {
          st = fs.statSync(real);
        } catch (e) {
          throw fsError(e);
        }
        if (st.isDirectory()) throw new ApiError(409, 'EISDIR', L.err.isDir);
        if (st.size > maxBytes) throw new ApiError(413, 'ETOOBIG', L.err.tooBig);
        let body: Buffer;
        try {
          body = fs.readFileSync(real);
        } catch (e) {
          throw fsError(e);
        }
        return send(res, 200, body, { 'content-type': 'application/octet-stream', 'x-mdv-mtime': String(Math.round(st.mtimeMs)) });
      }
      case 'GET /api/list': {
        const real = allowed(q('path'));
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(real, { withFileTypes: true });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOTDIR') throw new ApiError(400, 'EINVAL', L.err.notDir);
          throw fsError(e);
        }
        const out = entries.map((d) => {
          let isDir = d.isDirectory();
          if (d.isSymbolicLink()) {
            try {
              isDir = fs.statSync(path.join(real, d.name)).isDirectory();
            } catch {
              isDir = false;
            }
          }
          return { name: d.name, isDir };
        });
        return json(res, 200, out);
      }
      case 'GET /api/file': {
        const raw = q('path') ?? '';
        const type = IMAGE_TYPES[path.extname(raw).toLowerCase()];
        if (!type) throw new ApiError(415, 'EINVAL', L.err.notImage);
        const real = allowed(raw);
        let body: Buffer;
        try {
          if (fs.statSync(real).size > maxBytes) throw new ApiError(413, 'ETOOBIG', L.err.tooBig);
          body = fs.readFileSync(real);
        } catch (e) {
          throw e instanceof ApiError ? e : fsError(e);
        }
        const headers: http.OutgoingHttpHeaders = { 'content-type': type };
        if (type === 'image/svg+xml') headers['content-security-policy'] = SVG_CSP;
        return send(res, 200, body, headers);
      }
      case 'GET /api/events': {
        const client = (q('client') ?? '').slice(0, 100) || crypto.randomBytes(8).toString('hex');
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        });
        res.write('retry: 3000\n\n');
        if (!connections.has(client)) connections.set(client, new Set());
        connections.get(client)!.add(res);
        touchIdle();
        req.on('close', () => {
          const set = connections.get(client);
          set?.delete(res);
          if (set && !set.size) {
            connections.delete(client);
            watchSets.delete(client);
            rewatch();
          }
          touchIdle();
        });
        return;
      }
      case 'POST /api/watch': {
        const body = await readBody(req);
        const client = typeof body?.client === 'string' ? body.client.slice(0, 100) : '';
        if (!client || !Array.isArray(body.paths)) throw new ApiError(400, 'EINVAL', L.err.badRequest);
        const set = new Set<string>();
        for (const p of body.paths.slice(0, 1000)) {
          try {
            allowed(p);
            // 검사한 모양(.. 을 접은 경로)으로 감시한다. 원래 문자열로 보면 심볼릭 링크 뒤의 .. 를 OS가 풀어 허용 폴더 밖을 보게 된다.
            set.add(path.resolve(p));
          } catch {
            // 허용 폴더 밖이나 잘못된 경로는 감시하지 않는다.
          }
        }
        watchSets.set(client, set);
        rewatch();
        return send(res, 204, '');
      }
      case 'POST /api/roots': {
        const body = await readBody(req);
        const root = body?.root;
        if (typeof root !== 'string' || !isAbsolute(root, win)) throw new ApiError(400, 'EINVAL', L.err.badRequest);
        const given = path.resolve(root);
        let real: string;
        try {
          real = fs.realpathSync.native(given);
          if (!fs.statSync(real).isDirectory()) throw new ApiError(400, 'EINVAL', L.err.notDir);
        } catch (e) {
          throw e instanceof ApiError ? e : fsError(e);
        }
        rememberRoot(given, real);
        return send(res, 204, '');
      }
      case 'POST /api/reveal': {
        const body = await readBody(req);
        const real = allowed(body?.path);
        void reveal(real, platform);
        return send(res, 204, '');
      }
      case 'POST /api/log': {
        const body = await readBody(req);
        const level: LogLevel = body?.level === 'error' ? 'error' : body?.level === 'warn' ? 'warn' : 'info';
        log(level, L.log.viewer(String(body?.msg ?? '').slice(0, 2000)));
        return send(res, 204, '');
      }
      case 'POST /api/stop':
        send(res, 204, '');
        setImmediate(() => void close(L.log.stopRequest));
        return;
      default:
        throw new ApiError(404, 'ENOENT', L.err.noApi);
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!(e instanceof ApiError)) log('error', L.log.requestFailed(req.url ?? '', (e as Error)?.message ?? String(e)));
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, e instanceof ApiError ? e : new ApiError(500, 'EIO', L.err.internal));
    });
  });

  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (e: Error) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });

  // 명령에 준 포트(--port)가 있으면 그것을, 없으면 지난 포트를 먼저 쓴다. 지난 포트를 쓰면 뷰어 탭의 origin(127.0.0.1:<포트>)과 저장소가 그대로 이어진다.
  const preferred = opts.port ?? prev?.port ?? DEFAULT_PORT;
  try {
    port = await listen(preferred);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferred === 0) throw e;
    port = await listen(0);
  }
  persist();
  log('info', L.log.started(port, process.pid));
  touchIdle();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  async function close(why = ''): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      log('info', L.log.stopping(why));
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(heartbeat);
      watcher.close();
      for (const set of connections.values()) for (const res of set) res.end();
      connections.clear();
      const done = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await done;
      // 포트·토큰은 남겨, 다시 뜬 실행기에 열려 있던 뷰어가 그대로 붙게 한다.
      const cur = readState(opts.home);
      if (cur?.pid === process.pid) writeState(opts.home, { ...cur, pid: null });
      resolveClosed();
      if (opts.exitOnClose) process.exit(0);
    })();
    return closing;
  }

  return {
    port,
    token,
    closed,
    close,
    addRoot(root: string) {
      const given = path.resolve(root);
      rememberRoot(given, fs.realpathSync.native(given));
    },
  };
}
