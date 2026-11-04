# 갈래 3 — 진행 상태

- **독자와 용도**: 갈래 3(병렬 세션)이 다음에 할 일, 구간 끝에 고칠 지적, 진행 로그를 적는다. 공용 턴 규칙과 미해결(소유자에게 물을 것)은 [docs/PROGRESS.md](../PROGRESS.md), 단계의 차례와 체크는 [docs/BUILD_ORDER.md](../BUILD_ORDER.md)가 정본이다(ADR-0189, ADR-0190 결정 3).
- **맡은 일**: BUILD_ORDER에서 줄 끝에 '갈래 3(루프는 건너뛴다)'가 붙은 단계다. 계정, 봇 방어, 대기열 기능, 입장, 커머스를 맡는다.
- **작업 폴더**: git worktree `D:/ticketpass-lane3`(처음이면 만든다). 단계마다 `develop`에서 `feature/<WBS ID>-<요약>` 가지를 따고, 끝나면 `develop`에 커밋 하나로 합친다(PROGRESS 턴 규칙 '갈래').
- **이 갈래가 고치는 기록**: 이 파일, BUILD_ORDER의 자기 줄 체크, 커밋 본문의 정합 점검 행이다. 3일 넘는 작업을 ①②로 나누면 그 나눔 글을 wbs.md·wbs.csv 설명 칸에 쓴다(wbs §3). R 표·요약 §4·wbs 상태 칸은 고치지 않는다(갈래 1이 `node tools/ci/records.mjs`로 맞춘다).

## 다음 할 일
- BOT-041(wbs 3.1.3 ②): 설정의 로그인 수단 연결·해제(재인증할 제공자 고르기와 `lastLoginAt`은 BOT-036이 넘긴 것). 그 뒤 BOT-042(계정 병합) → BOT-045 → BOT-110~160.
- 봇 시뮬레이터(BAS-250, 구간 2)는 이 세션이 만들 수 없을 수 있다(2026-11-03 안전 분류기에 막힘). 그 단계에 닿으면 하지 않고 docs/PROGRESS.md '미해결'에 OPEN 줄로 소유자에게 묻는다.

