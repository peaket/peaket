# loadtest/analytics — F-04-8 측정 하네스

초당 3만 건 분석 이벤트를 Kafka에 넣고 `analytics-ingest`·`ops-rt`·`rt-pulse`를 실제로 돌려 ① 신선도 ② 누락률 ③ 강제 종료 뒤 정확성을 재는 도구다. 정본은 [docs/review/plans/F-04-8.md](../../docs/review/plans/F-04-8.md)이고, 시험 절차는 [docs/verification.md](../../docs/verification.md) §3.7·V-T19, 목표 숫자는 NFR-009다.

## 준비

- Node 24, Docker 엔진, 이미지 `apache/kafka:3.9.2`·`clickhouse/clickhouse-server:24.12`.
- 빌드(저장소 뿌리):
  ```bash
  pnpm exec turbo run build --filter=@peaket/contracts --filter=@peaket/platform \
    --filter=@peaket/analytics-ingest --filter=@peaket/ops-rt --filter=@peaket/rt-pulse
  ```
- Docker 잠금(측정 창은 두 자리 모두):
  ```bash
  bash D:/ticketpass-locks/lock.sh take docker-all lane6-F-04-8
  bash D:/ticketpass-locks/lock.sh drop docker-all lane6-F-04-8
  ```
- 스모크 한 번은 Docker 자리 하나(`docker`)로 충분하다. 끝나면 컨테이너를 지운다(`cleanup`).

## 명령

```bash
node loadtest/analytics/run.mjs smoke                 # 2,000건/초 × 30초, 10초에 분석·관제 SIGKILL
node loadtest/analytics/run.mjs run \\
  --rate 30000 --duration 1800 --partitions 12 --shards 4 --workers 2
node loadtest/analytics/run.mjs crash \\
  --rate 30000 --duration 600 --kill analytics,rt --kill-at 120
node loadtest/analytics/run.mjs hot \\
  --hot-rate 4500 --duration 1800 --background-events 11
node loadtest/analytics/run.mjs ladder \\
  --rates 30000,40000,50000,60000,75000,100000 --duration 300
node loadtest/analytics/run.mjs verify --out .cache/f048/<이름>   # 이미 끝난 실행을 다시 집계
node loadtest/analytics/run.mjs cleanup                           # 이름표 peaket.f048=1 컨테이너만 지운다
```

- `--partition-mode hash`(기본)는 한 회차의 사건을 토픽마다 파티션 0에 몰아 키 쏠림을 만든다. `spread`는 파티션을 돌려 처리량 상한을 볼 때 쓴다.
- `--workers 2`는 운영 복제 2개를 흉내 낸다(같은 소비자 그룹, 파티션 나눔).
- `--shards 4`는 발생기를 네 프로세스로 나눈다. 한 프로세스가 8,000~12,000건/초 [가정]을 낸다.
- `--keep`은 끝나도 컨테이너를 남긴다(디버깅). 끝나면 `cleanup`으로 지운다.
- `hot`은 ST-T17이다. 핫 회차의 좌석·주문이 `--hot-rate`(기본 4,500건/초)이고, 배경 11회차는 각각 그 1/10이다. 총 입력은 약 9,450건/초가 된다.

## 판정

- **신선도**: `rt.pulse`의 `지금 − max(produced_at)`을 1초마다 재고, 1분 창마다 p95 < 5초, 전 구간 p95 < 5초. 회복 구간(강제 종료 뒤 60초)은 신선도에서 뺀다. 브론즈 신선도는 참고값이고 정본 목표가 없다.
- **누락률**: `(못 읽은 오프셋 + 거절 + 발생기 최종 실패) ÷ (전체 오프셋 + 발생기 최종 실패)`. 0.1% 미만. 모집단이 1만 건 미만이면 0건만 통과다. 발생기 실패가 1건이라도 있으면 실행이 `invalid`다.
- **정확성**: 브론즈는 레코드별 `uniqExact(event_key)`·주문/결제 금액, rt는 `source/type`별 고유 `event_key`·결제 금액·홀드 결과·판정 범주가 발생기 기대와 **차이 0**. 원시 행 중복은 정상이고 고유 수로 판정한다.
- **인기 회차(ST-T17)**: 핫 파티션의 소비 밀림 p95 < 5초 [가정].
- `invalid`(발생기 포화·실패, 샘플 부족, 그룹을 찾지 못함, 따라잡기 실패)는 통과도 실패도 아니다. `pass`는 모든 필수 항목이 참일 때만이다.

## 산출물

`.cache/f048/<실행>/`에 다음을 쓴다(커밋하지 않는다).

| 파일 | 내용 |
| --- | --- |
| `run.json` | 조건, 커밋, 시작·끝 오프셋, 강제 종료 시각, 따라잡기 시간, 판정 |
| `shard-<n>/manifest.json` | 발생 성공 건수·금액 합계·홀드/판정 결과·실패 |
| `freshness.jsonl` | 1초 샘플(관제·브론즈 신선도, 조회 시간, 그룹·핫 파티션 밀림, 호스트·ClickHouse CPU) |
| `verify.json`·`report.json` | 기대·실제·판정·이유 |
| `report.md` | 사람이 읽는 요약 |
| `bench.json` | `tools/perf-ledger/collect.py --bench-summary`가 읽는 모양 |
| `infra.json` | PC·Docker·이미지·메모리 |
| `workers/*.log` | 작업자·발생기 로그 |

성능 장부에는 `bench.json`을 `--bench-summary`로 넣고 `--kpi NFR-009`로 적는다(측정 창에서).

## 알려진 한계

- Kafka·ClickHouse 한 대, 작업자 호스트 프로세스, PC 한 대다. 운영 MSK·관리형 ClickHouse의 복제·네트워크 지연은 빠진다.
- `ops-rt`는 가짜 Schema Registry(같은 계약의 고정 ID)로 띄운다. 실제 레지스트리의 인증·네트워크 지연은 빠진다.
- 5,000건/초 스모크에서 ClickHouse CPU p95가 79%였다. 30,000건/초는 이 PC에서 포화될 수 있고, 그 값 자체가 V-T19의 한계다.
- 조사 사본(`investigation.requests`)·`inv-ingest`는 아직 저장소에 없어 입력에 넣지 않는다(ADR-0171 확장은 그 기능이 생긴 뒤).
