# 웨이브 6 — 독립 감사와 수정

## 1. 목적과 범위

웨이브 6은 새 기능을 더하기 전에 `v0.2.0`(`6bcea3c7`, 2026-11-04)부터 `develop`(`fabbabac`, R-594, 2026-11-15)까지의 모든 작업을 구현에 참여하지 않은 에이전트로 다시 검토하는 웨이브다. 감사 대상 커밋·배치·R 번호는 `coverage.md`에, 발견은 `findings.md`에, 영역별 상세는 `reports/`에 있다.

## 2. 방법

- **영역 감사 7개**: A1 payment 정산·지급, A2 core export·webhook·카탈로그, B1 purchase, B2 queue, B3 ops, C1 ticket·scanner, C2 identity.
- **관점 감사 4개**: CONS(정합성), OPS(운영·관측성), SEC(보안), TEST(시험·증거).
- **변이 감사 5개**: M1 payment, M2 purchase, M3 queue, M4 ops, M5 scanner·identity. 정해진 변이를 넣고 시험이 잡는지 확인했다.
- **커버리지 감사 2개**: COV(영역·R 번호 누락), COV2(7개 영역 밖 구현 배치 8개).
- **독립성**: 감사자·수정자·시험 작성자·검증자를 분리했다. 수정자는 새 회귀 시험을 쓰지 않고, 별도 시험 작성자가 finding과 정본만 보고 시험을 쓴다. 검증자는 수정 diff와 변이를 다시 본다.
- **환경**: Docker·kind 측정은 한 번에 한 레인만 돌렸다. 소유자 미추적 파일(`miro_*`, `docs/superpowers/`, `tools/reader/`)은 건드리지 않았다.

## 3. 결과 요약

| 항목 | 수 |
| --- | ---: |
| 감사 대상 `BUILD_ORDER` 배치 | 67 |
| 구현·부분·잔여·측정·대체ID 배치 | 55 |
| 영역 감사가 덮은 배치 | 47 |
| COV2가 덮은 영역 밖 배치 | 8 |
| 감사 대상 아님·보류·미착수 | 12 |
| 고유 발견(표 기준) | 높음 23 · 중간 61 · 낮음 20여 |
| 수정 R | R-595..R-620 |

- 구현된 55개 배치는 모두 최소 하나의 독립 감사에 매핑됐다.
- 높은 결함은 배포 전에 모두 고치는 것을 원칙으로 했다. 중간·낮은 결함은 웨이브 안에서 고치거나 `findings.md`·`PROGRESS.md`에 막힘을 남겼다.
- 변이 감사에서 살아남은 결함은 별도 시험 작성자가 회귀 시험을 채우고, 검증자가 다시 변이를 넣어 확인한다.

## 4. 수정 목록

