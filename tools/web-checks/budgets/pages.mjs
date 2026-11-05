// Lighthouse가 재는 대표 주소(docs/frontend.md §5.8 'Lighthouse CI': 홈, 공연 상세, 대기실 셸, 좌석 화면 데모, 결제 데모, 월렛,
// 관제 대시보드 데모, 파트너 판매 현황 데모). 지금은 퍼블리싱 화면(목업 데이터, ADR-0170)이라 콘솔 둘도 가짜 API 없이 뜬다.
// row는 §5.8 표의 경로 묶음 이름이다(체감 목표를 그 행에서 읽는다).
import { APPS, portOf } from '../seed-css/apps.mjs';

/** 대기실 경량 페이지 셸(별도 빌드 apps/web/queue-room/dist)을 띄우는 정적 서버. 시각 회귀(playwright.visual.config.mjs)와 같은 preset */
export const QUEUE_ROOM = {
  port: 4106,
  path: '/queue/evt-lumen-2026',
  command: 'node lib/serve.mjs --root ../../apps/web/queue-room/dist --port 4106 --preset queue-room',
};

const app = (name) => {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`앱 ${name}이 seed-css/apps.mjs에 없다`);
  return a;
};

/** @param {string} host */
export function lighthousePages(host) {
  const at = (name, path) => `http://${host}:${portOf(app(name), 'prod')}${path}`;
  return [
    { name: '홈', url: at('web', '/'), row: '홈·공연 상세·굿즈(ISR)' },
    { name: '공연 상세', url: at('web', '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01'), row: '홈·공연 상세·굿즈(ISR)' },
    { name: '대기실 셸', url: `http://${host}:${QUEUE_ROOM.port}${QUEUE_ROOM.path}`, row: '대기실 경량 페이지' },
    { name: '좌석 화면 데모', url: at('web', '/booking/evt-lumen-1025/seats'), row: '좌석 화면' },
    { name: '결제 데모', url: at('web', '/booking/evt-lumen-1025/checkout'), row: '결제 화면' },
    { name: '월렛', url: at('web', '/my/tickets'), row: '월렛' },
    { name: '관제 대시보드 데모', url: at('console', '/'), row: '관제 콘솔' },
    { name: '파트너 판매 현황 데모', url: at('partner', '/events'), row: '파트너 콘솔' },
  ];
}
