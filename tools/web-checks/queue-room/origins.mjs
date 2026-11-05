// 대기실 세 엔진 검사의 주소(ADR-0217 결정 1). 개발용 가짜 API(4010)와 섞이지 않게 검사용 가짜 API는 4011이다
export const CHECK_MOCK_PORT = 4011;
export const CHECK_MOCK_ORIGIN = `http://127.0.0.1:${CHECK_MOCK_PORT}`;
/** 같은 출처 검사 틀(lib/same-origin.mjs) */
export const CHECK_ORIGIN = 'http://127.0.0.1:4130';
