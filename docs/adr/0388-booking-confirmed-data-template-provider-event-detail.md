# ADR-0388: 예매 확정 알림의 데이터·템플릿·제공자 이벤트 상세(2026-11-26)

- **상태**: 채택(2026-11-26, 소유자 결정 "네" — ADR-0387 뒤 상세 설계 1~3을 채운다). 세부 값은 추천 적용.
- **관련**: [docs/features/notify.md](../features/notify.md) §4.4·§4.8·§4.9·§10·§11·§12·§14·§16·§17, [docs/data.md](../data.md) `purchase_order`·`booking_no_sequence`·`notification_job`·`notification_delivery`·`notification_provider_event`, [docs/api/openapi.yaml](../api/openapi.yaml) `Order.bookingNumber`, [docs/api/guidelines.md](../api/guidelines.md) §8, [docs/architecture.md](../architecture.md) §3.2, [docs/infra.md](../infra.md) §9, [docs/security/data-classification.md](../security/data-classification.md), [ADR-0387](0387-notification-provider-amazon-ses-solapi-web-push.md)
- **관련 ID**: FR-053, N-T25, N-T26, N-T27, N-T28, N-T29

## 맥락

- ADR-0392은 예매 확정 알림의 트리거·채널·중복 키를, ADR-0387은 Amazon SES·Solapi를 정했다. 그런데 실제로 보내려면 ⑴ 예매번호가 데이터에 없고, ⑵ 이벤트에서 문안 변수(공연명·장소·좌석 등급명·판매자 정보)를 조립하는 길이 없고, ⑶ 이메일이 `text/plain` 한국어 문안뿐이며, ⑷ SES SNS·Solapi 웹훅을 받는 입구와 결과 상태가 없다.
- `openapi Order.bookingNumber`는 `[가정]`이고 "docs/data.md purchase_order에 칸이 아직 없다"고 적혀 있다. `OrderEvent`에는 `orderId`·`eventId`·`amount`·`items`(tierId·sectionId·price)만 있고 예매번호·판매자 정보·등급 이름이 없다.
- `fan-notify.ts`의 `VARS_ALLOWED`는 `BOOKING_CONFIRMED`가 없고, `assertVars`는 `name`·`phone` 키와 이메일·전화번호 꼴 값을 막는다. §4.8이 `seller` 7항목을 `vars`에 넣는다고 적은 것은 이 규칙과 충돌한다.
- `notification_delivery.status`는 `PENDING|SENT|FAILED|DEAD|EXPIRED`뿐이라 제공자의 `DELIVERED`·`BOUNCED`·`COMPLAINED`를 담을 수 없다.

## 결정

1. **예매번호는 `purchase_order.booking_no`로 저장하고, 한국 시각 날짜 8자리 + 5자리 일련번호로 만든다.** 예 `2026101400123`. 주문 생성 트랜잭션에서 `booking_no_sequence(day, next)`를 `INSERT … ON CONFLICT (day) DO UPDATE SET next = next + 1 RETURNING next`로 잡아 5자리로 채운다. 하루 99,999건을 넘으면 주문 생성을 닫고(503 `booking-number-exhausted`) SEV2로 알린다. 80,000건에서 경고한다. 예매번호는 비밀이 아니고 개인정보도 아니며, CS 문의의 `orderRef`와 같은 값이다. `openapi Order.bookingNumber`의 `[가정]`과 "칸이 없다" 문장을 지우고 이 값을 가리킨다.
2. **문안 데이터는 이벤트와 두 조회로 조립한다.** core-svc notify는 `CONFIRMED` 사건을 받으면 ⑴ purchase-svc 내부 HTTP `GET /internal/v1/orders/{orderId}/notice-view`로 `bookingNo`·`status`·`noticeAllowed`·`phoneE164`를, ⑵ core catalog 포트로 `productionName`·`venueName`·`eventStartsAt`·tier 이름을 읽는다. `noticeAllowed`가 거짓이면(주문이 `CONFIRMED`가 아니거나 회차 취소·환급이 진행 중) 알림을 만들지 않는다. 원격 읽기는 짧은 원장 트랜잭션 **밖**에서 하고, 중복 키·작업 적기와 Kafka 오프셋 커밋을 같은 트랜잭션에서 끝낸다. 실패는 재시도하고, 반복 실패는 `held_event`로 보류한다(ADR-0142). 소비자 그룹은 `peaket.core-svc-notify.<환경>`이고 주문 ID 단위로 동시에 처리한다.
3. **판매자 정보는 `notification_job.vars`에 넣지 않고 보낼 때 catalog에서 읽는다.** §4.8의 `seller` 변수를 없앤다. 이메일 렌더러가 보낼 때 core catalog에서 판매자 7항목과 고지 문장을 읽어 HTML에 넣는다. 그래서 `vars`는 `productionName`·`eventStartsAt`·`venueName`·`seatSummary`·`amount`·`bookingNoLast4`·`orderId`만 갖고, `assertVars`의 금지 키·이메일·전화번호 꼴 검사와 충돌하지 않는다. `seatSummary`는 tierId별 매수를 catalog 이름으로 바꾼 문자열이고 좌석 번호는 넣지 않는다.
4. **이메일 템플릿은 코드에 고정하고 판·언어를 남긴다.** `templates/booking-confirmed/{ko,en,ja,zh}.ts`가 `version`·제목·본문(text)·HTML을 만든다. `notification_job.template_version`과 `notification_delivery.template_version`에 실제 판을 남긴다. `MailMessage`에 `html`을 더하고 SES는 text+html multipart로 보낸다. HTML은 600px 표, 인라인 CSS, 외부 이미지·추적 픽셀·JavaScript 없이 만들고, 판매자 정보 7항목·중개자 고지·미성년자 고지·취소·환불 안내를 넣으며 글씨는 판매자 표시와 같거나 크게 한다. `account.locale`을 보낼 때 읽고, 번역이 없으면 한국어로 보내며 `notify_template_missing_total`로 센다. 법정 고지 번역은 검토를 마친 판만 쓴다.
5. **제공자 웹훅은 `gw-partner`의 웹훅 입구로 받고, 결과를 별도 상태로 남긴다.** `gw-partner-webhooks` HTTPRoute에 `/v1/notify-webhooks/ses`·`/v1/notify-webhooks/solapi` 규칙을 더해 core-svc로 보낸다. 쿠키·`Origin` 없이 받고, IP별 한도·본문 상한·5초 응답·WAF를 둔다. SES는 인프라가 SNS 구독을 미리 만들고, 받은 `TopicArn`·`SigningCertURL`(SNS 호스트)·서명·`MessageId`를 검증한다. Solapi는 `X-Solapi-Signature`를 Secrets Manager 비밀로 검증하고 재전송 창을 둔다.
6. **제공자 이벤트는 PII 없는 별도 표에 멱등하게 적고, `notification_delivery`에 제공자 상태를 더한다.** `notification_provider_event(provider, provider_event_id, provider_message_id, event_type, result_code, occurred_at, received_at, applied_at)`를 두고 `(provider, provider_event_id)`를 유일로 한다. 본문·이메일·전화번호·본문 해시는 넣지 않는다. `notification_delivery`에 `provider_status`(`ACCEPTED|DELIVERED|BOUNCED|COMPLAINED|REJECTED|DELAYED|UNKNOWN`), `provider_result_code`, `provider_event_id`, `provider_updated_at`, `template_version`을 더한다. `status`는 우리 발송 상태, `provider_status`는 제공자 결과로 나눈다. 알림톡이 문자로 대체되면 `channel`은 실제 `SMS`, `dedup_key`의 채널 자리는 요청한 `ALIMTALK` 그대로다.

