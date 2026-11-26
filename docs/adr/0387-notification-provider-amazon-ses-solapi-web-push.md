# ADR-0387: 알림 발송 업체 선정 — Amazon SES·Solapi·웹 푸시 표준(2026-11-26)

- **상태**: 채택(2026-11-26, 소유자 결정 "이메일은 Amazon SES, 알림톡 문자는 추천해주시고 웹 푸시도 추천대로 가겠습니다"). 세부 값은 추천 적용. 2026-11-26 ADR-0388이 예매번호·데이터 조립·템플릿·제공자 웹훅 상세를 정했다.
- **관련**: [docs/features/notify.md](../features/notify.md) §4.4·§4.8·§4.9·§10·§11·§16·§17·§18, [docs/security/secrets-and-keys.md](../security/secrets-and-keys.md) 'Amazon SES 발송 권한'·'Solapi API 키', [docs/security/data-classification.md](../security/data-classification.md) '국외 이전 목록'·'수탁자 목록', [docs/api/guidelines.md](../api/guidelines.md) §8, [docs/verification.md](../verification.md) §4, [docs/infra.md](../infra.md) §9, [docs/review/open-items.md](../review/open-items.md) 57, [ADR-0060](0060-screen-blueprint-open-decisions.md), [ADR-0089](0089-leftover-values-senior-engineer-decisions.md), [ADR-0139](0139-personal-data-cross-border-transfer-register.md)
- **관련 ID**: FR-040, FR-053, N-T7, N-T13, N-T26

## 맥락

- `open-items 57`은 알림 발송 대행사를 정하지 않은 채로 두고, 계약 전에는 이메일·웹 푸시만 쓰기로 했다(ADR-0060 결정 13). 코드에는 `MailTransport` 포트와 local·ci 파일 대역, 웹 푸시 RFC 8291·8292 구현, 가짜 전송기만 있고 운영 대행 어댑터는 없다.
- 대행사를 고를 때 볼 것은 `open-items 57`의 기준이다: 발송 결과 웹훅과 서명, 발송 한도·속도, 허용 IP 지원, IAM 역할 인증(정적 비밀 없이), 비용, 국외 재이전 여부, 발신 도메인·발신번호·발신 프로필 등록, 알림톡 템플릿 심사.
- 소유자가 이메일은 Amazon SES로 정했고, 알림톡·문자는 추천을 요청했으며, 웹 푸시는 브라우저 푸시 서비스와 VAPID를 쓰는 앞선 추천을 그대로 받아들였다.

## 결정

