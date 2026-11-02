# tools/local — 로컬·CI kind 클러스터

로컬 PC와 CI가 같은 스크립트로 쿠버네티스 클러스터를 띄워 시험합니다(docs/infra.md §3 '로컬', openspec 변경 `add-local-cluster-and-relay-deployment`). 계정이나 인증 토큰이 필요한 것은 없습니다. 모두 의존성 없는 Node 스크립트이고(차트 렌더 시험만 뿌리 개발 의존성 `yaml`을 씁니다) Node 24와 Docker 엔진이 있어야 합니다.

## 쓰는 법

저장소 뿌리에서 실행합니다.

```bash
node tools/local/cluster.mjs up
```

kind 클러스터 `peaket`을 만들고 Strimzi Kafka, PostgreSQL, AWS 흉내 서버를 띄웁니다(처음에는 이미지를 받느라 몇 분 걸립니다). 사용자의 `~/.kube/config`는 바꾸지 않고 전용 kubeconfig `.cache/peaket-tools/kubeconfig-peaket`을 씁니다.

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
| `cluster.mjs` | `up`·`image`·`observability`·`grafana`·`prometheus`·`status`·`down`. Strimzi 설치 파일은 받아 해시를 본 뒤 네임스페이스·운영자 메모리(512Mi)·운영자 이미지 다이제스트(운영자와 엔티티 운영자·초기화 컨테이너)를 고쳐 올립니다. 설치 파일의 이미지 표 가운데 쓰지 않는 것(Kafka Connect 빌드·브리지 등)은 태그로 남고, 쓰는 Kafka 이미지는 `deploy/local/kafka.yaml`에서 다이제스트로 고정합니다 |
| `chart.test.mjs` | 공용 차트(`deploy/charts/peaket-service`) 렌더 시험 |
| `dashboards.mjs` | 서비스마다 템플릿 대시보드 JSON을 만든다(첫 행 네 신호). `--check`는 커밋된 파일과 견준다 |
| `observability.test.mjs` | 대시보드 생성기, Prometheus·Grafana 매니페스트(다이제스트·권한·익명 보기·클러스터 안 주소), 차트의 수집 주석 시험 |
| `e2e/observability.e2e.mjs` | 실제 kind에서 수집·대시보드 조회 식·Grafana 익명 보기를 봅니다 |
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

## AWS 흉내 서버의 한계(2026-11-01 확인)

- 서명과 IAM 권한을 검사하지 않습니다. 권한 시험은 이것으로 하지 않습니다.
- S3 보존 기한 읽기(`GetObjectRetention`)를 구현하지 않고 객체를 돌려줍니다. 보존 값은 객체 머리(`HeadObject`의 `ObjectLockMode`·`ObjectLockRetainUntilDate`)로 봅니다. 보존·법적 보존이 판 지우기를 막는 것은 같습니다.
- KMS 검증이 틀린 서명에 `KMSInvalidSignatureException` 대신 `SignatureValid: false`로 답합니다. 어댑터는 실제 AWS처럼 예외로 다뤄야 하고, 시험은 두 답을 모두 '검증 실패'로 봅니다.