## 구간 끝 정리 목록
- 새 맥락 리뷰의 중간·낮은 지적 가운데 그 단계에서 고치지 않은 것을 '단계 ID: 지적 한 줄(파일)' 꼴로 적는다. 이 구간의 자기 단계를 다 끝낸 뒤 한 번에 고친다(ADR-0190 결정 2).
- BOT-010: 복귀 화면의 결과 확정이 401이고 갱신도 안 되면 `/login?next=/verify/return`으로 가 기관 값을 잃고 그 건은 처리 중으로 남는다. 로그인 next를 첫 화면으로 하거나 실패를 알리고 [다시 시도]로 안내한다(apps/web/src/features/identity-verify/flow.ts `runReturnFlow`)
- BOT-010: 결과의 `next`가 본인확인 부품이 없는 화면이면 탭 저장소 `peaket.verify.return`이 남아, 1일 안에 다른 화면에서 지난 결과 대화상자가 뜰 수 있다. 저장 시각과 짧은 기한을 둔다(flow.ts)
- BOT-010: 마이그레이션 0005의 '따로 트랜잭션' 주석은 운영 실행기(BAS-060)에서만 맞고, 로컬 Drizzle 실행기는 0004·0005를 한 트랜잭션으로 돌린다. 주석을 고치거나 검증 파일을 정비 시간 묶음으로 옮긴다(services/identity-svc/migrations/0005_verification_provider_down_validate.sql)
- BOT-010: demo에서 쓸 기관이 없다. 시험 어댑터는 demo에서 켜지는데(비밀 필수) 모의 기관은 local·ci에서만 돈다. 정본에 demo 기관을 정하거나 어댑터의 demo 허용을 뺀다(docs/features/identity.md §5, services/identity-svc/scripts/mock-idv.mjs)
- BOT-010: 쿼리로 돌려주는 기관이면 결과 값이 CDN·Envoy 접근 로그의 요청 줄에 남을 수 있다. `/verify/return`의 쿼리를 접근 로그에서 지우는 규칙을 정본에 적는다(docs/infra.md 접근 로그, HOT-290과 맞춘다)
- BOT-020: SCR-017에 '본인확인 전' 상태 미리보기가 없어 [지금 본인확인] 갈래를 화면에서 보지 못했다(퍼블리싱 목업 `ME`가 본인확인 완료). d5 §5.17 ①의 그 상태를 미리보기에 더한다(apps/web/src/shared/config/screens.account.ts `SCR017_STATES`, apps/web/src/_pages/settings)
- BOT-025: `GetVerificationStatus`가 읽기만 하는데 세션 줄을 잠근다(`getSessionForUpdate`). 잠그지 않는 세션 조회를 세션 저장소에 더한다(services/identity-svc/src/modules/session/application/get-verification-status.ts)
- BOT-025: pid 키 전환 작업이 KMS 호출 속도를 조절하지 않는다(100건씩 쉬지 않고). 운영 본인확인·관리자 로그인의 KMS 몫을 깎지 않게 초당 상한 선택지를 둔다(services/identity-svc/src/modules/verification/application/pid-rotation.ts)
- BOT-025: 두 pid 진입에서 옛 키가 다른 요청 값(대기 중·입장)으로 409일 때 그 값을 새 키에 최선 노력으로 옮겨 쓰는 변형 Lua를 둘지 본다(절차 규칙 '다 옮긴 뒤 15분 전에는 새 회차를 열지 않는다'를 어긴 경우의 덤, services/queue-svc/src/modules/entry/application/enter-queue.ts)
- BOT-030: 탈퇴 뒤 본인확인 기록 파기(둘째 트랜잭션)가 실패해 남은 기록이 있으면, 정비가 돌기 전에 같은 사람이 새 계정으로 본인확인할 때 409와 다른 계정 시도 기록이 잘못 남는다. 중복 판정에서 주인이 탈퇴한 계정이면 그 자리에서 지우고 다시 판정한다(services/identity-svc/src/modules/verification/application/confirm-verification.ts)
- BOT-030: 정비 withdrawal-finish가 매일 `account` 표 전체를 읽는다. 정리 중·탈퇴한 계정의 부분 인덱스를 트랜잭션 밖 `CREATE INDEX CONCURRENTLY` 파일로 더한다(운영 실행기 BAS-060 뒤, docs/devops.md §7.2)
- BOT-010: 늦은 메시지를 듣는 10분 타이머를 `cancel()` 때 지우지 않는다(해는 없고 메모리를 잠깐 잡는다), 브라우저의 Web Locks 연결(`refreshLock`)을 직접 보는 시험이 없다(flow.ts, browser.ts)
- BOT-036: 재인증 버튼이 토큰 갱신을 기다리는 동안 처리 중 표시·연타 막기가 없고, 그사이 창을 닫아도 갱신이 끝나면 제공자로 넘어간다. 처리 중 상태와 `aria-disabled`를 두고 닫으면 이동을 취소한다(apps/web/src/_pages/settings/ui/SettingsFlows.tsx `confirmReauth`)
- BOT-036: 떠나기 전 갱신이 네트워크 오류·5xx여도 로그인 화면으로 보낸다. 401(갱신 거절)일 때만 로그인, 나머지는 '잠시 뒤 다시'로 안내하고 정본 문장도 401로 좁힌다(features/account-withdraw/flow.ts `refresh`, docs/features/identity.md §8 '탈퇴 화면 연결')
- BOT-036: `/reauth/token` 응답에 `provider`가 없으면 제공자가 비어 403 뒤 재인증 창이 목업 분기로 빠져 되풀이된다(지금 서버는 늘 싣는 숨은 결함). 비면 `pickProvider()`로 채우고 실제 모드 탈퇴 목적은 목업으로 빠지지 않게 한다(SettingsFlows.tsx)
- BOT-036: 403 `reauth-required`는 만료 말고 이미 쓴 토큰·계정 불일치·탈퇴할 수 없는 상태에서도 오는데 늘 '5분이 지났습니다'를 보인다. 문구를 '확인이 만료되었거나 이미 쓰였습니다'처럼 넓히고, `reverify-required` 전용 문구를 정본에 적거나 하나로 합친다(flow.ts `reauthFailureText`, docs/features/identity.md §8)
- BOT-036: 저장소 표의 `peaket.withdraw.reauth` 줄 '지우는 때'에 로그아웃이 없고(§5.14.4 정리 루틴이 지우지 않아 같은 탭의 다른 계정에 묻지 않은 재인증 실패 창이 뜰 수 있다) 수명은 '탭(믿는 시간 10분)'이다(docs/frontend.md §3.12, 로그아웃 정리 루틴)
- BOT-036: 미리보기 상태 고르기가 클라이언트 이동이라 `SettingsFlows` 상태(창·목적·토큰)가 남아 목업과 실제 흐름이 섞인다(개발 서버만). `key={state}`를 붙인다(apps/web/src/_pages/settings/ui/SettingsPage.tsx)
- BOT-040: '새 계정 만들기'의 응답을 잃고 같은 멱등 키로 다시 보내면 제안이 이미 지워져 404다. 다시 보내기를 받으려면 제안을 지우기 전에 만든 세션을 멱등 키로 찾아 같은 세션을 돌려주거나, 제안을 '쓴 것'으로 표시해 잠시 남긴다(services/identity-svc/src/modules/session/application/separate-account.ts, apps/web keys.ts `separateKeyOf` 주석)