## 결과

- 좋아지는 점: 예매번호가 실제 데이터·API·화면·CS에서 같은 값이 되고, 알림 문안을 이벤트만으로 만들 수 없는 부분(판매자 정보·등급 이름·예매번호)을 어디서 읽는지 정해진다. 판매자 정보를 `vars`에 넣지 않아 개인정보 규칙과 충돌하지 않고, HTML·법정 고지·현지화 판이 남는다. 제공자 결과가 `DELIVERED`·`BOUNCED`·`COMPLAINED`로 구분되어 CS와 지표가 실제 전달을 볼 수 있다.
- 잃는 점: 주문 생성 트랜잭션에 예매번호 시퀀스 행 잠금이 하나 늘고, 하루 99,999건 상한이 생긴다. 알림 intake가 purchase-svc·catalog를 읽으므로 그 장애가 알림 적재를 늦춘다(재시도·보류로 흡수). 이메일 렌더링이 catalog 판매자 정보에 기대므로 catalog가 없으면 이메일이 늦어지고, 알림톡·문자는 먼저 나갈 수 있다. 제공자 웹훅 입구와 표가 늘어 운영·보안 면적이 커진다.
- 남는 한계: 판매자 정보가 구매 뒤 바뀌면 확인서는 보낼 때의 값이 된다(구매 시점 스냅샷은 두지 않는다). 예매번호 일련번호는 하루 단위라 날짜가 바뀌면 1부터 다시 시작한다. 이메일이 반송·스팸 신고로 끝나면 자동으로 같은 주소에 다시 보내지 않고 CS 건으로 연다(다시 보내기 API·화면은 뒤 몫). 번역 검토 전에는 법정 고지가 한국어로만 나간다. 알림톡 템플릿 심사·발신번호·카카오 채널 등록은 ADR-0387의 남은 몫이다.

## 검토한 다른 안

- **예매번호를 `T` + 주문 UUID 앞 12자리 16진으로 만들기**: 칸·시퀀스가 필요 없지만, CS가 번호로 주문을 찾으려면 접두 검색이 필요하고 충돌 시 대안이 없다. 날짜+일련번호가 기존 화면 예시·CS 관행과 맞아 고르지 않았다.
- **판매자 정보를 `notification_job.vars`에 넣기**: 보낼 때 catalog를 안 읽어도 되지만, `assertVars`의 금지 키·이메일·전화번호 꼴 검사와 충돌하고 작업 표에 판매자 PII 사본이 남는다. 보낼 때 읽는 쪽을 골랐다.
- **템플릿을 DB에서 고치기**: 운영이 문안을 바로 고칠 수 있지만, 템플릿 주입·검토·판 관리가 늘고 ASVS 1.3.7(템플릿은 코드에 고정)과 어긋난다. 코드 고정 + 판 기록을 골랐다.
- **제공자 이벤트를 `notification_delivery` 한 표에만 두기**: 표가 줄지만, 같은 메시지의 `Delivery`·`Bounce`·`Complaint`가 여러 번 와 멱등 키·감사가 어렵다. 별도 이벤트 표 + 결과 칸을 골랐다.
