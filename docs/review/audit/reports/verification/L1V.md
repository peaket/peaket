# L1V — R-608·R-618·R-619 독립 검증 보고

- 작업 위치: `D:\ticketpass-lane1`
- 브랜치 / HEAD: `wave/lane1-audit-m5` / `2157f0f6`
- 검증자: 수정 에이전트와 분리된 독립 세션
- 판정: **부분 통과(partial)**

## 1. 판정 요약

세 커밋의 핵심 코드 경로는 대부분 의도대로 동작한다. 내부 gRPC 토큰(없음/틀림/맞음), ApplyLabel의 호출자·`acted_by` 증명, 재인증 jti 1회용 저장소, mTLS `MTLS_CERT` 결속, R-618 초안 배너·자리표시자 숨김, R-619 비활성 계정 승인 차단은 임시 탐침으로 확인했다.

그러나 **R-608의 재인증 jti는 운영 배선에서 fail-open**이다. Redis 주소가 없으면 `ReauthJtiStore` 자체를 만들지 않아 `if (this.#jti && ...)`가 검사를 통째로 건너뛴다. `UnavailableReauthJtiStore`는 만들어 두고 아무 곳에서도 쓰지 않는다. 또 세 커밋 모두 **새 테스트도, 기존 테스트 수정도 없다**. 변이 10개 중 기존 시험이 잡은 것은 ticket 통합 시험 1개뿐이고, 나머지 9개는 기존 시험을 모두 통과했다(임시 탐침이 9개를 잡음). R-618의 noindex는 초안에 묶여 있지 않고 루트 전역 noindex에만 의존한다.

## 2. 결함·위험 (근거)

### [높음] R-608 — 운영에서 재인증 jti 1회용이 꺼진다(fail-open)

- `services/ops-svc/src/main.ts:65,75` — `PEAKET_REAUTH_REDIS_URL`이 있을 때만 `RedisReauthJtiStore`를 넣는다.
- `services/payment-svc/src/start.ts:231` — 같은 조건.
- `services/core-svc/src/main.ts:31,85` — `PEAKET_QUEUE_REDIS_URL`이 있을 때만 넣는다.
- `services/core-svc/src/modules/export/adapters/sources.ts:40`, `services/ops-svc/src/modules/payouts/adapters/jwks-approval-verifier.ts:28`, `services/payment-svc/src/modules/settlement/adapters/jwks-reauth-verifier.ts:38` — 모두 `if (this.#jti && !(await this.#jti.claim(...)))` 형태라 저장소가 없으면 검사하지 않는다.
- `packages/platform/src/reauth-jti.ts:38-42` — `UnavailableReauthJtiStore`가 있으나 배선되지 않았다. 같은 파일 2~3줄 주석은 "Redis가 없거나 실패하면 닫힌 쪽(사용 불가)으로 본다"고 하는데 실제 조립은 열린 쪽이다.
- `docs/PROGRESS.md:221`도 `PEAKET_REAUTH_REDIS_URL` Secret 주입이 "남은 몫"임을 인정한다. 즉 이 env가 주입되지 않은 배포에서는 같은 재인증 토큰을 5분 안에 다시 쓸 수 있다. SEC-03은 저장소 구현 수준에서는 닫혔지만, 운영 조립과 회귀 시험이 없어 "닫힘"으로 보기 어렵다.

### [높음] 세 커밋 모두 회귀 시험이 없다 — 변이 10개 중 기존 시험 검출 1개

- `git diff --name-only b0b6298c 2157f0f6 -- "*test*"` 결과가 비어 있다. 새 테스트 파일 추가 없음, 기존 테스트 수정 없음.
- 따라서 "시험 작성자 분리 원칙 위반"(새 테스트를 수정 에이전트가 추가)은 **아니다**. 다만 새 보안·법무 동작의 회귀 그물도 없다.
- 변이 표 참조: 내부 토큰 검사 제거, 호출자 검사 제거, jti 재사용, ScannerGuard 자격 종류 비교 제거, ApplyLabel 증명 제거, R-618 초안 배너 제거·자리표시자 복원, R-619 메모리 비활성 차단 제거는 기존 시험이 모두 통과했다. ticket `scanner-device-lookup.int.test.ts`만 자격 종류 불일치를 실제 기기로 검증해 lookup 변이를 잡았다.

