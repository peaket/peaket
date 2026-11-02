# 제안: 불변식 검사기 SQL과 PG 시뮬레이터 어댑터(wbs 1.2.3, BUILD_ORDER BSL-010)

## Why

v0(wbs 1.1)와 v1의 시험은 끝난 뒤 '깨지면 안 되는 약속'을 같은 SQL로 센다(docs/verification.md §2.5, ADR-0057 결정 4). 결제가 있는 시험은 모두 결제사 대역인 PG 시뮬레이터로 돈다(ADR-0029 결정 6). v0 결제·발권(wbs 1.1.3)이 이 둘에 기대므로 v0보다 먼저 만든다(wbs §1 '실행 방식', 1.1.3의 선행 1.2.3).

- 불변식 검사기: 차례 전 입장, 같은 세대 순번 중복, 오버셀, 1인 한도 초과, 이중 결제, 결제-발권 불일치(승인 뒤 60초 안 발권도 큐 등록도 없음, 발권 기한 초과, ADR-0106)와 정산 돈 불변식 다섯(docs/features/settlement.md §13 J-T25, ADR-0129 중간-043)을 시험 기록과 서비스 DB에서 센다. 결과를 모르는 요청은 성공과 실패 둘 다 가능했던 것으로 본다(Jepsen 방식).
- PG 시뮬레이터: 결제사 흉내 서버(메모리에 상태를 두는 빠른 대역)와, payment-svc가 그 서버를 부르는 결제 포트 어댑터. 기본 승인 지연은 로그정규 분포(중앙값 300ms, p99 1.5초 [가정], payment §2.1)이고, 시험이 장애(거절·처리 중·응답 유실·5xx·한도 초과·지연)를 넣는다.

## What Changes

- **불변식 검사기**(`services/invariant-checker`, 새 배포 단위·작업 이미지 자리): 검사 연결의 임시 표에 원본 DB(purchase·payment·ticket)의 필요한 칸만 읽기 전용 스냅샷으로 옮기고, 시험 기록(NDJSON)을 싣고, 불변식마다 SQL 한 편으로 위반 행을 센다. 결과는 성능 장부 실행 폴더의 `invariants.csv`(건수만)와 `invariants-detail.ndjson`(위반 행, Git에 두지 않음)다. 원본이 없는 불변식은 `SKIPPED`다. 시각 기준(`as_of`)은 주입한 시계로 정하고 KST로 적는다.
- **PG 시뮬레이터**(`services/pg-simulator`, 로컬·CI·데모·스테이징 전용 배포 단위): 토스페이먼츠와 같은 모양의 승인·조회·취소 API, 시험이 쓰는 제어 API(결제창 인증 흉내, 장애 넣기, 지연 바꾸기, 원장 내보내기, 웹훅 사건 목록, 초기화). 테스트 키(`sim_sk_`)만 받고 운영(`PEAKET_ENV` 없음·`prod`)에서는 시작하지 않으며, 기본은 루프백에만 묶는다.
- **결제 포트와 시뮬레이터 어댑터**(`services/payment-svc`의 결제 모듈 시작): 결제 포트(`capabilities`·`checkout`·`confirm`·`query`·`cancel`·`parseWebhook`)와 표준 결과(승인 6가지, 취소 4가지, 실패 범주 6가지), 시뮬레이터 어댑터, 세 어댑터가 함께 돌릴 공통 계약 시험 묶음(payment §2.1 '어댑터 계약 테스트' 열 항목).
- **정본 보충(추천 적용 2026-11-02)**: 정산 돈 불변식 둘(한 결제의 환급이 두 정산서에 없음, 판매 대금 = 그 판이 쓴 대사 완료 승인 합)은 정산서 판이 어떤 결제·환급을 썼는지 남기는 기록이 있어야 센다. 정산서 판의 계산 원본 목록 `statement_source`를 docs/data.md에 더한다.
- 작업 공간에 `services/*`를 더한다(pnpm-workspace.yaml 주석대로 첫 서비스가 생기는 단계).

## Impact

- 정본: docs/verification.md §2.5(검사기 구성·기록 형식·운영 확인), docs/data.md(`statement_source`), docs/features/settlement.md §4.1·§10·§13, docs/features/payment.md §2.1(시뮬레이터 세부), docs/perf-ledger.md(`invariants-detail.ndjson`은 원본 버킷), docs/security/asvs/verification-tools.md(새 표).
- ID: K2, K7, NFR-003, NFR-005, NFR-006, NFR-025, QR-FS-1, QR-FS-6, S-T2, J-T25, P-T39(60초·30분 기준), ADR-0029·0057·0106·0129, WBS 1.2.3.
- 코드: `services/invariant-checker`·`services/pg-simulator`·`services/payment-svc`(결제 모듈의 포트·어댑터·계약 시험만), `pnpm-workspace.yaml`. 새 의존성 없음(fastify·pg·vitest·typescript는 잠금 파일에 있는 판).
- 넘김: 운영의 1분 대조(ADR-0106, 운영 배포와 경보 SEV1)와 검사기 이미지·CronJob은 HOT·OPS 단계, 토스·포트원 어댑터는 wbs 2.7.1, 웹훅 보내기(시뮬레이터가 payment-svc를 부름)와 Toxiproxy 연결은 wbs 2.12.3(HOT-480), 가상계좌 입금 흉내는 가상계좌 단계, v0가 어댑터를 어떻게 쓸지는 BSL-040.
