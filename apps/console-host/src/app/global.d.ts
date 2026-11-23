// webpack DefinePlugin 값: 개발 서버에서만 true(화면 목록 /preview와 상태 고르기 패널)
declare const __PREVIEW__: boolean;
// 관제 API(gw-ops)와 스캐너 PWA 주소(빌드 때 PEAKET_OPS_API_ORIGIN·PEAKET_SCANNER_ORIGIN으로 바꾼다)
declare const __OPS_API_ORIGIN__: string;
declare const __SCANNER_ORIGIN__: string;
// 콘솔 밖 도구 링크(F-03-3, ADR-0067·0371): Grafana·Sentry 주소 틀과 링크로 열어 줄 호스트(쉼표). 빌드 때 PEAKET_CONSOLE_GRAFANA_URL·PEAKET_CONSOLE_SENTRY_URL·PEAKET_CONSOLE_LINK_HOSTS로 바꾼다
declare const __CONSOLE_GRAFANA_URL__: string;
declare const __CONSOLE_SENTRY_URL__: string;
declare const __CONSOLE_LINK_HOSTS__: string;

// 빌드 종류: mf(Module Federation 호스트 + 원격 둘) | single(한 앱 기준선, PEAKET_CONSOLE_BUILD=single, ADR-0360)
declare const __CONSOLE_BUILD__: 'mf' | 'single';
// webpack Module Federation 실행 중 API(원격 컨테이너 잇기, src/app/remotes/load-remote.ts)
declare function __webpack_init_sharing__(scope: string): Promise<void>;
declare const __webpack_share_scopes__: { default: unknown };

declare module '*.css';