### [중간] R-608 — core·ops는 내부 gRPC 토큰 미설정 시 시작이 막히지 않는다

- `internalGrpcTokenFromEnv` 호출은 identity(`services/identity-svc/src/main.ts:141`), ticket(`services/ticket-svc/src/start.ts:50`), payment(`services/payment-svc/src/start.ts:122`), purchase(`services/purchase-svc/src/start.ts:230`), trust(`services/trust-svc/src/main.ts:40`)에만 있다.
- core·ops는 gRPC **클라이언트**인데 `internalGrpcTokenFromEnv`를 부르지 않는다. 토큰이 없으면 `createGrpcClient`가 헤더를 싣지 않고(`packages/platform/src/grpc-channel.ts:159-160`), 운영에서 identity AdminAuthz·ticket ScannerDevice·purchase EventRefund 호출이 런타임에 거절된다. 커밋 메시지의 "그 밖의 환경은 시작할 때 없으면 실패한다"는 서버를 여는 5개 서비스에만 참이다.

### [중간] R-608 — 내부 gRPC 보호 범위가 5개 서비스로 부분적이다

- 보호 대상: identity `AdminAuthzService`, ticket `ScannerDeviceService`, payment `CompensationTransferService`, purchase `EventRefundService`, trust `TrustLabelService`.
- 보호되지 않는 내부 gRPC: identity `SessionService`·`IdentityService`·`AccountHoldService`·`ContactRefService`·`InvestigationRefService`·`AdminAccountService`·`AdminDesignationService`·`RestrictedCiHoldService`·`ReverificationCheckService`·`ScannerSessionCheckService`, ticket `TicketService`·`ScannerDeviceLookupService`, trust `TrustService`·`TrustEvidenceService`, payment `PaymentService`, purchase `PriorityPurchaseService`·`BookingRestrictionService`, queue-svc 3개.
- 호출자(`caller`) 검사는 ApplyLabel에만 있다. 나머지 4개 보호 서비스는 공유 토큰을 가진 어떤 워크로드든 호출할 수 있다. 감사 항목의 "다른 서비스 토큰 거절"은 ApplyLabel에서는 성립하지만, 다른 보호 서비스에는 서비스별 주체 구분이 없다.

### [중간] R-618 — 초안 noindex가 draft에 묶여 있지 않다

- `apps/web/src/_pages/policy/ui/PolicyPage.tsx:22-25` — `generateMetadata`는 `title`만 돌려준다. `draft`를 보지 않는다.
- `apps/web/src/_app/layouts/RootDocument.tsx:18-19` — 사이트 전체가 퍼블리싱 단계라 `robots: { index: false, follow: false }`를 건다. 지금은 이 전역 값 덕분에 noindex가 걸리지만, 주석대로 "경로별 robots는 화면을 잇는 단계에서 정한다"이므로 전역 noindex가 풀리면 초안 처리방침도 색인된다.
- 임시 탐침에서 `PolicyPage.tsx`의 `robots: { index: false` 부재를 확인했다(탐침 1건 실패). 법무 검토 전 문서가 검색에 노출될 수 있는 상태다.
- 추적성: R-618 커밋 메시지는 유효일을 2026-11-15라고 하지만, R-619가 `apps/web/src/entities/policy-doc/model.ts:187`을 2026-11-01로 바꿨고 `docs/PROGRESS.md`도 그렇게 정정했다. 초안 배너가 시행일을 가리므로 공개 화면 문제는 아니지만, 커밋 메시지와 최종 상태가 다르다.

### [중간] R-619 — 정비 재시도가 `finish.run` 실패 시 통째로 건너뛰어진다

