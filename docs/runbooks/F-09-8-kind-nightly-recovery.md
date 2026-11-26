# kind 재가동·야간 실행 복구 절차(F-09-8, 동결 로컬)

이 문서는 F-09-8(INF-010·INF-030·INF-040)을 동결 로컬 트랙에서 확인하는 순서다. 정본은 `docs/BUILD_ORDER.md:815`·`:817`·`:818`, ADR-0331 결정 9, ADR-0332 결정 1·4, `tools/local/README.md`이고, 이 문서는 그 절차를 사람이 따라 할 수 있게 풀어 쓴 것이다. 정본과 다르면 정본이 이긴다.

- **범위**: 로컬 kind 재가동과 ci-kind 시험, DAST·야간 성능의 수동 실행, kind로만 확인되는 장부 항목 재확인. INF-020의 배포 묶음(admission-ctrl 차트·리더 Service·`pod-deletion-cost`·`<서비스>-control` Service·`PEAKET_PROMETHEUS_URL`, Q-T12·G-09)은 동결이라 하지 않는다.
- **합치지 않는다**: 이 절차의 결과는 `freeze/lane1-F-09-8` 가지에만 남긴다. `develop`·`release/1.0.0`에 합치거나 체리픽하지 않는다(ADR-0386 결정 4).

## 1. 준비

아래 명령은 저장소 뿌리에서 Git Bash로 실행하는 것을 기준으로 적는다. PowerShell에서는 `export` 대신 `$env:PEAKET_CLUSTER='freeze-f098'`처럼 같은 값을 잡는다.

1. Docker 엔진과 Node 24, pnpm이 있는지 본다. `docker version`이 서버 판을 내야 한다.
2. Docker 차례 잠금을 잡는다. **다른 갈래가 kind를 쓰는 중이면 기다린다.**

   ```bash
   "C:\Program Files\Git\bin\bash.exe" D:/ticketpass-locks/lock.sh who docker
   "C:\Program Files\Git\bin\bash.exe" D:/ticketpass-locks/lock.sh take docker lane1-F-09-8
   ```

   `pause` 파일이 있으면 `allow: lane1-F-09-8`이 있을 때만 잡는다. 잡은 시각을 측정 기록에 적는다.
3. 이 PC에서 다른 갈래의 클러스터를 건드리지 않도록 이름과 포트를 고정한다. 기본 이름 `peaket`을 쓰지 않는다.

   ```bash
   export PEAKET_CLUSTER=freeze-f098
   export PEAKET_GATEWAY_BASE_PORT=18641
   ```

   kubeconfig는 `.cache/peaket-tools/kubeconfig-freeze-f098`이고, 게이트웨이 포트는 `127.0.0.1:18641~18645`다. 다른 클러스터·컨테이너는 그대로 둔다.
4. 도구를 받고 해시를 확인한다. `node tools/local/tools.mjs kind`·`kubectl`·`helm`이 경로를 내야 한다.

## 2. kind 재가동

```bash
node tools/local/cluster.mjs up
node tools/local/cluster.mjs status
```

`up`은 kind 클러스터 `freeze-f098`과 Strimzi Kafka 3.9.1, PostgreSQL 18, AWS 흉내 서버를 띄운다. 처음에는 이미지를 받느라 몇 분 걸린다. `status`가 핵심 파드가 준비됐다고 할 때까지 기다린다. 실패하면 `docker ps`·`kubectl --kubeconfig .cache/peaket-tools/kubeconfig-freeze-f098 get pods -A`로 원인을 가르고 측정 기록에 적는다.

## 3. ci-kind 시험

`ci-kind.yml`과 같은 차례로 돈다. 각 명령의 실패 줄·소요 시간을 측정 기록에 적는다.

```bash
node tools/local/cluster.mjs image
node --test tools/local/e2e/aws-emulator.e2e.mjs tools/local/e2e/relay-takeover.e2e.mjs
node --test tools/local/e2e/observability.e2e.mjs
node --test --test-timeout=900000 tools/local/e2e/probes.e2e.mjs
node --test --test-timeout=900000 tools/local/e2e/diagnose.e2e.mjs
node tools/local/cluster.mjs v0
node --test tools/local/e2e/v0-deploy.e2e.mjs
node tools/local/cluster.mjs gateways
node --test --test-timeout=300000 tools/local/e2e/gateways.e2e.mjs
node --test --test-timeout=300000 tools/local/e2e/queue-cors.e2e.mjs
node --test --test-timeout=300000 tools/local/e2e/gateway-limits.e2e.mjs
node --test --test-timeout=300000 tools/local/e2e/gateway-routes.e2e.mjs
node --test --test-timeout=300000 tools/local/e2e/gateway-admission.e2e.mjs
node --test --test-timeout=600000 tools/local/e2e/gateway-admission-fault.e2e.mjs
node tools/local/cluster.mjs mesh-netpol
node --test --test-timeout=300000 tools/local/e2e/mesh-netpol.e2e.mjs
node tools/local/cluster.mjs kyverno --env demo
node --test --test-timeout=900000 tools/local/e2e/kyverno.e2e.mjs
```

