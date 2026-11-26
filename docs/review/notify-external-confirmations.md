# 알림 외부 확인 기록

- **독자와 용도**: 예매 확정 알림·알림톡·템플릿 심사를 운영에 켜기 전에 소유자·외부 계약·콘솔에서 확인해야 하는 값을 한곳에 모은다. 이 문서는 **기록만** 한다. 실제 값·비밀은 여기에 쓰지 않고, 어디에 넣었는지만 적는다.
- **정본**: 값의 뜻과 설계는 [docs/features/notify.md](../features/notify.md) §4.12.9·§16·§18, [ADR-0387](../adr/0387-notification-provider-amazon-ses-solapi-web-push.md)·[ADR-0388](../adr/0388-booking-confirmed-data-template-provider-event-detail.md)·[ADR-0389](../adr/0389-notification-operations-cs-resend-sender-kakao-observability-cost.md)·[ADR-0391](../adr/0391-notification-template-review-and-activation.md)다. 이 문서와 정본이 다르면 정본이 이긴다.
- **상태**: 2026-11-26 등록. 항목은 모두 `대기`이고, 확인한 뒤 이 표의 상태·확인일·근거만 고친다. 비밀 값은 Secrets Manager·GitHub Secrets에 넣고 이름만 적는다.
- **막지 않는 것**: 아래 값이 없어도 이메일·웹 푸시 구현과 시험은 흉내 서비스로 진행할 수 있다. 알림톡·문자·템플릿 심사만 실제 값이 필요하다(notify §16).

## 확인 목록

| ID | 확인할 것 | 왜 필요한가 | 어떻게 확인하나 | 누가 | 언제 | 상태 | 근거·넣을 곳 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NX-01 | Solapi 템플릿 API v2 `channelId` 실제 값 | 템플릿 등록·조회·검수 요청의 채널 식별자 | Solapi 콘솔 또는 카카오 채널 연동 API에서 읽는다. 보내기 API의 `kakaoOptions.pfId`와 같은 채널이다 | 소유자 | 첫 템플릿 제출 전 | 대기 | GitOps `PEAKET_SOLAPI_CHANNEL_ID`(비밀 아님) |
| NX-02 | `BOOKING_CONFIRMED`의 정보성 `categoryCode` | Solapi 템플릿 등록 필수 값 | Solapi 카카오 템플릿 카테고리 조회로 정보성 카테고리를 확인한다. 현재 초기값 `003001` [가정] | 문안 담당자 | 첫 템플릿 제출 전 | 대기 | `notification_template.category_code`, notify §4.12.9 |
| NX-03 | 첫 실제 반려 `comments`와 우리 코드 매핑 | 제공자는 반려 사유 코드 열거를 주지 않는다 | 첫 반려를 받은 뒤 `comments` 원문을 읽고 `CONTENT_PROHIBITED`·`AD_UNDECLARED`·`VARIABLE_INVALID`·`LINK_INVALID`·`LENGTH`·`DUPLICATE`·`PROVIDER_TEMPORARY`·`OTHER`로 옮긴다 | CS 책임자 | 첫 반려 뒤 | 대기 | notify §4.12.3 표, `notification_template.reject_reason_code` |
| NX-04 | Solapi 계약: 단가·일일 한도·발신번호 등록·허용 IP | 문자 대체·비용·보안 설정 | 계약서와 Solapi 콘솔. 발신번호는 사업자등록증·통신서비스 이용증명으로 등록하고, 허용 IP는 `core-notify-sender` 고정 NAT EIP만 둔다 | 소유자 | 운영 전 | 대기 | Secrets Manager `PEAKET_SOLAPI_*`, notify §4.10.2 |
| NX-05 | 카카오 채널 상태·프로필·템플릿 심사 | 알림톡 발송 자체 | 카카오 비즈니스센터에서 채널 '피켓'의 상태·프로필을 확인하고, Solapi로 템플릿을 등록·검수 요청한다 | 소유자 | 첫 제출 전 | 대기 | Solapi 콘솔, notify §4.10.2·§4.12.3 |
| NX-06 | Amazon SES production access·발신 도메인·IAM·configuration set | 실제 이메일 발송 | AWS 콘솔에서 production access를 요청하고, 도메인 인증·DKIM·IAM Pod Identity 역할·configuration set `peaket-notify`·SNS 이벤트를 확인한다 | 소유자 | 운영 전 | 대기 | IAM 역할, Secrets Manager 아님. notify §4.9.2·§18 |
| NX-07 | 법정 고지 번역·법률 검토 | 예매 확인서의 판매자·중개자·미성년자·취소·환불 고지 | 한국어 원문을 기준으로 ko/en/ja/zh 번역과 법률 검토를 받는다. 한국어만 보증하고, 번역 전에는 ko로 대체한다 | 소유자·법률 | 운영 전 | 대기 | notify §4.9.2, 이메일 템플릿 판 |
| NX-08 | 내부 시험 수신자 | 검토 항목 C9(시험 발송) | 내부 수신자 전화번호·이메일을 정하고 시험 발송 결과를 적는다. 실제 고객 주소를 쓰지 않는다 | operator | 첫 시험 발송 전 | 대기 | `notification_template_event.note`, 비밀 아님 |
| NX-09 | Web Push VAPID 운영 키 | 실제 웹 푸시 | VAPID 키쌍을 만들고 Secrets Manager에 넣는다. 공개키는 빌드 값으로 둔다 | 소유자 | 운영 전 | 대기 | Secrets Manager, notify §4.4 |
| NX-10 | 알림함 1년 보존의 법률·처리방침 검토 | 개인정보 보존 기간 | 개인정보 처리방침·보존 기간 검토에 함께 넣는다 | 소유자·법률 | 운영 전 | 대기 | notify §4.11·§12, data-classification |

## 처리 방법

1. 확인한 사람이 `상태`를 `확인`으로 바꾸고 확인일·근거(티켓·커밋·콘솔 화면 이름)를 적는다. 비밀 값·전화번호·이메일 원문은 적지 않는다.
2. 값이 설계의 [가정]을 바꾸면 `docs/features/notify.md` §4.12.9·§17과 ADR-0391의 해당 문장을 함께 고친다. 계약·API 필드가 바뀌면 어댑터 계약 시험과 `docs/features/notify.md` §18을 고친다.
3. 새 항목이 생기면 이 표에 `NX-11`처럼 번호를 이어 붙인다. 끝난 항목도 지우지 않고 `확인`으로 남겨 감사에 쓴다.
4. 이 문서는 계획·기록이고, 실제 값의 정본은 Secrets Manager·GitOps·계약서다. 이 문서에 비밀을 옮겨 적지 않는다.

## 관련

- [notify.md §4.12.9 확정한 값과 남은 확인](../features/notify.md)
- [notify.md §16 남는 한계와 넘길 일](../features/notify.md)
- [open-items.md 57번 알림 발송 대행사 선정](open-items.md)
- [F-06-8 계획](plans/F-06-8.md)·[F-06-9 계획](plans/F-06-9.md)·[F-06-10 계획](plans/F-06-10.md)·[F-06-11 계획](plans/F-06-11.md)
