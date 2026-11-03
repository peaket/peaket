# ADR-0037: 최종 ORM 기술로 Drizzle 재선정 (조건식 타입 검증 지원 확인 및 미검증 성능 문구 배제)

- **상태**: 채택 (2026-10-09 수립. 임시 채택되었던 TypeORM(ADR-0035)을 대체하고 Drizzle 결정(ADR-0017)을 되살린다. ADR-0034의 확인 결과를 이어받고 이 ADR에서 확인한 사실을 더한다) 2026-10-22(ADR-0083): Drizzle 0.45.4 소스(`pg-core/table.ts`, drizzle-kit PostgreSQL 직렬화기)에는 파티션 선언이 없어, 파티션 표의 부모 표와 첫 파티션은 손으로 쓴 SQL 마이그레이션 파일로 만든다(docs/devops.md §7.2). 2026-10-22(ADR-0086): 핫패스 `.prepare()`는 PgBouncer 트랜잭션 풀링에서 `max_prepared_statements`가 0이 아니어야 동작하고, 열 구조를 바꾸는 마이그레이션 뒤에는 `RECONNECT`가 필요하다. Drizzle은 SQL 안의 값을 자리표시자로 바꾸므로, 부분 인덱스 조건 값은 `sql` 상수 조각으로 쓴다(docs/devops.md §7.2, docs/data.md §5.2).
- **관련 문서**: ADR-0017, ADR-0034, ADR-0035, docs/architecture.md §6.1·§8.3, docs/data.md §2·§4·§5, docs/features/seat-hold.md §6
- **관련 ID**: NFR-003, NFR-006, NFR-025, FR-010, FR-011, FR-047, K3

## 맥락
- 소유자가 TypeORM으로 바꾼 뒤(ADR-0035) 같은 날 Drizzle로 되돌리자고 제안했다(2026-10-09). 소유자가 든 근거는 런타임 오버헤드 0, 가벼움, SQL을 알면 직관적이라는 세 가지다.
- ADR-0035의 TypeORM은 QueryBuilder가 `where("user.name = :name")`처럼 조건식을 문자열로 받아 핫패스 컬럼명에 대한 TypeScript 정적 타입 검증을 제공하지 못한다는 단점이 있었다.
- 공식 문서와 소스로 확인한 Drizzle 사실(2026-10-09):

| 항목 | 확인한 사실 |
| --- | --- |
| 오버헤드 | 문서(Query performance)는 SQL 위의 얇은 TypeScript 층이라 오버헤드가 거의 0이고 prepared statement API로 실제 0으로 만들 수 있다고 설명한다. 자사 설명이다. 벤치마크 페이지의 'Drizzle vs TypeORM'은 '준비 중'이라 수치가 없다 |
| 크기 | 약 7.4kb(minified+gzipped), 의존성 0 |
| 쿼리 | SQL에 가까운 빌더이고, 조건은 컬럼 객체와 연산자(`eq(...)` 등)로 써서 컬럼 이름과 값 타입이 컴파일 때 검사된다. `sql` 템플릿 안의 `${값}`은 `$1` 자리표시자로 바뀌고, `sql.raw()`만 처리·이스케이프 없이 그대로 들어간다 |
| 잠금 | 소스(0.45.4)의 PostgreSQL select 빌더에 `for(strength, config)`가 있다. strength는 `'update'`·`'no key update'`·`'share'`·`'key share'`, config는 `skipLocked`·`noWait`·`of`다. 문서 사이트의 select 페이지에는 설명이 없고 소스 주석이 PostgreSQL 문서를 가리킨다. 생성 SQL은 `toSQL()`로 볼 수 있다 |
| 격리 수준 | `transaction(fn, { isolationLevel, accessMode })`로 `"read committed"`부터 `"serializable"`까지 지정한다 |
| 부분 인덱스 | 인덱스 정의의 `.where(sql…)`가 문서에 있다 |
| 버전 | 안정판은 0.45.4(2026-10-08)다. 1.0은 사전 배포 RC(v1.0.0-rc.4, 2026-06-27)다. 1.0 업그레이드는 `drizzle-kit up`으로 마이그레이션 폴더 구조를 바꾸고, Relational Queries를 썼다면 v2로 옮기는 것이다 |
| NestJS | `@nestjs/drizzle`(Nest 팀 관리) |

- ADR-0034·0035는 Drizzle의 잠금 절 API를 '문서에서 찾지 못했다'고 적었다. 문서 사이트 기준으로는 맞지만 소스에는 타입이 있는 API(`.for('update', { skipLocked: true })`)가 있었다. 그래서 ADR-0035가 TypeORM의 장점으로 든 '잠금 절을 공식 API로 씀'은 두 ORM의 차이가 아니며, 'Drizzle의 잠금 절 지원 부재'라는 전제는 해소되었다.

