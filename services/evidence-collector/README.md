# evidence-collector — 증거 수집기

Alertmanager 웹훅을 받아 큰 경보(SEV1·의존성 원인 SEV2·인시던트 선언)가 가리키는 의존성(PostgreSQL·Redis)의 순간 상태를 떠 진단 증거 저장소(S3 증거 버킷)에 올린다. 장애가 지나간 뒤에도 그때 DB가 무엇에 막혀 있었는지 볼 수 있게 남기는 블랙박스다. 동작의 정본은 [docs/observability.md](../../docs/observability.md) §5 '진단 증거'(받는 길·고르기·간격·뜨는 것·올리기·신호)와 §9 '진단 증거' 행(보존)이고, 결정은 ADR-0070 결정 1이다. 기능 F-01-1, 시험 D-T51(docs/devops.md).

- 받는 곳: 앱 포트 `POST /internal/v1/alerts`(Alertmanager 기본 웹훅 판 4, `Authorization: Bearer <공유 토큰>`). 토큰이 없거나 틀리면 401 Problem과 보안 로그 한 줄, 맞으면 곧바로 202 `{"accepted": <받은 경보 수>}`이고 수집은 답한 뒤에 한다.
- 뜨는 것: PostgreSQL은 `pg-activity.json`·`pg-blocking.json`·`pg-replication-slots.json`, Redis는 `redis-info.txt`·`redis-slowlog.json`·`redis-client-list.txt`, 둘 다 `manifest.json`. 객체 이름은 `evidence-collector/<대상>/<UTC 밀리초 시각>/<파일>`이고 모든 객체에 보존 태그가 붙는다(`@peaket/platform` 증거 저장소).
- 지표(관리 포트 `/metrics`): `evidence_collections_total{target, result}`, `evidence_webhook_alerts_total{decision}`, `evidence_webhook_rejected_total{reason}`.
- 자기 DB가 없고 수집 간격은 메모리에만 둔다(다시 뜨면 처음부터 센다). 복제 1개로 둔다.

## 환경 값

| 이름 | 필수 | 뜻 |
| --- | --- | --- |
| `PEAKET_EVIDENCE_WEBHOOK_TOKEN` | 예 | 웹훅 공유 토큰(Secret). Alertmanager 수신 설정의 Bearer 토큰과 같다 |
| `PEAKET_EVIDENCE_TARGETS` | 예 | 수집 대상 JSON 배열 `[{"name":"<대상>","kind":"postgres"\|"redis","urlEnv":"<접속 주소를 담은 환경 값 이름>"}]`. 이름은 `^[a-z0-9-]+$`, 겹치면 안 된다. 경보의 `dependency` 라벨 값이 이 이름이다 |
| 각 `urlEnv` | 예 | 그 대상의 접속 주소(Secret). PostgreSQL은 `pg_monitor` 역할만 받은 사용자, Redis는 `INFO`·`SLOWLOG GET`·`CLIENT LIST`만 허용한 사용자다 |
| `PEAKET_DIAG_BUCKET` | 예(`main.ts`) | 진단 증거 버킷 이름(진단 수집과 같은 이름) |
| `PEAKET_DIAG_S3_ENDPOINT` | 아니오 | local·ci의 흉내 서버(moto) 주소 |

하나라도 틀리면 시작하지 않는다. 그 밖은 플랫폼 공통 값(`PEAKET_ENV`·`PORT`·`PEAKET_MANAGEMENT_PORT` 등, `packages/platform/README.md`)이다.

## 명령

```bash
pnpm --filter @peaket/evidence-collector test               # 단위 시험(D-T51 ②③④⑥, 닫힌 포트로 접속 실패를 실제로 본다)
pnpm exec turbo run build --filter=@peaket/evidence-collector^...
pnpm --filter @peaket/evidence-collector test:integration   # 실제 PostgreSQL 18·Valkey 8.1(D-T51 ①⑤⑥, Docker 필요)
pnpm --filter @peaket/evidence-collector build && node --import @peaket/platform/telemetry/register dist/main.js
```

배포(플랫폼 네임스페이스, NetworkPolicy, `pg_monitor`·Redis 사용자, Alertmanager 수신 설정, 버킷)는 INF-020이다. 수집 실패·거절 경보 규칙은 OPS-100, 대시보드 패널은 platform 폴더 '관측 파이프라인' 대시보드의 증거 수집기 행이다(`tools/local/dashboards.mjs`가 만든다, OPS-080).
