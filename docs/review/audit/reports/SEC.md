# 웨이브 6 독립 감사 — SEC(보안)

- 감사자: 독립 감사 에이전트(구현 미참여), 읽기 전용
- 작업 위치: `D:\ticketpass-audit-ro1` (detached HEAD `42697cf7`)
- 대상: `6bcea3c7`(v0.2.0) .. `42697cf7`(develop), 321 커밋
- 방법: 커밋·코드·계약(openapi/proto)·마이그레이션·시험을 직접 대조. 기존 리뷰·ledger·CI 초록은 근거로 쓰지 않고, 필요한 곳에서만 “이미 기록된 위험”으로 인용했다. 코드 수정·커밋·푸시·Docker 없음.
- 요약: **높음 2, 중간 6, 낮음 6**

> 참조 해석 주의: 이 worktree에서 태그 `v0.2.0`은 `f47f9dc9`를 가리키지만 `git diff 6bcea3c7 f47f9dc9`가 비어 있어 같은 트리다. 로컬 브랜치 `develop`은 `fabbabac`(R-594, 감사 안내 문서 1커밋)로 지시된 `42697cf7`보다 1커밋 앞인데, 그 커밋은 `docs/`만 바꾼다. 감사는 지시대로 `6bcea3c7..42697cf7`을 기준으로 했다.

---

## 발견

### [높음] SEC-01: 새 gRPC 자금·권한 경로에 호출자 인증이 없다 — 회차 전체 환불·배상 송금·기기 등록 코드가 클러스터 안에서 무인증
- 영역/배치: BAT-425(GAT-130), BAT-450(GAT-220), BAT-435(GAT-170), ADR-0172. R-583·R-586·R-591·R-592.
- 위치:
  - `services/purchase-svc/src/grpc-server.ts:18` (`grpc.ServerCredentials.createInsecure()`)
  - `services/ticket-svc/src/grpc-server.ts:15`, `services/trust-svc/src/grpc-server.ts:17`
  - `services/purchase-svc/src/modules/refund/inbound/event-refund.grpc.ts:103-139` (`StartEventRefund`)
  - `services/payment-svc/src/modules/compensation/inbound/compensation-transfer.grpc.ts:40-62` (`RequestCompensationTransfer`)
  - `services/ticket-svc/src/modules/scanner/inbound/scanner-device.grpc.ts`, `services/identity-svc/src/modules/admin/inbound/admin-authz.grpc.ts:8-25`
- 증거:
  - 모든 gRPC 서버가 `createInsecure()`로 열리고, 처리기는 `call.metadata`를 한 번도 읽지 않는다. 모든 클라이언트가 `new grpc.Metadata()`(빈 메타데이터)로 부른다(`services/ops-svc/src/modules/scanner-devices/adapters/grpc-ticket-scanner-devices.ts:109`, `services/ops-svc/src/modules/priority/adapters/grpc-purchase-priority-grants.ts:109`, `services/ticket-svc/src/modules/scanner/adapters/grpc-scanner-session-check.ts:43,71` 등). 통합 시험도 토큰 없이 호출해 통과한다(`services/purchase-svc/test-int/event-refund-grpc.int.test.ts:57`, `services/payment-svc/test/compensation-transfer-grpc.test.ts:24`).
  - 설계는 서비스 메시(Istio ambient) L7 허용 목록에 기댄다(`docs/infra.md` §9, `docs/api/proto/README.md:39` “부르는 쪽 확인 … 메시 mTLS 신뢰(배포 설정)”). 그러나 저장소에 Istio `AuthorizationPolicy`/`PeerAuthentication`/웨이포인트 설정이 없고, `docs/architecture.md:743`의 포트별 허용 표에는 새 `EventRefundService`·`CompensationTransferService`가 **빠져 있다**. `docs/api/proto/README.md:132`는 배상 송금 계약을 아직 “결제사 계약 뒤 더한다”로 적고 있어, 이번에 추가된 `CompensationTransferService`의 호출자 표도 없다.
  - `docs/security/asvs/payment.md`의 v5.0.0-8.2.1도 “코드에는 목록이 없고 설정은 HOT-400”이라고 스스로 적는다.
