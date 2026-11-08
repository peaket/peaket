// Lighthouse가 재는 대표 주소(docs/frontend.md §5.8 'Lighthouse CI': 홈, 공연 상세, 대기실 셸, 좌석 화면 데모, 결제 데모, 월렛,
// 관제 대시보드 데모, 파트너 판매 현황 데모). 지금은 퍼블리싱 화면(목업 데이터, ADR-0170)이라 콘솔 둘도 가짜 API 없이 뜬다.
// row는 §5.8 표의 경로 묶음 이름이다(체감 목표를 그 행에서 읽는다).
import { APPS, portOf } from '../seed-css/apps.mjs';

/**
 * 대기실 경량 페이지 셸(별도 빌드 apps/web/queue-room/dist)을 띄우는 정적 서버. 시각 회귀(playwright.visual.config.mjs)와 같은 preset.
 * 대기열 화면은 데이터에 이어(ADR-0207) 사전 검증 토큰이 없으면 공연 상세로 넘어가고, Lighthouse는 저장소를 비우고 연다.
 * 그래서 같은 셸·같은 JS·CSS 묶음을 쓰고 네트워크 없이 그려지는 굿즈 대기 주소로 잰다
 */
export const QUEUE_ROOM = {
  port: 4106,
  path: '/shop/md-lumen-lightstick/queue',
  command: 'node lib/serve.mjs --root ../../apps/web/queue-room/dist --port 4106 --preset queue-room',
};

const app = (name) => {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`앱 ${name}이 seed-css/apps.mjs에 없다`);
  return a;
};

const SEAT_DEMO_EVENT = 'evt-lumen-1025';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * 좌석 화면은 입장 저장값이 없으면 안내를 보이고 대기실로 옮긴다(d5 §5.10 '구매 세션 끝'). 대기실은 이 서버에 없어(운영은 CDN이 낸다) 404가 되고
 * Lighthouse가 문서 오류로 멈춘다. 그래서 대기실을 지난 사람처럼 탭 저장소에 입장 저장값을 넣고 연다. 토큰은 시험용 모양뿐이고 서명은 아무도 보지 않는다.
 * 좌석맵 파일과 스냅샷은 이 서버에 없어 화면은 '불러오지 못함'에 머문다(셸·첫 JS·지도 묶음까지 재는 회귀 방지다)
 */
const seatDemoAdmission = () => ({
  [`peaket.admission.${SEAT_DEMO_EVENT}`]: JSON.stringify({
    admissionToken: `${b64url({ alg: 'none' })}.${b64url({ jti: 'lighthouse-seat-demo', event: SEAT_DEMO_EVENT, exp: 4102444800 })}.x`,
    // RFC 7515 A.3 공개키(가짜 API와 같은 시험 값)
    serverEcdhPublicKey: { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' },
    seatmapLayoutPath: `/v1/events/${SEAT_DEMO_EVENT}/seatmap-layouts/2.json`,
  }),
});

/** 결제 화면도 입장 저장값과 홀드가 있어야 머문다(없으면 대기실로 옮긴다). 홀드를 읽지 못해 '불러오지 못함'까지 잰다(회귀 방지다) */
const checkoutDemoStorage = () => ({ ...seatDemoAdmission(), [`peaket.hold.${SEAT_DEMO_EVENT}`]: JSON.stringify({ holdId: 'lighthouse-hold', seatIds: ['A-1-1'], expiresAt: '2099-01-01T00:00:00Z' }) });

/** @param {string} host */
export function lighthousePages(host) {
  const at = (name, path) => `http://${host}:${portOf(app(name), 'prod')}${path}`;
  return [
    { name: '홈', url: at('web', '/'), row: '홈·공연 상세·굿즈(ISR)' },
    { name: '공연 상세', url: at('web', '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01'), row: '홈·공연 상세·굿즈(ISR)' },
    { name: '대기실 셸', url: `http://${host}:${QUEUE_ROOM.port}${QUEUE_ROOM.path}`, row: '대기실 경량 페이지' },
    { name: '좌석 화면 데모', url: at('web', `/booking/${SEAT_DEMO_EVENT}/seats`), row: '좌석 화면', sessionStorage: seatDemoAdmission() },
    { name: '결제 데모', url: at('web', `/booking/${SEAT_DEMO_EVENT}/checkout`), row: '결제 화면', sessionStorage: checkoutDemoStorage() },
    { name: '월렛', url: at('web', '/my/tickets'), row: '월렛' },
    { name: '관제 대시보드 데모', url: at('console', '/'), row: '관제 콘솔' },
    { name: '파트너 판매 현황 데모', url: at('partner', '/events'), row: '파트너 콘솔' },
  ];
}
