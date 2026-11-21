# 작업 계획: W12-mesh(메시 정책 정적 시험의 배상 송금·payment REST 부르는 쪽)

- **무엇**: `deploy/platform/mesh/test/mesh-policies.test.mjs`의 MS-09·MS-10·MS-19가 실패한다(PR #50 실행 44916859307 `tools-check`. develop에서는 앞 단계 D-T42에서 멈춰 가려져 있었다). 이 PC 재현: 시험 22·통과 19·실패 3. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane4-mesh`(가지 `feature/lane4-W12-mesh`, 출발점 `origin/develop` `5cf51bc3d`).
- **등급·차례**: 버그 고침이라 재현 시험부터 쓴다(§8.6의 5). 계획 → 시험 → 구현 → 리뷰·검증. 새 ADR 없음.
- **감독 결정**: 정책을 되돌리지 않고 정본 표를 맞춘다. 정본 표 보충(docs)은 이 계획 커밋에서 했다(아래 2).

## 감독에게

1. **REST 경로의 정본은 있다(멈추지 않음).** purchase-svc `HttpPgCircuits`가 payment-svc `GET /internal/v1/circuits`를 읽는다(`services/purchase-svc/src/modules/refund/adapters/http-pg-circuits.ts:59-64`, 조립 `src/start.ts:395-408`, 주소 `deploy/workloads/purchase-svc/values.yaml:27-29`). 정본: `docs/features/transfer-refund.md:257` '서킷 연결', `docs/features/payment.md:721`, `docs/api/guidelines.md:197`(§8.1 내부 HTTP 줄, `docs/architecture.md` §5 REST 행이 가리키는 목록).
2. **근거 표기 바로잡기**: 원천 주석(`port-allow.yaml:166`)과 `guidelines.md:197`이 ADR-0316을 근거로 다는데, ADR-0316(지연 환급 계좌 새 시도)은 서킷 읽기를 다루지 않는다. 원천 주석은 구현이 transfer-refund §5로 고친다. guidelines 줄은 BAT-425 묶음 표기라 이 묶음에서 고치지 않았다.
3. **gRPC는 메서드로 좁힌다.** 원천은 `CompensationTransferService` 통째(`/*`)를 purchase-svc에 연다. 정본(ADR-0317 결정 1, transfer-refund.md:131)은 `RequestCompensationTransfer`만 적고, `GetCompensationTransfer`는 코드·정본 어디에도 부르는 곳이 없다(받는 쪽 `compensation-transfer.grpc.ts:72`뿐). 지시 '할 일 1'대로 Request만 연다. 되돌림이 아니라 좁힘이다.
4. **REST는 경로로 좁히지 못한다.** 노드 프록시는 L4라 경로를 보지 못하고(ADR-0285 결정 5·대안 2), 원천 `rest` 칸에 경로가 없다. 경로 단위는 ADR-0285 '되돌릴 조건'의 새 ADR 몫이라 하지 않는다. 남는 위험(purchase-svc가 공유 토큰으로 `POST /internal/v1/settlements/*`에 닿음)을 ADR-0285 되돌릴 조건에 보충 한 줄로 적었다. 새 ADR 번호는 쓰지 않는다.
5. **참고(이 묶음 밖)**: ① purchase-svc 릴레이(`relay-app.ts:221-231`)도 같은 경로를 부른다. 릴레이는 서비스 계정이 `purchase-svc-outbox-relay`(차트 `outbox-relay.yaml:3·79`)이고 지금 배포 값이 켜지 않아(차트 기본 `enabled: false`) ADR-0285 결정 4대로 그 배포가 생길 때 원천에 더한다. ② `tools/local/e2e/mesh-netpol.e2e.mjs:72`는 payment-svc REST 게이트웨이를 `gw-fan`·`gw-partner`로 박았는데 생성물은 `gw-partner`뿐이다(웹훅 라우트가 gw-partner로 감). ci-kind MK-01이 깨질 수 있다(손으로 보지 않음).

## 계획

### 1. 범위와 바른 동작

- 원인: 원천(`deploy/platform/mesh/port-allow.yaml:166-172`)과 생성물(`policies.yaml`·`meshless-networkpolicies.yaml`, `node tools/ci/mesh-policies.mjs --check` exit 0)은 BAT-420-rest(6e7a2a7c1)·BAT-425(84f30f86c) 때 purchase-svc를 넣었다. 시험이 스스로 든 기대 표만 그대로다: `INTERNAL_HTTP`(`mesh-policies.test.mjs:77-95`, ADR-0285 결정 9 표 14쌍 + ADR-0288 결정 8), `GRPC`의 `CompensationTransferService: []`(`:129-130`, 근거 주석 `:96-100`은 README §4 '넣지 않은 것' 줄), 배상 송금 0 단언(`:768-770`), 쌍 수 15(`:1111`).
- 그 표들의 정본: gRPC는 `docs/api/proto/README.md` §3 '호출 목록'(시험 주석 `:98`), REST는 ADR-0285 결정 9 표(`:77`). 둘 다 이 커밋에서 보충했다.

허용이 늘어나는 것(정본 근거 1:1):

| # | 받는 쪽·포트·경로 | 새로 받는 신원 | 판 | 정본 근거 | 코드 근거 |
| --- | --- | --- | --- | --- | --- |
| A1 | payment-svc 웨이포인트 `/peaket.payment.v1.CompensationTransferService/RequestCompensationTransfer` | purchase-svc | 운영(웨이포인트 정책) | ADR-0317 결정 1, transfer-refund.md:131, README §3 `:75`(이 커밋) | purchase-svc `refund/adapters/grpc-compensation-transfer.ts:41-58` |
| A2 | payment-svc REST 8080 | purchase-svc | 운영·메시 없는 둘 다 | transfer-refund.md:257, guidelines.md:197, ADR-0285 결정 9 보충 `:48·:54`(이 커밋) | 위 감독에게 1 |

좁아지는 것: payment-svc 웨이포인트 `/…/GetCompensationTransfer`는 purchase-svc를 빼고 아무도 받지 않는다(지금 원천은 `/*`로 연다). 업무 gRPC 포트의 메시 없는 판은 부르는 쪽 합이라 그대로다(purchase-svc는 이미 `PaymentService`로 들어 있다).

### 2. 손댈 파일

| 파일 | 할 일 | 몫 |
| --- | --- | --- |
| `docs/api/proto/README.md` | §2 '부르는 쪽 확인'에 한 문장, §3에 purchase-svc → payment-svc `RequestCompensationTransfer` 행(`:75`)과 기록 줄(`:128`), §4 배상 송금 행을 '실제 지급대행 연결'로 바꿈(`:138`) | 계획(끝남) |
| `docs/adr/0285-…md` | 결정 9 표에 purchase-svc → payment-svc 행(`:48`)과 보충 줄(`:54`), 되돌릴 조건 보충(`:85`). 원래 줄은 그대로 | 계획(끝남) |
| `deploy/platform/mesh/test/mesh-policies.test.mjs` | `GRPC` 배상 송금을 `{ RequestCompensationTransfer: ['purchase-svc'], GetCompensationTransfer: [] }`로(주석 근거 ADR-0317 결정 1·README §3), `INTERNAL_HTTP`에 `['purchase-svc', 'payment-svc']`, `:768-770` 단언과 MS-09·MS-19 이름의 '아무도 없음'·쌍 수(15+1=16), 새 W12M-01 | 시험 |
| `deploy/platform/mesh/port-allow.yaml` | `:172`을 `methods: { GetCompensationTransfer: [], RequestCompensationTransfer: [purchase-svc] }`로, `:166` 주석 근거를 transfer-refund §5 '서킷 연결'로 | 구현 |
| `policies.yaml`·`meshless-networkpolicies.yaml` | 손으로 고치지 않는다. `node tools/ci/mesh-policies.mjs --write`로만 다시 만든다. 기대 차이: 웨이포인트 경로 `/*` → `/RequestCompensationTransfer`, 머리 주석 `:4`의 '부르는 쪽이 없는 업무 gRPC'에 `GetCompensationTransfer`. 메시 없는 판은 차이 없음(있으면 멈추고 까닭을 본다) | 구현 |

서비스 코드는 고치지 않는다.

### 3. 시험 목록

- 시험 담당은 먼저 `peaket-test-antipatterns` 스킬을 읽는다. 기대값은 지금처럼 정본에서 시험이 스스로 들고, 원천·생성기에서 가져오지 않는다(시험 머리 주석 `:3`). ★는 시험만 고친 트리에서 실패해야 한다.

| 시험 | 단언 | 시험만 고친 트리 |
| --- | --- | --- |
| MS-09 ★(기존) | 메서드마다 웨이포인트 주체가 정본 표와 같다. 배상 송금은 Request = purchase-svc, Get = 없음 | 실패(Get이 `/*`로 purchase-svc를 받는다) |
| MS-10(기존) | 받는 포트·신원이 정본 표와 정확히 같다(payment-svc REST: gw-partner·ops-svc·purchase-svc) | 통과 |
| MS-19(기존) | 결정 9 표 15쌍 + ADR-0288 한 쌍(16쌍)마다 REST에 닿고, 표 밖 서비스 신원은 없다 | 통과 |
| W12M-01 ① ★(새) | payment-svc 웨이포인트: `RequestCompensationTransfer`는 purchase-svc 주체 하나뿐(ops-svc·core-svc·web·게이트웨이 다섯 없음), `GetCompensationTransfer`는 0, 어느 규칙에도 `/peaket.payment.v1.CompensationTransferService/*`가 없다 | 실패 |
| W12M-01 ②(새, 지킴) | purchase-svc는 payment-svc REST 8080에 메시·메시 없는 둘 다 닿고, 제어 50061·지표 9464에는 둘 다 닿지 않는다. purchase-svc 릴레이 파드(`component: outbox-relay`)·이름 라벨만 단 파드는 메시 없는 판에서 payment-svc REST에 닿지 않는다(`:1127` PRF-050 시험 꼴) | 통과 |

### 4. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 것 |
| --- | --- | --- |
| M1 | 원천을 서비스 통째 `[purchase-svc]` 그대로 둔다(지금 원천, 넓게 엶) | MS-09·W12M-01 ① |
| M2 | 두 메서드 모두 purchase-svc에 연다(넓게 엶) | MS-09·W12M-01 ① |
| M3 | Request에 ops-svc도 더한다(ADR-0317 맥락에서 버린 ops 송금 경로, 넓게 엶) | MS-09·W12M-01 ① |
| M4 | payment-svc의 메시 없는 출처를 이름 라벨만으로 고르거나 purchase-svc를 제어·지표 포트에도 더한다(넓게 엶) | MS-10·MS-18·W12M-01 ② |
| M5 | payment-svc REST에서 purchase-svc를 뺀다(되돌림) | MS-19·W12M-01 ② |

### 5. 범위 밖

- 릴레이의 바깥 호출, kind e2e 게이트웨이 목록(감독에게 5), REST 경로 단위 거르기(새 ADR 몫), guidelines.md:197의 ADR 표기.

### 6. 게이트

- `node --test deploy/platform/mesh/test/*.test.mjs` 실패 0.
- `node tools/ci/mesh-policies.mjs --check` exit 0(부르는 쪽 없는 업무 gRPC에 `GetCompensationTransfer` 하나), `node --test tools/ci/mesh-policies.test.mjs` 실패 0. `node --test "tools/ci/*.test.mjs"`가 10분을 넘으면 `mesh-policies`·`gateway-routes` 두 파일만.
- `pnpm exec eslint deploy/platform/mesh/test/mesh-policies.test.mjs`(뿌리 설정이 보는 경우), `python tools/doc-check/check_all.py` 오류 0, `node tools/ci/roles-check.mjs`.
- 생성물 diff가 2의 기대 차이뿐인지 본다. 메시 없는 판이 바뀌면 ci-kind도 돌린다.
- **리뷰 담당은 꼭 본다**: 허용이 늘어난 신원·경로(1의 A1·A2)가 정본 근거와 1:1인가, 그 밖에 늘어난 주체·포트·경로가 없는가(생성물 diff 전체를 표와 견준다).

## 실패 확인

- 까닭: 원천이 `CompensationTransferService`를 통째(`/*`)로 purchase-svc에 열어, 부르는 쪽이 없는 `GetCompensationTransfer`까지 purchase-svc를 받는다.
- `node --test deploy/platform/mesh/test/*.test.mjs`(시험만 고친 트리, 201d8cd5e 위): 시험 24·통과 22·실패 2.
  - MS-09: `payment-svc /peaket.payment.v1.CompensationTransferService/GetCompensationTransfer`가 `[purchase-svc]`를 받는다(기대 `[]`).
  - W12M-01 ①: `GetCompensationTransfer를 받는 주체가 있다(부르는 쪽 없음)`, 같은 `[purchase-svc]`.
  - MS-10·MS-19·W12M-01 ②는 통과(정본 표를 고쳐 원천과 맞음).

## 구현 메모

- 바꾼 파일: `deploy/platform/mesh/port-allow.yaml` 하나(원천). payment-svc `CompensationTransferService`를 서비스 통째 `[purchase-svc]`에서 `methods`로 나눠 `RequestCompensationTransfer: [purchase-svc]`, `GetCompensationTransfer: []`로 했다(근거 주석 ADR-0317 결정 1·README §3). REST 줄 주석의 근거를 ADR-0316에서 transfer-refund §5 '서킷 연결'·ADR-0285 결정 9 표 보충으로 고쳤다(감독에게 2).
- 생성물은 `node tools/ci/mesh-policies.mjs --write`로만 다시 만들었다. `policies.yaml` 차이 두 줄뿐: 머리 주석 `:4`의 '부르는 쪽이 없는 업무 gRPC'가 `없음` → `peaket.payment.v1.CompensationTransferService/GetCompensationTransfer`, 웨이포인트 경로 `/…CompensationTransferService/*` → `/…/RequestCompensationTransfer`(같은 주체 purchase-svc). `meshless-networkpolicies.yaml`은 차이 없음. 그 밖에 늘거나 준 주체·포트·경로 없음(계획 2의 기대 차이와 같다, A2는 원천에 이미 있어 생성물 차이 없음).
- 게이트: `node --test deploy/platform/mesh/test/*.test.mjs` 시험 24·통과 24·실패 0(MS-09·W12M-01 ① 통과), `node tools/ci/mesh-policies.mjs --check` exit 0(부르는 쪽 없는 업무 gRPC는 `GetCompensationTransfer` 하나), `node --test tools/ci/mesh-policies.test.mjs` 시험 14·통과 14·실패 0, `python tools/doc-check/check_all.py` 오류 0·경고 4(기존 openapi 3·mermaid 건너뜀 1, 이 묶음과 무관).
- 시험 이의 없음. 시험 파일은 고치지 않았다.

## 시험 결과

- `node --test deploy/platform/mesh/test/*.test.mjs`(49eebb291): 시험 24·실패 0.
- `node --test tools/ci/mesh-policies.test.mjs`(49eebb291): 시험 14·실패 0.

## 리뷰

- 본 것: `git diff origin/develop...HEAD`(b165f9276·201d8cd5e·29526b6d1·49eebb291·7bfb2cf6d), 정본은 ADR-0285 결정 4·5·8·9와 되돌릴 조건, ADR-0288 결정 8(이 묶음이 바꾸지 않음), ADR-0317 결정 1·7, `docs/api/proto/README.md` §2~§4, `docs/features/transfer-refund.md:131·:257`, `docs/features/payment.md:720-721`, `docs/api/guidelines.md:197`. 다시 돌림: `node tools/ci/mesh-policies.mjs --check` exit 0(부르는 쪽 없는 업무 gRPC `GetCompensationTransfer` 하나), `node --test deploy/platform/mesh/test/*.test.mjs` 시험 24·실패 0.
- **결론: 막는 지적 0.** 생성물에서 늘어난 주체·포트·경로는 0이다. `policies.yaml` 차이는 머리 주석 한 줄과 웨이포인트 경로 `/…CompensationTransferService/*` → `/…/RequestCompensationTransfer` 한 줄(주체는 그대로 `cluster.local/ns/purchase/sa/purchase-svc` 하나, `:674-681`)이고, `meshless-networkpolicies.yaml`은 차이가 없다. 계획의 A1·A2는 origin/develop에 이미 있던 허용(BAT-425 84f30f86c)이라 아래 표는 "남은 허용이 정본과 1:1인가"로 본다.

허용 1:1 대조(생성물 diff 전체와 계획 1의 A1·A2):

| # | 받는 쪽·포트·경로 | 주체 | 이 묶음의 변화 | 정본 근거 | 코드 근거 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | payment-svc 웨이포인트 `/peaket.payment.v1.CompensationTransferService/RequestCompensationTransfer` | purchase-svc | 좁힘(서비스 통째 → 메서드 하나) | ADR-0317 결정 1(`0317-…md:16` "ops-svc는 송금을 부르지 않는다"), transfer-refund.md:131 '배상 계좌 입력', 메서드 규칙 꼴은 ADR-0285 결정 8(`:33`) | `services/purchase-svc/src/modules/refund/adapters/grpc-compensation-transfer.ts:41`(`RequestCompensationTransfer`만 든 클라이언트) | 1:1 |
| A1′ | payment-svc 웨이포인트 `/…/GetCompensationTransfer` | 없음 | 닫힘(purchase-svc 빠짐) | 정본·코드 어디에도 부르는 쪽 없음(받는 쪽 `compensation-transfer.grpc.ts:72`와 그 단위 시험뿐), ADR-0285 결정 4 '부르는 쪽 빠진 규칙은 만들지 않는다' | — | 맞음 |
| A2 | payment-svc REST 8080(메시·메시 없는 둘 다) | purchase-svc | 없음(원천 주석 근거만 고침) | transfer-refund.md:257 '서킷 연결', payment.md:721, guidelines.md:197, ADR-0285 결정 9 표 `:48`·보충 `:54`(15쌍, 셌음) | `refund/adapters/http-pg-circuits.ts`(`GET /internal/v1/circuits`), 받는 쪽 `payment/inbound/internal-circuits.controller.ts:15-26` | 1:1(경로 단위는 아래 RV-01) |
| — | payment-svc 업무 gRPC 포트(메시 없는 판) | 부르는 쪽 합 | 없음 | ADR-0285 결정 8 끝 문장(메시 없는 판은 합) | purchase-svc는 `PaymentService`로 이미 들어 있음 | 맞음 |

- 원천: `port-allow.yaml:172-177`이 `methods: { GetCompensationTransfer: [], RequestCompensationTransfer: [purchase-svc] }`로 메서드 단위이고, 생성물은 `--check`가 원천·라우트·proto와 같다고 답한다(손 편집 없음).
- 정본 보충: ADR-0285는 덧붙임뿐이다(표 한 행 `:48`, 보충 문단 `:54`, 되돌릴 조건 한 줄 `:85`, 지운 줄 0). proto README §2 '부르는 쪽 확인'은 줄 끝에 한 문장을 더했고 §3은 행 `:75`·기록 `:128`을 더했다. §4 `:138`만 원래 줄을 고쳐 썼는데, 옛 줄("송금 … 결제사 계약 뒤 더한다")은 R-592(2026-11-15, `payment.proto:484` 서비스 있음) 뒤로 낡은 줄이었고, 남은 사실(ADR-0046, 지급대행 계약 전)은 새 줄에 남겼으며 옮김을 `:128`에 적었다. 뜻을 거꾸로 바꾼 곳은 없다.
- 남는 위험 판단(감독 3): 보안 높음으로 이 묶음에서 막을 것은 아니다. ① payment-svc `InternalSettlementController`(`internal-settlement.controller.ts:61-63`)는 공유 토큰 `InternalTokenGuard`(`packages/platform/src/auth.ts:115-121`, 토큰 값만 견줌)만 보고 부르는 쪽 신원을 보지 않으므로 purchase-svc가 토큰으로 `POST /internal/v1/settlements/*`에 닿는 것은 맞다. ② 그러나 이 허용은 origin/develop에 이미 있고 이 묶음은 넓히지 않았다(생성물 REST 차이 0). ③ 쓰려면 purchase-svc 장악이 먼저 필요하고, 같은 꼴의 core-svc 위험(BAT-420-rest RV-07)도 같은 되돌릴 조건 줄로 다뤘다. 다만 적힌 위험이 실제보다 가볍게 적혔다(RV-01).
- 시험: 기대 표(`INTERNAL_HTTP` 16쌍, `GRPC` 배상 송금 메서드 표, 포트 상수, 릴레이 파드 라벨)는 시험이 스스로 들고 원천·생성기에서 가져오지 않는다. proto 메서드 목록만 정본 proto에서 읽는다(W12M-01 ①). 커밋 경계: 시험 커밋 29526b6d1은 시험 파일과 이 계획만, 구현 커밋 49eebb291은 원천·생성물·이 계획만 건드렸다(시험 파일 0). 계획 커밋 b165f9276의 ADR·README는 계획 몫으로 적힌 대로다.

| 번호 | 등급 | 파일:줄 | 근거와 방향 |
| --- | --- | --- | --- |
| RV-01 | 중간(보안 성격, 기존 위험·이 묶음 밖) | `docs/adr/0285-mesh-port-allow-source-generated-policies.md:85`, `services/payment-svc/src/modules/settlement/application/settlements.ts:481-490·494-498`, `inbound/internal-settlement.controller.ts:137-158` | 보충 줄은 "닿는다"까지만 적었다. 실제로는 `approveBatch`가 `approvalId`를 ops-svc 승인 기록과 견주지 않고 아무 문자열이나 받아 `PENDING_APPROVAL`을 `APPROVED`로 바꾸고, `execution`이 그 상태만 보므로, 공유 토큰을 가진 부르는 쪽은 ops 승인 없이 지급 묶음을 승인·실행할 수 있다(지급처는 확정 정산서의 등록 판매자, 합계 대조 `:504-505`가 있어 돈이 엉뚱한 곳으로 가지는 않는다). 방향: 감독이 정리 목록에 올리고, 대안 2 새 ADR(경로 거르기)이나 앱 층 부르는 쪽 확인(부르는 쪽별 토큰, 또는 승인 ID를 ops-svc에 확인)을 그때 정한다. 보충 줄에 '승인 우회'를 한 구절 더하는 것도 그 묶음 몫 |
| RV-02 | 중간(기존·이 묶음 밖) | `tools/local/e2e/mesh-netpol.e2e.mjs:72·117` | kind 시험 MK-01은 `gw-fan` → payment-svc REST를 '닿음'으로 기대하는데 메시 없는 생성물(`meshless-networkpolicies.yaml:473`)은 `gw-partner`뿐이다. 이 묶음이 바꾼 것이 아니지만 ci-kind가 돌면 빨갛게 될 수 있다(손으로 돌리지 않음). 방향: 라우트 원천을 정본으로 e2e 표를 고치는 작은 묶음 |
| RV-03 | 낮음(이 묶음 밖) | `docs/api/guidelines.md:197` | 서킷 읽기 줄의 근거 ADR-0316(지연 환급 계좌)은 서킷을 다루지 않는다. 이 묶음의 ADR-0285 보충 `:54`가 이 줄을 근거로 가리키므로 표기를 transfer-refund §5 '서킷 연결'로 고치는 일을 정리 목록에 올린다 |
| RV-04 | 낮음(이 묶음 밖) | `services/purchase-svc/src/relay-app.ts:221-231` | 릴레이도 운영에서 `PEAKET_PAYMENT_HTTP_URL`을 꼭 요구하는데 원천에 릴레이 신원이 없다. ADR-0285 결정 4대로 릴레이 배포를 켜는 단계에서 원천·결정 9 표에 함께 더해야 한다(계획 '감독에게 5' ①). 정리 목록에 올린다 |

## 검증

- 임시 사본(7bfb2cf6d, detached)에서 틀린 구현을 하나씩 넣고 `node --test deploy/platform/mesh/test/*.test.mjs`와 `node tools/ci/mesh-policies.mjs --check`를 돌린 뒤 되돌렸다. 원천 표본은 `--write`로 생성물을 다시 만들었고, 생성물 표본(M4)은 생성물에 직접 넣었다. 사본은 `yaml` 패키지가 없어 `corepack pnpm install --frozen-lockfile` 뒤 돌렸다. 넣기 전 기준: 시험 24·통과 24, `--check` exit 0.

| # | 넣은 결함 | 실패한 시험 |
| --- | --- | --- |
| M1 | 원천 `CompensationTransferService: [purchase-svc]` 서비스 통째(`/*`) | MS-09, W12M-01 ①(`--check` exit 0) |
| M2 | 원천 `GetCompensationTransfer: [purchase-svc]`(두 메서드 모두 엶) | MS-09, W12M-01 ①(`--check` exit 0) |
| M3 | 원천 `RequestCompensationTransfer: [ops-svc, purchase-svc]` | MS-09, W12M-01 ①(`--check` exit 0) |
| M4 | 생성물 `meshless-networkpolicies.yaml` payment-svc 8080의 purchase-svc 출처를 이름 라벨만으로(`component: service` 지움) | MS-10, MS-18, W12M-01 ②(`--check` exit 1, 줄 488) |
| M5 | 원천 payment-svc `rest` 부르는 쪽에서 purchase-svc를 뺌 | MS-10, MS-19, W12M-01 ②(`--check` exit 0) |

- 넣은 5·잡힌 5·놓친 0. M4는 '이름 라벨만' 갈래만 넣었다('제어·지표 포트에 더함' 갈래는 표본 5개 상한으로 따로 돌리지 않음).
- 판정 기준 대조 ①: 시험 `GRPC`의 배상 송금 `{ RequestCompensationTransfer: ['purchase-svc'], GetCompensationTransfer: [] }`가 `docs/api/proto/README.md` §3 `:75`·`:39`, ADR-0317 결정 1(ops-svc는 송금을 부르지 않음)과 같다.
- 판정 기준 대조 ②: 시험 `INTERNAL_HTTP` 16쌍 중 15쌍이 ADR-0285 결정 9 표(`purchase-svc → payment-svc` `:48`, 보충 `:54` 포함)와 1:1로 같고, 남은 한 쌍 `purchase-svc → queue-svc`는 ADR-0288 결정 8이다. 경로 `GET /internal/v1/circuits`는 `docs/features/transfer-refund.md` §5 '서킷 연결', `docs/api/guidelines.md:197`과 같다.
- CI: PR #53 실행 44920667562(7bfb2cf6d)에서 `tools-check / tools` success. 같은 실행의 `node / node`·`ci-summary`는 failure이고 이 검증에서 까닭을 보지 않았다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12mesh-plan-8d4c | claude-opus-5-5 | 2026-11-22T00:15+09:00 | 2026-11-22T00:29+09:00 |
| test | w12mesh-test-2f9a | claude-opus-5-5 | 2026-11-22T00:31+09:00 | 2026-11-22T00:41+09:00 |
| impl | w12mesh-impl-5e7b | claude-opus-5-5 | 2026-11-22T00:35+09:00 | 2026-11-22T00:39+09:00 |
| review | w12mesh-review-3a6f | claude-opus-5-5 | 2026-11-22T00:43+09:00 | 2026-11-22T00:47+09:00 |
| verify | w12mesh-verify-7c2d | claude-opus-5-5 | 2026-11-22T00:43+09:00 | 2026-11-22T00:50+09:00 |

## 기록

- R-738. 합치기 전 `origin/develop`(650ef80e0) 위로 다시 쌓음. 다시 쌓은 트리에서 `node --test deploy/platform/mesh/test/*.test.mjs tools/ci/mesh-policies.test.mjs` 38/38, `mesh-policies --check` 통과, `roles-check` 통과(커밋 7).
- PR #53 CI 44920667562: tools-check success(develop에서 처음 끝까지 초록), node는 갈래 2에 맡긴 `@peaket/partner#test` 기준선 실패.
- 정리 목록: `docs/lanes/lane4-cleanup.md`(RV-01 정산 승인 대조 — 감독에게 따로, RV-02~04).
