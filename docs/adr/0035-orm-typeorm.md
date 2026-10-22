# ADR-0035: NestJS 환경을 고려한 TypeORM 일시 채택 결정 (추후 ADR-0037로 대체됨)

- **상태**: 대체됨 (2026-10-09 채택, 같은 날 ADR-0037이 Drizzle로 되돌림). ADR-0017(Drizzle 채택)과 ADR-0034(Drizzle 근거 보강)를 대체했었다.
- **관련 문서**: ADR-0017, ADR-0034, ADR-0037, docs/architecture.md §6.1·§8.3, docs/data.md §2·§4·§5, docs/features/seat-hold.md §6
- **관련 ID**: NFR-003, NFR-006, NFR-025, FR-010, FR-011, FR-047, K3

## 맥락
- ADR-0034는 소유자가 답한 두 근거(성능, SQL과 비슷한 쿼리)를 공식 문서로 확인해 Drizzle을 유지했다. 성능은 공식 비교 수치가 없어 측정할 가설로 바꿨다.
- 소유자 결정(2026-10-09): TypeORM으로 바꾼다. Prisma는 성능이 걱정되어 고르지 않는다.
- 공식 문서와 소스로 확인한 TypeORM 사실(2026-10-09):

| 항목 | 확인한 사실 |
| --- | --- |
| 유지보수 | 1.0.0이 2026-05-19에 나왔고 최신은 1.1.2(2026-10-08)다. 0.3 계열도 0.3.31(2026-07-13)까지 나왔다. MIT 라이선스, Node 20.19·22.13·24.11 이상 |
| 쿼리 작성 | QueryBuilder는 `select`·`from`·`where`·`orderBy`를 SQL 순서대로 쓰고, 조건은 `"user.name = :name"`처럼 SQL 조각과 이름 붙은 파라미터로 쓴다. 리포지토리의 find 옵션은 조건을 객체로 받고, 그 타입(`FindOptionsWhere<Entity>`)이 엔티티 속성 이름으로 만들어져 컴파일 때 검사된다 |
| 잠금 | `setLock("pessimistic_write")`가 PostgreSQL에서 `FOR UPDATE`가 되고, `setOnLocked("skip_locked")`·`setOnLocked("nowait")`를 지원한다. `findOne`에도 `lock` 옵션이 있다 |
| 격리 수준 | `transaction("SERIALIZABLE", …)`처럼 첫 인자로 지정하고, 드라이버가 지원하지 않는 수준이면 오류를 낸다 |
| 부분 인덱스 | `@Index`의 `where` 옵션이 소스의 `IndexOptions`에 'Index filter condition'으로 있다. 인덱스 문서에는 설명이 없고, 문서는 지원하지 않는 인덱스 정의를 마이그레이션에 직접 쓰고 `synchronize: false`로 두라고 안내한다 |
| 마이그레이션 | 엔티티와 DB 스키마를 비교해 마이그레이션 파일을 만든다. 데이터가 있는 운영 DB에서 `synchronize: true`는 안전하지 않다고 문서가 적는다 |
| NestJS | `@nestjs/typeorm`(Nest 팀 관리)으로 리포지토리를 주입하고, Nest 문서는 트랜잭션에 QueryRunner를 권한다. Drizzle도 `@nestjs/drizzle`(Nest 팀 관리)이 있어 통합 수준은 두 ORM의 차이가 아니다 |

- 세 ORM의 처리 성능을 비교한 공식 수치는 여전히 없다(ADR-0034).

## 결정
1. 백엔드 데이터베이스 계층에 TypeORM 1.x를 채택한다. 엔티티와 리포지토리(`@nestjs/typeorm` 주입)로 쓰고, 여러 행·테이블에 걸친 쓰기는 `DataSource.transaction()`이나 `QueryRunner`로 트랜잭션을 연다. Prisma는 소유자 판단으로 제외한다.
2. 쿼리 작성 계층을 이원화한다.
   - 단순 조회·저장은 리포지토리 메서드와 find 옵션(`FindOptionsWhere<Entity>`)으로 쓴다. 조건의 컬럼 이름과 값 타입이 컴파일 때 검사된다.
   - 핫패스(좌석 확정, 1인 한도 조건부 갱신, 취소표 반환, 로컬·v0의 Outbox 폴링 릴레이)는 `QueryBuilder`로 쓴다. 잠금은 `setLock`·`setOnLocked` API로 쓰고(ADR-0034의 `sql` 템플릿 우회가 필요 없다), 여러 좌석은 교착 상태 방지를 위해 좌석 ID 순서로 잠근다(K3).