- `services/identity-svc/src/maintenance-tasks.ts:26-36` — `const r = await finish.run(signal);` 다음에야 `staff.inactiveAccountIdsWithStaff(100)`를 돈다.
- `services/identity-svc/src/modules/session/application/finish-withdrawals.ts:64` — 탈퇴 정리·파기 실패가 하나라도 있으면 `throw new Error(...)`. 그날은 배정 REVOKED·세션 종료 재시도가 실행되지 않는다. C2V-04의 "매일 다시 훑는다"가 정확히 실패한 날에 꺼지는 구조다.
- 한 계정의 `terminateByAccount`가 던지면 나머지 계정도 건너뛴다(같은 루프).

### [중간] R-619 — `accountStatusOf`가 status 칸 부재·NULL을 ACTIVE로 읽는다(fail-open)

- `services/identity-svc/src/modules/session/adapters/db/drizzle-staff-assignment-store.ts:73-78` — `coalesce(to_jsonb(a)->>'status', 'ACTIVE')`. 주석이 "status 칸이 없는 시험용 최소 account 표에서도 ACTIVE로 본다"고 밝힌다. 운영 표는 `status NOT NULL`이지만, 스키마 불일치·마이그레이션 사고 시 예전 typed select는 실패했을 자리에서 지금은 ACTIVE로 통과한다.
- 이 메서드는 `CheckScannerSession`(`services/identity-svc/src/modules/session/application/check-scanner-session.ts:21`)이 스캐너 요청마다 부른다. fail-open이면 탈퇴·병합 계정의 세션이 유효로 판정될 수 있다.

### [낮음] R-619 — 메모리 저장소의 계정 상태 지도가 local 조립에서 채워지지 않는다

- `services/identity-svc/src/modules/session/adapters/memory-staff-assignment-store.ts:61`의 `accounts` 지도는 `MemorySessionStore`(`memory-session-store.ts:232,378,455,516`)와 별개다. local/memory 조립에서는 이 지도가 비어 있어 `createScannerSession`(`:155`)과 `accountStatusOf`(`:83-85`)가 모든 계정을 ACTIVE로 본다. 즉 local·demo에서는 R-619 차단이 사실상 꺼진다(운영 Drizzle 경로는 정상). 단위 시험도 이 지도를 직접 채워야 한다.

### [정보] R-619 C2V-01·C2V-02 코드 확인(회귀 시험은 별도 작성자 몫)

- C2V-01(병합 정리 호출): `services/identity-svc/src/modules/session/application/confirm-merge.ts:116-123`가 병합 트랜잭션 커밋 뒤 `staff.terminateByAccount({ accountId: p.absorbedAccountId, ... })`를 부르고, `services/identity-svc/src/modules/session/application/withdraw-account.ts:84-92`가 탈퇴 커밋 뒤 같은 정리를 부른다. 호출 단언 시험은 없다.
- C2V-02(부분 유일 인덱스): `services/identity-svc/migrations/0033_scanner_session_account_unique.sql:25-27`에 `scanner_session_account_active_key ON scanner_session (staff_account_id) WHERE terminated_at IS NULL`가 있다. `services/identity-svc/test-int/device-approval.int.test.ts:143-145`가 인덱스 존재를 확인하지만, 직접 위반 시험은 없다(커밋 메시지대로 별도 시험 작성자 몫).
- C2V-05(잠금 순서): `createScannerSession`은 계정 → 배정 → 세션 순서(`drizzle-staff-assignment-store.ts:196-229`), `terminateByAccount`는 배정 → 세션 순서(`:286-322`)다. `terminateByAccount`는 계정 잠금을 잡지 않으므로 두 경로 사이에 순환 대기는 없다. 다만 주석의 "계정 → 배정 → 세션"과 실제 순서(배정 → 세션)가 완전히 같지는 않다.
- C2V-06(유령 세션): 계정 행 `FOR UPDATE` 뒤 `acc.status !== 'ACTIVE'`면 `StaffAccountInactive`를 던지고, `DeviceApprovals.decide`가 `ACCOUNT_INACTIVE`로 매핑하며(`device-approvals.ts:146-161`), 컨트롤러가 403 `staff-account-inactive`로 닫는다(`device-approval.controller.ts:16`). 코드 경로는 맞다.

