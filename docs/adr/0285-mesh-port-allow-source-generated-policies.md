# ADR-0285: 메시 포트별 허용 정책과 메시 없는 실행의 NetworkPolicy를 한 원천에서 만든다(2026-11-18)

- **상태**: 채택(2026-11-18, 추천 적용, BUILD_ORDER BAT-061 계획 `bat061-plan-ce02fed3`). HOT-420(wbs 2.11.2 ①)을 구현하기 전에 정본 빈칸을 정했다. 방향(Istio 앰비언트, 포트별 허용 표, 메시 없는 실행은 NetworkPolicy)은 [ADR-0082](0082-istio-ambient-mesh-app-boundary-meshless-portfolio-runs.md)와 docs/architecture.md §5 그대로이고, 아래는 그 세부다.
- **관련**: [ADR-0082](0082-istio-ambient-mesh-app-boundary-meshless-portfolio-runs.md)·[ADR-0010](0010-service-discovery-and-internal-calls.md)·[ADR-0102](0102-control-plane-direct-grpc-dedicated-pool-ops-db-audit-chain-worker-break-glass.md)·[ADR-0169](0169-one-public-monorepo-and-private-bot-repository.md), [docs/architecture.md](../architecture.md) §5 '포트별 허용 표'·'메시 기본값 덮어쓰기', [docs/devops.md](../devops.md) §5.2·§14 D-T36, [docs/infra.md](../infra.md) §9, [docs/security/secrets-and-keys.md](../security/secrets-and-keys.md), [docs/api/proto/README.md](../api/proto/README.md) §2·§3, [docs/review/plans/BAT-061.md](../review/plans/BAT-061.md)
- **관련 ID**: D-T36, HOT-420

## 맥락

