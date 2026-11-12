# 완성 장부: offline-gate

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/offline-gate.md`, `docs/security/asvs/offline-gate.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 5 | 102 | 0 | 0 | 0 | 1 | 0 | 19 | 105 | 232 |
| 합계 | 5 | 102 | 0 | 0 | 0 | 1 | 0 | 19 | 105 | 232 |

## docs/features/offline-gate.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| O-T1 | — | 비행기 모드 오프라인 검표 | 네트워크가 끊긴 상태에서 판정 p95 ≤ 150ms와 정상 티켓 오거부율 < 0.1%를 달성한다. 정상 티켓 3,000장 이상을 판정해 오거부가 0건이어야… | 자동 시험 | B | 시험: loadtest/e2e/before090.e2e.mjs, loadtest/test/before090.test.mjs 외 2곳 |
| O-T2 | — | 동일 구역 다기기 동시 스캔 | 오프라인 상태의 두 스캐너에서 같은 티켓을 1분 간격으로 통과시킨 뒤 두 기록이 모두 올라오면, '중복 입장' 이상 표시가 100% 생기고, 나중 기록은… | 빈칸 | B | — |
| O-T3 | — | 타 게이트 구역 티켓 스캔 | 배정되지 않은 다른 게이트의 스캐너에 찍으면 바로 거절되고, 올바른 게이트 위치가 안내된다. | 빈칸 | B | — |
| O-T4 | — | 분실 스캐너를 악용한 위조 | 분실된 스캐너 안의 데이터베이스만으로 유효한 회전 QR 서명을 위조하려는 시도가 100% 거절된다(통과 0건). | 빈칸 | B | — |
| O-T5 | — | 단말기 시스템 시계 ±60초 편차 | 시계 편차가 보정되어 정상 티켓이 통과된다. 보정되지 않은 기기의 비정상 요청은 안전하게 거부로 기록된다. | 빈칸 | B | — |
| O-T6 | — | iOS 7일 미사용 저장소 삭제 복구 | 입장 시작 전에는 재인증 뒤 재발급이 되고, 이전 키는 폐기 목록에 오른다. 24시간 안의 두 번째 재발급은 거부되고, 입장 시작 뒤의 재발급 요청은 현장 부스… | 빈칸 | B | — |
| O-T7 | — | 양도 직후 원소유자 입장 시도 | 변경분이 반영된 뒤 양도인의 QR은 '양도·취소·재발급된 티켓의 옛 QR'로 거절된다. 반영 전에 통과한 건은 두 기록이 올라오면 이상 표시로 잡힌다. | 빈칸 | B | — |
| O-T8 | — | 정적 스크린샷 QR 캡처본 검표 | 유효시간(±30초)이 지난 정적 캡처본 이미지는 스캐너 검표 단계에서 100% 거절된다. | 빈칸 | B | — |
| O-T9 | — | 재입장 순서 검증 | 앞선 퇴장 스캔(OUT)이 빠진 재입장 시도에는 '퇴장 기록 없음' 확인 필요가 화면에 바로 표시된다. | 빈칸 | B | — |
| O-T10 | — | 오프라인 동기화 멱등성 보장 | 같은 스캔 이벤트 배치를 2회 중복 업로드해도, 데이터베이스에는 단 1건만 정상 적재된다(멱등성: 같은 요청이 여러 번 와도 한 번 처리한 것과 결과가 같은… | 빈칸 | B | — |
| O-T11 | — | 업로드 재시도 폴백 | 업로드가 실패한 뒤 일회성 Background Sync가 3번 시도하고 포기해도, 화면이 다시 켜지면 앱이 남은 큐를 바로 올린다. | 빈칸 | B | — |
| O-T12 | — | 티켓 이중 양도 동시성 경합 | 같은 티켓에 2개 세션에서 동시에 양도를 요청하면, 행 잠금으로 차례로 처리되어 단 1건만 성공하고 나머지는 상태 재확인에서 409다(기술 검토 낮음-071). | 빈칸 | B | — |
| O-T13 | — | 월렛 오프라인 QR 자체 갱신 | 비행기 모드에서도 월렛이 15초마다 새로 서명한 유효한 QR 코드를 계속 만든다. 화면을 2분 끈 뒤 다시 켜면 다시 보이는 순간 그 시각으로 새로 서명한… | 빈칸 | B | — |
| O-T14 | — | 스캐너 접근성 및 직관성 | 검표 판정 결과를 색상, 아이콘, 텍스트, 비프음, 햅틱 진동으로 동시에 알려 주고, 화면 낭독기(화면의 글자를 소리로 읽어 주는 프로그램)로 판정 결과를… | 빈칸 | B | — |
| O-T15 | — | 회차별 재입장 정책 동적 반영 | 재입장 허용 회차는 OUT → IN을 정상 처리하고, 불허 회차는 두 번째 IN을 거부한다. 오픈 뒤 정책 완화가 다음 변경분(60초)에 스캐너에 반영된다. | 빈칸 | B | — |
| O-T16 | — | 입장 시작 후 예매 취소 건 방어 | 취소하자마자 폐기 목록에 오른다. 오프라인 스캐너가 통과시킨 건은 업로드 뒤 '취소 뒤 입장' 이상 표시가 붙고, CS 확인으로 취소가 무효로 확정된다. | 빈칸 | B | — |
| O-T17 | — | 스캔 로그의 현장 스태프 감사 추적 | 모든 `scan_event` 레코드에 서버가 세션으로 정한 `staff_account_id`가 기록되고, 스캐너 로컬 화면과 저장소에는 관람객 개인정보가… | 빈칸 | B | — |
| O-T18 | — | 양도 수락과 스캔 동시 경합 | 입장 시작 전에 받는 사람의 수락과 보낸 사람 QR의 온라인 스캔 수신이 겹치면, 행 잠금으로 하나만 성공한다. 스캔이 먼저면 수락은 409이고, 수락이 먼저면… | 빈칸 | B | — |
| O-T19 | — | 돌려주기·양도 회수 키 교체 | 입장 시작 전에 돌려주기나 회수를 하면, 변경분이 반영된 뒤 받은 사람의 QR은 거부되고 결제자 기기의 새 키로 입장된다. | 빈칸 | B | — |
| O-T20 | — | 스캐너 동기화 신선도 경보 | 입장 시간대에 스캐너 한 대의 네트워크를 3분 끊으면, 2분이 지난 뒤 관제에 SEV2와 현장 책임자 알림이 나온다. 그 스캐너는 오프라인 판정을 계속한다… | 빈칸 | B | — |
| O-T21 | — | 해제 15분 뒤 토큰 재사용 | 파트너가 스태프를 해제하고 6초 [가정] 뒤와 16분 뒤에 그 토큰과 그 기기 키의 DPoP 증명으로 요청한다. 근무 준비·목록·변경분과 책임자 기능(기기… | 빈칸 | B | — |
| O-T22 | — | 입장 중 소유권 동결 | 입장 시작 뒤 돌려주기·양도 수락·양도 회수 요청은 409 `ENTRY_STARTED`로 거부되고, 키가 바뀌지 않는다. | 빈칸 | B | — |
| O-T23 | — | 입장 상태 공유 | 같은 구역의 온라인 스캐너 A가 통과시킨 티켓을 2분 [가정] 뒤 스캐너 B로 찍으면 '이미 입장한 티켓'으로 거부된다. | 다른 단계 | B | BAT-350 · v0 모놀리스의 입장 시험(services/v0-monolith/test-int/gate.int.test.ts)만 있다. 목표 구조의 오프라인 게이트는 그 묶음(GAT-010)에서 다시… |
| O-T24 | — | 다른 기기의 퇴장·재입장 | 재입장을 허용하는 회차에서 기기 X(퇴장 모드)로 OUT한 뒤 기기 Y(입장 모드)로 IN하면 정상이고, 이상 표시가 없다. | 빈칸 | B | — |
| O-T25 | — | 키 미반영 | 변경분을 받지 못한 오프라인 스캐너는 입장 시작 뒤 처음 등록한 키의 QR을 '키 미반영'으로 거부하고 부스·책임자를 안내한다. | 빈칸 | B | — |
| O-T26 | — | 해제·만료 뒤 남은 기록 | 업로드를 기다리는 기록 12건이 남은 채 해제되거나 역할 유효 끝이 지나도, 기기가 연결되면 12건이 모두 올라간다. 해제·만료 뒤 시각의 기록은 '세션 밖… | 빈칸 | B | — |
| O-T27 | — | 기기 폐기 | SCR-053에서 폐기한 기기가 다음에 보내는 요청은 거부된다. 그 기기의 스태프 세션도 끝나고, 감사 로그에 남는다. | 빈칸 | B | — |
| O-T28 | — | 부스 재발급 | 본인확인 결과가 보유 계정과 같으면 부스 코드가 나온다. 책임자가 이 코드를 찍은 뒤 10분 안에 한 BOOTH 등록만 성공한다. 결과가 다르면 409… | 빈칸 | B | — |
| O-T29 | — | 입장 기록 마감 | 모든 기기가 큐를 비웠으면 역할 유효 끝에 마감된다. 한 대가 보고하지 않으면 24시간 [가정] 뒤에 마감되고, CS 처리함에 '미보고 스캐너'가 생긴다. 마감… | 빈칸 | B | — |
| O-T30 | — | 변경분 일련번호 | 같은 회차에 동시에 들어온 두 변경 트랜잭션도 `scanner_seq` 카운터 행에서 차례로 번호를 받아 번호 순서와 커밋 순서가 같고, 스캐너가 둘 다… | 빈칸 | B | — |
| O-T31 | — | 기기 배치 권한 | 일반 스태프가 배치를 바꾸면 403이다. 재입장을 허용하지 않는 회차에 퇴장 모드로 배치하면 422다. | 빈칸 | B | — |
| O-T32 | — | 입장용 휴대폰 등록 | 데스크톱으로 보이는 브라우저에서 월렛을 열면 키를 만들지 않고 휴대폰 등록을 안내한다. 휴대폰에서 등록하면 QR이 나온다. | 빈칸 | B | — |
| O-T33 | — | QR v1 형식 | 지원하지 않는 형식 버전은 '유효하지 않은 QR', 폐기된 keyId는 '옛 QR', 서명이 맞지 않으면 '위조 의심'으로 사유가 나뉜다. | 빈칸 | B | — |
| O-T34 | — | 예외 통과 | 책임자 세션만 예외 통과를 할 수 있다. 사유·메모·책임자 계정이 기록되고, CS 처리함의 사후 검토에 오른다. 대리 승인 세션에는 버튼이 없고, API로… | 빈칸 | B | — |
| O-T35 | ① | 기기 인증만 요구하는 쓰기 경로(기기 승인 요청·토큰·스캔 올리기)에… | ①는 403이다. 확인 코드가 만들어지지 않고 기록도 저장되지 않는다. | 빈칸 | B | — |
| O-T35 | ② | 기기 인증만 요구하는 쓰기 경로(기기 승인 요청·토큰·스캔 올리기)에… | ②는 403이다. 확인 코드가 만들어지지 않고 기록도 저장되지 않는다. | 빈칸 | B | — |
| O-T35 | ③ | 기기 인증만 요구하는 쓰기 경로(기기 승인 요청·토큰·스캔 올리기)에… | ③은 415다. | 빈칸 | B | — |
| O-T35 | ④ | 기기 인증만 요구하는 쓰기 경로(기기 승인 요청·토큰·스캔 올리기)에… | ④는 정상 처리된다 | 빈칸 | B | — |
| O-T35 | ⑤ | 기기 인증만 요구하는 쓰기 경로(기기 승인 요청·토큰·스캔 올리기)에… | ⑤는 정상 처리된다 | 빈칸 | B | — |
| O-T36 | — | mTLS 선택지의 교차 출처 인증서(선택 PoC 5.4.3):… | 사전 요청은 인증서 없이 통과하고, 본 요청에는 기기 인증서가 실려 통과하며 PWA가 응답을 읽는다. 인증서 없는 본 요청은 403이다. 하나라도 안 되면… | 빈칸 | B | — |
| O-T37 | ① | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ①은 통과하고, 브라우저의 사전 요청은 자격 증명 없이 끝난다(`credentials: 'omit'`). | 빈칸 | B | — |
| O-T37 | ② | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ②은 401이고 기록이 저장되지 않는다. | 빈칸 | B | — |
| O-T37 | ③ | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ③은 401이고 기록이 저장되지 않는다. | 빈칸 | B | — |
| O-T37 | ④ | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ④은 401이고 기록이 저장되지 않는다. | 빈칸 | B | — |
| O-T37 | ⑤ | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ⑤은 401이고 기록이 저장되지 않는다. | 빈칸 | B | — |
| O-T37 | ⑥ | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ⑥은 401이고 기록이 저장되지 않는다. | 빈칸 | B | — |
| O-T37 | ⑦ | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ⑦은 403(기기 폐기)이다. | 빈칸 | B | — |
| O-T37 | ⑧ | 기본 기기 키 DPoP(추천 적용 2026-10-28, 기술 검토… | ⑧은 같은 키로 만든 증명으로 모두 올라간다 | 빈칸 | B | — |
| O-T38 | — | 목록 생성 중 커밋된 폐기(추천 적용 2026-10-28, 기술 검토… | 한 스냅샷 구현에서는 스캐너가 그 keyId를 폐기로 안다(빠짐 0건). 비교 대상에서는 빠짐이 재현된다. 같은 변경을 두 번 받아도 스캐너 상태가 같다 | 빈칸 | B | — |
| O-T39 | — | 스캔 큐 쓰기의 내구성(추천 적용 2026-10-28, 기술 검토… | 다시 켜면 통과 화면을 본 기록이 모두 스캔 큐에 있다(유실 0건). strict의 판정 지연 p95가 150ms 안이다. 넘으면 wbs 5.4.7에서 예산을… | 빈칸 | B | — |
| O-T40 | — | 온라인 → 오프라인 전환 중 판정(추천 적용 2026-10-28, 기술… | 결과가 나오지 않거나 오류인 판정이 0건이고, 전환 앞뒤 1분 판정 지연의 최댓값이 평소 p95(150ms) 안 [가정]이다(판정이 멈춘 시간 0초). 끊긴… | 빈칸 | B | — |
| O-T41 | — | 레인 처리량(추천 적용 2026-10-28, 기술 검토 낮음-058):… | 오프라인의 분당 통과 인원 중앙값이 온라인의 90% [가정] 이상이다. 차이가 나면 판정 지연·화면 갱신·큐 쓰기 가운데 어디서 늘었는지 기록한다 | 빈칸 | B | — |
| O-T42 | ① | 기기 등록 시도 제한(추천 적용 2026-10-28, 기술 검토… | ① 15대 모두 201(성공은 세지 않는다) | 빈칸 | B | — |
| O-T42 | ② | 기기 등록 시도 제한(추천 적용 2026-10-28, 기술 검토… | ② 11번째부터 10분 동안 429 | 빈칸 | B | — |
| O-T42 | ③ | 기기 등록 시도 제한(추천 적용 2026-10-28, 기술 검토… | ③ 등록 201과 SEV3 경보 하나, 등록 경로는 닫히지 않는다 | 빈칸 | B | — |
| O-T42 | ④ | 기기 등록 시도 제한(추천 적용 2026-10-28, 기술 검토… | ④ 410 | 빈칸 | B | — |
| O-T43 | — | 잠금 걸린 티켓의 정상 입장(추천 적용 2026-10-31… | 세 티켓 모두 통과하고, 판정 사유와 지연이 잠금 없는 티켓과 같다. 회차 목록·변경분·스캐너 저장소에 잠금 칸·사건 ID가 0건이다. 입장 시작 뒤… | 빈칸 | B | — |

## docs/security/asvs/offline-gate.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test/sale-eligibility.http.test.ts 외 7곳 (영역:… |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 5곳… |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts (영역: apps/scanner) |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/args090.test.mjs 외 77곳 (영역: apps/scanner… |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/save-answer.test.mjs… |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/catalog.int.test.ts 외 34곳 (영역:… |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-deposit.int.t… |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/admission-ctrl/test/admission-leader.test.ts 외 34곳 (영역:… |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts… |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/idempotency.int.test.ts, packages/platform/test-int/template.int.test.ts 외 49곳 (영역:… |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | 자동 시험 | B | 시험: services/identity-svc/test/login-verdict.test.ts, services/identity-svc/test/trust-login-risk.test.ts |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/result-files.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/web/src/_pages/queue-verify/model/verify-flow.test.mjs, apps/web/src/_pages/queue-verify/model/view.test.mjs 외… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: apps/scanner) |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test/http.test.ts 외 2곳… |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: apps/scanner) |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/web/server/csp-hash-server.test.mjs, apps/web/src/_app/security/page-headers.test.mjs 외 1곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/scanner) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | ID만 | B | 다른 곳 시험: apps/web/src/_app/security/page-headers.test.mjs, packages/config/headers/headers.test.mjs 외 1곳 (영역:… |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | ID만 | B | 다른 곳 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs 외… |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/queue-svc/test/leave-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs, apps/web/src/features/identity-verify/flow.test.mjs… |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/verify-return.test.mjs, apps/web/src/_pages/login/model/state.test.mjs 외 8곳 (영역:… |
| v5.0.0-6.1.1 | — | L1 | 레이트 리밋·자동화 방지·적응형 대응 같은 통제가 크리덴셜 스터핑과 비밀번호 무차별 대입을 어떻게 막는지 문서에 정한다. 통제를 어떻게 설정하는지와 악의적 계정… | ID만 | B | 다른 곳 시험: services/identity-svc/test/admin-login.test.ts (영역: apps/scanner) |
| v5.0.0-6.1.2 | — | L2 | 비밀번호로 쓸 수 없는 서비스 관련 단어 목록을 문서화한다. | 해당 없음 | B | 해당 없음: 현장 스태프와 스캐너에는 비밀번호·PIN이 없다(ADR-0030) |
| v5.0.0-6.1.3 | — | L2 | 인증 경로가 여럿이면 모든 경로와, 모든 경로에 일관되게 적용할 보안 통제·인증 강도를 함께 문서화한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-6.3.1 | — | L1 | 명세서에 정의된 크리덴셜 스터핑 및 무차별 대입 방어 통제를 시스템에 구현한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-login.int.test.ts, services/identity-svc/test/admin-login-http.test.ts 외 3곳 |
| v5.0.0-6.3.2 | — | L1 | 기본 계정(root, admin 등)이 없거나 비활성화되어 있다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-6.3.3 | — | L2 | 애플리케이션 접근에는 다중 요소 인증이나 단일 요소 인증의 조합을 요구하고(L3는 피싱에 강하고 사용자 동작을 요구하는 하드웨어 요소 포함), 이를 완화하려면… | ID만 | B | 다른 곳 시험: services/identity-svc/test/admin-passkey-http.test.ts, services/identity-svc/test/admin-totp.test.ts 외 1곳 (영역:… |
| v5.0.0-6.3.4 | — | L2 | 인증 경로가 여럿이면 문서에 없는 경로가 없게 하고, 모든 경로에 같은 보안 통제와 인증 강도를 일관되게 적용한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-6.5.1 | — | L2 | 조회용 비밀값, 대역 외 인증 요청·코드, TOTP는 한 번만 성공적으로 쓸 수 있다. | ID만 | B | 다른 곳 시험: services/identity-svc/test-int/admin-unlock.int.test.ts, services/identity-svc/test/admin-totp.test.ts 외 1곳… |
| v5.0.0-6.5.2 | — | L2 | 엔트로피가 112비트 미만인 조회용 비밀값은 백엔드에 저장할 때 32비트 난수 솔트를 넣은 승인된 비밀번호 저장용 해시로 저장하고, 112비트 이상이면 일반… | 해당 없음 | B | 해당 없음: 조회용 비밀값(복구 코드)이 없다. 112비트 이상인 초대 토큰(256비트)은 SHA-256으로 저장하고, 확인 코드·부스 코드는 수명 10분 이하의 대역 외 코드라 6.5.4·6.5.5로 다룬다 |
| v5.0.0-6.5.3 | — | L2 | 조회용 비밀값, 대역 외 인증 코드, TOTP 시드는 CSPRNG로 만든다. | 빈칸 | B | 영역: services/identity-svc, services/ticket-svc |
| v5.0.0-6.5.4 | — | L2 | 조회용 비밀값과 대역 외 인증 코드는 20비트 이상의 엔트로피를 갖는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-6.5.5 | — | L2 | 대역 외 인증 요청·코드·토큰과 TOTP에 수명을 정하고, 대역 외 요청은 최대 10분, TOTP는 최대 30초로 한다. | ID만 | B | 다른 곳 시험: services/identity-svc/test/admin-totp.test.ts (영역: apps/scanner) |
| v5.0.0-6.6.1 | — | L2 | 전화·SMS로 일회용 코드를 보내는 인증은 미리 검증한 번호에만, 더 강한 수단과 함께, 보안 위험을 알리며 제공하고, L3에서는 제공하지 않는다. | 해당 없음 | B | 해당 없음: PEAKET은 전화·SMS OTP를 인증 수단으로 쓰지 않는다. 부스의 휴대폰 본인확인은 본인확인기관 서비스로 신원 대조에만 쓴다 |
| v5.0.0-6.6.2 | — | L2 | 대역 외 인증 요청·코드·토큰은 만들어진 원래 인증 요청에 묶이고 앞뒤 다른 요청에 쓸 수 없다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-6.6.3 | — | L2 | 코드 기반 대역 외 인증은 레이트 리밋으로 무차별 대입을 막는다(64비트 이상 코드도 고려). | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.1.1 | — | L2 | 세션 유휴 만료와 절대 만료를 다른 통제와 함께 봐도 적절하게 정해 문서화하고, NIST SP 800-63B 재인증 기준과 다른 점의 근거를 적는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.1.2 | — | L2 | 계정당 동시 세션 수와 한도 도달 때의 동작을 문서화한다. | ID만 | B | 다른 곳 시험: services/identity-svc/test/device-sessions.test.ts (영역: apps/scanner) |
| v5.0.0-7.1.3 | — | L2 | SSO 같은 연합 인증 환경에서 사용자 세션을 만들고 관리하는 모든 시스템과, 세션 수명·종료·재인증 조건을 서로 맞추는 통제를 문서화한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.2.1 | — | L1 | 세션 토큰 검증을 신뢰할 수 있는 백엔드에서 한다. | 빈칸 | B | 영역: services/identity-svc, services/ticket-svc |
| v5.0.0-7.2.2 | — | L1 | 세션은 동적으로 만든 토큰으로 관리하고 고정 API 키를 쓰지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.2.3 | — | L1 | 사용자 세션에 참조 토큰을 쓰면 CSPRNG로 만든 엔트로피 128비트 이상의 고유한 값으로 한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.2.4 | — | L1 | 인증·재인증 때 새 세션 토큰을 만들고 이전 토큰을 끝낸다. | ID만 | B | 다른 곳 시험: services/identity-svc/test-int/admin-token-refresh.int.test.ts, services/identity-svc/test/admin-token-refresh-… |
| v5.0.0-7.3.1 | — | L2 | 위험 분석과 문서화한 보안 결정에 따라 유휴 만료를 두어 재인증을 요구한다. | ID만 | B | 다른 곳 시험: services/identity-svc/test/admin-token-refresh-http.test.ts (영역: apps/scanner) |
| v5.0.0-7.3.2 | — | L2 | 위험 분석과 문서화한 보안 결정에 따라 절대 만료를 두어 재인증을 요구한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.4.1 | — | L1 | 로그아웃·만료로 세션이 끝나면 그 세션을 더 쓰지 못하게 하고, 참조 토큰·상태 저장 세션은 백엔드에서 무효화하며 자체 완결형 토큰은 종료 목록 등으로 거부한다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, packages/platform/test/auth-guard.test.ts 외… |
| v5.0.0-7.4.2 | — | L1 | 계정이 정지·삭제되면 그 계정의 모든 활성 세션을 끝낸다. | ID만 | B | 다른 곳 시험: services/identity-svc/test/admin-token-refresh-http.test.ts, services/identity-svc/test/http.test.ts (영역:… |
| v5.0.0-7.4.3 | — | L2 | 인증 요소를 바꾸거나 지운 뒤 다른 세션을 모두 끝낼 수 있게 한다. | ID만 | B | 다른 곳 시험: apps/web/src/entities/provider/model.test.mjs, apps/web/src/features/login-methods/flow.test.mjs 외 4곳 (영역:… |
| v5.0.0-7.4.4 | — | L2 | 로그인이 필요한 모든 화면에서 로그아웃 기능이 잘 보이고 쉽게 닿게 한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.4.5 | — | L2 | 관리자가 사용자별·전체 활성 세션을 끝낼 수 있다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.5.1 | — | L2 | 인증에 영향을 주는 민감 계정 정보를 바꾸기 전에 전체 재인증을 요구한다. | ID만 | B | 다른 곳 시험: services/identity-svc/test/passkey-cases.ts (영역: apps/scanner) |
| v5.0.0-7.5.2 | — | L2 | 사용자가 지금 활성인 세션을 보고, 인증 요소 하나 이상으로 다시 인증한 뒤 일부나 전부를 끝낼 수 있게 한다. | ID만 | B | 다른 곳 시험: apps/web/src/_pages/settings/model/state.test.mjs, apps/web/src/features/device-sessions/flow.test.mjs 외 3곳… |
| v5.0.0-7.6.1 | — | L2 | 신뢰 당사자와 IdP 사이의 세션 수명·종료가 문서대로 동작하고, IdP 인증 간격이 최대 시간에 이를 때처럼 필요하면 재인증을 요구한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-7.6.2 | — | L2 | 사용자 동의나 명시적 동작 없이 세션을 만들지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/event-summary.http.test.ts, services/core-svc/test/partner-production.http.test.ts 외 3곳… |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, packages/platform/test/auth-guard.test.ts 외 28곳… |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 39곳 (영역:… |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | ID만 | B | 다른 곳 시험: packages/contracts/test/close-additional-properties.test.ts, packages/contracts/test/types.test.ts 외 6곳 (영역:… |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: apps/scanner) |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 4곳 (영역:… |
| v5.0.0-9.1.1 | — | L1 | 자체 완결형 토큰은 서명이나 MAC을 검증한 뒤에만 내용을 받아들인다. | ID만 | B | 다른 곳 시험: packages/platform/test/purchase-auth.test.ts, packages/platform/test/token-verify.test.ts 외 15곳 (영역:… |
| v5.0.0-9.1.2 | — | L1 | 자체 완결형 토큰의 생성·검증에는 맥락별 허용 목록의 알고리즘만 쓰고(`none` 제외, 되도록 대칭·비대칭 중 한쪽만), 둘 다 써야 하면 키 혼동을 막는… | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/purchase-svc/test/admission-token.test.ts 외 5곳 (영역:… |
| v5.0.0-9.1.3 | — | L1 | 검증 키는 미리 정한 신뢰 출처에서만 얻고 `jku`·`x5u`·`jwk` 헤더를 허용 목록으로 검증한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/admission-token.test.ts, services/queue-svc/test/tokens.test.ts (영역: apps/scanner) |
| v5.0.0-9.2.1 | — | L1 | 유효 기간이 있으면 검증 시각이 그 안일 때만 받는다(`nbf`·`exp`). | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/purchase-svc/test-int/purchase-session.int.test.ts 외 11곳… |
| v5.0.0-9.2.2 | — | L2 | 토큰 종류와 목적이 맞는지 확인한 뒤 받는다. | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/identity-svc/test/passkey-cases.ts 외 4곳 (영역:… |
| v5.0.0-9.2.3 | — | L2 | 그 서비스를 위한 토큰(`aud`)만 받는다. | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/purchase-svc/test/admission-token.test.ts 외 4곳 (영역:… |
| v5.0.0-9.2.4 | — | L2 | 같은 개인 키로 여러 대상에 토큰을 발급하면 대상을 고유하게 나타내는 대상 제한을 넣고, 대상 식별자를 동적으로 정하면 발급자가 그 대상을 검증해 대상 사칭을… | ID만 | B | 다른 곳 시험: packages/platform/test/token-verify.test.ts (영역: apps/scanner) |
| v5.0.0-10.1.1 | — | L2 | 토큰은 꼭 필요한 구성요소에만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-10.1.2 | — | L2 | 클라이언트는 같은 사용자 에이전트 세션에서 시작한 바로 그 인가 흐름의 값(인가 코드·ID 토큰)만 받고, 이를 위해… | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-10.2.1 | — | L2 | 코드 흐름을 쓰면 PKCE나 `state`로 CSRF를 막는다. | 해당 없음 | B | 해당 없음: 스캐너 로그인은 인가 코드 흐름이 아니라 기기 승인 흐름이다(브라우저를 다른 주소로 보내는 리디렉션이 없다) |
| v5.0.0-10.2.2 | — | L2 | 인가 서버가 여럿이면 혼동 공격을 막는다. | 해당 없음 | B | 해당 없음: 스캐너 클라이언트의 인가 서버는 `identity-svc` 하나다 |
| v5.0.0-10.3.1 | — | L2 | 자원 서버는 그 서비스를 위한 액세스 토큰(`aud`)만 받는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.3.2 | — | L2 | 자원 서버는 토큰의 위임 인가 클레임(`sub`·`scope` 등)으로 판정한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.3.3 | — | L2 | 사용자를 식별할 때 다른 사용자에게 다시 배정될 수 없는 클레임(`iss`와 `sub`)을 쓴다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.3.4 | — | L2 | 특정 인증 강도·방법·최근성이 필요하면 토큰이 그 조건을 만족하는지 확인한다. | 해당 없음 | B | 해당 없음: 스캐너 경로에는 인증 강도·최근성 조건을 두지 않는다 |
| v5.0.0-10.4.1 | — | L1 | 인가 서버는 클라이언트별로 미리 등록한 리디렉션 URI만 정확히 비교해 허용한다. | 해당 없음 | B | 해당 없음: 기기 승인 흐름에는 리디렉션 URI가 없다. 승인 화면 주소는 PEAKET의 고정 경로다 |
| v5.0.0-10.4.2 | — | L1 | 인가 코드는 토큰 요청에 한 번만 쓰고, 다시 쓰면 거부하고 관련 토큰을 폐기한다. | 해당 없음 | B | 해당 없음: 인가 코드를 쓰지 않는다. 기기 승인 코드도 한 번 토큰으로 바꾸면 지운다(6.5.1) |
| v5.0.0-10.4.3 | — | L1 | 인가 코드는 수명이 짧다(L2는 최대 10분). | 해당 없음 | B | 해당 없음: 인가 코드를 쓰지 않는다. 기기 승인 코드의 수명은 5분이다 |
| v5.0.0-10.4.4 | — | L1 | 인가 서버는 클라이언트에 필요한 grant만 허용하고 implicit·password grant는 쓰지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.4.5 | — | L1 | 공개 클라이언트의 리프레시 토큰 재사용 공격을 막는다. | 해당 없음 | B | 해당 없음: 스캐너에는 리프레시 토큰이 없다. 만료되면 다시 승인한다 |
| v5.0.0-10.4.6 | — | L2 | 코드 흐름이면 PKCE를 요구하고 `plain`을 받지 않는다. | 해당 없음 | B | 해당 없음: 코드 흐름을 쓰지 않는다 |
| v5.0.0-10.4.7 | — | L2 | 인증 없는 동적 클라이언트 등록을 지원하면 악성 클라이언트 위험을 줄인다. | 해당 없음 | B | 해당 없음: 동적 클라이언트 등록이 없다. 기기는 operator가 등록한다 |
| v5.0.0-10.4.8 | — | L2 | 리프레시 토큰에 절대 만료가 있다. | 해당 없음 | B | 해당 없음: 리프레시 토큰이 없다 |
| v5.0.0-10.4.9 | — | L2 | 권한 있는 사용자가 리프레시 토큰과 참조 액세스 토큰을 폐기할 수 있다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.4.10 | — | L2 | 기밀 클라이언트는 토큰 요청 같은 백채널 요청에서 인증한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.4.11 | — | L2 | 인가 서버는 클라이언트에 필요한 scope만 준다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test/quicknet-verifier.test.ts 외 1곳… |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: apps/scanner) |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/payment-svc/test/portone-gateway.test.ts (영역:… |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | 해당 없음 | B | 해당 없음: 이 기능은 데이터를 암호화하지 않고 서명과 TLS(통신을 암호화하는 표준)만 쓴다. 저장 암호화는 공통으로 다룬다(data-classification) |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | 해당 없음 | B | 해당 없음: 11.3.1과 같다 |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | 해당 없음 | B | 해당 없음: 11.3.1과 같다 |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역: apps/scanner) |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | B | 해당 없음: 이 기능에는 비밀번호가 없다 |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역: apps/scanner) |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음: 비밀번호에서 키를 만들지 않는다 |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | ID만 | B | 다른 곳 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 5곳 (영역:… |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test-int/kms-seed.int.test.ts 외 4곳… |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-server.test.ts (영역: apps/scanner) |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 해당 없음 | B | 해당 없음: 기본안(기기 키와 DPoP)은 클라이언트 인증서로 인증하지 않는다. DPoP 키가 등록된 기기 키인지와 기기 상태(ACTIVE)는 10.3.5와 7.2.1이 판정한다(추천 적용 2026-10-28… |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/consumers.test.ts (영역: apps/scanner) |
| v5.0.0-13.2.1 | — | L2 | 표준 사용자 세션을 쓰지 않는 백엔드 구성 요소 사이 통신을 개별 서비스 계정·단기 토큰·인증서로 인증하고, 바뀌지 않는 비밀번호·API 키를 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/portone-gateway.int.test.ts, services/payment-svc/test-int/toss-gateway.int.test… |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | ID만 | B | 다른 곳 시험: loadtest/test/manifests090.test.mjs, loadtest/test/review060.test.mjs 외 9곳 (영역: apps/scanner) |
| v5.0.0-13.2.3 | — | L2 | 서비스 인증에 기본 자격 증명을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-13.2.4 | — | L2 | 애플리케이션이 통신할 수 있는 외부 자원의 허용 목록을 정의한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts 외 1곳 (영역:… |
| v5.0.0-13.2.5 | — | L2 | 서버가 요청을 보내거나 자원을 불러올 수 있는 대상의 허용 목록을 설정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/payment-svc/test/portone-config.test.ts 외 2곳… |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 13곳 (영역: apps/scanner) |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 5곳… |
| v5.0.0-13.4.1 | — | L1 | 배포물에 `.git`·`.svn` 같은 소스 관리 메타데이터가 없거나, 있어도 외부와 애플리케이션 모두 접근할 수 없다. | ID만 | B | 다른 곳 시험: apps/web/server/deployment-id.test.mjs, apps/web/server/standalone.test.mjs 외 2곳 (영역: apps/scanner) |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts, services/pg-simulator/test/simulator.test.ts (영역: apps/scanner) |
| v5.0.0-13.4.3 | — | L2 | 의도한 경우가 아니면 웹 서버가 디렉터리 목록을 보여 주지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-13.4.4 | — | L2 | 운영 환경에서 HTTP TRACE 메서드를 지원하지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/metrics.test.ts, services/pg-simulator/test/simulator.test.ts 외 2곳 (영역: apps/scanner) |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts (영역: apps/scanner) |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | ID만 | B | 다른 곳 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.t… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts (영역:… |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역:… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, packages/platform/test-int/held-events.int.test.ts 외 15곳 (영역: apps/scanner) |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | ID만 | B | 다른 곳 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account-http.test.ts 외… |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | ID만 | B | 다른 곳 시험: tools/ci/vuln-deadline.test.mjs (영역: apps/scanner) |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | B | 다른 곳 시험: tools/ci/sbom-find.test.mjs, tools/web-checks/static/assets.test.mjs (영역: apps/scanner) |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, apps/partner/src/_pages/seatmap-editor/model/work… |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/maintenance.int.test.ts, packages/platform/test/circuit-breaker.test.ts 외 6곳 (영역:… |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, services/payment-svc/test-int/payment-new-pause.int.test.ts… |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, packages/platform/test/telemetry.test.ts 외 2곳 (영역:… |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 3곳 (영역:… |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: apps/scanner) |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | B | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/config/eslint/js-security.test.mjs 외 4곳 (영역: apps/scanner) |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 1곳 (영역:… |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts (영역: apps/scanner) |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/production-image.int.test.ts (영역:… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | ID만 | B | 다른 곳 시험: loadtest/test/before090.test.mjs, loadtest/test/lib.test.mjs 외 78곳 (영역: apps/scanner) |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외… |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.t… |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.t… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | ID만 | B | 다른 곳 시험: packages/platform/test/redis.test.ts, packages/platform/test/request-log.test.ts 외 54곳 (영역: apps/scanner) |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 1곳 (영역:… |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: apps/scanner) |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/kafka.int.test.ts, packages/platform/test-int/outbox.int.test.ts 외 87곳 (영역:… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/circuit-breaker.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 71곳… |
| v5.0.0-3.6.1 | — | L3 | 외부에 둔 클라이언트 자산은 정적이고 버전이 붙은 자원을 SRI로 검증할 때만 쓰고, 안 되면 자원마다 보안 결정으로 문서에 남긴다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-8.3.2 | — | L3 | 인가 판정의 근거 값이 바뀌면 바로 반영하고, 자체 완결형 토큰처럼 바로 반영할 수 없으면 완화 통제를 둔다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.3.5 | — | L3 | 자원 서버는 mTLS나 DPoP로 보낸 사람에 묶인 토큰만 받아 도난 토큰 사용을 막는다. | 빈칸 | B | 영역: apps/scanner |
| v5.0.0-10.4.14 | — | L3 | 인가 서버는 보낸 사람에 묶인 액세스 토큰만 발급한다. | 빈칸 | B | 영역: services/identity-svc |
| v5.0.0-15.4.2 | — | L3 | 자원 상태 확인과 그 상태에 따른 동작을 원자적으로 해서 확인 시점과 사용 시점의 경합(TOCTOU)을 막는다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test-int/leader-store.int.tes… |