### [낮음] R-608 — payment의 Redis 오류는 500으로 샌다

- `services/payment-svc/src/modules/settlement/adapters/jwks-reauth-verifier.ts:40-43` — `TokenRejected`만 403으로 매핑하고, jti 저장소의 Redis 오류는 그대로 던진다. ops·core는 generic 오류를 403 `reauth-required`로 닫는다. 보안은 닫히지만 계약(403/503)과 관측성이 어긋나고, 호출 경로(`settlements.ts:383`)에는 별도 매핑이 없어 일반 5xx로 샌다.

### [낮음] R-608 — mTLS 비밀 값 비교가 timing-safe하지 않다

- `packages/platform/src/auth.ts:502` — `mtlsHeader !== mtls.secret`.
- `services/ticket-svc/src/modules/scanner/inbound/scanner-enrollment.controller.ts:46` — `mtlsHeader !== this.mtlsSecret`.
- 게이트웨이 신뢰 머리 비밀 값이라 네트워크 타이밍 공격 난도는 높지만, 같은 패키지의 `InternalTokenGuard`는 `timingSafeEqual`을 쓴다. 새 코드가 기존 `!==` 패턴을 복사했다.

### [낮음] R-608 — 문서와 코드가 다른 mTLS 폴백 서술

- `docs/features/identity.md:494` — "비밀 값이 없거나 다르면 DPoP 경로로 내려가고".
- 실제 `scanner-enrollment.controller.ts:46-48`은 `mtlsSecret`이 설정된 상태에서 머리 비밀 값이 틀리면 400으로 거절한다(폴백 아님). 보안상 더 닫힌 동작이지만 문서가 틀렸다.

### [낮음] R-619 — 재시도 상한 100/일, `terminateByAccount`의 전체 배정 잠금

- `drizzle-staff-assignment-store.ts:324-337` — `limit 100`. 대량 탈퇴·병합 뒤 정리가 하루 100계정씩 밀린다.
- 같은 파일 `:289-293` — 과거 REVOKED 배정까지 `FOR UPDATE`로 잠근다. 계정 이력이 긴 경우 승인 트랜잭션과 경합할 수 있다.

### [정보] 배포 Secret 미주입

- `deploy/`에서 `PEAKET_INTERNAL_GRPC_TOKEN`·`PEAKET_REAUTH_REDIS_URL`을 찾지 못했다. 차트는 `secretEnvFrom`으로 외부 Secret을 받을 수 있으나, 이 저장소 기준으로는 주입이 확인되지 않는다.
- 토큰이 없으면 identity/ticket/payment/purchase/trust는 시작 실패(닫힘), core/ops는 시작 후 런타임 실패. jti는 위 [높음]대로 열린다. `docs/PROGRESS.md:221`이 이 주입을 남은 몫으로 적고 있다.

## 3. 변이 표

각 변이 후 `git checkout -- <파일>`로 원복했고, 매번 `git status --short`가 깨끗한 것을 확인했다. "탐침"은 커밋하지 않은 임시 vitest/node:test 파일이며 검증 뒤 삭제했다.

