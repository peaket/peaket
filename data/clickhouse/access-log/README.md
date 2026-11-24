# 법정 접속기록 DB `access_log`

법정 접속기록(통신비밀보호법 시행령 §41②2호 준용, POL-025)을 담는 ClickHouse 전용 데이터베이스다. 업무 DB·분석 DB·조사 저장소 `inv`와 떨어진 곳에 둔다(docs/data.md §1, docs/observability.md §7).

## 파일

| 파일 | 무엇 |
| --- | --- |
| `001_access_log.sql` | exporter 원천 표 `access_log_otel`, 계약 표 `access_log`, 그 둘을 잇는 materialized view `access_log_from_otel` |
| `002_users.sql` | 사용자 넷과 권한(넣기만·관리 계정 줄만·수사 대응만·마이그레이션만) |

수집기(ClickHouse exporter)는 자기 고정 칸(`Timestamp`·`TraceId`·`LogAttributes` 등)을 가진 `access_log_otel`에 넣는다. `access_log`는 계약 칸(`ts`·`source`·`client_ip`… )을 가진 표이고, materialized view가 `LogAttributes`를 옮겨 적는다. 그래서 exporter의 `create_schema: false`와 표 칸이 어긋나지 않는다.

## 보존과 하루 사본

- 두 표의 TTL은 3개월 이상이다. TTL을 줄이는 변경은 `node tools/ci/access-log-config.mjs`가 막는다.
- 매일 04:00 [가정] 전날 파티션을 Parquet 파일 하나로 접속기록 사본 버킷에 내보낸다. 파일의 행 수와 SHA-256이 일 해시 앵커다.
- 사본 버킷은 Object Lock 준수 모드이고, 보존은 그 날짜의 3개월 + 7일 [가정]이다. 보존 기간 안의 삭제는 버킷이 거부한다.
- 7일 백업 밖의 날짜는 하루 사본으로 되살린다(RB-38, V-T23). 다시 넣은 행 수와 SHA-256이 앵커와 같아야 한다.
- 다음 날 03:30에 전날 하루를 대조하고, 전날 사본 성공 표시가 06:00까지 없으면 SEV2다.

## 로컬로 적용하기

`002_users.sql`은 비밀번호 자리에 `${PEAKET_AL_*_PASSWORD}`를 둔다. 파일을 그대로 적용하지 말고 INF-020이 External Secrets로 채운 뒤 envsubst로 적용한다. 로컬 시험은 사용자 없이 `default` 사용자로 표만 만든다.

```bash
docker run --rm -d --name peaket-ch-access -p 127.0.0.1:9000:9000 clickhouse/clickhouse-server:24.12
docker exec -i peaket-ch-access clickhouse-client --multiquery < data/clickhouse/access-log/001_access_log.sql
```

로컬 단일 노드에는 Keeper가 없어 `ReplicatedMergeTree`가 뜨지 않는다. 시험은 `ENGINE = MergeTree`로 바꾼 사본을 쓴다(합성 시험 `tmp-ch.sh` 방식).

## 권한

- `al_ingest`: `access_log_otel`에 `INSERT`만. 에이전트 수집기의 ClickHouse 내보내기가 쓴다. 계약 표는 materialized view가 쓴다.
- `al_admin_reader`: `access_log`의 `SELECT` 중 `is_admin = 1` 줄만(행 정책 `admin_rows_only`). ops-svc가 관리 계정 줄을 감사 저장소로 옮길 때 쓴다.
- `al_investigation`: `access_log`의 `SELECT`만. 적법한 영장을 확인한 수사 대응에만 쓴다(POL-025).
- `al_migrator`: `ALTER`·`DROP`·`CREATE TABLE`만. TTL·표 변경에만 쓰고 평소 읽기·쓰기에는 쓰지 않는다.
- 사본 버킷은 쓰기 역할(`access-log-export`)과 복원 역할(`access-log-restore`)을 나눈다.