- 포트별 허용 표(docs/architecture.md §5)는 문서의 표로만 있다. 정책을 만드는 도구가 읽을 원천이 없다(BAT-060 계획 14절).
- 정책을 쓰려면 받는 쪽 포트 번호, 부르는 쪽의 신원 이름, 기본 거부(표에 없는 것은 막음)가 걸리는 범위, 웨이포인트(서비스마다 둔 요청 단위 대리인)를 붙일 Service, `cacerts`(메시 인증서를 찍는 중간 인증 기관 묶음)의 자리, 최소 TLS 1.3을 거는 곳이 필요한데 정본에 없다.
- 표의 REST 행은 내부 HTTP(서비스가 다른 서비스의 REST 포트를 바로 부르는 것)를 부르는 서비스도 REST 포트에 닿는다고 적는다. 그런데 누가 부르는지는 §3.2 REST 행의 한 경로뿐이다. 2026-11-18 코드(커밋 d686e49d)에는 내부 HTTP 호출이 더 있다(아래 결정 9).
- 한 proto 서비스 안에서 메서드마다 부르는 쪽이 다른 곳이 있다. 예를 들어 `peaket.ticket.v1.TicketService`의 `ListTickets`는 팬 웹 앱 서버가, `IssueTickets`는 purchase-svc가 부른다(docs/api/proto/README.md §3). 서비스 단위로만 거르면 웹 앱 서버가 발권을 부를 수 있다.
- 2026-11-18에 확인한 것:
  - istio/ztunnel 저장소 README: 노드 프록시(ztunnel)는 어느 암호 모듈을 골라도 TLS 1.3(암호 묶음 `TLS13_AES_256_GCM_SHA384`·`TLS13_AES_128_GCM_SHA256`)만 쓴다(https://github.com/istio/ztunnel).
  - Istio 문서 'Workload Minimum TLS Version Configuration': `meshConfig.meshMTLS.minProtocolVersion`은 Istio 워크로드 사이 TLS 연결의 최소 판이고, 최대 판은 1.3이다. 앰비언트·노드 프록시는 다루지 않는다(https://istio.io/latest/docs/tasks/security/tls-configuration/workload-min-tls-version/).
  - Istio 문서 'Plug in CA Certificates': `istio-system` 네임스페이스의 Secret `cacerts`에 `ca-cert.pem`·`ca-key.pem`·`root-cert.pem`·`cert-chain.pem` 넷을 넣는다. 이 Secret이 없을 때 istiod가 무엇을 하는지는 적지 않는다(https://istio.io/latest/docs/tasks/security/cert-management/plugin-ca-cert/).
- kind(v0.33.0)는 기본 네트워크 kindnet이 NetworkPolicy를 지킨다(ADR-0082 맥락). kind에는 Istio를 올리지 않는다(ADR-0082 결정 4, BUILD_ORDER BAT-061).

## 결정

1. **원천 파일 하나.** `deploy/platform/mesh/port-allow.yaml`(적용 대상이 아닌 원천)이 포트별 허용 표의 기계 판이다. 규칙의 정본은 문서 표이고, 원천이 문서와 다르면 원천을 고친다. 원천에 담는 것:
   - 워크로드마다: 이름, 네임스페이스(docs/devops.md §5.2 '네임스페이스 지도'), 서비스 계정, 파드 라벨, 포트(REST·업무 gRPC·제어 gRPC·지표)와 포트마다 부르는 쪽.
   - 업무 gRPC는 proto 서비스(전체 이름)마다 부르는 쪽. 한 서비스 안에서 메서드마다 부르는 쪽이 다르면(docs/api/proto/README.md §3 '호출 목록') 메서드마다 적는다.
   - 부르는 쪽 신원 표: 이름마다 운영 신원(서비스 계정)과 메시 없는 실행의 고르개(네임스페이스·파드 라벨).
   - 받는 쪽은 proto 패키지로 정한다. `peaket.<x>.v1`의 x가 core·identity·payment·purchase·queue·ticket·trust면 `<x>-svc`, image는 `image-worker`, seatmap은 `seatmap-worker`, control(`ControlReceiver`)은 제어 gRPC 포트다.
   - REST 포트의 게이트웨이는 원천에 적지 않는다. 생성기가 `deploy/gateways/` 맨 위 YAML 파일의 HTTPRoute `backendRefs`(그 서비스로 경로를 보내는 게이트웨이)와 SecurityPolicy `remoteJWKS` 주소(공개키 묶음을 읽으러 그 서비스의 REST 포트에 닿는 게이트웨이)에서 뽑는다. 라우트가 가리키는 서비스가 원천에 없거나 포트가 다르면 생성은 실패한다.
2. **생성기.** `node tools/ci/mesh-policies.mjs --write|--check [--root <저장소>]`(게이트웨이 라우트 생성기 `tools/ci/gateway-routes.mjs`와 같은 꼴). 만드는 파일은 둘이다: `deploy/platform/mesh/policies.yaml`(운영 오버레이: 웨이포인트, 업무 gRPC Service, Istio 인가 정책 AuthorizationPolicy), `deploy/platform/mesh/meshless-networkpolicies.yaml`(로컬·CI·데모의 NetworkPolicy). 생성 파일은 손으로 고치지 않는다. `--check`는 다시 만든 결과가 저장소 파일과 다르면 1로 끝나고, `gitops-check`(docs/devops.md §3)가 생기기 전에는 `tools-check`가 돌린다. 끝 코드는 0 같음(또는 씀), 1 다름·원천 오류, 2 인자 오류다.
3. **이름과 라벨.** 받는 쪽 노드 프록시 정책 `<워크로드>-ports`, 웨이포인트 정책 `<워크로드>-waypoint-callers`, 웨이포인트 `<워크로드>-waypoint`, 업무 gRPC Service `<워크로드>-grpc`, NetworkPolicy `<워크로드>-ports`. 생성한 객체에는 모두 라벨 `peaket.io/generated-by: mesh-policies`와 `peaket.io/workload: <워크로드>`를 단다.
4. **기본 거부의 범위.** 원천에 있는 워크로드마다 그 파드를 고르는 정책을 하나씩 둔다. 정책이 걸린 파드는 표에 적은 포트·신원만 받는다(Istio ALLOW 정책, NetworkPolicy Ingress). 받는 통신이 없는 워크로드는 규칙 없는 정책(아무것도 받지 않음)을 받는다. 부르는 쪽이 빠진 규칙(모든 출처 허용)이나 포트가 빠진 규칙(모든 포트 허용)은 만들지 않는다. 메시 전체·네임스페이스 전체의 '아무것도 허용하지 않음' 정책과 네임스페이스 기본 차단 NetworkPolicy는 이 생성기가 만들지 않는다. 애드온과 표 밖 워크로드까지 함께 막기 때문이다. 운영 네임스페이스의 기본 차단은 docs/infra.md §9 '네트워크 격리 계층'대로 배포 상태 단계(wbs 0.4.4, BUILD_ORDER BAS-140)가 둔다. 표 밖 워크로드(알림·웹훅 발송 워커, Outbox 릴레이, realtime-gw 등)는 그 배포가 생기는 단계에서 원천에 더한다.
5. **웨이포인트와 디스커버리.** 업무 gRPC를 받는 워크로드마다 웨이포인트 하나(`Gateway`, `gatewayClassName: istio-waypoint`, 듣는 곳 15008 `HBONE`, 라벨 `istio.io/waypoint-for: service`)를 둔다. 업무 gRPC 포트 하나만 내는 Service `<워크로드>-grpc`(고르개는 공용 차트의 서비스 파드 라벨)에 라벨 `istio.io/use-waypoint: <워크로드>-waypoint`를 단다. 기본 Service `<워크로드>`(REST)에는 달지 않는다. 웨이포인트는 Service 단위로 붙어 그 Service의 모든 포트에 걸린다. 기본 Service에 붙이면 내부 HTTP도 웨이포인트를 지나 받는 쪽 노드 프록시에서 웨이포인트 신원으로 보이고, 표의 REST 행('웨이포인트를 지나지 않는다')과 어긋난다. 게이트웨이는 파드 주소로 보내므로(`routingType: Endpoint`) 어느 쪽이든 웨이포인트를 지나지 않는다. 업무 gRPC를 부르는 쪽의 주소는 `<워크로드>-grpc:<포트>`다(배포 값, 예 `deploy/workloads/ops-svc/values.yaml`의 `PEAKET_IDENTITY_GRPC_URL`). 제어 gRPC 포트의 Service(웨이포인트 없음, ADR-0102)는 제어 gRPC를 잇는 단계(BUILD_ORDER OPS-310)가 만든다. 메시 없는 실행에서도 `<워크로드>-grpc` Service는 같다(웨이포인트 라벨은 메시가 없으면 아무 일도 하지 않는다).
6. **포트 번호.** REST 8080(공용 차트 `service.port`), 지표 9464(차트 `managementPort`), 업무 gRPC는 그 서비스 코드가 `PEAKET_GRPC_PORT` 없이 여는 기본값(50051, ticket-svc는 50052)이고 기본값이 없는 워크로드는 50051, 제어 gRPC는 50061 [가정, OPS-310에서 확정]이다. 화면 앱 서버는 라우트의 포트(web 3000, partner 3001)다. 배포 단위 값(`deploy/workloads/<워크로드>/values.yaml`)이 있으면 같은 번호여야 한다.
7. **신원.** 운영은 서비스 계정 주체 `cluster.local/ns/<네임스페이스>/sa/<서비스 계정>`다. 신뢰 도메인은 `cluster.local` 그대로 두고 istiod 값에 적는다. 서비스 계정은 공용 차트대로 워크로드 이름, 웨이포인트는 `<워크로드>-waypoint`다. 게이트웨이 프록시는 Envoy Gateway v1.10이 만드는 서비스 계정 이름을 쓴다. 구현 담당이 고정 판의 소스에서 이름 규칙을 확인해 원천의 신원 표와 docs/infra.md §9 '메시 포트별 허용 정책의 첫 구현' 행에 적고, kind 시험이 실제 프록시 파드의 서비스 계정과 견준다. 클러스터 Prometheus는 `observability/prometheus` [가정, 관측 스택 배포에서 확정], 비상 런북 Job은 `ops-breakglass/ops-breakglass` [가정, OPS-310에서 확정], 화면 앱 서버는 `web/web`·`web/partner` [가정, BAS-140에서 확정]다. 메시 없는 실행은 신원 대신 네임스페이스(`kubernetes.io/metadata.name`)와 파드 라벨을 NetworkPolicy의 한 출처 칸에 함께 둔다(둘 다 맞아야 한다). 서비스 파드는 `app.kubernetes.io/name`·`app.kubernetes.io/component: service`, 게이트웨이 프록시는 `gateway.envoyproxy.io/owning-gateway-name`·`gateway.envoyproxy.io/owning-gateway-namespace`, Prometheus는 `app.kubernetes.io/name: prometheus`다. 비상 런북 Job은 네임스페이스만 본다(Job을 만드는 권한이 비상 역할에만 있다, docs/infra.md §9 '비상 런북 통제').
8. **웨이포인트 정책.** 업무 gRPC 서비스마다(결정 1에서 메서드로 나눈 것은 메서드마다) 규칙 하나를 둔다. 경로는 `/<패키지>.<서비스>/*`(메서드면 `/<패키지>.<서비스>/<메서드>`)이고 출처는 부르는 쪽 주체 목록이다. 받는 쪽 노드 프록시는 업무 gRPC 포트에 그 워크로드의 웨이포인트 하나만 받는다. 메시 없는 실행의 업무 gRPC 포트는 경로로 거르지 못하므로 그 워크로드의 모든 업무 gRPC 부르는 쪽을 합쳐 받는다.
9. **REST 포트의 내부 HTTP 부르는 쪽(2026-11-18 코드에서 뽑음).** 게이트웨이 밖에서 REST 포트에 닿는 신원은 아래뿐이다. 새 내부 HTTP를 더하는 단계는 이 표와 원천에 줄을 함께 더한다. 부르는 곳이 없는 내부 경로(core-svc `/internal/v1/notify/*`·`/internal/v1/reviews/*`, ops-svc `/internal/v1/ops/command-events`·`/internal/v1/fraud-objections`)는 메시 안에서 받지 않는다.

   | 부르는 쪽 | 받는 쪽 | 쓰는 곳(코드) |
   | --- | --- | --- |
   | core-svc | identity-svc | 관리 공개키 묶음 `/internal/jwks/admin.json`(`PEAKET_IDENTITY_JWKS_URL`, 예매자 내보내기 재인증) |
   | core-svc | purchase-svc | 예매자 명단 `/internal/v1/events/{eventId}/attendees`(`PEAKET_PURCHASE_HTTP_URL`) |
   | ops-svc | core-svc | 판매 설정 사본 `/internal/v1/events/{eventId}/sale-config`, 회차 규모 변경 `/v1/ops/events/{eventId}/scale-changes`, 회차 취소·연기의 core 회차 상태 반영 `/internal/v1/events/{eventId}/cancellation-status`(2026-11-19 더함, BUILD_ORDER GAT-110, docs/features/transfer-refund.md §5 'core 회차 상태 반영'), 온세일 윈도우가 끝난 회차 목록 `/internal/v1/events/onsale-closed`(감사 회차 마감 체크포인트, 보충(2026-11-22, BAT-360): 같은 쌍이라 원천 규칙은 그대로이고 구현 커밋이 원천 주석에 경로를 더한다, ADR-0348 결정 9)(`PEAKET_CORE_HTTP_URL`) |
   | ops-svc | identity-svc | 관리 공개키 묶음(`PEAKET_IDENTITY_JWKS_URL`) |
   | ops-svc | payment-svc | 정산·지급 `/internal/v1/settlements/*`, 결제사 차단기 상태 `/internal/v1/circuits`(`PEAKET_PAYMENT_HTTP_URL`) |
   | ops-svc | purchase-svc | 일괄 환불 `/internal/v1/event-refunds`, 판매 중지 `/internal/v1/event-sales/*`, 우선 구매 `/internal/v1/priority-grants`(`PEAKET_PURCHASE_HTTP_URL`) |
   | ops-svc | queue-svc | 판매 중지 사본 `/internal/v1/event-sales/*`, 우선 구매 사본 `/internal/v1/priority-grants`(`PEAKET_QUEUE_HTTP_URL`) |
   | payment-svc | core-svc | 정산 원천 `/internal/v1/events/settlement-due`·`/internal/v1/events/{eventId}/commission-rate`·`/internal/v1/shop/product-settlement-items`(`PEAKET_CORE_HTTP_URL`) |
   | payment-svc | identity-svc | 관리 공개키 묶음(`PEAKET_IDENTITY_JWKS_URL`) |
   | purchase-svc | core-svc | 판매 설정 사본(`PEAKET_CORE_HTTP_URL`) |
   | purchase-svc | payment-svc | 결제사 서킷 상태 `GET /internal/v1/circuits`(`PEAKET_PAYMENT_HTTP_URL`, 회차 취소 일괄 환불의 자동 정지). 보충(2026-11-22, W12-mesh) |
   | purchase-svc | ops-svc | CS 처리함 `/internal/v1/cs-cases`, 운영 경보 `/internal/v1/ops-alerts`(`PEAKET_OPS_HTTP_URL`) |
   | ticket-svc | core-svc | 판매 설정 사본(`PEAKET_CORE_HTTP_URL`) |
   | ticket-svc | ops-svc | 운영 경보 `/internal/v1/ops-alerts`(`PEAKET_OPS_HTTP_URL`) |
   | 팬 웹 앱 서버(web) | identity-svc | 팬 공개키 묶음 `/internal/jwks/fan.json`(`PEAKET_FAN_TOKEN_JWKS_URL`) |
   | identity-svc | core-svc | 판매 설정 사본 `/internal/v1/events/{eventId}/sale-config`(파트너 현장 스태프 초대의 회차 소유 확인, 2026-11-22 BAT-450B, ADR-0353) |

   보충(2026-11-22, W12-mesh): purchase-svc → payment-svc 줄을 더해 표는 15쌍이다. 보충(2026-11-22, BAT-450B): identity-svc → core-svc 줄을 더해 16쌍이다(ADR-0353, `deploy/platform/mesh/port-allow.yaml`의 core-svc REST callers에도 identity-svc를 더했다). 근거는 docs/features/transfer-refund.md §5 '서킷 연결'과 docs/api/guidelines.md §8.1의 'purchase-svc 내부 서킷 상태 읽기' 줄이고(BAT-425 R-716), 원천에는 그때 이미 들어가 있었다. 시험의 정본 표만 따라오지 못했다(계획 docs/review/plans/W12-mesh.md).

   trust-svc의 REST 포트는 gw-fan만 받는다(허니팟 기록 경로 하나, docs/architecture.md §5 '포트별 허용 표'). 이 경로의 라우트는 공개 경로를 설정으로 넣으므로 저장소의 라우트에 없다(docs/infra.md §4.1 '허니팟 경로의 첫 구현'). 그래서 원천에 예외 한 줄로 적는다.
10. **메시 바탕 매니페스트(손으로 쓴다, `deploy/platform/mesh/`).**
    - `namespaces.yaml`: 앰비언트 등록 라벨 `istio.io/dataplane-mode: ambient`를 queue·purchase·ticket·trust·core·web·data·observability·ops-breakglass와 Envoy Gateway 네임스페이스(`envoy-gateway-system`)에 단다. Prometheus는 지표 포트에 신원으로 닿아야 하므로 `observability`도 넣는다. `istio-system`·`kube-system`에는 달지 않는다. 네임스페이스 객체를 누가 가질지(ArgoCD 앱 묶음)는 BAS-140이 정한다.
    - `peer-authentication.yaml`: 메시 전체 STRICT(`istio-system`의 `default`, 고르개 없음). 다른 PeerAuthentication은 두지 않는다(포트·네임스페이스 단위로 STRICT를 푸는 것을 막는다).
    - `istiod-values.yaml`: istiod Helm 값. `meshConfig.meshMTLS.minProtocolVersion: TLSV1_3`, `meshConfig.trustDomain: cluster.local`. Istio 판은 설치하는 단계(BAS-140)에서 고정한다.
    - `cacerts.yaml`: 아래 결정 12의 ExternalSecret.
11. **최소 TLS 1.3을 거는 곳.** istiod 값 `meshConfig.meshMTLS.minProtocolVersion: TLSV1_3` 하나다. 이 값은 Envoy를 쓰는 쪽(웨이포인트, 사이드카로 둔 서비스)에 걸린다. 노드 프록시는 TLS 1.3만 쓰므로 따로 거는 설정이 없다(맥락의 ztunnel README). 이것으로 docs/architecture.md §5 '메시 기본값 덮어쓰기'의 'wbs 2.11.2에서 확인한다'를 닫는다. 실제 연결의 판은 메시가 있는 환경에서 확인한다(운영 확인).
12. **`cacerts`.** ExternalSecret(External Secrets Operator, docs/devops.md §5.2 애드온)이 AWS Secrets Manager 경로 `peaket/<환경>/mesh/cacerts` [가정]의 네 칸을 `istio-system`의 Secret `cacerts`(키 `ca-cert.pem`·`ca-key.pem`·`root-cert.pem`·`cert-chain.pem`)로 만든다. 저장소에는 값이 없다. 비밀 저장소 객체(ClusterSecretStore) 이름은 `aws-secrets-manager` [가정, BAS-140에서 확정]이다. 이 경로를 읽는 저장소 객체는 `istio-system`에서만 쓰게 좁힌다. 종류(ClusterSecretStore)는 그대로 두고 `spec.conditions`의 네임스페이스를 `istio-system` 하나로 두며(다른 네임스페이스의 비밀은 다른 저장소 객체로 받는다), 그 저장소가 쓰는 AWS 역할도 이 경로만 읽는다. 조건이 없으면 어느 네임스페이스의 ExternalSecret이든 같은 경로를 끌어와 아무 서비스 신원이나 찍을 수 있기 때문이다 [가정, BAS-140에서 확정](추천 적용, 2026-11-18, BAT-061 리뷰 RV-04). istiod보다 먼저 맞춰지게 하는 설치 차례는 BAS-140이 정한다. Secret이 없을 때의 istiod 동작은 문서에서 확인하지 못했으므로, 메시가 있는 환경에서 워크로드 인증서의 루트 지문이 오프라인 루트와 같은지 확인한다(운영 확인). 키 목록은 docs/security/secrets-and-keys.md '서비스 메시 중간 CA(`cacerts`)' 행이다.
13. **시험 방법.** 정적 시험은 YAML을 읽어 구조와 값을 견준다. Istio CRD 스키마 검사 도구는 받지 않는다(새 외부 도구라 감독·소유자 몫). kind 시험은 이미 노드에 싣는 고정 Node 이미지(`node:24.18.0-bookworm-slim`, 게이트웨이 대역 백엔드와 같은 것)로 받는 쪽 대역 파드와 부르는 쪽 시험 파드를 띄워 메시 없는 NetworkPolicy를 본다. 새 이미지는 없다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 생성기가 문서 표(markdown)를 바로 읽기 | 기각. 칸이 글이라 해석이 쉽게 깨지고, 메서드 단위 부르는 쪽처럼 표에 없는 정보가 필요하다. 문서는 규칙, 원천은 값으로 나누고 시험이 둘을 견준다 |
| 웨이포인트를 기본 Service에 붙이고 받는 쪽 REST 포트에서도 웨이포인트 신원을 받기 | 이 묶음에서는 기각. 내부 HTTP를 웨이포인트에서 경로로 거를 수 있는 이점(표의 '남는 위험'을 줄임)이 있지만, 표의 REST 행과 다르고 REST 포트가 웨이포인트를 지난 모든 신원을 받게 된다. 아래 '되돌릴 조건'에 둔다 |
| 네임스페이스마다 '아무것도 허용하지 않음' 정책을 함께 두기 | 이 생성기에서는 기각. 표 밖 워크로드와 애드온이 막혀 그 배포가 생길 때까지 깨진다. 기본 차단은 배포 상태 단계가 네임스페이스 단위로 둔다 |
| 웨이포인트 정책을 proto 서비스 단위로만 두기 | 기각. 메서드마다 부르는 쪽이 다른 서비스에서 더 넓은 부르는 쪽이 모든 메서드에 닿는다(맥락의 `TicketService`) |
| 게이트웨이 프록시를 네임스페이스(`envoy-gateway-system`)로만 고르기 | 기각. 다섯 게이트웨이와 컨트롤러·레이트 리밋 서비스가 한 네임스페이스에 있어 '그 경로의 게이트웨이만'을 지키지 못한다 |

## 결과와 트레이드오프

- **좋은 점**: 표 하나(원천)와 라우트에서 운영 정책과 메시 없는 NetworkPolicy가 함께 나와 두 판이 어긋나지 않는다. 라우트를 바꾸면 REST 포트 허용이 따라 바뀌고, 생성 대조가 손으로 고친 정책을 막는다. 메서드 단위 경로로 웨이포인트가 표보다 좁게 거른다.
- **남는 한계**: 메시 아래 동작(mTLS, 신원 인가, TLS 판)은 메시가 있는 환경에서만 확인한다(ADR-0082 '남는 한계'). 게이트웨이 프록시의 서비스 계정 이름은 Envoy Gateway 판에 묶인다(판을 올리면 kind 시험이 본다). 표 밖 워크로드는 원천에 더할 때까지 받는 통신을 막지 않는다. 메시 없는 실행의 업무 gRPC 포트는 부르는 쪽의 합을 받는다.

## 되돌릴 조건

- Envoy Gateway가 프록시 서비스 계정 이름을 정하는 설정을 주면 그 이름으로 고정한다.
- 내부 HTTP를 경로로 거를 필요가 커지면(내부 HTTP 부르는 쪽이 바깥 경로를 부른 사고나 검토 지적) 대안 2를 새 ADR로 다시 본다. 상태를 바꾸는 내부 HTTP가 늘면 그 경로를 여기 적는다. 2026-11-19: core-svc `POST /internal/v1/events/{eventId}/cancellation-status`(회차 취소·연기 반영). 부르는 쪽은 ops-svc뿐이지만 포트 단위라 core-svc REST 포트를 부르는 다른 서비스도 공유 토큰만 있으면 닿는다(BAT-420-rest 리뷰 RV-07).
- 보충(2026-11-22, W12-mesh): payment-svc REST 포트의 부르는 쪽이 ops-svc 하나에서 ops-svc·purchase-svc 둘이 됐다. purchase-svc가 부르는 것은 읽기 `GET /internal/v1/circuits` 하나지만, 포트 단위라 공유 토큰만 있으면 ops-svc 몫의 상태를 바꾸는 `POST /internal/v1/settlements/*`(정산 계산·지급 묶음 승인·실행·미수금)에도 닿는다. 위 '대안 2를 새 ADR로 다시 볼' 때 함께 본다.

## 확인

- BUILD_ORDER BAT-061의 정적 시험(`tools-check`)과 kind 시험(`ci-kind`)이 D-T36 ①~⑦과 이 결정을 본다(계획 `docs/review/plans/BAT-061.md`).
- `python -I -X utf8 tools/doc-check/check_all.py`에 이 변경이 만든 오류가 없다.
