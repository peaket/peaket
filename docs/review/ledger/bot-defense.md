# 완성 장부: bot-defense

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/bot-defense.md`, `docs/security/asvs/bot-defense.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 61 | 21 | 0 | 0 | 0 | 0 | 0 | 0 | 41 | 123 |
| 합계 | 61 | 21 | 0 | 0 | 0 | 0 | 0 | 0 | 41 | 123 |

## docs/features/bot-defense.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| B-T1 | — | 점수기 목록 파이프라인: 차단 목록 기기와 허니팟 적중 세션은 가중합과… | 점수기 목록 파이프라인: 차단 목록 기기와 허니팟 적중 세션은 가중합과 관계없이 `CHALLENGE`이고, 그때도 `HumanCheck` 검증과 그림자 판… | 자동 시험 | A | 시험: services/trust-svc/test-int/score-risk.int.test.ts, services/trust-svc/test/score-risk.test.ts 외 1곳 |
| B-T2 | — | 값 없음: 피처 Redis 시간 초과, 사람 확인 보류, 로비… | 값 없음: 피처 Redis 시간 초과, 사람 확인 보류, 로비 입장(행동 요약 없음)에서 그 점수기는 0으로 더해지고 다른 가중치는 바뀌지 않는다. 응답의… | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts |
| B-T3 | — | 응답과 기록에 점수 원값·가중치·기준값·확정 신호 종류가 없다. 사유… | 응답과 기록에 점수 원값·가중치·기준값·확정 신호 종류가 없다. 사유 범주는 하나다. 공개 저장소 `peaket`의 trust-svc 코드·설정… | 자동 시험 | A | 시험: services/trust-svc/test/grpc.test.ts, services/trust-svc/test/rules.test.ts 외 2곳 |
| B-T4 | — | 그림자 판: 그림자 판을 켜고 끄며 같은 합성 트래픽 1만 세션을 두… | 그림자 판: 그림자 판을 켜고 끄며 같은 합성 트래픽 1만 세션을 두 번 넣는다. 적용 판정이 두 번 모두 같고, 그림자 판의 `shadow` true 기록… | 빈칸 | A | — |
| B-T5 | ① | 사람 확인 서버 검증: ① 검증 API가 600ms 늦게 답하면 같은… | ① 검증 API가 600ms 늦게 답하면 같은 `idempotency_key`로 한 번 다시 묻고 | 자동 시험 | A | 시험: services/trust-svc/test/turnstile.test.ts |
| B-T5 | ② | 사람 확인 서버 검증: ① 검증 API가 600ms 늦게 답하면 같은… | ② 두 번 모두 늦으면 '검증 보류'이며 | 자동 시험 | A | 시험: services/trust-svc/test/turnstile.test.ts |
| B-T5 | ③ | 사람 확인 서버 검증: ① 검증 API가 600ms 늦게 답하면 같은… | ③ `hostname`이나 `action`이 다른 토큰은 실패이고 | 자동 시험 | A | 시험: services/trust-svc/test/turnstile.test.ts |
| B-T5 | ④ | 사람 확인 서버 검증: ① 검증 API가 600ms 늦게 답하면 같은… | ④ 쓴 토큰을 다시 보내면 실패(`timeout-or-duplicate`)이며 보류가 아니다 | 자동 시험 | A | 시험: services/trust-svc/test/turnstile.test.ts |
| B-T5 | ⑤ | 사람 확인 서버 검증: ① 검증 API가 600ms 늦게 답하면 같은… | ⑤ 검증 API 서킷이 열리면 호출하지 않고 보류다 | 자동 시험 | A | 시험: services/trust-svc/test/turnstile.test.ts |
| B-T6 | ① | 축소 운영 두 층: ① 피처 Redis를 멈추면 trust-svc가… | ① 피처 Redis를 멈추면 trust-svc가 `degraded` 참으로 답하고 진입이 이어진다 | 자동 시험 | A | 시험: services/queue-svc/test/trust-risk.test.ts, services/trust-svc/test-int/score-risk.int.test.ts 외 1곳 |
| B-T6 | ② | 축소 운영 두 층: ① 피처 Redis를 멈추면 trust-svc가… | ② trust-svc 파드를 모두 멈추면 queue-svc 서킷이 열리고 기기·계정 한도(5회/10초)가 걸리며, 호스팅 대역 IP에는 IP 한도가, 통신사… | 자동 시험 | A | 시험: services/queue-svc/test/degraded-limits.test.ts, services/queue-svc/test/risk-http.test.ts 외 1곳 |
| B-T6 | ③ | 축소 운영 두 층: ① 피처 Redis를 멈추면 trust-svc가… | ③ 그동안 받은 사전 검증 토큰에 '검증 보류'가 있고, 되살린 뒤 토큰 갱신에서 다시 판정된다 | 자동 시험 | A | 시험: services/queue-svc/test/degraded-limits.test.ts, services/queue-svc/test/risk-http.test.ts |
| B-T6 | ④ | 축소 운영 두 층: ① 피처 Redis를 멈추면 trust-svc가… | ④ 그동안 추가 검증 제출은 통과로 처리되지 않는다 | ID만 | A | 시험: services/queue-svc/test/degraded-limits.test.ts, services/queue-svc/test/risk-http.test.ts 외 3곳 |
| B-T6 | ⑤ | 축소 운영 두 층: ① 피처 Redis를 멈추면 trust-svc가… | ⑤ 서킷이 열리고 닫힐 때 운영 사건 줄과 경보가 남는다(FR-039, NFR-001) | ID만 | A | 시험: services/queue-svc/test/degraded-limits.test.ts, services/queue-svc/test/risk-http.test.ts 외 3곳 |
| B-T7 | ① | ASN 분류표: ① 새 판을 S3에 두면 1시간 안에 두 서비스가… | ① 새 판을 S3에 두면 1시간 안에 두 서비스가 읽는다 | ID만 | A | 시험: packages/platform/test/asn-table.test.ts, services/queue-svc/test/degraded-limits.test.ts 외 1곳 |
| B-T7 | ② | ASN 분류표: ① 새 판을 S3에 두면 1시간 안에 두 서비스가… | ② S3를 막으면 마지막 판으로 판정하고 7일 [가정] 넘게 새 판이 없으면 SEV3 | 자동 시험 | A | 시험: packages/platform/test/asn-table.test.ts |
| B-T7 | ③ | ASN 분류표: ① 새 판을 S3에 두면 1시간 안에 두 서비스가… | ③ `CloudFront-Viewer-ASN`이 없는 요청은 그 밖으로 보고 IP 한도를 걸지 않는다 | 자동 시험 | A | 시험: packages/platform/test/asn-table.test.ts, services/queue-svc/test/degraded-limits.test.ts 외 1곳 |
| B-T8 | ① | 허니팟 경로: ① 로그인한 같은 출처 클릭은 `tr:hp:{pid}`가… | ①로그인한 같은 출처 클릭은 `tr:hp:{pid}`가 생기고 다음 사전 검증이 `CHALLENGE`(사유 범주 `INTERACTION`)다 | 빈칸 | A | — |
| B-T8 | ② | 허니팟 경로: ① 로그인한 같은 출처 클릭은 `tr:hp:{pid}`가… | ②로그인하지 않은 클릭은 지표만 오른다 | 빈칸 | A | — |
| B-T8 | ③ | 허니팟 경로: ① 로그인한 같은 출처 클릭은 `tr:hp:{pid}`가… | ③이미 판정을 통과해 기다리는 사람의 적중은 격리를 만들지 않는다 | 빈칸 | A | — |
| B-T8 | ④ | 허니팟 경로: ① 로그인한 같은 출처 클릭은 `tr:hp:{pid}`가… | ④ 24시간 [가정] 뒤 표시가 사라진다 | 빈칸 | A | — |
| B-T8 | ⑤ | 허니팟 경로: ① 로그인한 같은 출처 클릭은 `tr:hp:{pid}`가… | ⑤ 모든 경우 응답은 204·빈 본문이다(FR-049, NFR-020) | 빈칸 | A | — |
| B-T9 | ① | 차단 기기 목록 등재 조건: ① 추가 검증 실패, 허니팟 적중, 재평가… | ① 추가 검증 실패, 허니팟 적중, 재평가 후보만으로는 키가 생기지 않는다 | 빈칸 | A | — |
| B-T9 | ② | 차단 기기 목록 등재 조건: ① 추가 검증 실패, 허니팟 적중, 재평가… | ② 표본 검토 '봇' 판정과 부정구매 확인 라벨 반영으로만 키가 생기고 값에 확정 출처가 있다 | 빈칸 | A | — |
| B-T9 | ③ | 차단 기기 목록 등재 조건: ① 추가 검증 실패, 허니팟 적중, 재평가… | ③ 표본 검토 '사람' 재판정과 이의 인정은 키를 지운다 | 빈칸 | A | — |
| B-T10 | ① | 이의 제기 경로: ① 이의를 보내면 202이고 처리함에… | ①이의를 보내면 202이고 처리함에 `VERIFICATION_APPEAL` 건이 하나 생긴다(같은 요청을 다시 보내도 하나) | 빈칸 | A | — |
| B-T10 | ② | 이의 제기 경로: ① 이의를 보내면 202이고 처리함에… | ② 건 요청 발행을 실패시키면 503이고 다시 보내면 건이 생긴다 | 빈칸 | A | — |
| B-T10 | ③ | 이의 제기 경로: ① 이의를 보내면 202이고 처리함에… | ③ 인정하면 queue-svc `PASSED`와 trust-svc `LABELED_HUMAN`이 남고 근거에 차단 목록이 있었으면 키가 지워진다 | 빈칸 | A | — |
| B-T10 | ④ | 이의 제기 경로: ① 이의를 보내면 202이고 처리함에… | ④ 기각하면 대기 참여가 `BLOCKED`로 끝나고 trust-svc 라벨은 없다 | 빈칸 | A | — |
| B-T10 | ⑤ | 이의 제기 경로: ① 이의를 보내면 202이고 처리함에… | ⑤ 결과 반영 호출을 한 번 실패시키면 작업 워커가 다시 보내 한 번만 반영된다(FR-020, POL-006) | 빈칸 | A | — |
| B-T11 | — | 추가 검증 제출(`VERIFICATION`): 차단 목록에 있는… | 추가 검증 제출(`VERIFICATION`): 차단 목록에 있는 기기라도 심층 챌린지와 본인확인 재통과면 `PASSED`다. 심층 챌린지 토큰의… | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts |
| B-T12 | — | 재평가 격리 상한의 분모: 대기 인원 1만 명 회차에 10분 안 후보… | 재평가 격리 상한의 분모: 대기 인원 1만 명 회차에 10분 안 후보 80명을 적용 모드로 넣으면 50명(0.5%)까지 격리되고 나머지는 '상한 도달'로… | 빈칸 | A | — |
| B-T13 | — | 로비 입장의 행동 신호: 로비 입장 판정도 `BehaviorSignal`… | 로비 입장의 행동 신호: 로비 입장 판정도 `BehaviorSignal`(`features` 비움)을 내고, 한 기기 가명으로 로비 참가자 pid 6명이 10분… | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts, services/trust-svc/test/telemetry-recorder.test.ts |
| B-T14 | — | 판정 근거 키: `CHALLENGE` 판정과 재평가 격리에만… | 판정 근거 키: `CHALLENGE` 판정과 재평가 격리에만 `tr:vb`가 생기고 `ALLOW`에는 생기지 않는다. 30일 [가정] 뒤 사라지고, 사라진 뒤의… | 자동 시험 | A | 시험: services/trust-svc/test-int/score-risk.int.test.ts, services/trust-svc/test/score-risk.test.ts |
| B-T15 | — | 판정 근거 조회(`GetVerdictEvidence`, 추천 적용… | 판정 근거 조회(`GetVerdictEvidence`, 추천 적용 2026-10-30, §12): 이의 심사 화면이 판정 근거를 읽는다. ops-svc 밖의… | 빈칸 | A | — |
| B-T16 | ① | 기기 키 통일(추천 적용 2026-10-31, ADR-0171… | ①로그인(identity-svc `CreateSession`) | 자동 시험 | A | 시험: services/identity-svc/test/investigation.test.ts, services/trust-svc/test-int/main-key-info.int.test.ts 외 1곳 |
| B-T16 | ② | 기기 키 통일(추천 적용 2026-10-31, ADR-0171… | ②로비 입장 | ID만 | A | 시험: packages/platform/test/inv-ref.test.ts, services/identity-svc/test/investigation.test.ts 외 4곳 |
| B-T16 | ③ | 기기 키 통일(추천 적용 2026-10-31, ADR-0171… | ③ 사전 검증을 한다. identity `device.device_ref`, `BehaviorSignal.deviceRef`… | ID만 | A | 시험: packages/platform/test/inv-ref.test.ts, services/identity-svc/test/investigation.test.ts 외 4곳 |
| B-T17 | ① | 여정 ID(추천 적용 2026-10-31, §3.1·§4.1): ①… | ①로비 입장과 사전 검증 판정의 `TrustVerdict.journeyId`·`BehaviorSignal.journeyId`가 그 토큰의 `jny`와 같다 | ID만 | A | 시험: services/trust-svc/test-int/telemetry-kafka.int.test.ts, services/trust-svc/test/score-risk.test.ts 외 1곳 |
| B-T17 | ② | 여정 ID(추천 적용 2026-10-31, §3.1·§4.1): ①… | ② `journey_id`만 다르고 나머지가 같은 요청 둘의 판정·사유 범주가 같다(점수에 쓰지 않음) | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts |
| B-T17 | ③ | 여정 ID(추천 적용 2026-10-31, §3.1·§4.1): ①… | ③로그인·추가 검증 제출 판정은 `journey_id`가 비어도 판정한다 | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts |
| B-T17 | ④ | 여정 ID(추천 적용 2026-10-31, §3.1·§4.1): ①… | ④로비 입장의 `BehaviorSignal`은 screen `LOBBY`, 사전 검증은 `EVENT_DETAIL`이다. 연결: FR-072 | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts |
| B-T18 | ① | 끝단 신호(추천 적용 2026-10-31, §3.3): ① HTTPS로… | ① HTTPS로 대기열 API 배포를 지난 요청은 조사용 요청 기록에 `ja4`(36자)가 있다 | 빈칸 | A | — |
| B-T18 | ② | 끝단 신호(추천 적용 2026-10-31, §3.3): ① HTTPS로… | ② 헤더가 빠진 요청은 `ja4`가 비고 나머지 칸은 그대로다 | 빈칸 | A | — |
| B-T18 | ③ | 끝단 신호(추천 적용 2026-10-31, §3.3): ① HTTPS로… | ③ 대기열 경로 요청은 `edgeBotLabels`가 빈다(Bot Control 없음) | 빈칸 | A | — |
| B-T18 | ④ | 끝단 신호(추천 적용 2026-10-31, §3.3): ① HTTPS로… | ④ 원본 확인 헤더 없이 위조 `CloudFront-Viewer-JA4-Fingerprint`·`CloudFront-Viewer-ASN`·x-amzn-waf-b… | 빈칸 | A | — |
| B-T18 | ⑤ | 끝단 신호(추천 적용 2026-10-31, §3.3): ① HTTPS로… | ⑤ `ScoreRiskRequest`에 JA4·끝단 라벨 칸이 없고, WAF 토큰 지문 라벨은 어디에도 남지 않는다. 연결: FR-072 | 빈칸 | A | — |
| B-T19 | ① | 좌석·결제 행동 요약(추천 적용 2026-10-31, §4.1): ①… | ① 직접 선택 공연에서 구매 세션의 첫 홀드에 `behavior`를 실으면 purchase-svc가 screen `SEAT`인… | ID만 | A | 시험: apps/web/src/_pages/seats/model/booking-machine.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs 외… |
| B-T19 | ② | 좌석·결제 행동 요약(추천 적용 2026-10-31, §4.1): ①… | ② 결제 시도 시작의 `behavior`는 screen `PAYMENT` 한 건이다 | ID만 | A | 시험: apps/web/src/_pages/seats/model/booking-machine.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs 외… |
| B-T19 | ③ | 좌석·결제 행동 요약(추천 적용 2026-10-31, §4.1): ①… | ③ 좌석 자동 배정 공연의 홀드에는 `SEAT` 신호가 없다 | ID만 | A | 시험: apps/web/src/_pages/seats/model/booking-machine.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs 외… |
| B-T19 | ④ | 좌석·결제 행동 요약(추천 적용 2026-10-31, §4.1): ①… | ④ `SEAT`·`PAYMENT` 신호 1만 건을 넣어도 `trust.behavior_raw` 행 수와 재평가 후보 수가 늘지 않는다 | ID만 | A | 시험: apps/web/src/_pages/seats/model/booking-machine.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs 외… |
| B-T19 | ⑤ | 좌석·결제 행동 요약(추천 적용 2026-10-31, §4.1): ①… | ⑤ 홀드·결제 경로에서 trust-svc `ScoreRisk` 호출이 0건이다 | ID만 | A | 시험: apps/web/src/_pages/seats/model/booking-machine.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs 외… |
| B-T19 | ⑥ | 좌석·결제 행동 요약(추천 적용 2026-10-31, §4.1): ①… | ⑥ 요약 본문에 정해지지 않은 칸(좌표 배열 등)을 넣으면 400이다. 연결: FR-072, NFR-020 | ID만 | A | 시험: apps/web/src/_pages/seats/model/booking-machine.test.mjs, apps/web/src/features/behavior-summary/tracker.test.mjs 외… |
| B-T20 | ① | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ① `FRAUD_ACTIONED` BOT이면 `tr:block` 키가 생기고 값에 확정 출처와 건 ID가 있다 … 의 기기에… | 빈칸 | A | — |
| B-T20 | ② | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ② 외부 게시물 대조만 있는 계정은 `tr:block` 키가 생기지 않는다(라벨 출처가 아니다) | 빈칸 | A | — |
| B-T20 | ③ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ③의 기기에 `FRAUD_APPEAL_ACCEPTED` HUMAN을 보내면 키가 지워진다(`REMOVED`) | 빈칸 | A | — |
| B-T20 | ④ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ④ 판정 근거에 차단 목록이 있던 사람의 `FRAUD_APPEAL_ACCEPTED`도 키를 지운다 | 빈칸 | A | — |
| B-T20 | ⑤ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ⑤ `FRAUD_ACTIONED`에 HUMAN, `FRAUD_APPEAL_ACCEPTED`에 BOT이면 `INVALID_ARGUMENT`다 | 빈칸 | A | — |
| B-T20 | ⑥ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ⑥ 같은 건 ID·판을 다시 보내면 `changed` false다 | 빈칸 | A | — |
| B-T20 | ⑦ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ⑦ 두 출처 모두 `telemetry.trust-verdicts`에 사건이 0건이다 | 빈칸 | A | — |
| B-T20 | ⑧ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ⑧ 판정이 30일 지난 사람이면 요청의 `device_ref`로 키를 올리고, `device_ref`도 없으면 `DEVICE_NOT_FOUND`다 | 빈칸 | A | — |
| B-T20 | ⑨ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ⑨ 한 사건 ID로 계정 둘을 차례로 보내면 둘 다 반영된다 | 빈칸 | A | — |
| B-T20 | ⑩ | 부정 예매 조사에서 오는 라벨(추천 적용 2026-10-31, §9):… | ⑩ ops-svc 밖의 신원은 거부된다. 연결: FR-072·FR-073, POL-046 | 빈칸 | A | — |
| B-T21 | ① | 출시 첫 판의 행동 신호(추천 적용 2026-10-31… | ① 첫 온세일 설정 판에서 `BehaviorScore`의 적용 판 가중치가 0이고 그림자 판에서는 원래 가중치다 | 빈칸 | A | — |
| B-T21 | ② | 출시 첫 판의 행동 신호(추천 적용 2026-10-31… | ② 같은 합성 트래픽에서 `BehaviorScore`만 높은 세션은 적용 판 `ALLOW`, 그림자 판 `CHALLENGE`(`shadow` true)다 | 빈칸 | A | — |
| B-T21 | ③ | 출시 첫 판의 행동 신호(추천 적용 2026-10-31… | ③ 나머지 다섯 점수기와 확정 신호는 두 판에 같게 더해진다 | 빈칸 | A | — |
| B-T21 | ④ | 출시 첫 판의 행동 신호(추천 적용 2026-10-31… | ④ 분석의 봇 지표는 그림자 판정을 세지 않는다. 연결: FR-039, NFR-022 | 빈칸 | A | — |
| B-T22 | ① | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ① 서로 다른 pid를 세고 같은 pid는 한 번이다 | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts, services/trust-svc/test/instant-features.test.ts |
| B-T22 | ② | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ② 사람 확인이 실패·보류이거나 토큰이 없어도 넣는다(일부러 실패해 피하지 못한다). 사람 확인을 기다리지 않고 세고, 사람 확인 뒤에는 요청 경로의 Redis… | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts, services/trust-svc/test/instant-features.test.ts |
| B-T22 | ③ | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ③ 원소는 20개를 넘지 않고 상한 이상은 같게 본다. `sharedAt`이 20을 넘는 규칙 판은 읽지 않는다 | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts, services/trust-svc/test/rules.test.ts |
| B-T22 | ④ | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ④ 첫 원소 뒤 10분에 사라지고 뒤 원소가 수명을 늘리지 않으며, 만료 뒤에 넣으면 새 키가 다시 10분을 산다 | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts |
| B-T22 | ⑤ | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ⑤로그인·추가 검증 제출은 넣지 않는다. 추가 검증을 통과해도 공유 수는 그대로다 | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts |
| B-T22 | ⑥ | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ⑥ 키 읽기·쓰기가 실패하면 `degraded`가 참이고 판정은 이어진다 | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts, services/trust-svc/test/redis-feature-store.test.ts |
| B-T22 | ⑦ | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ⑦ 기기 식별값이 없으면 키가 없고 `degraded`가 아니다 | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts |
| B-T22 | ⑧ | 기기 공유 수(추천 적용 2026-11-09, ADR-0251): ①… | ⑧ Lua는 키 하나만 쓴다(슬롯을 넘지 않는다). 연결: FR-039, NFR-022, ASVS 2.4.1 | 자동 시험 | A | 시험: services/trust-svc/test/redis-feature-store.test.ts |
| B-T23 | ① | 호스팅·프록시 대역 진입 수(추천 적용 2026-11-09… | ① 호스팅·프록시 ASN만 10초 칸으로 세고 수가 늘면 사유 범주가 `RAPID_REQUESTS`다 | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts, services/trust-svc/test/instant-features.test.ts |
| B-T23 | ② | 호스팅·프록시 대역 진입 수(추천 적용 2026-11-09… | ② 통신사 대역과 분류표에 없는 ASN은 키가 없다 | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts, services/trust-svc/test/redis-feature-store.test.ts |
| B-T23 | ③ | 호스팅·프록시 대역 진입 수(추천 적용 2026-11-09… | ③ 칸이 바뀌면 다시 센다 | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts, services/trust-svc/test/instant-features.test.ts |
| B-T23 | ④ | 호스팅·프록시 대역 진입 수(추천 적용 2026-11-09… | ④ 키의 수명은 30초 [가정]이다 | 자동 시험 | A | 시험: services/trust-svc/test-int/instant-features.int.test.ts |
| B-T23 | ⑤ | 호스팅·프록시 대역 진입 수(추천 적용 2026-11-09… | ⑤ 실패하면 `degraded`가 참이다 | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts, services/trust-svc/test/redis-feature-store.test.ts |
| B-T23 | ⑥ | 호스팅·프록시 대역 진입 수(추천 적용 2026-11-09… | ⑥로그인은 세지 않는다. 연결: FR-039, ASVS 2.4.1 | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts |
| B-T24 | ① | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ① 값마다 KMS를 부르지 않는다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts |
| B-T24 | ② | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ② 첫 받기가 실패하면 칸을 비우고 `refMissing` 참·`degraded` 참이며 지표가 오른다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts, services/trust-svc/test-int/device-key.int.test.ts 외 2곳 |
| B-T24 | ③ | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ③ 다시 받기가 실패해도 받은 지 10분까지는 옛 키를 쓴다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts |
| B-T24 | ④ | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ④ 10분이 지나면 칸을 비운다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts |
| B-T24 | ⑤ | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ⑤ 다시 받으면 돌아온다. 받지 못한 라벨만 15·30·60초 [가정]에 흔들림을 더해 다시 받는다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts |
| B-T24 | ⑥ | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ⑥ 라벨 키 값은 로그·직렬화에 나오지 않는다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts |
| B-T24 | ⑦ | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ⑦ 값 라벨 키는 local·ci·demo에서만 받는다 | 자동 시험 | A | 시험: packages/platform/test/inv-ref.test.ts, services/trust-svc/test/device-refs.test.ts |
| B-T24 | ⑧ | 기기 라벨 키(추천 적용 2026-11-09, ADR-0251): ①… | ⑧ 운영에 키 설정이 없으면 시작은 하고 `NO_KEY`로 센다. 연결: NFR-022, ASVS 16.3.4 | ID만 | A | 시험: packages/platform/test/inv-ref.test.ts, services/trust-svc/test-int/device-key.int.test.ts 외 3곳 |
| B-T25 | — | 로그인 판정의 근거(추천 적용 2026-11-09, ADR-0251):… | 로그인 판정의 근거(추천 적용 2026-11-09, ADR-0251): 이력이 없는 새 기기의 로그인은 통신사 대역 ASN이 있어도, 호스팅 대역의 위험이 기준… | 자동 시험 | A | 시험: services/trust-svc/test/instant-features.test.ts |

## docs/security/asvs/bot-defense.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | 빈칸 | A | 영역: services/trust-svc |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | 자동 시험 | A | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/consumers.int.test.ts 외 29곳 |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | 자동 시험 | A | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-store.int.test.ts, services/purchase-svc/test-int/seat-store.int.test.ts 외 6곳 |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/consumers.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 24곳 |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | 자동 시험 | A | 시험: services/admission-ctrl/test/admission-leader.test.ts, services/admission-ctrl/test/aimd.test.ts 외 9곳 |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | 자동 시험 | A | 시험: services/identity-svc/test/login-verdict.test.ts, services/identity-svc/test/trust-login-risk.test.ts 외 6곳 |
| v5.0.0-2.4.2 | — | L3 | 비즈니스 업무 로직 흐름이 물리적 인간의 현실적인 동작 타이밍을 요구하도록 설계하여 비정상적으로 빠른 기계적 제출을 방어한다. | 빈칸 | A | 영역: services/trust-svc |
| v5.0.0-6.1.1 | — | L1 | 레이트 리밋·자동화 방지·적응형 대응 같은 통제가 크리덴셜 스터핑과 비밀번호 무차별 대입을 어떻게 막는지 문서에 정한다. 통제를 어떻게 설정하는지와 악의적 계정… | ID만 | A | 다른 곳 시험: services/identity-svc/test/admin-login.test.ts (영역: services/trust-svc) |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | 자동 시험 | A | 시험: services/queue-svc/test/sale-state.test.ts, services/queue-svc/test/shuffle-proof.test.ts |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | A | 시험: apps/web/src/_pages/shuffle-proof/model/proof-view.test.mjs |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | 자동 시험 | A | 시험: services/queue-svc/test/edge-entry-function.test.ts, services/queue-svc/test/edge-first-visit-function.test.ts |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | A | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: services/trust-svc) |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | 자동 시험 | A | 시험: services/queue-svc/test/edge-first-visit-function.test.ts |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | 자동 시험 | A | 시험: services/queue-svc/test/edge-first-visit-function.test.ts, services/queue-svc/test/first-visit-cookie.test.ts |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | A | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | A | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: services/trust-svc) |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | A | 시험: apps/web/server/csp-hash-server.test.mjs, apps/web/src/_app/security/page-headers.test.mjs 외 1곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | A | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | A | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/web) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | A | 시험: apps/web/src/_app/security/page-headers.test.mjs |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | A | 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | 자동 시험 | A | 시험: services/queue-svc/test/admission.test.ts, services/queue-svc/test/http.test.ts 외 1곳 |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | 자동 시험 | A | 시험: services/trust-svc/test/honeypot.test.ts |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | A | 영역: services/trust-svc |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | ID만 | A | 다른 곳 시험: apps/web/src/features/identity-verify/flow.test.mjs (영역: services/trust-svc) |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | A | 영역: services/trust-svc |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | ID만 | A | 다른 곳 시험: apps/web/src/_pages/login/model/state.test.mjs, apps/web/src/features/identity-verify/flow.test.mjs 외 5곳 (영역:… |
| v5.0.0-3.6.1 | — | L3 | 외부에 둔 클라이언트 자산은 정적이고 버전이 붙은 자원을 SRI로 검증할 때만 쓰고, 안 되면 자원마다 보안 결정으로 문서에 남긴다. | 빈칸 | A | 영역: services/trust-svc |
| v5.0.0-5.2.3 | — | L2 | 압축 파일은 풀기 전에 풀린 크기와 파일 수 상한을 확인한다. | 자동 시험 | A | 시험: tools/perf-ledger/human-data.test.mjs |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | 빈칸 | A | 영역: services/ops-svc |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | 자동 시험 | A | 시험: services/trust-svc/test/score-risk.test.ts |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | 자동 시험 | A | 시험: services/queue-svc/test/trust-risk.test.ts, services/trust-svc/test-int/device-key.int.test.ts 외 5곳 |
