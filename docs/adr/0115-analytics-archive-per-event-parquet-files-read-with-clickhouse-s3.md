# ADR-0115: 분석 아카이브는 Iceberg 표 대신 회차별 Parquet 파일로 S3에 두고, ClickHouse `s3()`로 읽는다 — ADR-0052 결정 2의 아카이브 부분 보완(2026-10-28)

- **상태**: 채택 (2026-10-28. 기술 검토(review/tech-review.md)의 중간-012 'S3 Iceberg 영구 아카이브는 고른 이유와 읽는 방법이 없다'에 소유자가 "나머지 건수들은 모두 추천안에 동의합니다. 그렇게 모두 수정해주세요."라고 정했다. 검토가 낸 세 안 가운데 (나) 동결 때 회차별 Parquet 파일을 쓰고 ClickHouse `s3()`로 읽기를 골랐다(추천 적용, 고른 이유는 결정 1). 방향은 소유자 결정(추천안 승인)이고, 경로·manifest·읽기 뷰·권한·경보·시험·일정 같은 세부는 추천 적용이다. 수치는 [가정]이다)
- **관련**: ADR-0042(결정 1의 3층 'S3 Iceberg 영구'), ADR-0052(결정 2), ADR-0077(결정 7 Iceberg 정리를 대신한다), ADR-0053(백업 버킷과 백업 보존), ADR-0086(골드 판 바꾸기 `gold.current_run`), ADR-0089(분석 저장소 시간 초과 행), ADR-0004(상태 줄의 집계 보관), NFR-026, POL-040, FR-068, [docs/features/analytics.md](../features/analytics.md) §2·§3.5·§4.2·§5.5·§6.4·§11·§13·§15, [docs/security/asvs/analytics.md](../security/asvs/analytics.md) 13.1.1·13.2.4, [docs/data.md](../data.md) §1·§6, [docs/infra.md](../infra.md) §1·§6, [docs/infra-handover.md](../infra-handover.md) §2·§3.2·§4.1·§6.1, [docs/observability.md](../observability.md) §1·§9·§13, [docs/devops.md](../devops.md) §7.5, [docs/architecture.md](../architecture.md) §5·§6.1, guide/15, wbs 4.3.6, [review/tech-review.md](../review/tech-review.md)(중간-012)

## 맥락

- **아카이브에 담는 것**: 동결한 회차의 골드(스타 스키마 집계)다. 사람 단위 행이 없고, 회차마다 사실 표 행이 수천~수만 줄이라 작다 [추정].
- **지금 설계**
  - Iceberg 표(파일 위에 표 형식을 얹는 공개 표 형식) + AWS Glue Data Catalog + Glue 표 최적화(작은 파일 합치기, 스냅샷 보존, 남은 파일 삭제)다(ADR-0077 결정 7).
  - 쓰기는 ClickHouse의 Iceberg 쓰기나 'Parquet로 내보낸 뒤 Iceberg에 등록'을 wbs 4.3.6 PoC에서 고르기로 했다.
  - 읽는 방법은 정하지 않았다. analytics §6.4는 '2년보다 오래된 회차와의 비교는 아카이브에서 한다'고만 적었다.
