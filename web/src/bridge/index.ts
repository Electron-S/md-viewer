// 모드 판별 (SDD 3장): 실행기 주소(`http://127.0.0.1:<포트>/?t=<토큰>`)면 실행기 브리지, 그 밖은 파일 핸들 브리지.
import { LocalBridge } from './local';
import { ServerBridge } from './server';
import type { Bridge } from './types';

export * from './types';

export function createBridge(): Bridge {
  const local = new LocalBridge();
  const params = new URLSearchParams(location.search);
  if (/^https?:$/.test(location.protocol) && params.get('t')) return new ServerBridge(local, params);
  return local;
}
