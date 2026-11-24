# OTel 수집기 셋의 설정

요청 기록(trace)과 로그를 모아 거르는 수집기 셋(에이전트·게이트웨이·클러스터)의 설정 원천이다. 동작과 규칙의 정본은 docs/observability.md §1 '수집기 구성'·'설정 원천과 로컬 확인', §6 '테일 기반 적응형 샘플링', §7 '2차 마스킹 정규식 원천'이고, 이 글은 파일 차례와 띄우는 법만 적는다(BUILD_ORDER F-01-3, OPS-060).

## 파일

| 파일 | 무엇 | 손으로 고침 |
| --- | --- | --- |
| `agent.yaml` | 에이전트(노드마다 하나) 운영 판: OTLP·컨테이너 표준 출력 → 쿠버네티스 메타데이터 → trace ID 부하 분산·게이트웨이 | 고친다 |
| `gateway.yaml` | 게이트웨이 수집기 운영 판: 받기·메모리 상한·묶기·Tempo(관측 전용 Kafka)·Loki 내보내기와 파이프라인 차례 | 고친다 |
| `cluster.yaml` | 클러스터 수집기 운영 판: 쿠버네티스 이벤트를 리더 하나만 받아 Loki로 | 고친다 |
| `access-log.yaml` | 접근 로그 세 갈래(법정·일반·조사)와 법정 접속기록 DB·조사 Kafka 내보내기(BUILD_ORDER F-01-8, OPS-070) | 고친다 |
| `generated/tail-sampling.yaml` | 꼬리 표본 처리기(크기 값과 정책 다섯, 드문 경로 정책은 openapi의 `x-peaket-trace-rare`에서) | **고치지 않는다** |
| `generated/pii-masking.yaml` | 2차 마스킹 처리기(`packages/platform/src/pii-patterns.json`의 꼴, IP 속성 처리) | **고치지 않는다** |
| `local/agent.yaml`·`local/gateway.yaml`·`local/access-log.yaml` | 운영 판 위에 겹치는 로컬 판(쿠버네티스 없이 Docker로) | 고친다 |

`generated/`는 원천(openapi, docs/observability.md §1 꼬리 표본 줄, `pii-patterns.json`)을 고친 뒤 `node tools/ci/collector-config.mjs --write`로만 만든다. `--check`가 생성 대조와 운영 판 셋의 규칙을 보고, tools-check가 돌린다.

## 겹쳐 읽는 차례

수집기는 `--config`를 거듭 받아 차례로 겹친다. 뒤 파일의 표가 앞 파일의 같은 표를 덮고, 목록(파이프라인의 처리기·내보내기 등)은 통째로 바뀐다.

- 게이트웨이: `--config gateway.yaml --config generated/tail-sampling.yaml --config generated/pii-masking.yaml`(운영). 로컬은 끝에 `--config local/gateway.yaml`을 더한다(내보내기만 파일로 바뀌고 처리기 차례는 운영 판 그대로).
- 에이전트: `--config agent.yaml --config access-log.yaml`(운영). 로컬은 끝에 `--config local/agent.yaml --config local/access-log.yaml`을 더한다(쿠버네티스 메타데이터를 빼고, 부하 분산은 Docker 네트워크 별칭 `peaket-gw-0`·`peaket-gw-1`, 로그는 `peaket-gw-0`으로, 접속기록 DB·Kafka는 127.0.0.1로).
- 클러스터: `--config cluster.yaml`(쿠버네티스가 있어야 떠서 로컬 판이 없다).

## 로컬로 띄우기

수집기 이미지는 판과 다이제스트를 고정한다(docs/devops.md §4.4). 플랫폼 통합 시험(`packages/platform/test-int/collector.ts`의 `COLLECTOR_IMAGE`)과 같은 값이다.

```
otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea
```

저장소 뿌리에서(Docker 엔진, 환경 변수 없음):

```bash
IMG=otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea
mkdir -p /tmp/otelcol-out && chmod 777 /tmp/otelcol-out
docker run --rm -p 4317:4317 -p 4318:4318 -p 8888:8888 \
  -v "$PWD/deploy/platform/observability/collector:/etc/otelcol:ro" -v /tmp/otelcol-out:/var/lib/otelcol/out \
  "$IMG" --config /etc/otelcol/gateway.yaml --config /etc/otelcol/generated/tail-sampling.yaml \
  --config /etc/otelcol/generated/pii-masking.yaml --config /etc/otelcol/local/gateway.yaml
```

- 받는 곳: OTLP gRPC 4317, OTLP HTTP 4318. 자체 지표: `:8888/metrics`(Prometheus 형식).
- 결과: `/var/lib/otelcol/out/traces.json`·`logs.json`(JSON 줄). 꼬리 표본이 판정을 기다리므로(§6 `decision_wait`) trace는 그만큼 늦게 나온다.
- 설정만 확인: 위 명령의 `--config …` 앞에 `validate`를 넣는다.
- 자동 시험: `pnpm --filter @peaket/platform test:integration test-int/collector-masking.int.test.ts`(V-T49 ③, 같은 꼴로 ④⑤와 V-T30 ②).
- 접속기록 갈래만 띄우기(법정 접속기록 DB·Kafka가 있어야 한다): 위 에이전트 명령에 `--config /etc/otelcol/access-log.yaml --config /etc/otelcol/local/access-log.yaml`을 더한다. 정적 검사는 `node tools/ci/access-log-config.mjs`다.

## 운영 판의 가정

- 내보내기 주소(`obs-kafka-bootstrap.observability.svc:9098`, `loki-gateway.observability.svc:3100`)와 부하 분산이 찾는 헤드리스 Service(`otel-gateway-headless.observability`), 리더 임대 이름은 INF-020 배포가 정하는 이름에 맞춘다 [가정]. 노드 사이 암호화는 메시(ambient mTLS)가 맡아 수집기끼리는 평문 OTLP다.
- 배포(DaemonSet·Deployment·헤드리스 Service·권한·NetworkPolicy), Prometheus가 `:8888`을 긁는 설정, 이미지 서명 확인은 INF-020 몫이다.
