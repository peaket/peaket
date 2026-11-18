# 갈래 4 — 구간 끝 정리 목록

- 갈래 4(ADR-0286)가 묶음에서 고치지 않은 리뷰·검증의 중간·낮은 지적을 '묶음 ID(R 번호) 지적 번호 심각도: 지적 한 줄(파일)' 꼴로 적는다(ADR-0190 결정 2, ADR-0283 결정 2). 구간 마무리(SEG) 때 소유자가 한 번에 정하고, 그 밖에는 이 목록을 고칠 때만 읽는다. 크기 상한(ADR-0283 결정 1)을 보지 않는 파일이다.

- BAT-052(R-690) 리뷰 정리 목록(계획 `docs/review/plans/BAT-052.md` '## 리뷰' '정리 목록' 표가 원문): COR-02 낮음(판 파일은 판 번호가 오를 때만 바꿈), COR-04=CON-05 중간·확인 필요(클러스터 붙음 표·`redis_up` 판정, `sharded-channel-moved-error`, 클러스터 통합 시험), COR-07 낮음(겹친 회차 ID 가드 시험), CON-06 중간·확인 필요(보내기 버퍼 파드 전체 상한·프레임 크기 상한), CON-07 낮음(메시지 처리기 감싸기), CON-10 낮음(`closes_total{code}` 라벨 집합), CON-11 낮음(간격은 단조 시계), SEC-06 낮음(받는 프레임 수 상한), SEC-07 낮음(회차 다른 토큰이면 판 파일을 읽지 않음), WIR-07 정보(가짜 서버 PoC 주석 → HOT-415)(services/realtime-gw, tools/web-checks/purchase).
- BAT-052(R-690) 검증 놓침(통과 기준 밖): M26a·V13(겹친 가드가 가림), V7(다시 보낼 때마다 경고 줄), M46(마감 넘겨도 종료 코드 0), M35c(판 기억 원형 오염 단위 시험 빈칸), 통합 M25(다시 붙은 뒤 다시 구독 안 함 — node-redis 6.3이 스스로 다시 구독해 가려짐)·M27b(받는 층이 1001로 닫음 — 허브가 먼저 1012)(services/realtime-gw).
- BAT-052(R-690) 검증 판정: 4429 `too many`로 닫는 모든 연결이 100ms 유예·jti 셈을 받는다(정본은 '맺은 뒤 곧 닫는 연결'). 해는 없음, 정본과 맞추기는 (나) '맺은 뒤 곧 닫음' 표시로 고르기 추천(services/realtime-gw/src/modules/stream/inbound/handshake.ts, ADR-0297 결정 3).
- BAT-052(R-690) 뺀 ASVS 27행(장부 범위를 좁힘, 감독 결정 2026-11-18): 3.3.2, 3.4.1, 3.4.2, 3.4.4, 3.5.2, 3.5.3, 3.5.4, 3.7.1, 4.1.2, 4.2.1, 5.4.2, 8.4.1, 12.1.1, 12.1.2, 12.2.1, 12.2.2, 13.3.1, 13.4.2, 14.1.1, 15.1.1, 15.1.2, 15.2.1, 15.2.3, 15.3.2, 15.3.4, 16.4.2, 16.4.3 — 구현 위치에 기존 시험 경로를 적어 닫을지 SEG 때 정함(docs/security/asvs/seat-hold.md).
- BAT-052(R-690) 입장 토큰 확인 규칙이 `packages/platform` `verifyAdmissionToken`과 purchase-svc 두 곳에 있다. purchase-svc를 platform 함수로 바꾸는 일(다른 갈래 코드)(ADR-0296 결정 2).
- BAT-052(R-690) 계정 전체 동시 연결 상한(SEC-02 뒤, 지금은 파드 안 jti 2개·파드 5,000만): S-T12 ① 측정(갈래 5 측정 창 2) 뒤 정함, 정하면 HOT-415(갈래 1) 쪽(감독 결정 2026-11-19).
- 감독 넘김(BAT-416 RV-02, 낮음): 차례 배포 중 옛 purchase-svc 파드가 `changedAtMs`를 초로 낼 수 있다. realtime-gw가 `changedAtMs` < 10^12면 묶음 대기·지연 계산에서 뺄지 나중에 정한다(services/realtime-gw/src/modules/stream/application/hub.ts).