## 진행 로그
- 2026-11-04 갈래 파일을 만들었다(ADR-0190 결정 3).
- 2026-11-04 BOT-010 모의 기관과 기관 창 흐름(R-267, I-T45): 서명한 결과만 믿는 시험 어댑터·모의 기관, 결과 때 기관 장애는 PROVIDER_DOWN으로 마침, 부르는 화면의 실제 창 흐름(팝업·차단 대체·REDIRECT, 받은 표시, 늦은 메시지, 갱신 잠금), 복귀 화면 처리기(proxy.ts, COOP unsafe-none), 로컬 게이트웨이 대역. 브라우저 확인은 Playwright로 대신(Chrome 연결 없음).
- 2026-11-04 BOT-020 키 판·만 14세·다른 계정 시도·재통과(R-269, I-T42·I-T55·I-T65): 연계정보 키 판(KMS·설정값, 쓰기 판, 시작 때 판 확인), 만 14세 미만 UNDER_14와 계정 정리 시작, 다른 계정 시도 기록, REVERIFY 재통과. BOT-020을 둘로 나눠 pid 키 전환은 BOT-025로 뒀다.
- 2026-11-04 BOT-025 pid 키 전환과 두 키 1인 1순번(R-273, I-T49·Q-T45): identity 전환 작업(전환 기록, 이어 하기, 끝 시각 뒤 pid_prev 지우기)과 GetVerificationStatus(previous_pid), queue-svc 옛 pid → 새 pid 차례의 두 키 진입·입장 확정과 옮겨 쓰기. 화면이 없어 브라우저 확인은 하지 않았다.
- 2026-11-04 BOT-030 탈퇴 첫 구현(R-276, I-T16·I-T27·I-T8): 재인증 토큰 1회 사용, 계정·로그인 수단·기기·본인확인 기록 파기와 세션 종료(DELETE), 연계정보 처리 기록 1년 보존 스키마, 정비 다섯(만 14세 미만 정리 마무리 포함), 정리 중 계정의 구매 권한 빼기, 끝난 세션의 리프레시 토큰 해시 지우기. 나머지는 BOT-035로 나눴다.
- 2026-11-04 BOT-035 이용 제한 중 탈퇴의 대조값 보관(R-278, I-T68): `SetRestrictedCiHold`(판 비교·RELEASED 지우기·탈퇴한 계정의 행), 탈퇴 409 `fraudHold`와 같은 재인증 토큰으로 다시 보내기, 다시 가입한 계정에 잇기·`restrictedUntil`·제한 끝까지 구매 권한 빼기, 정비 지우기. BOT-035를 셋으로 나눠 화면 연결은 BOT-036, 대기열 키는 BOT-037로 뒀다.
- 2026-11-04 BOT-036 탈퇴 화면 연결(R-281, I-T16·I-T68 ⑨): SCR-017 탈퇴를 재인증(`POST /reauth/{provider}` → `POST /reauth/token`, 토큰은 메모리에만)과 실제 `DELETE /v1/identity/account`에 잇고(409 fraudHold 안내 뒤 같은 토큰으로 다시, 403이면 재인증 실패), 로그인 수단 목록 API를 더했다. 브라우저 확인은 Playwright로 대신(세 시나리오 통과).
- 2026-11-04 BOT-037 탈퇴 계정의 대기열 키 지우기(R-283, I-T27): 계정 탈퇴 트랜잭션이 계정을 잠근 뒤 읽은 pid(전환 기간이면 옛 pid도)를 실은 탈퇴 사건 `identity.accounts-withdrawn`(asyncapi·Avro `AccountWithdrawn`, `purgeBy` = 탈퇴 + 5일)을 세션 종료 사건 뒤 Outbox에 적고, queue-svc 처리기가 진행 중인 회차마다 `q:dup`·`q:adm`에 `PEXPIREAT … LT`를 건다. 토픽 보존 3일·조각 1일 [가정]. Kafka 구독·보류 사건 정리·15분 뒤 처리는 HOT-010.
- 2026-11-04 BOT-040 가입 때 계정 연결 제안(R-286, I-T29·I-T30): BOT-040을 셋으로 나눴다(①은 이것, ② BOT-041 설정 연결·해제, ③ BOT-042 병합). 같은 검증 이메일의 활성 계정이 하나면 `CreateSession`이 세션 대신 연결 제안(세션·캐시 Redis `id:link`, 10분, 묶음 값은 해시만)을 주고, 앱 서버가 `__Host-peaket_link`에 봉인해 SCR-039로 보낸다. 기존 제공자 로그인이 대상 계정이면 새 제공자를 잇고 연결 성공 화면을 거쳐 처음 주소로, 다른 계정이면 3회까지 남은 시도를 보이고 만료한다. 새 계정 만들기(`SeparateAccount`)·제안 조회(`GetLinkProposal`), `account.email_verified`(마이그레이션 0011).
