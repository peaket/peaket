# ADR-0259: 추가 검증 제출은 본인확인 재통과를 먼저 묻고, 이의 접수는 대기열 Redis에 처음 것만 둔 뒤 2초 안에 건 요청을 내며, 보안 검사 게이트는 외부 도구 없이 되는 몫부터 만든다

- **상태**: 채택(2026-11-10, 추천 적용). BUILD_ORDER BOT-090·BAS-010(나눈 단계 BAS-011), 기능 묶음 BAT-200·BAT-202(ADR-0256), wbs 3.3.1·0.1.4.
- **관련**: FR-020, POL-006, POL-041, ADR-0023, ADR-0065, ADR-0079 결정 4, ADR-0156 결정 8·14, ADR-0183, ADR-0211, ADR-0233, ADR-0253, ADR-0256, ADR-0258, [docs/features/bot-defense.md](../features/bot-defense.md) §5.2·§12·§15·§17, [docs/features/queue-admission.md](../features/queue-admission.md) §6·§9 Q-T34, [docs/features/identity.md](../features/identity.md) §5 '로컬 게이트웨이 대역'·I-T56, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/queues/{eventId}/verification`, [docs/api/guidelines.md](../api/guidelines.md) §5·§8·§8.1, [docs/data.md](../data.md) §3·§5, [docs/verification.md](../verification.md) §2·§4.1, [docs/devops.md](../devops.md) §3.1·§4.4, [docs/security/asvs/delivery.md](../security/asvs/delivery.md), [docs/security/asvs/bot-defense.md](../security/asvs/bot-defense.md), [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §5.8·§5.9, [docs/frontend.md](../frontend.md) §3.12·§5.14.1
- **관련 ID**: B-T6, B-T10, B-T11, B-T15, Q-T34, I-T56, V-T31, ASVS v5.0.0-2.2.1, 2.3.2, 3.2.2, 3.5.5, 3.7.2, 13.3.1, 15.1.1, 15.3.1, 15.3.6, 16.5.3

## 맥락

- 용어: 추가 검증은 봇으로 의심되어 격리된 사람이 심층 사람 확인과 휴대폰 본인확인을 다시 해 원래 순번을 되찾는 절차다(SCR-009). 이의 제기는 그 판정에 설명이나 재검토를 요청하는 것이고, CS 처리함에 건으로 간다. 보안 검사 게이트는 PR마다 비밀 노출·위험한 코드 꼴·취약한 의존성을 찾아 막는 CI 잡이다.
- 정본은 제출 경로를 200·202·503만 적었다. 200 본문 모양, 400·403·404·409·410·429, 202 본문, 새로고침 뒤 화면이 상태를 되살릴 읽기, 본문의 기기 식별값이 없었다. 사람 확인 토큰은 300초 한 번 쓰기인데 화면 차례가 사람 확인 → 본인확인이라, 서버가 둘을 어떤 차례로 보는지 정하지 않으면 본인확인이 길 때 토큰을 헛되이 태운다.
- 이의 접수는 queue-svc가 DB 없이 대기열 Redis에 두고 거래·제어 Kafka 클러스터로 바로 건 요청을 내는 길로 정해져 있었다(2026-10-30). 그 발행을 요청이 몇 초까지 기다리는지, 처리함 건 ID에서 이의 ID를 찾는 자리, 한 대기 참여의 제출 횟수 한도가 없었다. 기각과 다른 빠진 번호가 같은 410이라 화면이 '기각' 문구를 고르지 못했다.
- B-T10·B-T15·I-T56의 세부 몇 개(처리함 건 생성, 작업 워커 재전송, 부르는 신원 제한)는 아직 없는 ops-svc(GAT-280)와 메시 L7 허용 목록(HOT-400)의 몫인데 queue-svc 몫과 같은 세부에 섞여 있었다. Q-T34에는 정본 규칙(1인 1순번 위반 때 통과 칸 지우기, queue-admission §7)의 시험 세부가 없었다.
- BAS-010(wbs 0.1.4)은 gitleaks·Semgrep·CodeQL·Scorecard·Trivy를 쓰라고 적었지만 저장소에는 그 도구가 하나도 없고, 받으려면 소유자 허락이 든다(새 서드파티 액션, 바이너리 받기). 같은 단계의 규칙 몇 개(HTML 넣기 금지, 서비스 외부 호출 금지, 조치 기한 판정)는 도구 없이 된다. 응답 스키마가 없는 처리기를 막는 린트(ASVS 15.3.1)를 지금 걸면 처리기 약 85개 [추정]를 한꺼번에 고쳐야 한다.

## 결정

1. **제출은 본인확인 재통과를 먼저 묻는다.** queue-svc는 identity-svc `CheckReverification`을 먼저 부르고, 재통과가 있을 때만 trust-svc `ScoreRisk(VERIFICATION)`로 사람 확인 토큰을 검증한다. 재통과가 없으면 trust-svc를 부르지 않고 200 `REVERIFY_REQUIRED`다. 화면은 본인확인을 마친 뒤 제출하고, 위젯 토큰을 받은 지 240초 [가정]가 넘었으면 위젯을 다시 돌린다(사전 검증 토큰 갱신과 같은 방식, ADR-0211). 둘 가운데 하나라도 답이 없으면 통과로 보지 않고 503이다(2026-10-30 규칙 그대로).
2. **제출 응답과 본문.** 200 `result`는 `PASSED`·`CHALLENGE_FAILED`·`REVERIFY_REQUIRED`·`PERSON_MISMATCH`이고, `PASSED`면 원래 번호와 차례가 지났을 때의 유예 마감 `graceUntil`을 싣는다. 이미 통과했으면 같은 200 `PASSED`를 다시 준다. 본문은 `challengeToken`과 `appeal` 가운데 정확히 하나만 받고, 기기 식별값 `deviceId`(선택, 로비 입장·사전 검증과 같은 모양)를 받아 trust-svc가 기기 이력과 차단 목록을 본다. 오류는 400(본문 형식, about:blank), 403 `identity-verification-required`, 404 `queue-entry-not-found`(새 이름), 409 `not-verifying`(새 이름), 410 `sale-ended`·`queue-ticket-removed`, 429 `verification-submit-limited`(새 이름), 503이다. 대기 참여는 본문이 아니라 그 계정의 `q:dup`이 가리키는 대기표로 찾는다(대기 취소와 같은 길, ADR-0233).
3. **이의 접수와 상태 읽기.** 202 본문은 `{appealId, receivedAt}`이고 이미 접수했으면 처음 값이다. 새 읽기 `GET /v1/queues/{eventId}/verification`이 `state`(`VERIFYING`·`PASSED`·`BLOCKED`), 사유 범주, 이의 접수 여부·시각을 주어 화면이 새로고침 뒤 되살린다. '검토 중' 배지는 ops-svc가 생기는 GAT-280 전까지 '접수됨'으로만 보인다.
4. **기각은 같은 410에 확장 칸을 싣는다.** 이의 기각(`BLOCKED`)으로 끝난 대기표의 입장 확정과 제출은 410 `queue-ticket-removed`에 `removeReason: "BLOCKED"`를 싣는다(asyncapi 대기 기록의 `removeReason`과 같은 이름). 새 type은 만들지 않는다. 화면이 문구만 고르면 되고, 어떤 대기표가 왜 빠졌는지 다른 경우를 더 드러내지 않는다.
5. **건 ID 색인과 제출 횟수 한도.** 처리함 건 ID에서 이의 ID를 찾는 `q:appealcase:{caseId}`(값 = 이의 ID, `q:appeal`과 같은 수명)를 첫 결과 반영 때 `SET NX`로 쓴다. 판 번호와 반영한 결과는 `q:appeal`에 둔다. 한 대기 참여의 `challengeToken` 제출은 사람 슬롯 카운터 `q:vsub:{pid}:E`로 10분에 5회 [가정]까지이고, 넘으면 429와 `Retry-After`다. 게이트웨이 한도(HOT-400)와 따로 센다.
6. **건 요청 발행은 2초까지 기다린다.** 요청 경로는 발행 확인을 2초 [가정]까지만 기다리고, 넘으면 503 `Retry-After`다. 늦게 전달된 사건은 같은 `eventKey`라 ops-svc가 중복을 지운다. 이의 글을 먼저 `HSETNX`로 두므로 다시 보내도 같은 `eventKey`로 나간다. 이 호출의 무게는 2등급(판단·보조)이고, 멈추면 새 이의 접수만 503이다(guidelines §8.1).
7. **시험 세부를 몫대로 나눈다.** B-T10은 ①~⑤가 queue-svc·trust-svc 몫(건 요청 한 건, 발행 실패 503, 인정·기각, 건 ID·판 멱등), ⑥이 ops-svc 몫(처리함 건, 작업 워커 재전송, GAT-280)이다. B-T15는 ① 응답 칸·`found` false, ② 부르는 신원 제한(HOT-400)으로, I-T56은 ⑤ 부르는 신원 제한(HOT-400)을 ④에서 뗀다. Q-T34에 ⑧ '통과한 대기표가 1인 1순번을 어기면 `verify` 칸을 지우고 다음 입장 확정은 410'을 더한다.
8. **로컬 연결과 성능 비교.** 로컬 게이트웨이 대역은 대기열 주소(`queueUrl`)를 받으면 `/v1/queues/` 경로를 신원 머리와 함께 queue-svc로 넘긴다(local·ci 전용). 성능 비교 도구 `loadtest/micro/lua-compare.mjs`는 대기열 Lua(`PRECHECK_LUA`, 통과 Lua)도 골라 견준다. 추가 검증 격리·통과는 규칙 모델(`specs/queue.qnt`)에 넣지 않고 Q-T34가 실제 Valkey로 맡는다. 바뀌는 것이 회차 슬롯 확인의 읽기 분기 하나이기 때문이다.
9. **남는 한계로 둔다.** 판정 근거 키 `tr:vb`는 회차의 첫 `CHALLENGE`만 남기므로, 뒤에 차단 목록으로 다시 걸린 사람의 이의 인정은 차단 키를 지우지 못한다. 고치려면 trust-svc 빠른 경로 Lua가 바뀌어 이 단계의 범위를 넘는다.
10. **BAS-010을 둘로 나눈다(감독 결정).** BAS-010 ①은 외부 도구 없이 되는 몫이다: `packages/config/eslint`의 화면 보안 규칙(ESLint 기본 규칙 선택자로 `dangerouslySetInnerHTML`, `innerHTML`·`outerHTML` 대입, `insertAdjacentHTML`·`document.write` 호출, 창 메시지 수신기를 막는다. 창 메시지 규칙은 뿌리 `eslint.config.mjs`에서 옮긴다), 서비스 외부 호출 규칙(V-T31 ③, ASVS 15.3.2), 취약점 조치 기한·예외 만료 판정 도구(`tools/ci/vuln-deadline.mjs`, 예외 파일은 `tools/ci` 아래의 `vuln-exceptions.json`), pnpm 내장 의존성·라이선스 검사, `security-scan.yml`. PR은 유효한 예외가 없는 치명·높음을 막고 중간 이하는 알림만 남긴다. 검사 결과를 읽지 못하면 막는다. 외부 도구(gitleaks·Semgrep·CodeQL·Scorecard·Trivy)는 새 단계 BAS-011 ②(묶음 BAT-202)가 소유자 허락(PROGRESS OPEN[31]) 뒤 더한다. ASVS 13.3.1·15.3.6이 BAT-202의 장부 범위로 간다. 15.3.1은 결정 11대로 기준선과 함께 이 묶음(BAT-200)에 두고 '부분 적용'으로 판정한다(BUILD_ORDER와 같다, 2026-11-10 리뷰 뒤 바로잡음).
11. **응답 스키마 린트는 기준선부터 건다.** BAS-010 ①이 규칙과 표시 장식자를 만들고, 지금 있는 처리기는 기준선 목록에 두어 새 처리기만 막는다. 기준선 처리기에 응답 스키마를 다는 일은 서비스마다 따로 둘 채우기 단계가 한다. 그동안 ASVS 15.3.1은 '부분 적용'이다.
12. **리뷰 뒤 더한 것(2026-11-10).** 묶음 리뷰에서 나온 빈틈을 같은 묶음 안에서 정본에 더했다.
    - 제출 503이면 화면은 받았던 사람 확인 토큰을 버리고 위젯을 다시 돌린 새 토큰으로만 다시 보낸다(쓴 토큰을 다시 보내면 Turnstile이 중복으로 거절해 실패가 기록된다). 자동 다시 보내기는 3번 [가정]까지이고 그 뒤에는 '다시 시도' 버튼이다. 제출 횟수 한도(결정 5)는 trust-svc 검증을 실제로 부를 때만 센다: 재통과 확인이 통과한 뒤 `ScoreRisk(VERIFICATION)` 바로 앞에서 세고, trust-svc가 응답하지 않아 부르지 못한 503과 사람 확인 서버 검증이 보류된 503(Turnstile 장애)은 되돌린다(bot-defense §5.2, openapi, d5 §5.9, frontend 호출 표).
    - 상태 읽기(결정 3)에 `passedVia`(`CHALLENGE`·`APPEAL`), `graceUntil`(차례와 통과 가운데 늦은 때 + 유예), `appeal.text`(본인이 보낸 글)를 더한다. 대기 참여는 있는데 추가 검증 칸이 없으면 제출과 같은 409 `not-verifying`이고, 404는 이 회차에 대기 참여가 없을 때만이다. 새로고침 뒤 화면은 이 탭의 본인확인 기억에 기대지 않고 바로 제출해 보며, `REVERIFY_REQUIRED`면 본인확인 창을 연다. 이미 통과한 참여에 다시 보낸 제출의 `graceUntil`도 같은 계산이다. 대기실 저장값 `turnAtMs`는 통과 시각 쪽으로 옮겨 쓰고, 입장 확정의 410 `removeReason: BLOCKED`면 대기실이 추가 검증 화면으로 옮겨 기각 문구를 보인다(d5 §5.8, frontend §3.12).
    - 이의 글에 NUL·양방향 제어 글자(U+202A~U+202E, U+2066~U+2069)·0폭 글자(U+200B~U+200D, U+FEFF)가 있으면 400이다(ASVS 2.2.1).
    - 이의 건 요청 발행(결정 6): 2초에 503으로 끝난 요청의 발행이 늦게 성공해도 보낸 표시를 남긴다. 같은 이의의 발행이 진행 중이면 파드 안에서 하나로 묶어 그 결과를 기다린다. 생산자 보내기가 잇달아 3번 [가정] 실패하면 그 생산자를 버리고 새로 만든다(bot-defense §12, guidelines §5).
    - B-T10에 ⑦ 'ops-svc 밖의 신원이 `VerificationAppealService`를 부르면 거부된다'(HOT-400 몫)를 더하고, queue.proto에 같은 이의에 다른 건 ID가 와도 `ALREADY_EXISTS`라고 적는다(결정 7).
    - 본인확인기관 창을 여는 화면(추가 검증 SCR-009 포함)은 CSP 변형 `identityForm`을 실제로 싣는다(frontend §5.14.1).
    - 보안 린트(결정 10·11)의 구현 위치는 Semgrep이 아니라 `packages/config/eslint`에 직접 만든 규칙(`peaket-web/no-html-injection`·`peaket-web/no-window-message`·`peaket-service/no-direct-outbound-http`·`peaket-service/route-response-schema`)이다. 보안 규칙을 줄 안 주석으로 끄면 CI 검사(`tools/ci`)가 막고, 응답 스키마 기준선은 지금 줄 수보다 늘지 않게 시험이 막으며, pnpm `auditConfig` 무시 설정은 판정 도구가 막는다(devops §4.4, asvs/delivery 3.2.2·3.5.5·15.3.1·15.3.2).

## 검토한 다른 안

- **사람 확인을 먼저 검증하기**: 화면 차례와 같아 단순하지만, 본인확인이 늦으면 한 번 쓰기 토큰이 낡거나 이미 태워져 사람이 위젯을 두 번 풀어야 한다. 재통과가 없을 때 trust-svc를 부르지 않으면 trust-svc 부하도 줄어 본인확인을 먼저 묻는다.
- **기각에 새 오류 이름(`verification-blocked`)**: 화면 문구는 고르기 쉽지만, 입장 확정 410의 type이 하나 늘어 대기실 셸과 계약 깨짐 검사가 함께 바뀐다. 확장 칸 하나로 같은 일을 한다.
- **건 요청을 생산자 기본 상한까지 기다리기**: 끊김 없이 한 번에 나갈 확률은 높지만, Kafka가 느리면 이의 요청 하나가 수십 초 묶인다. 이의 글이 Redis에 먼저 있으므로 짧게 끊고 다시 보내게 하는 쪽이 사람에게 낫다.
- **결과 반영을 한 Lua로 묶기**: 사람 키와 회차 키는 슬롯이 달라 묶지 못한다(queue-admission §6 '순서'). 회차 쓰기를 먼저 하고 판 번호를 뒤에 올려 다시 보낸 호출이 같은 결과를 내게 했다.
- **BAS-010을 나누지 않고 허락을 기다리기**: 도구 없이 되는 규칙까지 늦어진다. 묶음 안 한 단계만 막혔으면 나눈다는 턴 규칙을 따랐다.
- **응답 스키마를 이번에 모두 채우기**: 처리기 약 85개 [추정]를 바꾸면 이 묶음 범위가 서비스 전체로 넓어지고 리뷰가 어렵다. 기준선으로 새 처리기만 막고 서비스마다 나눈다.
- **Semgrep으로 화면 규칙 두기**: 받기 허락이 든다. JS·TS 규칙은 ESLint 기본 규칙으로 같은 것을 막을 수 있다(ADR-0253 선례). 프로토타입 오염·`sql.raw()` 허용 목록은 ESLint로는 약해 BAS-011로 남긴다.

## 결과

- 제출·이의·상태 읽기가 계약에 올라 화면과 서버가 같은 모양을 쓴다. 새 오류 이름 셋이 `x-peaket-problem-types`에 더해졌다. 대기열 Redis 키 둘(`q:appealcase`·`q:vsub`)과 queue-svc의 첫 Kafka 생산자가 생긴다(docs/verification.md §4.1, 한도 안).
- 이의 접수 발행이 2초를 넘으면 사람이 한 번 더 보낸다. 늦게 도착한 첫 사건과 둘째 사건은 같은 `eventKey`라 건이 하나다.
- 비밀 탐지·정적 분석·이미지 검사는 소유자 허락 전까지 CI에 없다. 그동안 BOT-161(보안 게이트 판정 검토)이 볼 것도 그만큼 적다.
- ASVS 15.3.1은 채우기 단계가 끝날 때까지 '부분 적용'이다.

## 되돌릴 조건

- 이의 접수 503이 운영에서 자주 나면(§15 `publish_failed` 경보) 2초 상한을 다시 보거나 queue-svc 보내지 못한 건 보류(대기열 Redis Stream)를 더하는 안을 본다.
- 제출 횟수 한도 429가 사람에게 자주 걸리면(제출의 1% [가정] 넘음) 한도를 다시 정한다.
- 소유자가 외부 도구를 받지 않기로 하면 BAS-011을 없애고 ASVS 13.3.1·15.3.6의 판정을 바꾼다.