- 왜 문제인가:
  - `StartEventRefund`는 `event_id`·`cancellation_request_id`·`ruled_by`·`confirmed_by`를 호출자가 정하는 그대로 받아 **회차 전체 일괄 환불**을 시작한다. purchase-svc gRPC 포트에 닿는 아무 파드(침해된 워크로드, 잘못 배포된 Job, SSRF로 내부 포트에 닿은 코드)가 두 문자열만 채워도 실제 PG 환불이 나간다.
  - `RegisterScannerDevice`/`ReissueEnrollmentCode`는 등록 코드를 발급하고, `AdminAuthzService.GetAdminAuthz`는 (계정, 세션)을 알면 역할·테넌트를 돌려준다. gRPC가 사실상 “클러스터 전체에 열린 관리 API”가 된다.
  - `CompensationTransferService`는 현재 fake 모드가 아니면 UNAVAILABLE이라 즉시 자금 피해는 없지만, 실제 지급대행이 붙는 순간 같은 구멍이 돈 이동에 직결된다.
- 재현/확인:
  - `rg "createInsecure" services/*/src` → purchase·ticket·trust·payment·identity·queue gRPC 서버 모두(`*/src/grpc-server.ts`).
  - `rg "new grpc.Metadata\(\)" services/*/src` → 호출자 토큰을 싣는 곳 0.
  - `rg "EventRefundService|CompensationTransferService" docs/architecture.md` → 포트별 허용 표에 없음.
- 제안 수정(최소):
  1. gRPC 서버에 공통 인터셉터를 달아 `x-peaket-internal-token`(HTTP와 같은 비밀) 또는 SPIFFE 신원을 검사하고, 없으면 `PERMISSION_DENIED`로 닫는다. `InternalTokenGuard`와 같은 “운영에서는 비어 있으면 시작 실패” 규칙을 적용한다.
  2. 메시를 쓴다면 `EventRefundService`·`CompensationTransferService`·`ScannerDeviceService`를 `docs/architecture.md:743` 허용 표와 `docs/api/proto/README.md` §3에 먼저 넣고, “호출자 없이 부르면 PERMISSION_DENIED” 통합 시험을 추가한다.
  3. 배포 전 `kubectl authz` 수준의 확인 항목(포트별 허용 표와 실제 AuthorizationPolicy 대조)을 릴리스 게이트에 넣는다.
- 확신도: **중간** (코드의 무인증·무암호화는 확인. 운영 메시 정책은 저장소 밖이라 “실제로 열려 있다”는 배포 확인이 필요).

---

### [높음] SEC-02: 회차 취소 확정이 계약이 요구하는 재인증 토큰을 검사하지 않는다
- 영역/배치: BAT-425 GAT-130 잔여(R-592), `POST /v1/ops/event-cancellations/{requestId}/approvals`.
- 위치:
  - `docs/api/openapi.yaml:5452-5453` (계약: `parameters: [..., { $ref: '#/components/parameters/ReauthToken' }]`, “되돌릴 수 없는 일괄 환불”)
  - `services/ops-svc/src/modules/event-cancellations/inbound/event-cancellations.controller.ts:88-98`
  - `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:73-84`
- 증거: 컨트롤러는 `requestId`와 `CurrentPrincipal`만 받고 `x-reauth-token`을 읽지 않는다. `approve()`도 `actor.accountId`만 본다. 같은 계약의 다른 위험 경로(지급 묶음 승인)는 `x-reauth-token`을 읽어 `JwksApprovalVerifier`로 패스키 요소까지 확인한다(`services/ops-svc/src/modules/payouts/inbound/payouts.controller.ts:121-128`, `payout-approvals.ts:95-96`). ASVS 메모는 “재인증 토큰은 아직 강제하지 않는다(후속)”라고 적어(`docs/security/asvs/transfer-refund.md:9`) 코드와 계약이 서로 다르다.
- 왜 문제인가: 회차 전체 환불은 되돌릴 수 없는 최대 자금 작업인데, 계약을 믿은 콘솔·클라이언트는 재인증을 받아 보내지만 서버는 무시한다. 공격자가 commander/operator 세션 두 개를 얻으면(2인 규칙 충족) 패스키 재인증 없이 전액 환불을 확정할 수 있다. “5분 1회용 재인증”이라는 방어선이 이 경로에서 사라진다.
- 재현/확인: `python -c`로 계약에서 `ReauthToken` 존재 확인(True), 컨트롤러 소스에서 `x-reauth` 문자열 0회. `approve()` 인자에 토큰 없음.
- 제안 수정: `approve`에서 `X-Reauth-Token`을 `act: 'APPROVAL'`(또는 전용 `EVENT_CANCEL`)·패스키 필수로 검증하고, 실패 시 403 `reauth-required`. 구현 전에는 계약에서 `ReauthToken`을 빼고 “미강제”를 명시해 클라이언트가 잘못된 안심을 하지 않게 한다.
- 확신도: **높음**

---

