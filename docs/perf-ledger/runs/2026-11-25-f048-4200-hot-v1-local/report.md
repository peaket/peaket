# F-04-8 측정 결과 2026-11-25T06-15-38-hot
- 판정: **pass**
- 입력: 2,520,000건, 발생기 실패 0건, 모드 hot
- 신선도(관제): p95 4096ms, 샘플 402개, 1분 창 9개, 창 위반 0개(예열 60초 제외)
- 신선도(브론즈, 참고): p95 1974ms
- 시계 차(ClickHouse−호스트): 1ms (통과)
- 누락률: 0.0000% (전체 2,541,888, 못 읽음 0, 거절 0)
- 정확성: 차이 0 (비교 17개)
- 소비자 밀림: 분석 0, 관제 0
- 조회 p95: 33ms, ClickHouse CPU p95 51.7%, 호스트 CPU p95 35.5%
- 인기 회차 파티션 밀림 p95: 666ms (통과)
| 브론즈 | 기대 | 실제 |
| --- | --- | --- |
| seat | 1677600 | 1677600 |
| order | 842400 | 842400 |
| payment | 0 | 0 |
| ticket | 0 | 0 |
| hold | 0 | 0 |
| verdict | 0 | 0 |
| queue | 0 | 0 |
| orderAmount | 10951197000 | 10951197000 |
| paymentAmount | 0 | 0 |
| 관제 rt | 기대 | 실제 |
| --- | --- | --- |
| seatSold | 1677600 | 1677600 |
| orderConfirmed | 842400 | 842400 |
| paymentApproved | 0 | 0 |
| ticketIssued | 0 | 0 |
| paymentAmount | 0 | 0 |
| holdHelped | 0 | 0 |
| holdConflict | 0 | 0 |
| verdictPass | 0 | 0 |
