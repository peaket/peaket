# F-09-8 kind 재가동·야간 실행 복구 기록

이 파일은 F-09-8(INF-010·INF-030·INF-040)의 실행 기록이다. 절차는 `docs/runbooks/F-09-8-kind-nightly-recovery.md`, 장부 재확인 표는 `docs/review/measurements/F-09-8-kind-recheck.md`를 따른다. 실행하지 않은 것은 `건너뜀`·`무효`·`실패`와 까닭을 적고 통과로 세지 않는다.

- **상태**: kind 재가동·게이트웨이/Kyverno/프로브/진단 재확인 완료. DAST와 야간 성능은 환경 실패·측정 무효로 남았다.
- **가지**: `freeze/lane1-F-09-8`(시험 고정 `07a7fa7e2`, 구현 변경은 이 기록 앞 커밋). `develop`·`release/1.0.0`에 합치지 않는다.
- **동결 로컬 범위**: INF-020의 배포 묶음은 하지 않았다. kind 재가동·ci-kind 시험·DAST·야간 성능 수동 실행·kind 장부 재확인만 했다.

## 환경

| 무엇 | 값 |
| --- | --- |
| 날짜 | 2026-11-26 19:45~22:40 KST |
| 커밋 | 시험 고정 `07a7fa7e2`, 구현 `d5c81547a`, 시험 불일치 고침 `F098-01`·`F098-02` |
| PC·OS | Windows, Docker Desktop 29.8.1 |
| Node·pnpm | Node v24.18.0, pnpm 12.16.0 |
| Docker 엔진 | 29.8.1 |
| kind·kubectl·helm 판 | kind v0.33.0, kubectl v1.35.8, helm v3.22.1 |
| 클러스터 이름·포트 | `freeze-f098`·`18641~18645` |
| Docker 잠금 | 1차 19:45:54~21:35:53, 재확인 21:50:38~21:57:41, 시험 불일치 고침 22:20:48~22:40:26(한 자리 `docker`, `docker-all` 아님) |

- 21:50 재확인 때 첫 `take`가 `lane6-F-04-15`에 막혀 있었는데 `up`·`gateways`가 먼저 돌았다(잠금 전 실행). 21:50:38에 잠근 뒤 시험과 정리를 마쳤고, 다른 갈래의 컨테이너는 없었다. 다음부터는 `take` 성공을 확인한 뒤에만 Docker를 만진다.
- 22:20~22:40 시험 불일치 고침 확인은 `take` 성공(22:20:48) 뒤에만 클러스터를 띄웠다. 게이트웨이 44/44, 메시 8/8을 확인하고 22:40:26에 정리·잠금 해제했다.

## kind 재가동

| 차례 | 명령 | 결과 | 걸린 시간 | 메모 |
| --- | --- | --- | --- | --- |
| 클러스터 | `PEAKET_CLUSTER=freeze-f098 PEAKET_GATEWAY_BASE_PORT=18641 node tools/local/cluster.mjs up` | 통과 | 약 4분 30초 | kind v1.35.8 노드, Strimzi 0.47.0(Kafka 3.9.1), PostgreSQL 18, AWS 흉내 서버 |
| 상태 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs status` | 통과 | 수 초 | 핵심 파드 Running |
| 이미지 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs image` | 통과 | 약 2분 | `peaket/example-svc:local` |

## 시험 결과

| 시험·단계 | 결과 | 숫자·메모 |
| --- | --- | --- |
| AWS 흉내·릴레이 | 통과 | 5/5. 릴레이 리더 이어받기 14.25초, 메시 600건 누락·중복 0 |
| 관측 최소 | 통과 | 1/1. Prometheus·Grafana·조직 둘·팀 9 |
| 프로브 | 통과 | 2/2(D-T19 ③④) |
| 진단 | 통과 | 2/2(D-T18 ①) |
| v0 배포 | 통과 | 12/12. 첫 실행은 `openssl`이 PATH에 없어 실패, Git openssl을 PATH에 두고 다시 실행 |
| 게이트웨이 | 통과 | 44/44(2차). B-T18 ④ gw-scanner는 토큰 `sub`를 로그 표지로 바꾼 시험 수정 뒤 통과 |
| 큐 CORS | 통과 | 18/18(Playwright chromium·firefox·webkit) |
| 게이트웨이 한도 | 통과 | 18/18(D-T50·D-T43·V-T43) |
| 게이트웨이 라우트 | 통과 | 10/10 |
| 입장 토큰 | 통과 | 18/18(S-T28 ①) |
| 입장 장애 | 통과 | 3/3(Q-T69 ②) |
| 메시 NetworkPolicy | 통과 | 8/8(2차). MK-01 payment-svc는 gw-partner만, MK-03 web→ticket-svc gRPC는 거부로 시험 기대를 라우트에 맞춤 |
| Kyverno | 통과 | 5/5(D-T11 ②·D-T18 ② 등) |
| I-T36 | 통과 | 7/7 |
| D-T33 ①② | 통과 | `tools/ci/gitops-check.test.mjs` 18/18 |

