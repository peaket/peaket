# 갈래 1 — 마지막 상태(2026-11-13, R-517)

- 갈래 1의 정본 진행 기록은 `docs/PROGRESS.md`다(ADR-0190 결정 3). 이 파일은 마지막 상태만 짧게 남긴다.
- **BAT-033/HOT-467: 부분 완료(known gap).** K2/A/A는 r23 21.74ms·r24 22.36ms·r25 22.81ms, dropped 0, A/A 0.9723/0.9800으로 통과·닫음. K7 공식 3회는 1.37/5.51/2.01%·p99 3,168.9/4,344.9/3,413.9ms, 진단 최선은 1.77%(167/9,422)·p99 3,773.6ms로 **공식 ≤1%·p99 <3초 미달**이다.
- 원인: `payment.confirm.gateway` p99 1,783ms(시뮬레이터 승인 지연·큐), `payment.status.wait` p99 3,455ms, 16초 지연군 0.5% 고정. 집기 19.7ms·결과 반영 52.2ms는 작다. 개선 이력 9%대→5.62%→1.77%.
- 재개 조건: 시뮬레이터 승인 지연 모델·동시 처리, `payment.status.wait` 경로 추가 최적화, 실제 PG·운영 무대 재측정 가운데 하나.
- 다음 갈래 1 묶음: **BAT-050**(HOT-160·HOT-090), **BAT-051**(HOT-252). BAT-036(SEG-010)은 구간 1의 다른 단계가 모두 끝난 뒤.
- 정본 기록: `docs/verification.md` §3.10, `docs/review/measurements/BAT-033-k7-finish.md` §12, `docs/BUILD_ORDER.md` BAT-033/HOT-467.