| R | 범위 | 커밋 | 상태 |
| --- | --- | --- | --- |
| R-595 | queue B2-1·B2-2 (`q:rst` TTL, 우선 입장 `lst`) | `c868de7e` | 병합 |
| R-596 | scanner·platform·identity·ticket M5 시험 공백 | `7460f556` | 병합 |
| R-597 | ops M4 8건·OPS-01/03/04/07·SEC-02 | `1ae63462` | 병합 |
| R-598 | purchase M2 시험 공백 | `4596b246` | 병합 |
| R-599 | payment CONS-01·CONS-02 | `e24ee8f8` | 병합 |
| R-600 | identity C2-01·C2-05 | `4768ff76` | 병합 |
| R-601 | platform·identity C2-02/03·CONS-07·OPS-05 | `b0b6298c` | 병합 |
| R-602 | core·deploy OPS-02/06/08 | `acfbbe85` | 병합 |
| R-604 | purchase B1 7건·자동 정지·USED 전이 | `f79a5855` | 병합 |
| R-605 | payment A2-01/05/06·M1-F1/F2/F3 | `4a2fd11b` | 병합 |
| R-606 | core A1-H4/A2-10·A2-03/17/19·SEC-06/07·TEST-06·COV2-02 | `24c6504d` | 병합 |
| R-607 | payment M1-F1·F2·F3·CONS-V02/03 | `b52e9e5f` | 병합 |
| R-608 | gRPC 내부 인증·SEC-01/03/08·COV2-01 | `779ca80d`·`684e3ed3` | 병합(재검증 중) |
| R-609 | scanner C1-01/02/11/13 | `8436d9db` | 병합 |
| R-610 | scanner·ticket C1-03..10/12·M5-07 | `992740e5` | 병합 |
| R-612 | ledger `--require` 강화 | `8620caa2` | 병합 |
| R-613 | payment A1-H2/H3/H7/H8/H10·CONS-V01/02 | `0ab87d48` | R-620과 함께 병합 |
| R-614 | ops B3-H01/H03·OPSV-01/02/04 | `3d98dbe5` | 병합 |
| R-615 | queue B2V-01/02/03 | `78d5decf` | 병합 |
| R-617 | core COV2-03/04/06·OPSV-03/05 | `93e95ebd` | 병합 |
| R-618 | web COV2-05 처리방침 초안 | `2136846d`·`684e3ed3` | 병합(재검증 중) |
| R-619 | identity C2V-01/02/05/06 | `2157f0f6`·`684e3ed3` | 병합(재검증 중) |
| R-620 | payment A1V-01/02/03/04/09/12 | `58b0034b`·`463dde28`·`51a90d62` | 병합(잔여 위험 문서화) |
| R-621 | queue B2V 회귀 시험 | `6f203fd3` | 병합 |
| R-622 | scanner M5·C1 회귀 시험 | `b31786ea` | 병합 |
| R-623 | ops M4·OPS·B3 회귀 시험 | `bd2569ed`·`d4ca8421` | 병합 |
| R-624 | purchase M2 회귀 시험 | `b2aa3ac7`·`d3f96882` | 병합 |
| R-625 | core A2·OPS 회귀 시험 | `9b920a04`·`869336c3` | 병합 |
| R-626 | identity C2·CONS 회귀 시험 | `c74a436c` | 병합 |
| R-627 | payment A1V 회귀 시험 | `97fbfd56`·`0f42082b`·`87798c80` | 병합 |
| R-628 | core SEC-06 fail-closed | `89ce5357` | 병합(검증 중) |
| R-629 | core·payment SEC-07 fake 가드 정본 env | `c94dac55` | 병합(검증 중) |
| R-632 | CI 계약·마이그레이션·SIGTERM 시험 정합 | `e925bd78` | 병합 |
| R-633 | trust-svc prod 기동 시험 내부 gRPC 토큰 | `aa35da01` | 병합 |

## 5. 독립 검증

| 검증 | 대상 | 결과 | 후속 |
| --- | --- | --- | --- |
| B2V | R-595 | TTL 시험이 값이 아니라 `PTTL > 0`만 봄 | R-621 |
| OPSV | R-597 | 감사 append가 별도 트랜잭션, 포트원 실행 감사 없음 | R-614 |
| CONSV | R-599 | 핵심 수정 통과, Drizzle 충돌 시험 공백 | R-613·R-620·payment 시험 |
| C2V | R-600 | 탈퇴 통과, 병합·부분 유일 인덱스 시험 공백 | R-619·R-626 |
| M5V | R-596 | 9개 변이 중 8개 잡힘, M5-07 생존 | R-610 |
| A1V | R-605/607/613 | **A1V-01/02/03 높음** 포함 15건 | R-620 |
| COV2 | 영역 밖 8개 배치 | **COV2-01 높음** 포함 11건 | R-608·R-617·R-618·R-606 |

### 5.1 회귀 시험 검증

