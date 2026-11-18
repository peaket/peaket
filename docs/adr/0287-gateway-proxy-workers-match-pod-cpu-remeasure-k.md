# ADR-0287: 게이트웨이 프록시의 Envoy 일꾼 수를 파드 CPU에 맞추고 그 무대에서 차단 상한의 k를 다시 잰다(2026-11-18)

- **상태**: 채택(2026-11-18, 추천 적용, BUILD_ORDER BAT-058 계획 `bat058-plan-960802c8`). 방향(일꾼 수를 파드 CPU에 맞추고 다시 재 운영 상한을 다시 센다)은 소유자 결정 OPEN[49] (가)(2026-11-18, docs/PROGRESS.md 'OPEN[49] 닫음')이고, 아래는 HOT-405를 구현하기 전에 정한 그 세부다.
- **관련**: [ADR-0009](0009-two-layer-circuit-breakers-fail-fast.md) 결정 1·3, [ADR-0147](0147-security-quality-doc-gaps-human-access-boundary-quality-rows.md) 결정 8, [docs/infra.md](../infra.md) §4.1 '게이트웨이 차단 상한', [docs/verification.md](../verification.md) V-T43·§4.1 '게이트웨이 동시 처리·보류 큐', 측정 보고서 [BAT-056](../review/measurements/BAT-056-gateway-breaker.md) §6·§7, 계획 [docs/review/plans/BAT-058.md](../review/plans/BAT-058.md)
- **관련 ID**: V-T43, HOT-405

## 맥락

- 게이트웨이 차단 상한(서킷 브레이커: 뒤의 서비스에 동시에 보내는 요청 수가 상한을 넘으면 기다리게 하지 않고 바로 503으로 끊는 장치)의 값은 ⌈k × R_pod × L_gw⌉이다(docs/infra.md §4.1 '값의 식'). k는 평균 동시 요청 수에 곱하는 여유 배수다.
- BAT-056 측정에서 k가 10.6으로 나왔다. 원인을 가르니 대부분이 Envoy 일꾼(요청을 처리하는 작업 스레드) 32개가 저마다 업스트림 연결을 따로 쥐는 고정 몫이었다. EnvoyProxy가 일꾼 수를 정하지 않아 노드 CPU 수(이 PC 32)를 따랐다. 일꾼을 2로 둔 진단에서 k는 약 2.6이었다(보고서 §6).
- 운영 파드 CPU는 2 [가정]이다(docs/infra.md §4.1 '값의 식', wbs 4.6.1에서 확정). 일꾼 수를 정하지 않으면 운영 노드의 CPU 수(예 16·32)만큼 일꾼이 생겨 PC와 같은 고정 몫이 생기고, 파드 하나가 CPU 2를 쓴다는 식의 뜻과도 맞지 않는다.
- 2026-11-18에 Envoy Gateway v1.10.0 소스(GitHub 태그 `v1.10.0`)에서 확인한 것:
  - `api/v1alpha1/envoyproxy_types.go`: EnvoyProxy `spec.concurrency`(정수, 선택)가 '일꾼 수'다. 설명은 '정하지 않으면 그 플랫폼의 cpuset 스레드 수'다. 같은 곳의 `spec.extraArgs`는 Envoy 명령줄 인자를 더 붙이는 칸이다.
  - `internal/infrastructure/common/proxy_args.go`: `spec.concurrency`가 있으면 Envoy 인자에 `--concurrency <값>`을 붙이고, 없으면 붙이지 않는다(`--cpuset-threads`도 붙이지 않는다). 그래서 정하지 않으면 Envoy 기본값(그 기계의 하드웨어 스레드 수)이 된다. BAT-056 무대의 관리 포트 `server.concurrency: 32`와 맞는다.
  - `api/v1alpha1/kubernetes_helpers.go`: envoy 컨테이너의 `resources`가 비어 있을 때만 기본 요청(CPU `100m`, 메모리 `512Mi`, 한도 없음)을 채운다. `resources`를 적으면 기본값은 통째로 바뀐다(칸마다 합치지 않는다).
- 이 저장소의 프록시 설정은 EnvoyProxy 두 개다: 게이트웨이 넷(gw-fan·gw-partner·gw-ops·gw-scanner)이 GatewayClass로 함께 쓰는 `peaket-proxy`, gw-queue가 Gateway `infrastructure.parametersRef`로 받는 `peaket-proxy-queue`(deploy/gateways/00-common.yaml). 게이트웨이 프록시는 Helm 차트를 쓰지 않는다(`deploy/charts/peaket-service`는 서비스 차트다).
- 로컬·CI kind는 같은 정의를 덧씌우기(`tools/local/gateway-objects.mjs` `localGatewayObjects`)만 거쳐 올린다. CI의 `kind / kind` 잡은 `ubuntu-24.04` 표준 러너(vCPU 4)에서 Kafka 등과 함께 게이트웨이 다섯을 띄운다.

## 결정