| # | 변이 | 파일:줄 | 기존 표적 시험 | 결과 |
| --- | --- | --- | --- | --- |
| 1 | 내부 gRPC 토큰 검사 제거(`if (true)`) | `packages/platform/src/internal-grpc.ts:68` | platform `grpc-channel`+`scanner-auth` 42 통과 | 기존 시험 **미검출**, 임시 탐침 검출(없음/틀림 → 0) |
| 2 | 다른 서비스 호출자 허용(`expected.caller` 무시) | `packages/platform/src/internal-grpc.ts:45` | trust `label-grpc` 4 통과 | 기존 시험 **미검출**, 임시 탐침 검출(ticket-svc → 0) |
| 3 | jti 재사용 허용(`return true`) | `packages/platform/src/reauth-jti.ts:33` | platform `token-verify` 14 통과 | 기존 시험 **미검출**, 임시 탐침 검출(두 번째 claim true) |
| 4 | ScannerGuard 자격 종류 비교 제거 | `packages/platform/src/auth.ts:549-551` | platform `scanner-auth` 25 통과 | 기존 시험 **미검출**, 임시 탐침 검출(DEVICE_KEY via mTLS → 200) |
| 5 | ScannerDeviceLookup 자격 종류 비교 제거 | `services/ticket-svc/src/modules/scanner/inbound/scanner-device-lookup.grpc.ts:39` | ticket 단위 3 통과, ticket **통합 1 실패** | **기존 통합 시험 검출**(DEVICE_KEY 기기에 MTLS_CERT 요청) |
| 6 | ApplyLabel 호출자·acted_by 증명 블록 제거 | `services/trust-svc/src/modules/scoring/inbound/trust.grpc.ts:200-206` | trust `label-grpc` 4 통과 | 기존 시험 **미검출**, 임시 탐침 2건 검출 |
| 7 | 초안 배너 로직 비활성(`const draft = false`) | `apps/web/src/_pages/policy/ui/PolicyPage.tsx:81` | web 정책 7 통과 | 기존 시험 **미검출**, 임시 탐침 검출 |
| 8 | 처리방침 자리표시자 복원(`업체 미정`·`[운영 담당자]`) | `apps/web/src/entities/policy-doc/model.ts:223,271` | web 정책 7 통과 | 기존 시험 **미검출**, 임시 탐침 검출 |
| 9 | 메모리 저장소 비활성 계정 차단 제거 | `services/identity-svc/src/modules/session/adapters/memory-staff-assignment-store.ts:155` | identity `device-approval` 12 통과 | 기존 시험 **미검출**, 임시 탐침 3건 검출 |
| 10 | Drizzle 승인 트랜잭션 비활성 계정 차단 제거 | `services/identity-svc/src/modules/session/adapters/db/drizzle-staff-assignment-store.ts:199-201` | identity **test-int 172 통과** | 기존 시험 **미검출**(운영 경로, 탐침 없음) |

## 4. 실행한 시험

| 시험 | 결과 |
| --- | --- |
| `pnpm --filter @peaket/platform test` | **550/550 통과**(44 파일). 첫 실행에서 `problem.test.ts` 1건이 5초 제한을 넘겨 실패했으나, 단독 재실행 16/16·최종 전체 재실행 550/550 통과. 부하성 flake로 판단 |
| `pnpm --filter @peaket/identity-svc test` | **556/556 통과**(45 파일) |
| `pnpm --filter @peaket/identity-svc test:integration` | **172/172 통과**(29 파일) |
| `pnpm --filter @peaket/ticket-svc test` | **98/98 통과**(17 파일) |
| `pnpm --filter @peaket/ticket-svc test:integration` | **44/44 통과**(8 파일) |
| `pnpm --filter @peaket/trust-svc test` | **211/211 통과**(15 파일) |
| `pnpm --filter @peaket/web test` | **833/833 통과** |
| `pnpm --filter @peaket/ops-svc test` | **97/97 통과**(23 파일) |
| `pnpm --filter @peaket/core-svc test` | **350/350 통과**(45 파일) |
| `pnpm --filter @peaket/payment-svc test` | **2941/2941 통과**(42 파일) |
| `pnpm typecheck` | **42/42 task 성공** |
| 표적: platform `grpc-channel`·`scanner-auth`·`token-verify` | 44/44 통과 |
| 표적: trust `label-grpc`·`grpc` | 11/11 통과 |
| 표적: ticket scanner 4파일 | 28/28 통과 |
| 표적: identity `device-approval`·`terminate-scanner-sessions` | 13/13 통과 |
| 표적: web `policy-page`·`policy-doc/model` | 7/7 통과 |
| Docker | 사전 `docker ps` 빈 상태. 통합 시험 뒤 남은 postgres:18-alpine 컨테이너 1개를 `docker rm -f`로 정리. 최종 `docker ps` 빈 상태 |

