// 월렛 IndexedDB 저장소는 entities/wallet으로 옮겼다(월렛 목록 받기 features/wallet-sync와 함께 쓴다, ADR-0329 '같은 층의 다른 조각').
// 이 조각의 안쪽 파일(enrollment·DeviceQr 등)과 시험이 쓰던 경로를 그대로 두려고 다시 내보낸다.
export * from '../../entities/wallet/index.ts';
