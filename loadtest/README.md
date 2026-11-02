# loadtest/

부하 시험 자리입니다. k6 시나리오(오픈 모델 도착률)와 카오스 실험 스크립트를 둡니다. 합성 봇 시뮬레이터는 공개하지 않으므로 여기 두지 않고 비공개 저장소 `peaket-bots`에 둡니다(POL-026).

- 측정 규칙과 기록: [docs/perf-ledger.md](../docs/perf-ledger.md), 시나리오·발생기 설계와 보정 결과: [docs/verification.md](../docs/verification.md) §3.9, 저장소 구성: [docs/devops.md](../docs/devops.md) §2.1, 결정: ADR-0169
- `scenarios/`·`lib/`·`runner/`·`run.mjs`: v0 측정용 k6 시나리오와 실행 도구(wbs 1.2.1, 아래).
- `poc/`: 기반 PoC 측정 틀(wbs 0.5.1, [poc/README.md](poc/README.md)). Redis 한 키·클라이언트 셋·좌석 샤드, HTTP 어댑터·검사 방식, Kafka 기본 클라이언트를 PC의 Docker 망 안에서 잰다.
- `nightly/`: 야간 축소 성능 상대 비교의 기준값(`threshold.json`, A/A 실행 10번으로 정하는 `max_ratio`)과 설정(`config.json`: 시나리오·판마다 실행 수·두 판을 올리는 준비 명령). 비교 도구는 `tools/perf-ledger/nightly.py`, 워크플로는 `.github/workflows/perf-nightly.yml`이다(docs/devops.md §3.3, D-T40). `config.json`은 BSL-090에서 둔다. 그 전에는 야간 잡이 건너뛴다.

## 쓰는 법(v0 시나리오와 발생기 보정)

저장소 뿌리에서 실행합니다. Node 24, Docker 엔진, `openssl`이 있어야 합니다. 먼저 클러스터와 v0를 올립니다.

```bash
node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0
pnpm --filter @peaket/invariant-checker build        # --invariants를 쓸 때

node loadtest/run.mjs calibrate --cpus 4 --rates 1000,2000,4000,8000 --record   # 발생기 보정(성능 장부 local-gen)
node loadtest/run.mjs v0 queue --users 10000 --entry-rate 1000 --admit-per-second 28 --warm 30 --main 120 --invariants
node loadtest/run.mjs v0 seat-hold --users 2000 --rate 2000 --mode hot --hot-count 1
node loadtest/run.mjs v0 payment --users 20000 --rate 300 --seats-per-order 2 --warm 10 --main 50 --invariants
```

- k6 1.4.2(다이제스트 고정)를 kind 안의 발생기 파드(네임스페이스 `loadtest`, CPU·메모리 요청 = 한도)로 띄우고 입구의 클러스터 안 주소(`https://v0-gateway.v0.svc.cluster.local:8443`)로 보냅니다. 포트 전달은 쓰지 않습니다(Windows에서 끊깁니다). 파드의 입력(시나리오·토큰·인증서·환경 파일)은 kind 노드 컨테이너의 실행 폴더(`/var/local/peaket-loadtest/<실행>`)에 `docker cp`로 넣고 파드가 hostPath로 붙입니다. 이 PC에서 `kubectl exec -i`의 표준 입력이 잘리기 때문입니다(2026-11-03 확인). 파드와 실행 폴더는 실행이 끝나면(실패해도) 지웁니다.
- 가상 사용자마다 시험 계정 토큰을 이 PC에서 서명해 파드로 넘깁니다(`tools/local/v0-token.mjs`, 개인키는 `.cache/peaket-tools/v0-token-key.json`에만). 가상 사용자 IP는 측정용 대역 198.18.0.0/15에서 붙입니다(131,072명까지).
- 회차는 실행마다 새로 엽니다(UUID). 대기열은 `--admit-per-second`로, 좌석·결제 시나리오는 모두를 곧바로 부르도록 엽니다. 판매 종료 시각을 실행 예상 끝 + 10분으로 두어, 끝난 회차는 입장 루프가 불러도 곧바로 돌아옵니다(회차 목록과 키는 남습니다).
- 인자 규칙(어기면 클러스터를 건드리기 전에 종료 코드 2): 본구간 5초 이상, 예상 시간 + 10분이 3시간(토큰 수명 상한) 이하, 좌석 홀드는 도착률 × 2 ≤ 0.6 × 10 × 가상 사용자 수(입구의 IP당 한도의 60%), 보정은 단계 수 × (예열 + 본구간 + 30) + 600 ≤ 11,400초, 결제는 도착률 × (예열 + 본구간) + 2 ≤ 가상 사용자 수.
- 부하 실행은 한 번에 하나입니다. 실행 잠금(네임스페이스 `loadtest`의 ConfigMap `loadtest-lock`)을 잡은 실행만 돌고, 잠금을 잡은 실행만 앞 실행이 남긴 것을 지웁니다. 다른 실행이 돌고 있으면 거절합니다.
- Ctrl+C 같은 종료 신호를 받으면 발생기 파드·실행 폴더·시험 키·실행 잠금을 지우고 끝냅니다. 강제로 죽어(Windows `taskkill /F` 등) 남은 것과 계속 나가는 부하는 `node loadtest/run.mjs cleanup`으로 지웁니다. 그래도 남은 파드는 실행 시간 상한(`activeDeadlineSeconds`)에서 끝납니다.
- 산출물은 `.cache/peaket-loadtest/<날짜>-<시나리오>-<실행>/`(또는 `--out`)입니다: `summary.json`(본구간 값으로 바꾼 k6 요약), `records.ndjson`(시험 기록, docs/verification.md §2.5), `generator.json`(발생기 CPU·메모리와 판정), `console.ndjson`, `cgroup.log`, `k6.log`, `infra.txt`, `run.json`, 그리고 `--invariants`면 `invariants.csv`. 토큰은 남기지 않습니다.
- `--record --run-id <ID>`는 `tools/perf-ledger/collect.py`로 장부에 옮깁니다(장부 표는 `python tools/perf-ledger/index.py`). 발생기 CPU 평균 80% 초과·메모리 90% 초과·`dropped_iterations` 1건 이상이면 `valid: false`와 사유가 남습니다.
- 불변식 검사기(`--invariants`)는 v0 DB 전체를 봅니다. 다른 시험이 일부러 깨뜨린 상태가 섞이지 않게 새로 올린 클러스터에서 돌립니다.
- 종료 코드: 0 실행을 마치고 산출물을 씀(발생기 판정이 무효여도), 1 k6가 돌지 못함·보정 단계 실패·불변식 FAIL, 2 인자 오류, 128 + 신호 번호(Ctrl+C 130, SIGTERM 143) 종료 신호를 받아 정리하고 끝냄.

