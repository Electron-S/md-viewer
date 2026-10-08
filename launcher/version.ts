// 실행기 버전. 빌드가 __MDV_VERSION__을 package.json의 version으로 바꾼다. 묶지 않고 돌릴 때(테스트)는 dev.
export const VERSION: string = typeof __MDV_VERSION__ === 'string' ? __MDV_VERSION__ : '0.0.0-dev';
