// webpack DefinePlugin 값: 개발 서버에서만 true(화면 목록 /preview와 상태 고르기 패널)
declare const __PREVIEW__: boolean;
// 관제 API(gw-ops)와 스캐너 PWA 주소(빌드 때 PEAKET_OPS_API_ORIGIN·PEAKET_SCANNER_ORIGIN으로 바꾼다)
declare const __OPS_API_ORIGIN__: string;
declare const __SCANNER_ORIGIN__: string;

declare module '*.css';
