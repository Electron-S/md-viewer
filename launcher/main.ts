// 실행기 진입점. `--serve`면 서버로, 아니면 명령으로 돈다.
// esbuild가 이 파일을 mdview.mjs 하나로 묶고, viewer.html·SKILL.md는 그 옆에 둔다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli';
import { Logger } from './log';
import { startServer } from './server';
import { homeDir, logsDir } from './state';
import { L } from './strings';
import { VERSION } from './version';

const scriptPath = fileURLToPath(import.meta.url);
const here = path.dirname(scriptPath);
const argv = process.argv.slice(2);

async function serve(args: string[]) {
  const home = homeDir();
  const logger = new Logger(logsDir(home));
  process.on('uncaughtException', (e) => logger.write('error', L.log.uncaught(e.stack ?? String(e))));
  const i = args.indexOf('--port');
  const port = i >= 0 ? Number(args[i + 1]) : undefined;
  const env = process.env;
  const server = await startServer({
    home,
    viewerPath: env.MDVIEW_VIEWER || path.join(here, 'viewer.html'),
    version: VERSION,
    port: Number.isInteger(port) ? port : undefined,
    idleMs: env.MDVIEW_IDLE_MS ? Number(env.MDVIEW_IDLE_MS) : undefined,
    maxBytes: env.MDVIEW_MAX_BYTES ? Number(env.MDVIEW_MAX_BYTES) : undefined,
    logger,
    exitOnClose: true,
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void server.close(L.log.signal(sig)));
}

// 부른 쪽이 출력을 먼저 닫아도(`mdview … | head -1` 등) 오류 없이 끝낸다.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw e;
  });
}

if (argv[0] === '--serve') {
  void serve(argv.slice(1));
} else {
  void runCli(argv, {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    env: process.env,
    cwd: process.cwd(),
    scriptPath,
  }).then((code) => {
    process.exitCode = code;
  });
}