- **Iceberg가 잘하는 일**: 여러 엔진(Spark·Trino·Athena 등)이 같은 표를 함께 읽고 쓰기, 행 단위 고치기와 지우기, 스키마·파티션 바꾸기, 지난 시점 조회. 이 아카이브는 회차마다 한 번 쓰고 바꾸지 않으며, 읽는 엔진은 ClickHouse 하나다.
- **고른 이유가 없었다**: 이 선택은 원문에서 이어받았고, ADR-0042·0052는 Iceberg를 더 단순한 보관 방법과 비교하지 않았다(원문은 판단 근거가 아니다, ADR-0097).
- **확인한 사실**
  - ClickHouse 26.8의 Iceberg 쓰기(`allow_insert_into_iceberg`)는 Beta이고 기본 꺼짐이다(v26.8.9.10-lts 소스, 기술 검토 §9, 2026-10-27).
  - ClickHouse `s3` 표 함수(2026-10-28 문서): `INSERT INTO FUNCTION s3(…)`로 파일을 쓴다. 읽을 때 경로에 `*`·`**`·`{a,b}`·`{N..M}`를 쓸 수 있고, 행마다 `_path`·`_file` 가상 칸이 붙는다. 이미 있는 파일에는 쓰기가 실패한다(`s3_truncate_on_insert`·`s3_create_new_file_on_insert` 기본 꺼짐).
  - ClickHouse 26.8 소스(v26.8.9.10-lts `FormatFactorySettings.h`, 2026-10-28): Parquet를 읽을 때 파일에 없는 칸은 기본값으로 채운다(`input_format_parquet_allow_missing_columns` 기본 켬). Parquet 쓰기의 기본 압축은 zstd다.

## 결정

1. **아카이브는 회차별 Parquet 파일이다(검토 안 (나), 추천 적용).** Iceberg 표, Glue Data Catalog, Glue 표 최적화는 쓰지 않는다.
   - 고른 이유는 넷이다.
     - ① 회차마다 한 번 쓰고 바꾸지 않으며 ClickHouse 하나가 읽는다. Iceberg의 강점(여러 엔진의 함께 쓰기, 행 고치기, 지난 시점 조회)을 쓰지 않는다.
     - ② 카탈로그와 정리 운영(작은 파일 합치기, 스냅샷 보존, 남은 파일 삭제)이 없어진다.
     - ③ Beta 기능(Iceberg 쓰기)에 기대지 않는다.
     - ④ Parquet(열 단위로 저장하는 공개 파일 형식)라 나중에 다른 엔진(Athena·DuckDB·Spark)도 카탈로그 없이 읽는다.
   - 안 (가)(골드를 ClickHouse에 오래 두고 매일 백업으로 영구 보관을 대신하기)는 고르지 않는다. 살아 있는 DB의 행은 권한만으로 '바뀌지 않음'을 지켜야 한다. ClickHouse 백업에는 가명 사건·원시 IP가 든 표가 함께 들어 7일 [가정]만 둔다(ADR-0053). 골드만 따로 오래 두는 백업을 만들면 결국 이 결정의 파일과 같아진다.
2. **쓰기(추천 적용).**
   - 동결(analytics §4.2, R2와 R3 중 늦은 시점 + 7일) 때 마감 실행기가 회차의 현재 판(`gold.current_run`) 골드 행을 표마다 파일 하나로 쓴다. 문장은 `INSERT INTO FUNCTION s3(…, 'Parquet') SELECT …`다.
   - 경로는 `s3://peaket-analytics-archive-<환경>/gold/<표>/open_month=<YYYY-MM>/event_id=<회차>/run_id=<판>.parquet`이다.
   - 다 쓰면 ClickHouse의 작은 영구 표 `gold.archive_manifest`(회차, 표, 경로, 행 수, SHA-256, 골드 스키마 판, `run_id`, 동결 시각)에 넣고, 같은 내용을 `manifest.json`으로 회차 경로에 둔다. manifest가 있는 회차만 '아카이브됨'이다.
   - 다시 실행하면 이미 있는 파일은 다시 쓰지 않는다. 행 수와 SHA-256을 확인하고 같으면 건너뛴다. 다르면 SEV3(`kind` hygiene)다. S3는 다 올라간 객체만 보이므로 반쪽 파일은 남지 않는다.
   - 동결 + 7일 [가정] 안에 manifest가 없으면 SEV3(`kind` hygiene)다.
