# F-09-8 kind 장부 재확인 표

이 표는 `docs/BUILD_ORDER.md:818`(INF-040)과 ADR-0332 결정 4가 든 kind 항목, 그리고 INF-040이 F-01-2·F-01-3·F-01-4·F-01-5에서 넘겨받은 항목을 다시 보는 순서다. 실행 절차는 `docs/runbooks/F-09-8-kind-nightly-recovery.md`를 따른다. 상태는 `대기`·`통과`·`실패`·`해당 없음`·`동결` 다섯뿐이고, 실행하지 않은 항목을 `통과`로 적지 않는다. 결과·명령 출력의 요지는 `docs/review/measurements/F-09-8-kind.md`에 적는다.

| 항목 | 무엇을 다시 보나 | 명령 | 판정 근거 | 상태 | 기록 |
| --- | --- | --- | --- | --- | --- |
| Q-T69 ② | 입장 토큰 공개키 목록을 비우고 지웠다 되돌리는 복구 경로에서 거절과 복구가 맞는가 | `node --test --test-timeout=300000 tools/local/e2e/gateway-admission-fault.e2e.mjs` | 응답 401·200과 키 목록 복구 뒤 정상 입장(장부 Q-T69 ②) | 대기 | — |
| S-T28 ① | gw-fan 구매 경로가 입장 토큰을 확인하고 잘못된 토큰을 거절하는가 | `node --test --test-timeout=300000 tools/local/e2e/gateway-admission.e2e.mjs` | 서명·`typ`·`iss`·`aud`·회차 대조와 옛 키 허용(장부 S-T28 ①) | 대기 | — |
| D-T50 | 경로별 메서드·전역 한도·웹훅 IP 한도·게이트웨이 오류가 정의대로인가 | `node --test --test-timeout=300000 tools/local/e2e/gateway-limits.e2e.mjs` | 429·403·405·`Retry-After`와 경로별 상한(장부 D-T50) | 대기 | — |
| D-T43 | 게이트웨이 오류가 Problem+JSON과 `traceId`로 나가는가 | `node --test --test-timeout=300000 tools/local/e2e/gateway-limits.e2e.mjs tools/local/e2e/gateway-routes.e2e.mjs` | 502·504·403·405의 Problem 본문과 trace 연결(장부 D-T43) | 대기 | — |
| D-T36 | 메시 없는 실행의 포트별 NetworkPolicy가 연결을 허용·거부하는가 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs mesh-netpol && node --test --test-timeout=300000 tools/local/e2e/mesh-netpol.e2e.mjs` | 허용 포트 연결 성공·목록 밖 포트 거부(장부 D-T36 ①~⑦) | 대기 | — |
| D-T11 ② | Kyverno 이미지 정책이 테스트 키 서명 입장과 서명 없음·다른 키·초기 컨테이너 서명 없음을 실제 입장에서 가르는가 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs kyverno --env demo && node --test --test-timeout=900000 tools/local/e2e/kyverno.e2e.mjs` | 서명 있음 통과·없음/다른 키/초기 컨테이너 거부(장부 D-T11 ②, Linux/CI 몫) | 대기 | — |
| D-T18 ① | kind 파드에 진단 주석을 달면 준비를 내리고 보고서·힙 스냅샷을 증거 저장소에 올린 뒤 다시 뜨는가 | `node --test --test-timeout=900000 tools/local/e2e/diagnose.e2e.mjs` | 준비 상태 내림·증거 객체 업로드·재시작(장부 D-T18 ①) | 대기 | — |
| D-T18 ② | `--disable-sigusr1`이 없는 Node 파드를 Kyverno가 거부하는가 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs kyverno --env demo && node --test --test-timeout=900000 tools/local/e2e/kyverno.e2e.mjs` | command·`NODE_OPTIONS`·`sh -c`·`--inspect` 다섯 사례 거부(장부 D-T18 ②, Linux/CI 몫) | 대기 | — |
| D-T19 ③ | 이벤트 루프를 2초씩 막아도 준비 상태가 유지되고 Service에서 빠지는 파드가 0인가 | `node --test --test-timeout=900000 tools/local/e2e/probes.e2e.mjs` | 준비 프로브 5초·시간 초과 3초·연속 6회에서 빠진 파드 0(장부 D-T19 ③) | 대기 | — |
| D-T19 ④ | 같은 시험을 쿠버네티스 기본 프로브 값으로 돌리면 빠지는 파드 수와 시각이 기록되는가 | `node --test --test-timeout=900000 tools/local/e2e/probes.e2e.mjs` | 기본값(10초·1초·3회)에서 빠진 파드 수·시각 기록(장부 D-T19 ④, 측정) | 대기 | — |
| D-T33 ① | 오버레이별 허용 레지스트리 값이 정책과 같고 `gitops-check`가 같은 값으로 PR을 막는가 | `node --test tools/ci/gitops-check.test.mjs` | 허용 레지스트리 목록과 정책 대조(장부 D-T33 ①) | 대기 | — |
| D-T33 ② | 허용 레지스트리 밖 이미지를 쓰는 PR이 `gitops-check`에서 막히는가 | `node --test tools/ci/gitops-check.test.mjs` | 목록 밖 레지스트리 거부(장부 D-T33 ②) | 대기 | — |
| V-T43 | 게이트웨이 차단 상한과 빠른 실패가 정상 부하에서 503 0건인가 | `node --test --test-timeout=300000 tools/local/e2e/gateway-limits.e2e.mjs` | 정상 부하 503 0건·과부하 빠른 실패(장부 V-T43 ①②) | 대기 | — |
| I-T36 | 다른 대상·다른 `typ`의 토큰이 게이트웨이에서 401로 거절되는가 | `node --test --test-timeout=300000 tools/local/e2e/gateways.e2e.mjs` | 팬 키로 서명한 ops 토큰·입장 토큰을 액세스 자리에 넣은 요청의 401(장부 I-T36) | 대기 | — |
| V-T28 ① | Outbox 릴레이 리더를 멈추고 이어받기·빠짐·순서가 맞는가 | `node --test tools/local/e2e/relay-takeover.e2e.mjs` | SIGSTOP 뒤 리더 이어받기와 누락·중복 0(장부 V-T28 ①의 kind 부분) | 대기 | — |
| V-T47 ⑥ | 실제 Grafana·Mimir 응답으로 조직 둘·폴더·보존·골라 보내기가 맞는가 | — | 운영 Grafana·Mimir 배포가 INF-020 동결이라 확인할 수 없다. 파일끼리 맞는 것은 V-T47 ①~⑤가 본다 | 동결 | — |
| V-T30 ③ | gw-queue가 trace를 0.1%만 고르고 고르지 않은 요청의 queue-svc span을 내보내지 않는가 | — | 수집기 셋·게이트웨이 배포가 INF-020 동결이라 확인할 수 없다. 수집기 설정은 V-T49가 Docker로 본다 | 동결 | — |
| C-T61 ⑦ | CronJob 마지막 성공 시각이 늦으면 SEV2 경보가 나는가 | — | BAT-365와 kind 클러스터·경보 규칙 배포가 INF-020 동결이다. 이 기능에서 닫지 않는다 | 동결 | — |
| F-01-4 운영 확인 ① | Mimir·Loki·Tempo의 복제·보존·쓰기 경로가 설정 원천대로 실렸는가 | — | 운영 판 배포가 INF-020 동결이다. `docs/observability.md` §9 운영 확인 표의 배포 뒤 확인 몫 | 동결 | — |
| F-01-4 운영 확인 ② | Loki 라벨이 넷이고 첫 온세일 동안 거절이 0인가 | — | 운영 판 Loki 배포가 INF-020 동결이다. `docs/observability.md` §1 운영 확인 표의 배포 뒤 확인 몫 | 동결 | — |
| F-01-4 운영 확인 ③ | 서비스 지도에 서비스 사이 gRPC 연결이 보이는가 | — | 운영 판 Tempo·Mimir 배포가 INF-020 동결이다. `docs/observability.md` §6 운영 확인 표의 배포 뒤 확인 몫 | 동결 | — |
| F-01-4 운영 확인 ④ | PostgreSQL 쿼리 통계에 `query` 라벨이 없고 `queryid`만 상위 20개로 나오는가 | — | 운영 판 postgres_exporter 배포가 INF-020 동결이다. `docs/observability.md` §8 운영 확인 표의 배포 뒤 확인 몫 | 동결 | — |
| F-01-4 Tempo 마이크로서비스 모드 | 운영 판 Tempo가 마이크로서비스 모드로 실제로 뜨고 관측 전용 Kafka에 쓰는가 | — | Tempo 운영 판 배포와 관측 전용 MSK가 INF-020 동결이다. `docs/observability.md` §1의 남은 확인 몫 | 동결 | — |
| F-01-5 로컬 Prometheus rule_files | 로컬 Prometheus가 `rule_files`를 실제로 싣고 규칙이 평가되는가 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs observability && PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs prometheus && curl -s http://127.0.0.1:9090/api/v1/rules` | `/api/v1/rules`에 SLO 규칙이 보이고 `up`·평가 시각이 움직인다 | 대기 | — |
| F-01-5 Grafana 주석 링크 | 경보 주석의 링크 앞에 Grafana 주소가 붙어 눌러 열리는가 | `PEAKET_CLUSTER=freeze-f098 node tools/local/cluster.mjs grafana` | Grafana에서 경보 주석 링크를 눌러 대시보드가 열린다 | 대기 | — |