### [중간] SEC-03: 새 재인증 소비자 3곳이 토큰의 1회용(`jti`)을 강제하지 않는다 — 5분 안 재사용 가능
- 영역/배치: BAT-425(R-592) 지급 승인·정산 계좌, BAT-610 잔여 명단 내려받기. `packages/platform` TokenVerifier.
- 위치:
  - `packages/platform/src/token-verify.ts:166-175` — “한 번 쓰기(jti)는 부르는 쪽이 본다”
  - `services/ops-svc/src/modules/payouts/adapters/jwks-approval-verifier.ts:18-24` — `jti`를 버리고 `{accountId, factors}`만 반환
  - `services/payment-svc/src/modules/settlement/adapters/jwks-reauth-verifier.ts:28-39` + `application/settlements.ts:381-400` — `jti`를 반환하지만 호출자가 무시
  - `services/core-svc/src/modules/export/adapters/sources.ts:29-41` — `jti`를 버림
- 증거: 세 검증기 모두 재사용 저장소를 두지 않는다. identity는 `admin_reauth.used_at`을 `ACCOUNT_SECURITY`에만 조건부로 적는다(`docs/data.md:2700`). 계약의 `ReauthToken` 설명은 “typ reauth+jwt, 5분 1회용”이다(`docs/api/openapi.yaml:364`).
- 왜 문제인가: 한 번 패스키로 재인증해 받은 토큰을 5분 동안 지급 묶음 승인 여러 건, 정산 계좌 변경, 예매자 명단 내려받기에 되풀이해 쓸 수 있다. “방금 패스키로 확인했다”는 감사·통제의 의미가 약해지고, 토큰+세션 쿠키가 새면 여러 고위험 작업을 한 번의 재인증으로 처리할 수 있다.
- 재현/확인: `rg "\.jti|jti" services/ops-svc/src/modules/payouts services/payment-svc/src/modules/settlement services/core-svc/src/modules/export` → 반환·저장 없음. `TokenVerifier.verifyReauth`는 jti를 돌려주기만 한다.
- 제안 수정: `ReauthJtiStore`(Redis `SET NX PX` 또는 DB 유니크) 공용 포트를 만들고 세 검증기가 `verify` 안에서 `claim(jti, exp)`하도록 한다. 재사용은 403 `reauth-required`. 이미 있는 `scanner:dpop:{jti}` 패턴을 재사용하면 된다.
- 확신도: **높음**

---

### [중간] SEC-04: 새 2인 승인 자금 업무(지급 묶음·회차 취소)가 `audit_chain`에 기록되지 않는다
- 영역/배치: BAT-610 잔여(지급 묶음 승인), BAT-425 GAT-130 잔여(회차 취소). `audit_chain`/`audit_chain_head`(GAT-110).
- 위치:
  - `services/ops-svc/src/modules/payouts/application/payout-approvals.ts` (전체) — `appendAuditIn` 없음
  - `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts` (전체) — `appendAuditIn` 없음
  - 대조: `services/ops-svc/src/modules/commands/adapters/db/drizzle-command-store.ts:72,125,141,156,174`, `services/ops-svc/src/modules/scanner-devices/application/scanner-devices.ts:38-47`
- 증거: `rg "audit|appendAudit" services/ops-svc/src/modules/payouts services/ops-svc/src/modules/event-cancellations` → 0. 마이그레이션 `0009_payout_approval.sql`·`0011_event_cancellation_request.sql`에도 트리거가 없고, `requested_by`·`judged_by`·`approved_by` 평문 열만 있다. `docs/features/control-tower.md:423`는 “2인 승인 UI와 감사 로그 저장소는 같이 쓴다”고 요구한다. 지급 승인 쪽은 `docs/review/measurements/BAT-610-remainder.md:55`에 이미 “승인 업무 감사 체인 미연결”로 적혀 있다.
- 왜 문제인가: 이 두 업무가 바로 “돈과 소유권을 움직이는 업무 승인”이다. 해시 체인 없이 일반 행만 두면 DB 쓰기 권한을 가진 공격자·실수가 `approved_by`/`status`를 바꿔도 탐지·검증할 수 없다. 회차 취소는 환불 실행의 유일한 사람 승인 기록이고, 지급 묶음은 파트너 정산 금액의 집행 승인이다.
- 재현/확인: 위 `rg` 결과 0. `services/ops-svc/migrations/0011_event_cancellation_request.sql:3-29`에 `audit_chain` 참조 없음.
- 제안 수정: 상태 변경과 같은 트랜잭션에서 `appendAuditIn`으로 `PAYOUT_BATCH_REQUESTED/APPROVED/REJECTED/EXECUTED`, `EVENT_CANCELLATION_REQUESTED/JUDGED/APPROVED/PAUSED/RESUMED`를 남긴다. 저장소가 메모리·DB 두 구현이므로 DB 구현에 먼저 넣고, 감사 실패 시 상태 변경도 실패하게 한다.
- 확신도: **높음**