1. **이메일은 Amazon SES, 서울 리전(`ap-northeast-2`)을 쓴다.** AWS 공식 엔드포인트 표에 서울 리전 SES 엔드포인트가 있고(2026-11-26 확인), 서울 리전은 국내 처리라 국외 이전을 만들지 않는다. Essentials 플랜(월 1,000만 통까지 1,000통당 0.16달러, VDM 포함)을 기본으로 하고, 비용이 더 중요해지면 종량제(1,000통당 0.10달러)로 바꾼다. 공유 IP로 시작하고, 전달률이 목표에 못 미치면 Pro 플랜(월 105달러, 관리형 전용 IP)으로 올린다.
2. **SES는 IAM 역할로만 부른다.** `core-notify-sender`의 Pod Identity 역할에 `ses:SendEmail`·`ses:SendRawEmail`·`ses:GetSendQuota`만 준다. SMTP 자격 증명과 정적 액세스 키를 만들지 않는다. 발신 도메인은 `notify.peaket.example`으로 검증하고 SPF·DKIM·DMARC와 custom MAIL FROM을 둔다. configuration set `peaket-notify`의 이벤트 목적지(SNS)로 `Bounce`·`Complaint`·`Delivery`·`Reject`를 받아 SNS 서명을 검증한 뒤 `notification_delivery`에 반영한다. 새 계정은 샌드박스(하루 200통·초당 1통, 수신 주소 검증 필요)이므로 출시 전에 production access를 신청하고(보통 96시간 안에 답), 발송량을 단계적으로 올린다.
3. **알림톡·문자는 Solapi로 정한다.** 보내기 API는 알림톡(`kakaoOptions.pfId`·`templateId`·`variables`)과 문자(SMS·LMS)를 함께 받고, `kakaoOptions.disableSms=false`와 등록된 `from` 발신번호로 알림톡 실패 시 문자 대체 발송을 쓴다. 템플릿 관리 API v2는 같은 채널을 `channelId`(구 `pfId`)로 부른다(2026-11-26 확인, notify §18). 알림톡은 카카오 채널과 템플릿 심사가 끝나야 하고, 본문은 변수 치환 뒤 1,000자까지다. 주문의 E.164 번호는 Solapi에 보낼 때 국내 표기(`010…`)로 바꾸고 `country`를 82로 준다. 한 요청에 10,000건까지이고, 그보다 많으면 그룹 API(1,000,000건)로 나눈다. 가격은 2026-11-26 공개 기준 알림톡 13원, SMS 18원, LMS 45원, MMS 110원이다(계약 때 다시 확인).
4. **Solapi는 발송 권한 키에 공인 IP 허용 목록을 건다.** 2026-11-11 전송자격인증제 시행으로 문자·RCS 발송 권한 키는 허용 IP가 1개 이상 필수이고 `0.0.0.0/0`과 사설 IP는 쓸 수 없다(Solapi 권한 가이드, 2026-11-26 확인). 그래서 `core-notify-sender`의 고정 NAT EIP를 Solapi 콘솔에 등록하고, 키 권한은 `message:send-ata`·`message:send-sms`·`message:send-lms`만 준다. 발송 결과는 `SINGLE-REPORT` 웹훅을 `X-Solapi-Signature`로 검증해 받고, 5초 안에 200을 돌려준다. 웹훅 비밀도 Secrets Manager에 둔다.
5. **문자·알림톡은 국내 번호(`+82`)만 보낸다.** Solapi의 국내 문자는 KT·LG유플러스, 알림톡은 비즈톡·디케이테크인에 처리 위탁되고, 해외 문자는 인포빕·Vonage로 나간다(Solapi 개인정보 처리방침, 2026-11-26 확인). 해외 번호는 이메일·웹 푸시만 보내 국외 이전을 만들지 않는다. Solapi는 발송 이력(발신·수신 번호, 본문, 결과)을 1년 보관하므로, 우리 `notification_job`·`notification_delivery`에는 번호·본문을 두지 않는 규칙(notify §12)을 그대로 지키고, 처리방침의 수탁자·보유 기간에 Solapi를 적는다.
6. **웹 푸시는 브라우저 푸시 서비스와 VAPID를 그대로 쓴다.** FCM·Mozilla·Apple·WNS로 보내고, 별도 유료 업체를 두지 않는다. VAPID 키·Topic 키·수신 거부 토큰 키는 지금 설계대로 Secrets Manager에 둔다(notify §3.4·§4.4, ADR-0139 결정 6). 이메일·문자·웹 푸시는 `core-notify-sender`의 채널별 어댑터 뒤에 두어, 업체가 바뀌어도 포트 구현만 바꾼다. 대행사 어댑터 계약은 notify §4.4에 표로 고정했다.

## 결과

