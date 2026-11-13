# 웨이브 보고서: 갈래 1 BAT-051

- 날짜: 2026-11-13
- 가지: `wave/lane1-BAT-051`(바탕 `origin/develop` `a5710f29`, 합치기·푸시 안 함)
- 배치: BAT-051(HOT-252, A, R-535)
- 웨이브 규칙: ADR-0267(배치마다 싼 게이트, 웨이브 끝에 비싼 게이트 한 번)

## 1. 커밋·rebase

| R | 커밋 | 내용 |
| --- | --- | --- |
| R-535 | `6f0e729f`(rebase 전 `9d39f68c`) | core-svc 내부 판매 설정 읽기, purchase-svc `CoreSaleConfigs`·`LayoutSeatMap` 덮기, `lst`·`entryGate`·`evaluateSalePolicy`, 홀드 Hash `lim`→`purchase_quota` |
| R-535 amend | 이 보고서를 포함한 최종 커밋 | heavy gate의 test-int, Q-T36 ③ 표본, 변이, 4관점 리뷰 수정(`core_ops` 읽기→`core_app`), 문서 |

- `origin/develop` `a5710f29`(R-536) 위로 rebase했다. 충돌 셋(`docs/00-summary.md`, `docs/review/consistency-review.md`, `services/purchase-svc/test/ticket-issue-adapters.test.ts`)은 R-535와 R-536을 모두 남기는 쪽으로 풀었다.

## 2. 게이트

| 게이트 | 결과 |
| --- | --- |
| core-svc 단위 | **260건 통과** |
| core-svc 실제 PostgreSQL test-int | **15파일 214건 통과, 1건 건너뜀** — 새 `internal-sale-config.int.test.ts` 3건 포함 |
| purchase-svc 단위 | **98파일 3,758건 통과** |
| purchase-svc 실제 PostgreSQL·Valkey test-int | **47파일 1,809건 통과, 2건 건너뜀** — 새 `sale-policy.int.test.ts` 9건 포함 |
| Q-T36 ③ 표본 | **100 동시 홀드: 성공 2·한도 초과 422 98·그 밖 0, p50 4.6ms·p99 5.3ms** |
| 변이 | **12개 넣어 12개 잡음, 놓침 0, 무효 0** |
| 4관점 리뷰 | 높음 0, 중간 5(1 고침·4 남김), 낮음 3 |
| typecheck | core-svc·purchase-svc 통과 |
| lint | 바뀐 `src` 통과(test·test-int는 eslint 설정 밖) |
| doc-check | 오류 0, 경고 4(기존 API 3·mermaid 건너뜀) |
| `ledger --batch BAT-051 --require` | 통과(자동 시험 2, ID만 0, 빈칸 0, 미검증 0) |
| `trace-check Q-T36 ③·v5.0.0-2.3.2` | 통과(시험 402개를 봄) |
| `records --check` | 통과(R-374·R-473 기존 경고만) |
| generated contracts | `check-generated` 통과 |
| api-client | **8파일 113건 통과** |
| 브라우저 확인 | **생략** — 이번 변경은 서버 내부 읽기·홀드 판정·DB 한도 경로뿐이고 화면 렌더링·상호작용이 바뀌지 않았다. 화면 변경은 LCH-080의 SCR-048·SCR-024 후속이다. |
| CI | GitHub Actions는 푸시 금지로 돌리지 않았다. 위 로컬 등가 게이트로 대신했다. |

## 3. test-int 조건

- PostgreSQL `postgres:18-alpine`, Valkey `valkey/valkey:8.1-alpine`, Docker 29.8.1, 무작위 포트. 각 파일의 `afterAll`이 컨테이너를 지우고, 웨이브 끝에 `docker ps`가 비었음을 확인했다.
- core-svc는 운영과 같은 `core_app`·`core_partner`·`core_ops` 로그인 사용자로 서비스를 띄우고, `core_ops`로 `event_sale_config`을 쓴 뒤 내부 HTTP가 `core_app` 읽기 역할로 답하는지 봤다.
- purchase-svc는 실제 HTTP 서버를 core-svc 대역으로 두고 `CoreSaleConfigs`의 200/404/5xx·캐시를, 실제 Valkey로 홀드 Lua `lim`·동시 홀드를, 실제 PostgreSQL로 `purchase_quota.limit_count`를 봤다.
- `LayoutSeatMap`은 임시 폴더의 실제 `{eventId}.json` 파일과 HTTP 사본을 함께 써서 덮어쓰기를 확인했다.

## 4. Q-T36 ③ 표본

- 조건: 회차 하나, 판매 정책 `lst`가 `lumen-fanclub-2026`을 가지면 1인 2매·없으면 `PRESALE_ONLY`, 같은 계정·같은 구매 세션, 서로 다른 좌석 100개, 100 요청 동시.
- 결과: 성공 2, `purchase-limit-exceeded` 422 98, 403 0, 409 0. p50 4.6ms, p99 5.3ms.
- 따로 잰 거부: `lst` 없는 요청 1건은 403 `sale-policy-denied`(`reason=PRESALE_ONLY`), 다른 계정 둘이 같은 좌석을 동시에 잡은 1쌍은 성공 1·409 `seat-already-held` 1.
- `purchase_quota`: 홀드 Hash `lim` 2를 `OrderHolds.limit`이 읽어 `reserve`의 `limit_count`가 2가 됐고(`used=2`), 같은 계정·회차의 다음 1석 예약은 `QUOTA_EXCEEDED`였다.
- 한계: 로컬 PC의 단일 노드 Valkey·단일 PostgreSQL 컨테이너, 100 동시 표본이다. 다중 샤드·네트워크 왕복·운영 규모의 부하 시험이 아니고, p99는 100개 표본의 끝값이라 신뢰구간이 넓다. 운영 SLO 판정은 별도 측정 창에서 한다.