| 검증 | 대상 | 결과 |
| --- | --- | --- |
| B2TA | R-621 queue | 통과 — 수정 전 7개 소스 원복에서 단위 5·test-int 4 실패, 변이 5개 중 4개 사망, 정렬 변이 1개 생존(공백 기록) |
| R622V | R-622 scanner | 조건부 통과 — 변이 7개 전부 사망, 일부 시험은 회귀 고정(수정 전에도 통과) |
| R623V | R-623 ops | 조건부 통과 — 변이 10개 중 9개 사망, DB `record_json` 변이는 R-614 test-int가 덮음. 역할 정본 불일치는 남은 위험 12 |
| R625V | R-625 core | 조건부 불합격 → 보강 — SEC-07 거짓 통과는 R-629가, A2-03/OPS-08 시험은 `869336c3`이 보강. A2-17/A2-19는 재현 시험을 `test/audit-core-gaps`에 보존 |
| R626V | R-626 identity | 조건부 통과 — 변이 6개 사망, `refreshUsed` M4b 변이 1개 생존(prevHash 삭제로 history 판정) |
| R627V | R-627 payment | 조건부 불합격 → 해소 — core 토큰 403 기대가 R-628 401 계약과 어긋남, `87798c80`이 401로 수정·병합 |
| R628V | R-628 core SEC-06 | 조건부 합격 — prod/staging 무토큰 시작 차단·401·timingSafeEqual 동작 확인, `onModuleInit`·상수시간 비교 회귀 시험은 공백 |
| A1V2·A1V3 | R-620 payment | 부분 통과 — A1V-01/03/04/08/12 통과, A1V-02 잔여 위험(공휴일·UTC/KST), A1V-07 force tick 대사 전 계산 위험, A1V-09 env 배선 수정 |
| L1V·L1V2 | R-608/618/619 | L1V 부분 통과 → `684e3ed3`로 jti fail-closed·core/ops 시작 차단·noindex·정비 재시도·계정 상태 fail-closed 수정, **L1V2 통과**(변이 5개 모두 사망, 실제 prod 시작·Postgres 확인) |

## 6. 남은 위험