- v0와 게이트웨이 사이에 v0 네임스페이스를 지우는 단계가 있다(`ci-kind.yml`). 같은 클러스터에서 자리를 비우려면 그 단계를 그대로 따른다.
- Kyverno 입장 시험은 Linux의 `--network host`를 전제한다. Windows에서는 설치·정책 적용(`cluster.mjs kyverno --env demo`)까지만 보고, 입장 시험은 CI/Linux 몫으로 넘긴다. 넘긴 사실을 측정 기록에 적는다.
- 실패가 나오면 마지막 통과 커밋 `fe21934d`(2026-11-19) 뒤에 바뀐 것을 먼저 본다. ADR-0332 맥락이 든 후보는 Kyverno 입장 시험, 게이트웨이 e2e, 데모 시드다. 재현 명령·실패 줄·원인·고침(또는 남은 위험)을 적는다.

## 4. 야간 실행 수동 복구

예약(`schedule`)은 기본 가지에서만 돈다. 이 가지에서는 예약이 실제로 울리지 않으므로 같은 명령을 손으로 돌린다. 병합 뒤 첫 예약 실행은 남은 몫이다.

### 4.1 DAST

```bash
node --test --test-timeout=900000 tools/local/e2e/dast.e2e.mjs
```

kind의 www·api·partner만 ZAP 기준선으로 점검하고 High(7.0 이상) 0을 본다. 미끼가 High를 못 찾으면 대상 점검을 하지 않는다. 실패하면 공격 이름·경로·응답을 적고, 예외 목록으로 덮지 않는다.

### 4.2 야간 축소 성능(D-T40)

```bash
python -I -X utf8 tools/perf-ledger/nightly.py run --config loadtest/nightly/config.json --out .cache/nightly-results.json --deadline-s 7000
python -I -X utf8 tools/perf-ledger/nightly.py compare --results .cache/nightly-results.json --threshold loadtest/nightly/threshold.json --alert-out .cache/nightly-alert.md
```

`prepare.mjs`가 kind를 `up --v0-only`로 올리고 v0를 배포하며, 가장 최근 출시 태그를 기준판으로 따로 빌드해 `v0-base`에 올린다. 두 판을 번갈아 5번 재고 p99 중앙값 비율을 `threshold.json`의 `max_ratio`와 견준다. 기준값과 A/A 목록은 소유자·감독 결정 없이 바꾸지 않는다. 실행이 실패하면 `--deadline-s`와 잡 시간 상한의 관계, k6 종료 코드, 입력 파일을 적는다.

## 5. 장부 재확인

`docs/review/measurements/F-09-8-kind-recheck.md`의 표를 위에서 아래로 돈다. 행마다 명령·판정 근거·상태를 채운다.

- 상태는 `대기`·`통과`·`실패`·`해당 없음`·`동결` 다섯뿐이다. 실행하지 않은 항목을 `통과`로 적지 않는다.
- `동결`은 까닭을 적는다(예: C-T61 ⑦은 BAT-365/INF-020, V-T47 ⑥·V-T30 ③은 운영 Grafana·Mimir·수집기 배포가 INF-020).
- 상태가 바뀐 항목만 `docs/review/ledger-notes.md`를 고치고, 장부 파일은 손으로 고치지 않고 다시 쓴다.

```bash
node tools/ci/ledger.mjs
node tools/ci/ledger.mjs --check
node tools/ci/ledger.mjs --batch F-09-8 --require
```

## 6. 정리

```bash
node tools/local/cluster.mjs status
node tools/local/cluster.mjs down
```

- `down`은 `PEAKET_CLUSTER=freeze-f098` 클러스터만 지운다. 기본 이름 `peaket`이나 다른 갈래의 `lane*` 클러스터를 지우지 않았는지 `kind get clusters`와 `docker ps`로 확인한다.
- Docker 잠금을 놓고 시각을 적는다.

  ```bash
  "C:\Program Files\Git\bin\bash.exe" D:/ticketpass-locks/lock.sh drop docker lane1-F-09-8
  ```

- 남은 컨테이너·포트·`.cache` 파일이 있으면 지운다. 지우지 못한 것은 측정 기록에 적는다.

## 7. 한계

- **기본 가지 예약**: GitHub은 예약 워크플로를 기본 가지(`develop`)의 최신 커밋에서만 돌린다. freeze 가지의 `on.schedule`은 병합 전에 울리지 않는다.
- **저장소 변수**: `PEAKET_KIND_IN_CI`는 저장소 변수라 소유자가 켠다. 이 절차는 `ci.yml`의 조건이 그 변수를 보는지 정적으로 확인할 뿐, 변수를 켜지 않는다.
- **Windows Kyverno**: Kyverno 입장 시험은 Linux 환경 몫이다. Windows에서는 설치·정책 적용까지만 본다.
- **동결 몫**: INF-020의 배포 묶음, 운영 Grafana·Mimir·Loki·Tempo 응답, 수집기 셋의 실제 kind 확인, CronJob 마지막 성공 경보는 이 절차에서 닫지 않는다.
- **비용·알림**: 병합 뒤 예약이 돌면 주 1회 kind(약 90분 상한), 매일 DAST·야간 성능이 돌고, DAST·성능 실패는 SEV3 이슈를 연다. 동결을 풀 때 소유자가 판단한다.
