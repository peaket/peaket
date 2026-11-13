# 완성 장부: identity

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/identity.md`, `docs/security/asvs/auth.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 219 | 56 | 0 | 0 | 0 | 5 | 0 | 7 | 93 | 380 |
| 합계 | 219 | 56 | 0 | 0 | 0 | 5 | 0 | 7 | 93 | 380 |

## docs/features/identity.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| I-T1 | — | 동일 이메일 타 제공자 로그인 | 자동 병합이 일어나지 않음을 입증한다. 검증 이메일이 같은 활성 계정이 정확히 1개면 계정을 만들기 전에 연결 제안(SCR-039)이 나오고, '새 계정… | 빈칸 | B | — |
| I-T2 | — | 소셜 제공자 토큰 유출 방어 | identity-svc 데이터베이스, 캐시 저장소, 애플리케이션 로그에 제공자 액세스 토큰이 0건임을 검증한다. | 빈칸 | B | — |
| I-T3 | — | 원격 세션 즉시 만료 전파 | 어떤 세션을 로그아웃하면 수 초 이내에 모든 마이크로서비스의 모든 파드가 그 `sid`의 요청을 바로 거절함을 확인한다(파드마다 따로 읽는 방송형 소비… | 자동 시험 | B | 시험: services/identity-svc/test/refresh-cases.ts |
| I-T4 | ① | 리프레시 토큰 재사용 탐지: ① 폐기된 리프레시 토큰을 30초… | ①는 그 패밀리의 모든 세션이 바로 강제 종료되고 보안 경보가 발행된다. … 과 같이 처리된다(추천 적용 2026-10-28, 기술 검토 중간-053) | 자동 시험 | B | 시험: services/identity-svc/test/refresh-cases.ts |
| I-T4 | ② | 리프레시 토큰 재사용 탐지: ① 폐기된 리프레시 토큰을 30초… | ②는 새 쿠키를 받고 세션이 이어지며 `identity_refresh_retry_reuse_total`이 1 오른다. | 자동 시험 | B | 시험: services/identity-svc/test/refresh-cases.ts |
| I-T4 | ③ | 리프레시 토큰 재사용 탐지: ① 폐기된 리프레시 토큰을 30초… | ③은 폐기된 토큰이라 | 자동 시험 | B | 시험: services/identity-svc/test/refresh-cases.ts |
| I-T4 | ④ | 리프레시 토큰 재사용 탐지: ① 폐기된 리프레시 토큰을 30초… | ④는 그 패밀리의 모든 세션이 바로 강제 종료되고 보안 경보가 발행된다. | 자동 시험 | B | 시험: services/identity-svc/test/refresh-cases.ts |
| I-T4 | ⑤ | 리프레시 토큰 재사용 탐지: ① 폐기된 리프레시 토큰을 30초… | ⑤는 그 패밀리의 모든 세션이 바로 강제 종료되고 보안 경보가 발행된다. | 자동 시험 | B | 시험: services/identity-svc/test/refresh-cases.ts |
| I-T5 | — | 동시 접속 기기 한도 초과 | 같은 계정으로 6번째 기기에서 로그인하면 가장 오래 쓰지 않은 세션이 자동으로 안전하게 종료된다. | 빈칸 | B | — |
| I-T6 | — | 본인확인 중복 연계정보 차단 | 이미 다른 계정에 등록된 연계정보(CI)로 인증을 시도하면 409 Conflict를 돌려주고 기존 계정 로그인을 안내한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/verification.int.test.ts, services/identity-svc/test/http.test.ts 외 1곳 |
| I-T7 | — | 미인증 상태 대기열 진입 차단 | 본인확인을 마치지 않은 계정의 진입 시도는 막히고, 그 화면에서 본인확인 안내(기관 창)를 받는다. 인증을 마친 뒤의 도착 시각 순서로 순번이 발급된다. | 빈칸 | B | — |
| I-T8 | — | 주문 생성 시 본인확인 상태 재검증 | 탈퇴·병합되었거나 본인확인 기록이 없는 계정의 주문 생성 요청(`POST /v1/orders`)은 서버 재확인에서 바로 막힌다(identity-svc가 응답하지… | 자동 시험 | B | 시험: services/identity-svc/test/withdrawal.test.ts |
| I-T9 | — | 1인 1순번 가명 식별자 무결성 | 같은 사람이 계정을 여러 개 만들려 하면 거부되고, 게이트웨이가 넣은 pid를 기준으로 대기 순번은 1개만 발급된다. | 빈칸 | B | — |
| I-T10 | — | 관리자 TOTP 2차 인증 강제 | 유효한 비밀번호를 입력해도 TOTP 검증이 빠지면 로그인이 전혀 되지 않는다. 패스키만으로 하는 로그인도, 패스키로 TOTP를 건너뛰는 로그인도 허용하지… | 자동 시험 | B | 시험: services/identity-svc/test/admin-login-http.test.ts, services/identity-svc/test/admin-totp.test.ts 외 1곳 |
| I-T11 | ① | 로그인 연속 실패 잠금(추천 적용 2026-10-28, 기술 검토… | ①은 계정과 그 묶음이 15분 잠기고 계정 주인에게 해제 링크가 간다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts, services/identity-svc/test/admin-unlock.test.ts |
| I-T11 | ② | 로그인 연속 실패 잠금(추천 적용 2026-10-28, 기술 검토… | ②는 운영자 없이 바로 풀린다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| I-T11 | ③ | 로그인 연속 실패 잠금(추천 적용 2026-10-28, 기술 검토… | ③은 그 출발지 묶음 잠금으로 거부되고 계정은 다시 잠기지 않는다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| I-T11 | ④ | 로그인 연속 실패 잠금(추천 적용 2026-10-28, 기술 검토… | ④는 1시간 잠금이다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts |
| I-T11 | ⑤ | 로그인 연속 실패 잠금(추천 적용 2026-10-28, 기술 검토… | ⑤는 보호 잠금이고 본인 해제가 막혀 운영자 재초대로만 풀린다(파트너 계정은 operator 이상, 운영자·CS 계정은 commander). | 자동 시험 | B | 시험: services/identity-svc/test/admin-unlock.test.ts |
| I-T11 | ⑥ | 로그인 연속 실패 잠금(추천 적용 2026-10-28, 기술 검토… | ⑥은 보안 경보와 계정 주인 알림이 나오고 모든 로그인에 사람 확인이 걸리며, 보호 잠금은 걸리지 않는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts |
| I-T12 | — | 관리 계정 1시간 유휴 만료 | 61분간 활동이 없는 관리자 세션은 바로 무효가 되고, 비밀번호와 TOTP 입력을 모두 다시 요구한다. | 빈칸 | B | — |
| I-T13 | — | 관제망 허용 IP 대역 격리 | 허용 IP(사내망·VPN 출구) 밖에서 관제 콘솔·`ops-api`에 접근하면 관제 배포의 웹 ACL에서 403으로 막힌다. 원본 확인 머리가 없거나… | 빈칸 | B | — |
| I-T14 | — | 관리자 비밀번호 복잡도 검증 | 15자 미만, 서비스·회사·계정 이름에 숫자나 기호만 붙인 비밀번호(금칙어 대조 방식은 docs/security/auth-controls.md §4.3, 예는… | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| I-T15 | ① | 내부 세션 생성 엔드포인트 격리(두 범위, 추천 적용… | ① 운영 설계(메시 있음): 외부 인터넷, 허가되지 않은 서비스, API 게이트웨이 밖에서 identity 내부 세션 생성… | 빈칸 | B | — |
| I-T15 | ② | 내부 세션 생성 엔드포인트 격리(두 범위, 추천 적용… | ② 포트폴리오 실행(메시 없음): docs/architecture.md §3.2에서 identity-svc를 부르지 않는 파드에서 identity-svc… | 빈칸 | B | — |
| I-T50 | ① | 세션 생성 계약의 멱등과 허용 목록(추천 적용 2026-10-28… | ① 같은 멱등 키로 `CreateSession`을 데드라인 직후 다시 보낸다 … 은 세션·기기 바인딩이 하나뿐이고 앞서 발급한 리프레시 토큰은 쓸 수 없다. | 자동 시험 | B | 시험: services/identity-svc/test-int/session-store.int.test.ts, services/identity-svc/test/session-cases.ts 외 1곳 |
| I-T50 | ② | 세션 생성 계약의 멱등과 허용 목록(추천 적용 2026-10-28… | ② 같은 키에 다른 `provider_user_id`를 보낸다 … 는 `ALREADY_EXISTS`, | 자동 시험 | B | 시험: services/identity-svc/test-int/session-store.int.test.ts, services/identity-svc/test/session-cases.ts 외 1곳 |
| I-T50 | ③ | 세션 생성 계약의 멱등과 허용 목록(추천 적용 2026-10-28… | ③ purchase-svc 신원으로 `SessionService`를, 웹 앱 서버 신원으로 `IdentityService`를 부른다 … 은… | ID만 | B | 시험: packages/contracts/test/proto-descriptors.test.ts, services/identity-svc/test-int/session-store.int.test.ts 외 2곳 |
| I-T50 | ④ | 세션 생성 계약의 멱등과 허용 목록(추천 적용 2026-10-28… | ④ 끝난 세션에 `EndSession`을 다시 보낸다. … 는 성공(`ended=false`)이다 | 자동 시험 | B | 시험: services/identity-svc/test/session-cases.ts, services/identity-svc/test/session.grpc.test.ts |
| I-T16 | — | 회원 탈퇴 및 개인정보 파기 | 탈퇴하면 바로 모든 세션이 만료되고, 프로필 정보와 CI 해시가 영구 파기된다. 법정 거래 기록만 물리적으로 분리해 보관된다. | 자동 시험 | B | 시험: apps/web/src/features/account-withdraw/flow.test.mjs, services/identity-svc/test-int/withdrawal.int.test.ts 외 2곳 |
| I-T17 | — | 법정 접속기록 보존 검증 | 로그인, 대기열 진입, 주문, 결제 요청의 감사 로그가 접속기록 저장소에 3개월간 온전히 보존되고 정상적으로 조회된다. '온전히'는 셋으로 확인한다(추천 적용… | 빈칸 | B | — |
| I-T18 | — | 민감 설정 변경 재인증 통제 | 양도, 연락처 변경, 수단 해제를 시도할 때 5분 이내의 유효한 재인증 토큰이 없으면 403 Forbidden으로 막힌다. | 빈칸 | B | — |
| I-T19 | — | 액세스 토큰 `aud` 권한 격리 | 일반 팬의 토큰으로 partner나 ops 관리자 API 엔드포인트를 부르면 게이트웨이에서 바로 401로 막힌다(관리 토큰 키로 서명되지 않은 토큰… | 자동 시험 | B | 시험: packages/platform/test/token-verify.test.ts |
| I-T20 | — | JWT 서명 키 무중단 로테이션 | 새 `kid` 키쌍을 배포한 뒤에도 기존 키로 서명된 토큰이 만료 시점까지 정상 검증됨을 확인한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, packages/platform/test/token-verify.test.ts 외 2곳 |
| I-T21 | — | 현장 스태프 초대 및 수락 통제 | 현장 스태프 초대 링크는 24시간 동안 쓰는 일회용이다. 검증 이메일이 초대 이메일과 다른 계정, 본인확인을 마치지 않은 계정, 네이버만 연결한 계정의 수락… | 빈칸 | B | — |
| I-T22 | — | 기기 승인 피싱 방지 검증 | 스캐너 단말기와 휴대폰의 확인 코드(8자)가 대조 화면에 함께 보인다. 등록되지 않았거나 폐기된 기기의 승인 코드 발급 요청과, 다른 파트너 기기의 승인은… | 빈칸 | B | — |
| I-T23 | — | 현장 스태프 세션 역할 유효시간 통제 | 입장 시작 3시간 전 이전이나 공연 종료 2시간 이후에는 로그인이 막힌다. 오프라인 스캐너도 유효시간이 지나는 즉시 스스로 종료된다. | 빈칸 | B | — |
| I-T24 | — | 현장 스태프 권한 해제 즉시 반영 | 파트너 콘솔에서 현장 스태프 배정을 해제하면 그 스캐너의 다음 서버 요청부터 거부되고(해제 16분 뒤 요청도 거부), 다음 변경분을 받을 때 스캐너가 자동으로… | 빈칸 | B | — |
| I-T25 | — | 현장 책임자 권한 통제 | `gate_staff` 토큰과 대리 승인 토큰으로 예외 통과·기기 배치·부스 허용·확인 스캔을 시도하면 403이 돌아온다. 이 작업은 `gate_lead`… | 빈칸 | B | — |
| I-T26 | — | 미사용 티켓 보유 회원의 탈퇴 | 남은 티켓의 환불 예상액과 양도 가능 여부 안내를 투명하게 보여 준다. 사용자가 최종 확인하면 취소·환불·탈퇴가 차례로 끝난다. | 빈칸 | B | — |
| I-T27 | — | 탈퇴 후 재가입 및 온세일 방어 | 탈퇴 때 CI 해시가 파기됐는지 확인한다. 바로 재가입하고 본인확인을 하는 것은 정상적으로 되지만, 탈퇴 뒤 5일 안에는 진행 중인 같은 공연에서 중복 순번이… | 자동 시험 | B | 시험: services/identity-svc/test-int/withdrawal.int.test.ts, services/identity-svc/test/withdrawal.test.ts 외 4곳 |
| I-T28 | — | PBKDF2 비밀번호 해시 규격 검증 | DB에 저장된 해시 문자열에 `pbkdf2-sha256` 식별자, 600,000회 이상의 반복 파라미터, 페퍼 키 버전이 들어 있는지 검증한다. 다른 관리 계정… | 빈칸 | B | — |
| I-T29 | — | 계정 연결 제안 발동 조건 | 검증된 이메일이 일치하는 활성 계정이 정확히 1개일 때만 연결 제안(`CreateSession`의 `link_proposal_id`, 웹은 SCR-039로… | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test-int/link-proposal.int.te… |
| I-T30 | — | 소유권 증명으로 연결 완결 | 연결 제안 뒤 기존 제공자 로그인에 성공하면 연결이 맺어진다. 3회 일치하지 않거나 10분이 지나면 제안이 안전하게 만료된다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test-int/link-proposal.int.te… |
| I-T31 | — | 계정 병합 사전 차단 조건 검증 | 티켓 합산 보유량이 1인 한도를 넘거나 진행 중인 구매 세션이 있으면, BLOCKED 응답과 함께 사유를 안내한다. 두 계정에 같은 종류의 다른 로그인 수단이… | 자동 시험 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs… |
| I-T32 | — | 계정 병합 트랜잭션 멱등성 | 병합 확정 요청이나 이벤트를 중복으로 처리해도 소유·상태 값(찜, 오픈 알림 구독, 배송지)은 1회만 옮겨지고, 흡수 계정의 모든 세션이 바로 종료된다. 흡수… | 자동 시험 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, services/identity-svc/test-int/merge.int.test.ts 외 2곳 |
| I-T33 | — | 로그인 수단 해제 안전성 | 마지막 남은 하나뿐인 로그인 수단의 해제 시도는 409 Conflict로 막힌다. 해제는 재인증을 통과했을 때만 끝난다. | 자동 시험 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, services/identity-svc/test-int/login-methods.int.test.ts 외 2곳 |
| I-T34 | — | 계정 변경 감사 이력 및 알림 | 연결·병합·해제가 일어나면 두 계정에 등록된 알림 채널로 통지가 1회 나간다. `account_merge` 감사 이력은 대표 계정이 탈퇴할 때까지 온전하게… | 자동 시험 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs… |
| I-T35 | — | 연계정보 키 교체 뒤 중복 계정 방어 | 연계정보 HMAC 키 새 버전을 만든 뒤, 옛 버전으로 본인확인한 사람이 새 계정에서 본인확인을 시도하면 옛 버전 값과 일치해 409(이미 다른 계정에서… | 빈칸 | B | — |
| I-T36 | — | 토큰 서명 키 분리 | 팬 토큰 키로 서명한 `aud` ops 토큰과, 입장 토큰을 액세스 토큰 자리에 넣은 요청을 gw-ops·gw-fan에 보내면 둘 다 401로 거부된다(키… | 자동 시험 | B | 시험: packages/platform/test/token-verify.test.ts |
| I-T37 | — | 확인 코드 무차별 대입 제한 | 한 계정으로 10분 안에 확인 코드 승인을 5번 틀리면 6번째 시도부터 거부되고, 계정은 잠기지 않는다. 한 기기가 1시간에 코드를 10번 발급받은 뒤 11번째… | 빈칸 | B | — |
| I-T38 | — | 스캐너 세션 수 | 같은 계정으로 두 번째 기기를 승인하면 첫 기기 세션이 끝나고, 같은 기기에서 다른 스태프가 승인하면 이전 스태프 세션이 끝난다(교대). | 빈칸 | B | — |
| I-T39 | — | 토큰과 기기 결속 | 기기 A의 스태프 토큰을 기기 B의 키로 만든 DPoP 증명과 함께 보낸 요청은 스캐너 경로에서 거부된다(`cnf.jkt` 불일치. mTLS 선택지는 기기 B의… | 빈칸 | B | — |
| I-T40 | — | 부스 본인확인 대조 | 대조 목적에 동의하지 않으면 본인확인이 시작되지 않는다. 결과 `ci_hmac`이 보유 계정과 다르면 409로 부스 코드가 나오지 않는다. 연계정보 원문은… | 빈칸 | B | — |
| I-T41 | — | TOTP 시드 암호문 결속 | 한 관리 계정의 TOTP 시드 암호문을 다른 관리 계정 행으로 복사하면 암호화 컨텍스트가 맞지 않아 복호에 실패한다. 로그인은 거부되고 보안 이벤트가 남는다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-totp.int.test.ts, services/identity-svc/test/admin-totp.test.ts |
| I-T42 | — | 만 14세 미만 본인확인 | 본인확인 결과가 만 14세 미만이면 연계정보가 저장되지 않고, 403 `under-14`가 나오며 계정 정리가 시작된다. 생년월일은 DB·로그에 0건이다. | 자동 시험 | B | 시험: services/identity-svc/test-int/verification-keys.int.test.ts, services/identity-svc/test/http.test.ts 외 1곳 |
| I-T43 | — | 받은 티켓·양도 요청·가상계좌가 있는 탈퇴 | 받은 티켓은 결제자에게 돌아간다. 수락 전에 보낸 양도 요청은 철회된 뒤 취소·환급되고, 받은 양도 요청은 거절로 끝난다. 입장 시작 뒤 취소한 가상계좌 결제… | 빈칸 | B | — |
| I-T44 | — | 파트너 역할: 파트너 실무자로 정산 계좌 변경·명단 내려받기·회차 취소… | 실무자 요청은 모두 403이고 화면 버튼은 비활성이다. 마지막 관리자의 역할 변경·삭제는 거부된다. 역할 변경은 권한 변경 내역에 남는다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-account-management.int.test.ts, services/identity-svc/test/admin-account-manage… |
| I-T45 | ① | 본인확인 흐름: 공연 상세에서 [휴대폰 본인확인]을 눌러 ① 팝업 완료… | ①은 별도 화면 없이 공연 상세 위 토스트, | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| I-T45 | ② | 본인확인 흐름: 공연 상세에서 [휴대폰 본인확인]을 눌러 ① 팝업 완료… | ②는 [다시 시도] 대화상자, | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| I-T45 | ③ | 본인확인 흐름: 공연 상세에서 [휴대폰 본인확인]을 눌러 ① 팝업 완료… | ③는 `/verify/return` 진행 표시 뒤 `next`로 돌아가 결과 대화상자, | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| I-T45 | ④ | 본인확인 흐름: 공연 상세에서 [휴대폰 본인확인]을 눌러 ① 팝업 완료… | ④는 `/verify/return` 진행 표시 뒤 `next`로 돌아가 결과 대화상자, | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| I-T45 | ⑤ | 본인확인 흐름: 공연 상세에서 [휴대폰 본인확인]을 눌러 ① 팝업 완료… | ⑤는 400이다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs, services/identity-svc/test/verification.test.ts |
| I-T45 | ⑥ | 본인확인 흐름: 공연 상세에서 [휴대폰 본인확인]을 눌러 ① 팝업 완료… | ⑥은 버려지고 결과 조회 API 값만 반영된다. 기관 결과 값은 URL·로그에 0건이다. 포트폴리오에서는 모의 기관(팝업 방식·페이지 이동 방식·POST 본문… | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| I-T46 | ① | 관리 계정 토큰 갱신: 파트너·운영자 세션으로 ① 액세스 토큰 만료 뒤… | ①은 204와 새 액세스·리프레시 쿠키(본문에 토큰 0건), | 자동 시험 | B | 시험: services/identity-svc/test/admin-token-refresh-http.test.ts |
| I-T46 | ② | 관리 계정 토큰 갱신: 파트너·운영자 세션으로 ① 액세스 토큰 만료 뒤… | ② (30초 유예가 지난 뒤)는 401과 패밀리 전체 폐기·세션 종료 이벤트, | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-token-refresh.int.test.ts |
| I-T46 | ③ | 관리 계정 토큰 갱신: 파트너·운영자 세션으로 ① 액세스 토큰 만료 뒤… | ③은 401이고 비밀번호와 TOTP를 다시 요구, | 자동 시험 | B | 시험: services/identity-svc/test/admin-token-refresh-http.test.ts |
| I-T46 | ④ | 관리 계정 토큰 갱신: 파트너·운영자 세션으로 ① 액세스 토큰 만료 뒤… | ④는 거절이다. | ID만 | B | 시험: services/identity-svc/test-int/admin-token-refresh.int.test.ts, services/identity-svc/test/admin-token-refresh-http… |
| I-T46 | ⑤ | 관리 계정 토큰 갱신: 파트너·운영자 세션으로 ① 액세스 토큰 만료 뒤… | ⑤는 백엔드에 리프레시 쿠키가 전달되지 않는다 | ID만 | B | 시험: services/identity-svc/test-int/admin-token-refresh.int.test.ts, services/identity-svc/test/admin-token-refresh-http… |
| I-T46 | ⑥ | 관리 계정 토큰 갱신: 파트너·운영자 세션으로 ① 액세스 토큰 만료 뒤… | ⑥은 204와 새 쿠키이고 세션이 이어진다(§3 '응답을 잃은 뒤의 재시도'), | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-token-refresh.int.test.ts, services/identity-svc/test/admin-token-refresh-http… |
| I-T47 | — | 초대·승인 링크의 URL 조각: 로그인하지 않은 휴대폰으로 초대… | 화면이 열리자마자 주소창에서 조각이 사라진다. 로그인 뒤 돌아온 주소·`next`·서버 접근 로그·`Referer`에 토큰과 확인 코드가 0건이고, 같은 탭에서… | 빈칸 | B | — |
| I-T48 | ① | 새 파드의 종료 세션(추천 적용 2026-10-28… | ①은 새 파드가 준비 상태가 된 뒤 그 세션 요청을 401로 거부한다 | 빈칸 | B | — |
| I-T48 | ② | 새 파드의 종료 세션(추천 적용 2026-10-28… | ②는 세 파드 모두 거부한다(이벤트가 파드 하나에만 가지 않는다) | 빈칸 | B | — |
| I-T48 | ③ | 새 파드의 종료 세션(추천 적용 2026-10-28… | ③은 30초 뒤 준비 상태가 되고 SEV2 `control_sync_lagging{kind="sessions"}`가 뜨며, Kafka가 돌아오면 15분 창을… | 빈칸 | B | — |
| I-T49 | ① | pid 키 전환(추천 적용 2026-10-28, 기술 검토… | ①은 identity-svc가 돌려준 옛 pid와 같아 통과한다. | 자동 시험 | B | 시험: services/identity-svc/test/identity.grpc.test.ts, services/identity-svc/test/pid-rotation.test.ts |
| I-T49 | ② | pid 키 전환(추천 적용 2026-10-28, 기술 검토… | ②는 `pid`(새 값)와 `pid_prev`(옛 값)를 함께 싣는다. | 자동 시험 | B | 시험: services/identity-svc/test/pid-rotation.test.ts |
| I-T49 | ③ | pid 키 전환(추천 적용 2026-10-28, 기술 검토… | ③는 pid가 바뀌지 않는다. | 자동 시험 | B | 시험: services/identity-svc/test/pid-rotation.test.ts |
| I-T49 | ④ | pid 키 전환(추천 적용 2026-10-28, 기술 검토… | ④는 pid가 바뀌지 않는다. | 자동 시험 | B | 시험: services/identity-svc/test/pid-rotation.test.ts |
| I-T49 | ⑤ | pid 키 전환(추천 적용 2026-10-28, 기술 검토… | ⑤는 `pid_prev`가 없고, DB의 `pid_prev`도 지워졌다. 토큰 발급 경로의 KMS 호출은 0건이다 | 자동 시험 | B | 시험: services/identity-svc/test/pid-rotation.test.ts |
| I-T51 | ② | 로그인 구현 비교 PoC(추천 적용 2026-10-28… | ②는 두 안 모두 거절한다. | 자동 시험 | B | 시험: tools/poc/login-compare/login-compare.test.mjs |
| I-T51 | ③ | 로그인 구현 비교 PoC(추천 적용 2026-10-28… | ③는 두 안 모두 거절한다. | 자동 시험 | B | 시험: tools/poc/login-compare/login-compare.test.mjs |
| I-T51 | ④ | 로그인 구현 비교 PoC(추천 적용 2026-10-28… | ④는 두 안 모두 거절한다. | 자동 시험 | B | 시험: tools/poc/login-compare/login-compare.test.mjs |
| I-T51 | ⑤ | 로그인 구현 비교 PoC(추천 적용 2026-10-28… | ⑤ 뒤 identity 세션 밖에 남는 세션 쿠키·저장소 수를 센다(C는 0). ADR-0119 결정 3의 기준 다섯(세션 층 수, 판 유지 상태, 코드 양… | 자동 시험 | B | 시험: tools/poc/login-compare/login-compare.test.mjs |
| I-T52 | ① | 파트너 로그인 경로(추천 적용 2026-10-28, ADR-0119):… | ①은 gw-partner 응답이 `__Secure-peaket_partner_at`·`__Secure-peaket_partner_rt`를 주고 본문에 토큰이… | 빈칸 | B | — |
| I-T52 | ② | 파트너 로그인 경로(추천 적용 2026-10-28, ADR-0119):… | ②는 거절된다. | 빈칸 | B | — |
| I-T52 | ③ | 파트너 로그인 경로(추천 적용 2026-10-28, ADR-0119):… | ③에 Auth.js 쿠키(`authjs.*`)가 없다. | 빈칸 | B | — |
| I-T52 | ④ | 파트너 로그인 경로(추천 적용 2026-10-28, ADR-0119):… | ④는 앱 서버가 받은 액세스 토큰으로 gw-partner를 불러 그린다 | 빈칸 | B | — |
| I-T53 | ① | 관리 계정 패스키 단계 인증(추천 적용 2026-10-28, 기술 검토… | ①은 활성화되지 않는다. | ID만 | B | 시험: services/identity-svc/test/admin-passkey-http.test.ts, services/identity-svc/test/passkey-cases.ts |
| I-T53 | ② | 관리 계정 패스키 단계 인증(추천 적용 2026-10-28, 기술 검토… | ②는 403 `reauth-required`이고 실행되지 않는다. | 자동 시험 | B | 시험: services/identity-svc/test/passkey-cases.ts |
| I-T53 | ③ | 관리 계정 패스키 단계 인증(추천 적용 2026-10-28, 기술 검토… | ③은 통과하고 재인증 기록에 `factors` 셋이 남는다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-passkey-http.test.ts, services/identity-svc/test/passkey-cases.ts |
| I-T53 | ④ | 관리 계정 패스키 단계 인증(추천 적용 2026-10-28, 기술 검토… | ④는 RP ID가 맞지 않아 거부된다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-passkey-http.test.ts, services/identity-svc/test/passkey-cases.ts |
| I-T53 | ⑤ | 관리 계정 패스키 단계 인증(추천 적용 2026-10-28, 기술 검토… | ⑤는 403 `reauth-required`이고 실행되지 않는다. | ID만 | B | 시험: services/identity-svc/test/admin-passkey-http.test.ts, services/identity-svc/test/passkey-cases.ts |
| I-T54 | ① | 제공자별 재인증 강도(추천 적용 2026-10-28, 기술 검토… | ①은 '확인됨' 재인증 토큰이다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, apps/web/src/features/social-login/server/reauth-st… |
| I-T54 | ② | 제공자별 재인증 강도(추천 적용 2026-10-28, 기술 검토… | ②는 거부되고 '제공자 계정에서 로그아웃한 뒤 다시 시도'를 안내한다. | 자동 시험 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs… |
| I-T54 | ③ | 제공자별 재인증 강도(추천 적용 2026-10-28, 기술 검토… | ③은 '요청만 함'이다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, apps/web/src/features/social-login/server/reauth-st… |
| I-T54 | ④ | 제공자별 재인증 강도(추천 적용 2026-10-28, 기술 검토… | ④는 카카오 재인증으로 이끈다. | ID만 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs… |
| I-T54 | ⑤ | 제공자별 재인증 강도(추천 적용 2026-10-28, 기술 검토… | ⑤는 '요청만 함'으로 받되 모든 공식 채널로 바로 알리고, 재인증 기록에 강도가 남는다 | ID만 | B | 시험: apps/web/src/features/login-methods/flow.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs… |
| I-T55 | ① | 로그인 판정이 CHALLENGE·UNKNOWN인 세션의 위험 작업(추천… | ①은 정해진 재인증만으로 재인증 토큰이 나온다. | 자동 시험 | B | 시험: services/identity-svc/test/login-verdict.test.ts |
| I-T55 | ② | 로그인 판정이 CHALLENGE·UNKNOWN인 세션의 위험 작업(추천… | ②은 재인증 강도가 '요청만 함'이면 재인증 토큰을 주지 않고 재통과를 요구한다. 로그인 자체는 막히지 않았다. | 자동 시험 | B | 시험: services/identity-svc/test/login-verdict.test.ts |
| I-T55 | ③ | 로그인 판정이 CHALLENGE·UNKNOWN인 세션의 위험 작업(추천… | ③은 재인증 강도가 '요청만 함'이면 재인증 토큰을 주지 않고 재통과를 요구한다. 로그인 자체는 막히지 않았다. | 자동 시험 | B | 시험: services/identity-svc/test/login-verdict.test.ts |
| I-T55 | ④ | 로그인 판정이 CHALLENGE·UNKNOWN인 세션의 위험 작업(추천… | ④는 재인증 토큰이 나온다. 세션의 `login_verdict`가 판정마다 남는다 | 자동 시험 | B | 시험: services/identity-svc/test-int/verification-keys.int.test.ts, services/identity-svc/test/verification-keys.test.ts |
| I-T56 | ① | 본인확인 재통과 확인(`CheckReverification`, 추천… | ①만 재통과로 답한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/main-reverification.int.test.ts, services/identity-svc/test-int/reverification-check… |
| I-T56 | ② | 본인확인 재통과 확인(`CheckReverification`, 추천… | ②은 재통과 아님이다. | 자동 시험 | B | 시험: services/identity-svc/test-int/reverification-check.int.test.ts, services/identity-svc/test/reverification-check.tes… |
| I-T56 | ③ | 본인확인 재통과 확인(`CheckReverification`, 추천… | ③은 재통과 아님이다. | 자동 시험 | B | 시험: services/identity-svc/test-int/reverification-check.int.test.ts, services/identity-svc/test/reverification-check.tes… |
| I-T56 | ④ | 본인확인 재통과 확인(`CheckReverification`, 추천… | ④는 queue-svc가 추가 검증 제출에 503을 돌려주고 통과로 보지 않는다. … 에서 떼어 냄은 추천 적용 2026-11-10, BUILD_ORDER… | 자동 시험 | B | 시험: services/queue-svc/test/verification-cases.ts, services/queue-svc/test/verification-clients.test.ts |
| I-T56 | ⑤ | 본인확인 재통과 확인(`CheckReverification`, 추천… | ⑤는 거부된다(메시 L7 허용 목록 몫, | 다른 단계 | B | HOT-400 · `CheckReverification`을 queue-svc 신원으로만 받는 것은 메시 L7 허용 목록이다(BAT-200에서 정함, 2026-11-10) |
| I-T57 | ① | 기기 승인 때 기기 상태 확인(GetScannerDeviceByCred… | ①은 승인 화면에 기기 이름이 보이고 토큰이 나온다. | 빈칸 | B | — |
| I-T57 | ② | 기기 승인 때 기기 상태 확인(GetScannerDeviceByCred… | ②는 토큰 발급이 거부된다(캐시하지 않는다). | 빈칸 | B | — |
| I-T57 | ③ | 기기 승인 때 기기 상태 확인(GetScannerDeviceByCred… | ③은 503이고 기기를 승인하지 않는다 | 빈칸 | B | — |
| I-T58 | ① | 관리 로그인의 사람 확인 토큰 검증(추천 적용 2026-10-30… | ①는 identity-svc의 검증을 통과한다. | 빈칸 | B | — |
| I-T58 | ② | 관리 로그인의 사람 확인 토큰 검증(추천 적용 2026-10-30… | ②는 identity-svc의 검증을 통과한다. | 빈칸 | B | — |
| I-T58 | ③ | 관리 로그인의 사람 확인 토큰 검증(추천 적용 2026-10-30… | ③은 hostname이 맞지 않아 사람 확인 실패로 센다. | 빈칸 | B | — |
| I-T58 | ④ | 관리 로그인의 사람 확인 토큰 검증(추천 적용 2026-10-30… | ④는 사람 확인이 필요한 로그인을 받지 않는다. 검증은 trust-svc를 부르지 않는다 | 빈칸 | B | — |
| I-T59 | ① | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ①은 422 first-partner-account-must-be-admin이다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ② | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ②는 201이고, 업무 이메일에 24시간 링크가 가며 토큰은 URL 조각에만 있고 DB에는 SHA-256만 있다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ③ | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ③은 403 admin-role-not-allowed, | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ④ | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ④는 409 admin-email-in-use, | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ⑤ | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ⑤는 403 reauth-required다. | ID만 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ⑥ | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ⑥은 200이고 비밀번호 해시·TOTP 시드·패스키·복구 코드가 지워지며 상태가 INVITED로 바뀌고 모든 세션이 끝난다(ADMIN_FORCE). | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ⑦ | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ⑦은 409다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T59 | ⑧ | 관리 계정 초대·재초대(추천 적용 2026-10-30, §6 '관리… | ⑧은 새 링크만 쓰이고 옛 링크는 무효다. 성공한 건은 모두 권한 부여 내역(permission-changes)에 남는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ① | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ①은 200이고 그 계정의 모든 세션이 수 초 안에 401이다(ROLE_CHANGED). … 의 내역이 permission-changes에 남는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ② | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ②는 403, | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ③ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ③은 403 self-target-forbidden, | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ④ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ④는 409 last-partner-admin, | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ⑤ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ⑤는 428과 412다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ⑥ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ⑥은 202이고 역할은 그대로다. … 의 내역이 permission-changes에 남는다 | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ⑦ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ⑦은 본인 승인이 403이고 다른 commander가 승인한 뒤에 역할이 바뀐다(AZ-T10과 같은 승인 규칙). … 의 내역이… | ID만 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ⑧ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ⑧은 422 role-group-mismatch, | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ⑨ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ⑨는 409 commander-removal-needs-role-change다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T60 | ⑩ | 관리 계정 역할 변경·삭제(추천 적용 2026-10-30… | ⑩은 200이고 업무 이메일과 인증 수단이 DB에 0건이며, 행에는 ID·역할·삭제 시각만 남고 그 계정의 로그인은 거부된다. … 의 내역이… | 자동 시험 | B | 시험: services/identity-svc/test/admin-account-management.test.ts |
| I-T61 | ① | 관리 계정 세션 강제 종료(추천 적용 2026-10-30… | ①은 재인증 없이 204이고 그 계정의 세션이 모든 파드에서 수 초 안에 401이다(ADMIN_FORCE). 계정 상태는 그대로라 비밀번호와 TOTP로 다시… | 빈칸 | B | — |
| I-T61 | ② | 관리 계정 세션 강제 종료(추천 적용 2026-10-30… | ②는 그 세션만 끝난다. | 빈칸 | B | — |
| I-T61 | ③ | 관리 계정 세션 강제 종료(추천 적용 2026-10-30… | ③은 404, | 빈칸 | B | — |
| I-T61 | ④ | 관리 계정 세션 강제 종료(추천 적용 2026-10-30… | ④는 403이다 | 빈칸 | B | — |
| I-T62 | ① | 스캐너 승인 화면의 파트너 이름(추천 적용 2026-10-30… | ①은 조회 응답에 파트너 이름이 없고, 화면이 `GET /v1/events/{eventId}`의 sellerName을 배정 파트너로 보인다(공연 상세의 판매자… | 빈칸 | B | — |
| I-T62 | ② | 스캐너 승인 화면의 파트너 이름(추천 적용 2026-10-30… | ②는 조회가 403 `other-partner-device`이고 화면은 이유만 보이며 파트너 이름이 없다. 그 코드로 승인을 보내도 403이다. | 빈칸 | B | — |
| I-T62 | ③ | 스캐너 승인 화면의 파트너 이름(추천 적용 2026-10-30… | ③은 회차 공개 요약이 404라 이름과 공연명 없이 기기 이름·확인 코드·유효 시간을 보이고, 승인은 된다. | 빈칸 | B | — |
| I-T62 | ④ | 스캐너 승인 화면의 파트너 이름(추천 적용 2026-10-30… | ④는 파트너 이름을 얻으려는 내부 호출이 0건이다 | 빈칸 | B | — |
| I-T63 | ① | 기기 가명 통일(추천 적용 2026-10-31, ADR-0171… | ①의 `device.device_ref`가 trust-svc 판정 기록의 `deviceRef`와 같고, 시험 키로 §9.1의 식대로 계산한 값과 같다. DB에… | ID만 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T63 | ② | 기기 가명 통일(추천 적용 2026-10-31, ADR-0171… | ②은 그 행이 지워진다 | ID만 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T63 | ③ | 기기 가명 통일(추천 적용 2026-10-31, ADR-0171… | ③은 그 행이 지워진다 | ID만 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T64 | ① | 연락처 가명(추천 적용 2026-10-31, §9.1): ① 본인확인… | ①은 PHONE·EMAIL 두 행이고 이메일은 소문자·앞뒤 빈칸을 뺀 값으로 계산된다. … 의 PHONE 값과 같다. | 자동 시험 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T64 | ② | 연락처 가명(추천 적용 2026-10-31, §9.1): ① 본인확인… | ②의 주문 사건 `contactRef`가 | 자동 시험 | B | 시험: services/identity-svc/test/investigation.test.ts |
| I-T64 | ③ | 연락처 가명(추천 적용 2026-10-31, §9.1): ① 본인확인… | ③는 그 종류의 값과 바뀐 시각만 새로 쓴다. | ID만 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T64 | ④ | 연락처 가명(추천 적용 2026-10-31, §9.1): ① 본인확인… | ④는 그 종류의 값과 바뀐 시각만 새로 쓴다. | 자동 시험 | B | 시험: services/identity-svc/test/investigation.test.ts |
| I-T64 | ⑤ | 연락처 가명(추천 적용 2026-10-31, §9.1): ① 본인확인… | ⑤는 행이 0건이다. 번호·이메일 원문은 이 표에 없다 | 자동 시험 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T65 | ① | 같은 본인확인으로 다른 계정에서 시도(추천 적용 2026-10-31… | ①은 지금처럼 409와 같은 안내이고, `identity_conflict_attempt`에 (B, A, 시각) 한 줄이 생긴다. 연계정보·`ci_hmac`은 그… | ID만 | B | 시험: services/identity-svc/test-int/verification-keys.int.test.ts, services/identity-svc/test/verification-keys.test.ts |
| I-T65 | ② | 같은 본인확인으로 다른 계정에서 시도(추천 적용 2026-10-31… | ②는 시도마다 한 줄이다. | ID만 | B | 시험: services/identity-svc/test-int/verification-keys.int.test.ts, services/identity-svc/test/verification-keys.test.ts |
| I-T65 | ③ | 같은 본인확인으로 다른 계정에서 시도(추천 적용 2026-10-31… | ③은 지워진다 | ID만 | B | 시험: services/identity-svc/test-int/verification-keys.int.test.ts, services/identity-svc/test/verification-keys.test.ts |
| I-T66 | ① | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ①는 201이다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ② | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ②는 201이다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ③ | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ③은 422 `designation-target-not-eligible`, | 자동 시험 | B | 시험: services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ④ | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ④는 409 `designation-conflict`, | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-designation.int.test.ts, services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ⑤ | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ⑤는 409 `designation-conflict`, | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-designation.int.test.ts, services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ⑥ | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ⑥은 422 `designation-target-not-commander`다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ⑦ | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ⑦은 같은 트랜잭션에서 지정의 `revoked_at`이 채워지고 권한 말소 내역이 남는다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-designation.int.test.ts, services/identity-svc/test/admin-designation.test.ts |
| I-T66 | ⑧ | 부정 거래 조사관 지정(추천 적용 2026-10-31, ADR-0171… | ⑧은 캐시가 지난 뒤 403이다. 모든 지정·거두기가 permission-changes에 남는다 | ID만 | B | 시험: services/identity-svc/test-int/admin-designation.int.test.ts, services/identity-svc/test/admin-designation.test.ts |
| I-T67 | ① | 조사 적재의 연결 값 조회(BatchGetInvestigationRef… | ①은 계정마다 연락처 가명 목록·기기 가명 목록·상대 계정 ID를 돌려주고, 탈퇴한 계정은 빈 목록이다. 응답에 번호·이메일·연계정보 원문이 없다. | 자동 시험 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test/investigation.test.ts |
| I-T67 | ② | 조사 적재의 연결 값 조회(BatchGetInvestigationRef… | ②는 `PERMISSION_DENIED`다 | ID만 | B | 시험: services/identity-svc/test-int/investigation.int.test.ts, services/identity-svc/test-int/merge.int.test.ts 외 2곳 |
| I-T68 | ① | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ①은 `restricted_ci_hold` 행이 생기고 두 상태 모두 `until`이 있다 | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ② | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ②는 프로필·연락처 가명·기기 연결과 `identity_verification`은 지워지고 그 행만 남는다 | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ③ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ③은 RESTRICTED 쪽 새 계정의 본인확인이 VERIFIED이고 `restrictedUntil`이 실리며 토큰에 `ticket:buy`가 없고… | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ④ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ④는 행이 지워지고 다음 토큰부터 `ticket:buy`가 실린다 | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ⑤ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ⑤는 행이 지워지고 다음 토큰부터 `ticket:buy`가 실린다 | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ⑥ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ⑥은 지금처럼 `ci_hmac`까지 바로 지워진다 | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ⑦ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ⑦은 `PERMISSION_DENIED`다 | ID만 | B | 시험: apps/web/src/features/account-withdraw/flow.test.mjs, services/identity-svc/test-int/fraud-hold.int.test.ts 외 2곳 |
| I-T68 | ⑧ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ⑧은 정비 작업이 그 행을 지운다 | 자동 시험 | B | 시험: services/identity-svc/test/fraud-hold.test.ts |
| I-T68 | ⑨ | 이용 제한 중 탈퇴와 다시 가입(ADR-0171 결정 5, 추천 적용… | ⑨는 RESTRICTED 쪽에 "이용 제한이 끝날 때까지 본인확인 대조값을 남깁니다"와 끝 시각이, CASE_OPEN 쪽에 "부정 예매 조사가 끝날… | 자동 시험 | B | 시험: apps/web/src/features/account-withdraw/flow.test.mjs, services/identity-svc/test/fraud-hold.test.ts 외 1곳 |
| I-T69 | ① | 지정의 동시 요청과 조사용 가명 계산 실패(추천 적용… | ①은 하나만 성공하고 다른 하나는 409 `designation-conflict`다(대상 계정 행 잠금) | 빈칸 | B | — |
| I-T69 | ② | 지정의 동시 요청과 조사용 가명 계산 실패(추천 적용… | ②는 로그인·본인확인이 성공하고 기기 행이 생기지 않으며 새 기기 알림이 가고 `inv_ref_missing_total{label=device}`가 는다 | 빈칸 | B | — |
| I-T69 | ③ | 지정의 동시 요청과 조사용 가명 계산 실패(추천 적용… | ③은 `k1.`로 시작하는 `device_ref` 행이 생긴다 | 빈칸 | B | — |
| I-T70 | ① | 역할을 토큰에 싣지 않고 요청마다 판정(소유자 결정… | ① `role`·`tid` 클레임이 없다 | 빈칸 | B | — |
| I-T70 | ② | 역할을 토큰에 싣지 않고 요청마다 판정(소유자 결정… | ② 캐시 적중 때 identity 호출이 없다 | 빈칸 | B | — |
| I-T70 | ③ | 역할을 토큰에 싣지 않고 요청마다 판정(소유자 결정… | ③ 캐시가 지워져 401이다 | 빈칸 | B | — |
| I-T70 | ④ | 역할을 토큰에 싣지 않고 요청마다 판정(소유자 결정… | ④ 503 `authz-unavailable`이다 | 빈칸 | B | — |
| I-T71 | ① | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ①은 I-T51과 같다( | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ② | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ②은 I-T51과 같다( … 거절, | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ③ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ③은 I-T51과 같다( … 거절, | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ④ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ④은 I-T51과 같다( … 거절, | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ⑤ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ⑤은 I-T51과 같다( … identity 밖 세션 쿠키 0). 실패 응답에는 이유가 없고 이유 범주는 서버 로그에만 있다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ⑥ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ⑥은 I-T51과 같다( | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ⑦ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ⑦은 인가 때와 같은 공개 출처의 콜백 주소로 코드를 교환한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ⑧ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ⑧은 이 앱의 쿠키를 지우고 503이다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T71 | ⑨ | 소비자 웹 로그인 경로(추천 적용 2026-11-03… | ⑨는 거절되고 세션이 그대로다. 같은 로그인 시도의 다시 보내기(gRPC 투명 재시도·메시 재시도)는 I-T50 ①이 본다. 앱 코드는 다시 보내지… | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T72 | ① | 재인증 결과 넘기기(추천 적용 2026-11-03… | ①은 Location·주소·`Referer`에 토큰이 없다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T72 | ② | 재인증 결과 넘기기(추천 적용 2026-11-03… | ②는 처음만 토큰을 주고 쿠키를 지운다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T72 | ③ | 재인증 결과 넘기기(추천 적용 2026-11-03… | ③은 거절된다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T72 | ④ | 재인증 결과 넘기기(추천 적용 2026-11-03… | ④는 토큰이 없다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T72 | ⑤ | 재인증 결과 넘기기(추천 적용 2026-11-03… | ⑤는 토큰 없이 거부 종류만 준다 | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| I-T73 | ② | 조사용 가명 키 회전의 이음(추천 적용 2026-11-05… | ②는 새 기기로 세지 않고 그 행이 새 판 값과 `device_ref_prev`(옛 판)를 갖는다. | 자동 시험 | B | 시험: services/identity-svc/test/inv-ref-rotation.test.ts |
| I-T73 | ③ | 조사용 가명 키 회전의 이음(추천 적용 2026-11-05… | ③은 EMAIL 행이 새 판이고 `ref_prev`가 옛 판이며 PHONE 행은 그대로다. | 자동 시험 | B | 시험: services/identity-svc/test/inv-ref-rotation.test.ts |
| I-T73 | ④ | 조사용 가명 키 회전의 이음(추천 적용 2026-11-05… | ④는 PHONE 행이 새 판과 옛 판을 갖는다. | 자동 시험 | B | 시험: services/identity-svc/test/inv-ref-rotation.test.ts |
| I-T73 | ⑤ | 조사용 가명 키 회전의 이음(추천 적용 2026-11-05… | ⑤는 두 판 값을 함께 싣는다. | 자동 시험 | B | 시험: services/identity-svc/test/inv-ref-rotation.test.ts |
| I-T73 | ⑥ | 조사용 가명 키 회전의 이음(추천 적용 2026-11-05… | ⑥은 옛 판 값과 다시 로그인하지 않은 기기의 옛 판 행이 없다. 이음 기간이 지나면 옛 판으로 계산하지 않는다 | 자동 시험 | B | 시험: services/identity-svc/test/inv-ref-rotation.test.ts |
| I-T74 | ① | 로그인한 기기 목록과 원격 로그아웃(추천 적용 2026-11-05… | ①은 세 줄(같은 기기는 한 줄, 지금 이 기기가 맨 앞, 나머지는 마지막 활동이 늦은 순)이고 줄마다 대표 세션 ID·기기 이름·마지막 활동·지금 이… | ID만 | B | 시험: apps/web/src/_pages/settings/model/state.test.mjs, apps/web/src/features/account-withdraw/flow.test.mjs 외 4곳 |
| I-T74 | ② | 로그인한 기기 목록과 원격 로그아웃(추천 적용 2026-11-05… | ②는 204이고 그 기기의 세션이 모두 끝나 세션마다 사건(reason `LOGOUT`)이 하나씩 적힌다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T74 | ③ | 로그인한 기기 목록과 원격 로그아웃(추천 적용 2026-11-05… | ③은 403 `reauth-required`다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T74 | ④ | 로그인한 기기 목록과 원격 로그아웃(추천 적용 2026-11-05… | ④는 기다리지 않고 모두 같은 404 `session-not-found`이며 아무 세션도 끝내지 않고 같은 재인증 토큰을 다시 쓸 수 있다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T74 | ⑤ | 로그인한 기기 목록과 원격 로그아웃(추천 적용 2026-11-05… | ⑤는 지금 세션만 남고 같은 기기의 다른 세션이 끝나며(`LOGOUT`), 다시 끄면 끝낼 것이 없어 404다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T74 | ⑥ | 로그인한 기기 목록과 원격 로그아웃(추천 적용 2026-11-05… | ⑥은 401이다 | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T75 | ① | 로그인 수단을 바꾸면 다른 세션을 끝낸다(추천 적용… | ①는 그 요청의 세션 말고 그 계정의 살아 있는 세션이 모두 끝나고 세션마다 사건(reason `LOGIN_METHOD_CHANGED`)이 연결·해제 사건보다… | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T75 | ② | 로그인 수단을 바꾸면 다른 세션을 끝낸다(추천 적용… | ②는 그 요청의 세션 말고 그 계정의 살아 있는 세션이 모두 끝나고 세션마다 사건(reason `LOGIN_METHOD_CHANGED`)이 연결·해제 사건보다… | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T75 | ③ | 로그인 수단을 바꾸면 다른 세션을 끝낸다(추천 적용… | ③은 아무 세션도 끝내지 않는다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T75 | ④ | 로그인 수단을 바꾸면 다른 세션을 끝낸다(추천 적용… | ④는 대표 계정의 세션 가운데 제안한 세션만 남고(흡수 계정이 제안했으면 대표 계정의 세션이 모두 끝나고) 흡수 계정의 세션은 `MERGED`다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T75 | ⑤ | 로그인 수단을 바꾸면 다른 세션을 끝낸다(추천 적용… | ⑤는 그 로그인으로 만든 세션만 남고, 기기 한도를 넘었어도 다른 세션은 모두 `LOGIN_METHOD_CHANGED`다. 모든 경우 세션 끝내기는 트랜잭션에서… | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| I-T76 | ① | 화면용 기기 이름(추천 적용 2026-11-05, BUILD_ORDER… | ①은 정해진 낱말의 '브라우저 · 운영체제'만 남고(모르면 null, 하나만 알면 그것만) 판 번호와 원문 글이 DB에 없다. | ID만 | B | 시험: services/identity-svc/test-int/device-sessions.int.test.ts, services/identity-svc/test/device-sessions.test.ts 외 1곳 |
| I-T76 | ② | 화면용 기기 이름(추천 적용 2026-11-05, BUILD_ORDER… | ② 뒤에는 그 세션의 기기 이름이 비어 있다 | ID만 | B | 시험: services/identity-svc/test-int/device-sessions.int.test.ts, services/identity-svc/test/device-sessions.test.ts 외 1곳 |
| I-T76 | ③ | 화면용 기기 이름(추천 적용 2026-11-05, BUILD_ORDER… | ③ 뒤에는 그 세션의 기기 이름이 비어 있다 | ID만 | B | 시험: services/identity-svc/test-int/device-sessions.int.test.ts, services/identity-svc/test/device-sessions.test.ts 외 1곳 |
| I-T77 | ① | 팬 계정 요약(추천 적용 2026-11-09, BUILD_ORDER… | ①가입 전 계정은 닉네임 null·`signupCompleted` false다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T77 | ② | 팬 계정 요약(추천 적용 2026-11-09, BUILD_ORDER… | ②가입을 마치면 닉네임과 `signupCompleted` true다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T77 | ③ | 팬 계정 요약(추천 적용 2026-11-09, BUILD_ORDER… | ③ 본인확인을 마치면 `verified` true다(토큰의 `ticket:buy`와 같은 출처) | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T77 | ④ | 팬 계정 요약(추천 적용 2026-11-09, BUILD_ORDER… | ④ 스태프 배정은 포트의 값이다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T77 | ⑤ | 팬 계정 요약(추천 적용 2026-11-09, BUILD_ORDER… | ⑤ 응답에 이메일·휴대폰 번호·회원 코드가 없고 `Cache-Control: no-store`다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts |
| I-T77 | ⑥ | 팬 계정 요약(추천 적용 2026-11-09, BUILD_ORDER… | ⑥ 세션이 끝났으면 401이다(인증 없는 요청도 401) | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T78 | ① | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ① 끝낸 까닭마다 그 세션의 쿠키로 갱신하면 401에 `ended`가 그 값이다(LOGOUT·REFRESH_REUSE·DEVICE_LIMIT·MERGED·DELE… | 자동 시험 | B | 시험: services/identity-svc/test/session-ended.test.ts |
| I-T78 | ② | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ② 재사용을 찾아낸 응답은 `REFRESH_REUSE`다 | 자동 시험 | B | 시험: services/identity-svc/test/session-ended.test.ts |
| I-T78 | ③ | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ③ 모르는 토큰·모양이 틀린 토큰·쿠키 없음·유휴 만료는 칸이 없다 | 자동 시험 | B | 시험: services/identity-svc/test/session-ended.test.ts |
| I-T78 | ④ | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ④ 화면은 갱신 거절의 `ended`로 `/login?next=&ended=`에 보낸다(허용 목록에 없는 값은 싣지 않는다, 한 번 쓰면 지운다) | 자동 시험 | B | 시험: apps/web/src/shared/lib/token-refresh.test.mjs, services/identity-svc/test/session-ended.test.ts |
| I-T78 | ⑤ | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ⑤ 계약 모양 가짜 API도 같다 | 자동 시험 | B | 시험: apps/web/scripts/mock-api.test.mjs |
| I-T78 | ⑥ | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ⑥ 실제 경로의 401 본문에도 같은 칸이 있다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts |
| I-T78 | ⑦ | 세션 종료 사유를 갱신 401로 알린다(추천 적용 2026-11-09… | ⑦이미 끝난 세션을 다시 끝내도 첫 까닭이 남는다 | 자동 시험 | B | 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/session-ended.test.ts |
| I-T79 | ① | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ①만 14세 확인·필수 동의·닉네임으로 마치면 `age_verified`와 동의 행(고지 문안 판·서버 시각), 회원 코드가 쓰이고 새 요약이 온다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T79 | ② | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ② 선택 동의는 그때만 행이 생긴다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T79 | ③ | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ③ 동의 없는 휴대폰 번호·필수 동의 없음은 400이다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts |
| I-T79 | ④ | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ④ 다시 보내면 409 `signup-already-completed`다 | ID만 | B | 시험: apps/web/scripts/mock-api.test.mjs, services/identity-svc/test-int/fan-account.int.test.ts 외 2곳 |
| I-T79 | ⑤ | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ⑤ 같은 계정이 동시에 두 번 보내도 하나만 성공한다(PostgreSQL) | 자동 시험 | B | 시험: services/identity-svc/test-int/fan-account.int.test.ts |
| I-T79 | ⑥ | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ⑥ 응답은 `no-store`다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts |
| I-T79 | ⑦ | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ⑦만 14세 미만으로 정리 중인 계정은 403 `under-14`다 | 자동 시험 | B | 시험: apps/web/scripts/mock-api.test.mjs, services/identity-svc/test/fan-account-http.test.ts 외 1곳 |
| I-T79 | ⑧ | 가입 마무리(추천 적용 2026-11-09, BUILD_ORDER… | ⑧ 동의 행의 판은 문서의 시행일이다 | 자동 시험 | B | 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T80 | ① | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ① 규칙(길이·허용 글자·이모지·결합 표시·보이지 않는 글자)을 어기면 invalid, 화면 규칙과 같은 값이다. 보이지 않는 글자는 유니코드… | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T80 | ② | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ② 대소문자·전각이 다른 같은 닉네임은 taken이다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T80 | ③ | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ③가입 마무리에서 같은 키는 409 `nickname-taken`이다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T80 | ④ | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ④ 동시에 같은 닉네임을 보내면 한쪽만 성공한다(PostgreSQL) | 자동 시험 | B | 시험: services/identity-svc/test-int/fan-account.int.test.ts |
| I-T80 | ⑤ | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ⑤ 세션마다 31번째 요청은 429와 `Retry-After`다 | 자동 시험 | B | 시험: services/identity-svc/test-int/nickname-check-limits.int.test.ts, services/identity-svc/test/fan-account-http.test.t… |
| I-T80 | ⑥ | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ⑥ 탈퇴·흡수로 닉네임이 지워지면 그 키를 다시 쓸 수 있다 | 자동 시험 | B | 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T80 | ⑦ | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ⑦ 닉네임은 본문으로만 받는다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts |
| I-T80 | ⑧ | 닉네임 확인과 중복 키(추천 적용 2026-11-09… | ⑧ 세션이 끝났으면 401이다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T81 | ① | 만 14세 미만 가입 취소(추천 적용 2026-11-09… | ①가입 전 계정이면 정리 사유 UNDER_14로 표시되고 그 계정의 세션이 모두 끝나며 204와 팬 쿠키 지우기다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T81 | ② | 만 14세 미만 가입 취소(추천 적용 2026-11-09… | ②가입을 마친 계정이면 409 `signup-already-completed`다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account-http.test.ts, services/identity-svc/test/fan-account.test.ts |
| I-T81 | ③ | 만 14세 미만 가입 취소(추천 적용 2026-11-09… | ③ 세션이 끝났으면 401이다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T82 | ① | 가입 전 계정 치우기(추천 적용 2026-11-09… | ①만든 지 30일이 지나고 살아 있는 세션이 없는 가입 전 계정만 지운다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T82 | ② | 가입 전 계정 치우기(추천 적용 2026-11-09… | ② 30일이 안 됐거나 세션이 살아 있거나 가입을 마친 계정은 그대로다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T82 | ③ | 가입 전 계정 치우기(추천 적용 2026-11-09… | ③ 지우면 프로필·동의 행·로그인 수단이 사라진다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T82 | ④ | 가입 전 계정 치우기(추천 적용 2026-11-09… | ④ 본인확인을 마친 계정은 지우지 않는다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T82 | ⑤ | 가입 전 계정 치우기(추천 적용 2026-11-09… | ⑤ 본인확인 여부를 모르면 지우지 않는다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |
| I-T82 | ⑥ | 가입 전 계정 치우기(추천 적용 2026-11-09… | ⑥ 한 계정이 실패해도 나머지를 다루고 끝에 실패를 알린다 | 자동 시험 | B | 시험: services/identity-svc/test/fan-account.test.ts |

## docs/security/asvs/auth.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/result-files.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs, apps/web/src/_pages/queue-verify/model/verify-fl… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: apps/console-host, apps/partner, apps/web… |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | 자동 시험 | B | 시험: services/identity-svc/test/http.test.ts |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: apps/console-host, apps/partner, apps/web… |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs, apps/web/server/csp-hash-server.test.mjs 외 2곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/web) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | B | 시험: apps/web/src/_app/security/page-headers.test.mjs |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/queue-svc/test/leave-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 해당 없음 | B | 해당 없음: 로그인은 창을 열지 않고 리디렉션(브라우저를 다른 주소로 보내는 응답)으로 이동하므로 받는 창 메시지가 없다(docs/features/identity.md §2). 로그인에 팝업 창을 쓰게 되면 다시… |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | 자동 시험 | B | 시험: apps/web/queue-room/test/verify-return.test.mjs, apps/web/src/_pages/login/model/state.test.mjs 외 4곳 |
| v5.0.0-3.3.5 | — | L3 | 쿠키를 쓸 때 쿠키 이름과 값의 길이 합이 4,096바이트를 넘지 않게 한다(넘으면 브라우저가 저장하지 않아 그 쿠키에 기대는 기능을 쓸 수 없다). | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-6.1.1 | — | L1 | 레이트 리밋·자동화 방지·적응형 대응 같은 통제가 크리덴셜 스터핑과 비밀번호 무차별 대입을 어떻게 막는지 문서에 정한다. 통제를 어떻게 설정하는지와 악의적 계정… | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts |
| v5.0.0-6.1.2 | — | L2 | 비밀번호로 쓸 수 없는 서비스 관련 단어 목록을 문서화한다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| v5.0.0-6.1.3 | — | L2 | 인증 경로가 여럿이면 모든 경로와, 모든 경로에 일관되게 적용할 보안 통제·인증 강도를 함께 문서화한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-6.2.1 | — | L1 | 비밀번호 최소 길이를 8자 이상(15자 권장)으로 강제한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.2.2 | — | L1 | 사용자가 자신의 비밀번호를 자율적으로 변경할 수 있어야 한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, services/identity-svc |
| v5.0.0-6.2.3 | — | L1 | 비밀번호 변경 시 기존 비밀번호와 신규 비밀번호를 모두 검증한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.2.4 | — | L1 | 가입 및 변경 시 널리 쓰이는 취약 비밀번호 상위 3,000개와 대조 차단한다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| v5.0.0-6.2.5 | — | L1 | 불필요하고 복잡한 문자 종류 강제 조합 규칙을 부과하지 않는다. | 빈칸 | B | 영역: packages/validation |
| v5.0.0-6.2.6 | — | L1 | 비밀번호 입력 필드는 `type="password"`로 은폐하며 마스킹 해제 토글을 지원한다. | 빈칸 | B | 영역: packages/ds |
| v5.0.0-6.2.7 | — | L1 | 붙여넣기 기능, 브라우저 비밀번호 관리자 및 외부 크리덴셜 매니저 연동을 전면 허용한다. | 빈칸 | B | 영역: packages/ds |
| v5.0.0-6.2.8 | — | L1 | 입력된 비밀번호를 임의로 자르거나 대소문자를 왜곡 변환하지 않고 원문 그대로 검증한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.2.9 | — | L2 | 최소 64자 이상의 긴 비밀번호 입력을 온전히 수용한다. | 빈칸 | B | 영역: packages/validation |
| v5.0.0-6.2.10 | — | L2 | 주기적인 비밀번호 변경을 사용자에게 불필요하게 강제하지 않는다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.2.11 | — | L2 | 문서화된 서비스 맥락 단어 목록으로 추측하기 쉬운 비밀번호가 만들어지지 않게 한다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-password.test.ts |
| v5.0.0-6.2.12 | — | L2 | 가입 및 변경 시 기 유출된 비밀번호 데이터베이스와 실시간 대조 검증한다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-login.test.ts, services/identity-svc/test/admin-password-change.test.ts |
| v5.0.0-6.3.1 | — | L1 | 명세서에 정의된 크리덴셜 스터핑 및 무차별 대입 방어 통제를 시스템에 구현한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-login.int.test.ts, services/identity-svc/test/admin-login-http.test.ts 외 3곳 |
| v5.0.0-6.3.2 | — | L1 | 기본 계정(root, admin 등)이 없거나 비활성화되어 있다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-6.3.3 | — | L2 | 애플리케이션 접근에는 다중 요소 인증이나 단일 요소 인증의 조합을 요구하고(L3는 피싱에 강하고 사용자 동작을 요구하는 하드웨어 요소 포함), 이를 완화하려면… | 자동 시험 | B | 시험: services/identity-svc/test/admin-passkey-http.test.ts, services/identity-svc/test/admin-totp.test.ts 외 1곳 |
| v5.0.0-6.3.4 | — | L2 | 인증 경로가 여럿이면 문서에 없는 경로가 없게 하고, 모든 경로에 같은 보안 통제와 인증 강도를 일관되게 적용한다. | 빈칸 | B | 영역: apps/web, services/identity-svc |
| v5.0.0-6.4.1 | — | L1 | 시스템이 자동 발급하는 초기 비밀번호 및 활성화 코드는 CSPRNG 난수와 짧은 만료 기한을 적용한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.4.2 | — | L1 | 비밀번호 힌트 기능이나 비밀 질문 복구 방식을 일절 사용하지 않는다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.4.3 | — | L2 | 비밀번호 재설정 절차가 기존 다중 요소 인증(MFA) 검증 단계를 우회하지 않도록 보장한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.4.4 | — | L2 | 다중 인증 수단을 분실한 경우 최초 등록 단계와 동등한 수준으로 신원을 재검증한다. | 자동 시험 | B | 시험: services/identity-svc/test/passkey-cases.ts |
| v5.0.0-6.5.1 | — | L2 | 조회용 비밀값, 대역 외 인증 요청·코드, TOTP는 한 번만 성공적으로 쓸 수 있다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-unlock.int.test.ts, services/identity-svc/test/admin-totp.test.ts 외 1곳 |
| v5.0.0-6.5.2 | — | L2 | 엔트로피가 112비트 미만인 조회용 비밀값은 백엔드에 저장할 때 32비트 난수 솔트를 넣은 승인된 비밀번호 저장용 해시로 저장하고, 112비트 이상이면 일반… | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.5.3 | — | L2 | 조회용 비밀값, 대역 외 인증 코드, TOTP 시드는 CSPRNG로 만든다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-6.5.4 | — | L2 | 조회용 비밀값과 대역 외 인증 코드는 20비트 이상의 엔트로피를 갖는다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-6.5.5 | — | L2 | 대역 외 인증 요청·코드·토큰과 TOTP에 수명을 정하고, 대역 외 요청은 최대 10분, TOTP는 최대 30초로 한다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-totp.test.ts |
| v5.0.0-6.6.1 | — | L2 | 전화·SMS로 일회용 코드를 보내는 인증은 미리 검증한 번호에만, 더 강한 수단과 함께, 보안 위험을 알리며 제공하고, L3에서는 제공하지 않는다. | 해당 없음 | B | 해당 없음: SMS 기반 인증을 전혀 쓰지 않으며 TOTP와 패스키만 지원한다 |
| v5.0.0-6.6.2 | — | L2 | 대역 외 인증 요청·코드·토큰은 만들어진 원래 인증 요청에 묶이고 앞뒤 다른 요청에 쓸 수 없다. | 해당 없음 | B | 해당 없음: 팬·관리 계정 로그인은 대역 외 인증을 쓰지 않는다. 스캐너 기기 승인의 확인 코드는 offline-gate.md 6.6.2가 판정한다 |
| v5.0.0-6.6.3 | — | L2 | 코드 기반 대역 외 인증은 레이트 리밋으로 무차별 대입을 막는다(64비트 이상 코드도 고려). | 해당 없음 | B | 해당 없음: 팬·관리 계정 로그인은 대역 외 인증을 쓰지 않는다. 스캐너 기기 승인의 확인 코드 시도 제한은 offline-gate.md 6.6.3이 판정한다(identity I-T37) |
| v5.0.0-6.8.1 | — | L2 | 복수의 IdP를 지원하면 다른 IdP를 통해(예: 같은 사용자 식별자로) 사용자를 사칭할 수 없어야 한다. 표준 완화책은 `(IdP, IdP_User_ID)`… | 자동 시험 | B | 시험: services/identity-svc/test/session-cases.ts |
| v5.0.0-6.8.2 | — | L2 | 소셜 제공자가 전달한 인증 어서션(ID 토큰 등)의 전자서명을 수신 즉시 무조건 검증한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-6.8.3 | — | L2 | SAML 어서션은 유효 윈도우 내에서 단 1회만 소비되도록 보장한다. | 해당 없음 | B | 해당 없음: SAML 프로토콜 미사용 |
| v5.0.0-6.8.4 | — | L2 | 요구되는 인증 강도를 IdP 클레임(`acr`·`amr`·`auth_time`)으로 확인하며 미제공 시 최저 강도로 간주한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test/session-cases.ts |
| v5.0.0-6.3.5 | — | L3 | 미등록 신규 기기 접속 등 의심스러운 인증 시도를 감지하여 사용자에게 보안 알림을 발송한다. | 빈칸 | B | 영역: services/core-svc, services/identity-svc |
| v5.0.0-6.7.2 | — | L3 | 암호 인증의 챌린지 난수는 64비트 이상이고, 통계적으로 고유하거나 그 인증기를 쓰는 동안 고유하다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-passkey.int.test.ts, services/identity-svc/test/passkey-cases.ts |
| v5.0.0-7.1.1 | — | L2 | 세션 유휴 만료와 절대 만료를 다른 통제와 함께 봐도 적절하게 정해 문서화하고, NIST SP 800-63B 재인증 기준과 다른 점의 근거를 적는다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-7.1.2 | — | L2 | 계정당 동시 세션 수와 한도 도달 때의 동작을 문서화한다. | 자동 시험 | B | 시험: services/identity-svc/test/device-sessions.test.ts |
| v5.0.0-7.1.3 | — | L2 | SSO 같은 연합 인증 환경에서 사용자 세션을 만들고 관리하는 모든 시스템과, 세션 수명·종료·재인증 조건을 서로 맞추는 통제를 문서화한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-7.2.1 | — | L1 | 세션 토큰 검증을 신뢰할 수 있는 백엔드에서 한다. | 빈칸 | B | 영역: apps/web |
| v5.0.0-7.2.2 | — | L1 | 세션은 동적으로 만든 토큰으로 관리하고 고정 API 키를 쓰지 않는다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-7.2.3 | — | L1 | 사용자 세션에 참조 토큰을 쓰면 CSPRNG로 만든 엔트로피 128비트 이상의 고유한 값으로 한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-7.2.4 | — | L1 | 인증·재인증 때 새 세션 토큰을 만들고 이전 토큰을 끝낸다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-token-refresh.int.test.ts, services/identity-svc/test/admin-token-refresh-http… |
| v5.0.0-7.3.1 | — | L2 | 위험 분석과 문서화한 보안 결정에 따라 유휴 만료를 두어 재인증을 요구한다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-token-refresh-http.test.ts |
| v5.0.0-7.3.2 | — | L2 | 위험 분석과 문서화한 보안 결정에 따라 절대 만료를 두어 재인증을 요구한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-7.4.1 | — | L1 | 로그아웃·만료로 세션이 끝나면 그 세션을 더 쓰지 못하게 하고, 참조 토큰·상태 저장 세션은 백엔드에서 무효화하며 자체 완결형 토큰은 종료 목록 등으로 거부한다. | 자동 시험 | B | 시험: packages/platform/test/auth-guard.test.ts, services/identity-svc/test-int/device-sessions.int.test.ts 외 7곳 |
| v5.0.0-7.4.2 | — | L1 | 계정이 정지·삭제되면 그 계정의 모든 활성 세션을 끝낸다. | 자동 시험 | B | 시험: services/identity-svc/test/admin-token-refresh-http.test.ts, services/identity-svc/test/http.test.ts |
| v5.0.0-7.4.3 | — | L2 | 인증 요소를 바꾸거나 지운 뒤 다른 세션을 모두 끝낼 수 있게 한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/device-sessions.int.test.ts, services/identity-svc/test-int/link-proposal.int.test.ts… |
| v5.0.0-7.4.4 | — | L2 | 로그인이 필요한 모든 화면에서 로그아웃 기능이 잘 보이고 쉽게 닿게 한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web |
| v5.0.0-7.4.5 | — | L2 | 관리자가 사용자별·전체 활성 세션을 끝낼 수 있다. | 빈칸 | B | 영역: services/identity-svc, services/ops-svc |
| v5.0.0-7.5.1 | — | L2 | 인증에 영향을 주는 민감 계정 정보를 바꾸기 전에 전체 재인증을 요구한다. | 자동 시험 | B | 시험: services/identity-svc/test/passkey-cases.ts |
| v5.0.0-7.5.2 | — | L2 | 사용자가 지금 활성인 세션을 보고, 인증 요소 하나 이상으로 다시 인증한 뒤 일부나 전부를 끝낼 수 있게 한다. | 자동 시험 | B | 시험: apps/web/src/_pages/settings/model/state.test.mjs, apps/web/src/features/device-sessions/flow.test.mjs 외 3곳 |
| v5.0.0-7.6.1 | — | L2 | 신뢰 당사자와 IdP 사이의 세션 수명·종료가 문서대로 동작하고, IdP 인증 간격이 최대 시간에 이를 때처럼 필요하면 재인증을 요구한다. | 빈칸 | B | 영역: apps/web |
| v5.0.0-7.6.2 | — | L2 | 사용자 동의나 명시적 동작 없이 세션을 만들지 않는다. | 빈칸 | B | 영역: apps/web |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/event-summary.http.test.ts, services/core-svc/test/partner-production.http.test.ts 외 3곳… |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-password-change.int.test.ts, services/identity-svc/test/admin-password-change.t… |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | 자동 시험 | B | 시험: services/queue-svc/test/leave-cases.ts |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | ID만 | B | 다른 곳 시험: packages/contracts/test/close-additional-properties.test.ts, packages/contracts/test/types.test.ts 외 6곳 (영역:… |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: apps/console-host… |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 4곳 (영역:… |
| v5.0.0-9.1.1 | — | L1 | 자체 완결형 토큰은 서명이나 MAC을 검증한 뒤에만 내용을 받아들인다. | 자동 시험 | B | 시험: packages/platform/test/purchase-auth.test.ts, packages/platform/test/token-verify.test.ts |
| v5.0.0-9.1.2 | — | L1 | 자체 완결형 토큰의 생성·검증에는 맥락별 허용 목록의 알고리즘만 쓰고(`none` 제외, 되도록 대칭·비대칭 중 한쪽만), 둘 다 써야 하면 키 혼동을 막는… | 자동 시험 | B | 시험: packages/platform/test/token-verify.test.ts |
| v5.0.0-9.1.3 | — | L1 | 검증 키는 미리 정한 신뢰 출처에서만 얻고 `jku`·`x5u`·`jwk` 헤더를 허용 목록으로 검증한다. | 자동 시험 | B | 시험: services/queue-svc/test/tokens.test.ts |
| v5.0.0-9.2.1 | — | L1 | 유효 기간이 있으면 검증 시각이 그 안일 때만 받는다(`nbf`·`exp`). | 자동 시험 | B | 시험: packages/platform/test/token-verify.test.ts |
| v5.0.0-9.2.2 | — | L2 | 토큰 종류와 목적이 맞는지 확인한 뒤 받는다. | 자동 시험 | B | 시험: packages/platform/test/token-verify.test.ts |
| v5.0.0-9.2.3 | — | L2 | 그 서비스를 위한 토큰(`aud`)만 받는다. | 자동 시험 | B | 시험: packages/platform/test/token-verify.test.ts |
| v5.0.0-9.2.4 | — | L2 | 같은 개인 키로 여러 대상에 토큰을 발급하면 대상을 고유하게 나타내는 대상 제한을 넣고, 대상 식별자를 동적으로 정하면 발급자가 그 대상을 검증해 대상 사칭을… | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts (영역: services/identity-svc) |
| v5.0.0-10.1.1 | — | L2 | 토큰은 꼭 필요한 구성요소에만 보낸다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.1.2 | — | L2 | 클라이언트는 같은 사용자 에이전트 세션에서 시작한 바로 그 인가 흐름의 값(인가 코드·ID 토큰)만 받고, 이를 위해… | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.2.1 | — | L2 | 코드 흐름을 쓰면 PKCE나 `state`로 CSRF를 막는다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.2.2 | — | L2 | 인가 서버가 여럿이면 혼동 공격을 막는다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.5.1 | — | L2 | OpenID Connect ID 토큰의 재사용 공격을 방어하기 위해 `nonce` 클레임을 엄격히 대조한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.5.2 | — | L2 | ID 토큰 내부의 불변 주체 식별자(`sub`)를 기반으로 이용자 계정을 고유하게 식별한다. | 자동 시험 | B | 시험: services/identity-svc/test/session-cases.ts |
| v5.0.0-10.5.3 | — | L2 | IdP 디스커버리 메타데이터의 `issuer` 값이 사전에 등록된 공인 설정값과 정확히 일치함을 검증한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.5.4 | — | L2 | 수신된 ID 토큰의 `aud` 클레임이 사전에 발급받은 시스템의 `client_id`와 일치함을 검증한다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-10.5.5 | — | L2 | OIDC 백채널 로그아웃 토큰의 디지털 서명과 유효성을 검증한다. | 해당 없음 | B | 해당 없음: 백채널 로그아웃 미사용 (소셜 세션과 내부 서비스 세션의 독립 운영 원칙) |
| v5.0.0-10.2.3 | — | L3 | 서비스 운영에 반드시 요구되는 최소한의 인가 스코프만을 선별하여 요청한다. | 빈칸 | B | 영역: apps/web |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test/quicknet-verifier.test.ts 외 1곳… |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: apps/console-host, apps/partner, apps/web… |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/payment-svc/test/portone-gateway.test.ts (영역:… |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/virtual-account-deposit.test.ts (영역: services/identity-svc) |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | ID만 | B | 다른 곳 시험: packages/shuffle/test/drand-seal.test.ts, services/admission-ctrl/test/kms-seed-opener.test.ts 외 3곳 (영역:… |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.te… |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역:… |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-totp.int.test.ts, services/identity-svc/test/admin-totp.test.ts |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역:… |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음: 비밀번호로부터 암호화 키를 파생하지 않는다 |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | ID만 | B | 다른 곳 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 5곳 (영역:… |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test-int/kms-seed.int.test.ts 외 4곳… |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-server.test.ts (영역: apps/console-host, apps/partner, apps/web… |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: apps/console-host, apps/partner, apps/web, services/identity-svc |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 13곳 (영역: apps/console-host, apps/partner… |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts (영역: apps/console-host, apps/partner, apps/web… |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.test.m… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts (영역:… |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역:… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, packages/platform/test-int/held-events.int.test.ts 외 15곳 (영역:… |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 자동 시험 | B | 시험: apps/web/queue-room/test/logout.test.mjs |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | 자동 시험 | B | 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account-http.test.ts 외 2곳 |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 자동 시험 | B | 시험: apps/web/queue-room/test/autoassign.test.mjs, apps/web/src/_pages/seats/model/storage.test.mjs |