---

### [중간] SEC-05: `InternalTokenGuard`가 토큰이 비면 통과(fail-open)이고, 운영 시작을 막는 검사가 없다 — 새 내부 자금 경로가 무인증이 될 수 있다
- 영역/배치: BAT-425(내부 HTTP), BAT-450(ops 알림), BAT-435(서킷). `packages/platform` 공통 가드.
- 위치:
  - `packages/platform/src/auth.ts:88-96` — `if (!this.expected) return true`
  - 각 모듈 provider: `{ provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN }` (예: `services/payment-svc/src/modules/payment/payment.module.ts:32`, `services/purchase-svc/src/modules/refund/refund.module.ts:42`, `services/ops-svc/src/modules/payouts/payouts.module.ts:22`)
  - `services/payment-svc/src/config.ts` — 내부 토큰 필수 검사 없음
  - `deploy/workloads/ops-svc/values.yaml:17` — “비우면 로컬·CI처럼 검사를 끈다”는 주석뿐
- 증거: ticket-svc는 `PEAKET_IDENTITY_GRPC_URL`·`PEAKET_TICKET_REDIS_URL`이 없으면 시작을 막지만(`services/ticket-svc/src/config.ts:31-33`), 내부 토큰은 어느 서비스에서도 staging/prod 시작 조건이 아니다. 새 내부 경로는 `POST /internal/v1/event-refunds`(회차 전체 환불), `/internal/v1/settlements/payout-batches*`(지급 생성·승인·실행·재시도), `/internal/v1/receivables`(미수금 생성), `/internal/v1/notify/trade-events`(팬 알림), `/internal/v1/ops-alerts`(경보) 등이다.
- 왜 문제인가: 환경 변수 오타·Secret 누락 하나로 서비스 사이 인증이 조용히 꺼진다. 새 경로는 돈을 직접 움직이므로 “로컬·CI 편의”를 위한 fail-open이 운영 사고로 이어질 수 있다. 같은 저장소가 다른 필수 값에는 fail-closed를 적용하고 있어 일관성도 없다.
- 재현/확인: `rg "PEAKET_INTERNAL_TOKEN" services/*/src/config.ts` → ticket-svc만 `internalToken?` 선택 값. `rg "internalToken.*없으면|INTERNAL_TOKEN.*없으면" services/*/src/config.ts` → 시작 실패 0.
- 제안 수정: `PEAKET_ENV`가 `local|ci|demo`가 아니면 `PEAKET_INTERNAL_TOKEN`이 비었을 때 시작 실패. 또는 `InternalTokenGuard`가 `PEAKET_ENV`를 보고 운영에서는 `expected` 없으면 503으로 닫기. 설정 시험 1건 추가.
- 확신도: **높음**

---

### [중간] SEC-06: 유일하게 `InternalTokenGuard`가 없는 내부 경로 `GET /internal/v1/events/{eventId}/sale-config`
- 영역/배치: BAT-051(HOT-252, R-535), BAT-435 GAT-170 잔여(R-582)에서 필드가 늘어난 경로.
- 위치: `services/core-svc/src/modules/catalog/inbound/internal-sale-config.controller.ts:39-46`
- 증거: `@Controller('internal/v1/events')` + `@Roles(['public'])`이고 `@UseGuards(InternalTokenGuard)`가 없다. 같은 저장소의 다른 내부 컨트롤러 14곳은 모두 `InternalTokenGuard`를 쓴다(예: `services/payment-svc/src/modules/settlement/inbound/internal-settlement.controller.ts:43-45`, `services/purchase-svc/src/modules/refund/inbound/event-refund.controller.ts:89-91`). 응답에는 `promoterId`, 판매·입장 창, `salePolicy`, `eligLists`(명단 키), `pgKey`, `pgTps`가 들어간다. `docs/review/measurements/BAT-051-wave.md:76`이 이미 “호출자 인증 없음, NetworkPolicy 전제(wbs 0.4.4)”로 중간에 기록했다.
- 왜 문제인가: 게이트웨이 HTTPRoute에 없다는 사실과 NetworkPolicy에만 기대는 구조다. 게이트웨이 라우팅 실수, 클러스터 안 SSRF, 침해된 파드에서 다른 파트너의 판매 정책·자격 명단 키를 읽을 수 있다. 개인정보는 아니지만 테넌트 기밀(경쟁사 판매 전략·명단 구조)이고, 이번 웨이브에서 “내부 경로에는 토큰” 규칙을 세운 것과 어긋난다.
- 재현/확인: 위 파일에 `InternalTokenGuard` 문자열 0. 같은 경로를 부르는 `services/purchase-svc/src/modules/inventory/adapters/core-sale-configs.ts:82`, `services/ticket-svc/src/modules/scanner/adapters/http-core-event-policy.ts:73`는 이미 `PEAKET_INTERNAL_TOKEN`을 다른 호출에 쓰고 있어 추가 비용이 없다.
- 제안 수정: `@UseGuards(InternalTokenGuard)`를 달고 모듈에 `INTERNAL_TOKEN` provider를 넣는다. “토큰 없이 부르면 403” 시험을 추가한다. NetworkPolicy는 별도 릴리스 게이트로 확인한다.
- 확신도: **높음**