## 5. 변이

| 변이 | 결과 |
| --- | --- |
| M01 직접 선택 홀드에서 `entryGate` 제거 | 잡힘 |
| M02 직접 선택 홀드에서 `evaluateSalePolicy` 제거 | 잡힘 |
| M03 규칙 한도 최솟값을 최댓값으로 바꿈 | 잡힘 |
| M04 홀드 Lua에 규칙 한도 대신 회차 한도를 넘김 | 잡힘 |
| M05 예약이 홀드 Hash `lim`을 무시하고 회차 한도를 씀 | 잡힘 |
| M06 입장 토큰 `lst` 상한을 10에서 100으로 늘림 | 잡힘 |
| M07 core-svc 5xx를 닫지 않고 사본 없음으로 숨김 | 잡힘 |
| M08 판매 설정 사본 캐시 TTL을 0으로 바꿈 | 잡힘 |
| M09 `LayoutSeatMap`이 core 사본을 덮지 않음 | 잡힘 |
| M10 등급 혼합 평가에서 첫 등급만 봄 | 잡힘 |
| M11 `purchase_quota.limit_count`를 요청 한도 대신 4로 씀 | 잡힘 |
| M12 `OrderHolds.limit`이 홀드 Hash `lim`을 읽지 않음 | 잡힘 |

- 잡힘 12, 놓침 0, 무효 0. 상세 실행 기록은 `.cache/bat051-mutations.md`(커밋하지 않음).

## 6. 4관점 리뷰

- **보안(높음 0)**
  - 중간: 내부 `GET /internal/v1/events/{eventId}/sale-config`는 호출자 인증이 없고 클러스터 NetworkPolicy에 기댄다. 게이트웨이 HTTPRoute에 없고 `public` 역할이지만, 운영 NetworkPolicy가 purchase-svc만 받게 좁혀져야 한다(wbs 0.4.4). 문서에 전제를 적었다.
  - 중간: 홀드의 `lst`는 게이트웨이가 서명을 확인해 넘긴 머리에서 읽고 구매 세션 상태에 묶지 않는다. 게이트웨이 신뢰 경계와 purchase-svc 앱 포트 격리가 전제다. `seat-hold.md` §2에 적었다.
  - 중간(고침): 내부 읽기 경로가 쓰기 역할 `core_ops`로 `event_sale_config`을 읽었다. `DrizzleSaleConfigReader`를 `core_app`(`DATABASE`)에 묶어 최소 권한으로 고쳤다.
- **정합(높음 0)**
  - 중간(남김): Redis 다시 만들기·옛 홀드는 `seat_hold` 원장에 `lim`이 없어 `purchase_quota`가 회차 설정 한도로 되돌아간다. `lim`을 원장·재구축에 싣는 일은 후속이다.
  - 낮음: `CoreSaleConfigs`는 `salePolicy`를 배열인지까지만 보고 규칙 뜻은 core-svc 저장 검사를 믿는다.
  - 낮음: 판매 설정 사본 5초 캐시로 정책 변경이 최대 5초 늦게 반영된다(의도한 절충).
- **시험(높음 0)**
  - 단위·test-int·변이가 정책 거부, 한도 최솟값, 등급 혼합, `lst`, 404/5xx, 캐시, `lim`→quota를 덮는다.
  - 낮음: Q-T36 ③ 표본은 100 동시·단일 Valkey라 운영 규모의 p99 근거가 아니다.
- **운영(높음 0)**
  - 중간(남김): `PEAKET_CORE_HTTP_URL`은 local·ci·demo 밖에서 필수인데, 저장소의 배포 단위 값(workloads)에는 purchase-svc 값 파일이 아직 없다. 배포 단계에서 넣고 core-svc NetworkPolicy를 확인해야 한다.

## 7. 남은 문제

- 좌석맵 **내용**은 여전히 `PEAKET_SEATMAP_DIR`의 `{eventId}.json`이다. core 사본의 `layoutVersion`으로 파일을 고르는 LCH-080의 출처 전환은 후속이다.
- `lim`이 `seat_hold` 원장·재구축에 없어 재난 복구 뒤 quota 한도가 회차 한도로 되돌아간다.
- `PEAKET_CORE_HTTP_URL` 배포 값과 core-svc 내부 경로 NetworkPolicy는 배포 단계 몫이다.
- 첫 전체 purchase-svc test-int에서 `payment-model.int.test.ts`의 V-T40 경합 시험이 한 번 실패(UNKNOWN 기대, APPROVED 1건)했고 같은 시험을 다시 돌리자 통과했다. 이 묶음의 변경과 무관한 기존 확률 시험의 흔들림으로 본다.
- core-svc test-int 1건·purchase-svc test-int 2건은 기존에 건너뛰는 시험이다.

## 8. 컨테이너 정리

- 웨이브 끝에 `docker ps`로 남은 컨테이너가 없음을 확인했다. 각 test-int의 `afterAll`이 `docker rm -f -v`를 부른다.
