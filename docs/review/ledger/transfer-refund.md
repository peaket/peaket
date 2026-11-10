# 완성 장부: transfer-refund

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/transfer-refund.md`, `docs/security/asvs/transfer-refund.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 0 | 79 | 0 | 0 | 0 | 0 | 0 | 20 | 129 | 228 |
| 합계 | 0 | 79 | 0 | 0 | 0 | 0 | 0 | 20 | 129 | 228 |

## docs/features/transfer-refund.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| R-T1 | — | 양도 요청 뒤 48시간 경과 | 요청은 EXPIRED, 티켓은 보낸 사람에게, 받는 사람이 수락하면 409 | 빈칸 | A | — |
| R-T2 | — | 받은 사람이 다른 회원에게 양도 시도 | 409, 보안 이벤트 기록 | 빈칸 | A | — |
| R-T3 | — | 양도 요청 중 결제자 취소 | 409, 안내 문구 | 빈칸 | A | — |
| R-T4 | — | 돌려받은 뒤 결제자 취소 | 공제율대로 결제자가 처음 결제한 수단으로 환급 | 빈칸 | A | — |
| R-T5 | — | 수락·스캔·취소 동시 경합 1,000회 | 각 시도에서 정확히 하나만 성공 | 빈칸 | A | — |
| R-T6 | — | 재량 면제 29만 원과 31만 원 | 29만 원은 `cs_lead` 1인 승인, 31만 원은 2인 승인이 필요하다 | 빈칸 | A | — |
| R-T7 | — | 요청자가 자기 승인 업무를 승인 | 403 | 빈칸 | A | — |
| R-T29 | ① | 승인 업무 철회와 만료(추천 적용 2026-10-28, 기술 검토… | ①은 WITHDRAWN과 사유가 남고 상위 승인자 알림이 멈춘다 | 빈칸 | A | — |
| R-T29 | ② | 승인 업무 철회와 만료(추천 적용 2026-10-28, 기술 검토… | ②는 403 | 빈칸 | A | — |
| R-T29 | ③ | 승인 업무 철회와 만료(추천 적용 2026-10-28, 기술 검토… | ③은 EXPIRED(`TARGET_CHANGED`)이고 요청자·승인자에게 알림이 간다 | 빈칸 | A | — |
| R-T29 | ④ | 승인 업무 철회와 만료(추천 적용 2026-10-28, 기술 검토… | ④는 EXPIRED, 지급일이 다음 영업일로 미뤄지고 다음 영업일 09시에 새 묶음이 생긴다 | 빈칸 | A | — |
| R-T29 | ⑤ | 승인 업무 철회와 만료(추천 적용 2026-10-28, 기술 검토… | ⑤는 승인 직전 만료 판정으로 실행되지 않는다. 모든 전이가 감사 로그에 남는다 | 빈칸 | A | — |
| R-T8 | — | 회차 취소 1만 건 일괄 환불, 결제사 한도 300 TPS(초당 처리… | 한도 초과 0, 중복 환급 0, 진행률이 실제와 일치 | 빈칸 | A | — |
| R-T9 | — | 일괄 환불 중 결제사 오류율 급증(추천 적용 2026-10-28, 기술… | 4.9%·19건은 멈추지 않는다. 5%·20건·서킷 열림은 토스형 몫만 멈추고 SEV2가 나며, 포트원형 몫은 계속한다. 멈춘 동안 토스형 새 취소 호출은… | 빈칸 | A | — |
| R-T22 | ① | 일괄 환불 수동 일시정지·재개와 업무 거절(추천 적용… | ① 모든 몫이 멈추고 이미 보낸 호출만 답을 받는다 | 빈칸 | A | — |
| R-T22 | ② | 일괄 환불 수동 일시정지·재개와 업무 거절(추천 적용… | ② 그 몫만 멈춘다 | 빈칸 | A | — |
| R-T22 | ③ | 일괄 환불 수동 일시정지·재개와 업무 거절(추천 적용… | ③ 403 | 빈칸 | A | — |
| R-T22 | ④ | 일괄 환불 수동 일시정지·재개와 업무 거절(추천 적용… | ④ 작업 전체가 `AUTO_REJECT_RATE`로 멈추고 거절 건은 CS 처리함 '일괄 환불 실패'에 오른다 | 빈칸 | A | — |
| R-T22 | ⑤ | 일괄 환불 수동 일시정지·재개와 업무 거절(추천 적용… | ⑤ 기준 3으로 바로 다시 멈춘다 | 빈칸 | A | — |
| R-T22 | ⑥ | 일괄 환불 수동 일시정지·재개와 업무 거절(추천 적용… | ⑥ 1시간마다 다시 알린다. 모든 정지·재개가 사유와 함께 감사 로그에 남는다 | 빈칸 | A | — |
| R-T23 | ① | 판매 중지·재개·회차 취소 요청(추천 적용 2026-10-28… | ① 403 | 빈칸 | A | — |
| R-T23 | ② | 판매 중지·재개·회차 취소 요청(추천 적용 2026-10-28… | ② 같은 트랜잭션으로 비공개가 되고 검색·홈에서 빠지며 CDN 무효화를 부른다. 판매 중인 회차의 새 홀드·결제 접수는 423이고 serving이 멈추며, 대기… | 빈칸 | A | — |
| R-T23 | ③ | 판매 중지·재개·회차 취소 요청(추천 적용 2026-10-28… | ③ 판매 중지가 풀리지 않는다 | 빈칸 | A | — |
| R-T23 | ④ | 판매 중지·재개·회차 취소 요청(추천 적용 2026-10-28… | ④ 판매 중이던 회차는 다시 열리고, 오픈 시각이 지난 회차는 열리지 않으며 파트너에게 오픈 시각을 바꾸라고 알린다 | 빈칸 | A | — |
| R-T23 | ⑤ | 판매 중지·재개·회차 취소 요청(추천 적용 2026-10-28… | ⑤ 409 `sale-not-suspended` | 빈칸 | A | — |
| R-T23 | ⑥ | 판매 중지·재개·회차 취소 요청(추천 적용 2026-10-28… | ⑥ 요청이 생기고 판정·판정자 외 1인 확정·일괄 환불이 docs/planning/03 §2.11대로 이어진다 | 빈칸 | A | — |
| R-T24 | — | 입장 시작 뒤 회차 취소(추천 적용 2026-10-28, 기술 검토… | 여섯 가지 모두 환급 대상이고, 입장 기록 마감을 기다리지 않고 일괄 환불이 시작된다. 보류 중이던 예매 취소는 공제 없이 전액으로 바뀌고, 양도 요청은 먼저… | 빈칸 | A | — |
| R-T25 | ① | 회차 취소·연기 때 진행 중인 양도 요청(추천 적용… | ① 양도 요청이 모두 WITHDRAWN(사유 `EVENT_CANCELLED`)이 되고, 같은 트랜잭션에서 결제자 환급이 걸려 3영업일 안에 끝난다. 받는 사람과… | 빈칸 | A | — |
| R-T25 | ② | 회차 취소·연기 때 진행 중인 양도 요청(추천 적용… | ② 철회와 수락 가운데 하나만 성공하고, 어느 쪽이든 환급은 결제자에게 한 번만 간다 | 빈칸 | A | — |
| R-T25 | ③ | 회차 취소·연기 때 진행 중인 양도 요청(추천 적용… | ③ 연기 확정 때 양도 요청이 WITHDRAWN(사유 `EVENT_POSTPONED`)이 되고, 회차 취소 요청은 REFUND_WINDOW에 머물다가 기간이… | 빈칸 | A | — |
| R-T10 | — | 주최 측 귀책 판정, 할인 판매 표 포함 | 배상액이 실제 결제 금액의 10%이고(33,333원 결제는 원 미만 올림으로 3,334원, 기술 검토 낮음-095), PEAKET이 먼저 송금한 뒤 그 금액의… | 빈칸 | A | — |
| R-T11 | — | 배상 계좌 입력 | DB·로그에 계좌번호가 없다(끝 4자리만) | 빈칸 | A | — |
| R-T12 | — | 분쟁 접수 후 영업일 경과 | 3영업일·10영업일 기한 배지와 1영업일 전 알림 | 빈칸 | A | — |
| R-T13 | — | 남용 기준 해당 계정 | 시스템은 표시만 한다. `cs_lead`가 확인하기 전에는 예매할 수 있다. `cs_lead`가 제한을 걸면 예매가 막히고 1일 이상의 소명 기한이 안내된다… | 빈칸 | A | — |
| R-T14 | — | 판매 승인 전 공연 URL 직접 접근 | 404 또는 비공개 안내가 나오고, 대기열에 들어갈 수 없다 | 빈칸 | A | — |
| R-T15 | — | 결제 직전 화면 | 판매자 이름과 중개자 고지 문장이 보이고, 글씨 크기 규칙을 통과한다 | 빈칸 | A | — |
| R-T16 | — | 공연예술통합전산망 시뮬레이터 하루 장애 | 다음 날 누락분을 포함해 보내고, 원장 해시가 일치한다 | 빈칸 | A | — |
| R-T17 | — | 입장 시작 뒤 수락·돌려주기·회수 | 모두 409 `ENTRY_STARTED`이고, 키와 보유자에 변화가 없다 | 빈칸 | A | — |
| R-T18 | — | 재승인 대기 중 공개와 판매: 판매 중인 공연의 가격을 바꾼 뒤 공연… | 재승인을 기다리는 동안 공개·판매는 마지막 승인 가격으로 계속된다. 재승인하면 새 가격이 반영되고 캐시(자주 쓰는 값을 가까운 곳에 복사해 둔 것)가… | 빈칸 | A | — |
| R-T19 | — | 판매 승인 때 결제사 지정 고정: 지정 없는 공연을 승인한 뒤 플랫폼… | 승인할 때 그 시점의 기본값이 그 공연의 회차마다 지정으로 저장되고(결제사 지정은 회차 칸, §2.1 확인 항목 4, 2026-11-01 정합 점검), 배포… | 빈칸 | A | — |
| R-T20 | — | CS 처리함 기한과 재발송: 추가 검증 이의·미보고 스캐너·환불 대기… | 기한 배지(10영업일·3영업일·3영업일)와 1영업일 전 알림이 맞다. 환불 계좌 요청이 다음 영업일·그다음 영업일 10:00과 그 뒤 7일마다 나간다. 실패한… | 빈칸 | A | — |
| R-T21 | ① | 양도 거절·철회의 멱등키와 알림 링크로 들어오는 경우: ① 같은… | ① 두 번째도 처음 결과를 돌려주고 상태는 한 번만 바뀐다 | 빈칸 | A | — |
| R-T21 | ② | 양도 거절·철회의 멱등키와 알림 링크로 들어오는 경우: ① 같은… | ② 400 `idempotency-key-invalid`로 거절된다(키 필수, guidelines §4) | 빈칸 | A | — |
| R-T21 | ③ | 양도 거절·철회의 멱등키와 알림 링크로 들어오는 경우: ① 같은… | ③ 링크의 첫 요청에는 팬 쿠키가 실리지 않고 응답은 정적 셸이다. 양도 요청 조회와 수락·거절은 화면 스크립트가 같은 사이트로 보내는 요청으로 간다 | 빈칸 | A | — |
| R-T26 | ① | 예외 환불의 증빙과 미성년자 계약 취소(추천 적용 2026-10-28… | ① CS 책임자 1인 승인으로 3영업일 안에 환급된다. | 빈칸 | A | — |
| R-T26 | ② | 예외 환불의 증빙과 미성년자 계약 취소(추천 적용 2026-10-28… | ② 확인 사실과 확인자만 기록되고 파일은 저장되지 않는다. | 빈칸 | A | — |
| R-T26 | ③ | 예외 환불의 증빙과 미성년자 계약 취소(추천 적용 2026-10-28… | ③ 휴대폰 본인확인 대조 뒤 CS 책임자 1인이 승인하면 공제 없이 전액이 환급되고 좌석이 취소표로 돌아간다. 생년월일은 DB·로그에 0건이다 | 빈칸 | A | — |
| R-T27 | ① | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ① 201, 접수 번호 토스트, CS 처리함에 '문의' 건. | 빈칸 | A | — |
| R-T27 | ② | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ② 오류 요약 두 줄과 첫 오류로 초점 이동. | 빈칸 | A | — |
| R-T27 | ③ | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ③ 429와 안내 문구. | 빈칸 | A | — |
| R-T27 | ④ | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ④ 진행 경과 3영업일·결과 10영업일 기한이 보인다. | 빈칸 | A | — |
| R-T27 | ⑤ | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ⑤ 문의가 닫히고 추가 문의는 409. | 빈칸 | A | — |
| R-T27 | ⑥ | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ⑥ 없는 문의와 같은 404. | 빈칸 | A | — |
| R-T27 | ⑦ | 고객 문의(추천 적용 2026-10-28, 기술 검토 중간-005):… | ⑦ 유형 목록이 12개이고 첨부 칸이 없다. CS 처리함에 category `RESALE_POST_REPORT`인 '문의' 건이 생긴다. 등록된 수집본(출처… | 빈칸 | A | — |
| R-T28 | ① | 후기 신고와 처리(추천 적용 2026-10-28, 기술 검토… | ① 확인 모달을 거친 뒤 201, 버튼이 비활성 [신고함]. | 빈칸 | A | — |
| R-T28 | ② | 후기 신고와 처리(추천 적용 2026-10-28, 기술 검토… | ② 오류 요약으로 초점이 가고 확인 모달은 열리지 않는다. | 빈칸 | A | — |
| R-T28 | ③ | 후기 신고와 처리(추천 적용 2026-10-28, 기술 검토… | ③ 처음은 오류, 다음은 CS 처리함에 '권리 침해 삭제 요청' 건(기한 1영업일 [가정]). | 빈칸 | A | — |
| R-T28 | ④ | 후기 신고와 처리(추천 적용 2026-10-28, 기술 검토… | ④ 31일은 거부되고, 30일은 후기 자리에 임시조치 공시와 신청인·글쓴이 알림이 생긴다(글쓴이 알림에 신고한 사람이 없다). | 빈칸 | A | — |
| R-T28 | ⑤ | 후기 신고와 처리(추천 적용 2026-10-28, 기술 검토… | ⑤ 접수하자마자 후기와 사진이 가려진다. | 빈칸 | A | — |
| R-T28 | ⑥ | 후기 신고와 처리(추천 적용 2026-10-28, 기술 검토… | ⑥ 409와 429 | 빈칸 | A | — |
| R-T30 | ① | 소명이 들어오는 길(추천 적용 2026-10-30, §7.1 '소명이… | ①은 core DB `appeal`에 한 행, `support.cases-requested`(kind `APPEAL`) 한 건, 그 예매 제한에 이어진 CS… | 빈칸 | A | — |
| R-T30 | ② | 소명이 들어오는 길(추천 적용 2026-10-30, §7.1 '소명이… | ②는 support의 화면용 사본으로 409다. | 빈칸 | A | — |
| R-T30 | ③ | 소명이 들어오는 길(추천 적용 2026-10-30, §7.1 '소명이… | ③은 접수되지만 ops-svc가 '대상 아님'으로 닫고 팬에게 알린다. | 빈칸 | A | — |
| R-T30 | ④ | 소명이 들어오는 길(추천 적용 2026-10-30, §7.1 '소명이… | ④는 그 승인 업무(SCR-046)에 '받은 분 소명 <제출됨>'으로 붙는다. | 빈칸 | A | — |
| R-T30 | ⑤ | 소명이 들어오는 길(추천 적용 2026-10-30, §7.1 '소명이… | ⑤는 Outbox에 남았다가 ops-svc가 돌아오면 건이 한 번만 생긴다. ops-svc로 바로 가는 팬 요청은 0건이다 | 빈칸 | A | — |
| R-T31 | ① | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ① 양도 요청이 WITHDRAWN(사유 `FRAUD_LOCK`)이 되고 티켓은 보낸 사람에게 남는다. 세 티켓의 `fraud_lock_case_id`가 사건… | 빈칸 | A | — |
| R-T31 | ② | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ② 양도 요청은 409 `transfer-locked`이고 키·보유자가 그대로다. 받은 사람의 돌려주기는 성공하고, 돌아온 표는 결제자에게… | 빈칸 | A | — |
| R-T31 | ③ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ③ 공제율대로 환급된다 | 빈칸 | A | — |
| R-T31 | ④ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ④ 한 번 보낸 것과 결과가 같고 옛 판은 무시된다 | 빈칸 | A | — |
| R-T31 | ⑤ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑤ 그 티켓은 바뀌지 않고 응답에 따로 나온다 | 빈칸 | A | — |
| R-T31 | ⑥ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑥ `PERMISSION_DENIED` | 빈칸 | A | — |
| R-T31 | ⑦ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑦ 매번 하나만 먼저 되고, 잠긴 뒤 넘어간 표가 0장이다 | 빈칸 | A | — |
| R-T31 | ⑧ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑧ 잠금이 풀리고 결제자에게 `FRAUD_TRANSFER_LOCK_RELEASED`가 한 번 간다 | 빈칸 | A | — |
| R-T31 | ⑨ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑨ ops-svc 호출 없이 `Ticket.transferLocked`가 거짓이 되고, 풀림 알림은 가지 않는다 | 빈칸 | A | — |
| R-T31 | ⑩ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑩ ops-svc 호출 없이 `Ticket.transferLocked`가 거짓이 되고, ops-svc가 다시 뜨면 사본의 잠금 상태를 풀림으로 보내 풀림 알림이… | 빈칸 | A | — |
| R-T31 | ⑪ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑪ `lockExpiresAt`이 처음 값 그대로다 | 빈칸 | A | — |
| R-T31 | ⑫ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑫ 반려·만료는 잠금이 풀리고, 철회는 잠금이 남는다 | 빈칸 | A | — |
| R-T31 | ⑬ | 부정 예매 양도 잠금(추천 적용 2026-10-31, ADR-0171… | ⑬ "이 회차 표는 부정 예매 조사가 끝날 때까지 양도가 잠깁니다"가 보이고, 결제 뒤 발권한 표도 잠긴다 | 빈칸 | A | — |
| R-T32 | ① | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ① `support.cases-requested`(kind `APPEAL`, category `FRAUD_CASE`) 한 건, 그 사건에 이어진 CS… | 빈칸 | A | — |
| R-T32 | ② | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ② '대상 아님'으로 닫고 알린다 | 빈칸 | A | — |
| R-T32 | ③ | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ③ '기한 경과'로 닫고 알린다 | 빈칸 | A | — |
| R-T32 | ④ | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ④ 없는 건과 같은 404 | 빈칸 | A | — |
| R-T32 | ⑤ | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ⑤이의로 받아 사건이 `OBJECTED`가 된다 | 빈칸 | A | — |
| R-T32 | ⑥ | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ⑥ 그 제한의 사건에 이어지고 처리자가 조사관이다 | 빈칸 | A | — |
| R-T32 | ⑦ | 부정 예매 사건 소명(추천 적용 2026-10-31, ADR-0171… | ⑦ '보유자 진술'로 사건에 이어지고(사건 기록 `APPEAL_RECEIVED`, party `HOLDER`), 사건 계정의 소명 상태와 사건 상태는 바뀌지… | 빈칸 | A | — |
| R-T33 | ① | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ① `order_cancellation`(사유 `FRAUD`, `fraud_case_id`, `approval_id`)이 생기고 공제 0원으로 결제자에게 결정을… | 빈칸 | A | — |
| R-T33 | ② | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ② 그 건만 재시도 큐로 가고, 다 쓰면 CS '환급 실패'다 | 빈칸 | A | — |
| R-T33 | ③ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ③ EXPIRED이고 표가 바뀌지 않는다 | 빈칸 | A | — |
| R-T33 | ④ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ④ 두 건 모두 자동으로 다시 발권되지 않는다. 안 팔린 좌석은 같은 좌석, 팔린 좌석은 같은 등급 남은 좌석의 우선 구매 권리가 생기고, 남은 좌석도 없으면… | 빈칸 | A | — |
| R-T33 | ⑤ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ⑤ 422 | 빈칸 | A | — |
| R-T33 | ⑥ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ⑥ 403, 403 `fraud-approver-ineligible` | 빈칸 | A | — |
| R-T33 | ⑦ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ⑦ 두 경우 모두 409 `fraud-summary-not-viewed`다(연 기록은 승인자마다 따로다) | 빈칸 | A | — |
| R-T33 | ⑧ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ⑧ 422 `approval-reason-required` | 빈칸 | A | — |
| R-T33 | ⑨ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ⑨ 남은 계정의 표만 취소되고, 뺀 계정은 반려된 것으로 보아 다른 열린 조치 요청이 없으면 양도 잠금이 풀린다. 요청 밖이나 모두 빼면 422… | 빈칸 | A | — |
| R-T33 | ⑩ | 부정 예매 표 취소와 환급(추천 적용 2026-10-31… | ⑩ 그 표는 '건너뜀'이고 그대로 남는다 | 빈칸 | A | — |
| R-T34 | ① | 부정 예매 이용 제한(추천 적용 2026-10-31, ADR-0171… | ① `booking_restriction`(사유 `FRAUD`)이 queue-svc·purchase-svc 두 곳에 반영된 뒤 Done이고, 입장 확정과 주문… | 빈칸 | A | — |
| R-T34 | ② | 부정 예매 이용 제한(추천 적용 2026-10-31, ADR-0171… | ② 403 | 빈칸 | A | — |
| R-T34 | ③ | 부정 예매 이용 제한(추천 적용 2026-10-31, ADR-0171… | ③ 제한이 그대로라 막힌다 | 빈칸 | A | — |
| R-T34 | ④ | 부정 예매 이용 제한(추천 적용 2026-10-31, ADR-0171… | ④ 두 곳에서 풀린 뒤 Done | 빈칸 | A | — |
| R-T34 | ⑤ | 부정 예매 이용 제한(추천 적용 2026-10-31, ADR-0171… | ⑤ ops-svc가 다시 보내 Done이 되고, 처리 기한 안에 끝나지 않으면 '승인 업무 실행 실패'다 | 빈칸 | A | — |
| R-T34 | ⑥ | 부정 예매 이용 제한(추천 적용 2026-10-31, ADR-0171… | ⑥ 넘는 요청은 422 `restriction-too-long`이고 승인 업무가 생기지 않는다. 늘리는 요청은 2인 승인 뒤 Done이 되고… | 빈칸 | A | — |
| R-T35 | — | 이의 인정 뒤 우선 구매(추천 적용 2026-10-31… | A는 같은 좌석, B는 같은 등급 좌석의 우선 구매 권리(48시간 [가정], 원래 가격·수수료 없음)가 생기고 팬의 GET… | 빈칸 | A | — |

## docs/security/asvs/transfer-refund.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.1.1 | — | L2 | 입력은 그 형식으로 인코딩된 데이터가 기대될 때만 정규 형식으로 한 번만 디코딩(이스케이프 해제 포함)하고, 검증·정화 같은 다음 처리보다 먼저 한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-1.1.2 | — | L2 | 출력 인코딩·이스케이프는 그 값을 쓰는 해석기 바로 앞의 마지막 단계에서 하거나 해석기가 직접 한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-1.2.1 | — | L1 | HTTP 응답·HTML·XML 출력은 문맥(HTML 요소·속성·주석, CSS, HTTP 헤더)에 맞게 인코딩해 메시지·문서 구조가 바뀌지 않게 한다. | ID만 | A | 다른 곳 시험: apps/web/src/_pages/event-detail/model/detail.test.mjs, apps/web/src/_pages/search/model/search.test.mjs 외 1곳… |
| v5.0.0-1.2.2 | — | L1 | URL을 동적으로 만들 때 신뢰하지 않는 값을 문맥에 맞게 인코딩하고 안전한 프로토콜만 허용한다(`javascript:`·`data:` 금지). | ID만 | A | 다른 곳 시험: apps/web/queue-room/test/preload.test.mjs, packages/api-client/test/policy.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-1.2.3 | — | L1 | JavaScript·JSON을 동적으로 만들 때 인코딩·이스케이프해 구조가 바뀌지 않게 한다. | ID만 | A | 다른 곳 시험: apps/web/src/_pages/event-detail/model/detail.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | ID만 | A | 다른 곳 시험: services/purchase-svc/test-int/booking-restrictions.int.test.ts… |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | 해당 없음 | A | 해당 없음(OS 명령을 부르지 않는다) |
| v5.0.0-1.2.6 | — | L2 | LDAP 주입을 막는다. | 해당 없음 | A | 해당 없음(LDAP을 쓰지 않는다) |
| v5.0.0-1.2.7 | — | L2 | XPath 주입을 쿼리 파라미터화·사전 컴파일로 막는다. | 해당 없음 | A | 해당 없음(XPath를 쓰지 않는다) |
| v5.0.0-1.2.8 | — | L2 | LaTeX 처리기를 안전하게 설정하고(`--shell-escape` 금지) 명령 허용 목록을 쓴다. | 해당 없음 | A | 해당 없음(LaTeX을 쓰지 않는다) |
| v5.0.0-1.2.9 | — | L2 | 정규식의 특수 문자를 이스케이프해 메타 문자로 해석되지 않게 한다. | 해당 없음 | A | 해당 없음(사용자 값을 정규식에 넣지 않는다. 받는 사람 조회는 정규화한 값의 정확한 일치로 찾는다) |
| v5.0.0-1.3.1 | — | L1 | WYSIWYG 편집기 등에서 오는 신뢰하지 않는 HTML 입력은 모두 잘 알려진 안전한 HTML 정화 라이브러리나 프레임워크 기능으로 정화한다. | 해당 없음 | A | 해당 없음(소명·사유·CS 메모는 HTML을 받지 않는 평문이다) |
| v5.0.0-1.3.2 | — | L1 | `eval()` 같은 동적 코드 실행을 피하고, 불가피하면 사용자 입력을 실행 전에 정화한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-1.3.3 | — | L2 | 위험할 수 있는 문맥에 넘기는 데이터는 그 문맥에 안전한 문자만 허용하고 너무 긴 입력을 자르는 등 미리 정화한다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts 외 2곳 (영역: 아직 코드가 없다) |
| v5.0.0-1.3.4 | — | L2 | 사용자가 준 SVG는 애플리케이션에 안전한 태그·속성만 담도록 검증하거나 정화한다(`script`·`foreignObject` 제외). | 해당 없음 | A | 해당 없음(파일을 받지 않는다. 회차 취소 증빙도 문서의 종류·번호만 적는다, 3.2.1) |
| v5.0.0-1.3.5 | — | L2 | 사용자가 넣은 Markdown·CSS·XSL·BBCode 같은 스크립트·표현식 템플릿 내용을 정화하거나 끈다. | 해당 없음 | A | 해당 없음(소명·사유를 Markdown 같은 형식으로 해석하지 않고 평문으로만 보인다) |
| v5.0.0-1.3.6 | — | L2 | 다른 서비스를 부르는 데 쓰기 전에 신뢰하지 않는 값을 프로토콜·도메인·경로·포트 허용 목록과 대조하고 위험할 수 있는 문자를 정화해 SSRF를 막는다. | 해당 없음 | A | 해당 없음(사용자가 준 주소로 요청을 보내지 않는다. 송금·공연예술통합전산망 주소는 설정에 고정한다) |
| v5.0.0-1.3.7 | — | L2 | 신뢰하지 않는 입력으로 템플릿을 만들지 않아 템플릿 주입을 막고, 불가피하면 템플릿에 넣는 신뢰하지 않는 입력을 정화하거나 엄격히 검증한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-1.3.8 | — | L2 | JNDI 조회에 넣기 전에 입력을 정화하고 JNDI를 안전하게 설정한다. | 해당 없음 | A | 해당 없음(JNDI를 쓰지 않는다) |
| v5.0.0-1.3.9 | — | L2 | memcache로 보내기 전에 내용을 정화한다. | 해당 없음 | A | 해당 없음(memcache를 쓰지 않는다) |
| v5.0.0-1.3.10 | — | L2 | 예상과 다르거나 악의적으로 해석될 수 있는 형식 문자열은 처리 전에 정화한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-1.3.11 | — | L2 | 메일 시스템에 넘기기 전에 사용자 입력을 정화해 SMTP·IMAP 주입을 막는다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-1.4.1 | — | L2 | 메모리 안전한 문자열·메모리 복사·포인터 연산으로 스택·버퍼·힙 오버플로를 찾아내거나 막는다. | 해당 없음 | A | 해당 없음(애플리케이션 코드는 메모리 관리 언어(TypeScript)다) |
| v5.0.0-1.4.2 | — | L2 | 부호·범위·입력 검증으로 정수 오버플로를 막는다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-1.4.3 | — | L2 | 할당한 메모리와 자원을 해제하고 해제된 참조를 지워 use-after-free를 막는다. | 해당 없음 | A | 해당 없음(메모리 관리 언어만 쓴다) |
| v5.0.0-1.5.1 | — | L1 | XML 파서를 제한적으로 설정하고 외부 엔터티 해석 같은 위험 기능을 꺼 XXE를 막는다. | 해당 없음 | A | 해당 없음(XML을 파싱하지 않는다. 공연예술통합전산망 연동 규격이 XML 응답이면 규격을 받을 때 다시 판정한다) |
| v5.0.0-1.5.2 | — | L2 | 신뢰하지 않는 데이터의 역직렬화는 허용 객체 타입 목록 등으로 안전하게 처리하고, 안전하지 않다고 알려진 방식은 쓰지 않는다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/end-purchase-session.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts… |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/seat-layout.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | ID만 | A | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/args090.test.mjs 외 66곳 (영역: 아직 코드가 없다) |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-confirm-runne… |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-deposit.int.t… |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | ID만 | A | 다른 곳 시험: services/admission-ctrl/test/admission-leader.test.ts, services/admission-ctrl/test/aimd.test.ts 외 23곳 (영역: 아직… |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts… |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | ID만 | A | 다른 곳 시험: packages/platform/test-int/idempotency.int.test.ts, packages/platform/test-int/template.int.test.ts 외 49곳 (영역:… |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | ID만 | A | 다른 곳 시험: services/core-svc/test/wish.http.test.ts, services/identity-svc/test/login-verdict.test.ts 외 23곳 (영역: 아직 코드가… |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | ID만 | A | 다른 곳 시험: services/admission-ctrl/test/result-files.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 2곳 (영역:… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | ID만 | A | 다른 곳 시험: apps/web/src/_pages/shuffle-proof/model/proof-view.test.mjs, services/v0-monolith/test-int/seat.int.test.ts… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | ID만 | A | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | A | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | ID만 | A | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | ID만 | A | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test/http.test.ts 외 2곳… |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | A | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역: 아직… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | A | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | ID만 | A | 다른 곳 시험: apps/web/server/csp-hash-server.test.mjs, apps/web/src/_app/security/page-headers.test.mjs 외 4곳 (영역: 아직 코드가 없다) |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | A | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | A | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | ID만 | A | 다른 곳 시험: apps/web/src/_app/security/page-headers.test.mjs, packages/config/headers/headers.test.mjs 외 1곳 (영역: 아직 코드가 없다) |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | ID만 | A | 다른 곳 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs 외… |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | A | 다른 곳 시험: packages/platform/test/content-type.test.ts, services/queue-svc/test/admission.test.ts 외 2곳 (영역: 아직 코드가 없다) |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | A | 다른 곳 시험: services/queue-svc/test/leave-http.test.ts, services/queue-svc/test/shuffle-proof.test.ts 외 1곳 (영역: 아직 코드가 없다) |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 해당 없음 | A | 해당 없음: 이 기능 화면은 창 메시지(`postMessage`)를 받지 않는다. 양도·취소 전 소셜 재인증 흐름은 auth.md가 판정한다 |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | ID만 | A | 다른 곳 시험: apps/web/src/_pages/login/model/state.test.mjs, apps/web/src/features/identity-verify/flow.test.mjs 외 5곳 (영역:… |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | ID만 | A | 다른 곳 시험: services/core-svc/test/event-summary.http.test.ts, services/core-svc/test/partner-production.http.test.ts 외 2곳… |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | ID만 | A | 다른 곳 시험: packages/platform/test/auth-guard.test.ts, services/core-svc/test/partner-directory.http.test.ts 외 22곳 (영역: 아직… |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | ID만 | A | 다른 곳 시험: services/core-svc/test/partner-production.http.test.ts, services/identity-svc/test-int/device-sessions.int.test… |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | ID만 | A | 다른 곳 시험: packages/contracts/test/close-additional-properties.test.ts, packages/contracts/test/types.test.ts 외 5곳 (영역:… |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | ID만 | A | 다른 곳 시험: services/core-svc/test-int/rls.int.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-9.1.1 | — | L1 | 자체 완결형 토큰은 서명이나 MAC을 검증한 뒤에만 내용을 받아들인다. | ID만 | A | 다른 곳 시험: packages/platform/test/purchase-auth.test.ts, packages/platform/test/token-verify.test.ts 외 15곳 (영역: 아직 코드가 없다) |
| v5.0.0-9.1.2 | — | L1 | 자체 완결형 토큰의 생성·검증에는 맥락별 허용 목록의 알고리즘만 쓰고(`none` 제외, 되도록 대칭·비대칭 중 한쪽만), 둘 다 써야 하면 키 혼동을 막는… | ID만 | A | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/purchase-svc/test/admission-token.test.ts 외 5곳 (영역: 아직… |
| v5.0.0-9.1.3 | — | L1 | 검증 키는 미리 정한 신뢰 출처에서만 얻고 `jku`·`x5u`·`jwk` 헤더를 허용 목록으로 검증한다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/admission-token.test.ts, services/queue-svc/test/tokens.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-9.2.1 | — | L1 | 유효 기간이 있으면 검증 시각이 그 안일 때만 받는다(`nbf`·`exp`). | ID만 | A | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/purchase-svc/test-int/purchase-session.int.test.ts 외 11곳… |
| v5.0.0-9.2.2 | — | L2 | 토큰 종류와 목적이 맞는지 확인한 뒤 받는다. | ID만 | A | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/identity-svc/test/passkey-cases.ts 외 4곳 (영역: 아직 코드가 없다) |
| v5.0.0-9.2.3 | — | L2 | 그 서비스를 위한 토큰(`aud`)만 받는다. | ID만 | A | 다른 곳 시험: packages/platform/test/token-verify.test.ts, services/purchase-svc/test/admission-token.test.ts 외 4곳 (영역: 아직… |
| v5.0.0-9.2.4 | — | L2 | 같은 개인 키로 여러 대상에 토큰을 발급하면 대상을 고유하게 나타내는 대상 제한을 넣고, 대상 식별자를 동적으로 정하면 발급자가 그 대상을 검증해 대상 사칭을… | ID만 | A | 다른 곳 시험: packages/platform/test/token-verify.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | ID만 | A | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test/quicknet-verifier.test.ts 외 1곳… |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | A | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | ID만 | A | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/payment-svc/test/portone-gateway.test.ts (영역: 아직… |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | 해당 없음 | A | 해당 없음: 이 기능은 데이터를 암호화하지 않는다. 환불·배상 계좌는 저장하지 않고 결제사·송금 요청에 바로 넘긴다(POL-014, ADR-0050 결정 3) |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | 해당 없음 | A | 해당 없음: 11.3.1과 같다 |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | 해당 없음 | A | 해당 없음: 11.3.1과 같다 |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | ID만 | A | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | A | 해당 없음: 이 기능에는 비밀번호가 없다. 관리 계정 재인증은 계정·인증 추적 표가 맡는다 |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | ID만 | A | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | A | 해당 없음: 비밀번호에서 키를 만들지 않는다 |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | ID만 | A | 다른 곳 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 5곳 (영역:… |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | ID만 | A | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test-int/kms-seed.int.test.ts 외 4곳… |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | A | 다른 곳 시험: services/v0-monolith/test-int/gate.int.test.ts, services/v0-monolith/test-int/queue.int.test.ts 외 3곳 (영역: 아직… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | ID만 | A | 다른 곳 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.t… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | A | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역: 아직 코드가… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | ID만 | A | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, packages/platform/test-int/held-events.int.test.ts 외 14곳 (영역: 아직 코드가 없다) |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | ID만 | A | 다른 곳 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account-http.test.ts 외… |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | A | 다른 곳 시험: tools/web-checks/static/assets.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-confirm-run… |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | ID만 | A | 다른 곳 시험: packages/platform/test-int/maintenance.int.test.ts, packages/platform/test/circuit-breaker.test.ts 외 3곳 (영역:… |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-new-pause.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외… |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | ID만 | A | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역: 아직 코드가… |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | ID만 | A | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/accept-http.test.ts 외 2곳 (영역: 아직 코드가… |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | A | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/validation/test/validation.test.ts 외 2곳 (영역: 아직 코드가 없다) |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | ID만 | A | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 1곳 (영역:… |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | A | 다른 곳 시험: packages/platform/test/request-log.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | ID만 | A | 다른 곳 시험: loadtest/test/before090.test.mjs, loadtest/test/lib.test.mjs 외 76곳 (영역: 아직 코드가 없다) |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외… |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | ID만 | A | 다른 곳 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/accept-payment.test.ts 외 1곳 (영역: 아직… |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test-int/payment-reconciliation… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | ID만 | A | 다른 곳 시험: packages/platform/test/redis.test.ts, packages/platform/test/request-log.test.ts 외 53곳 (영역: 아직 코드가 없다) |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | ID만 | A | 다른 곳 시험: packages/platform/test/request-log.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | A | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | ID만 | A | 다른 곳 시험: packages/platform/test-int/kafka.int.test.ts, packages/platform/test-int/outbox.int.test.ts 외 84곳 (영역: 아직 코드가… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | ID만 | A | 다른 곳 시험: packages/platform/test/circuit-breaker.test.ts, services/payment-svc/test-int/payment-call-guard.int.test.ts 외… |
| v5.0.0-2.3.5 | — | L3 | 고가치 업무 흐름에는 여러 사람의 승인을 요구한다. | 빈칸 | A | 영역: 아직 코드가 없다 |
| v5.0.0-14.2.7 | — | L3 | 민감 정보에 보존 등급을 매기고, 쓸모없어진 데이터를 정한 일정이나 상황에 따라 자동으로 지운다. | ID만 | A | 다른 곳 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts… |
| v5.0.0-15.4.2 | — | L3 | 자원 상태 확인과 그 상태에 따른 동작을 원자적으로 해서 확인 시점과 사용 시점의 경합(TOCTOU)을 막는다. | ID만 | A | 다른 곳 시험: services/admission-ctrl/test-int/batch-store.int.test.ts, services/admission-ctrl/test-int/leader-store.int.tes… |