## 결정
1. 프로덕션 ORM으로 Drizzle을 최종 채택한다. 안정판(0.45 계열)으로 시작하고, 1.0이 정식으로 나오면 업그레이드 안내(`drizzle-kit up`)대로 옮긴다. 업그레이드 부담을 줄이려고 1.0 정식 전에는 Relational Queries를 쓰지 않고 SQL형 빌더만 쓴다.
2. 채택 근거는 다음 세 가지로 적는다.
   - **SQL 지향성과 정적 타입 검증의 결합**: SQL처럼 쓰면서 조건의 컬럼과 값 타입까지 컴파일 때 검사된다. 소유자가 말한 'SQL을 알면 직관적'을 정확히 쓰면 이것이다. TypeORM도 QueryBuilder가 SQL 순서를 따르지만 조건이 문자열이라 검사되지 않는다(ADR-0035).
   - **핫패스 핵심 기능의 API 충족**: 부분 인덱스(`.where(sql...)`), 잠금 절(`FOR UPDATE SKIP LOCKED`), 격리 수준을 모두 타입이 있는 API로 쓴다.
   - **SQL 인젝션 통로 축소**: `sql` 템플릿의 값이 자동으로 `$1, $2` 자리표시자로 파라미터화되어 취약점 통로가 `sql.raw()` 하나로 좁다.
3. 소유자가 든 '런타임 오버헤드 0'과 '가벼움'은 결정 근거로 쓰지 않는다.
   - 오버헤드 0은 자사 설명이고, prepared statement를 써도 결과 행을 객체로 바꾸는 일은 남는다. TypeORM과 비교한 수치는 Drizzle 벤치마크에도 없다.
   - 크기는 서버리스·엣지의 콜드 스타트에서 의미가 크다. PEAKET 서비스는 EKS에서 상시 가동되는 Node 파드라 효과가 작고, 실제 쿼리 실행 지연과 네트워크 I/O가 지배적이다.
   - 대신 핫패스에서 자주 실행되는 쿼리는 prepared statement(`.prepare()`)로 두고, Phase 2 After 측정(wbs 2.12.1)의 트레이스에 ORM 구간 시간을 기록해 효과를 잰다.
4. 쿼리 작성 규칙
   - 핫패스(좌석 확정, 1인 한도 조건부 갱신, 취소표 반환, 로컬·v0의 Outbox 폴링 릴레이)는 SQL형 빌더로 쓴다. 잠금은 `.for('update', { skipLocked: true })`처럼 쓰고, 여러 좌석은 좌석 ID 순서로 잠근다(K3).
   - 잠금 API는 문서 사이트에 설명이 없으므로, 잠금을 쓰는 쿼리마다 생성 SQL을 `toSQL()`로 테스트에서 확인한다.
5. SQL 인젝션 규칙(ASVS v5.0.0-1.2.4)
   - 값은 빌더나 `sql` 템플릿으로만 넘긴다.
   - `sql.raw()`는 허용 목록에서 고른 식별자와 정렬 열에만 쓴다(ASVS V1.2의 주석: 컬럼 이름·정렬 열은 바인딩할 수 없다). 그 밖의 `sql.raw()`는 Semgrep 사용자 규칙으로 CI에서 차단한다.
6. 스키마와 마이그레이션
   - `drizzle-kit generate`로 SQL 마이그레이션 파일을 만들고 리뷰해 커밋한다. 스키마 원본은 마이그레이션 파일이다(ADR-0017의 결과 그대로).
   - 로컬 시제품을 넘는 환경에서는 `drizzle-kit push`를 쓰지 않고 마이그레이션 파일로만 스키마를 바꾼다.
   - `seat_sale`의 활성 상태 부분 유니크 인덱스(docs/data.md §2)는 `.where(sql…)`로 정의한다.

## 검토한 대안
| 대안 | 기각 사유 및 한계점 |
| --- | --- |
| TypeORM 유지(ADR-0035) | 1.x 안정판이고 잠금 API가 문서에 있다. 하지만 핫패스 조건이 문자열이라 타입 검사를 받지 못하고, 인젝션 방지를 작성 규칙과 정적 검사에 더 많이 기대야 한다. 잠금 API는 Drizzle 소스에도 있어 차이가 아니다. |
| Prisma 채택 | 소유자가 성능 우려로 제외했다(ADR-0035). 기본 쿼리 API가 SQL 형태가 아니고 부분 유니크 인덱스가 Preview다. |

## 결과와 트레이드오프
- 얻는 것: 핫패스 SQL을 타입 검사 안에서 쓰고, 인젝션 통로가 `sql.raw()` 하나로 좁아진다. 원문(ADR-0017)·부록·data.md의 Drizzle 기술과 다시 맞는다.
- 잃는 것
  - 1.0 정식 전이라 업그레이드 작업(마이그레이션 폴더 구조 재정렬)이 한 번 남는다.
  - 잠금 API가 문서 사이트에 없어 생성 SQL을 테스트로 확인해야 한다.
- 되돌릴 조건
  - 2.12.1 측정에서 ORM 구간이 결제 확정 예산 중 PG 밖 1초(NFR-006, payment §2)에서 의미 있는 비율을 차지하면, 핫패스만 드라이버 직접 호출로 바꾸는 것을 검토한다.
  - 1.0 정식이 늦어지고 0.x 계열의 깨지는 변경이 템플릿 유지 비용을 키우면 TypeORM(ADR-0035)을 다시 본다.
