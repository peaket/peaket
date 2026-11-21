# tools/local — 로컬·CI kind 클러스터

로컬 PC와 CI가 같은 스크립트로 쿠버네티스 클러스터를 띄워 시험합니다(docs/infra.md §3 '로컬', openspec 변경 `add-local-cluster-and-relay-deployment`). 계정이나 인증 토큰이 필요한 것은 없습니다. 모두 의존성 없는 Node 스크립트이고(차트 렌더 시험만 뿌리 개발 의존성 `yaml`을 씁니다) Node 24와 Docker 엔진이 있어야 합니다.

## 쓰는 법

저장소 뿌리에서 실행합니다.

```bash
node tools/local/cluster.mjs up
```

kind 클러스터 `peaket`을 만들고 Strimzi Kafka, PostgreSQL, AWS 흉내 서버를 띄웁니다(처음에는 이미지를 받느라 몇 분 걸립니다). 사용자의 `~/.kube/config`는 바꾸지 않고 전용 kubeconfig `.cache/peaket-tools/kubeconfig-peaket`을 씁니다. `up --v0-only`는 v0가 쓰는 PostgreSQL만 띄우고 Kafka·AWS 흉내 서버는 건너뜁니다. 야간 성능 비교가 CPU 4개인 CI 러너에 두 판과 부하 발생기를 함께 놓으려고 씁니다(docs/devops.md §3.3).

```bash
node tools/local/cluster.mjs image
```

서비스 뼈대 이미지(`peaket/example-svc:local`, `packages/platform/template/Dockerfile`)를 만들어 클러스터에 싣습니다.

```bash
node --test tools/local/e2e/aws-emulator.e2e.mjs tools/local/e2e/relay-takeover.e2e.mjs
```

```bash
node tools/local/cluster.mjs observability
node tools/local/cluster.mjs grafana
node tools/local/cluster.mjs prometheus
```

로컬 관측 최소(Prometheus v3.14.0·Grafana 13.2.5, `deploy/local/observability.yaml`)를 올리고 템플릿 대시보드(`deploy/local/dashboards/*.json`)를 Grafana에 싣습니다. `grafana`는 Grafana를 `http://127.0.0.1:3000`에 포트 전달합니다(익명 보기만, 로그인 화면 없음). Prometheus는 `prometheus.io/scrape` 주석을 단 파드(공용 차트의 서비스·릴레이 파드)를 5초마다 긁습니다. 성능 장부는 `node tools/local/cluster.mjs prometheus`(전용 kubeconfig로 127.0.0.1:9090에 포트 전달)를 켜 두고 `collect.py --prom-url http://127.0.0.1:9090`으로 읽습니다(docs/observability.md §3 '로컬 관측 최소와 템플릿 대시보드'). 확인: `node --test tools/local/e2e/observability.e2e.mjs`(relay-takeover가 올린 example-svc를 씁니다).

대시보드는 손으로 고치지 않습니다. 생성기를 고친 뒤 `node tools/local/dashboards.mjs`로 다시 쓰고, CI는 `node --test "tools/local/*.test.mjs"` 안에서 `--check`로 커밋된 파일과 견줍니다.

```bash
node tools/local/cluster.mjs v0
node tools/local/cluster.mjs v0-forward
node tools/local/cluster.mjs v1 [--redis-tls on|off] [--replicas N]
node tools/local/cluster.mjs v1-down
```

v0 배포(K6·K9의 비교 기준, docs/infra.md §3 'v0 배포')를 네임스페이스 `v0`에 올립니다. 이미지 둘(`peaket/v0-monolith:local`·`peaket/pg-simulator:local`)을 만들어 싣고, Valkey 8.1·metrics-server(CPU HPA의 지표)·DB `v0`·Secret(처음 한 번 만든 시험 키, 입구 TLS 인증서)·마이그레이션 잡·PG 시뮬레이터·앱(CPU HPA, 앱 포트는 입구만)·입구(HTTPS 8443, IP 레이트 리밋)를 차례로 올립니다. 토큰 서명 개인키는 이 PC의 `.cache/peaket-tools/v0-token-key.json`에만 두고 클러스터에는 공개키 목록만 넣습니다(`node tools/local/v0-token.mjs sign <계정>`이 시험 토큰을 찍습니다). `v0-forward`는 입구를 `https://127.0.0.1:8443`에 포트 전달합니다(자체 서명 인증서). 확인: `node --test tools/local/e2e/v0-deploy.e2e.mjs`(입구를 거친 v0 흐름, 머리 지우기·토큰·출처·레이트 리밋, 앱 포트 막기, CPU 부하에 HPA가 복제본을 늘리는 것).