---

### [중간] SEC-07: `PEAKET_*_MODE=fake`가 운영에서도 켜진다 — 배상 송금·팬 알림이 실제로 하지 않고 성공처럼 보고된다
- 영역/배치: BAT-425 GAT-130 잔여(R-592) 배상 송금·core-notify-sender 첫 몫.
- 위치:
  - `services/payment-svc/src/modules/compensation/adapters/fake-compensation-transfer.ts:12-17`
  - `services/payment-svc/src/start.ts:275`
  - `services/core-svc/src/modules/notify/application/notification-sender.ts:64,74-81`
  - `services/core-svc/src/modules/notify/notify.module.ts:32`
- 증거: 두 어댑터 모두 `env.PEAKET_..._MODE?.trim() === 'fake'`만 보고 환경을 구분하지 않는다. fake 배상 송금은 `status: 'REQUESTED'`를, fake 알림은 `status: 'SENT'`를 돌려준다. 같은 저장소의 PG 시뮬레이터는 `assertPgAdapters`가 `local|ci` 밖에서 시뮬레이터를 거부한다(`services/payment-svc/src/config.ts:188-192`). 이 두 새 어댑터에는 그런 검사가 없다.
- 왜 문제인가: 운영 환경 변수 실수 하나로 “배상 송금 요청됨”·“팬 알림 발송됨”이 기록되지만 실제 송금·발송은 없다. 돈이 나가지 않은 것을 나간 것처럼 보이게 하고, 팬은 안내를 받지 못한다. 실패가 조용하다는 점이 가장 위험하다.
- 재현/확인: 위 두 파일에서 환경 검사가 `fake` 문자열 비교 하나뿐. `rg "assert.*Fake|fake.*PEAKET_ENV|COMPENSATION_TRANSFER_MODE" services/*/src` → 운영 차단 0.
- 제안 수정: `PEAKET_ENV`가 `local|ci|demo|staging`이 아니면 `=fake`를 시작 실패로 만든다. 또는 명시적 `PEAKET_ALLOW_FAKE=1`을 함께 요구하고, fake가 켜진 파드에 `/ready` 경고·지표를 낸다.
- 확신도: **높음**

---

### [중간] SEC-08: mTLS 선택지는 실제 기기로는 쓸 수 없다 — 인증서 지문을 기기에 묶는 등록 경로가 없다
- 영역/배치: BAT-435 GAT-170 잔여 mTLS PoC(R-591).
- 위치: `services/ticket-svc/src/modules/scanner/application/scanner-devices.ts:175-198`, `services/ticket-svc/src/modules/scanner/adapters/db/drizzle-scanner-device-store.ts:82-99`, `services/ticket-svc/src/modules/scanner/inbound/scanner-enrollment.controller.ts:29-66`, `packages/platform/src/auth.ts:476-484`
- 증거: `enroll()`은 DPoP 증명의 `jkt`만 받고 `bindCredential`은 항상 `credentialType: 'DEVICE_KEY'`로 쓴다. mTLS 가드는 `deviceByThumbprint(certSha256)`로 기기를 찾지만, 인증서 SHA-256을 `credential_thumbprint`에 넣는 경로가 없다. 시험은 `b.devices.byJkt.set(X5T, ...)`로 손수 넣는다(`packages/platform/test/scanner-auth.test.ts:327-352`). `docs/features/offline-gate.md:157-159`는 “관리형 기기·사설 CA PoC가 없다”고는 하지만, “기기 등록이 인증서 지문을 받지 않는다”는 점은 적지 않는다.
- 왜 문제인가: `PEAKET_SCANNER_MTLS_SECRET`을 켜도 실제 스캐너는 DPoP로만 등록·인증되므로 mTLS 경로는 영원히 매칭되지 않는다. “mTLS를 켰다”는 운영 판단이 실제 통제 강화로 이어지지 않고, PoC 시험만 초록이다.
- 재현/확인: `rg "credentialType: 'DEVICE_KEY'|MTLS_CERT" services/ticket-svc/src` → 쓰기 경로는 DEVICE_KEY 하나, MTLS_CERT는 읽기(`scanner-shift.ts:126`)에만.
- 제안 수정: 관리형 기기 등록 경로(운영자 주도, 사설 CA)에서 인증서 DER/지문을 받아 `credentialType: 'MTLS_CERT'`로 묶는 API·마이그레이션을 추가하기 전까지 `PEAKET_SCANNER_MTLS_SECRET`을 “실험용, 실제 기기 미지원”으로 표시하고 시작 경고를 낸다.
- 확신도: **높음**

