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

(구현 담당이 채운다)

## 시험 결과

(구현 뒤 시험 담당이 채운다)

## 리뷰

(리뷰 담당이 채운다)

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12mesh-plan-8d4c | claude-opus-5-5 | 2026-11-22T00:15+09:00 | 2026-11-22T00:29+09:00 |
| test | w12mesh-test-2f9a | claude-opus-5-5 | 2026-11-22T00:31+09:00 | 2026-11-22T00:33+09:00 |
