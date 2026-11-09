// 경고 로그 문(추천 적용 2026-11-04 L6): 메모리 부족 경고를 파드마다 1초에 한 줄까지만 남긴다. 받는 층(HoldsController)과 만료 반복(ExpirySweeper)이
// 같은 문을 나눈다(InventoryModule이 하나만 만든다). 시각은 주입 Clock의 벽시계다. 문 자체(LogGate)는 어댑터도 쓰므로 도메인 층에 있다(domain/log-gate.ts).
export { LogGate } from '../domain/log-gate.js';

/** 주입 이름(InventoryModule이 파드에 하나 둔다) */
export const OOM_WARN_GATE = Symbol('purchase.OomWarnGate');