---

### [낮음] SEC-09: mTLS 공유 비밀 값의 최소 길이·상수 시간 비교가 없다
- 위치: `packages/platform/src/scanner-auth.ts:71-76`, `packages/platform/src/auth.ts:477`
- 증거: `mtlsHeader !== mtls.secret`는 일반 문자열 비교이고, `PEAKET_SCANNER_MTLS_SECRET`에 길이·엔트로피 검사가 없다(`services/ticket-svc/src/config.ts:44`).
- 왜 문제인가: 짧은 비밀 값이 배포되면 스캐너 API에 대한 오프라인/온라인 추측이 쉬워지고, 비교 타이밍으로 접두사를 알아낼 여지가 있다(네트워크 지터로 악용 난이도는 높음). 게이트웨이 신뢰 경계의 유일한 비밀 값이라 최소 32바이트 같은 하한이 필요하다. 또한 mTLS 경로는 “게이트웨이가 클라이언트가 보낸 `x-user-x5t`를 지우고 토큰의 `cnf.x5t#S256`을 넣는다”는 전제에 기대는데, 이 전제가 깨지면 DPoP `cnf.jkt` 토큰을 가진 클라이언트가 자기 인증서 지문을 `x-user-x5t`로 보내 DPoP 증명 없이 통과할 수 있다(서비스는 토큰을 다시 검증하지 않는다). 저장소에는 이 머리 삭제를 검증하는 게이트웨이 설정·시험이 없다.
- 제안 수정: config에서 32바이트 이상 랜덤 값만 받고, `timingSafeEqual`로 비교한다. 게이트웨이 설정에 `x-user-x5t`·`x-peaket-mtls-authenticated`·`x-peaket-client-cert-sha256` 삭제 규칙과 그 회귀 시험을 넣는다.
- 확신도: **높음**

---

### [낮음] SEC-10: 등록 실패 제한 키가 클라이언트가 조작할 수 있는 `X-Forwarded-For` 첫 값이다
- 위치: `services/ticket-svc/src/modules/scanner/inbound/scanner-enrollment.controller.ts:15-19`, `services/ticket-svc/src/modules/scanner/application/scanner-devices.ts:175-183`
- 증거: `x-forwarded-for`의 첫 값을 그대로 IP로 쓴다. 게이트웨이가 값을 덮어쓰지 않고 덧붙이면 공격자가 임의 IP를 앞에 넣어 IP당 10분 10회 제한을 우회할 수 있다. 전역 100회 카운터는 여전히 올라가 SEV3 경보를 인위적으로 울릴 수 있다.
- 왜 문제인가: 등록 코드는 20문자 알파벳 12자라 대입 자체는 현실적이지 않지만, 제한·경보가 조작 가능하면 운영 신호를 오염시키고 “IP 제한이 있다”는 문서·ASVS 판정이 실제보다 강해 보인다.
- 제안 수정: 게이트웨이가 신뢰하는 홉 수(`PEAKET_V0_TRUSTED_PROXY_HOPS` 같은 값)만큼 뒤에서 읽거나, 게이트웨이가 넣은 단일 `x-peaket-client-ip`를 쓴다. 최소한 첫 값이 사설/예약 대역이면 거절한다.
- 확신도: **중간** (게이트웨이 XFF 처리 설정이 저장소에 없다).

---

