# 법정 접속기록 DB `access_log`

법정 접속기록(통신비밀보호법 시행령 §41②2호 준용, POL-025)을 담는 ClickHouse 전용 데이터베이스다. 업무 DB·분석 DB·조사 저장소 `inv`와 떨어진 곳에 둔다(docs/data.md §1, docs/observability.md §7).

## 파일

| 파일 | 무엇 |
| --- | --- |
| `001_access_log.sql` | 표 `access_log`(일 파티션, 3개월 TTL, 원문 IP bloom filter 색인) |
| `002_users.sql` | 사용자 넷과 권한(넣기만·관리 계정 줄만·수사 대응만·마이그레이션만) |

## 보존과 하루 사본

- 표 TTL은 3개월 이상이다. TTL을 줄이는 변경은 `node tools/ci/access-log-config.mjs`가 막는다.
- 매일 04:00 [가정] 전날 파티션을 Parquet 파일 하나로 접속기록 사본 버킷에 내보낸다. 파일의 행 수와 SHA-256이 일 해시 앵커다.
- 사본 버킷은 Object Lock 준수 모드이고, 보존은 그 날짜의 3개월 + 7일 [가정]이다. 보존 기간 안의 삭제는 버킷이 거부한다.
- 7일 백업 밖의 날짜는 하루 사본으로 되살린다(RB-38, V-T23). 다시 넣은 행 수와 SHA-256이 앵커와 같아야 한다.
- 다음 날 03:30에 전날 하루를 대조하고, 전날 사본 성공 표시가 06:00까지 없으면 SEV2다.

## 로컬로 적용하기

Docker ClickHouse에 표와 사용자를 만든다(비밀 값은 로컬 시험용으로 바꾼다).

```bash
docker run --rm -d --name peaket-ch-access -p 127.0.0.1:9000:9000 clickhouse/clickhouse-server:25.8
docker exec -i peaket-ch-access clickhouse-client --multiquery < data/clickhouse/access-log/001_access_log.sql
docker exec -i peaket-ch-access clickhouse-client --multiquery < data/clickhouse/access-log/002_users.sql
```

로컬 단일 노드에는 Keeper가 없어 `ReplicatedMergeTree`가 뜨지 않는다. 시험은 `ENGINE = MergeTree`로 바꾼 사본을 쓰거나 Keeper를 함께 띄운다.

## 권한

- `al_ingest`: `INSERT`만. 에이전트 수집기의 ClickHouse 내보내기가 쓴다.
- `al_admin_reader`: `SELECT` 중 `is_admin = 1` 줄만(행 정책 `admin_rows_only`). ops-svc가 관리 계정 줄을 감사 저장소로 옮길 때 쓴다.
- `al_investigation`: `SELECT`만. 적법한 영장을 확인한 수사 대응에만 쓴다(POL-025).
- `al_migrator`: `ALTER`·`DROP`·`CREATE TABLE`만. TTL·표 변경에만 쓰고 평소 읽기·쓰기에는 쓰지 않는다.
- 사본 버킷은 쓰기 역할(`access-log-export`)과 복원 역할(`access-log-restore`)을 나눈다.
