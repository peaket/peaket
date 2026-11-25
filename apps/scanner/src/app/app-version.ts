// 스캐너 앱 판. Vite define `__APP_VERSION__`은 apps/scanner/package.json의 version에서 만든다.
// Node 시험은 define이 없으므로 package.json과 같은 값으로 떨어진다(IR-05).
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.4.0';