3. **읽기(추천 적용).**
   - 2년보다 오래된 회차와의 비교(같은 규모 기준선 `mtr_baseline_band`, analytics §6.4)와 연도 비교는 ClickHouse 뷰 `archive.<표>`로 읽는다. 뷰는 `s3()` 표 함수로 `gold/<표>/**/*.parquet`를 읽고, `_path`가 `gold.archive_manifest`에 있는 행만 낸다. 그래서 쓰다 멈춘 회차의 파일은 읽히지 않는다.
   - 같은 회차가 골드에 아직 있으면(동결 뒤 2년 안) 골드를 읽는다. 기준선은 '골드의 최근 2년 + 아카이브의 그보다 오래된 회차'를 합쳐 낸다.
   - 뷰는 정의자 권한(`SQL SECURITY DEFINER`)으로 만들어, 읽는 사용자(`an_ops_reader`·`an_grafana_reader`)에게 S3 원천 권한을 따로 주지 않는다 [확인 필요, wbs 4.3.6]. 읽기 사용자의 실행 시간·메모리 상한(analytics §11)은 그대로다.
   - 스키마는 칸 추가만 한다(devops §7.5). 옛 파일에 없는 칸은 읽을 때 기본값으로 채워진다(26.8 기본 설정). 칸 뜻을 바꿔야 하면 새 칸을 더하고 뷰에서 옛 칸과 맞춘다.
4. **보관과 복원(추천 적용).**
   - 아카이브 버킷은 버전 관리와 도쿄 교차 리전 복제를 켜고, SSE-KMS(분석 데이터 키)·퍼블릭 접근 차단·TLS만 허용한다.
   - 마감 실행기 역할은 이 버킷에 쓰기만 하고 지우기 권한이 없다. ClickHouse 서버 역할은 읽기만 한다.
   - ClickHouse를 잃으면 골드 2년치는 지금처럼 스냅샷 복원과 다시 계산으로 되살린다. 그보다 오래된 회차는 되살리지 않고 아카이브 파일을 그대로 읽는다. 골드로 되돌려 넣어야 하면 `INSERT INTO gold.<표> SELECT … FROM s3(…)`로 넣는다.
5. **바꿀 조건(Iceberg로 가는 조건, 추천 적용).** 아래 가운데 하나가 오면 Iceberg(또는 그때의 표 형식)를 다시 본다. 그때 ClickHouse의 Iceberg 쓰기가 Beta인지와 카탈로그(Glue·REST)를 다시 확인한다.
   1. ClickHouse 말고 다른 엔진(Athena·Spark·외부 분석 도구)이 같은 아카이브를 표로 읽어야 할 때.
   2. 아카이브 행을 고치거나 지워야 할 요구가 생길 때. 예를 들어 집계에 사람 단위 행을 넣게 되어 파기 요청에 따라 지워야 할 때다.
   3. 회차 파일이 많아져 경로 훑기 때문에 비교 조회가 10초 [가정]를 넘을 때. 먼저 조회를 연도별 경로로 좁히고, 그래도 넘으면 표 형식을 본다.
6. **시험(추천 적용).** A-T19: 로컬 S3(LocalStack)에서 회차 셋을 동결해 아카이브를 쓰고 읽는다.
   - ① 파일의 행 수와 SHA-256이 manifest와 같다.
   - ② 뷰로 읽은 값이 동결 전 골드 값과 같다.
   - ③ 같은 회차의 동결을 다시 돌려도 파일을 다시 쓰지 않는다.
   - ④ manifest에 없는 파일은 뷰에 나오지 않는다.
   - ⑤ 골드 표에 칸을 하나 더한 뒤 옛 파일을 읽으면 그 칸이 기본값이다.
7. **보안·데이터(추천 적용).**
   - 분석 기능의 외부 통신에서 Glue Data Catalog가 빠진다(asvs/analytics 13.1.1·13.2.4).
   - 골드와 아카이브에 사람 단위 행이 없다는 규칙(analytics §11, data.md §6)은 그대로다.
