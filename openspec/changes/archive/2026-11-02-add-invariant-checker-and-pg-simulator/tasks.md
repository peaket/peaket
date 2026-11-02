# 작업: 불변식 검사기 SQL과 PG 시뮬레이터 어댑터(wbs 1.2.3)

## 0. 시작 전

- [x] 0.1 ASVS 추적 표 `docs/security/asvs/verification-tools.md`와 운영 확인 표(docs/verification.md §2.5)를 쓴다 — 확인: `python -I tools/doc-check/check_all.py`의 `asvs` 규칙 오류 0
- [x] 0.2 정본 보충: docs/data.md `statement_source`, docs/features/settlement.md §4.1·§10·§13, docs/verification.md §2.5(검사기·기록 형식·결과 파일·운영 확인), docs/features/payment.md §2.1(시뮬레이터 구성), docs/perf-ledger.md — 확인: 문서 점검 오류 0
- [x] 0.3 작업 공간에 `services/*`를 더하고 세 패키지 뼈대(package.json·tsconfig·vitest 설정)를 만든다 — 확인: `pnpm install`(새 외부 의존성 없음, 잠금 파일에는 세 작업 공간 항목만 늘어남)

## 1. PG 시뮬레이터(`services/pg-simulator`)

- [x] 1.1 실패하는 시험 쓰기: `test/simulator.test.ts`(시험 키·운영 거절, 승인 기한 10분, 주문 ID 재사용 금지, 멱등키 재생·처리 중 409·다른 본문 422·15일 보관, 같은 결제 동시 승인 400, 이미 승인 400, 금액 대조, 부분·전액 취소와 남은 금액, 장애 여섯 가지, 원장 내보내기, 웹훅 사건, 초기화, 기본 지연 분포(고정 시드 1만 회), KST 시각)
- [x] 1.2 실패 확인(모듈 없음)
- [x] 1.3 구현: `src/engine.ts`, `src/latency.ts`, `src/server.ts`, `src/config.ts`, `src/time.ts`, `src/main.ts`
- [x] 1.4 통과 확인: `npx vitest run` 31개, `npx tsc --noEmit`

## 2. 결제 포트와 시뮬레이터 어댑터(`services/payment-svc`)

- [x] 2.1 실패하는 시험 쓰기: 공통 계약 묶음 `test/pg-contract.ts`(payment §2.1 열 항목)와 `test/simulator-gateway.test.ts`(능력 플래그, 결제창 값, 멱등키 형식, 처리 중·한도 초과·결제사 오류·읽기 시간 초과·금액이 다른 이미 승인·구매자 이탈·키 틀림, 조회, 취소 결과, 웹훅 해석)
- [x] 2.2 실패 확인(모듈 없음)
- [x] 2.3 구현: `src/modules/payment/domain/payment-gateway.ts`, `src/modules/payment/adapters/pg/simulator-gateway.ts`
- [x] 2.4 통과 확인: `npx vitest run` 22개, `npx tsc --noEmit`, 층 규칙 `pnpm lint`

## 3. 불변식 검사기(`services/invariant-checker`)

- [x] 3.1 실패하는 시험 쓰기(단위): `test/records.test.ts`, `test/report.test.ts`(CSV·KST `as_of`·PASS/FAIL/SKIPPED·종료 코드·상세 1,000줄 상한·명령줄)
- [x] 3.2 실패하는 시험 쓰기(통합, 실제 PostgreSQL 18): `test-int/invariants.int.test.ts`(Q1·Q2·S1~S4·P1~P6·M1~M5 각각 지켜짐과 깨짐, J-T25 시험 데이터, 결과 모름, 원본·표·기록 없음 SKIPPED, 원본을 검사 DB로 써도 원본 그대로, 개인정보 칸을 읽지 않음)
- [x] 3.3 실패 확인(모듈 없음)
- [x] 3.4 구현: `sql/*.sql`(불변식 17편과 임시 표), `src/tables.ts`, `src/records.ts`, `src/invariants.ts`, `src/run.ts`, `src/report.ts`, `src/cli-args.ts`, `src/cli.ts`
- [x] 3.5 통과 확인: 단위 20개, 통합 24개, 빌드한 명령 `node dist/cli.js`를 임시 PostgreSQL로 한 번 돌림(위반 1건 → 종료 코드 1, 접속 실패 → 주소 없이 오류 코드만, 종료 코드 2)
- [x] 3.6 결함 고침(재현 시험부터): 위반 행 시각이 검사 연결의 시간대(UTC)로 찍힘 → 검사 연결을 KST로 고정. 같은 연결 객체를 검사와 원본으로 넘기면 원본 읽기가 빈 임시 표를 읽음 → 거절

## 4. 확인과 리뷰

- [x] 4.1 전체 회귀: `pnpm --filter @peaket/platform test`(373개), `pnpm exec turbo run test typecheck`(15개 패키지, 작업 28개), `pnpm lint`, `python -I tools/doc-check/check_all.py`(오류 0·경고 0), `pnpm exec openspec validate add-invariant-checker-and-pg-simulator`
- [x] 4.2 새 맥락 코드 리뷰 1차 결함 5건. 재현 시험부터 넷을 고쳤다: ① 같은 주문의 두 결제를 동시에 승인하면 둘 다 승인됨 → 기다린 뒤 다시 확인해 `DUPLICATED_ORDER_ID` ② 원본 세션의 DateStyle이 ISO가 아니면 날짜가 틀어짐 → 원본 트랜잭션에서 `SET LOCAL DateStyle = 'ISO, YMD'` ④ 금액을 생략한 전액 취소가 기다리는 사이 부분 취소가 들어오면 실패 → 기다린 뒤의 남은 금액 ⑤ `toString`·`__proto__` 종류가 줄 번호 없이 TypeError → `Object.hasOwn`. ③(가상계좌 재입금 때 P3·P4가 옛 사건을 봄)은 정본에 그 동작이 없어 BUILD_ORDER HOT-150으로 넘겼다
- [x] 4.3 새 맥락 리뷰 2차(고친 부분)
- [x] 4.4 대조와 보관

## Workflow follow-up

- 브라우저 확인: 해당 없음(화면이 없는 변경, browser-check.md)