1. **일꾼 수를 거는 자리.** EnvoyProxy 두 개(`peaket-proxy`·`peaket-proxy-queue`) 모두 `spec.concurrency`에 적는다. `spec.extraArgs`로 `--concurrency`나 `--cpuset-threads`를 겹쳐 걸지 않는다(두 길이 함께 있으면 어느 값이 이기는지 판에 기댄다).
2. **일꾼 수와 파드 CPU의 관계.** 일꾼 수 = envoy 컨테이너의 CPU 요청(스케줄러가 그 파드 몫으로 떼어 두는 CPU, 코어 단위)이다. 지금은 둘 다 2 [가정, 파드 CPU 2 그대로]다. CPU 요청이 정수 코어가 아니면 일꾼 수는 그 값을 내린 정수이고 1보다 작지 않다(`gw capacity`가 CPU를 묶을 때와 같은 규칙).
3. **자원 칸.** envoy 컨테이너 `resources`는 `requests: { cpu: "2", memory: 512Mi }`이고 한도(`limits`)는 두지 않는다. 메모리 요청 512Mi는 Envoy Gateway 기본 요청을 그대로 다시 적은 것이다(`resources`를 적으면 기본값이 통째로 바뀌어 빠지기 때문이다). CPU 한도를 두지 않는 까닭: CPU 한도는 100ms 주기의 몫을 다 쓰면 파드의 모든 스레드(일꾼, 주 스레드, 접근 로그 쓰기)를 잠깐 멈추게 해, 정상 부하 지연과 V-T43 ②의 3ms 빠른 실패에 몰림을 더한다. 일꾼 수가 이미 바쁜 때의 CPU 사용을 요청 근처로 묶는다. 메모리 한도와 복제 수·HPA(파드 수를 부하에 따라 늘리고 줄이는 장치)·PDB는 지금처럼 wbs 4.6.1(구간 끝 정리 목록 W7-CON-04) 몫이다.
4. **로컬·CI kind.** 덧씌우기는 envoy 컨테이너의 CPU 요청만 `100m`(Envoy Gateway 기본 요청, 지금 kind와 같은 값)으로 낮춘다. 일꾼 수·메모리 요청은 그대로 두고 CPU 한도를 새로 두지 않는다. 다섯 파드 × CPU 2는 vCPU 4 러너에 들어가지 않기 때문이다. 그래서 kind 무대는 일꾼 수와 한도 없음이 운영과 같고, CPU 요청(자리 잡기와 다툼 때의 몫)만 다르다.
5. **바꿀 때.** 파드 CPU를 정하거나 바꾸는 단계(wbs 4.6.1)는 일꾼 수, CPU 요청, 차단 상한(docs/infra.md §4.1 '값의 식'의 파드 CPU)을 함께 고친다. 정적 시험이 두 EnvoyProxy의 일꾼 수와 CPU 요청이 같은지 본다.
6. **k를 다시 재는 무대와 방법(V-T43 M-A, docs/infra.md §4.1 '측정(V-T43)'에 적음).** 결정 1~4가 들어간 kind 무대(일꾼 2)에서 정상 부하로 잰다. 먼저 A/A(같은 설정을 두 번 재서 잡음 폭을 보는 것)로 무대가 조용한지 보고, 동시 상한 후보(그리드)를 한 번씩 잰 뒤 경계 값을 3회로 굳힌다. r_min(정상 부하 503 0건이 되는 가장 작은 동시 상한)은 '한 번이라도 실패한 가장 큰 후보의 바로 위 후보이고 3회 모두 통과한 값'이다. 평균 지연은 진입 흐름 2xx 평균 응답 시간을 발생기의 2xx 수로 가중해 합친 값이다(합친 요약의 평균은 발생기 가운데 큰 값이라 쓰지 않는다).
7. **k와 운영 상한의 셈.** k = r_min ÷ (진입 도착률 × 평균 지연)을 0.1 단위로 올리고(예 2.614 → 2.7, 2.6 → 2.6), 2보다 작으면 2다. R_pod = 0.6 × 파드 포화 처리량(vCPU 하나에 초당 2,600건, BAT-056 측정) × 파드 CPU 2다. 동시 = 연결 = ⌈k × R_pod × L_gw⌉, 보류 = ⌈동시 ÷ 8⌉이고, 셈은 정수로 해 마지막에 한 번만 올린다(소수 곱셈의 끝자리 오차로 정수인 값이 하나 커지지 않게). 따로 더하는 여유는 없다: k가 여유 배수이고, r_min이 경계 위쪽 후보라 이미 큰 쪽이다. 셈은 측정 도구 `node loadtest/run.mjs gw limits`가 하고, 손 셈과 다르면 도구가 이긴다(보고서에 둘을 적는다).
8. **포화 처리량은 다시 재지 않는다.** BAT-058은 BAT-056의 2,600(CPU 0.5·일꾼 1로 잰 선형 추정)을 입력으로 쓴다. CPU 2·일꾼 2에서 바로 재려면 도착률 6,000/s까지 발생기 6대(CPU 24·메모리 12GiB)가 들어 이 PC의 kind(32 CPU·15.5GiB)에 들어가지 않고, 대역 백엔드(Node 프로세스 하나)가 프록시보다 먼저 찰 수 있다. 선형 추정이 낮게 잡힌 쪽이면 상한도 작은 쪽이다.
9. **운영 값 적용과 차례.** 측정을 한 구현 담당이 같은 커밋에서 정본(docs/infra.md '첫 값'을 '잰 값'으로, docs/verification.md 두 행, docs/architecture.md §9.4 행, docs/review/ledger-notes.md V-T43 두 줄)과 `deploy/gateways` 다섯 게이트웨이의 `circuitBreaker` 값을 고친다. 결제 결과 롱 폴링 규칙은 지금처럼 gw-fan 게이트웨이 값을 따른다. 시험 담당이 정적·kind 시험의 단언 값을 고친 정본에서 다시 적는다.
10. **측정 도구가 실제 일꾼 수를 본다.** `gw sweep`·`gw capacity`는 단계마다 부하를 넣기 전에 프록시 파드마다 관리 포트 통계의 `server.concurrency`를 읽는다. 기대 값(`--workers`, 없으면 EnvoyProxy `spec.concurrency`, capacity는 자기가 묶은 값)과 다르거나 못 읽으면 그 단계는 부하를 넣지 않고 무효다(통과로 세지 않는다).