`v1`은 증명 핵심 측정의 무대(docs/verification.md §3.8 '합본의 v1 무대')를 네임스페이스 `v1`에 올리고, `v1-down`은 그 네임스페이스와 kind 노드 폴더를 지웁니다(클러스터는 그대로). 전제: 대기 상태 파일 앞 캐시의 고정 판 nginx(`nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc5…`, `v1-objects.mjs`의 `V1_NGINX_IMAGE`)가 이 PC의 Docker에 미리 받아져 있어야 합니다(`docker pull <그 판>`. `v1`은 이미지를 받지 않고, 태그의 이미지 ID가 고정 다이제스트와 같고 Docker 엔진 아키텍처의 매니페스트가 있는지 본 뒤 그 플랫폼 하나만 싣습니다). 같은 클러스터에 다시 올리면 합본·릴레이를 먼저 0개로 줄이고 전용 PostgreSQL·Valkey·시험 키를 새로 만듭니다. 확인: `node --test --test-concurrency=1 loadtest/e2e/v1-rehearsal.e2e.mjs`(무대를 `--replicas 2`로 올린 뒤).

```bash
PEAKET_CLUSTER=peaket-gw node tools/local/cluster.mjs gateways   # 클러스터가 없으면 게이트웨이 포트 매핑을 건 채로 만든다
PEAKET_CLUSTER=peaket-gw node --test tools/local/e2e/gateways.e2e.mjs
PEAKET_CLUSTER=peaket-gw node --test tools/local/e2e/gateway-limits.e2e.mjs   # 경로별 메서드·한도·게이트웨이 오류(HOT-410). 1분 창 시험이 있어 몇 분 걸린다
PEAKET_CLUSTER=peaket-gw node --test tools/local/e2e/gateway-routes.e2e.mjs   # 생성 라우트의 인증 종류·백엔드·시간 상한(BAT-055 웨이브 끝 리뷰 지적)
node --test tools/local/e2e/queue-cors.e2e.mjs   # 먼저 tools/web-checks에서 pnpm install --frozen-lockfile(Playwright 브라우저 셋)
```

