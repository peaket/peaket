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
| CF3-06 HOT-400 몰아 보내기와 끊긴 연결 뒤에도 게이트웨이 다섯 포트가 곧바로 답한다 | `tools/local/e2e/gateways.e2e.mjs`(파일 끝) | ⓐ gw-fan 확인 경로(`probes['gw-fan']`)에 200건을 동시 50으로 보내고(판정 값이 아닌 통로 시험이라 동시 수는 이 계획이 정한다), ⓑ 게이트웨이마다 TLS 연결 20개를 열어 요청 머리 일부만 보낸 뒤 RST로 끊고(`socket.resetAndDestroy()`), ⓒ 기다리지 않고 바로 다섯 게이트웨이 확인 경로에 하나씩 보내 모두 네트워크 오류(ECONNREFUSED·ECONNRESET·socket hang up) 없이 HTTP 응답을 받는다. ⓐ의 응답도 네트워크 오류가 0이다(429 등 HTTP 상태는 상관없다). 다시 보내기를 하지 않는다 | 실패 예상(확률적. CI 로그와 로컬 재현으로 적는다) |

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
| M-13 | 워크플로 | `ci-kind.yml`에 `gateways-forward` 띄우기를 다시 넣고 시험은 그 포트로(접속 정보의 `ports`를 포트 전달 포트로) | CF3-03, CF3-06(kind) |
| M-14 | Service | 로컬 전용 Service를 만들지 않는다(매핑은 있음, 노드 포트에 받는 것이 없음) | CF3-06(kind, 기존 e2e도 실패) |

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w8l1-cifix3-plan-5e19a3d7 | claude-opus-5-5 | 2026-11-16T22:14+09:00 | 2026-11-16T22:24+09:00 |
| impl | w8l1-cifix3-impl-3c81f0a2 | claude-opus-5-5 | 2026-11-16T22:26+09:00 | 2026-11-16T22:55+09:00 |
| test | w8l1-cifix3-test-9d4e27b5 | claude-opus-5-5 | 2026-11-16T22:25+09:00 | 2026-11-16T23:45+09:00 |
