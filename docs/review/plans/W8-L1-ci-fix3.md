# 작업 계획: W8-L1-ci-fix3(develop CI kind 잡: 게이트웨이 시험을 포트 전달 대신 포트 매핑으로 잇기)

- **무엇**: develop CI(실행 43865738562, 커밋 `3256c93f`)에서 실패한 `kind / kind` 잡(job ID 133,294,220,765. 쉼표는 문서 검사의 12자리 숫자 규칙 때문이고 명령에는 붙여 쓴다)을 고치는 일의 작업 목록이다(docs/architecture.md §8.6, ADR-0281). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane1-cf3`, 가지 `wave/lane1-w8-cifix3`, 출발점 `origin/develop` `3256c93f`. 2026-11-16 작성. 같은 실행의 다른 실패 셋(`web / budgets`, `loadtest-check`, `node / node`)은 묶음 W8-L1-ci-fix2가 고친다. 이 폴더에는 `node_modules`가 없다(감독이 Docker 잠금과 함께 준비한다).
- **묶음 ID와 차례**: 묶음 표에 없는 일이라 이 파일 이름 `W8-L1-ci-fix3`을 쓴다. 코드 묶음이고 **정방향 묶음**이다(이 계획 커밋에 `Batch-Order: impl-first`). 차례는 계획 → 구현 → 독립 시험 담당의 시험(구현 전 트리 `3256c93f`에서 실패 확인) → 시험 통과 → 리뷰 → 검증 → 기록이다.
- **등급**: B(배포·운영 도구, 로컬·CI 시험 통로). 틀린 구현 표본은 아래 '틀린 구현 목록'이다.
- **정본**: docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현'(이 계획 커밋이 '로컬 kind에서 이 PC로 잇는 법' 줄을 더했다), docs/devops.md §3 워크플로 표 `ci-kind.yml` 행(이 계획 커밋이 한 문장을 더했다), docs/infra.md §3 '로컬 클러스터', ADR-0281 결정 1~3·5. 시험 판정 값은 각 시험의 정본(V-T31 ① 1,000건, SR-T13 ② 초당 50건·모아 두기 50건 등)을 그대로 둔다.

## 계획

### 1. 원인(감독이 로그에서 확인한 사실과 이 계획 담당이 코드에서 다시 본 것)

1. **CI 사실**(job ID 133,294,220,765, `gh run view 43865738562 --repo peaket/peaket --job <kind 잡 ID> --log`):
   - `gateways.e2e.mjs`는 43개 가운데 22개 통과, 21개 실패. 같은 `run` 블록이 `bash -e`라 그 뒤의 `queue-cors`·`gateway-limits`·`gateway-routes`는 돌지 않았다.
   - 첫 고장은 12:37:35 V-T31 ①(`gateways.e2e.mjs` 79줄, 1,000건을 동시 4로)에서 `ECONNRESET 127.0.0.1:18442`. 같은 때 kubectl 포트 전달 다섯이 모두 `portforward.go:424 … error forwarding port 10443 to pod …: read tcp4 127.0.0.1:…->127.0.0.1:10443: read: connection reset by peer` 뒤 `error: lost connection to pod`로 끝났다. `cluster.mjs` `gatewaysForward`(837~868줄)가 1초 뒤 다시 띄우지만, 그 사이에 돈 V-T31 ②·identity §3은 1~3ms 만에 ECONNREFUSED로 실패했다.
   - 그 뒤 B-T18 ①~④부터 HOT-400 PRF-030까지는 통과했다. 그러다 SR-T13 ②(485줄 근처, 300건을 동시 50으로 몰아 보내기)에서 다시 `socket hang up`이 났고, 그 뒤 526~811줄의 시험 열일곱이 모두 ECONNREFUSED였다(18441·18442·18443·18445).
   - 게이트웨이 파드와 정의는 모두 Running·Programmed였다. 고장 난 것은 게이트웨이가 아니라 **시험 통로**(kubectl 포트 전달)다.
2. **구조**(이 계획 담당이 본 코드):
   - `.github/workflows/ci-kind.yml` 57~72줄: `node tools/local/cluster.mjs gateways-forward`를 뒤에서 띄우고 다섯 포트가 열리기만 기다린 뒤 e2e 넷을 잇달아 돈다.
   - `tools/local/gateway-objects.mjs` `gatewayForwardArgs`: `kubectl port-forward svc/<프록시 Service> <포트>:443`. 로컬 덧씌우기(`localGatewayObjects`)는 프록시 Service를 `ClusterIP`로 둔다. kind 설정 `deploy/local/kind.yaml`에는 포트 매핑이 없다.
   - kubectl 포트 전달은 파드 쪽 연결 하나가 RST로 끝나면 그 전달 전체를 끝낸다('lost connection to pod'). Envoy는 정상 동작 안에서도 연결을 RST로 닫을 수 있다(한도 넘김, 몰아 보내기, 클라이언트가 먼저 닫음 등). 그래서 많이 보내는 시험 하나가 그 뒤 시험 모두를 무너뜨린다.
   - 로컬도 같다. `tools/local/README.md`의 'Windows에서 하나씩 돌리는 법'이 '동시 연결이 몰리면 끊긴다(2026-11-16 실측)'고 적고 시험마다 포트 전달을 새로 띄우라고 한다. BAT-055 계획(`docs/review/plans/BAT-055.md` 500·520줄)에도 Q-T41 ④ 뒤 끊김과 firefox ② 끊김이 적혀 있다. '로컬에서는 통과'는 운 좋게 안 끊긴 판이거나 하나씩 돌린 판이다.
   - 동시 수를 이미 4로 묶은 V-T31 ①에서도 CI에서 끊겼다. 동시 수만 줄여서는 막지 못한다.

### 2. 고칠 길과 고른 것

| 길 | 무엇 | 판단 |
| --- | --- | --- |
| 가. 동시 연결을 묶고 시험마다 포트가 다시 열리기를 기다리기 | 정본이 동시 수를 정하지 않은 시험(V-T31 ① 동시 4, SR-T13 ② 동시 50 등)의 동시 수를 줄이고, 시험 앞마다 다섯 포트가 답할 때까지 기다린다 | 고르지 않음 |
| 나. kind 포트 매핑과 NodePort로 잇기 | 클러스터를 만들 때 kind 노드에 `extraPortMappings`(이 PC `127.0.0.1:18441~18445` → 노드의 고정 포트)를 걸고, 게이트웨이마다 그 노드 포트를 받는 로컬 전용 NodePort Service를 둔다. 포트 전달은 쓰지 않는다 | **고름(추천 적용 2026-11-16)** |
| 다. 시험을 클러스터 안 파드에서 돌리기 / 클라우드 부하 분산기 흉내(cloud-provider-kind) | 시험 Job 파드가 Service 이름으로 붙거나, 따로 도구를 더해 LoadBalancer를 흉내 낸다 | 고르지 않음 |

- **가를 고르지 않는 까닭**:
  - V-T31 ①은 이미 동시 4인데 끊겼다. 동시 수를 더 줄여도 끊김의 확률만 낮출 뿐 RST 하나에 전달 전체가 죽는 구조는 그대로다.
  - SR-T13 ②는 정본(초당 50건, 모아 두기 50건)을 넘기려면 1초에 50건 넘게 보내야 한다. 동시 수를 크게 줄이면 한도를 넘기지 못해 시험이 무엇을 보는지가 흐려진다. 판정 값은 낮추지 않는다(감독 조건 ①).
  - '포트가 다시 열릴 때까지 기다리기'는 끊긴 동안 보낸 요청이 실패하는 것을 막지 못한다. 막으려고 다시 보내기까지 넣으면, 게이트웨이가 정말로 연결을 잘못 끊는 결함도 다시 보내기로 감춰진다(흔들림을 가릴 위험).
- **나를 고르는 까닭**:
  - 연결 하나의 RST는 그 연결만 끝낸다. Docker 포트 공개 → 노드 → kube-proxy(노드의 Service 전달 규칙) → 프록시 파드는 연결마다 따로라, 한 시험의 몰아 보내기가 다음 시험의 통로를 죽이지 않는다. 그래도 요청마다 ECONNRESET이 남으면 그것은 게이트웨이의 실제 동작이라 시험이 그대로 본다(감추지 않는다).
  - 운영의 길(부하 분산기 → Service → 프록시)과 가깝다. 포트 전달은 Service 이름을 받아도 파드 **하나**에만 붙지만, NodePort는 복제 모두로 나눈다. `SR-T13 ②`는 이미 '파드마다 센다'를 복제 수(`replicas`)로 곱해 보므로 나눠 받아도 판정이 맞다.
  - 로컬과 CI가 같은 길이다(docs/infra.md §3 'CI 시험 환경도 같은 구성'). Windows에서 '하나씩 돌리기' 우회가 필요 없어진다.
  - 판정 값과 시험 파일의 단언은 바꾸지 않는다. 시험 쪽은 접속 정보 파일의 `ports`만 보므로(`gateway-client.mjs` 머리 주석의 약속 1) 그대로 돈다.
  - 비용: 포트 매핑은 클러스터를 만들 때 정해진다. 이미 있는 로컬 클러스터는 `down` 뒤 `up`이 한 번 필요하다. 한 PC에서 클러스터 둘을 같은 시작 포트로 띄우면 두 번째 `up`이 포트를 잡지 못해 실패한다(그때는 `PEAKET_GATEWAY_BASE_PORT`를 바꾼다. Docker 잠금으로 한 번에 한 갈래만 kind를 띄우므로 보통은 없다).
- **다를 고르지 않는 까닭**: 시험 파드는 저장소·Playwright 브라우저·접근 로그를 읽는 kubectl 권한을 파드 안에 다시 갖춰야 해서 바뀌는 것이 크다. cloud-provider-kind는 고정할 도구가 하나 늘고, 나와 같은 효과를 더 많은 부품으로 낸다.
- **NodePort를 어떻게 두나(나의 세부, 추천 적용 2026-11-16)**:
  1. Envoy Gateway가 만드는 프록시 Service는 그대로 `ClusterIP`로 둔다. 프록시 설정(`EnvoyProxy`)은 게이트웨이 넷이 하나(`peaket-proxy`)를 함께 쓰므로, 거기서 Service를 NodePort로 바꾸면 노드 포트를 게이트웨이마다 다르게 고정할 수 없다.
  2. 대신 `cluster.mjs gateways`가 게이트웨이마다 **로컬 전용 Service** 하나를 더 만든다. 이름은 `peaket-local-<게이트웨이>`, 네임스페이스는 `envoy-gateway-system`, `type: NodePort`, 고르개는 `gateway.envoyproxy.io/owning-gateway-name: <게이트웨이>`(접속 정보 `logs.selector`와 같은 라벨), 포트는 443 → 프록시 컨테이너의 HTTPS 포트(Envoy Gateway가 만든 그 게이트웨이 Service의 443 포트 `targetPort`를 읽어 그대로 쓴다. 지금 10443), `nodePort`는 아래 고정 값.
  3. 노드 포트 고정 값 `GATEWAY_NODE_PORTS`: `gw-queue` 30441, `gw-fan` 30442, `gw-partner` 30443, `gw-ops` 30444, `gw-scanner` 30445(쿠버네티스 NodePort 범위 30000~32767 안, `GATEWAY_NAMES` 차례).
  4. `cluster.mjs up`은 `deploy/local/kind.yaml`을 읽어 control-plane 노드에 `extraPortMappings` 다섯(`containerPort` = 위 노드 포트, `hostPort` = 시작 값 + 차례(0~4), `listenAddress: 127.0.0.1`, `protocol: TCP`)을 더한 설정을 `.cache/peaket-tools/` 아래 파일로 써서 `kind create cluster --config`에 넘긴다. 저장소의 `deploy/local/kind.yaml`은 바꾸지 않는다. 시작 값은 `PEAKET_GATEWAY_BASE_PORT`(없으면 18441). `--v0-only`·`v1` 무대로 만든 클러스터에도 똑같이 건다(포트만 잡아 둔다).
  5. `cluster.mjs gateways`는 접속 정보의 `ports`를 환경 값으로 계산하지 않고, kind 노드 컨테이너(`<클러스터 이름>-control-plane`)의 실제 포트 공개(`docker inspect`의 `HostConfig.PortBindings`의 `<노드 포트>/tcp`)에서 읽는다. 다섯 가운데 하나라도 없으면 '이 클러스터는 게이트웨이 포트 매핑 없이 만들었다. `node tools/local/cluster.mjs down` 뒤 `up`으로 다시 만든다'는 뜻의 오류로 멈춘다. 공개 주소가 `127.0.0.1`이 아니면 같은 꼴로 멈춘다(이 PC 밖에 열지 않는다).
  6. `gateways`는 '준비됨'을 찍기 전에 다섯 포트가 TLS 손 맞잡기(접속 정보의 호스트 이름 SNI, `caPem` 신뢰)를 마치는지 60초까지 기다린다. 그래서 CI 워크플로의 포트 기다림 고리는 필요 없다.
  7. `gateways-forward` 명령과 `gatewayForwardArgs`는 지운다(쓰는 곳이 CI·README·시험 셋뿐이다. 길을 둘로 두면 다시 포트 전달로 돌아가 같은 흔들림을 낸다). `v0-forward`(v0 입구)는 이 묶음 밖이라 그대로 둔다.
  8. `.github/workflows/ci-kind.yml`: 게이트웨이 `run` 블록에서 `gateways-forward` 띄우기와 `/dev/tcp` 기다림 고리를 지우고 e2e 넷(`gateways` → `queue-cors` → `gateway-limits` → `gateway-routes`, `--test-timeout=300000`)은 그 차례 그대로 둔다. 실패 때 단계의 `cat gateways-forward.log`는 지우고, 대신 로컬 전용 Service와 노드 포트 공개를 적는다(`kubectl -n envoy-gateway-system get svc -o wide`, `docker port <노드 컨테이너>`).
  9. `tools/local/README.md`: 게이트웨이 실행법에서 `gateways-forward` 줄과 'Windows에서 하나씩 돌리는 법'을 지우고, 이미 있는 클러스터는 `down` 뒤 `up`이 한 번 필요하다는 것을 적는다. 명령 표 행에서 `gateways-forward`를 뺀다.
- 정본: 이 계획 커밋이 docs/infra.md §4.1에 '로컬 kind에서 이 PC로 잇는 법' 줄을, docs/devops.md §3 `ci-kind.yml` 행에 한 문장을 더했다.

### 3. 공개 인터페이스

- `tools/local/gateway-objects.mjs`가 새로 내놓는 것:
  - `GATEWAY_NODE_PORTS`: 위 2의 3 객체(얼린 객체).
  - `gatewayPortMappings(basePort)`: `GATEWAY_NAMES` 차례로 `{ containerPort, hostPort, listenAddress: '127.0.0.1', protocol: 'TCP' }` 다섯.
  - `gatewayNodePortService(gw, targetPort)`: 위 2의 2 Service 객체 하나(`apiVersion: 'v1'`, `kind: 'Service'`).
  - `gatewayHostPorts(portBindings)`: `docker inspect`의 `HostConfig.PortBindings` 객체를 받아 `{ <게이트웨이>: 이 PC 포트(수) }`를 돌려준다. 하나라도 없거나 `HostIp`가 `127.0.0.1`이 아니면 던진다(메시지에 `down`과 `up`이 든다).
  - 지우는 것: `gatewayForwardArgs`.
- `tools/local/cluster.mjs`가 새로 내놓는 것: `kindClusterConfig(basePort)`(위 2의 4 설정 객체. `deploy/local/kind.yaml`의 다른 칸은 그대로). 명령 `gateways-forward`는 없어진다(쓰는 법 글에서도 뺀다).
- 접속 정보 파일(`gateway-client.mjs` 머리 주석의 약속)은 칸 이름·모양이 그대로다. `ports`의 값이 실제 공개 포트에서 온다는 것만 바뀐다.

### 4. 손댈 파일

| 파일 | 담당 | 무엇 |
| --- | --- | --- |
| `docs/infra.md` §4.1 | 계획(이 커밋) | '로컬 kind에서 이 PC로 잇는 법' 줄 |
| `docs/devops.md` §3 표 `ci-kind.yml` 행 | 계획(이 커밋) | 포트 전달 없이 잇는다는 문장 |
| `tools/local/gateway-objects.mjs` | 구현(먼저) | 위 3의 넷, `gatewayForwardArgs` 지우기 |
| `tools/local/cluster.mjs` | 구현 | `kindClusterConfig`, `up`의 설정 파일, `gateways`의 Service·포트 읽기·TLS 기다림, `gateways-forward` 지우기 |
| `.github/workflows/ci-kind.yml` | 구현 | 위 2의 8 |
| `tools/local/README.md` | 구현 | 위 2의 9 |
| `tools/local/cluster.test.mjs` | 시험(구현 뒤) | CF3-01·02·04·05. 지운 `gatewayForwardArgs`를 부르는 기존 시험이 있으면 시험 담당이 정리한다 |
| `tools/ci/check-workflows.test.mjs` | 시험 | CF3-03 |
| `tools/local/e2e/gateways.e2e.mjs` | 시험 | CF3-06(파일 끝에 더한다. 다른 시험의 단언·판정 값은 바꾸지 않는다) |

- **구현 담당이 알아 둘 것**: Docker를 쓰는 실행(`up`·`gateways`·e2e)은 감독이 Docker 잠금을 잡아 줄 때만 한다(공통 규칙). 클러스터 이름은 `lane1-`로 시작한다. 구현 커밋 전에 클러스터 없이 도는 `node --test "tools/local/*.test.mjs"`가 통과하는지 본다(지운 `gatewayForwardArgs`를 부르는 시험이 있으면 그 실패는 시험 담당 몫으로 '시험 결과'에 남는다). 잠금을 받으면 한 바퀴(`up` → `gateways` → e2e 넷)를 돌려 보고 결과를 커밋 본문에 적는다.

### 5. 시험 목록

- 이름 꼴: `CF3-<두 자리> <정본 ID> <설명>`(§8.6의 7). 정본 ID는 게이트웨이 첫 구현의 단계 ID `HOT-400`이다(근거 줄은 docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법').
- **시험 담당은 구현을 보지 않고 쓴다(ADR-0281 결정 2)**: 단언 값(노드 포트 다섯, 시작 값 18441, `127.0.0.1`, Service 이름·고르개·종류, 워크플로 단계 차례, 오류 메시지의 `down`·`up`)은 이 계획 2·3과 정본(docs/infra.md §4.1 새 줄)에서 가져온다.
- **구현 전 트리에서 실패 확인(ADR-0281 결정 3, 감독 조건 ③)**: '실패 확인' 절에 아래 둘을 함께 적는다.
  1. **CI 실패 로그**: 실행 43865738562, job ID 133,294,220,765, 첫 실패 12:37:35(V-T31 ① ECONNRESET 127.0.0.1:18442와 포트 전달 다섯의 'lost connection to pod'), 43개 가운데 21개 실패, 뒤 셋 안 돎. `gh run view 43865738562 --repo peaket/peaket --job <kind 잡 ID> --log`에서 그 줄들을 골라 시각과 함께 옮긴다.
  2. **로컬 재현**(감독이 Docker 잠금을 잡아 줄 때, 한 바퀴 약 15분): 구현 전 트리(`git -C D:/ticketpass-lane1-cf3 archive 3256c93f`를 푼 폴더나 감독이 꺼낸 분리 HEAD)에서 `PEAKET_CLUSTER=lane1-cf3pre`로 `up` → `gateways` → `gateways-forward`를 뒤에서(띄운 PID 기록) → CI와 같은 e2e 넷을 같은 차례로. 포트 전달 기록(표준 오류)의 'lost connection to pod' 수와 시각, 실패한 시험 수·첫 실패 시험·까닭을 적는다. 끊김은 확률적이라 한 바퀴에 안 나면 한 번 더 돌린다. 두 번 다 안 나면 그렇다고 적는다(그때 CF3-06의 구현 전 실패는 CI 로그로만 센다).
  - 단위 시험 CF3-01·02·04·05는 구현 전 트리에서 내놓는 함수가 없어 '실행이 안 되는 실패'다(세지 않는다). 이 넷은 검증 담당의 틀린 구현으로 실패를 본다(아래 M-01~M-12). CF3-03은 구현 전 트리의 `ci-kind.yml`에서 단언 실패를 본다.
- **다 되었다고 보는 기준(감독 조건 ②)**:
  1. 고친 가지에서 로컬 kind 같은 묶음(`up` → `gateways` → `gateways.e2e`(43+CF3-06) → `queue-cors` → `gateway-limits` → `gateway-routes`, CI와 같은 `--test-timeout=300000`)을 **두 번** 돌려 두 번 다 실패 0. 두 바퀴 사이에 `down`·`up`을 다시 한다. '시험 결과' 절에 바퀴마다 파일별 통과·실패 수와 걸린 시간을 적는다.
  2. 합친 뒤 develop CI `kind / kind` 잡 초록(기록 담당이 실행 번호를 적는다).

| 시험 | 파일 | 단언 | 구현 전 트리(`3256c93f`)에서 |
| --- | --- | --- | --- |
| CF3-01 HOT-400 kind 클러스터 설정은 게이트웨이 다섯을 127.0.0.1의 시작 포트부터 노드 포트로 잇는다 | `tools/local/cluster.test.mjs` | `kindClusterConfig(18441)`의 control-plane 노드 `extraPortMappings`가 정확히 다섯이고 `{30441→18441, 30442→18442, 30443→18443, 30444→18444, 30445→18445}`, 모두 `listenAddress: '127.0.0.1'`·`protocol: 'TCP'`. `kindClusterConfig(20001)`은 hostPort 20001~20005. 노드 이미지 칸은 `deploy/local/kind.yaml`과 같다 | 실행 안 됨(함수 없음) |
| CF3-02 HOT-400 로컬 전용 NodePort Service는 게이트웨이마다 고정 노드 포트로 그 게이트웨이 프록시만 고른다 | 같은 파일 | `gatewayNodePortService(gw, 10443)`가 다섯 게이트웨이마다 이름 `peaket-local-<gw>`, 네임스페이스 `envoy-gateway-system`, `type: 'NodePort'`, 고르개가 `gateway.envoyproxy.io/owning-gateway-name: <gw>` 하나, 포트 하나(443 → `targetPort` 10443, `nodePort` = `GATEWAY_NODE_PORTS[gw]`). 다섯의 `nodePort`가 서로 다르고 30000~32767 안 | 실행 안 됨 |
| CF3-03 HOT-400 ci-kind는 포트 전달 없이 게이트웨이 시험 넷을 그 차례로 돈다 | `tools/ci/check-workflows.test.mjs` | `ci-kind.yml`에 `gateways-forward`와 `port-forward` 글자가 없고, `cluster.mjs gateways` 단계 뒤에 `gateways.e2e.mjs` → `queue-cors.e2e.mjs` → `gateway-limits.e2e.mjs` → `gateway-routes.e2e.mjs`가 이 차례로 있으며, 넷 모두 `--test-timeout=300000` | 실패(`gateways-forward`가 있다) |
| CF3-04 HOT-400 접속 정보의 포트는 노드 컨테이너의 실제 공개 포트다 | `tools/local/cluster.test.mjs` | `gatewayHostPorts`에 `{ '30441/tcp': [{ HostIp: '127.0.0.1', HostPort: '18441' }], … }`(다섯)을 주면 `{ 'gw-queue': 18441, …, 'gw-scanner': 18445 }`(수). 공개 포트가 차례와 다른 값(예 gw-fan 25000)이어도 그 값을 그대로 돌려준다(시작 값으로 계산하지 않는다) | 실행 안 됨 |
| CF3-05 HOT-400 매핑 없이 만든 클러스터나 127.0.0.1 밖 공개면 gateways가 멈춘다 | 같은 파일 | `gatewayHostPorts`가 ⓐ 빈 객체, ⓑ 다섯 가운데 `30445/tcp`만 없음, ⓒ `HostIp: '0.0.0.0'`, ⓓ `HostIp: ''`(모든 주소)에서 던지고, 메시지에 `down`과 `up`이 든다(ⓒ·ⓓ는 `127.0.0.1`도 든다) | 실행 안 됨 |
| CF3-06 HOT-400 몰아 보내기와 끊긴 연결 뒤에도 게이트웨이 다섯 포트가 곧바로 답한다 | `tools/local/e2e/gateways.e2e.mjs`(파일 끝) | ⓐ gw-fan 확인 경로(`probes['gw-fan']`)에 200건을 동시 50으로 보내고(판정 값이 아닌 통로 시험이라 동시 수는 이 계획이 정한다), ⓑ 게이트웨이마다 TLS 연결 20개를 열어 요청 머리 일부만 보낸 뒤 RST로 끊고(`socket.resetAndDestroy()`, 손님 쪽 RST), ⓑ′ 게이트웨이마다 TLS 연결 20개에서 `Connection: close` 요청을 보낸 뒤에도 512바이트씩 5ms마다(최대 40번, 닫히면 멈춤) 더 보내 게이트웨이 쪽 RST를 내게 하고(맺기·TLS 실패는 네트워크 오류로 세고, 닫힌 뒤의 쓰기 오류는 노린 결과라 세지 않는다. 바로잡음 2026-11-16, 아래 '시험 이의' 판정), ⓒ 기다리지 않고 바로 다섯 게이트웨이 확인 경로에 하나씩 보내 모두 네트워크 오류(ECONNREFUSED·ECONNRESET·socket hang up) 없이 HTTP 응답을 받는다. ⓐ의 응답도 네트워크 오류가 0이다(429 등 HTTP 상태는 상관없다). 다시 보내기를 하지 않는다 | 실패 예상. ⓑ′를 더한 뒤 구현 전 트리 로컬에서 두 번 다 실패(ⓑ까지만은 통과했다, '시험 이의') |

- 처음부터 통과가 예상되는 시험: 없다(CF3-01·02·04·05는 실행 안 됨, CF3-03·06은 실패 예상).
- 기존 e2e의 단언·판정 값·동시 수는 이 묶음에서 바꾸지 않는다. 고친 뒤 기존 시험이 실패하면 그것은 통로가 아니라 게이트웨이나 시험의 문제이므로, 시험 담당이 '시험 결과'에 적고 계획 담당이 정본으로 가린다(ADR-0281 결정 2).
- 시간: 단위 `node --test --test-name-pattern="CF3-0[1245]" tools/local/cluster.test.mjs`, `node --test --test-name-pattern="CF3-03" tools/ci/check-workflows.test.mjs`(1분 안). kind 한 바퀴 약 15분, 기준 1은 두 바퀴라 30분 남짓.

### 6. 앞으로 막을 것(후보)

- **이 묶음에서 넣는 것**: CF3-03(워크플로가 포트 전달로 돌아가지 않음), CF3-05(매핑 없는 클러스터·밖으로 열린 공개를 멈춤), CF3-06(통로가 한 연결의 끊김에 무너지지 않음).
- **구간 끝 정리 목록 후보(이 묶음에서 하지 않는다)**:
  1. v0 입구(`v0-forward`)와 v0 e2e도 같은 포트 전달 위험이 있는지 훑고, 있으면 같은 길로 옮기기.
  2. `bash -e` 한 블록에 e2e 넷을 묶어 앞 파일이 실패하면 뒤 파일이 돌지 않는 것을 단계 넷으로 나눌지(실패 때도 뒤를 돌려 한 번에 더 많이 보기).

### 구현 kind 확인(구현 담당, 2026-11-16)

- **무엇**: 구현 커밋 `18fd1cc6`의 트리에서 감독이 잡은 Docker 잠금 안에 kind 한 바퀴를 돌렸다. 구현이 실제 클러스터에서 도는지 보는 확인이고, 시험 담당의 '시험 결과'나 위 5의 '다 되었다고 보는 기준'(두 바퀴)을 대신하지 않는다. CF3-06은 아직 시험 파일에 없어서 돌지 않았다.
- **차례**: 구현 전 재현과 같은 꼴로 `PEAKET_CLUSTER=lane1-cf3`에서 `up --v0-only`(클러스터 새로 만듦, 68초) → `gateways`(86초) → e2e 넷을 ci-kind.yml과 같은 차례·`--test-timeout=300000`으로 돌렸다. 브라우저는 `tools/web-checks`의 `pnpm install --offline --frozen-lockfile`로 받았다. 이 PC에 Playwright 1.64.1이 쓰는 판(chromium 1248·firefox 1555·webkit 2370)이 이미 있어 `playwright install`은 하지 않았다.
- **포트 매핑**: `.cache/peaket-tools/kind-lane1-cf3.yaml`에 매핑 다섯(30441~30445 → 127.0.0.1:18441~18445, TCP)이 들어갔다. `docker port lane1-cf3-control-plane`에도 그대로 나왔다(`30441/tcp -> 127.0.0.1:18441` … `30445/tcp -> 127.0.0.1:18445`). `gateways`는 포트를 이 공개에서 읽었고, Service `peaket-local-gw-*` 다섯(NodePort, 443 → targetPort 10443, 노드 포트 30441~30445)을 만들었다. 각 Service의 EndpointSlice는 그 게이트웨이의 프록시 파드 하나를 가리켰다. '준비됨' 전에 다섯 포트가 모두 'TLS 됨'이었고, 컨트롤러가 받지 않은 정의는 '없음'이었다.

| 파일 | 합계 | 통과 | 실패 | 걸린 시간 |
| --- | --- | --- | --- | --- |
| `gateways.e2e.mjs` | 43 | 43 | 0 | 379초 |
| `queue-cors.e2e.mjs` | 18 | 18 | 0 | 184초 |
| `gateway-limits.e2e.mjs` | 13 | 13 | 0 | 30초 |
| `gateway-routes.e2e.mjs` | 10 | 10 | 0 | 103초 |

- **네트워크 오류**: 네 파일의 출력 어디에도 `ECONNREFUSED`·`ECONNRESET`·`socket hang up`·`lost connection`이 없었다(건너뜀·취소 0). 포트 전달 프로세스는 띄우지 않았다. 구현 전 CI에서 처음 무너졌던 V-T31 ①(1,000건)과 SR-T13 ②(몰아 보내기), 그 뒤 시험 열일곱도 이번에는 통과했다.
- **정리**: `cluster.mjs down`으로 클러스터를 지웠고, `docker ps -a`에 `lane1-cf3` 컨테이너가 남지 않았다. 잠금 폴더(`D:/ticketpass-locks/docker`)는 감독이 쥐고 있어 건드리지 않았다.
- **구현 담당이 고친 것**: 없음(실패 0).

## 시험 이의

- **CF3-06 ⓑ에 게이트웨이 쪽 RST(ⓑ′)를 더했다(시험 담당, 2026-11-16. 판정 값과 단언은 그대로)**:
  - **까닭(실측)**: 구현 전 트리(`624b8f8f`, 클러스터 `lane1-cf3pre`, `gateways-forward`를 뒤에서 띄움)에서 계획대로 쓴 CF3-06(ⓐ 200건 동시 50, ⓑ 요청 머리 일부 뒤 손님 쪽 RST 게이트웨이마다 20개, ⓒ 다섯 확인 경로)만 돌렸더니 **통과**했다(23:08:56, 0.6초). 포트 전달 기록에는 손님 쪽 끊김(`portforward.go:404 … wsarecv: An existing connection was forcibly closed by the remote host`) 100줄만 있고 'lost connection to pod'는 0이었다. 손님 쪽 RST는 kubectl의 이 PC 쪽 연결만 끝내고 파드 쪽 전달은 살린다. CI와 구현 전 재현에서 전달을 죽인 것은 파드 쪽(Envoy)에서 온 RST(`read tcp4 …->127.0.0.1:10443: read: connection reset by peer`)였다(위 1의 1). 그래서 계획대로의 ⓑ는 구현 전 트리에서 실패를 보지 못해 CF3-06이 무엇을 막는지 증명하지 못한다.
  - **더한 것(ⓑ′)**: 게이트웨이마다 TLS 연결 20개에서 `Connection: close` 요청을 보낸 뒤에도 512바이트씩 5ms마다(최대 40번, 닫히면 멈춤) 더 보낸다. 게이트웨이가 응답하고 연결을 닫은 뒤에 닿은 바이트에 게이트웨이 쪽 커널이 RST로 답한다(Envoy가 연결을 RST로 닫는 정상 동작의 한 꼴, 위 1의 2). 연결·TLS를 맺지 못하면 네트워크 오류로 센다. 닫힌 뒤의 쓰기 오류는 노린 결과라 세지 않는다. 계획의 ⓑ(손님 쪽 RST)는 그대로 둔다. 차례는 ⓐ → ⓑ → ⓑ′ → ⓒ다.
  - **확인**: 같은 구현 전 트리에서 ⓑ′를 더한 CF3-06은 두 번 다 실패했다(아래 '실패 확인' 2의 ③). ⓑ′ 실험 한 번(게이트웨이마다 20개)에 포트 전달 다섯이 모두 'lost connection to pod'로 끝났다.
  - **계획 담당이 가릴 것**: ⓑ′를 CF3-06의 단언 목록(위 5의 표)에 넣을지. 넣지 않으면 CF3-06의 구현 전 실패는 CI 로그로만 센다(위 5 '실패 확인' 2).
  - **판정(계획 담당 w8l1-cifix3-plan-5e19a3d7, 2026-11-16): 받는다. 시험 결함이 아니라 계획의 자극이 모자랐던 것이다.** 위 5 표의 CF3-06 줄에 ⓑ′를 넣었고, 틀린 구현 M-13의 '잡아야 할 시험' 칸에 ⓑ′가 포트 전달을 끝낸다는 것을 적었다.
    1. 계획 1의 2가 원인을 '파드 쪽 연결이 RST로 끝나면 전달 전체가 끝난다'로 적었는데, 계획 5의 ⓑ는 손님 쪽 RST라 그 원인을 건드리지 않았다. 실측(손님 쪽 끊김 100줄에도 'lost connection to pod' 0, ⓑ′ 한 번에 다섯 모두 끝남)이 이를 보여 준다. ⓑ′는 CI 로그(`read: connection reset by peer` → 'lost connection to pod')와 같은 길을 일부러 낸다.
    2. 판정 값과 단언은 그대로다: ⓐ의 건수·동시 수, '다시 보내지 않는다', ⓒ의 '기다리지 않고 다섯 모두 네트워크 오류 없이'. ⓑ′는 자극(입력)만 더한다. 응답 뒤 닫힌 연결에 닿은 바이트에 RST로 답하는 것은 TCP의 정해진 동작이라, 게이트웨이 판이나 운이 아닌 자극이다.
    3. ⓑ′의 '닫힌 뒤의 쓰기 오류는 세지 않는다'는 흔들림을 감추지 않는다: 세지 않는 것은 그 자극 연결 자신의 오류뿐이고, 통로가 살아 있는지는 ⓒ의 새 연결 다섯이 본다. 맺기·TLS 실패는 그대로 센다.
    4. 고친 가지 두 바퀴에서 CF3-06이 ⓑ′와 함께 통과했으므로(위 '시험 결과') 구현을 고칠 것은 없다. 시험 커밋(`1c49b0c8`)이 이미 ⓑ′를 넣었으므로 시험 쪽 고침도 없다.

## 실패 확인

1. **CI 실패 로그**(develop 실행 43865738562, `kind / kind` job ID 133,294,220,765, 커밋 `3256c93f`, `gh run view 43865738562 --repo peaket/peaket --job <잡 ID> --log`에서 시험 담당이 골라 옮김. 시각은 UTC):
   - 12:37:35.368~.667: kubectl 포트 전달 다섯(18441~18445)이 모두 `portforward.go:424 … error forwarding port 10443 to pod …: read: connection reset by peer` 뒤 `error: lost connection to pod`로 끝났다(가장 이른 줄은 18442 gw-fan 12:37:35.368028).
   - 12:37:35.374: 첫 실패 V-T31 ①(672ms) `Error: Client network socket disconnected before secure TLS connection was established`, `code: 'ECONNRESET'`.
   - 12:40:38.180~.208: 다섯 전달이 다시 모두 'lost connection to pod'(SR-T13 ② 때). SR-T13 ②는 `Error: socket hang up`.
   - 12:40:38.287: `gateways.e2e.mjs` 합계 43개, 통과 22, 실패 21. 'lost connection to pod' 줄은 모두 10개다. `bash -e`라 `queue-cors`·`gateway-limits`·`gateway-routes`는 돌지 않았다.
2. **로컬 재현**(시험 담당, 2026-11-16, 시각은 +09:00, 결과 기록은 시험 담당 scratchpad의 `cf3-repro.md`·`cf3-*.log`):
   1. **바퀴 1(구현 전 트리 `3256c93f`, 기존 시험 43개만)**: `D:/ticketpass-lane1-pre`(분리 HEAD, `pnpm install --frozen-lockfile`만 함)에서 `PEAKET_CLUSTER=lane1-cf3pre`로 `up --v0-only`(22:27:31→22:28:55) → `gateways`(22:29:09→22:30:46, '컨트롤러가 받지 않은 정의: 없음') → `gateways-forward`를 뒤에서(PID 70664, 22:30:59) → CI처럼 다섯 포트가 열리기를 기다림 → `node --test --test-timeout=300000 tools/local/e2e/gateways.e2e.mjs`(22:31:12→22:34:24, 192초).
      - **합계 43개, 통과 22, 실패 21**(CI와 같은 수, 같은 시험). 첫 실패는 V-T31 ①(975ms) `ECONNRESET`(TLS 맺기 전 끊김), 이어 V-T31 ②·identity §3 신원 머리가 `connect ECONNREFUSED 127.0.0.1:18442`. B-T18 ①부터 PRF-030·BOT-047까지 22개 통과. SR-T13 ②가 `read ECONNRESET`, 그 뒤 17개가 1~3ms 만에 `ECONNREFUSED`.
      - 포트 전달 기록의 'lost connection to pod'는 9줄: 22:31:14.176~.196에 넷(18442~18445), 22:34:24.412~.478에 다섯. 꼴은 CI와 같다(`… read tcp4 127.0.0.1:51660->127.0.0.1:10443: read: connection reset by peer`).
      - 두 번째 바퀴는 첫 바퀴에서 재현되어 돌리지 않았다.
   2. **새 시험의 구현 전 실패(트리 `624b8f8f`, 시험 파일 셋만 복사해 돌리고 되돌림, 그 폴더는 커밋하지 않음)**:
      - ① 단위 CF3-01·02·04·05(`node --test --test-name-pattern="CF3-0[1245]" tools/local/cluster.test.mjs`): **넷 모두 실패**. 까닭은 모두 '내놓는 이름이 없다'(`cluster.mjs가 kindClusterConfig를 내놓지 않는다`, `GATEWAY_NODE_PORTS` 값 다름(undefined), `gateway-objects.mjs가 gatewayHostPorts를 내놓지 않는다` 둘)라서 위 5의 말대로 '실행이 안 되는 실패'로 보고 세지 않는다. 검증 담당의 M-01~M-12로 실패를 본다.
      - ② CF3-03(`node --test --test-name-pattern="CF3-03" tools/ci/check-workflows.test.mjs`): **실패**, 단언 실패 `ci-kind.yml에 gateways-forward가 있다`. 센다.
      - ③ CF3-06(kind, `lane1-cf3pre`를 새로 만들어 `up --v0-only`(23:06:03→23:07:02) → `gateways`(→23:08:40) → `gateways-forward` PID 78640(23:08:47) → `--test-name-pattern="CF3-06"`으로 CF3-06만): 계획대로의 ⓐⓑⓒ만으로는 **통과**(23:08:56, 위 '시험 이의'). ⓑ′를 더한 뒤 두 번 돌려 **두 번 다 실패**(23:11:23·23:11:53, 각 약 3.8초): `네트워크 오류 2건(ⓐ 상태별 수: {"200":200})`, `ⓒ gw-partner: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:18443`, `ⓒ gw-ops: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:18444`. 한 번에 'lost connection to pod'가 다섯씩 늘었다(5→10→15). ⓐ의 200건은 네트워크 오류 0이었고, 무너진 것은 ⓑ′ 뒤의 ⓒ다. 센다(ⓑ′가 단언 목록에 드는지는 '시험 이의'에서 계획 담당이 가린다).
   - 뒤처리: 띄운 PID 70664·78640(과 그 자식 kubectl)만 끝냈고, `lane1-cf3pre`는 두 번 다 `down`으로 지웠다. `D:/ticketpass-lane1-pre`는 복사한 시험 파일 셋을 `git checkout`으로 되돌려 `git status`가 비었다.

## 시험 결과

- **단위(시험 담당, 고친 가지 `3573fafe` + 시험)**: `node --test "tools/local/*.test.mjs"` 139개 가운데 통과 138, 실패 0, 건너뜀 1(Windows 파일 권한). CF3-01·02·04·05 넷 모두 통과. `node --test tools/ci/check-workflows.test.mjs` 47개 가운데 통과 46, 실패 0, 건너뜀 1(CI에서만 도는 yaml 시험), CF3-03 통과. `node tools/ci/check-workflows.mjs` 통과. eslint(바꾼 시험 파일 여섯) 통과. doc-check 오류 0(경고 넷은 이 묶음과 상관없는 openapi·mermaid).
- **kind 두 바퀴(위 5 '다 되었다고 보는 기준' 1)**: 클러스터 `lane1-cf3`, 바퀴마다 `down` → `up --v0-only`(새로 만듦) → `gateways` → e2e 넷을 ci-kind.yml 차례와 `--test-timeout=300000`으로. 포트 전달은 띄우지 않았다. 두 바퀴 모두 `docker port lane1-cf3-control-plane`이 `30441/tcp -> 127.0.0.1:18441` … `30445/tcp -> 127.0.0.1:18445`였고 `gateways`가 다섯 포트 모두 'TLS 됨'을 찍었다. 컨트롤러가 받지 않은 정의는 '없음'.

| 바퀴(+09:00) | 파일 | 합계 | 통과 | 실패 | 걸린 시간 |
| --- | --- | --- | --- | --- | --- |
| 1(23:13:01~23:26:56) | `gateways.e2e.mjs`(43 + CF3-06) | 44 | 44 | 0 | 379초 |
| 1 | `queue-cors.e2e.mjs` | 18 | 18 | 0 | 182초 |
| 1 | `gateway-limits.e2e.mjs` | 13 | 13 | 0 | 36초 |
| 1 | `gateway-routes.e2e.mjs` | 10 | 10 | 0 | 103초 |
| 2(23:27:24~23:41:57) | `gateways.e2e.mjs`(43 + CF3-06) | 44 | 44 | 0 | 379초 |
| 2 | `queue-cors.e2e.mjs` | 18 | 18 | 0 | 211초 |
| 2 | `gateway-limits.e2e.mjs` | 13 | 13 | 0 | 29초 |
| 2 | `gateway-routes.e2e.mjs` | 10 | 10 | 0 | 103초 |

- **끊김**: 두 바퀴 여덟 파일의 출력 어디에도 `ECONNREFUSED`·`ECONNRESET`·`socket hang up`·`lost connection`이 없다(건너뜀·취소 0). CF3-06은 바퀴 1에서 3.6초, 바퀴 2에서 3.6초에 통과했다(구현 전 트리에서는 같은 시험이 ⓒ에서 ECONNREFUSED로 실패).
- **기존 시험**: 단언·판정 값·동시 수는 바꾸지 않았다. 바꾼 것은 e2e 머리 주석(gateways·queue-cors·gateway-limits·gateway-routes의 '포트 전달' 글을 새 잇는 법으로)뿐이다.
- **구현에서 실패한 새 시험**: 없음.
- **뒤처리**: `lane1-cf3`는 `down`으로 지웠고 `docker ps -a`에 `lane1-` 컨테이너가 없다. 고친 가지 바퀴에서는 뒤에서 띄운 프로세스가 없다. 잠금 폴더는 감독이 쥐고 있어 그대로 둔다.

## 리뷰

리뷰 담당(w8l1-cifix3-review-4b8e61d2, 2026-11-16). 받은 것: `git diff origin/develop..HEAD`(파일별), `git log origin/develop..HEAD`(HEAD `e6cc1b2d`), 이 계획 파일의 '계획'·'시험 이의'·'실패 확인'·'시험 결과' 절, 정본 줄(docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법', docs/devops.md §3 `ci-kind.yml` 행), 원래 실패(develop CI 실행 43865738562의 kind 잡, 게이트웨이 시험 43개 가운데 21개 실패)의 요약.

- **구현이 계획·정본대로인가**
  - **127.0.0.1에만 묶임**: `gatewayPortMappings`(`tools/local/gateway-objects.mjs` 324줄 근처)가 다섯 모두 `listenAddress: '127.0.0.1'`·`protocol: 'TCP'`이고, 시작 값이 정수가 아니거나 65535를 넘으면 던진다(`PEAKET_GATEWAY_BASE_PORT=abc`면 `NaN`이라 던진다. 조용히 0.0.0.0이 되는 길이 없다). 읽는 쪽 `gatewayHostPorts`(354줄)도 공개 하나하나의 `HostIp`가 정확히 `127.0.0.1`이 아니면(`0.0.0.0`·빈 값·`::` 모두) 던진다. 쓰는 쪽과 읽는 쪽이 둘 다 막으므로 BSL050 '입구 포트 전달은 127.0.0.1에만'(`tools/local/cluster.test.mjs` 324줄, ASVS 13.4.5)과 같은 뜻을 지킨다. 노드 포트 30441~30445 자체는 kind 노드의 Docker 네트워크 안에서만 열리고, 이것은 API 서버 포트 등 kind가 원래 여는 것과 같은 범위다.
  - **고르개**: `gatewayNodePortService`(334줄)의 고르개는 `gateway.envoyproxy.io/owning-gateway-name: <gw>` 하나이고 접속 정보 `logs.selector`와 같은 라벨이다. 새 Service 자신은 이 라벨을 달지 않으므로(`part-of: peaket-local`만) 다시 돌려도 `gatewayHttpsTargetPort`의 '프록시 Service가 하나' 확인이 깨지지 않는다. 게이트웨이는 모두 한 네임스페이스라 이름 라벨 하나로 그 게이트웨이 프록시 파드만 고른다(구현 kind 확인의 EndpointSlice 관찰과 맞음). `targetPort`는 Envoy Gateway가 만든 Service의 443 포트에서 읽어 숫자를 손으로 적지 않는다.
  - **클러스터 이름·시작 값이 바뀌어도**: 설정 파일(`.cache/peaket-tools/kind-<이름>.yaml`), 노드 컨테이너(`<이름>-control-plane`, `nodePortBindings`), kubeconfig가 모두 `CLUSTER`(`PEAKET_CLUSTER`, 기본 `peaket`)를 따른다. `deploy/local/kind.yaml`의 `name: peaket`은 `--name`이 덮는다. 접속 정보의 `ports`는 시작 값이 아니라 실제 공개에서 읽으므로, 다른 시작 값으로 만든 클러스터도 맞게 잇는다(RV-3·RV-6은 그 둘레의 작은 빈틈).
  - **이미 있는 클러스터(매핑 없음)**: `gateways`가 `ensureCluster` 바로 뒤, 아무것도 올리기 전에 `gatewayHostPorts(nodePortBindings())`를 불러 던진다(`down` 뒤 `up`을 말함). 조용히 넘어가는 길은 없다. 클러스터를 만드는 곳은 `ensureCluster` 하나뿐이다(`kind create cluster`를 `tools`·`loadtest`에서 찾음).
  - 원래 실패의 원인(파드 쪽 RST 하나에 포트 전달 전체가 끝남)과 고친 길이 맞는다: 이제 연결마다 Docker 공개 → kube-proxy → 프록시 파드라 한 연결의 RST가 다른 연결에 번지지 않는다. 복제는 로컬에서 게이트웨이마다 1이라(`gatewayContract`의 `replicas`) NodePort가 나눠 받는 것이 판정에 영향이 없다.
- **ci-kind.yml**: `gateways-forward` 띄우기, `/dev/tcp` 기다림 고리, `cat gateways-forward.log`가 모두 빠졌다. 실패 때 단계에 `get svc -o wide`와 `docker port peaket-control-plane`이 더해졌다(이름 고정은 RV-4). e2e 넷은 여전히 한 `run` 블록(기본 셸 `bash -e`)에서 그 차례로 돈다. 앞 파일이 실패하면 뒤가 돌지 않는 것은 계획 6의 2 후보 그대로다(RV-7에 묶음).
- **남은 포트 전달 의존**: `grep -rn "gateways-forward\|gatewayForwardArgs\|gatewaysForward"`(docs, tools, .github, apps, deploy, loadtest, services, packages)에 코드·워크플로·정본은 없다. 남은 것은 지난 검토 기록(`docs/review/plans/BAT-055.md`·`BAT-060.md`)과 CF3-03 단언 글자뿐이고 기록이라 고치지 않는다. 다만 시험 파일 안에 포트 전달을 까닭으로 든 주석·관용이 남았다(RV-5).
- **시험**
  - 구현을 옮겨 적지 않았다: CF3-01·02·04·05의 기대 값은 시험 안에 글자로 적은 값(`CF3_NODE_PORTS`, 18441·20001, `peaket-local-<gw>`, `envoy-gateway-system`, 고르개 객체)과 `deploy/local/kind.yaml`을 직접 읽은 값이고, 구현 함수를 불러 기대 값을 만들지 않는다. 내놓는 이름만 보지 않고 `deepEqual`로 값을 본다(CF3-04는 차례와 다른 공개 값 25000, 뒤섞인 20001~20005까지 본다). CF3-05는 다섯 꼴(빈 객체, 하나 빠짐, `0.0.0.0` 하나, 빈 값 하나, 다섯 모두 `0.0.0.0`)과 메시지의 `down`·`up`·`127.0.0.1`을 본다.
  - 판정 값을 낮추지 않았다: `gateways.e2e.mjs`·`queue-cors.e2e.mjs`·`gateway-limits.e2e.mjs`·`gateway-routes.e2e.mjs`의 바뀐 줄은 머리 주석과 파일 끝 CF3-06뿐이다(V-T31 ① 1,000건·동시 4, SR-T13 ② 초당 50건·모아 두기 50건 등 그대로).
  - CF3-06 ⓑ′는 흔들림을 감추지 않는다: 버리는 오류는 TLS를 맺은 뒤 그 자극 연결 자신의 쓰기·닫힘 오류뿐이고, 맺기·TLS 실패는 센다. ⓐ의 200건은 모두 HTTP 응답이어야 하고(`>= 100`이 200개), ⓒ는 기다림·다시 보내기 없이 새 연결 다섯을 본다. `send`(`gateway-client.mjs` 62줄)에도 다시 보내기가 없다. 구현 전 트리에서 두 번 실패한 근거도 '실패 확인' 2의 ③에 있다. 다만 ⓑ′가 실제로 게이트웨이 쪽 끊김을 냈는지는 단언하지 않는다(RV-2).
  - CF3-03은 e2e 줄 끝에 무엇이 붙으면(`|| true` 등) 정규식 `\s*$`로 실패한다. `if:`·`continue-on-error:`·블록 안 `set +e`는 보지 않는다(RV-7).
- **문서**: README(`tools/local/README.md` 실행법·'이 PC로 잇는 법'·'이미 있는 클러스터'·명령 표), infra §4.1 새 줄, devops §3 `ci-kind.yml` 행, 코드 머리 주석이 같은 말을 한다(127.0.0.1만, 노드 포트 30441~30445, 시작 값은 `up` 때 정함, 매핑 없으면 `down` 뒤 `up`). 어긋난 곳은 찾지 못했다.
- **실행(이 리뷰 담당, Docker 안 씀)**: `node --test "tools/local/*.test.mjs"` → 139, 통과 138, 실패 0, 건너뜀 1. `node --test tools/ci/check-workflows.test.mjs` → 47, 통과 46, 실패 0, 건너뜀 1. `node tools/ci/check-workflows.mjs` → '통과: 워크플로 19개'.

| 번호 | 심각도 | 파일:줄 | 발견 | 근거·재현 | 고칠 쪽 |
| --- | --- | --- | --- | --- | --- |
| RV-1 | 낮음(보안 추적) | `tools/local/cluster.test.mjs:792`(CF3-01)·`:857`(CF3-05), `docs/security/asvs/verification-tools.md:44` | 이 묶음은 게이트웨이 다섯을 이 PC 포트로 여는 새 길을 만들고 그 길을 127.0.0.1에만 묶는다(ASVS 13.4.5 꼴). 그런데 그것을 보는 CF3-01·CF3-05 이름에 `[ASVS v5.0.0-13.4.5]` 태그가 없어, 같은 뜻의 BSL050(`cluster.test.mjs:324`, 태그 있음)과 달리 ASVS 태그 보고(docs/devops.md §3 `ci-node.yml` 행의 `asvs-report.mjs`)에 잡히지 않는다. ASVS 표 13.4.5 행도 `local-obs`(Prometheus·Grafana 포트 전달)만 적고 게이트웨이 포트 매핑을 적지 않는다 | `grep -n "ASVS" tools/local/cluster.test.mjs \| grep CF3` → 없음. 구현은 맞다(쓰는 쪽·읽는 쪽 모두 127.0.0.1 강제). 빠진 것은 추적뿐이다 | **이 묶음에서 고침**(보안). 시험: CF3-01·CF3-05 이름 끝에 `[ASVS v5.0.0-13.4.5]`를 붙인다(`Fix-By: test`). 계획: verification-tools.md 13.4.5 행에 '로컬 kind 게이트웨이 다섯은 kind 포트 매핑을 127.0.0.1에만 걸고, 다른 주소 공개면 `gateways`가 멈춘다(CF3-01·05)'를 더한다 |
| RV-2 | 낮음 | `tools/local/e2e/gateways.e2e.mjs:883`(`resetByGateway`), `:909`(CF3-06) | ⓑ′가 정말 게이트웨이 쪽 끊김을 냈는지(연결이 게이트웨이에 의해 닫혔는지, `closed`가 참이 됐는지)를 단언하지 않는다. Envoy 판이나 설정이 바뀌어 `Connection: close` 뒤에도 연결을 열어 두거나 RST 대신 조용히 닫으면, ⓑ′는 아무 자극도 못 내고 CF3-06은 그대로 통과한다. 그러면 M-13(포트 전달로 되돌림)을 다시 못 잡는데 아무도 모른다 | 지금 판에서는 '실패 확인' 2의 ③(구현 전 트리 두 번 실패)으로 자극이 듣는 것이 증명됐다. 흔들림을 감추는 길은 아니다(통과 판정을 느슨하게 하지 않음) | 구간 끝 정리 목록 후보(시험). `resetByGateway`가 `closed`를 돌려주게 하고 게이트웨이마다 20개 가운데 몇 개가 게이트웨이 쪽에서 닫혔는지 세어 0이면 실패('자극이 듣지 않았다')로 본다 |
| RV-3 | 낮음 | `tools/local/gateway-objects.mjs:294`(`gatewayContract`), `tools/local/cluster.mjs:847` | CF3-04의 이름은 '접속 정보의 포트는 실제 공개 포트다'인데 시험은 `gatewayHostPorts`만 본다. `gatewayContract`가 받은 `ports`를 그대로 쓰는지 보는 단위 시험이 없다. `gatewayContract`가 예전처럼 `18441 + 차례`를 계산하도록 틀려도 단위 시험은 모두 통과하고, kind 시험도 기본 시작 값에서는 통과한다 | `grep -rn "gatewayContract" tools/local/*.test.mjs tools/local/e2e/*.mjs` → 0줄. 시작 값을 바꾼 kind 실행은 계획·시험 어디에도 없다 | 구간 끝 정리 목록 후보(시험). `gatewayContract({ ports: { …, 'gw-fan': 25000 }, … }).ports`가 그 값 그대로인지 보는 줄을 CF3-04에 더한다 |
| RV-4 | 낮음 | `.github/workflows/ci-kind.yml:87` | 실패 때 단계의 `docker port peaket-control-plane`이 클러스터 이름을 손으로 적었다. CI는 `PEAKET_CLUSTER`를 정하지 않아 지금은 맞고, 같은 파일의 `kubeconfig-peaket`도 모두 고정 이름이라 어긋나지는 않는다. 다만 CI가 클러스터 이름을 바꾸면 진단 줄만 조용히 빈다(`\|\| true`) | 실패 때 진단 줄이라 통과 판정에는 영향이 없다 | 구간 끝 정리 목록 후보(구현). 잡 `env`에 `PEAKET_CLUSTER: peaket`을 두고 `docker port "$PEAKET_CLUSTER-control-plane"`·`kubeconfig-$PEAKET_CLUSTER`로 묶는다 |
| RV-5 | 낮음 | `tools/local/e2e/gateways.e2e.mjs:86`, `tools/local/e2e/gateway-limits.e2e.mjs:40~55`·`:441`·`:543` | 포트 전달을 까닭으로 든 주석과 관용이 남았다. ① V-T31 ①의 동시 4는 'Windows kubectl 포트 전달이 동시 연결에 약하다'가 까닭이다(BAT-055 시험 이의 (라)). ② gateway-limits의 `CONN_ERROR`·`sendOrConnError`는 '포트 전달이 끊긴 꼴의 연결 오류'를 정책 바꾼 뒤 '아직'으로 보고 다시 보낸다. 포트 전달이 없어진 지금은 그 관용이 게이트웨이 자신의 연결 끊김(설정 다시 읽기 때 등)을 다시 보내기로 넘긴다. 통과로 세지는 않아 판정이 새지는 않는다 | 이 묶음은 기존 단언·동시 수를 바꾸지 않기로 했다(계획 5). 판정 값은 아니다 | 구간 끝 정리 목록 후보(계획 → 시험). 주석의 까닭을 새 길에 맞게 고치고, ②의 관용을 남길지(Envoy 설정 바뀜의 연결 비우기라는 까닭을 실측으로 적고 남김) 뺄지 계획 담당이 가린다. ①의 동시 수를 되돌릴지도 함께 본다 |
| RV-6 | 낮음 | `tools/local/cluster.mjs:142`(`gatewayBasePort`)·`:162`(`ensureCluster`) | 이제 `cluster.mjs`가 만드는 모든 클러스터(게이트웨이를 안 쓰는 `up`·`v0`·`v1` 측정 무대, 다른 갈래의 `lane2-`·`lane3-` 클러스터 포함)가 127.0.0.1:18441~18445를 잡는다. 지우지 않은 클러스터가 하나 남아 있으면 다음 클러스터의 `up`이 Docker의 '포트 이미 씀' 오류로 실패하는데, 메시지에 `PEAKET_GATEWAY_BASE_PORT`나 남은 클러스터 이야기가 없다. 또 `gateways` 때의 `PEAKET_GATEWAY_BASE_PORT`가 실제 공개와 달라도 알리지 않는다(실제 값으로 잇고 포트를 찍기는 한다) | 계획 2 '나를 고르는 까닭'의 '비용'과 README가 이 일을 적었다. Docker 잠금으로 한 번에 한 갈래만 kind를 띄우므로 보통은 안 난다 | 구간 끝 정리 목록 후보(구현). `kind create cluster`가 실패하면 '18441~18445를 다른 클러스터가 쓰는지(`kind get clusters`), 또는 `PEAKET_GATEWAY_BASE_PORT`를 바꾼다'를 덧붙이고, `gateways`에서 환경 값과 실제 공개가 다르면 경고 한 줄을 찍는다 |
| RV-7 | 낮음 | `tools/ci/check-workflows.test.mjs:790`(CF3-03), `.github/workflows/ci-kind.yml:64~71` | CF3-03은 e2e 넷의 차례·시간 한도·뒤붙임 없음을 보지만, 그 단계의 `if:`·`continue-on-error: true`나 블록 안 `set +e`는 보지 않는다(W8-L1-ci-fix2 RV-2와 같은 꼴). 또 e2e 넷이 한 `bash -e` 블록이라 앞 파일이 실패하면 뒤 셋의 결과를 못 본다(원래 실패에서도 뒤 셋이 안 돌았다) | 일부러 써야 생기는 꼴이라 낮음. 블록 나누기는 계획 6의 2 후보와 같다 | 구간 끝 정리 목록 후보(시험·구현). CF3-03에 그 단계의 `if`·`continue-on-error` 키 없음과 `set +e` 없음을 더하고, 계획 6의 2(단계 넷으로 나누기)와 함께 정한다 |

- 높음·중간은 없다. 통과 기준 지적은 없다. 보안 쪽 지적은 RV-1 하나(추적 빠짐, 구현은 맞음)이고 이 묶음에서 고친다. 나머지 RV-2~RV-7은 구간 끝 정리 목록 후보다.
- **같은 모델 새 맥락 사실**: 이 리뷰는 계획·구현·시험 담당과 같은 모델(claude-opus-5-5)이 그들의 대화 맥락 없이 새 세션에서 했다(ADR-0270 결정 6, OPEN[40]: 다른 모델을 쓸 수 없음). 받은 것은 감독이 준 공통 규칙, 위 diff·log, 이 계획 파일, 정본 두 줄, 원래 실패의 요약뿐이고 다른 담당의 보고는 받지 않았다. Docker는 쓰지 않았고 코드·시험은 고치지 않았다.

## 틀린 구현 목록

검증 담당이 하나씩 넣고 위 5의 시험이 실패하는지 본다(B등급 표본). 단위 쪽(M-01~M-12)은 클러스터 없이 돈다. kind 쪽(M-13·M-14)은 감독이 Docker 잠금을 줄 때 한 바퀴에 하나씩만 넣는다(못 돌리면 그렇게 적는다). 묶음이 작아 표본이 14개다.

| 번호 | 대상 | 넣을 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- |
| M-01 | 매핑 | `listenAddress`를 빼거나 `0.0.0.0`으로(이 PC 밖에 연다) | CF3-01 |
| M-02 | 매핑 | gw-fan과 gw-queue의 `hostPort`를 바꿔 넣는다 | CF3-01 |
| M-03 | 매핑 | 매핑을 넷만(gw-scanner 빠짐) | CF3-01 |
| M-04 | 매핑 | `hostPort`를 시작 값 대신 늘 18441부터 | CF3-01(20001 사례) |
| M-05 | 매핑 | `protocol: 'UDP'` | CF3-01 |
| M-06 | Service | `type: 'ClusterIP'` | CF3-02 |
| M-07 | Service | 고르개를 다른 게이트웨이 이름으로(gw-fan Service가 gw-queue 프록시를 고름) | CF3-02 |
| M-08 | Service | `targetPort`를 인자 대신 443으로 | CF3-02 |
| M-09 | Service | 두 게이트웨이에 같은 `nodePort` | CF3-02 |
| M-10 | 포트 읽기 | `gatewayHostPorts`가 공개 값 대신 시작 값 + 차례를 돌려준다 | CF3-04 |
| M-11 | 포트 읽기 | 빠진 공개를 시작 값으로 채우고 던지지 않는다 | CF3-05 |
| M-12 | 포트 읽기 | `HostIp`를 보지 않는다(`0.0.0.0`·빈 값을 받음) | CF3-05 |
| M-13 | 워크플로 | `ci-kind.yml`에 `gateways-forward` 띄우기를 다시 넣고 시험은 그 포트로(접속 정보의 `ports`를 포트 전달 포트로) | CF3-03, CF3-06(kind, ⓑ′가 포트 전달을 끝낸다) |
| M-14 | Service | 로컬 전용 Service를 만들지 않는다(매핑은 있음, 노드 포트에 받는 것이 없음) | CF3-06(kind, 기존 e2e도 실패) |

## 검증

검증 담당(w8l1-cifix3-verify-8f2a5c19, 2026-11-17). 틀린 구현은 `D:/ticketpass-lane1-pre`(분리 HEAD `2a52bce4`, 커밋하지 않음)에 하나씩 넣고 매번 `git checkout`으로 되돌렸으며, 끝날 때마다 `git status --short`가 비었다. 기록은 검증 담당 scratchpad의 `mutate.mjs`·`mutate-out.txt`·`k1-*`·`k2-*`·`k3-*.log`다.

- **같은 모델 새 맥락 사실**: 이 검증은 계획·구현·시험·리뷰 담당과 같은 모델(claude-opus-5-5)이 그들의 대화 맥락 없이 새 세션에서 했다(ADR-0270 결정 6, OPEN[40]: 다른 모델을 쓸 수 없음). 받은 것은 감독이 준 공통 규칙과 지시, 이 계획 파일, 저장소뿐이다. '리뷰' 절은 아래 결과를 다 쓴 뒤 겹침을 맞추는 데만 읽었다.
- **구현 위 출발점(`2a52bce4`)**: `node --test "tools/local/*.test.mjs"` 140개, 통과 139, 실패 0, 건너뜀 1(Windows 파일 권한). `node --test tools/ci/check-workflows.test.mjs` 47개, 통과 46, 실패 0, 건너뜀 1. `node tools/ci/check-workflows.mjs` '통과: 워크플로 19개'.
- **단위 쪽 돌리는 법**: 틀린 꼴 하나마다 `node --test --test-name-pattern="CF3-0[123457]" tools/local/cluster.test.mjs`(워크플로 꼴은 `--test-name-pattern=CF3-03 tools/ci/check-workflows.test.mjs`). `cluster.mjs` 안을 바꾼 꼴(V-17~V-19)과 단위에서 놓친 꼴(V-09·V-12)은 `node --test "tools/local/*.test.mjs"` 전체로 다시 돌려 다른 시험도 못 잡는 것을 보았다(셋 모두 139 통과, 실패 0).
- **kind 쪽 돌리는 법**: 감독이 쥔 Docker 잠금 안에서 `PEAKET_CLUSTER=lane1-cf3v`, 틀린 꼴마다 클러스터를 새로 만들고(`up --v0-only` → `gateways`) CF3-06만 이름으로(`--test-timeout=300000 --test-name-pattern="CF3-06"`) 돌린 뒤 `down`했다.

### 계획의 틀린 구현 목록(M-01~M-14)

| 번호 | 넣은 것 | 잡은 시험(실패 메시지 요지) | 같이 통과한 시험 |
| --- | --- | --- | --- |
| M-01 ⓐ | `gatewayPortMappings`의 `listenAddress`를 `'0.0.0.0'`으로 | CF3-01(18441: 매핑이 … 다섯이 아니다) | CF3-02·04·05·07 |
| M-01 ⓑ | `listenAddress`를 뺌 | CF3-01(같은 메시지) | CF3-02·04·05·07 |
| M-02 | gw-queue·gw-fan의 `hostPort`를 바꿔 넣음 | CF3-01 | CF3-02·04·05·07 |
| M-03 | 매핑에서 gw-scanner를 뺌(넷) | CF3-01 | CF3-02·04·05·07 |
| M-04 | `hostPort`를 늘 `18441 + i` | CF3-01(20001: 매핑이 … 20001~20005 다섯이 아니다) | CF3-02·04·05·07 |
| M-05 | `protocol: 'UDP'` | CF3-01 | CF3-02·04·05·07 |
| M-06 | Service `type: 'ClusterIP'` | CF3-02(gw-queue: 종류) | CF3-01·04·05·07 |
| M-07 | gw-fan Service의 고르개를 gw-queue로 | CF3-02(gw-fan: 고르개) | CF3-01·04·05·07 |
| M-08 | `targetPort`를 인자 대신 443 | CF3-02(gw-queue: targetPort는 받은 값이다) | CF3-01·04·05·07 |
| M-09 | gw-fan Service에 gw-queue의 `nodePort`(겹침) | CF3-02(gw-fan: 노드 포트) | CF3-01·04·05·07 |
| M-10 | `gatewayHostPorts`가 공개 값 대신 `18441 + 차례` | CF3-04, CF3-07(deep-equal 실패) | CF3-01·02·05 |
| M-11 | 빠진 공개를 `18441 + 차례`로 채우고 던지지 않음 | CF3-05(ⓐ 빈 객체: 던지지 않았다) | CF3-01·02·04·07 |
| M-12 | `HostIp`를 보지 않음 | CF3-05(ⓒ HostIp 0.0.0.0: 던지지 않았다) | CF3-01·02·04·07 |
| M-13 워크플로 | `ci-kind.yml`의 `cluster.mjs gateways` 단계 뒤에 `gateways-forward … &` 단계를 다시 넣음 | CF3-03(ci-kind.yml에 gateways-forward가 있다) | (그 파일의 CF3 시험은 CF3-03 하나) |
| M-13 kind | 고친 트리로 클러스터를 만들고 `gateways`가 '준비됨'까지 간 뒤(00:20:59), 구현 전 `gatewaysForward`와 같은 꼴의 포트 전달 다섯(`kubectl port-forward --address 127.0.0.1 svc/<프록시 Service> <포트>:443`, 끝나면 1초 뒤 다시 띄움, PID 9904)을 127.0.0.1:18451~18455에 띄우고 접속 정보 사본의 `ports`를 그 포트로 바꿈(`PEAKET_GATEWAYS_E2E`) | CF3-06 **두 번 다 실패**(00:22:53·00:23:01, 각 약 3.8초): `네트워크 오류 2건(ⓐ 상태별 수: {"200":200})`, `ⓒ gw-partner: ECONNREFUSED … 127.0.0.1:18453`, `ⓒ gw-ops: ECONNREFUSED … 127.0.0.1:18454`. 포트 전달 기록의 'lost connection to pod'는 한 번에 다섯씩 모두 10줄 | 대조: 같은 클러스터에서 포트 전달 없이(노드 포트 길) 먼저 돌린 CF3-06은 통과(00:21:29, 3.7초) |
| M-14 kind | `gateways`에서 로컬 전용 Service를 만드는 `kubectl apply`를 뺌(매핑은 있음) | ① `gateways` 자신이 멈춤(종료 1, 00:17:29): '게이트웨이 포트가 60초 안에 TLS로 답하지 않았다: gw-queue 127.0.0.1:18441(Client network socket disconnected before secure TLS connection was established), …' 다섯 모두. ② 접속 정보 파일은 그 앞에서 써지므로 그 파일로 CF3-06을 돌리니 **실패**(00:17:46, 4ms): `ECONNRESET` 127.0.0.1:18441, TLS 맺기 전 끊김 | (CF3-06만 돌림) |

### 목록 밖(검증 담당이 더한 것)

| 번호 | 넣은 것 | 잡은 시험 |
| --- | --- | --- |
| V-01 | (CF3-07이 노리는 꼴) `gatewayContract`의 `ports`를 받은 값 대신 `GATEWAY_BASE_PORT + 차례`로 계산 | CF3-07(접속 정보의 ports가 받은 값과 다르다). CF3-01·02·04·05는 통과 |
| V-02 | `kindClusterConfig`가 `basePort` 대신 `GATEWAY_BASE_PORT`로 매핑 | CF3-01(20001 사례) |
| V-03 | `kindClusterConfig`가 control-plane 노드를 매핑만 든 새 노드로 바꿈(노드 이미지 고정이 빠짐) | CF3-01(노드 이미지가 deploy/local/kind.yaml과 다르다) |
| V-04 | `GATEWAY_NODE_PORTS`에서 gw-ops·gw-scanner의 값을 맞바꿈(매핑과 Service가 같이 바뀌어 길은 이어지지만 고정 값이 계획과 다름) | CF3-01·02·04·07(CF3-05만 통과) |
| V-05 | 노드 포트 하나를 엇갈리게: gw-ops Service만 `nodePort` 30445(매핑은 30444 그대로라 gw-ops가 gw-scanner 노드 포트로 감) | CF3-02(gw-ops: 노드 포트) |
| V-06 | 다섯 Service 고르개를 모두 gw-fan으로 | CF3-02(gw-queue: 고르개) |
| V-07 | `gatewayHostPorts`가 gw-fan 공개를 gw-queue 노드 포트 키(30441/tcp)에서 읽음 | CF3-04·05·07 |
| V-08 | `HostIp` 빈 값만 막고 `0.0.0.0`은 받음 | CF3-05(ⓒ HostIp 0.0.0.0: 던지지 않았다) |
| V-09 | 공개가 여럿일 때 첫째의 `HostIp`만 봄(`[127.0.0.1, 0.0.0.0]` 꼴을 받음) | **놓침**(CF3 다섯 모두 통과, 단위 전체 139 통과) |
| V-10 | 오류 메시지에서 `down`·`up` 안내를 뺌 | CF3-05(ⓐ: 메시지에 down이 없다) |
| V-11 | Service 네임스페이스를 `default`로 | CF3-02(gw-queue: 네임스페이스) |
| V-12 | `HostPort`가 수가 아니어도(빈 값 → `NaN`·0) 던지지 않음 | **놓침**(단위 전체 139 통과) |
| V-13 | `gateway-routes.e2e.mjs` 줄에서 `--test-timeout=300000`을 뺌 | CF3-03(gateway-routes.e2e.mjs에 --test-timeout=300000이 없다) |
| V-14 | `queue-cors.e2e.mjs`를 `gateway-routes` 뒤로 옮김 | CF3-03(queue-cors → gateway-limits 차례가 아니다) |
| V-15 | `cluster.mjs gateways` 단계를 맨 끝 `down` 단계 뒤로 옮김 | CF3-03(gateways.e2e.mjs가 cluster.mjs gateways 단계보다 앞이다) |
| V-16 | `ci-kind.yml`에 주석 `# 예비: kubectl port-forward 로 잇기`만 더함 | CF3-03(ci-kind.yml에 port-forward가 있다) |
| V-17 | `cluster.mjs gateways`가 `gatewayHostPorts(nodePortBindings())` 대신 `gatewayBasePort() + 차례`로 접속 정보 포트를 계산(계획 2 '나'의 5를 어김) | **놓침**(단위 전체 139 통과. kind도 `up`과 `gateways`의 `PEAKET_GATEWAY_BASE_PORT`가 같으면 값이 같아 통과한다) |
| V-18 | `cluster.mjs gateways`가 `gatewayHttpsTargetPort` 대신 `gatewayNodePortService(gw, 443)`(M-08의 잇는 곳 꼴) | 단위는 **놓침**(139 통과). kind(클러스터 새로, 00:23:48~00:27:05)에서 ① `gateways`가 TLS 기다림에서 멈춤(종료 1, 다섯 모두 'Client network socket disconnected before secure TLS connection was established'), ② CF3-06 실패(00:28:00, 4ms, 같은 ECONNRESET). kind로 잡음 |
| V-19 | `ensureCluster`가 매핑을 더한 설정 대신 `deploy/local/kind.yaml`을 그대로 써 클러스터를 만듦 | **놓침**(단위 전체 139 통과). kind에서는 돌리지 않았다(아래 '흉내만 낸 것') |
| V-20 | e2e 넷 단계에 `continue-on-error: true`를 붙임 | **놓침**(CF3-03 통과, `check-workflows.mjs`에도 그 규칙이 없다. 리뷰 RV-7과 같은 꼴) |

### 합계

- **계획 목록**: 14항목, 넣은 꼴 16(M-01 둘, M-13 워크플로·kind 둘) → **16/16 잡음**.
- **목록 밖**: 20 넣음 → 15 잡음(단위 14, kind 1: V-18), **놓침 5**(V-09·V-12·V-17·V-19·V-20).
- **전체**: **31/36 잡음**. 계획이 정한 '잡아야 할 시험' 칸은 모두 그 시험이 실패했다(M-10은 CF3-07도 함께 실패).

### 처음부터 통과하던 시험의 실패 확인

- 구현 전 트리에서 '실행이 안 되는 실패'라 세지 않았던 CF3-01·02·04·05와 리뷰 뒤에 더한 CF3-07이 모두 단언 실패를 보였다: CF3-01(M-01~M-05, V-02~V-04), CF3-02(M-06~M-09, V-04~V-06, V-11), CF3-04(M-10, V-04, V-07), CF3-05(M-11, M-12, V-07, V-08, V-10), CF3-07(M-10, V-01, V-04, V-07). 실패는 모두 '함수 없음'이 아니라 값 단언(deep-equal·`던지지 않았다`·메시지)이다.
- CF3-03·CF3-06은 구현 전 트리에서 이미 실패를 보였고(위 '실패 확인'), 여기서도 M-13·V-13~V-16(CF3-03), M-13·M-14·V-18(CF3-06)로 다시 실패를 보였다.

### 놓친 것과 처리 제안

| 놓친 것 | 위험 | 제안 |
| --- | --- | --- |
| V-09 공개가 여럿일 때 첫째만 보기 | 낮음. 구현은 맞다(공개 하나하나를 본다). kind의 매핑은 `listenAddress` 하나라 지금은 공개가 하나뿐이지만, 같은 노드 포트를 손으로 더 공개하면 밖에 열린 것을 못 막는 꼴을 시험이 못 본다. CF3-05는 ASVS 13.4.5 태그가 달린 시험이다 | **이 묶음에서 시험 한 줄**(`Fix-By: test`)을 권한다: CF3-05에 'ⓔ `30442/tcp`에 `[{127.0.0.1}, {0.0.0.0}]` 둘' 꼴을 더해 던지는지 본다. 감독이 미루면 구간 끝 정리 목록 후보 |
| V-12 `HostPort`가 수가 아님 | 낮음. 그래도 `gateways`의 TLS 기다림이 60초 뒤 멈춘다 | 구간 끝 정리 목록 후보(시험): CF3-05에 `HostPort: ''` 꼴 |
| V-17·V-18·V-19 `cluster.mjs`의 잇는 곳(`gateways`·`ensureCluster`) | V-18은 kind에서 `gateways` TLS 기다림이 잡았다. V-19는 `gateways`가 `gatewayHostPorts`에서 던질 것이다(돌리지 않음). V-17은 `up`과 `gateways`의 시작 값이 같으면 결과가 같아 해가 없고, 다르면 TLS 기다림이 잡는다. 다만 '포트는 실제 공개에서 읽는다'(계획 2 '나'의 5)를 어겨도 어떤 시험도 실패하지 않는다. 리뷰 RV-3(CF3-07로 `gatewayContract`는 막음)·RV-6(환경 값과 실제 공개가 달라도 알리지 않음)과 이어진다 | 구간 끝 정리 목록 후보(구현 → 시험): 공개를 읽어 접속 정보 포트를 만드는 줄을 순수 함수로 빼서 단위로 보거나, RV-6의 '환경 값과 실제 공개가 다르면 경고'와 함께 kind에서 시작 값을 바꾼 한 바퀴를 둔다 |
| V-20 e2e 단계 `continue-on-error` | 낮음. 일부러 써야 생긴다 | 리뷰 RV-7과 같다(구간 끝 정리 목록 후보). 따로 더할 것은 없다 |

### 그 밖에 본 것

- **RV-2와 겹침**: M-13 kind에서 ⓑ′는 지금 판에서 포트 전달 다섯을 모두 끝냈다(한 번에 'lost connection to pod' 다섯, 두 번 10줄). 자극이 듣는다는 것은 이번에도 확인됐다. 자극이 듣는지를 시험이 스스로 단언하지 않는다는 RV-2의 빈틈은 그대로다.
- **CF3-06의 실패 꼴(M-14·V-18)**: 노드 포트에 받는 것이 없을 때 CF3-06은 자기 오류 목록(`errors`) 단언이 아니라 잡히지 않은 TLS 소켓 오류(`ECONNRESET` 127.0.0.1:18441)로 4ms 만에 끝났다. 실패는 맞지만 ⓐ·ⓑ·ⓑ′·ⓒ 가운데 어디서 샜는지 메시지에 없다. 구간 끝 정리 목록 후보(시험): 그 단계들의 소켓에 오류 처리기를 먼저 달아 오류 목록으로 모은다.

### 흉내만 낸 것

- **M-13 kind**: `gateways-forward` 명령과 `gatewayForwardArgs`는 구현이 지워서 그대로 되살리지 않았다. 대신 검증 담당 scratchpad의 `m13-forward.mjs`가 구현 전 트리(`3256c93f`)의 `gatewaysForward`와 같은 인자·같은 '1초 뒤 다시 띄움'으로 포트 전달을 띄웠고, 접속 정보는 사본(`PEAKET_GATEWAYS_E2E`)의 `ports`만 바꿨다. 포트는 노드 매핑이 18441~18445를 쥐고 있어 18451~18455를 썼다. 워크플로 쪽은 M-13 워크플로(CF3-03)로 따로 보았다.
- **M-14·V-18**: `gateways`가 TLS 기다림에서 멈춘 뒤 이미 써진 접속 정보로 CF3-06만 돌렸다. 계획 칸의 '기존 e2e도 실패'는 돌리지 않았다(지시대로 잡혀야 할 시험만 이름으로).
- **V-19**: kind로 돌리지 않았다. `gateways`가 `gatewayHostPorts`에서 '`down` 뒤 `up`' 오류로 멈출 것이라는 것은 코드 읽기다.
- **뒤처리**: 띄운 PID 9904(과 그 자식 kubectl 다섯)만 `taskkill /PID 9904 /T /F`로 끝냈다. `lane1-cf3v`는 바퀴마다 `down`으로 지웠고, 끝에 `kind get clusters`는 '없음', `docker ps -a`에 `lane1-` 컨테이너가 없고, 18441~18445·18451~18455에서 듣는 프로세스가 없다. `D:/ticketpass-lane1-pre`의 `kind-lane1-cf3v.yaml`·`kubeconfig-lane1-cf3v`는 지웠고 `git status --short`가 비었다. 잠금 폴더(`D:/ticketpass-locks/docker`)는 감독이 쥐고 있어 건드리지 않았다.

### 검증 반영 뒤 마지막 검증

검증 담당(같은 세션 w8l1-cifix3-verify-8f2a5c19, 같은 모델 새 맥락 그대로, 2026-11-17). 대상은 검증 반영 커밋 `66a0a7ad`(V-09)와 `43032e32`(V-12·V-17·V-20, 새 CF3-08)를 더한 HEAD `43032e32`다. 감독이 Docker 잠금을 놓아서 Docker·kind는 쓰지 않았고, 단위 시험과 워크플로 시험만으로 보았다. 틀린 꼴은 `D:/ticketpass-lane1-pre`를 `43032e32`(분리 HEAD)로 옮겨 넣었다. 틀린 꼴마다 `git checkout`으로 되돌렸고, 끝에 `git status --short`가 비었다. 기록은 검증 담당 scratchpad의 `final.py`·`final-out.txt`다.

- **구현 위**: `node --test "tools/local/*.test.mjs"`는 141개 가운데 통과 140, 실패 0, 건너뜀 1이다. `node --test tools/ci/check-workflows.test.mjs`는 47개 가운데 통과 46, 실패 0, 건너뜀 1이다. `node tools/ci/check-workflows.mjs`는 '통과: 워크플로 19개'다.
- **돌리는 법**: 코드 꼴은 `node --test "tools/local/*.test.mjs"` 전체로 돌렸다. 워크플로 꼴은 `--test-name-pattern=CF3-03 tools/ci/check-workflows.test.mjs`로 돌렸다.

| 번호 | 넣은 것 | 잡은 시험(실패 메시지 요지) |
| --- | --- | --- |
| V-09 | 공개가 여럿일 때 첫째의 `HostIp`만 봄(`bindings.slice(0, 1)`) | CF3-05(ⓔ: 던지지 않았다) |
| V-12 | `HostPort`가 수가 아니어도 던지지 않음 | CF3-05(ⓕ: 던지지 않았다) |
| V-17 | `gateways()`가 `gatewayHostPorts(nodePortBindings())` 대신 `gatewayBasePort() + 차례`로 포트를 계산 | CF3-08(gateways()가 gatewayHostPorts(<공개 읽기>())의 결과를 변수에 받지 않는다) |
| V-20 | e2e 넷 단계에 `continue-on-error: true` | CF3-03(e2e 단계에 continue-on-error가 있다) |
| V-21 | 공개 확인을 kubectl 뒤로: `const ports = gatewayHostPorts(…)`와 그 출력 줄을 Envoy Gateway 설치 `kubectl apply` 뒤로 옮김 | CF3-08(공개 확인이 첫 kubectl 부르기보다 뒤다) |
| V-17b | 공개는 읽되 `gatewayContract`에는 `ports: … 18441 + i`를 넘김 | CF3-08(gatewayContract의 ports가 gatewayHostPorts 결과(ports)가 아니다) |
| V-20b | e2e 넷 `run` 블록 첫 줄에 `set +e` | CF3-03(e2e 단계의 run에 set +e가 있다) |
| V-20c | e2e 넷 단계에 `if: ${{ always() }}` | CF3-03(e2e 단계에 if가 있다) |
| V-20d | `cluster.mjs gateways` 단계에 `continue-on-error: true` | CF3-03(cluster.mjs gateways 단계에 continue-on-error가 있다) |
| V-18 | `gatewayNodePortService(gw, 443)`(targetPort를 손으로 적음) | 단위로는 여전히 안 잡힌다(140 통과). 아래 분류대로 이 묶음 밖이다 |
| V-19 | `ensureCluster`가 매핑 없는 `deploy/local/kind.yaml`로 클러스터를 만듦 | 단위로는 여전히 안 잡힌다(140 통과). 아래 분류대로 이 묶음 밖이다 |
| 지난 표본 11개 | M-01 ⓐ, M-04, M-07, M-09, M-10, M-11, M-12, V-01, V-05, V-07, V-08을 그대로 다시 넣음 | 모두 지난번과 같은 시험이 잡았다. CF3-01(M-01 ⓐ·M-04), CF3-02(M-07·M-09·V-05), CF3-04(M-10·V-07), CF3-05(M-11·M-12·V-07·V-08), CF3-07(M-10·V-01·V-07) |

- **합계**: 22개를 넣어 20개를 잡았다(새 단언을 노린 꼴 9/9, 지난 표본 11/11). 안 잡힌 둘(V-18·V-19)은 보안 꼬리표가 없다고 가린 꼴이라, 이번 반영의 대상이 아니다.
- **놓친 다섯의 분류(감독 세션 조건: ASVS 꼬리표가 달렸거나 보안 판정(인증·출처·한도·포트 노출)을 보는 시험의 틀린 구현이면 이 묶음에서 시험으로 고친다)**:
  - V-09: 이 묶음에서 고침. ASVS 13.4.5 꼬리표가 달린 CF3-05의 빈틈이고(밖에 열린 둘째 공개를 놓침), CF3-05 ⓔ가 더해져 이제 잡힌다(`66a0a7ad`).
  - V-12: 이 묶음에서 고침. ASVS 13.4.5 꼬리표가 달린 CF3-05가 맡는 `gatewayHostPorts`의 거르기다(포트 노출 자체는 바뀌지 않음). CF3-05 ⓕ가 더해져 이제 잡힌다(`43032e32`).
  - V-17: 이 묶음에서 고침. 포트 노출 판정이다. 이 꼴은 실행 길에서 `gatewayHostPorts`를 아예 부르지 않아, 127.0.0.1 밖 공개 검사와 매핑 없음 검사가 함께 빠진다. 새 CF3-08(ASVS 13.4.5)이 더해져 V-17·V-17b·V-21이 이제 잡힌다(`43032e32`).
  - V-20: 이 묶음에서 고침. 보안 판정 시험이다. 그 단계의 e2e 넷이 게이트웨이의 인증·출처·한도·403을 판정하는데, 이 꼴이면 그 실패가 CI를 막지 못한다. CF3-03에 `if`·`continue-on-error`·`set +e`·`|| true` 없음이 더해져 V-20·V-20b~d가 이제 잡힌다(`43032e32`).
  - V-18: 보안 꼬리표 없음. 까닭: 클러스터 안 연결이 되느냐만 바뀌고, 이 PC 밖 노출·인증·출처·한도와는 상관없다. 고장은 닫히는 쪽이며, kind에서 `gateways`의 TLS 기다림이 멈추는 것으로 잡혔다(위 V-18 kind).
  - V-19: 보안 꼬리표 없음. 까닭: 매핑이 없어 이 PC에 여는 포트가 오히려 줄어든다(닫히는 쪽). `gateways`가 `gatewayHostPorts`에서 '`down` 뒤 `up`'으로 멈춘다. 이 멈춤이 실행 길에 남는다는 것은 이제 CF3-08이 지킨다. kind로는 돌리지 않았다(코드 읽기).
- **흉내만 낸 것**: 이번에는 없다(Docker·kind를 쓰지 않음). CF3-08은 `cluster.mjs`의 글자를 읽는 시험이다. 그래서 이름을 바꾸거나 다른 함수로 감싸 같은 뜻을 지키는 꼴은 통과할 수 있고, 거꾸로 같은 뜻을 다른 글자로 어기는 꼴은 놓칠 수 있다. 이번에 넣은 꼴(V-17·V-17b·V-21)은 모두 잡았다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w8l1-cifix3-plan-5e19a3d7 | claude-opus-5-5 | 2026-11-16T22:14+09:00 | 2026-11-16T22:24+09:00 |
| impl | w8l1-cifix3-impl-3c81f0a2 | claude-opus-5-5 | 2026-11-16T22:26+09:00 | 2026-11-16T22:55+09:00 |
| test | w8l1-cifix3-test-9d4e27b5 | claude-opus-5-5 | 2026-11-16T22:25+09:00 | 2026-11-16T23:45+09:00 |
| review | w8l1-cifix3-review-4b8e61d2 | claude-opus-5-5 | 2026-11-16T23:49+09:00 | 2026-11-17T00:02+09:00 |
| verify | w8l1-cifix3-verify-8f2a5c19 | claude-opus-5-5 | 2026-11-17T00:07+09:00 | 2026-11-17T00:32+09:00 |
| verify | w8l1-cifix3-verify-8f2a5c19 | claude-opus-5-5 | 2026-11-17T00:37+09:00 | 2026-11-17T00:50+09:00 |

위 표는 `roles-check`가 읽는 표라 정본 꼴(머리 다섯 칸, 감독·기록은 적지 않음)을 그대로 둔다. 실제 하위 에이전트 ID와 기록 담당은 아래 보탬 표에 적는다(검사는 절 안의 첫 표만 읽는다).

| 역할 | 세션 ID | 하위 에이전트 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- | --- |
| plan | w8l1-cifix3-plan-5e19a3d7 | a9b2028a538f3ccd8 | claude-opus-5-5 | 2026-11-16T22:14+09:00 | 2026-11-16T22:24+09:00 |
| impl | w8l1-cifix3-impl-3c81f0a2 | a2e85f25565db5a97 | claude-opus-5-5 | 2026-11-16T22:26+09:00 | 2026-11-16T22:55+09:00 |
| test | w8l1-cifix3-test-9d4e27b5 | a4b154e8692892a78 | claude-opus-5-5 | 2026-11-16T22:25+09:00 | 2026-11-16T23:45+09:00 |
| review | w8l1-cifix3-review-4b8e61d2 | a62ef30f913960d88 | claude-opus-5-5 | 2026-11-16T23:49+09:00 | 2026-11-17T00:02+09:00 |
| verify | w8l1-cifix3-verify-8f2a5c19 | a2ea750dbd208e095 | claude-opus-5-5 | 2026-11-17T00:07+09:00 | 2026-11-17T00:32+09:00 |
| verify | w8l1-cifix3-verify-8f2a5c19 | a2ea750dbd208e095 | claude-opus-5-5 | 2026-11-17T00:37+09:00 | 2026-11-17T00:50+09:00 |
| record | w8l1-cifix3-record-b7d40e92 | (이 기록 담당 세션) | claude-opus-5-5 | 2026-11-17T00:48+09:00 | 2026-11-17T01:00+09:00 |

- 모델: 모두 claude-opus-5-5다. 리뷰·검증은 구현 담당과 같은 모델의 새 맥락이다(소유자 결정 OPEN[40], ADR-0270 결정 6). 시험 담당은 구현 전 재현(22:25부터, 구현과 겹쳐 Docker로), 독립 시험(`1c49b0c8`·`7e0c2643`), 리뷰·검증 반영(`2a52bce4` 00:05, `66a0a7ad` 00:33, `43032e32` 00:36)을 모두 했다. 검증 담당은 두 번(`0c2ab594`, 검증 반영 뒤 `5e0c0145`) 했다.
- 감독(갈래 1 감독 세션)은 코드·시험을 쓰지 않았다. 감독이 한 것은 Docker 잠금(아래 '기록'), 가지 다시 올리기, 아래 '기록'의 감독 처리 한 건이다.

## 기록

- 누가: 기록 담당 `w8l1-cifix3-record-b7d40e92`, 2026-11-17. 받은 것은 `git log origin/develop..HEAD`, 이 계획 파일, 감독이 준 사실(담당 표의 하위 에이전트 ID, 이 묶음을 고른 까닭, Docker 잠금 시각, 감독 처리 한 건, 놓친 틀린 구현의 처리 조건)뿐이다.
- 왜 이 묶음인가: develop CI 실행 43865738562(`3256c93f`)와 43877632398(`108f029a`, W8-L1-ci-fix2를 합친 뒤)의 `kind / kind`가 실패했다. kubectl 포트 전달이 게이트웨이 쪽 RST 하나에 통째로 끝나('lost connection to pod') `gateways.e2e.mjs`가 43개 가운데 21개 실패했고, 뒤 e2e 셋은 돌지 않았다(위 '계획' 1). 처음엔 W8-L1-ci-fix2에 넣으려다 감독 결정으로 따로 묶음을 냈다.
- 웨이브 8 멈춤과의 관계: 웨이브 8로 넘어가지 않는다는 소유자 결정(R-657)과 어긋나지 않는다. 웨이브 7 합치기(BAT-055·060)가 빨갛게 만든 develop을 초록으로 되돌리는 마무리이기 때문이다(감독 세션 판단).
- 무엇을 고쳤나: kind 클러스터를 만들 때 노드에 포트 매핑 다섯(이 PC `127.0.0.1:18441~18445` → 노드 포트 30441~30445)을 걸고, `gateways`가 게이트웨이마다 로컬 전용 NodePort Service `peaket-local-<게이트웨이>`를 만들며, 접속 정보의 포트를 노드 컨테이너의 실제 공개에서 읽는다(매핑이 없거나 127.0.0.1 밖이면 '`down` 뒤 `up`'을 말하며 멈춤). `gateways-forward` 명령과 `gatewayForwardArgs`를 지웠고, `ci-kind.yml`은 포트 전달 없이 e2e 넷을 그 차례로 돈다. 정본은 docs/infra.md §4.1 '로컬 kind에서 이 PC로 잇는 법', docs/devops.md §3 `ci-kind.yml` 행, ASVS 표 `docs/security/asvs/verification-tools.md` 13.4.5 행이다.
- 가지 다시 올리기: 감독이 2026-11-16 22:56에 가지를 `3256c93f`에서 `108f029a`(W8-L1-ci-fix2 기록) 위로 다시 올렸다. 그래서 위 '구현 kind 확인'의 구현 커밋 `18fd1cc6`은 올리기 전 해시이고 지금은 `8760eabf`다. 그 밖의 절에 적힌 해시는 모두 지금 가지의 해시와 같다.
- 커밋(차례대로):

| 해시 | 역할 | 제목 |
| --- | --- | --- |
| 624b8f8f | plan(`Batch-Order: impl-first`) | W8-L1-ci-fix3 kind 게이트웨이 시험을 포트 매핑으로 잇는 계획과 정본 줄을 정한다 |
| 8760eabf | impl | kind 게이트웨이 다섯을 포트 전달 대신 포트 매핑과 NodePort로 잇는다 |
| 3573fafe | impl | W8-L1-ci-fix3 구현의 kind 한 바퀴 확인을 적는다 |
| 1c49b0c8 | test | 게이트웨이를 포트 매핑과 NodePort로 잇는 시험 CF3-01~06을 더한다 |
| 7e0c2643 | test | W8-L1-ci-fix3 시험 이의·실패 확인·시험 결과를 적는다 |
| e6cc1b2d | plan | W8-L1-ci-fix3 CF3-06 게이트웨이 쪽 RST 자극 이의를 받는다 |
| 521e382f | review | W8-L1-ci-fix3 리뷰를 적는다 |
| 2a52bce4 | review-fix(`Fix-By: test`, RV-1·RV-3) | CF3-01·05에 ASVS 13.4.5 태그를 달고 접속 정보 포트 시험 CF3-07·ASVS 13.4.5 행을 더한다 |
| 0c2ab594 | verify | W8-L1-ci-fix3 틀린 구현 표본 검증을 적는다 |
| 66a0a7ad | review-fix(`Fix-By: test`, V-09) | CF3-05에 같은 노드 포트의 둘째 공개가 127.0.0.1 밖인 사례를 더한다 |
| 43032e32 | review-fix(`Fix-By: test`, V-12·V-17·V-20) | CF3-05 포트 값 거르기·CF3-08 gateways 공개 읽기·CF3-03 단계 멈춤 조건을 더한다 |
| 5e0c0145 | verify | W8-L1-ci-fix3 검증 반영 뒤 마지막 검증을 적는다 |

- 역할별 커밋 수: plan 2, impl 2, test 2, review 1, 리뷰·검증 반영 3(모두 시험 쪽), verify 2, 합 12개. 이 기록 커밋을 더하면 13개다.
- Docker: 감독이 2026-11-16 22:24에 잠금을 잡고 2026-11-17 00:3x에 놓았다. 그 사이 구현 전 재현 1바퀴, 구현 확인 1바퀴, 고친 가지 2바퀴, 검증의 kind 틀린 구현(계획 목록의 M-13·M-14와 목록 밖 V-18)을 돌렸다. 클러스터 이름은 모두 `lane1-`로 시작했고 끝마다 지웠다.
- 시험(층별):
  - **단위**: 구현 전 트리에서 CF3-01·02·04·05는 내놓는 이름이 없어 '실행이 안 되는 실패'라 세지 않았다(검증의 틀린 구현으로 단언 실패를 봄). 고친 가지(`3573fafe` + 시험)에서 `node --test "tools/local/*.test.mjs"` 139개 가운데 통과 138·실패 0·건너뜀 1(Windows 파일 권한). 마지막(`43032e32`)에서 141개 가운데 통과 140·실패 0·건너뜀 1(CF3-01·02·04·05·07·08 모두 통과).
  - **워크플로**: CF3-03은 구현 전 트리에서 실패(`ci-kind.yml에 gateways-forward가 있다`), 구현 위에서 통과. `node --test tools/ci/check-workflows.test.mjs`는 고친 가지와 마지막 모두 47개 가운데 통과 46·실패 0·건너뜀 1(CI에서만 도는 yaml 시험), `node tools/ci/check-workflows.mjs`는 '통과: 워크플로 19개'.
  - **kind 바퀴별**:

| 바퀴 | 트리 | `gateways.e2e` | `queue-cors` | `gateway-limits` | `gateway-routes` | 끊김 |
| --- | --- | --- | --- | --- | --- | --- |
| CI 43865738562 | `3256c93f` | 22/43 | 안 돎 | 안 돎 | 안 돎 | 'lost connection to pod' 10줄 |
| 구현 전 재현(22:31~22:34) | `3256c93f` | 22/43(CI와 같은 시험) | 안 돎 | 안 돎 | 안 돎 | 9줄 |
| CF3-06 구현 전(23:11, 두 번) | `624b8f8f` + 시험 | CF3-06 두 번 다 실패(ⓒ ECONNREFUSED) | - | - | - | 한 번에 다섯 |
| 구현 확인 | `18fd1cc6`(올리기 전, 지금 `8760eabf`) | 43/43 | 18/18 | 13/13 | 10/10 | 0 |
| 고친 가지 1(23:13~23:26) | `3573fafe` + 시험 | 44/44(43 + CF3-06) | 18/18 | 13/13 | 10/10 | 0 |
| 고친 가지 2(23:27~23:41) | 같음 | 44/44 | 18/18 | 13/13 | 10/10 | 0 |
| 검증 M-13·M-14·V-18 | `2a52bce4` + 틀린 꼴 | CF3-06 모두 실패(대조: 틀린 꼴 없는 같은 클러스터 통과) | - | - | - | M-13만 10줄 |

  - 고친 가지 두 바퀴 사이에 `down`·`up`을 다시 했고, 두 바퀴 여덟 파일 어디에도 `ECONNREFUSED`·`ECONNRESET`·`socket hang up`·`lost connection`이 없었다(계획 5 '다 되었다고 보는 기준' 1 충족). 기준 2(합친 뒤 develop CI `kind / kind` 초록)는 아직 합치지 않아 실행 번호가 없다. 합친 뒤 감독이 그 실행을 본다.
  - 기존 e2e의 단언·판정 값·동시 수는 바꾸지 않았다(바뀐 것은 머리 주석과 파일 끝 CF3-06).
- 틀린 구현 검사: 첫 검증(`0c2ab594`) 넣은 수 36, 잡은 수 31, 놓친 수 5(V-09·V-12·V-17·V-19·V-20, 모두 목록 밖 보탬). 계획 목록 M-01~M-14(넣은 꼴 16)는 모두 잡았다. 검증 반영 뒤 마지막 검증(`5e0c0145`) 넣은 수 22, 잡은 수 20, 놓친 수 2(V-18·V-19). 새 단언을 노린 꼴 9개와 지난 표본 11개는 모두 잡았다.
- 리뷰·검증 지적 처리:
  - 높음·중간·통과 기준 지적은 없다. RV-1(낮음, 보안 추적: CF3-01·05에 ASVS 태그가 없고 ASVS 표 13.4.5 행에 게이트웨이 포트 매핑이 없음)과 RV-3(낮음: `gatewayContract`가 받은 포트를 그대로 쓰는지 보는 시험 없음)은 `2a52bce4`(`Fix-By: test`, CF3-07 더함)에서 고쳤다. RV-2·RV-4~RV-7은 `docs/PROGRESS.md` '구간 끝 정리 목록(갈래 1)'으로 올렸다.
  - 놓친 틀린 구현 가운데 ASVS 꼬리표나 보안 판정 시험에 걸린 것은 이 묶음에서 시험으로 고쳤다(감독 세션 조건): V-09(`66a0a7ad`, CF3-05 ⓔ), V-12(`43032e32`, CF3-05 ⓕ), V-17(`43032e32`, 새 CF3-08 ASVS 13.4.5), V-20(`43032e32`, CF3-03의 `if`·`continue-on-error`·`set +e`·`|| true` 없음). V-18·V-19는 보안 꼬리표 없음과 까닭(닫히는 쪽 고장이고 이 PC 밖 노출·인증·출처·한도와 상관없음)을 '검증' 절에 적었고 구간 끝 정리 목록으로 올렸다.
  - 검증 절의 구간 끝 후보(CF3-06 실패 메시지가 어디서 샜는지 알리지 않음, CF3-08이 글자를 읽는 시험이라 생기는 한계)와 계획 6의 후보 둘(v0 입구 포트 전달, e2e 넷을 단계 넷으로)도 같은 목록에 올렸다.
- 감독 처리 한 건: 계획 세션이 RV-1의 문서 몫(verification-tools.md 13.4.5 행)을 `Fix-By: test`로 커밋(`cb7d8c19`)해 roles-check가 `[세션] … plan와 test을 함께 맡았다`를 냈다. 감독이 푸시 전 그 커밋을 soft reset으로 빼고 같은 내용을 시험 세션의 리뷰 반영 커밋 `2a52bce4`에 넣었다(계획 세션에 그 일을 시킨 감독 지시의 잘못이었다).
- 예외: 없다. `roles-check --base origin/develop --head HEAD`가 이 기록 커밋 전(`5e0c0145`)에 '묶음 W8-L1-ci-fix3: 코드(정방향) 커밋 12개', '통과'를 냈고 감독 예외 줄도 없다. BUILD_ORDER에는 이 묶음의 단계 줄이 없어 고치지 않았다.
- 정방향 차례가 실제로 흐른 꼴: 계획 담당이 `Batch-Order: impl-first`를 단 계획 커밋(`624b8f8f`)을 냈고, 구현 담당이 계획만 보고 먼저 고쳐 kind 한 바퀴를 확인했다(`8760eabf`·`3573fafe`). 시험 담당은 구현과 겹쳐 구현 전 트리에서 재현(22/43)한 뒤, 구현 차이를 보지 않고 계획·정본에서 단언을 정해 시험을 썼다(`1c49b0c8`). CF3-06의 손님 쪽 RST가 구현 전 트리에서 실패를 못 내 게이트웨이 쪽 RST(ⓑ′)를 더하는 시험 이의를 냈고, 계획 담당이 받았다(`e6cc1b2d`). 리뷰(23:49)는 시험 뒤, 첫 검증(00:07)은 첫 리뷰 반영 뒤에 시작했고, 마지막 검증(`5e0c0145`)은 마지막 고침(`43032e32`) 뒤다.