게이트웨이 다섯(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현'·'경로별 메서드·한도·게이트웨이 오류')을 올리고 kind·브라우저 시험을 돌립니다. 접속 정보는 `.cache/peaket-tools/gateways-e2e.json`(개인키가 들어 있어 이 PC에만)입니다.

- **이 PC로 잇는 법**(docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법'): kubectl 포트 전달(쿠버네티스 API 서버를 거쳐 파드 포트를 이 PC로 잇는 명령)은 쓰지 않습니다. 포트 전달은 Envoy가 연결 하나를 RST(연결을 바로 끊는 신호)로 끊으면 통째로 끝나, 그 뒤 시험이 모두 연결 거절로 실패했습니다(2026-11-16 CI와 Windows 로컬). 대신 클러스터를 만들 때 kind 노드에 포트 매핑(`extraPortMappings`, 이 PC 쪽은 `127.0.0.1`만)을 걸고, `gateways`가 게이트웨이마다 로컬 전용 NodePort Service `peaket-local-<게이트웨이>`(노드 포트 `gw-queue` 30441, `gw-fan` 30442, `gw-partner` 30443, `gw-ops` 30444, `gw-scanner` 30445)를 둡니다. 그래서 `gateways`가 끝나면 다섯이 곧바로 `https://127.0.0.1:18441~18445`에서 답합니다(`gateways`가 다섯 포트의 TLS 응답까지 기다린 뒤 '준비됨'을 찍습니다). 접속 정보의 `ports`는 kind 노드 컨테이너의 실제 포트 공개(`docker inspect`)에서 읽습니다.
- **이미 있는 클러스터**: 포트 매핑은 클러스터를 만들 때 정해집니다. 이 방식 전에 만든 클러스터(매핑 없음)나 `127.0.0.1` 밖에 열린 클러스터에서는 `gateways`가 다시 만들라는 말과 함께 멈추므로, `node tools/local/cluster.mjs down` 뒤 `up`을 한 번 합니다. 시작 포트를 바꾸려면 `up` 전에 `PEAKET_GATEWAY_BASE_PORT`를 정합니다(한 PC에서 두 클러스터를 같은 시작 포트로 띄우면 두 번째 `up`이 포트를 잡지 못합니다). 만든 kind 설정은 `.cache/peaket-tools/kind-<클러스터 이름>.yaml`에 남습니다(`deploy/local/kind.yaml`에 매핑만 더한 것).
- **컨트롤러 설정**: 설치 파일의 컨트롤러 설정 자리에 `deploy/gateways/controller/envoy-gateway.yaml`을 그대로 넣습니다(Lua 확장, 전역 레이트 리밋 백엔드, 레이트 리밋 서비스 복제 2·키 접두사 `rl:`). 로컬 덧씌우기는 없습니다: 카운터 저장소는 같은 이름의 Service `peaket-ratelimit-redis`(게이트웨이 네임스페이스, TLS 포트 6379만 여는 Valkey 8.1)이고, 인증서 Secret `peaket-ratelimit-redis-tls`(`tls.crt`·`tls.key`·`ca.crt`)는 v1 무대와 같은 법(`redisTlsCertArgs`)으로 이 PC에서 새로 만듭니다. 레이트 리밋 서비스는 Envoy Gateway가 만드는 Deployment `envoy-ratelimit`입니다.
- **라우트**: API 호스트 다섯의 HTTPRoute는 생성 파일 `deploy/gateways/<게이트웨이>.routes.yaml`입니다(`node tools/ci/gateway-routes.mjs --write`, 원천 `deploy/gateways/routes/`). 생성 파일도 다른 정의처럼 대역 백엔드로 바꿔 올립니다.
- **접속 정보의 새 칸**(BAT-060, `tools/local/e2e/gateway-limits.e2e.mjs` 머리의 약속): `rateLimit`(`namespace`, `deployment`: `envoy-ratelimit`), `rateLimitRedis`(`namespace`, `target`: `deploy/peaket-ratelimit-redis`, `container`: `valkey`, `cli`: TLS로 붙는 `valkey-cli --tls --cacert /tls/ca.crt -h localhost -p 6379`, `plainCli`: 같은 포트에 평문으로 붙는 `valkey-cli -h localhost -p 6379`), `replicas`의 `gw-partner`(1), `stats`(프록시 통계 `19001`·`/stats/prometheus`).
- **확인 경로**(`probes`): 생성 라우트는 계약의 (경로, 메서드)만 넘기므로 계약의 GET 경로입니다. gw-fan은 전역 한도(계정당 60회/분)가 없는 구매 경로의 좌석 스냅샷, gw-partner는 회차 관객 목록, gw-ops는 회차 실시간 현황입니다.
- **대역 백엔드의 늦은 응답**: 요청 머리 `x-e2e-delay-ms: <밀리초>`(60,000까지)를 달면 그만큼 기다린 뒤 답합니다(W7-CON-02 경로별 시간 상한).
- **대역 백엔드의 Problem 흉내**: 요청 머리 `x-e2e-problem-status: <상태>`를 달면 그 상태와 `application/problem+json` 본문(`traceId`는 받은 `traceparent`의 trace-id)을 돌려줍니다(D-T43 ②).

```bash
node tools/local/cluster.mjs mesh-netpol   # gateways 뒤에(게이트웨이 프록시 파드가 있어야 MK-08이 본다)
node --test --test-timeout=300000 tools/local/e2e/mesh-netpol.e2e.mjs
```

메시 없는 실행의 포트별 허용 NetworkPolicy(D-T36, ADR-0285 결정 13, BUILD_ORDER HOT-420)를 봅니다. kind에 Istio는 올리지 않고, 기본 네트워크 kindnet이 NetworkPolicy를 지킵니다.

- **올리는 것**: 원천 `deploy/platform/mesh/port-allow.yaml`의 워크로드마다 받는 쪽 대역(Deployment·Service `<워크로드>`, 복제 1, 라벨은 원천 `podLabels`에 대역 라벨 `peaket.io/mesh-netpol: stand-in`을 더한 것)과 생성 파일 `deploy/platform/mesh/meshless-networkpolicies.yaml`(그대로 적용)입니다. 대역은 그 워크로드의 모든 포트(REST·업무 gRPC·제어·지표)에서 TCP 연결을 받아 `ok\n`을 쓰고 닫습니다. 네임스페이스(워크로드·부르는 쪽의 것)는 없을 때만 만듭니다. 이미지는 게이트웨이 대역 백엔드와 같은 고정 Node 이미지라 새로 받는 것이 없습니다.
- **대역 라벨**: Service·Deployment 고르개에 대역 라벨이 있어, 부르는 쪽 라벨을 단 시험 파드가 같은 네임스페이스에 떠도 대역 Service의 끝점이 되지 않습니다. NetworkPolicy는 원천 `podLabels`만 봅니다.
- **접속 정보**: `.cache/peaket-tools/mesh-netpol-e2e.json`(비밀 없음, 환경 값 `PEAKET_MESH_NETPOL_E2E`로 바꿈). 칸은 `image`(시험 파드 이미지), `reply`, `policies`, `namespaces`, `standInLabel`, `workloads`(워크로드마다 `namespace`·`host` `<워크로드>.<네임스페이스>.svc.cluster.local`·`ports`(`rest`·`grpc`·`control`·`metrics` 가운데 있는 것))입니다.
- 내리는 명령은 없습니다. 다시 돌려도 됩니다(덮어쓰기). 클러스터를 지우면(`down`) 함께 없어집니다.

```bash
node tools/local/cluster.mjs kyverno --env demo   # Kyverno 3.10.0 설치 + 데모 정책(감사) 적용
node --test --test-timeout=900000 tools/local/e2e/kyverno.e2e.mjs  # 시험 담당이 더하면
```

Kyverno CEL 입장 정책(docs/devops.md §4.3, D-T11·D-T18 ②·D-T33, BUILD_ORDER BAS-150·BAT-085, ADR-0318)을 kind에서 봅니다. `kyverno`는 차트 3.10.0(appVersion v1.20.0)을 `deploy/platform/kyverno/values.yaml`(복제 3·PDB `minAvailable: 2`·관제 풀·이미지 다이제스트 고정)로 설치하고, `deploy/policies/kyverno/envs/<환경>/policies.yaml`을 적용한 뒤 admission controller가 준비될 때까지 기다립니다. 환경은 `--env demo|staging|prod`(기본 demo)입니다. 서명·출처 검증 시험은 테스트 서명 키를 시험할 때 임시 폴더에 만들고 지웁니다(저장소에 비밀 키를 두지 않습니다). 오프라인 검증 PoC의 기준은 `docs/review/measurements/BAT-085-offline-verify.md`, GHCR 익명 끌어오기는 `BAT-085-ghcr.md`에 적습니다.

```bash
node tools/local/cluster.mjs down
```

판단 부분의 시험은 클러스터 없이 돕니다.

```bash
node --test "tools/local/*.test.mjs"
```

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `tools.mjs` | kind·kubectl·helm을 공식 주소에서 받아 표의 SHA-256과 견주고, 맞을 때만 `.cache/peaket-tools`(커밋하지 않음)에 둡니다. 압축으로 받는 helm은 푼 실행 파일의 해시도 표에 있습니다. 받아 둔 것도 쓸 때마다 표의 해시와 다시 견줍니다 |
| `cluster.mjs` | `up [--v0-only]`·`image`·`observability`·`grafana`·`prometheus`·`v0`·`v0-forward`·`v1`·`v1-down`·`gateways`·`gateways-admission`(`restore`·`empty`·`remove`)·`mesh-netpol`·`kyverno [--env demo|staging|prod]`·`status`·`down`. `kyverno`는 Kyverno 3.10.0을 설치하고 그 환경의 CEL 정책을 적용한다(BUILD_ORDER BAS-150·BAT-085, ADR-0318). `mesh-netpol`은 메시 없는 포트별 허용 NetworkPolicy 무대다(위 '메시 없는 실행', 객체는 `mesh-netpol-objects.mjs`). 클러스터 이름은 환경 값 `PEAKET_CLUSTER`(기본 `peaket`, kubeconfig는 `.cache/peaket-tools/kubeconfig-<이름>`)로 바꾼다(여러 작업 폴더가 한 PC에서 따로 띄울 때). `gateways`는 게이트웨이 다섯의 바탕이다(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', BUILD_ORDER HOT-400): 클러스터가 없으면 만들고, Envoy Gateway 설치 파일(해시 고정, Lua 확장 켬)을 올리고, 이 PC에서 새로 만든 리스너 인증서(자체 서명 하나)·원본 확인 값 Secret·시험 키 넷(fan·admin·staff·admission)과 입장 토큰 시험 키 넷(지금 키 = admission·다음 키·끝 시각이 남은 옛 키·끝 시각이 지난 옛 키, 공개 부분은 gw-fan 프록시가 받는 ConfigMap `peaket-admission-jwks`, docs/infra.md §4.1 '입장 토큰 확인', BAT-057)을 두고, 대역 백엔드 `gateway-echo`(`gateway-echo.mjs`: 받은 요청을 JSON으로 돌려주고 시험 공개키 묶음을 낸다)와 `deploy/gateways`의 로컬 덧씌우기(`gateway-objects.mjs`: 백엔드는 대역으로, 프록시 Service는 ClusterIP, ReferenceGrant 뺌, 프록시 envoy 컨테이너의 CPU 요청만 `100m`(정의의 2 × 다섯 파드가 CI의 vCPU 4 러너에 들어가지 않는다. 일꾼 수 2·메모리 요청·한도 없음은 정의 그대로, ADR-0287 결정 4), 호스트·출처는 그대로)를 올려 다섯이 Programmed가 될 때까지 기다린다. 이어서 게이트웨이마다 로컬 전용 NodePort Service `peaket-local-<게이트웨이>`(노드 포트 30441~30445)를 두고, 시험 접속 정보 `.cache/peaket-tools/gateways-e2e.json`(개인키 포함, 이 PC에만)을 쓰고, 컨트롤러가 받지 않은 정의(조건이 참이 아닌 것)를 적고, 다섯 포트가 TLS로 답할 때까지(60초) 기다린다. 이 PC 포트는 클러스터를 만들 때 건 kind 포트 매핑(127.0.0.1:18441~18445, `PEAKET_GATEWAY_BASE_PORT`로 바꿈, `up` 전에 정한다)이고 접속 정보의 `ports`는 노드 컨테이너의 실제 공개에서 읽는다. 매핑이 없거나 127.0.0.1 밖에 열린 클러스터면 `down` 뒤 `up`으로 다시 만들라며 멈춘다. kubectl 포트 전달은 쓰지 않는다. 시험은 `tools/local/e2e/gateways.e2e.mjs`·`queue-cors.e2e.mjs`다. 접속 정보의 `admission`(`issuer`·`current`·`next`·`previous`·`expired`, 옛 키 둘은 `{ jwk, until }`)과 확인 경로의 `admission: true`(gw-fan 구매 경로는 입장 토큰도 붙인다)는 BAT-057이 더했다. `gateways-admission`(`restore`·`empty`·`remove`)는 그 ConfigMap을 처음 값·빈 묶음·지움으로 바꾸고 gw-fan 프록시를 다시 띄워 옛 파드가 사라질 때까지 기다린다(복구 경로 장애 주입). `v1`은 증명 핵심 측정의 무대(docs/verification.md §3.8 '합본의 v1 무대', BUILD_ORDER PRF-215)다: 합본 이미지(`services/bundle/Dockerfile`)·시뮬레이터를 싣고, 네임스페이스 `v1`에 대기열·좌석 Valkey(TLS 켬이 기본)·전용 PostgreSQL(연결 한도 600, DB `v1_purchase`·`v1_payment`, 새로 만듦)·시험 키 Secret(이 PC에서 새로 만듦)·무대 공개 값 ConfigMap `v1-stage-public`·마이그레이션 잡·Kafka 토픽·합본(복제 3)과 릴레이 둘·대기 상태 파일 앞 nginx 캐시를 올린다. 객체는 `v1-objects.mjs`, 키와 서비스별 환경 파일은 `v1-stage.mjs`가 만든다(시험 `v1-stage.test.mjs`). Strimzi 설치 파일은 받아 해시를 본 뒤 네임스페이스·운영자 메모리(512Mi)·운영자 이미지 다이제스트(운영자와 엔티티 운영자·초기화 컨테이너)를 고쳐 올립니다. 설치 파일의 이미지 표 가운데 쓰지 않는 것(Kafka Connect 빌드·브리지 등)은 태그로 남고, 쓰는 Kafka 이미지는 `deploy/local/kafka.yaml`에서 다이제스트로 고정합니다 |
| `mesh-netpol-objects.mjs` | `mesh-netpol`의 배치(원천에서 워크로드·네임스페이스·포트), 받는 쪽 대역 객체, 시험 접속 정보(BUILD_ORDER HOT-420, ADR-0285 결정 13) |
| `chart.test.mjs` | 공용 차트(`deploy/charts/peaket-service`) 렌더 시험 |
| `dashboards.mjs` | 서비스마다 템플릿 대시보드 JSON을 만든다(첫 행 네 신호). `--check`는 커밋된 파일과 견준다 |
| `observability.test.mjs` | 대시보드 생성기, Prometheus·Grafana 매니페스트(다이제스트·권한·익명 보기·클러스터 안 주소), 차트의 수집 주석 시험 |
| `e2e/observability.e2e.mjs` | 실제 kind에서 수집·대시보드 조회 식·Grafana 익명 보기를 봅니다 |
| `v0-token.mjs` | v0 입구 시험 토큰. 시험 키 쌍을 이 PC에 만들어 개인키는 `.cache/peaket-tools/`에만 두고, 팬 액세스 토큰(ES256, `typ` at+jwt, `aud` fan)을 찍습니다 |
| `e2e/v0-deploy.e2e.mjs` | v0 배포를 실제 kind에서 봅니다(docs/infra.md §3 'v0 배포'의 '확인') |
| `e2e/aws-emulator.e2e.mjs` | AWS 흉내 서버가 우리가 쓰는 기능을 흉내 내는지 봅니다 |
| `e2e/relay-takeover.e2e.mjs` | V-T28 ①의 kind 부분: 쓰기를 흘리며 Outbox 릴레이 리더를 SIGSTOP으로 멈추고 이어받기·빠짐·순서를 봅니다 |
| `demo-images.mjs` | BAT-087 데모 이미지 10개의 계획·정적 점검(`--check`)·빌드(`--build`). 기존 `bundle`·`ops-svc`·`pg-simulator`는 재사용합니다 |
| `demo-objects.mjs` | 데모 무대의 순수 객체·값: 워크로드 표, 네임스페이스, PostgreSQL·Valkey·Kafka 토픽, Secret, 모의 기관, 실제 백엔드를 보는 게이트웨이 객체(출처 포트·bundle 네임스페이스) |
| `demo-auth.mjs` | 데모 인증 도우미: 팬 gRPC `CreateSession`, 관리·파트너 공개 로그인(비밀번호+TOTP), 패스키 CDP 입력, 데모 비밀 생성(`prepare`) |
| `demo-seed.mjs` | `deploy/envs/demo/seed/base.yaml` 검사(`--check`)·적용(`--apply`). 부트스트랩 Job 뒤 공개·관리 API로 시드하고 개수를 다시 읽습니다. 로컬 데모 예외로 공연장·스태프 배정은 직접 SQL로 넣습니다(README '로컬 데모 전용 예외') |
| `e2e/demo-stage.e2e.mjs` | `demo`→`demo-seed`→게이트웨이 응답→`demo-down` 연기 시험(시험 담당 몫, 계획 §6 DS-07~10) |
| `demo.mjs` | BAT-086 한 명령 데모 재현: `all`·`doctor`·`plan`·`up`·`seed`·`play`·`status`·`compat`·`cloud-plan`·`down`. 선행이 없으면 닫힌 실패(exit 1), 모르는 인자·시나리오는 exit 2 |
| `demo/scenarios.mjs` | S1~S9 정의(화면 번호·계정·선행·결과 확인). `plan --check`가 정본 d5 §10.6 표와 대조 |
| `demo/runner.mjs` | Playwright 재생기: 시나리오마다 새 맥락, 조건 기다리기, 실패 그림, S1~S9 실제 API·화면 재생(증거 전용 화면은 `evidenceOnlyScreens`) |
| `demo/measure.mjs` | 측정 Markdown(`docs/review/measurements/BAT-086-demo.md` 정본 + 실행별 `BAT-086-demo-<runId>.md`)과 비밀 가리기 |
| `demo/compat.mjs` | 운영 판 호환 검사 시연(D-T48): 임시 복제본에서 같은 커밋 통과·마지막 출시 태그 실패 |
| `demo/cloud-plan.mjs` | `deploy/demo/cloud-plan.yaml` 값 검사(TTL·예산 산술·정리 차례·서명 GHCR) |

```bash
node tools/local/cluster.mjs demo [--skip-build] [--only <목록>]
node tools/local/cluster.mjs demo-seed [--check|--apply] [--json]
node tools/local/cluster.mjs demo-status [--json]
node tools/local/cluster.mjs demo-down
```

BAT-086 재현 스크립트가 도는 **로컬 데모 무대**를 올립니다(계획 `docs/review/plans/BAT-087.md`, 정본 `docs/infra.md` §3 '로컬 데모 무대'). 클러스터는 `lane4-demo`, kubeconfig는 `.cache/peaket-tools/kubeconfig-lane4-demo`이고 다른 갈래의 `peaket`·`lane4-*` 클러스터는 건드리지 않습니다. `demo`가 ① 이미지 13개(새 이미지 10개 + `bundle`·`ops-svc`·`pg-simulator`) 빌드·kind 적재 ② 네임스페이스 여섯(`queue`·`purchase`·`ticket`·`trust`·`core`·`web`) ③ PostgreSQL 하나(논리 DB 여섯)·Valkey·Kafka 토픽·Secret ④ 마이그레이션 잡 ⑤ 공용 차트 ⑥ 실제 백엔드를 보는 게이트웨이 ⑦ 준비 대기까지 합니다. 중간에 하나라도 실패하면 그 자리에서 멈추고 exit 1이며 '준비됨'을 찍지 않습니다.

- **이미지**: `peaket/<워크로드>:demo`, `pullPolicy: Never`. 새 이미지는 `services/{identity-svc,ticket-svc,trust-svc,core-svc,realtime-gw}`와 `apps/{web,partner,console-host,scanner}`,`apps/web/queue-room`의 Dockerfile 10개입니다. `node tools/local/demo-images.mjs --check`가 폴더·기본 이미지 다이제스트·`latest` 없음·비루트 사용자·`.dockerignore` 예외를 정적으로 보고, `--build`는 Docker 잠금 안에서만 부릅니다. `bundle`(queue·admission·purchase·payment), `ops-svc`, `pg-simulator`는 기존 이미지를 그대로 씁니다.
- **환경**: `PEAKET_ENV=local`입니다(`demo`가 아닙니다: 합본은 `local`·`ci`에서만 시작하고 identity KMS·웹 모의 OIDC 제공자도 local 전제입니다).
- **호스트·포트**: 정본 이름에 이 PC 포트를 붙입니다(`https://www.peaket.example:18441`~`https://scanner.peaket.example:18445`). identity gRPC는 `127.0.0.1:19051`, 모의 본인확인기관은 `127.0.0.1:18920`입니다. 브라우저는 Playwright `--host-resolver-rules=MAP *.peaket.example 127.0.0.1`·`ignoreHTTPSErrors: true`, 사람은 hosts 파일을 씁니다(아래 표).
- **인증**: `node tools/local/demo-auth.mjs fan <accountKey>`·`admin <accountKey>`가 표준 출력 한 줄 JSON `{ accountKey, kind, cookies, passkey? }`를 냅니다. 팬은 identity gRPC `CreateSession`, 관리·파트너는 공개 로그인 API(비밀번호→TOTP)입니다. 모의 OIDC 제공자는 올리지 않습니다. 값은 `.cache/peaket-tools/demo-secrets/`(0600)에만 있습니다.
- **시드**: `demo-seed --check`가 참조·비밀 없음·개수 계약을 보고, `--apply`가 부트스트랩 Job 둘 뒤 공개·관리 API로 공연·회차·좌석맵·기기·판매 승인을 넣습니다. 승인 전에 purchase-svc가 읽는 좌석맵 판 파일(`/tmp/seatmaps/{eventId}.json`)을 `kubectl exec`로 bundle 파드에 채웁니다(로컬 데모 전용 예외). 두 번 적용해도 개수가 같고, 두 번째에는 좌석맵을 다시 PUT하지 않지만 판 파일은 다시 씁니다. `--json`은 `created`(`counts`, `purchaseSeatMaps` 포함)·`total`·`eventIds`를 냅니다. 첫 관리자·promoter만 부트스트랩 예외이고 **감사 기록이 남지 않습니다(한계)**.
- **로컬 데모 전용 예외(직접 SQL)**: 파트너 공연 목록·상세·스태프 초대 API가 아직 core-svc에 없어(HOT-260·R-548), 로컬 데모 시드만 공연장(`place`)과 스태프 배정(`staff_assignment`)을 직접 SQL로 넣고 기존 공연·회차·스태프를 찾는 읽기도 SQL로 합니다. 공연·회차·좌석맵·기기는 공개·관리 API로만 만듭니다. 판매 심사 제출은 BAT-616의 `POST /v1/partner/productions/{productionId}/sale-review`를 씁니다. 좌석맵 판 파일은 core의 `/var/peaket/public`과 purchase의 `/tmp/seatmaps`가 달라 시드가 bundle 파드에 직접 씁니다(운영은 LCH-080이 정합니다). 이 예외는 운영·클라우드에 쓰지 않습니다.
- **정리**: `demo-down`은 데모 네임스페이스 여섯만 지우고 `lane4-demo` 클러스터는 남깁니다. 두 번 불러도 exit 0입니다.
- **한계**: 합본 재사용(운영 모양과 다름), 로컬 전용 이미지(GHCR·서명 없음), 부트스트랩 감사 없음, OTel 수집기·`image-worker` 없음. 자세한 것은 `deploy/envs/local/demo/README.md`.

```bash
node tools/local/demo-images.mjs --check
node tools/local/demo-seed.mjs --check
node tools/local/cluster.mjs demo-status --json
```

## 한 명령 데모 재현(BAT-086)

빈 PC에서 무대·시드·시연 S1~S9·측정·정리까지 한 번에 합니다(계획 `docs/review/plans/BAT-086.md`, ADR-0325). Node 24와 Docker가 있어야 하고, Playwright는 `tools/web-checks`의 1.64.1을 빌려 씁니다(새 패키지 없음). `doctor`는 패키지와 chromium 실행 파일을 함께 보고, 없으면 설치 명령과 함께 exit 1입니다.

```bash
pnpm --dir tools/web-checks install --frozen-lockfile
pnpm --dir tools/web-checks exec playwright install chromium
node tools/local/demo.mjs doctor
node tools/local/demo.mjs all
```

- **명령**: `all`(무대 → 시드 → S1~S9 → 측정 → 정리), `down`, `status`, `up`, `seed`, `play`, `doctor`, `plan`, `compat`, `cloud-plan`. `all`은 `--skip-build`(이미지가 이미 있으면), `--seed-only`, `--skip-play`, `--keep`(무대를 남김), `--scenarios S1,S4`, `--headed`, `--video`, `--measure <파일>`을 받습니다.
- **두 경로**: 로컬(기본, 0원)은 BAT-087의 `peaket/<워크로드>:demo`와 `deploy/envs/local/demo` 오버레이를, 클라우드(선택)는 `deploy/envs/demo/*.yaml`의 서명 GHCR 다이제스트를 씁니다. 클라우드는 이 묶음에서 실행하지 않고 `deploy/demo/cloud-plan.yaml`의 값 검사(TTL 6시간 [가정]·예산 5만 원 상한·정리 차례)와 `docs/devops.md` §5.1 절차로만 둡니다. 같은 `play`가 두 경로에 쓰입니다.
- **시나리오**: 정본은 `docs/design/d5-screen-blueprint.md` §10.6입니다. `node tools/local/demo.mjs plan --check`가 화면 번호·순서를 대조합니다. S1~S9 모두 실제 API·화면으로 끝까지 부릅니다. S1·S3·S4·S6은 구매 세션 서명(ECDH+HKDF)과 데모 PG 시뮬레이터, S2는 대기열 Redis 매진 픽스처, S5는 팬 재인증·취소, S7은 패스키 재인증·2인 승인(API 세션 둘), S8은 보존한 DPoP 기기 키·판정 넷, S9는 회차 취소·일괄 환불입니다. 화면 방문 실패는 시나리오 실패이고, 증거로만 여는 화면은 `scenarios.mjs`의 `evidenceOnlyScreens`에 적습니다(S1 SCR-001, S5 SCR-014·SCR-041, S9 SCR-044·SCR-043). 확인하지 못한 시나리오는 통과로 세지 않습니다.
- **데모 시계**: 회차 오픈을 지금+30초로 당기고(파트너 회차 고치기, 공개 전에만), 화면의 조건을 기다립니다. 고정 `sleep`으로 화면을 넘기지 않습니다.
- **측정**: `all`은 `docs/review/measurements/BAT-086-demo.md`(정본)와 실행별 `BAT-086-demo-<runId>.md`에 커밋·날짜·PC·도구 판·콜드 스타트(명령 시작~첫 화면)·전체 시간·시나리오별 결과·정리 결과를 씁니다. 실패한 실행도 지우지 않고 실패 단계를 남깁니다. `play`만 돌리면 정본을 덮지 않고 `docs/review/measurements/play/`에 씁니다. `--seed-only`·`--skip-play`처럼 0건 실행은 '건너뜀'으로 적고 통과로 세지 않습니다. 비밀·토큰·쿠키는 싣지 않습니다.
- **호환 시연**: `node tools/local/demo.mjs compat`는 임시 `git clone --shared`에서 같은 커밋 통과와 `v0.0.0` 태그와 견준 깨짐(응답 필드 하나 삭제) 검출을 보입니다(계획의 `v0.0.0-demo`는 출시 태그 규칙 vX.Y.Z 밖이라 v0.0.0을 씁니다). 실제 저장소·원격·태그는 건드리지 않고, Docker가 없으면 exit 2입니다.
- **한계**: S7의 2인 승인은 API 세션 둘(브라우저 맥락 하나)입니다. S8은 보존한 DPoP 키로 기기를 등록하지만 실제 카메라·기기는 쓰지 않습니다. Docker·kind 실행은 Docker 잠금(`bash D:/ticketpass-locks/lock.sh take docker <갈래-묶음>`) 안에서 합니다.

## 고정 판(2026-11-01)

| 무엇 | 판 | 고른 까닭 |
| --- | --- | --- |
| kind | v0.33.0 | 최신. 노드 이미지는 이 판이 만든 `kindest/node:v1.35.8`을 다이제스트로 고정합니다(`deploy/local/kind.yaml`) |
| kubectl | v1.35.8 | 노드 쿠버네티스와 같은 판(판 차이 없음) |
| helm | v3.22.1 | ArgoCD가 그리는 v2 차트 형식과 같습니다. 4.x로 갈 이유가 아직 없습니다 |
| Strimzi | 0.47.0 | Kafka 3.9를 받는 마지막 판입니다(0.48.0이 3.9를 뺐고 1.x는 4.2 이상만). 운영 MSK와 같은 3.9.x를 쓰려고 고릅니다(docs/devops.md §9.4). 더 고쳐지지 않는 판이라 로컬·CI에만 씁니다 |
| Kafka | 3.9.1(KRaft, 브로커 겸 컨트롤러 하나) | Strimzi가 3.9.2 이미지를 내지 않습니다. 통합 시험의 공식 컨테이너는 3.9.2입니다 |
| PostgreSQL | 18(`postgres:18-alpine` 다이제스트) | 통합 시험과 같은 이미지 |
| AWS 흉내 서버 | moto 5.2.5(Apache-2.0) | LocalStack은 계정·인증 토큰이 있어야 떠서(infra §3) 계정 없는 대역으로 바꿨습니다(추천 적용 2026-11-01) |
| Prometheus | v3.14.0(다이제스트, 2026-11-02 확인) | 로컬 관측 최소의 지표 저장소. exemplar 저장을 켭니다(docs/observability.md §2) |
| Grafana | 13.2.5(다이제스트, 2026-11-02 확인) | 로컬 관측 최소의 대시보드. 13.2 줄의 최신 고침 판입니다 |
| metrics-server | v0.9.1(설치 파일 해시·이미지 다이제스트, 2026-11-03 확인) | v0 배포의 CPU HPA 지표. kind 노드의 kubelet 인증서가 자체 서명이라 `--kubelet-insecure-tls`를 더합니다 |
| Valkey | 8.1(`valkey/valkey:8.1-alpine` 다이제스트) | v0 배포의 대기열 Redis. 통합 시험과 같은 이미지입니다 |
| Envoy Gateway | 1.10.0(설치 파일 해시·컨트롤러 이미지 다이제스트, 프록시는 이 판의 기본 Envoy 1.40.2 다이제스트, 2026-11-16 확인) | 게이트웨이 다섯의 컨트롤러(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', BUILD_ORDER HOT-400). 공식 릴리스(envoyproxy)의 최신 안정판이고, 게이트웨이가 쓰는 출처 확인(`SecurityPolicy.csrf`)·응답 머리 `addIfAbsent`·Lua 환경 값 허용이 이 판에 있습니다. 로컬에서는 컨트롤러·프록시 이미지를 태그로 미리 싣습니다(`cluster.mjs gateways`) |
| Kyverno | 차트 3.10.0(appVersion v1.20.0), 네 컨트롤러 이미지 다이제스트 고정(2026-11-20 GHCR 목록 다이제스트) | Kyverno CEL 입장 정책의 kind 시험(BUILD_ORDER BAS-150·BAT-085, ADR-0318). `cluster.mjs kyverno`가 Helm으로 설치하고 그 환경의 정책을 적용합니다. 차트는 `deploy/platform/kyverno/values.yaml`(복제 3·PDB 2·관제 풀·이미지 다이제스트) |
| Envoy 레이트 리밋 서비스 | `docker.io/envoyproxy/ratelimit:5ae0682e`(목록 다이제스트 `sha256:b95206e32b1a5f824fb06062fbb85bbdfb7f5de54135e92afe8462f22c979681`, 2026-11-16 레지스트리 조회) | 전역 레이트 리밋의 판정 서버(docs/infra.md §4.1 '전역 레이트 리밋 걸기', BUILD_ORDER HOT-410). 판을 따로 고르지 않고 Envoy Gateway 1.10.0 설치 파일의 기본값을 씁니다(감독 승인 2026-11-16: 공식 레지스트리·다이제스트 고정·판 기록). 로컬에서는 태그로 미리 싣습니다 |

## AWS 흉내 서버의 한계(2026-11-01 확인)

- 서명과 IAM 권한을 검사하지 않습니다. 권한 시험은 이것으로 하지 않습니다.
- S3 보존 기한 읽기(`GetObjectRetention`)를 구현하지 않고 객체를 돌려줍니다. 보존 값은 객체 머리(`HeadObject`의 `ObjectLockMode`·`ObjectLockRetainUntilDate`)로 봅니다. 보존·법적 보존이 판 지우기를 막는 것은 같습니다.
- KMS 검증이 틀린 서명에 `KMSInvalidSignatureException` 대신 `SignatureValid: false`로 답합니다. 어댑터는 실제 AWS처럼 예외로 다뤄야 하고, 시험은 두 답을 모두 '검증 실패'로 봅니다.
