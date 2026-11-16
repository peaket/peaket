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
PEAKET_CLUSTER=peaket-gw node tools/local/cluster.mjs gateways
PEAKET_CLUSTER=peaket-gw node tools/local/cluster.mjs gateways-forward   # 다른 창에서, 시험 동안 켜 둔다
PEAKET_CLUSTER=peaket-gw node --test tools/local/e2e/gateways.e2e.mjs
PEAKET_CLUSTER=peaket-gw node --test tools/local/e2e/gateway-limits.e2e.mjs   # 경로별 메서드·한도·게이트웨이 오류(HOT-410). 1분 창 시험이 있어 몇 분 걸린다
node --test tools/local/e2e/queue-cors.e2e.mjs   # 먼저 tools/web-checks에서 pnpm install --frozen-lockfile(Playwright 브라우저 셋)
```

게이트웨이 다섯(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현'·'경로별 메서드·한도·게이트웨이 오류')을 올리고 kind·브라우저 시험을 돌립니다. 접속 정보는 `.cache/peaket-tools/gateways-e2e.json`(개인키가 들어 있어 이 PC에만)입니다.

- **컨트롤러 설정**: 설치 파일의 컨트롤러 설정 자리에 `deploy/gateways/controller/envoy-gateway.yaml`을 그대로 넣습니다(Lua 확장, 전역 레이트 리밋 백엔드, 레이트 리밋 서비스 복제 2·키 접두사 `rl:`). 로컬 덧씌우기는 없습니다: 카운터 저장소는 같은 이름의 Service `peaket-ratelimit-redis`(게이트웨이 네임스페이스, TLS 포트 6379만 여는 Valkey 8.1)이고, 인증서 Secret `peaket-ratelimit-redis-tls`(`tls.crt`·`tls.key`·`ca.crt`)는 v1 무대와 같은 법(`redisTlsCertArgs`)으로 이 PC에서 새로 만듭니다. 레이트 리밋 서비스는 Envoy Gateway가 만드는 Deployment `envoy-ratelimit`입니다.
- **라우트**: API 호스트 다섯의 HTTPRoute는 생성 파일 `deploy/gateways/<게이트웨이>.routes.yaml`입니다(`node tools/ci/gateway-routes.mjs --write`, 원천 `deploy/gateways/routes/`). 생성 파일도 다른 정의처럼 대역 백엔드로 바꿔 올립니다.
- **접속 정보의 새 칸**(BAT-060, `tools/local/e2e/gateway-limits.e2e.mjs` 머리의 약속): `rateLimit`(`namespace`, `deployment`: `envoy-ratelimit`), `rateLimitRedis`(`namespace`, `target`: `deploy/peaket-ratelimit-redis`, `container`: `valkey`, `cli`: TLS로 붙는 `valkey-cli --tls --cacert /tls/ca.crt -h localhost -p 6379`, `plainCli`: 같은 포트에 평문으로 붙는 `valkey-cli -h localhost -p 6379`), `replicas`의 `gw-partner`(1), `stats`(프록시 통계 `19001`·`/stats/prometheus`).
- **확인 경로**(`probes`): 생성 라우트는 계약의 (경로, 메서드)만 넘기므로 계약의 GET 경로입니다. gw-fan은 전역 한도(계정당 60회/분)가 없는 구매 경로의 좌석 스냅샷, gw-partner는 회차 관객 목록, gw-ops는 회차 실시간 현황입니다.
- **대역 백엔드의 Problem 흉내**: 요청 머리 `x-e2e-problem-status: <상태>`를 달면 그 상태와 `application/problem+json` 본문(`traceId`는 받은 `traceparent`의 trace-id)을 돌려줍니다(D-T43 ②).

**Windows에서 하나씩 돌리는 법**: Windows의 kubectl 포트 전달은 동시 연결이 몰리면 끊깁니다(2026-11-16 실측). 끊기면 그 뒤 시험이 모두 ECONNREFUSED가 됩니다. 시험은 끊김을 감추지 않고 실패하므로, 이때는 시험마다 포트 전달을 새로 띄우고 이름으로 하나씩 돌립니다.

```bash
PEAKET_CLUSTER=peaket-gw node tools/local/cluster.mjs gateways-forward &   # 띄운 PID만 끝에 끈다(kubectl을 모두 끄는 taskkill /IM은 쓰지 않는다)
PEAKET_CLUSTER=peaket-gw node --test --test-timeout=300000 --test-name-pattern="^V-T31 ①" tools/local/e2e/gateways.e2e.mjs
```

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
| `cluster.mjs` | `up [--v0-only]`·`image`·`observability`·`grafana`·`prometheus`·`v0`·`v0-forward`·`v1`·`v1-down`·`gateways`·`gateways-forward`·`status`·`down`. 클러스터 이름은 환경 값 `PEAKET_CLUSTER`(기본 `peaket`, kubeconfig는 `.cache/peaket-tools/kubeconfig-<이름>`)로 바꾼다(여러 작업 폴더가 한 PC에서 따로 띄울 때). `gateways`는 게이트웨이 다섯의 바탕이다(docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현', BUILD_ORDER HOT-400): 클러스터가 없으면 만들고, Envoy Gateway 설치 파일(해시 고정, Lua 확장 켬)을 올리고, 이 PC에서 새로 만든 리스너 인증서(자체 서명 하나)·원본 확인 값 Secret·시험 키 넷(fan·admin·staff·admission)을 두고, 대역 백엔드 `gateway-echo`(`gateway-echo.mjs`: 받은 요청을 JSON으로 돌려주고 시험 공개키 묶음을 낸다)와 `deploy/gateways`의 로컬 덧씌우기(`gateway-objects.mjs`: 백엔드는 대역으로, 프록시 Service는 ClusterIP, ReferenceGrant 뺌, 호스트·출처는 그대로)를 올려 다섯이 Programmed가 될 때까지 기다린다. 끝에 컨트롤러가 받지 않은 정의(조건이 참이 아닌 것)를 적고 시험 접속 정보 `.cache/peaket-tools/gateways-e2e.json`(개인키 포함, 이 PC에만)을 쓴다. `gateways-forward`는 다섯을 127.0.0.1:18441~18445(`PEAKET_GATEWAY_BASE_PORT`로 바꿈, `gateways` 전에 정한다)로 잇고 끝날 때까지 돈다. 포트 전달 하나가 끊기면 그 하나만 1초 뒤 다시 띄운다(끊긴 순간의 요청은 실패한다). 시험은 `tools/local/e2e/gateways.e2e.mjs`·`queue-cors.e2e.mjs`다. `v1`은 증명 핵심 측정의 무대(docs/verification.md §3.8 '합본의 v1 무대', BUILD_ORDER PRF-215)다: 합본 이미지(`services/bundle/Dockerfile`)·시뮬레이터를 싣고, 네임스페이스 `v1`에 대기열·좌석 Valkey(TLS 켬이 기본)·전용 PostgreSQL(연결 한도 600, DB `v1_purchase`·`v1_payment`, 새로 만듦)·시험 키 Secret(이 PC에서 새로 만듦)·무대 공개 값 ConfigMap `v1-stage-public`·마이그레이션 잡·Kafka 토픽·합본(복제 3)과 릴레이 둘·대기 상태 파일 앞 nginx 캐시를 올린다. 객체는 `v1-objects.mjs`, 키와 서비스별 환경 파일은 `v1-stage.mjs`가 만든다(시험 `v1-stage.test.mjs`). Strimzi 설치 파일은 받아 해시를 본 뒤 네임스페이스·운영자 메모리(512Mi)·운영자 이미지 다이제스트(운영자와 엔티티 운영자·초기화 컨테이너)를 고쳐 올립니다. 설치 파일의 이미지 표 가운데 쓰지 않는 것(Kafka Connect 빌드·브리지 등)은 태그로 남고, 쓰는 Kafka 이미지는 `deploy/local/kafka.yaml`에서 다이제스트로 고정합니다 |
| `chart.test.mjs` | 공용 차트(`deploy/charts/peaket-service`) 렌더 시험 |
| `dashboards.mjs` | 서비스마다 템플릿 대시보드 JSON을 만든다(첫 행 네 신호). `--check`는 커밋된 파일과 견준다 |
| `observability.test.mjs` | 대시보드 생성기, Prometheus·Grafana 매니페스트(다이제스트·권한·익명 보기·클러스터 안 주소), 차트의 수집 주석 시험 |
| `e2e/observability.e2e.mjs` | 실제 kind에서 수집·대시보드 조회 식·Grafana 익명 보기를 봅니다 |
| `v0-token.mjs` | v0 입구 시험 토큰. 시험 키 쌍을 이 PC에 만들어 개인키는 `.cache/peaket-tools/`에만 두고, 팬 액세스 토큰(ES256, `typ` at+jwt, `aud` fan)을 찍습니다 |
| `e2e/v0-deploy.e2e.mjs` | v0 배포를 실제 kind에서 봅니다(docs/infra.md §3 'v0 배포'의 '확인') |
| `e2e/aws-emulator.e2e.mjs` | AWS 흉내 서버가 우리가 쓰는 기능을 흉내 내는지 봅니다 |
| `e2e/relay-takeover.e2e.mjs` | V-T28 ①의 kind 부분: 쓰기를 흘리며 Outbox 릴레이 리더를 SIGSTOP으로 멈추고 이어받기·빠짐·순서를 봅니다 |

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
| Envoy 레이트 리밋 서비스 | `docker.io/envoyproxy/ratelimit:5ae0682e`(목록 다이제스트 `sha256:b95206e32b1a5f824fb06062fbb85bbdfb7f5de54135e92afe8462f22c979681`, 2026-11-16 레지스트리 조회) | 전역 레이트 리밋의 판정 서버(docs/infra.md §4.1 '전역 레이트 리밋 걸기', BUILD_ORDER HOT-410). 판을 따로 고르지 않고 Envoy Gateway 1.10.0 설치 파일의 기본값을 씁니다(감독 승인 2026-11-16: 공식 레지스트리·다이제스트 고정·판 기록). 로컬에서는 태그로 미리 싣습니다 |

## AWS 흉내 서버의 한계(2026-11-01 확인)

- 서명과 IAM 권한을 검사하지 않습니다. 권한 시험은 이것으로 하지 않습니다.
- S3 보존 기한 읽기(`GetObjectRetention`)를 구현하지 않고 객체를 돌려줍니다. 보존 값은 객체 머리(`HeadObject`의 `ObjectLockMode`·`ObjectLockRetainUntilDate`)로 봅니다. 보존·법적 보존이 판 지우기를 막는 것은 같습니다.
- KMS 검증이 틀린 서명에 `KMSInvalidSignatureException` 대신 `SignatureValid: false`로 답합니다. 어댑터는 실제 AWS처럼 예외로 다뤄야 하고, 시험은 두 답을 모두 '검증 실패'로 봅니다.