3. SQL 인젝션 규칙(ASVS v5.0.0-1.2.4)
   - QueryBuilder 조건 문자열과 원시 SQL(`query()`)에는 값을 넣지 않고 이름 붙은 파라미터(`:name`)나 자리표시자(`$1`)로만 넘긴다.
   - 정렬 열과 컬럼 이름은 바인딩할 수 없으므로(ASVS V1.2의 주석) 허용 목록에서만 고른다.
   - 템플릿 문자열이나 문자열 연결로 만든 조건은 Semgrep 사용자 규칙으로 CI에서 차단한다.
4. 스키마와 마이그레이션
   - 로컬을 포함한 모든 환경에서 `synchronize`를 끄고 마이그레이션 파일로만 스키마를 바꾼다. 스키마 원본은 마이그레이션 파일이다(ADR-0017의 결과 그대로).
   - 마이그레이션은 생성 기능으로 초안을 만들고 SQL을 리뷰해 커밋한다.
   - `seat_sale`의 활성 상태 부분 유니크 인덱스(docs/data.md §2)는 `@Index`의 `where`로 정의하고, 생성된 SQL을 서비스 템플릿 작업(wbs 0.3.2)에서 확인한다. 의도와 다르면 문서가 안내하는 대로 마이그레이션에 SQL로 직접 쓰고 엔티티의 인덱스는 `synchronize: false`로 둔다.
5. 성능은 결정 근거로 쓰지 않고 측정한다(ADR-0034와 같음). Phase 2 After 측정(wbs 2.12.1)의 트레이스에 ORM 구간 시간을 기록한다.

## 검토한 대안
| 대안 | 기각 사유 및 한계점 |
| --- | --- |
| Drizzle 유지(ADR-0034) | 조건까지 스키마 타입으로 검사하고 부분 인덱스가 문서화되어 있지만, 당시 잠금 절 API를 문서 사이트에서 찾지 못해 `sql` 템플릿으로 우회해야 했다. 소유자가 TypeORM을 골랐다. |
| Prisma 채택 | 소유자가 성능 우려로 제외했다. 기본 쿼리 API가 SQL 형태가 아니고 부분 인덱스가 Preview다(2026-10-09 문서). |

## 결과와 트레이드오프
- 얻는 것: 잠금 절과 격리 수준을 공식 API로 쓴다. `@nestjs/typeorm`의 리포지토리 주입을 쓴다. 소유자가 말한 '쿼리가 SQL과 비슷해 읽기 쉬움'은 QueryBuilder가 SQL 순서를 따르므로 그대로 유지된다.
- 잃는 것
  - QueryBuilder 조건 문자열(`where("user.name = :name")`)과 원시 SQL은 컴파일 때 검사되지 않는다. ADR-0034가 근거로 든 '조건까지 타입 검사'는 find 옵션에만 남는다. 핫패스 쿼리는 실제 PostgreSQL에 붙는 통합 테스트로 덮는다. (이 문제는 같은 날 작성된 ADR-0037에서 Drizzle 소스의 잠금 API가 확인되면서 Drizzle 재선정으로 해소된다.)
  - 부분 인덱스는 인덱스 문서에 설명이 없어 생성 결과를 직접 확인해야 한다.
- 되돌릴 조건
  - 2.12.1 측정에서 ORM 구간이 결제 확정 예산 중 PG 밖 1초(NFR-006, payment §2)에서 의미 있는 비율을 차지하면, 핫패스만 QueryRunner의 원시 SQL(자리표시자 바인딩)로 바꾸는 것을 검토한다.
  - 문자열 조건 때문에 생긴 결함이 통합 테스트를 빠져나가 배포되면 쿼리 작성 규칙(결정 2·3)을 다시 본다.
