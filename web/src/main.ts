import { App } from './app';

const app = new App();
// E2E·진단용 읽기 창구. 문서 내용에서 스크립트는 실행되지 않으므로(CSP) 외부에 노출되지 않는다.
(window as any).__mdv = app;
void app.start();