- 좋아지는 점: 발송 업체가 정해져 계정·도메인·템플릿·키를 실제로 만들 수 있다. SES는 AWS IAM과 서울 리전으로 정적 비밀과 국외 이전을 줄이고, Solapi는 한 API에서 알림톡·문자 대체·결과 웹훅·IP 허용 목록을 제공한다. 비용은 2026-11-26 공개 단가로 계산할 수 있다.
- 잃는 점: SES는 샌드박스 해제와 발신 도메인 평판 쌓기(워밍업)가 필요하고, 공유 IP의 전달률이 낮으면 Pro 플랜 비용이 든다. Solapi는 발송 권한 키에 고정 공인 IP가 필수라 NAT EIP를 준비해야 하고, 알림톡 템플릿 심사와 카카오 채널이 필요하다. Solapi가 발송 이력을 1년 보관하는 것은 처리방침에 적어야 한다. 해외 번호에는 문자를 보내지 않는 제한이 남는다.
- 남는 한계: 공개 단가·한도는 계약 때 달라질 수 있어 계약서로 다시 확인한다. SES 이벤트(SNS)와 Solapi 웹훅을 받는 공개 입구·서명 검증은 ADR-0388·구현 묶음에서 만든다. 알림톡 템플릿은 카카오 심사를 통과해야 하고, 심사가 늦으면 문자·이메일·웹 푸시만 나간다. SES·Solapi 계정과 키가 없으면 지금처럼 local·ci 파일 대역과 가짜 전송기로만 시험한다.
- 검토한 다른 안: NHN Cloud Notification Hub(국내 클라우드, 알림톡·문자·이메일을 한 API로, 결과 웹훅·IP ACL이 있으나 appkey/secret 인증과 콘솔 플로우 설정이 늘고 이메일은 SES와 중복), Aligo(저렴하지만 결과 웹훅·권한·문서가 얕음), 카카오 비즈센터+별도 문자 업체(업체 둘, 대체 발송을 직접 구현), AWS End User Messaging(알림톡 없음), Twilio(국내 알림톡 없음).

## 확인한 외부 사실(2026-11-26)

- AWS SES 엔드포인트·쿼터: 서울 리전 `email.ap-northeast-2.amazonaws.com`이 있다(https://docs.aws.amazon.com/general/latest/gr/ses.html).
- AWS SES 가격: Essentials 1,000통당 0.16달러(0~1,000만 통), 종량제 1,000통당 0.10달러, Pro 월 105달러(https://aws.amazon.com/ses/pricing/).
- AWS SES 샌드박스: 새 계정은 하루 200통·초당 1통이고 수신 주소를 검증해야 하며, production access 심사는 보통 96시간 안에 답한다(https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
- AWS SES 이벤트: configuration set 이벤트 목적지로 CloudWatch·Firehose·SNS를 쓸 수 있고, `Send`·`Delivery`·`Bounce`·`Complaint`·`Reject`·`DeliveryDelay` 등을 받는다(https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity.html).
- Solapi 가격: 알림톡 13원, SMS 18원, LMS 45원, MMS 110원, 해외 90원(https://solapi.com/msg).
- Solapi 권한·허용 IP: 문자·RCS 발송 권한 키는 허용 IP가 1개 이상 필수이고 `0.0.0.0/0`·사설 IP는 안 된다. 알림톡 대체 발송은 문자·장문 발송 권한과 허용 IP가 모두 있어야 한다(https://solapi.com/developers/api/authority, 2026-11-13).
- Solapi 웹훅: `SINGLE-REPORT`·`GROUP-REPORT`를 등록하고, `secret`을 두면 `X-Solapi-Signature`가 붙는다. 5초 안에 200을 돌려주어야 하며 실패하면 다시 보낸다(https://solapi.com/developers/api/webhook, 2026-11-17).
- Solapi 알림톡: `disableSms` 기본값 false, 대체 발송에는 등록된 `from`이 필요하고, 템플릿 변수는 `#{변수명}`, 본문은 치환 후 1,000자까지다(https://solapi.com/developers/api/messages-ata).
- Solapi 개인정보: 국내 문자는 KT·LG유플러스, 알림톡은 비즈톡·디케이테크인, 해외 문자는 인포빕·Vonage에 제공하며, 발송 이력은 발송일부터 1년 보관한다(https://solapi.com/privacy, 2026-08-20 시행).