1. **COV2-06 배선**: core에 후기 익명화 내부 경로는 생겼지만 identity 탈퇴·병합이 그 경로를 호출하지 않는다. core가 `identity.accounts-withdrawn`을 소비하는 후속이 필요하다. **→ 2026-11-16 웨이브 7 갈래 3 W7-audit에서 고침**: core-svc가 그 사건을 `peaket.core-svc.<환경>` 그룹으로 받아 계정·주문 참조를 끊고(pid는 남기지 않음), 운영 역할 `core_app`의 후기·보류 표 권한 결함을 core 0022로 고쳤다. 남은 결정: 파기 vs 익명화 OPEN[42], 탈퇴 직후 15분 창 OPEN[44]([W7-lane3-wave.md](../measurements/W7-lane3-wave.md)).
2. **A1V-11 메모리 저장소**: 운영은 Drizzle 트랜잭션이지만 단위 시험은 메모리 저장소라 상계 원자성을 검증하지 못한다. test-int가 덮는다.
3. **B2V-03 무기한 제한 TTL**: ops 작업 워커가 아직 없어 현재는 드러나지 않는다. R-615가 같은 판 재전송으로 30일 TTL을 다시 세우는 동작을 넣었고 R-621 시험이 고정했다. 워커를 붙일 때 이 계약을 지켜야 한다.
4. **OPSV-05 identity JWKS**: `PEAKET_IDENTITY_JWKS_URL`이 없으면 재인증이 503이다. 배포 환경에서 필수 값으로 고정해야 한다.
5. **K7 공식 목표**: `BAT-033`의 K7 공식 목표는 여전히 known gap이다. 감사는 코드·시험을 대상으로 했고 목표 수치를 재측정하지 않았다.
6. **BAT-052·BAT-197**: realtime-gw 보류와 trust 표시·라벨 미착수는 이번 웨이브의 구현 대상이 아니다.
7. **운영 배포 형상**: trust-svc가 아직 `deploy/workloads`에 없어 COV2-01의 실제 노출 범위는 제한적이다. 배포 전 mTLS·L7 허용 목록이 필요하다.
8. **A2-17 paging 잔여(확인됨)**: `DrizzleMerchOrderStore.listAttendees`의 `limit*10`·`slice`, `HttpAttendeeSource`의 `nextCursor` 폐기, `page.length < 1000` 정지 조건 때문에 짧은 페이지에서 명단이 조용히 잘린다. R-625 보강 시험이 999/2,000건 절단을 재현했고 `test/audit-core-gaps` 가지에 남겼다. Wave 7에서 `AttendeeSource` 페이지 포트·`nextCursor` 전달·정확한 커서를 고친다. **→ 2026-11-16 웨이브 7 갈래 3 W7-audit에서 고침**: 원천 포트를 `{items, nextCursor}` 페이지로 바꾸고 `nextCursor`가 null일 때만 끝으로 본다. 같은 커서 되풀이·빈 커서는 503 `dependency-unavailable`.
9. **A2-19 조회 감사(확인됨)**: `attendee_export` insert와 접속기록 audit가 별도 트랜잭션이고, 명단 **조회**는 접속기록을 남기지 않는다. 조회 감사 포트·행위자 전달·`LIST` 형식·fail-closed가 필요하다. 재현 시험은 `test/audit-core-gaps`에 있다. **→ 2026-11-16 웨이브 7 갈래 3 W7-audit에서 고침**: 명단 보기 접속기록(`action LIST`, 행위자 없거나 기록 실패면 명단을 주지 않음), 내려받기 이력·접속기록 한 트랜잭션, 접속지 `source_ip`(core 0021). 저장소·해시 체인·FR-064 점검은 OPEN[43].
10. **SEC-07 process.env**: R-629가 `prod`·`staging`·`NODE_ENV=production` fake 가드를 정본화했고 `NotifyModule`에 env 주입구를 열었다. 다만 `NotifyModule`의 `PEAKET_INTERNAL_TOKEN` 직접 읽기와 `main.ts`의 env 주입은 후속이다.
11. **C2-06..C2-11·COV2-07..11·CONS-03..06**: 낮음·중간 잔여는 `findings.md`에 후속으로 남겼다.
12. **BOT_LEVEL·DEGRADED_MODE 승인 요건 문서 차이**: `docs/features/control-tower.md` §3 표는 "commander 요청 + 요청자 아닌 operator 이상 1인 승인"인데, R-614 코드는 요청·승인 모두 commander로 강제한다(감사 B3-H01의 보안 판단). 코드가 더 엄격해 급한 보안 위험은 없지만 운영자가 승인할 수 없어 정본 결정이 필요하다. Wave 7에서 소유자 결정을 받아 문서·코드 중 하나로 맞춘다.
13. **R-628 회귀 시험 공백**: `InternalToken401Guard`의 `onModuleInit` 시작 차단과 `timingSafeEqual` 비교를 고정하는 시험이 없다. R628V는 임시 탐침으로 동작을 확인했고, Wave 7에서 최소 모듈 부트·상수시간 비교 시험을 더한다. **→ 2026-11-16 웨이브 7 갈래 3 W7-audit에서 고침**: SEC-06R ①~⑤ 시험(운영 무토큰 시작 차단·상수시간 비교), 검증 담당의 틀린 구현으로 실패를 봤다.

## 7. 웨이브 6 종료 조건

- [x] 높은 결함 전부 수정·검증(A1V-01/02/03, COV2-01 포함)
- [x] 독립 시험 작성자가 쓴 회귀 시험 병합(R-621..R-627)
- [x] 수정별 독립 검증자 재확인
- [x] 전체 CI(web 포함) 통과 — 43688939738
- [x] `coverage.md`·`findings.md`·`wave6.md`·`PROGRESS.md`·`BUILD_ORDER.md` 기록
- [x] Wave 7 착수 전 `develop` 푸시
