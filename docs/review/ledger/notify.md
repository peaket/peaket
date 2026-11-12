# 완성 장부: notify

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/notify.md`, `docs/security/asvs/notify.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 0 | 103 | 0 | 0 | 0 | 0 | 0 | 21 | 55 | 179 |
| 합계 | 0 | 103 | 0 | 0 | 0 | 0 | 0 | 21 | 55 | 179 |

## docs/features/notify.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| N-T1 | ① | 오픈 알림 내용(V-T36 ①): 오픈 알림을 구독한 계정 둘(본인확인… | ①이메일은 대기실이 열리는 시각을, | 빈칸 | B | — |
| N-T1 | ② | 오픈 알림 내용(V-T36 ①): 오픈 알림을 구독한 계정 둘(본인확인… | ② 본인확인 안내 푸시도 간다. 연결: FR-004 | 빈칸 | B | — |
| N-T1 | ③ | 오픈 알림 내용(V-T36 ①): 오픈 알림을 구독한 계정 둘(본인확인… | ③ 웹 푸시는 대기실이 열렸다는 것과 오픈 시각을 적고(docs/design/d5 §9.1 문안), 안 마친 계정의 메시지에는 본인확인 버튼이 있는 공연 상세… | 빈칸 | B | — |
| N-T2 | — | 같은 사건 두 번(V-T36 ②): 같은 결제 확정 사건을… | 받는 사람은 채널마다 한 번만 받는다. 발송 행은 하나다. 연결: FR-040 | 빈칸 | B | — |
| N-T3 | — | 밤 신청 알림(V-T36 ③): 22:10 KST에 취소표가 나왔고… | 켠 사람은 웹 푸시와 이메일을, 끈 사람은 이메일만 받는다. 밤 판정은 보내는 순간의 시각으로 한다. 연결: FR-018, FR-040 | 빈칸 | B | — |
| N-T4 | — | 광고 밤 금지(V-T36 ④): 광고 알림을 20:59와 21:00에… | 20:59는 나가고 21:00은 어느 채널로도 나가지 않는다(docs/design/d5 §9.1.1)… | 빈칸 | B | — |
| N-T5 | — | 파트너 웹훅 끝까지 실패(V-T36 ⑤): 파트너 웹훅을 받는 서버가… | 정한 간격으로 다시 보낸 뒤 DEAD(DLQ: 처리에 실패한 메시지를 따로 모아 두는 곳)로 가고(V-T24), 파트너 콘솔에 오류가 보인다. 연결:… | 빈칸 | B | — |
| N-T6 | — | 대량 발송 속도와 퍼짐: 로컬에서 신청 10만 [가정]과 푸시 서비스… | 초당 발송 수가 '대상 ÷ 창'의 ±20% [가정] 안이고, 창 끝 + 30초 안에 99%를 시도한다. 받는 사람마다 만든 행(작업·기록·중복 키)은 0이고… | 빈칸 | B | — |
| N-T7 | — | 푸시 서비스 응답 처리: 흉내 서비스가 201·404·410·403(VA… | 404·410·403 구독은 지워진다. 429는 `Retry-After`를 지키고 그 서비스 몫이 줄었다가 되오른다. 5xx는 남은 TTL 안에서만 다시… | 빈칸 | B | — |
| N-T8 | — | 웹 푸시 구독 등록 검사: `http://` 주소, 포트 8443… | 앞의 다섯은 422이고 행이 없다(사설 IP로 풀리는 이름은 보낼 때도 연결하지 않는다). 11번째는 가장 오래 쓰지 않은 구독을 지운다. 남의 키 해제는… | 빈칸 | B | — |
| N-T9 | ① | 계획이 바뀜: ① 뒤에 `open_at`을 1시간 미룬다, ② 오픈… | ① 옛 판 발송은 CANCELLED이고 새 판 … 이 "오픈 시각이 바뀌었습니다"로 간다. | 빈칸 | B | — |
| N-T9 | ② | 계획이 바뀜: ① 뒤에 `open_at`을 1시간 미룬다, ② 오픈… | ② 발송이 모두 취소되고 취소 안내 이메일이 한 통 간다. | 빈칸 | B | — |
| N-T9 | ③ | 계획이 바뀜: ① 뒤에 `open_at`을 1시간 미룬다, ② 오픈… | ③ 아무것도 가지 않는다. … 푸시를 한 번 받는다. 연결: FR-004 | 빈칸 | B | — |
| N-T9 | ④ | 계획이 바뀜: ① 뒤에 `open_at`을 1시간 미룬다, ② 오픈… | ④ 낱건으로 | 빈칸 | B | — |
| N-T10 | — | 취소표 차례: 매진 풀림을 10분 안에 세 번, 그 뒤 네 번 더… | 차례는 10분에 하나다. 다시 매진되면 남은 조각이 취소되고 보낸 횟수가 오르지 않는다. 다섯 번째 알림에 '신청을 마쳤습니다'가 있고 상태가… | 빈칸 | B | — |
| N-T11 | — | 찜: 같은 공연에 `PUT`을 두 번, `DELETE`를 두 번… | 결과는 한 번 한 것과 같다. 1,001번째는 422, 공개 전은 404다. 201번째 신청은 422 `subscription-limit`, 오픈이 지난 회차의… | 빈칸 | B | — |
| N-T12 | — | 한 번 누름 수신 거부: List-Unsubscribe=One-Clic… | 첫 요청에 그 신청만 지워진다. 다시 보낸 요청·위조한 토큰·맞지 않는 HMAC은 모두 같은 200이고, `GET`은 이 경로에 없어 받지… | 빈칸 | B | — |
| N-T13 | — | 이메일 대행 응답: 흉내 대행사가 429·5xx·시간 초과·결과 모름을… | 신청 알림은 결과 모름에 다시 보내지 않고, 환급 완료(돈) 알림은 상태 확인 뒤 한 번 더 간다. 스팸 신고가 온 신청은 지워진다. 쓸모 기한이 지난 작업은… | 빈칸 | B | — |
| N-T14 | — | 알림 문구 변수: 이메일·전화번호가 든 값과 허용 목록 밖 키로 작업을… | 작업이 만들어지지 않고 오류로 센다. 표 어디에도 받는 주소·전화번호·본문이 없다. 연결: FR-040 | 빈칸 | B | — |
| N-T15 | — | 파트너 웹훅 관리: 실무자가 재발급·다시 보내기를 부른다, 다른… | 실무자는 403, 남의 행은 404, 판 불일치는 412다. 다시 보낸 것은 같은 `webhook-id`이고 새 `webhook-timestamp`다. 계속… | 빈칸 | B | — |
| N-T16 | ① | 부정 예매 알림(추천 적용 2026-10-31… | ①은 알림이 늘지 않는다 | 빈칸 | B | — |
| N-T16 | ② | 부정 예매 알림(추천 적용 2026-10-31… | ②는 결제자에게 `FRAUD_ACTION_NOTICE`('3영업일 안에 원래 결제 수단으로 전액 환급합니다')와, 잠긴 표 가운데 받은 사람의 표가 남아… | 빈칸 | B | — |
| N-T16 | ③ | 부정 예매 알림(추천 적용 2026-10-31… | ③은 그 결제자에게 `FRAUD_TRANSFER_LOCK_RELEASED`가 한 통 간다 | 빈칸 | B | — |
| N-T16 | ④ | 부정 예매 알림(추천 적용 2026-10-31… | ④는 풀림 알림이 가지 않고 `notified_lock_active`만 거짓이 된다. 어느 경우든 풀린 뒤에도 사본의 `locked_ticket_ids`는… | 빈칸 | B | — |
| N-T16 | ⑤ | 부정 예매 알림(추천 적용 2026-10-31… | ⑤는 풀림 알림이 가지 않고 `notified_lock_active`만 거짓이 된다. 어느 경우든 풀린 뒤에도 사본의 `locked_ticket_ids`는… | 빈칸 | B | — |

## docs/security/asvs/notify.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.1.1 | — | L2 | 입력은 그 형식으로 인코딩된 데이터가 기대될 때만 정규 형식으로 한 번만 디코딩(이스케이프 해제 포함)하고, 검증·정화 같은 다음 처리보다 먼저 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 (영역:… |
| v5.0.0-1.1.2 | — | L2 | 출력 인코딩·이스케이프는 그 값을 쓰는 해석기 바로 앞의 마지막 단계에서 하거나 해석기가 직접 한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, tools/web-checks/rich-text/seatmap-editor.spec.mj… |
| v5.0.0-1.2.1 | — | L1 | HTTP 응답·HTML·XML 출력은 문맥(HTML 요소·속성·주석, CSS, HTTP 헤더)에 맞게 인코딩해 메시지·문서 구조가 바뀌지 않게 한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs… |
| v5.0.0-1.2.2 | — | L1 | URL을 동적으로 만들 때 신뢰하지 않는 값을 문맥에 맞게 인코딩하고 안전한 프로토콜만 허용한다(`javascript:`·`data:` 금지). | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/preload.test.mjs, packages/api-client/test/policy.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-1.2.3 | — | L1 | JavaScript·JSON을 동적으로 만들 때 인코딩·이스케이프해 구조가 바뀌지 않게 한다. | ID만 | B | 다른 곳 시험: apps/web/src/_pages/event-detail/model/detail.test.mjs, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts, services/purchase-svc/test-int/booking-restrictions.int.test.ts 외… |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | 해당 없음 | B | 해당 없음(OS 명령을 부르지 않는다) |
| v5.0.0-1.2.6 | — | L2 | LDAP 주입을 막는다. | 해당 없음 | B | 해당 없음(LDAP을 쓰지 않는다) |
| v5.0.0-1.2.7 | — | L2 | XPath 주입을 쿼리 파라미터화·사전 컴파일로 막는다. | 해당 없음 | B | 해당 없음(XPath를 쓰지 않는다) |
| v5.0.0-1.2.8 | — | L2 | LaTeX 처리기를 안전하게 설정하고(`--shell-escape` 금지) 명령 허용 목록을 쓴다. | 해당 없음 | B | 해당 없음(LaTeX을 쓰지 않는다) |
| v5.0.0-1.2.9 | — | L2 | 정규식의 특수 문자를 이스케이프해 메타 문자로 해석되지 않게 한다. | 해당 없음 | B | 해당 없음(사용자 값을 정규식에 넣지 않는다. 알림 문구 변수의 이메일·전화번호 꼴 검사는 고정 정규식이다) |
| v5.0.0-1.3.1 | — | L1 | WYSIWYG 편집기 등에서 오는 신뢰하지 않는 HTML 입력은 모두 잘 알려진 안전한 HTML 정화 라이브러리나 프레임워크 기능으로 정화한다. | 해당 없음 | B | 해당 없음(HTML 입력을 받지 않는다) |
| v5.0.0-1.3.2 | — | L1 | `eval()` 같은 동적 코드 실행을 피하고, 불가피하면 사용자 입력을 실행 전에 정화한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-1.3.3 | — | L2 | 위험할 수 있는 문맥에 넘기는 데이터는 그 문맥에 안전한 문자만 허용하고 너무 긴 입력을 자르는 등 미리 정화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts, services/purchase-svc/test/hold-seats.test.ts 외 3곳 (영역: 아직 코드가 없다) |
| v5.0.0-1.3.4 | — | L2 | 사용자가 준 SVG는 애플리케이션에 안전한 태그·속성만 담도록 검증하거나 정화한다(`script`·`foreignObject` 제외). | 해당 없음 | B | 해당 없음(SVG를 받지 않는다) |
| v5.0.0-1.3.5 | — | L2 | 사용자가 넣은 Markdown·CSS·XSL·BBCode 같은 스크립트·표현식 템플릿 내용을 정화하거나 끈다. | 해당 없음 | B | 해당 없음(알림 문구 템플릿은 코드에 고정하고, 사용자가 넣은 Markdown·CSS 같은 템플릿 내용을 받지 않는다) |
| v5.0.0-1.3.6 | — | L2 | 다른 서비스를 부르는 데 쓰기 전에 신뢰하지 않는 값을 프로토콜·도메인·경로·포트 허용 목록과 대조하고 위험할 수 있는 문자를 정화해 SSRF를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-1.3.7 | — | L2 | 신뢰하지 않는 입력으로 템플릿을 만들지 않아 템플릿 주입을 막고, 불가피하면 템플릿에 넣는 신뢰하지 않는 입력을 정화하거나 엄격히 검증한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-1.3.8 | — | L2 | JNDI 조회에 넣기 전에 입력을 정화하고 JNDI를 안전하게 설정한다. | 해당 없음 | B | 해당 없음(JNDI를 쓰지 않는다) |
| v5.0.0-1.3.9 | — | L2 | memcache로 보내기 전에 내용을 정화한다. | 해당 없음 | B | 해당 없음(memcache를 쓰지 않는다) |
| v5.0.0-1.3.10 | — | L2 | 예상과 다르거나 악의적으로 해석될 수 있는 형식 문자열은 처리 전에 정화한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-1.3.11 | — | L2 | 메일 시스템에 넘기기 전에 사용자 입력을 정화해 SMTP·IMAP 주입을 막는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-1.4.1 | — | L2 | 메모리 안전한 문자열·메모리 복사·포인터 연산으로 스택·버퍼·힙 오버플로를 찾아내거나 막는다. | 해당 없음 | B | 해당 없음(애플리케이션 코드는 메모리 관리 언어(TypeScript)다) |
| v5.0.0-1.4.2 | — | L2 | 부호·범위·입력 검증으로 정수 오버플로를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test/media-rules.test.ts 외 3곳 (영역:… |
| v5.0.0-1.4.3 | — | L2 | 할당한 메모리와 자원을 해제하고 해제된 참조를 지워 use-after-free를 막는다. | 해당 없음 | B | 해당 없음(메모리 관리 언어만 쓴다) |
| v5.0.0-1.5.1 | — | L1 | XML 파서를 제한적으로 설정하고 외부 엔터티 해석 같은 위험 기능을 꺼 XXE를 막는다. | 해당 없음 | B | 해당 없음(XML을 파싱하지 않는다) |
| v5.0.0-1.5.2 | — | L2 | 신뢰하지 않는 데이터의 역직렬화는 허용 객체 타입 목록 등으로 안전하게 처리하고, 안전하지 않다고 알려진 방식은 쓰지 않는다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, packages/validation/test/sale-policy.test.ts 외… |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test/sale-eligibility.http.test.ts 외 7곳 (영역:… |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 5곳… |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/args090.test.mjs 외 77곳 (영역: 아직 코드가 없다) |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/save-answer.test.mjs… |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/catalog.int.test.ts 외 34곳 (영역: 아직 코드가… |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-deposit.int.t… |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/admission-ctrl/test/admission-leader.test.ts 외 34곳 (영역:… |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts… |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/idempotency.int.test.ts, packages/platform/test-int/template.int.test.ts 외 49곳 (영역:… |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | ID만 | B | 다른 곳 시험: services/core-svc/test/wish.http.test.ts, services/identity-svc/test/login-verdict.test.ts 외 24곳 (영역: 아직 코드가… |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/result-files.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test/http.test.ts 외 2곳… |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역: 아직… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs, apps/web/server/csp-hash-server.test.mjs 외 5곳 (영역:… |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | ID만 | B | 다른 곳 시험: apps/web/src/_app/security/page-headers.test.mjs, packages/config/headers/headers.test.mjs 외 1곳 (영역: 아직 코드가 없다) |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | ID만 | B | 다른 곳 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs 외… |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/queue-svc/test/leave-http.test.ts 외 3곳 (영역: 아직… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs, apps/web/src/features/identity-verify/flow.test.mjs… |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/verify-return.test.mjs, apps/web/src/_pages/login/model/state.test.mjs 외 8곳 (영역: 아직… |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | ID만 | B | 다른 곳 시험: services/purchase-svc/test/http.test.ts, services/v0-monolith/test-int/queue.int.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-4.1.2 | — | L2 | 브라우저로 직접 여는 사용자 화면만 HTTP에서 HTTPS로 자동 리디렉션하고, 그 밖의 서비스·엔드포인트는 리디렉션하지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-4.1.3 | — | L2 | 로드밸런서·프록시·BFF 같은 중간 계층이 넣어 애플리케이션이 쓰는 헤더(`X-Real-IP`·`X-Forwarded-*`·`X-User-ID` 등)는 최종… | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 4곳… |
| v5.0.0-4.2.1 | — | L2 | 로드밸런서·방화벽 등 모든 구성요소가 HTTP 버전에 맞게 메시지 경계를 정해 요청 밀반입을 막는다(HTTP/1.x는 `Transfer-Encoding`이… | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-4.3.1 | — | L2 | 허용 쿼리 목록, 깊이·개수 제한, 쿼리 비용 분석 가운데 하나 이상으로 비싼 중첩 쿼리에 의한 GraphQL·데이터 계층 표현식 서비스 거부를 막는다. | 해당 없음 | B | 해당 없음(GraphQL을 쓰지 않는다) |
| v5.0.0-4.3.2 | — | L2 | GraphQL을 외부에 공개하는 경우가 아니면 운영 환경에서 인트로스펙션을 끈다. | 해당 없음 | B | 해당 없음(GraphQL을 쓰지 않는다) |
| v5.0.0-4.4.1 | — | L1 | 모든 WebSocket 연결에 WSS를 쓴다. | 해당 없음 | B | 해당 없음(이 기능은 연결을 열어 둔 채 서버와 브라우저가 주고받는 통신 방식인 WebSocket을 쓰지 않는다) |
| v5.0.0-4.4.2 | — | L2 | WebSocket 첫 HTTP 핸드셰이크에서 `Origin`을 허용 출처 목록과 대조한다. | 해당 없음 | B | 해당 없음(WebSocket 미사용) |
| v5.0.0-4.4.3 | — | L2 | 표준 세션 관리를 쓸 수 없으면 세션 관리 요구사항을 따르는 전용 토큰을 쓴다. | 해당 없음 | B | 해당 없음(WebSocket 미사용) |
| v5.0.0-4.4.4 | — | L2 | 전용 WebSocket 세션 토큰은 인증된 HTTPS 세션으로 처음 받거나 검증한다. | 해당 없음 | B | 해당 없음(WebSocket 미사용) |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/event-summary.http.test.ts, services/core-svc/test/partner-production.http.test.ts 외 3곳… |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, packages/platform/test/auth-guard.test.ts 외 28곳… |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 39곳 (영역:… |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | ID만 | B | 다른 곳 시험: packages/contracts/test/close-additional-properties.test.ts, packages/contracts/test/types.test.ts 외 6곳 (영역:… |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 4곳 (영역:… |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test/quicknet-verifier.test.ts 외 1곳… |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/payment-svc/test/portone-gateway.test.ts (영역: 아직… |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/virtual-account-deposit.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | ID만 | B | 다른 곳 시험: packages/shuffle/test/drand-seal.test.ts, services/admission-ctrl/test/kms-seed-opener.test.ts 외 3곳 (영역: 아직… |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.te… |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | B | 해당 없음(이 기능은 비밀번호를 저장하지 않는다) |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음(비밀번호에서 키를 만들지 않는다) |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | ID만 | B | 다른 곳 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 5곳 (영역:… |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test-int/kms-seed.int.test.ts 외 4곳… |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-server.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/consumers.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-13.2.1 | — | L2 | 표준 사용자 세션을 쓰지 않는 백엔드 구성 요소 사이 통신을 개별 서비스 계정·단기 토큰·인증서로 인증하고, 바뀌지 않는 비밀번호·API 키를 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/portone-gateway.int.test.ts, services/payment-svc/test-int/toss-gateway.int.test… |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | ID만 | B | 다른 곳 시험: loadtest/test/manifests090.test.mjs, loadtest/test/review060.test.mjs 외 9곳 (영역: 아직 코드가 없다) |
| v5.0.0-13.2.3 | — | L2 | 서비스 인증에 기본 자격 증명을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-13.2.4 | — | L2 | 애플리케이션이 통신할 수 있는 외부 자원의 허용 목록을 정의한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts 외 1곳 (영역: 아직… |
| v5.0.0-13.2.5 | — | L2 | 서버가 요청을 보내거나 자원을 불러올 수 있는 대상의 허용 목록을 설정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/payment-svc/test/portone-config.test.ts 외 2곳… |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 13곳 (영역: 아직 코드가 없다) |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 5곳… |
| v5.0.0-13.4.1 | — | L1 | 배포물에 `.git`·`.svn` 같은 소스 관리 메타데이터가 없거나, 있어도 외부와 애플리케이션 모두 접근할 수 없다. | ID만 | B | 다른 곳 시험: apps/web/server/deployment-id.test.mjs, tools/ci/image-smoke.test.mjs 외 1곳 (영역: 아직 코드가 없다) |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts, services/pg-simulator/test/simulator.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-13.4.3 | — | L2 | 의도한 경우가 아니면 웹 서버가 디렉터리 목록을 보여 주지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-13.4.4 | — | L2 | 운영 환경에서 HTTP TRACE 메서드를 지원하지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/metrics.test.ts, services/pg-simulator/test/simulator.test.ts 외 2곳 (영역: 아직 코드가 없다) |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | ID만 | B | 다른 곳 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.t… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts (영역: 아직 코드가… |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역: 아직 코드가… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, packages/platform/test-int/held-events.int.test.ts 외 15곳 (영역: 아직 코드가 없다) |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | ID만 | B | 다른 곳 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account-http.test.ts 외… |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | ID만 | B | 다른 곳 시험: tools/ci/vuln-deadline.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | B | 다른 곳 시험: tools/ci/sbom-find.test.mjs, tools/web-checks/static/assets.test.mjs (영역: 아직 코드가 없다) |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, apps/partner/src/_pages/seatmap-editor/model/work… |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/maintenance.int.test.ts, packages/platform/test/circuit-breaker.test.ts 외 6곳 (영역:… |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, services/payment-svc/test-int/payment-new-pause.int.test.ts… |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, packages/platform/test/telemetry.test.ts 외 2곳 (영역: 아직 코드가 없다) |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 3곳 (영역:… |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | B | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/config/eslint/js-security.test.mjs 외 4곳 (영역: 아직 코드가 없다) |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 1곳 (영역:… |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/production-image.int.test.ts (영역: 아직… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | ID만 | B | 다른 곳 시험: loadtest/test/before090.test.mjs, loadtest/test/lib.test.mjs 외 78곳 (영역: 아직 코드가 없다) |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외… |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.t… |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.t… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | ID만 | B | 다른 곳 시험: packages/platform/test/redis.test.ts, packages/platform/test/request-log.test.ts 외 54곳 (영역: 아직 코드가 없다) |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 1곳 (영역: 아직… |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/kafka.int.test.ts, packages/platform/test-int/outbox.int.test.ts 외 87곳 (영역: 아직 코드가… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/circuit-breaker.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 71곳… |
| v5.0.0-4.1.5 | — | L3 | 아주 민감하거나 여러 시스템을 거치는 요청·거래에는 전송 보호 위에 메시지마다 디지털 서명을 더한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-11.2.4 | — | L3 | 모든 암호 연산을 상수 시간으로 하고 비교·계산·반환에서 조기 종료하지 않아 정보가 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/platform/test/purchase-auth.test.ts, services/queue-svc/test/arrival-cookie.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-13.1.3 | — | L3 | 쓰는 외부 시스템·서비스마다 자원 관리 전략(해제 절차, 시간 초과, 실패 처리, 재시도 횟수·간격·백오프)을 문서에 정하고, 동기 HTTP 요청에는 짧은 시간… | ID만 | B | 다른 곳 시험: packages/platform/test-int/idempotency.int.test.ts, packages/platform/test/outbox-relay.test.ts (영역: 아직 코드가 없다) |
| v5.0.0-13.1.4 | — | L3 | 보안에 핵심인 비밀과 그 교체 일정을 위협 모델에 따라 문서로 정한다. | 빈칸 | B | 영역: 아직 코드가 없다 |
| v5.0.0-13.2.6 | — | L3 | 외부 서비스 연결마다 최대 동시 연결, 한도 도달 시 동작, 연결 타임아웃, 재시도 전략 같은 문서화된 설정을 따른다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-channel-lim… |
| v5.0.0-14.2.7 | — | L3 | 민감 정보에 보존 등급을 매기고, 쓸모없어진 데이터를 정한 일정이나 상황에 따라 자동으로 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/payment-svc/test-int/payment-confirm-runner.i… |