## 검토한 대안

1. **`spec.extraArgs`에 `--concurrency 2`.** 같은 효과지만 형식이 없는 칸이라 오타·겹침을 정적 시험이 덜 잡고, Envoy Gateway가 내부에서 쓰는 인자와 부딪힐 수 있다(그 칸 설명). 버림.
2. **CPU 요청 = 한도 = 2(Guaranteed).** 자리 잡기가 확실하지만 위 결정 3의 멈칫이 지연 꼬리를 늘린다. 운영에서 CPU 몫 다툼이 문제가 되면 wbs 4.6.1이 다시 본다. 버림.
3. **CPU 요청을 적지 않고 일꾼 수만 2.** 범위는 작지만 '파드 CPU 2'가 설정 어디에도 없어 일꾼 수와 맞는지 시험할 것이 없고, 자리 잡기도 기본 100m이라 파드가 CPU 2를 받는다는 식의 입력이 보장되지 않는다. 버림.
4. **연결 상한을 동시 상한과 떼어 크게.** 일꾼마다 쥐는 연결 몫을 없애지만 docs/infra.md '값의 식'(연결 = 동시)과 BAT-056 R8 판단을 바꾸는 방향이라 이 묶음에서 하지 않는다(BAT-056 보고서 §7).
5. **k를 고정 몫(일꾼 수 × 일꾼당 연결)과 비례 몫 두 항으로.** 식이 더 맞을 수 있으나 일꾼당 연결 수를 재는 측정이 따로 들고 정본 식이 바뀐다. 일꾼 2에서 고정 몫이 작으면 필요 없다. 측정 결과 k가 크게 남으면 다시 본다(아래 '되돌릴 조건').

## 결과와 트레이드오프

- **좋은 점**: 운영 파드의 일꾼 수가 노드 크기에 따라 바뀌지 않고, PC에서 잰 k가 운영 파드와 같은 일꾼 수에서 나온다. k 셈과 반올림이 도구 하나에 있어 손 셈 차이(BAT-056 보고서 §7의 (나) 줄처럼 k 2.6과 2.66이 섞이는 일)가 없어진다.
- **남는 한계**: 포화 처리량은 여전히 선형 추정이다(결정 8). kind 무대의 CPU 요청은 운영과 다르다(결정 4). 운영 피크 부하와 메시·TLS 업스트림은 PC에서 재지 않는다(BAT-056 보고서 §9와 같다).

## 되돌릴 조건

- 일꾼 2에서 잰 k가 5보다 크면(고정 몫이 여전히 크다는 뜻) 대안 4·5를 새 ADR로 다시 본다.
- wbs 4.6.1이 파드 CPU를 2가 아닌 값으로 정하면 결정 2·3의 값을 그 값으로 바꾸고 k를 다시 잰다.
- Envoy Gateway 판을 올려 `spec.concurrency`의 뜻이나 `resources` 기본값 채우기가 바뀌면 결정 1·3을 다시 본다.

## 확인

- BAT-058의 정적 시험(`tools-check`), 덧씌우기 시험(`kind`의 `tools/local/*.test.mjs`), 측정 도구 시험(`loadtest-check`), kind 시험(`kind / kind`의 `gateway-limits.e2e.mjs`)과 측정 보고서 docs/review/measurements/ 아래 `BAT-058-gateway-workers.md`가 이 결정을 본다(계획 `docs/review/plans/BAT-058.md`).
- `python -I -X utf8 tools/doc-check/check_all.py`에 이 변경이 만든 오류가 없다.
