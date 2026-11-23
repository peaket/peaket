# 관측 설정 원천

관측 저장소(지표·로그·요청 기록을 모아 두는 곳)와 exporter(저장소·클라우드의 상태를 Prometheus 형식 지표로 바꿔 내놓는 작은 프로그램), Grafana 연결의 설정 파일이다. 무엇을 왜 그렇게 두는지의 정본은 [docs/observability.md](../../../docs/observability.md) §1 '관측 저장소 설정 원천과 로컬 확인'이다. 이 글은 파일 차례와 쓰는 법만 적는다. 실제 배포(Helm 차트 값, 영역별 복제, 객체 저장소·KMS 권한)는 INF-020이 이 파일을 그대로 싣는다.

## 파일

| 자리 | 무엇 | 검사 |
| --- | --- | --- |
| `mimir/config.yaml` | Mimir 운영 판(인제스터 링 복제·영역 인식) | `observability-stores.mjs` |
| `mimir/runtime-overrides.yaml` | Mimir 테넌트별 보존 | `observability-config.mjs` |
| `loki/config.yaml`, `loki/local.yaml` | Loki 운영 판과 로컬 판(복제·보존·한도·OTLP 색인 라벨) | `observability-stores.mjs` |
| `tempo/config.yaml`, `tempo/local.yaml` | Tempo 운영 판과 로컬 판(쓰기 큐·보존·서비스 그래프·원격 쓰기) | `observability-stores.mjs` |
| `exporters/postgres-exporter.yaml` | postgres_exporter 이미지와 인자(쿼리 통계) | `observability-stores.mjs` |
| `exporters/yace.yaml` | CloudWatch 내보내기 도구 YACE의 CloudFront 수집 작업 둘 | `observability-stores.mjs` |
| `prometheus/remote-write.yaml` | 클러스터 Prometheus → Mimir 원격 쓰기 | `observability-config.mjs` |
| `rules/`, `alerts/` | 기록 규칙과 경보 규칙 | `observability-config.mjs` |
| `alertmanager/` | Alertmanager 받는 곳 다섯·경로·Slack 문구 틀, 데드맨 규칙의 받는 곳 | `tools/ci/alertmanager-config.test.mjs`, 플랫폼 통합 시험 |
| `alert-check.yaml` | 경보 규칙 검사의 '그 밖의 긁기 작업' 간격과 규칙 시험 간격 예외 목록(docs/observability.md §4 '검사 방법' ③) | `alert-check.mjs` |
| `grafana/` | Grafana 조직·폴더, 데이터 소스(신호 연결 포함)·대시보드 공급자 | 둘 다 |

검사는 저장소 뿌리에서 돌린다. 어긋나면 tools-check가 병합 전에 막는다.

```bash
node tools/ci/observability-stores.mjs --check
node tools/ci/observability-config.mjs --check
```

## 로컬 판 겹치기

Loki·Tempo는 설정 파일을 하나만 읽는다. 그래서 운영 판(`config.yaml`) 위에 로컬 판(`local.yaml`)을 겹쳐 한 파일로 만든다. 표(키와 값의 묶음)는 키마다 합치고, 목록과 값은 로컬 판이 통째로 바꾸며, 로컬 판에 `null`로 적은 키는 지운다. 로컬 판은 한도·라벨·보존을 덮지 않는다. 그래서 Docker로 띄운 로컬 판이 운영 판의 한도와 라벨을 그대로 시험한다.

```bash
node tools/ci/observability-stores.mjs --render loki > loki.yaml
node tools/ci/observability-stores.mjs --render tempo > tempo.yaml
```

## 시험에 쓰는 이미지

플랫폼 통합 시험(`packages/platform/test-int/`의 `tempo-service-graph`·`loki-labels`·`loki-limits`·`postgres-exporter`, V-T50 ③④⑤·V-T30 ④)이 아래 판으로 띄운다. 값의 원본은 시험 도우미 `packages/platform/test-int/observability-stores.ts`의 상수이고, 판을 올리면 그 상수와 이 표를 함께 고친다. postgres_exporter는 `exporters/postgres-exporter.yaml`의 `image`가 같은 값이어야 한다(V-T50 ⑤가 본다).

| 도구 | 이미지 |
| --- | --- |
| Loki | `grafana/loki:3.7.10@sha256:b43c257ccfc925d4a50b8717cac61a3b51df8c48d01847936057e5c4075a24a7` |
| Tempo | `grafana/tempo:3.1.1@sha256:64e2fbd56d9c2b3412a4b430a58ea59e91a670b1e75f920a0c702213ad145044` |
| Prometheus | `prom/prometheus:v3.14.0@sha256:e906cef998316bbe319f98711e1b4d8613ad37e14b08ff831d7036e77b7464f9`(`deploy/local/observability.yaml`과 같은 판) |
| postgres_exporter | `prometheuscommunity/postgres-exporter:v0.21.1@sha256:3b8e05a84282cd1199ad2fb6c66f362738bf4c68c1547d8f4226a34a7dd6d8d7` |
| PostgreSQL | `postgres:18-alpine`(`packages/platform/test-int/postgres.ts`) |