## 실패와 고침

| 시험·단계 | 실패 줄 | 원인 | 고침 | 다시 실행 | 남은 위험 |
| --- | --- | --- | --- | --- | --- |
| v0 배포 첫 실행 | `spawnSync openssl ENOENT` | Windows PATH에 openssl이 없었다 | Git openssl(`C:\Program Files\Git\usr\bin`)을 PATH에 둠 | 12/12 통과 | 없다. 복구 절차 §1에 적었다 |
| 게이트웨이 B-T18 ④ RV-01 | gw-ops 401 로그에 위조 `ja4`·`asn`·`edgeBotLabels`가 남음 | Envoy Gateway 엄격 검증이 `envoy_on_request`를 핸들 없이 불러 Lua가 멈췄고, gw-ops의 원본 확인이 맞은 요청은 끝단 머리를 지우지 않았다 | `envoy_on_request`의 `filterContext`를 `pcall`로 감싸 검증 호출을 건너뛰고, gw-ops는 허용 IP 확인 뒤 끝단 머리를 지운다. `docs/infra.md` §4.1·`docs/features/bot-defense.md` §3.3에 적었다 | RV-01 1/1 통과, 2차 전체 게이트웨이 44/44 | 없다 |
| 게이트웨이 B-T18 ④ | `gw-scanner: 203.0.113.x가 든 접근 로그 줄이 20000ms 안에 없다` | gw-scanner는 정본대로 XFF를 신뢰하지 않아 `clientIp`가 연결 주소(10.244.0.1)다. 시험은 XFF 주소를 로그 마커로 찾았다 | 시험 표지를 토큰 `sub`로 바꿨다(제품·XFF 규칙 그대로). `gateways.e2e.mjs:240` | 2차 게이트웨이 44/44 | 없다 |
| 메시 MK-01·MK-03 | `gw-fan → payment-svc rest(8080)`·`web → ticket-svc grpc(50052)`가 `deny` | 시험 기대가 현재 라우트와 달랐다. payment-svc는 gw-partner만 라우트가 있고, web은 ticket-svc를 HTTP로 부른다(`port-allow.yaml` `ListTickets: []`) | `REST_GATEWAYS['payment-svc']=['gw-partner']`, MK-03의 web→ticket-svc gRPC를 거부로 바꿨다. `port-allow.yaml`은 고치지 않았다 | 2차 메시 8/8 | 없다 |
| DAST | `ZAP 미끼 점검 3회 안에 High를 못 찾았다` | Windows Docker Desktop에서 `--network host`로 호스트의 미끼 서버에 닿지 못했다 | 고치지 않았다(환경) | — | 대상 High 0은 확인하지 못했다. Linux CI에서 다시 봐야 한다 |
| 야간 성능 | `k6 실패(base/new, 종료 1, 약속 없음)`·`dropped_iterations 155/70` | 이 PC에서 1,000 VU 발생기가 반복 시작을 다 못 해 측정이 무효가 됐다(게이트웨이·Kyverno 등을 내린 뒤에도 같음) | 고치지 않았다(환경) | 두 번 시도, 모두 무효 | 결과 파일이 없어 `compare`를 하지 못했다. 측정 창의 전용 러너에서 다시 해야 한다 |
| F-01-5 rule_files | `/api/v1/rules`의 `groups` 0개 | 로컬 Prometheus 설정에 `rule_files`가 없다 | 고치지 않았다(F-01-5 후속) | — | SLO 규칙이 로컬에서 평가되지 않는다 |

- 마지막 통과 커밋 `fe21934d`(2026-11-19) 뒤에 바뀐 것을 먼저 보는 절차를 썼다. 위 실패는 게이트웨이 e2e(문서화·Lua), 메시 표(라우트), DAST(환경), 야간 성능(환경)으로 갈렸다.
- 고침이 시험 파일을 바꿔야 하는 지적은 고치지 않고 남은 위험으로 넘겼다(ADR-0372 결정 3).