### [낮음] SEC-11: `@Roles(..., { fresh: true })`가 어느 처리기에도 쓰이지 않는다 — 위험 작업도 5초 역할 캐시를 쓴다
- 위치: `packages/platform/src/auth.ts:62-63,271-298` (`fresh` 구현), `services/**/inbound/*.controller.ts` 전체(`fresh: true` 0건)
- 증거: `rg "fresh: true" services` → 0. 전체 저장소에서 유일한 사용은 `packages/platform/test/auth-guard.test.ts:45`의 시험 fixture다. ADR-0172·`docs/security/authz-matrix.md:202`는 “재인증 토큰을 받는 위험 작업은 캐시를 쓰지도 넣지도 않는다”고 요구한다. 지급 승인·회차 취소 확정·정산 계좌 변경·명단 내려받기가 모두 해당한다.
- 왜 문제인가: 역할 강등·세션 종료가 5초 안에 반영되지 않아, 방금 권한을 잃은 계정이 위험 작업을 한 번 더 통과할 수 있다. 재인증을 붙여도 역할 판정은 캐시된 값이다.
- 제안 수정: 위험 처리기에 `fresh: true`를 달고, `RolesCheck`가 “reauth를 쓰는 처리기는 fresh여야 한다”를 시작 때 검사하게 한다.
- 확신도: **높음**

---

### [낮음] SEC-12: 스캐너 기기 감사 기록이 원장 변경과 원자적이지 않다 — 주석의 “감사 없는 변경 없음”이 성립하지 않는다
- 위치: `services/ops-svc/src/modules/scanner-devices/application/scanner-devices.ts:20-47`
- 증거: `register/revoke/reissue`는 먼저 ticket-svc gRPC로 원장을 바꾼 뒤 `audit.append`를 부른다. 주석은 “감사 기록이 실패하면 명령도 실패로 답한다(감사 없는 기기 변경을 남기지 않는다)”지만, gRPC 변경은 이미 커밋됐고 감사만 실패하면 호출자는 500을 받는다. 같은 `requestId`로 재시도하면 `alreadyDone`으로 원장은 그대로인 채 감사만 뒤늦게 남는다.
- 왜 문제인가: 감사 체인은 “변경과 감사가 함께”일 때만 증거가 된다. 실패 창에서 기기 등록·폐기가 감사 없이 남을 수 있다(폐기는 보안 사건과 직결).
- 제안 수정: ticket-svc gRPC가 `request_id` 멱등 표(`scanner_device_command`)와 감사를 같은 트랜잭션에 쓰게 하거나, ops-svc가 “감사 먼저(PENDING)→원장→감사 확정” 2단계로 바꾼다. 최소한 주석을 실제 동작에 맞게 고친다.
- 확신도: **높음**

---

### [낮음] SEC-13: 계약에만 있고 서버가 없는 새 파트너 현장 경로 2개
- 위치: `docs/api/openapi.yaml:4852` (`/v1/partner/events/{eventId}/gate-status`), `docs/api/openapi.yaml:4854` (`/v1/partner/events/{eventId}/flags`)
- 증거: `rg "gate-status" services` → 0. 생성 클라이언트(`packages/api-client/src/gen/endpoints/partner/partner.ts:4145`)와 MSW 핸들러는 있는데 ticket-svc/core-svc에 처리기가 없다. `docs/features/offline-gate.md:312`·`docs/architecture.md:191`는 구현된 것처럼 경로를 싣는다.
- 왜 문제인가: 보안 관점에서는 “계약이 약속한 인가(partner_admin·partner_member, 테넌트 격리)가 실제로 검증되지 않는 경로”가 문서에 존재한다. 구현될 때 테넌트 대조를 빠뜨리면 바로 IDOR가 된다. 현재는 404라 정보 노출은 없다.
- 제안 수정: 구현 전까지 openapi에 `x-peaket-status: planned` 같은 표시를 넣거나 경로를 빼고, 구현 배치에서 `tenantOf`/`events.find(promoterId, eventId)` 시험을 함께 넣는다.
- 확신도: **높음**

---

### [낮음] SEC-14: 지급 승인 계약의 `cs_lead` 허용과 코드의 `commander` 전용이 어긋난다
- 위치: `docs/api/openapi.yaml:5364` (`x-peaket-roles: [commander, cs_lead]`), `services/ops-svc/src/modules/payouts/inbound/payouts.controller.ts:121-128`, `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:94,120`
- 증거: 컨트롤러는 `@Roles(['commander','cs_lead'])`로 열지만, 유스케이스가 `actor.role !== 'commander'`면 403 `approval-role-required`를 던진다. `docs/planning/03 §3`·control-tower §9.2는 2인 승인의 제2승인자를 commander로 적는다.
- 왜 문제인가: 지금은 fail-closed라 권한 상승은 아니지만, 계약을 정본으로 삼는 콘솔·감사가 `cs_lead`에게 승인 버튼을 보여 주고 403을 받는다. 누군가 “계약에 맞춰” 코드를 고치면 2인 승인 정책이 약해진다.
- 제안 수정: 계약의 `cs_lead`를 빼고 코드·문서·시험을 commander로 맞춘다(또는 반대로 정책을 바꾸려면 ADR).
- 확신도: **높음**

