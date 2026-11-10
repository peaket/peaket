// 측정 무대의 회차 열기에 쓰는 것(BUILD_ORDER PRF-215, docs/verification.md §3.9 'v1 경로'). core-svc 판매 승인(BUILD_ORDER LCH-080)이 없는 local·ci 무대에서
// 한 프로세스 합본의 시드(services/bundle/src/seed.ts)가 운영 코드와 같은 좌석 판매 열기(RedisSeatStore.openSale)와 다시 만들기 표시(markOpened)를 부른다.
// 운영 조립(start.ts)은 이 파일을 쓰지 않는다.
export { DrizzleSeatRebuildSource } from './modules/inventory/adapters/db/drizzle-seat-rebuild.js';
export { RedisSeatStore } from './modules/inventory/adapters/redis-seat-store.js';
export { KEEP_AFTER_SALE_END_MS } from './modules/inventory/index.js';