| 명령 | 재는 것 | 주요 인자(기본값) |
| --- | --- | --- |
| `calibrate` | 발생기 용량(빈 응답 대역 nginx에 보내 왜곡 없이 보낸 가장 높은 단계)과 가상 사용자당 메모리 | `--cpus 4` `--memory-mi 4096` `--target-cpus 8` `--rates 1000,2000,4000,8000` `--warm 10` `--main 30` |
| `cleanup` | 강제로 끝난 실행이 남긴 발생기 파드·실행 폴더·시험 키·빈 응답 대역·실행 잠금을 지운다(계속 나가던 부하가 멈춘다) | 없음 |
| `v0 queue` | K1(Q-T2의 v0 쪽): 진입 뒤 대기자들이 만드는 조회 도착률 | `--users` `--entry-rate` `--admit-per-second`(필수) |
| `v0 seat-hold` | K2·K3(S-T1·S-T10의 v0 쪽): 홀드 도착률과 좌석 고르기 | `--users` `--rate`(필수) `--mode spread` `--hold-size 2` `--hot-count 1` `--pairs 1` `--release-ms 0` |
| `v0 payment` | K7: 홀드 → 주문 → 시뮬레이터 인증 → 결제 확정 → 주문 보기 | `--users` `--rate`(필수) `--seats-per-order 2`, rate × (warm + main) + 2 ≤ users(가상 사용자 하나가 결제 하나, 도착률 실행기는 구간마다 한 번 더 시작할 수 있다) |
| 공통 | — | `--warm 30` `--main 60` `--cpus 4` `--memory-mi 4096` `--record --run-id` `--profile`(사용자 수로 local-1k·10k·100k) `--invariants` `--out` |

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `scenarios/v0-queue.js`·`v0-seat-hold.js`·`v0-payment.js` | v0 시나리오(docs/verification.md §3.9 '시나리오') |
| `scenarios/calibrate.js` | 발생기 보정 시나리오(대기 상태 조회와 같은 모양의 HTTPS GET) |
| `scenarios/common.js` | 시나리오가 함께 쓰는 k6 부분(요청·기록 내기·구간 표시·요약 쓰기·준비 구간) |
| `lib/model.mjs` | 오픈 모델 구간과 대기자 조회 도착률(서버와 같은 거리별 간격) |
| `lib/records.mjs` | 시험 기록 줄(KST 시각) |
| `lib/users.mjs`·`lib/seats.mjs` | 가상 사용자 가명·IP·머리, 좌석 고르기 |
| `runner/args.mjs`·`manifests.mjs`·`results.mjs` | 인자 검사, 발생기 파드·빈 응답 대역 객체, 발생기 지표·판정·보정 용량·기록 나누기·장부 인자 |
| `run.mjs` | 실행 도구 |
| `test/*.test.mjs` | 계산·실행 도구 시험과 시나리오 형식 검사(`node --test "loadtest/test/*.test.mjs"`, CI `loadtest-check.yml`) |
| `e2e/v0-rehearsal.e2e.mjs` | 실제 kind에서 시나리오마다 작은 규모로 끝까지 돌려 보는 리허설(docs/perf-ledger.md §3 1번, `node --test loadtest/e2e/v0-rehearsal.e2e.mjs`) |

## 알아 둘 것

- 가상 사용자 수 상한은 발생기 메모리 × 0.6 ÷ 가상 사용자당 2MiB [가정]로 잡습니다(`run.mjs`의 `ASSUMED_VU_MI`). 보정이 잰 값은 0.9~1.3MB라 넉넉한 쪽입니다(docs/verification.md §3.9 '보정 결과'). 대상이 느려져 가상 사용자가 모자라면 `dropped_iterations`가 생겨 그 실행은 무효입니다.
- 이 PC에서 발생기 하나(CPU 4개)가 놓침 없이 보내는 도착률은 1,000/s까지였습니다(2026-11-03 보정). 그보다 높으면 CPU가 남아도 드물게 반복을 놓쳐 무효가 될 수 있습니다(docs/verification.md §3.9 '보정 결과').
- K4(변경분 연결 5,000개), K5(Playwright), K6(봇), K8(경보), K10(망 끊기)은 이 도착률 시나리오에 넣지 않습니다(docs/verification.md §3.9).