---

## 확인했으나 결함 없음(범위 증거)

- **테넌트 격리(신규 파트너 경로)**: `partner-attendee-export`·`partner-settlement`·`partner-media`·`partner-sale-policy`·`partner-seatmap` 모두 `tenantOf(me)`(principal의 `tenantId`)와 `events.find(promoterId, eventId)`/`findStatement(promoterId, statementId)`로 대조한다. 경로·본문의 `promoterId`를 신뢰하는 곳은 없다. (`services/core-svc/src/modules/export/application/attendee-exports.ts:67-131`, `services/payment-svc/src/modules/settlement/application/settlements.ts:59-89`)
- **DPoP 검증**: `typ`·`alg`·공개키(`d` 금지)·서명·`htm`·`htu`(질의 제거)·`iat` ±5분·`ath`·`jti` 1회·`cnf.jkt`를 모두 본다. 기기 전용(`token:'none'`) 경로에 사람 토큰을 붙이면 401, `optional`에서 토큰이 있으면 세션까지 본다. (`packages/platform/src/scanner-auth.ts:143-208`, `auth.ts:454-467`)
- **기기 승인 로그인**: 기기 코드는 SHA-256만 저장, `jkt` 결속 확인(`auth.jkt !== i.jkt` → expired), 등록 기기 ACTIVE 재확인, 사용자 코드 20문자 알파벳 8자, 승인은 배정 파트너·유효 창·`gate_lead` 대리만. (`services/identity-svc/src/modules/session/application/poll-scanner-token.ts:36-63`, `device-approvals.ts:67-159`)
- **지급 2인 승인**: 요청자≠승인자, 승인자는 commander, 패스키 재인증 필수, 지급 묶음은 APPROVED만 실행, 계좌는 끝 4자리만 저장. (`services/ops-svc/src/modules/payouts/application/payout-approvals.ts:88-112`, `services/payment-svc/src/modules/settlement/application/settlements.ts:225-315,381-400`)
- **웹훅**: 서명 검증 후 본문 상태·금액을 믿지 않고 “단독 조회 신호”로만 쓴다. 실패는 이름 없는 400, 본문 상한 413. (`services/payment-svc/src/modules/payment/inbound/payment-webhook.controller.ts`, `application/receive-payment-webhook.ts:34-111`)
- **CSRF/CORS**: 스캐너 승인·토큰 경로는 `Origin` 일치, multipart 업로드는 `X-Requested-With` 요구, 쓰기는 `application/json`만. (`services/identity-svc/src/modules/session/inbound/scanner-authorization.controller.ts:16-21`, `services/core-svc/src/modules/catalog/inbound/multipart.ts:27-31`)
- **파일 업로드**: jpeg/png/webp만 magic·확장자·선언 타입 3중 대조, SVG 미허용, 저장 키는 `imageId`에서만 만든다. (`services/core-svc/src/modules/catalog/domain/production-image.ts:36-88`)
- **PII 마스킹**: 예매자 목록은 이름·전화 마스킹, 전체 명단은 재인증+사유+보관 기간+감사 행 후에만 내려받는다. (`services/core-svc/src/modules/export/application/attendee-exports.ts:67-124`)
- **에러 메시지**: 새 경로는 이름 붙은 Problem type과 고정 제목을 쓰고, PG·DB 원문을 응답에 싣지 않는다. 웹훅 400은 about:blank.

## 감사 범위의 한계

- 게이트웨이(Envoy) HTTPRoute·CORS·Origin 검사·XFF 처리 설정과 Istio `AuthorizationPolicy`는 저장소에 없다. 따라서 “게이트웨이가 `x-user-*`/`x-peaket-mtls-*`를 지운다”·“메시가 gRPC 호출자를 제한한다”는 전제는 코드가 아니라 배포 설정 몫이며, 이 감사에서 확인할 수 없었다.
- Docker·전체 시험·변이는 지침대로 실행하지 않았다. 표적 시험은 코드 경로 확인으로 대체했고, 실행이 필요한 주장은 “확신도 중간”으로 표시했다.
- `v0.2.0` 태그가 `f47f9dc9`로 옮겨져 있으나 트리는 `6bcea3c7`과 같다. 로컬 `develop`은 감사 안내 문서 1커밋(`fabbabac`) 앞서 있다.