8. **문서와 일정(추천 적용).**
   - ADR-0077 결정 7(Iceberg 정리)은 이 결정으로 대신한다.
   - analytics §2·§3.5·§5.5·§6.4·§13·§15, data.md §1·§6, infra.md §1·§6, infra-handover §2·§3.2·§4.1·§6.1, observability §1·§9·§13, devops §7.5, architecture §5·§6.1, asvs/analytics, guide/15, planning/03 '분석 저장소'를 고친다.
   - WBS 4.3.6: Iceberg 쓰기 PoC와 Glue 정리 설계(0.5일)를 빼고, Parquet 쓰기·manifest·읽기 뷰·A-T19(0.25일)를 넣는다. 1.5일 → 1.25일 [가정].

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 | 다시 볼 조건 |
| --- | --- | --- | --- | --- |
| 나. 회차별 Parquet 파일 + `s3()` 읽기(이 결정) | 카탈로그와 정리 작업이 없다. 파일을 한 번 쓰고 바꾸지 않는다. 공개 형식이라 다른 엔진도 읽는다. Beta 기능에 기대지 않는다 | 파일 목록과 스키마 판을 manifest로 우리가 관리한다. 파일이 많아지면 경로 훑기가 느려진다 | 고른다 | 결정 5 |
| 가. 골드를 ClickHouse에 오래 두고 매일 백업 | 읽기가 가장 단순하다(그냥 골드) | 살아 있는 DB에서 '바뀌지 않음'은 권한으로만 지킨다. 백업에 가명 사건·원시 IP가 함께 들어 오래 둘 수 없다(ADR-0053). ClickHouse 보존과 용량이 계속 는다 | 쓰지 않는다 | 오래된 회차 비교가 잦아 `s3()` 읽기가 느릴 때(그때는 그 회차들을 골드에 다시 넣는다) |
| 다. Iceberg 표 + Glue(이전 설계, ADR-0042·0052·0077) | 여러 엔진이 같은 표를 읽고 쓴다. 지난 시점 조회와 스키마 바꾸기가 표 형식에 있다. 레이크하우스 설계를 보인다 | 카탈로그와 정리 작업을 운영한다. ClickHouse의 Iceberg 쓰기는 26.8에서 Beta다. 읽는 엔진이 하나뿐이라 강점을 쓰지 않는다 | 쓰지 않는다 | 결정 5 |
| 라. 동결 때 CSV·JSON 파일 | 사람이 바로 읽는다 | 자료형 정보가 없고 크다. 칸 추가에 약하다 | 쓰지 않는다 | 없다 |

## 결과와 트레이드오프

- Glue Data Catalog와 Glue 표 최적화가 빠지고, 분석 기능의 외부 통신은 S3·KMS·STS만 남는다.
- 아카이브를 읽는 길(뷰 `archive.<표>`)이 생겨 '2년보다 오래된 비교'가 실제로 돌아간다.
- 'Iceberg를 썼다'는 줄은 빠진다. Iceberg 정리 설계는 ADR-0077 결정 7과 git 이력에 남는다.

## 되돌릴 조건

- 결정 5의 조건이 오면 그때의 사실로 표 형식을 다시 비교한다.
- A-T19에서 뷰 값이 동결 전 골드와 다르면 아카이브 쓰기를 멈추고 쓰기·읽기 규칙을 같은 PR에서 고친다.

## 남는 한계

- manifest와 파일이 어긋나는 일(누가 파일을 지우거나 새 판으로 덮는 일)은 SHA-256 대조와 A-T19로 찾을 뿐 막지 못한다. 버전 관리로 옛 판은 되살릴 수 있다.
- 회차 파일이 많아질수록 `s3()`가 경로를 훑는 시간이 는다. 몇 개까지 괜찮은지는 재지 않았다 [추정].
- 아카이브는 칸 추가만 쉽다. 칸 뜻을 바꾸면 뷰에서 옛 판과 새 판을 맞춰야 한다.
