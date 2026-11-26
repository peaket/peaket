# ADR-0390: 알림함(인앱 알림 이력) 설계(2026-11-26)

- **상태**: 채택(2026-11-26, 소유자 결정 "알림 이력/알림함은 설계해야 겠네요"). 세부 값은 추천 적용.
- **관련**: [docs/features/notify.md](../features/notify.md) §4.11·§11·§12·§14·§16·§17, [docs/data.md](../data.md) `notification_inbox`, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/notifications*`, [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §3·§5.36, [docs/design/d3-screens.md](../design/d3-screens.md) SCR-072, [docs/planning/04-ia-flows-screens.md](../planning/04-ia-flows-screens.md) SCR-072, [docs/security/data-classification.md](../security/data-classification.md), [ADR-0392](0392-booking-confirmed-notification-trigger-copy-and-send-rules.md), [ADR-0388](0388-booking-confirmed-data-template-provider-event-detail.md), [ADR-0389](0389-notification-operations-cs-resend-sender-kakao-observability-cost.md)
- **관련 ID**: FR-053, N-T33, N-T34

## 맥락

- 알림은 이메일·문자·웹 푸시로 나가지만, 팬이 그 채널을 놓치면 지난 알림을 앱 안에서 다시 볼 곳이 없었다. 마이 티켓·예매 내역은 주문·티켓만 보여 주고, 문의 답변·회차 취소·양도·보안 알림은 흩어져 있다.
- `notification_delivery`는 채널별 발송 결과이고 90일만 남으며, `notification_job`은 보내면 지운다. 둘 다 팬이 읽을 이력으로 쓰기에는 수명·모양이 맞지 않는다.
- 본문을 그대로 저장하면 판매자 정보·공연 정보·금액 같은 값이 표에 복제되고, 템플릿이 바뀌면 옛 본문과 새 본문이 섞인다. 그래서 `vars`와 문안 판만 두고 읽을 때 그리는 쪽을 골랐다.

## 결정

1. **새 화면 SCR-072 알림함을 `/my/notifications`에 둔다.** 소비자 웹 일반 셸의 머리에 종 아이콘(CMP-003, `ic-bell`)과 안 읽은 수 배지를 더하고, 누르면 알림함으로 간다. 화면은 탭 [전체]·[읽지 않음], 분류 칩, 목록(분류·제목·본문 2줄·상대 시각·안 읽음), [모두 읽음], 더 보기로 이룬다. sm 1열, lg 720px [가정] 가운데다.
2. **`notification_inbox` 한 표에 논리 알림 하나를 둔다.** `(account_id, logical_key)`가 유일이고 `logical_key`는 채널을 뺀 키다(예 `BOOKING_CONFIRMED:{orderId}:CONFIRMED:{accountId}`). 같은 알림이 이메일·푸시·문자로 여러 번 가도, 다시 보내도 항목은 하나다. `vars`(허용 목록)·`template_version`·`category`·`target_ref`·`created_at`·`read_at`만 두고 **본문·주소·전화번호·판매자 정보는 넣지 않는다.** 제목·본문은 읽을 때 템플릿과 catalog로 만든다.
3. **intake가 같은 트랜잭션에서 인박스 행을 넣는다.** `notification_dedup`·`notification_job`과 함께 쓰고, 인박스 쓰기가 실패하면 그 알림 적재를 실패로 보고 재시도한다. 그래서 모든 채널이 DEAD여도 알림함에는 남는다. 보존은 1년 [가정]이고 `created_at` 기준 묶음 삭제, 탈퇴하면 바로, 계정 병합 때 대표 계정으로 옮기고 겹치면 하나(하나라도 읽었으면 읽음)다.
4. **API는 목록·안 읽은 수·하나 읽음·모두 읽음 넷이다.** `GET /v1/notifications`(커서·limit 기본 20 [가정]·최대 50, `unreadOnly`, `category`), `GET /v1/notification-unread-count`, `POST /v1/notification-read-all`(204), `POST /v1/notifications/{notificationId}/read`(204, 멱등, 남의 항목 404). 팬 쿠키, `Cache-Control: private, no-store`, 계정 밖 항목 404. 이메일·푸시 링크는 지금처럼 대상 화면으로 가고, 그 링크로는 읽음이 바뀌지 않는다(대상 화면이 알림 ID를 모른다. 필요해지면 링크에 알림 ID를 더하는 안을 다시 본다).
5. **화면은 개인 알림을 브라우저에 저장하지 않는다.** 오프라인은 "연결되면 불러옵니다"만 보이고, 401은 로그인 뒤 같은 주소로 돌아온다. `url`은 같은 출처의 허용한 앞부분(`/my/`, `/events/`, `/help/`, `/queue/`, `/productions/`)만 열고, 대상이 지워졌으면 분류별 기본 화면으로 보낸다. 안 읽음은 색만이 아니라 점과 "읽지 않음" 글자로 알리고, [모두 읽음] 결과는 `role="status"`로 한 번 읽으며, 항목을 열면 대상 제목으로 초점을 옮긴다.
6. **알림함은 발송 성공·실패의 정본이 아니다.** 채널별 결과는 `notification_delivery`·`notification_provider_event`가 정본이고 CS가 본다. 알림함은 팬이 읽는 이력이고, CS 다시 보내기(§4.10.1)와 독립이다. 지표는 `notify_inbox_write_failures_total`·`notify_inbox_items_total{category}`·`notify_inbox_read_total`·`notify_inbox_unread_ratio`이고 계정·주문·전화번호 라벨을 쓰지 않는다. 시험은 N-T33(데이터·API), N-T34(화면·접근성)다.

## 결과

- 좋아지는 점: 팬이 이메일·문자·푸시를 놓쳐도 앱에서 지난 알림을 다시 보고 대상 화면으로 갈 수 있다. 채널이 모두 실패해도 알림함에 남아 법정·거래 안내를 다시 볼 길이 생긴다. 본문을 저장하지 않아 개인정보 복제와 템플릿 불일치가 줄고, 읽음 상태가 기기 사이에서 같다.
- 잃는 점: `notification_inbox` 표와 머리 종 배지·새 화면·API가 늘고, 목록을 읽을 때 템플릿·catalog를 읽으므로 catalog 장애가 인박스 조회를 늦춘다(문구 없는 항목은 기본 문구로 대체). 1년 보존이라 표가 커질 수 있어 정비 삭제가 필요하다.
- 남는 한계: 이메일·푸시 링크로 대상 화면에 바로 간 경우 알림함 읽음은 바뀌지 않는다. 템플릿 판이 코드에서 사라지면 옛 항목은 지금 판으로 그려 문구가 달라질 수 있다. 알림함은 광고를 포함한 모든 종류를 담을 수 있지만, 광고 수신 동의·야간 규칙은 발송 쪽(§7)이 정본이고 인박스는 이미 보낸 것만 보여 준다. 템플릿 관리 화면은 뒤 몫이다.
- 검토한 다른 안: `notification_delivery`를 그대로 읽기(채널별 중복·90일 수명·본문 없음), 보낼 때 렌더한 본문을 저장하기(개인정보 복제·템플릿 불일치), 화면을 SCR-054의 셋째 탭으로 넣기(머리 종 배지·딥링크·1년 이력에 자리가 좁다), 브라우저 저장소에 캐시하기(개인 알림이 기기에 남는다).
