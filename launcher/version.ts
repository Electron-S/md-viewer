// 실행기 버전. 빌드(tools/build.mjs)와 테스트 묶음(tools/test.mjs)이 __MDV_VERSION__을 package.json의 version으로 바꾼다.
// 그 정의 없이 돌릴 때만 0.0.0-dev.
export const VERSION: string = typeof __MDV_VERSION__ === 'string' ? __MDV_VERSION__ : '0.0.0-dev';