## 야간 수동 실행

| 무엇 | 명령 | 결과 | 숫자·판정 | 메모 |
| --- | --- | --- | --- | --- |
| DAST | `node --test --test-timeout=900000 tools/local/e2e/dast.e2e.mjs` | 실패 | ZAP 미끼 High 0/3회 | Windows `--network host` 환경. High 0 판정 아님 |
| 야간 성능 실행 1 | `python -I -X utf8 tools/perf-ledger/nightly.py run --config loadtest/nightly/config.json --out .cache/nightly-results.json --deadline-s 7000` | 무효 | new 1번째 dropped 155 | 결과 파일 없음. 게이트웨이 등이 남은 상태 |
| 야간 성능 실행 2 | 같은 명령 | 무효 | base 1번째 dropped 70 | 게이트웨이·Kyverno·관측을 내린 뒤에도 발생기 반복 시작 실패 |
| 야간 성능 비교 | `python -I -X utf8 tools/perf-ledger/nightly.py compare --results .cache/nightly-results.json --threshold loadtest/nightly/threshold.json --alert-out .cache/nightly-alert.md` | 미실행 | — | 결과 파일이 없어 비교하지 않았다. 통과로 세지 않는다 |

## 장부 재확인

| 항목 | 상태 | 근거 |
| --- | --- | --- |
| Q-T69 ②·S-T28 ① | 통과 | gateway-admission 18/18, gateway-admission-fault 3/3 |
| D-T50·D-T43·V-T43 | 통과 | gateway-limits 18/18, gateway-routes 10/10 |
| D-T36 | 통과 | mesh-netpol 8/8(2차). 시험 기대를 현재 라우트에 맞춤(MK-01 payment-svc는 gw-partner만, MK-03 web→ticket-svc gRPC는 거부) |
| D-T11 ②·D-T18 ② | 통과 | kyverno 5/5 |
| D-T18 ① | 통과 | diagnose 2/2 |
| D-T19 ③④ | 통과 | probes 2/2 |
| D-T33 ①② | 통과 | gitops-check 18/18 |
| I-T36 | 통과 | I-T36 7/7 |
| V-T28 ① | 통과 | relay-takeover 1/1 |
| V-T47 ⑥·V-T30 ③·C-T61 ⑦ | 동결 | INF-020·BAT-365 |
| F-01-4 운영 확인 ①~④·Tempo | 동결 | INF-020 |
| F-01-5 rule_files | 실패 | `/api/v1/rules` groups 0 |
| F-01-5 Grafana 주석 링크 | 대기 | 관측 스택 정리 전에 실제 주석을 만들지 못함 |

- 상태가 바뀐 항목은 `docs/review/measurements/F-09-8-kind-recheck.md`에 적었고, 장부 파일은 `node tools/ci/ledger.mjs`로 다시 쓴다.
- 실행하지 않은 항목을 `통과`로 적지 않았다. `동결`은 까닭을 적었다.

## 정리

| 무엇 | 결과 |
| --- | --- |
| 이 가지 클러스터 | 지움(1차 21:35:53, 재확인 21:57:41, 시험 불일치 고침 뒤 22:40:26. `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs down`) |
| 다른 클러스터·컨테이너 | kind 클러스터 0개, `freeze-f098`·`peaket` 컨테이너 0개 |
| Docker 잠금 | 1차 21:35:53, 재확인 21:57:41, 시험 불일치 고침 뒤 22:40:26 놓음 |
| 남은 포트·`.cache` | 포트 18641~18645 해제. `.cache`의 실행 로그·결과 파일은 커밋하지 않는다 |

## 남은 위험

1. **DAST**: Windows Docker Desktop의 `--network host` 제약으로 미끼가 실패했다. Linux CI에서 다시 본다.
2. **야간 성능**: 이 PC의 1,000 VU 발생기가 반복 시작을 못 해 두 번 무효였다. 측정 창 전용 러너에서 다시 잰다.
3. **저장소 변수·CI**: `PEAKET_KIND_IN_CI`는 소유자 몫이고, develop CI kind 초록은 병합 뒤에 본다.
4. **F-01-5 rule_files**: 로컬 Prometheus에 규칙이 실리지 않는다(F-01-5 후속). Grafana 주석 링크도 아직 확인하지 못했다.
