# 갈래 1 — 마지막 상태(2026-11-13, R-525)

- 갈래 1의 정본 진행 기록은 `docs/PROGRESS.md`다(ADR-0190 결정 3). 이 파일은 마지막 상태만 짧게 남긴다.
- **BAT-090(HOT-080·BOT-100): 완료(known gap, R-518·R-525).** HOT-080은 자동 배정 Lua·후보 목록(연석→1순위 분리→2순위→2순위 분리, 휠체어 필터)·`auto_cur` 커서·409 `manual-selection-required`를 넣었다. BOT-100은 서버 ECDH 옛 키(`PEAKET_PURCHASE_ECDH_KEY_PREV`)·`sharedSecrets`·다중 키 MAC 확인·탈취 재현 시험을 넣었다. heavy gate: test-int 46파일 1,800건(실제 PostgreSQL·Valkey, 실제 Lua 5건), 단위 285건, 변이 23/23, 4관점 리뷰 높음 3·중간 4 고침, trace-check·ledger 통과.
- **남은 문제**: S-T16 ② 1ms는 3회 반복 중앙값 전체 p99 9.7101ms·Redis 제외 3.8070ms·MAC만 1.1281ms로 미달. S-T19 문자 그대로 1,000건 동시는 로컬 단일 Valkey 100ms 마감에서 503(100 동시×10묶음은 1,000/1,000·중복 0·수동 0), S-T20은 순서 동일·굶주림 0으로 통과. 보고서 `docs/review/measurements/BAT-090-wave.md` §9.
- **S-T16 재개 조건**: 운영과 같은 다중 샤드·연결 풀·실기에서 다시 재고, Redis 근접 측정(같은 AZ·노드, 파이프라인, 로컬 세션 캐시)으로 왕복을 줄인 뒤 같은 3경로를 다시 잰다. 그래도 1ms가 어려우면 1ms 예산을 '검증 연산(ECDH/HKDF+MAC)'으로 조정할지 소유자가 정한다. 정본 `docs/verification.md` §3.11.
- **BAT-050 분할(감독 결정 2026-11-13)**: BAT-050은 **HOT-160 발권(ticket-svc 최소, 1일)** 만, BAT-052는 **HOT-090 실시간 전파(realtime-gw, 3일)** 로 나눴다. BAT-052는 새 서비스 선행이 필요해 **보류**. BAT-050 HOT-160은 다음 기회에 별도 배치.
- **BAT-051 보류(2026-11-13)**: HOT-252의 `salePolicy` 읽기 경로가 core-svc/purchase-svc에 없고 LCH-080(BAT-615) 전이라 보류. 평가 함수 `@peaket/validation/sale-policy`는 준비되어 있고, 규칙 원천만 없다.
- **BAT-033/HOT-467**: 부분 완료(known gap). K2/A/A는 r23~r25 21.74/22.36/22.81ms·A/A 0.9723/0.9800으로 통과·닫음. K7 공식 3회 1.37/5.51/2.01%·p99 3,168.9/4,344.9/3,413.9ms, 진단 최선 1.77%·3,773.6ms로 ≤1%·p99 <3초 미달. 재개 조건은 시뮬레이터 지연 모델·동시 처리, wait 경로 추가 최적화, 실제 PG·운영 무대 재측정.
- 정본 기록: `docs/BUILD_ORDER.md` BAT-050/BAT-051/BAT-052/BAT-090, `docs/features/seat-hold.md` §3, `docs/data.md` §3, `docs/PROGRESS.md`, `docs/verification.md` §3.10.