임시 탐침으로 추가 확인한 동작(모두 통과):
- 내부 gRPC: 토큰 없음/틀림 `UNAUTHENTICATED`, 맞음 처리기 도달, 서비스 필터 밖은 토큰 없이 통과.
- `verifyInternalGrpcActor`: 토큰·호출자·처리자·HMAC 증명의 각 실패 사유와 성공.
- `internalGrpcTokenFromEnv`: local/ci 허용, prod/staging/미설정 거절, 토큰 우선.
- jti: 메모리 5분 TTL·토큰 수명 상한, Redis `SET NX PX` 인자와 `OK`만 최초 성공.
- mTLS: `ScannerGuard`가 MTLS_CERT/DEVICE_KEY를 구분, enrollment가 인증서 지문을 MTLS_CERT로 묶고 잘못된 비밀은 400.
- ApplyLabel: 토큰·ops-svc 호출자·본문 acted_by·증명이 모두 맞을 때만 처리.
- R-618: privacy `draft:true`, `effective:2026-11-01`, `업체 미정`·`[운영 담당자]` 부재, 초안 배너 분기 존재.
- R-619: DELETED/MERGED/WITHDRAWAL_PENDING 계정 승인 `ACCOUNT_INACTIVE`, ACTIVE는 세션 생성.

## 5. 남은 위험

1. **운영 jti fail-open** — `PEAKET_REAUTH_REDIS_URL`(ops/payment)·`PEAKET_QUEUE_REDIS_URL`(core)이 없으면 SEC-03의 1회용이 꺼진다. `UnavailableReauthJtiStore`를 local/ci 밖 기본값으로 배선하거나, env 미설정 시 시작을 막아야 한다.
2. **회귀 시험 부재** — 변이 10개 중 기존 시험 검출 1개. 특히 R-608 내부 토큰·ApplyLabel·jti, R-618 초안/noindex, R-619 비활성 승인은 시험 작성자가 반드시 추가해야 한다.
3. **내부 gRPC 부분 보호** — 5개 서비스만 토큰 검사. 나머지 내부 gRPC는 메시 mTLS에만 의존한다. 서비스별 토큰/호출자 허용 목록은 ApplyLabel 외에는 없다.
4. **core/ops fail-fast 부재** — 토큰 없이 시작해 런타임에 403/503으로 실패한다. 배포 시 조기 실패가 낫다.
5. **R-618 noindex** — 전역 퍼블리싱 noindex가 풀리면 초안 처리방침이 색인된다. `generateMetadata`에서 `doc.draft`일 때 `robots: { index: false, follow: false }`를 걸어야 한다.
6. **R-619 정비 재시도** — `finish.run`이 던지는 날 배정·세션 재시도가 꺼진다. `try/finally`로 분리하고, 계정별 실패를 모아 다음 계정을 계속해야 한다.
7. **R-619 `accountStatusOf` fail-open** — status 칸 부재·NULL을 ACTIVE로 본다. typed select로 되돌리거나, 없으면 예외로 닫아야 한다.
8. **payment jti 오류 5xx** — Redis 장애 시 403/503이 아니라 일반 5xx. ops/core와 같은 매핑이 필요하다.
9. **mTLS 비밀 비교** — `timingSafeEqual`로 통일하는 것이 좋다.
10. **배포 Secret** — `PEAKET_INTERNAL_GRPC_TOKEN`·`PEAKET_REAUTH_REDIS_URL` 주입이 저장소에서 확인되지 않는다. 토큰 미주입 시 5개 서비스는 시작 실패, jti는 fail-open이다.

## 6. 작업 뒤 상태

```
$ git status --short
(빈 출력)

$ git rev-parse --short HEAD
2157f0f6

$ git branch --show-current
wave/lane1-audit-m5
```

- 코드 영구 수정 없음. 변이용 편집은 모두 `git checkout --`로 원복.
- 임시 탐침 파일 7개는 모두 삭제.
- 커밋·푸시·합치기 없음.
- 실행 중 Docker 컨테이너 없음(`docker ps` 빈 출력).
