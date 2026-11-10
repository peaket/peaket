# 완성 장부: security

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/security/auth-controls.md`, `docs/security/authz-matrix.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 17 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 34 | 57 |
| 합계 | 17 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 34 | 57 |

## docs/security/auth-controls.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-T1 | — | 한 출발지가 여러 계정에 한 번씩: 한 IP에서 서로 다른 이메일… | 여섯 번째 시도부터 사람 확인이 나온다. 다섯 계정 모두 잠기지 않는다. 출발지 경보가 1시간 뒤 풀린다 | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-login.int.test.ts, services/identity-svc/test/admin-login-http.test.ts 외 1곳 |
| AC-T2 | — | 없는 이메일: 없는 이메일로 다섯 번 틀린다. 같은 횟수를 있는… | 상태 코드, 본문, 남은 시도, 잠금 문구가 두 경우 모두 같다. 없는 이메일에는 메일이 나가지 않는다. 두 경우의 응답 시간 중앙값 차이를 기록한다(KMS… | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-login.int.test.ts, services/identity-svc/test/admin-login.test.ts |
| AC-T3 | — | 비밀번호 연속 실패 누계: 시험 시계로 시간 잠금을 넘기며 로그인 성공… | 50번째에 계정 주인 알림과 SEV3 경보가 나온다. 100번째에 보호 잠금이 걸리고 해제 링크가 나가지 않으며, 재초대로만 풀린다. 99번 뒤 로그인에… | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts |
| AC-T4 | — | 비밀번호만 맞은 로그인: 지난 30일 성공 기록이 없는 출발지에서 맞는… | 새 출발지는 10분 뒤 계정 주인에게 알림이 가고, 다음 로그인 세션은 비밀번호 바꾸기와 로그아웃만 된다(다른 경로는 403). 바꾼 뒤 다른 세션이 모두… | 자동 시험 | B | 시험: packages/platform/test/auth-guard.test.ts, services/identity-svc/test-int/admin-password-change.int.test.ts 외 2곳 |
| AC-T5 | ① | 해제 링크: ① 링크에서 인증 앱 코드를 맞게 넣는다 ② 링크에서… | ①은 시간 잠금만 풀리고 묶음 잠금은 남는다(I-T11 ③과 같다) | ID만 | B | 시험: services/identity-svc/test/admin-login-http.test.ts, services/identity-svc/test/admin-unlock.test.ts |
| AC-T5 | ② | 해제 링크: ① 링크에서 인증 앱 코드를 맞게 넣는다 ② 링크에서… | ②는 그 링크가 무효가 된다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| AC-T5 | ③ | 해제 링크: ① 링크에서 인증 앱 코드를 맞게 넣는다 ② 링크에서… | ③는 거절된다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| AC-T5 | ④ | 해제 링크: ① 링크에서 인증 앱 코드를 맞게 넣는다 ② 링크에서… | ④는 거절된다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| AC-T5 | ⑤ | 해제 링크: ① 링크에서 인증 앱 코드를 맞게 넣는다 ② 링크에서… | ⑤는 거절되고 메일이 나가지 않는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| AC-T5 | ⑥ | 해제 링크: ① 링크에서 인증 앱 코드를 맞게 넣는다 ② 링크에서… | ⑥은 보호 잠금이 걸린다. 주소창·접근 로그·`Referer`에 링크 토큰이 0건이다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| AC-T6 | — | 금칙어 대조: §4.3 6의 예 아홉 개를 파트너 상호 '해오름엔터'… | 표의 판정과 같다. 막은 것은 이유 종류가 표와 같고 안내 문구가 함께 나온다. 받은 것은 같은 원문으로 로그인된다(대조 사본이 아니라 원문을 NFC로 맞춘… | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| AC-T7 | ① | 유출 목록: 시험 HIBP 서버로 ① 목록에 있는 비밀번호를 정한다 ②… | ①은 거절된다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| AC-T7 | ② | 유출 목록: 시험 HIBP 서버로 ① 목록에 있는 비밀번호를 정한다 ②… | ②는 503과 `Retry-After`이고 비밀번호가 저장되지 않는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| AC-T7 | ③ | 유출 목록: 시험 HIBP 서버로 ① 목록에 있는 비밀번호를 정한다 ②… | ③은 로그인되고 다음 로그인에 다시 본다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts, services/identity-svc/test/outbound-trace.test.ts |
| AC-T7 | ④ | 유출 목록: 시험 HIBP 서버로 ① 목록에 있는 비밀번호를 정한다 ②… | ④는 §3.5대로 비밀번호를 바꾸게 한다. 모든 요청에 `Add-Padding: true`가 있고, 로그·트레이스에 SHA-1과 그 앞 5자가 0건이다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts, services/identity-svc/test/admin-password-change.test.ts |
| AC-T8 | — | 웹 ACL 속도 규칙(운영 설계만): Terraform 정책 시험으로… | 규칙이 없거나 값이 §5와 다르면 실패한다. 결과는 '설계 검사'로 적는다(docs/architecture.md §8.2 4) | 빈칸 | B | — |
| AC-T9 | — | 전체 실패율: 시험 환경에서 5분에 관리 계정 로그인 실패 120건을… | SEV3 보안 경보가 나고, 그 뒤 1시간 동안 모든 관리 계정 로그인에 사람 확인이 나온다. 1시간 뒤 풀린다 | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-login.int.test.ts, services/identity-svc/test/admin-login.test.ts |
| AC-T10 | — | 설정 범위 검사: §5 값을 범위 밖으로 바꿔(잠금 기준 20, 누계… | 셋 모두 시작에 실패하고 어느 설정이 범위를 벗어났는지 로그에 남는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |

## docs/security/authz-matrix.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| AZ-T1 | ① | 기본 거부: ① 허용 규칙이 없는 시험용 경로를 각 게이트웨이에 더한다… | ①은 그 경로가 막힌다 | ID만 | B | 시험: packages/platform/test/auth-guard.test.ts |
| AZ-T1 | ② | 기본 거부: ① 허용 규칙이 없는 시험용 경로를 각 게이트웨이에 더한다… | ②는 서비스가 시작하지 않는다 | ID만 | B | 시험: packages/platform/test/auth-guard.test.ts |
| AZ-T1 | ③ | 기본 거부: ① 허용 규칙이 없는 시험용 경로를 각 게이트웨이에 더한다… | ③는 doc-check `roles` 오류다(§5.5) | ID만 | B | 시험: packages/platform/test/auth-guard.test.ts |
| AZ-T1 | ④ | 기본 거부: ① 허용 규칙이 없는 시험용 경로를 각 게이트웨이에 더한다… | ④는 doc-check `roles` 오류다(§5.5) | ID만 | B | 시험: packages/platform/test/auth-guard.test.ts |
| AZ-T1 | ⑤ | 기본 거부: ① 허용 규칙이 없는 시험용 경로를 각 게이트웨이에 더한다… | ⑤는 doc-check `roles` 오류다(§5.5) | ID만 | B | 시험: packages/platform/test/auth-guard.test.ts |
| AZ-T2 | — | 테넌트를 넘는 읽기: A의 관리자·실무자 토큰으로 B의… | ID 조회는 모두 404이고 없는 ID와 본문이 같다. 목록에 B의 행이 0건이다. 거절이 보안 이벤트로 남는다 | 빈칸 | B | — |
| AZ-T3 | — | 테넌트를 넘는 쓰기: 같은 B의 ID로 고치기·지우기·회차 취소… | 모두 404이고 B의 데이터와 감사 기록에 변화가 0건이다 | 빈칸 | B | — |
| AZ-T4 | — | 테넌트 값 꾸미기: A의 토큰에 본문·쿼리의 `promoterId`=B를… | 게이트웨이가 바깥 헤더를 지운다. 역할과 테넌트는 서비스가 요청마다 identity에서 받은 값만 쓴다(ADR-0172). 본문의 테넌트 칸은 400이다. 모든… | 빈칸 | B | — |
| AZ-T5 | — | DB 깊이 방어: 시험용으로 테넌트 조건을 뺀 조회를 파트너 전용 DB… | 첫째는 A의 행만, 둘째는 0건이다. 팬·관제 사용자와 일괄 작업 사용자는 정책대로 본다. 앱 사용자가 표 소유자가 아니고 `BYPASSRLS`가 없다 | 자동 시험 | B | 시험: services/core-svc/test-int/rls.int.test.ts |
| AZ-T6 | — | 본인 데이터: 팬 A로 팬 B의 주문·티켓·양도 요청·문의·본인확인… | 비공개 자원은 404, 후기 고치기는 403이다. 대표 계정에는 흡수 계정 주문이 보인다 | 빈칸 | B | — |
| AZ-T7 | — | 상태·시간: 판매 승인 전 공연을 다른 파트너와 팬이 조회한다. 입장… | 승인 전 공연은 404, 입장 시작 뒤는 409 `ENTRY_STARTED`, 본문의 시각은 무시되고 서버 시각으로 판정한다 | 빈칸 | B | — |
| AZ-T8 | — | 칸: 역할마다 같은 자원을 읽어 §4.1 표와 맞춘다(CS의 팬 조회에… | 표에서 '보이지 않는다'인 칸이 응답에 0건이다. 사유 없는 원문 요청은 거절되고, 사유를 넣은 원문 열람은 접속기록에 남는다. 서버 칸은 400이다 | 빈칸 | B | — |
| AZ-T9 | — | 권한 변경 반영: commander의 역할을 operator로 바꾸고… | 수 초 안에 그 계정의 모든 세션이 401로 거절된다. 그 사이에 받은 재인증 토큰 요청은 DB 역할로 거절된다 | 빈칸 | B | — |
| AZ-T10 | — | 2인 승인 분리: 요청자가 자기 요청을 승인한다. 같은 사람이 두 번… | 403, 409(유일 제약), 403이다. 승인 기록에 남은 승인자는 0명이다 | 빈칸 | B | — |
| AZ-T11 | — | 재인증 토큰 묶음: 정산 계좌 변경용으로 받은 재인증 토큰을 명단… | 모두 403 `reauth-required`다 | 빈칸 | B | — |
| AZ-T12 | — | 지정: 지정 없는 commander가 분석 실버와 포렌식 2단계… | 모두 403이다. 지정을 거둔 뒤에는 캐시 시간(5초 [가정]) 안에 막힌다 | 빈칸 | B | — |
| AZ-T13 | — | 현장 스태프: A 회차 토큰으로 B 회차 목록을, 다른 파트너 기기로… | 403이고 판정이 기록되지 않는다(I-T22·I-T23·I-T25와 같은 결과) | 빈칸 | B | — |
| AZ-T14 | ① | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ①는 모두 403이고 대상 계정과 권한 내역에 변화가 0건이다. | 빈칸 | B | — |
| AZ-T14 | ② | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ②는 모두 403이고 대상 계정과 권한 내역에 변화가 0건이다. | 빈칸 | B | — |
| AZ-T14 | ③ | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ③은 403 self-target-forbidden과 422 designation-target-not-commander다. | 빈칸 | B | — |
| AZ-T14 | ④ | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ④는 캐시 시간(5초 [가정]) 안에 403이다(AZ-T12와 같다). | 빈칸 | B | — |
| AZ-T14 | ⑤ | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ⑤는 세션이 이미 끝나 401이거나, 세션 종료 이벤트가 늦어도 identity-svc가 DB 역할로 다시 봐 거절한다. | 빈칸 | B | — |
| AZ-T14 | ⑥ | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ⑥은 A의 계정만 나오고 B의 계정이 0건이며 이메일은 가린 값이다. partner_member는 403이다. | 빈칸 | B | — |
| AZ-T14 | ⑦ | 관리 계정 관리(§6.1, 추천 적용 2026-10-30… | ⑦은 doc-check `roles` 오류다(§5.5) | 빈칸 | B | — |
| AZ-T15 | ② | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ② B·C는 상세가 404이고, 승인은 B 403·C 403 `fraud-approver-ineligible`이다. D는 요약이 든 상세를 읽고 재인증 뒤… | 빈칸 | B | — |
| AZ-T15 | ③ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ③ 403 | 빈칸 | B | — |
| AZ-T15 | ④ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ④ 둘 가운데 하나만 생기고 다른 하나는 409 `designation-conflict`다. 냉각 기간 안의 지정도 409다 | 빈칸 | B | — |
| AZ-T15 | ⑤ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑤ 같은 트랜잭션에서 지정이 사라져 게이트웨이 403이고, 세션도 끝난다 | 빈칸 | B | — |
| AZ-T15 | ⑥ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑥ F는 '대상 아님'으로 닫히고, G는 404 `priority-grant-not-found`다 | 빈칸 | B | — |
| AZ-T15 | ⑦ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑦ 양도 요청은 409 `transfer-locked`, 동시 요청은 하나만 이긴다 | 빈칸 | B | — |
| AZ-T15 | ⑧ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑧ 그래프 응답의 IP 점은 가린 값이고 원문이 0건이다. 같은 IP·계정·가명이어도 두 사건의 `nodeId`가 다르고, `nodeId`가 그 값의 해시(키… | 빈칸 | B | — |
| AZ-T15 | ⑨ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑨ 409 `fraud-summary-not-viewed`, 422 `approval-reason-required`, 422… | 빈칸 | B | — |
| AZ-T15 | ⑩ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑩ H의 사본은 `party` `HOLDER`, 가진 사건 표만이고 사유 범주가 없다. 돌려주기는 성공하고, 돌아온 표는 잠긴 채다 | 빈칸 | B | — |
| AZ-T15 | ⑪ | 부정 거래 조사(§3.2·§3.5·§3.7·§4.1, 추천 적용… | ⑪ 403 `pseudonymization-review-pending` | 빈칸 | B | — |
| AZ-T16 | ① | 역할은 요청마다 판정(소유자 결정 2026-10-31… | ① `role`·`tid` 클레임이 없다 | 빈칸 | B | — |
| AZ-T16 | ② | 역할은 요청마다 판정(소유자 결정 2026-10-31… | ② 세션이 끝나 401이다. 세션 종료 사건이 늦어도 운영 명령은 위험 작업이라 캐시 없이 지금 역할을 보므로 바로 403이다 | 빈칸 | B | — |
| AZ-T16 | ③ | 역할은 요청마다 판정(소유자 결정 2026-10-31… | ③ 판정에 쓰이지 않는다 | 빈칸 | B | — |
| AZ-T16 | ④ | 역할은 요청마다 판정(소유자 결정 2026-10-31… | ④ 503 `authz-unavailable`이고 통과시키지 않는다 | 빈칸 | B | — |
| AZ-T16 | ⑤ | 역할은 요청마다 판정(소유자 결정 2026-10-31… | ⑤ 403이다 | 빈칸 | B | — |
