# ADR-0389: 예매 확정 알림 운영 — CS 다시 보내기·발신자/카카오·관측/비용(2026-11-26)

- **상태**: 채택(2026-11-26, 소유자 결정 "네" — ADR-0388 뒤 상세 설계 4~6을 채운다). 세부 값은 추천 적용.
- **관련**: [docs/features/notify.md](../features/notify.md) §4.10·§10·§11·§14·§16·§17, [docs/data.md](../data.md) `notification_job`·`notification_delivery`, [docs/api/openapi.yaml](../api/openapi.yaml) `POST /v1/ops/notification-deliveries/{deliveryId}/resends`, [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §7.6, [docs/security/asvs/notify.md](../security/asvs/notify.md), [docs/security/data-classification.md](../security/data-classification.md), [ADR-0387](0387-notification-provider-amazon-ses-solapi-web-push.md), [ADR-0388](0388-booking-confirmed-data-template-provider-event-detail.md)
- **관련 ID**: FR-053, N-T30, N-T31, N-T32

## 맥락

- ADR-0387·0388이 발송 업체·데이터·템플릿·제공자 웹훅을 정했지만, 알림이 끝내 닿지 않았을 때 CS가 다시 보내는 길, 발신번호·카카오 채널·알림톡 템플릿을 누가 어떻게 관리하는지, 제공자 잔액·쿼터·비용을 어떻게 보고 멈출지가 없었다.
- `notification_delivery`에는 CS가 가리킬 안정된 ID가 없고(기본 키가 `dedup_key`+`sent_at`), 다시 보낸 배송과 원래 배송을 잇는 칸도 없었다.
- Solapi는 발신번호 사전 등록과 카카오 채널·템플릿 심사가 없으면 문자·알림톡이 실패한다. SES는 production access·쿼터·반송률·스팸 신고율을 보지 않으면 계정이 위험해진다.
- 예산을 넘었다고 예매 확인서(법정·거래 기록)를 멈추면 안 된다. 그래서 비용 경보와 알림 중단 대상을 나눠 정해야 한다.

## 결정

1. **CS 다시 보내기는 `delivery_id`로 가리키고 `cs_lead`만 한다.** `notification_delivery.delivery_id`(UUIDv7, UNIQUE)를 더하고, `resend_of`(원래 `delivery_id`)·`resend_no`를 `notification_job`·`notification_delivery`에 둔다. API는 `POST /v1/ops/notification-deliveries/{deliveryId}/resends`(관제, `cs_lead`, `Idempotency-Key`, 본문 `{reason}` 1~200자, 202 `{status:"PENDING"}`)이고, ops-svc가 권한·감사·CS 건 기록을 맡은 뒤 core-svc notify 내부 `POST /internal/v1/notify/resends`(내부 토큰, ops-svc 신원만)를 불러 작업을 만든다. 1차에는 `BOOKING_CONFIRMED`만 받고, `FAILED`·`DEAD`·`EXPIRED`만 다시 보낸다. `SENT`·`DELIVERED`는 받지 않고, `BOUNCED`·`COMPLAINED`는 같은 주소로 다시 보내지 않는다. 배송당 3회 [가정], 주문 하루 3회 [가정], `cs_lead` 분당 10회 [가정]다. 새 작업은 `...:resend:{n}` 중복 키로 만들고 vars는 `notice-view`·catalog로 다시 조립한다. 감사 기록과 SCR-045 알림 미도달 건(`NOTIFICATION_UNDELIVERED` [가정], 기한 1영업일 [가정])에 남긴다.
2. **발신번호는 PEAKET 소유의 거래 알림용 번호 하나를 Solapi에 등록해 쓴다.** 예 `1544-0000` [가정]. 사업자등록증·통신서비스 이용증명으로 등록하고 `from` 설정 값으로 쓴다. 광고에는 쓰지 않고, 답장은 고객센터로 돌린다. 번호를 바꾸면 새 번호 등록·시험 발송 뒤 옛 번호 답장을 30일 [가정] 더 받는다. `from`이 없거나 등록과 다르면 문자·대체 발송 실패로 SEV3다.
3. **카카오 채널과 알림톡 템플릿을 설정으로 관리한다.** 채널 이름 '피켓', 채널 ID는 GitOps 환경 값 `PEAKET_SOLAPI_CHANNEL_ID`이고, 어댑터가 보내기 API의 `kakaoOptions.pfId`로 옮긴다(Solapi 템플릿 API v2는 `channelId`, 2026-11-26 확인). 템플릿 ID는 `PEAKET_SOLAPI_TEMPLATE_IDS`의 `{kind, locale, version} → templateId`로 둔다. 1차 템플릿은 `BOOKING_CONFIRMED` 한국어 하나이고, 정보성 카테고리 `003001` [가정], `messageType=BA`, `emphasizeType=NONE`, 변수는 공연명·회차 일시, 버튼은 마이 티켓이다. 좌석·금액·예매번호·링크는 문자 대체에 넣지 않는다. 템플릿은 카카오 심사(카카오 안내 2영업일, Solapi 안내 1~3영업일)를 거치고, 반려·휴면이면 문자로 대체하며 `notify_solapi_template_rejected_total`·SEV3로 알린다. 바꾼 템플릿은 새 ID로 등록하고 옛 판을 24시간 [가정] 함께 둔다. 알림톡은 1차에 한국어만 쓰고(국내 번호), 이메일·웹 푸시는 ko/en/ja/zh를 쓴다.
4. **관측은 제공자 잔액·쿼터·템플릿·비용까지 본다.** SES는 쿼터 80% [가정]·반송 5% [가정]·스팸 0.1% [가정], Solapi는 잔액 3일치 [가정]·일일 한도 80% [가정]·템플릿 반려·허용 IP 거절을 SEV3로, 잔액 0·계정 정지·production access 상실을 SEV2로 본다. 대시보드 라벨에는 계정·주문·전화번호를 쓰지 않는다.
5. **비용은 채널·종류별 건수 × 단가로 세고, 법정·거래 알림은 예산이 차도 멈추지 않는다.** SES Essentials 1,000통당 0.16달러, Solapi 알림톡 13원·SMS 18원·LMS 45원(2026-11-26 공개, 계약 때 다시 확인). 월 예산 `PEAKET_NOTIFY_MONTHLY_BUDGET_KRW` [가정]의 50·80·100%에서 알린다. 100%에서도 예매 확인서 이메일은 계속 보내고 SMS 대체만 멈추며, 광고성 알림은 80%에서 먼저 멈춘다. 소유자에게 SEV2로 알린다.
6. **부하 시험은 예매 확정 2.5만 건을 15분에 보낸다.** 초당 약 28건, 이메일·알림톡·30% 문자 대체. SES 쿼터·429, Solapi 일일·요청 한도, 워커 임대·백로그, p99, DEAD·재시도, 비용 집계를 잰다. 매 PR이 아니라 배포 전·월 1회 [가정]로 돌린다. 시험은 N-T30·N-T31·N-T32다.

## 결과

- 좋아지는 점: 알림이 닿지 않았을 때 CS가 같은 배송을 가리켜 사유와 함께 다시 보낼 수 있고, 누가·언제·무엇을 다시 보냈는지 남는다. 발신번호·카카오 채널·템플릿을 설정과 심사로 관리해 실패 원인을 빨리 찾는다. 제공자 잔액·쿼터·비용이 지표로 보이고, 예산이 차도 법정 알림은 지킨다.
- 잃는 점: `delivery_id`·`resend_of`·`resend_no` 칸과 관제 API가 늘고, CS 화면에 알림 미도달 건이 더해진다. 발신번호·채널·템플릿 심사와 시험 발송이 운영 일이 된다. 잔액·쿼터·예산 경보가 늘어 경보 피로가 생길 수 있어 임계값을 운영 데이터로 조정한다.
- 남는 한계: 1차 다시 보내기는 `BOOKING_CONFIRMED`만이고, 다른 종류는 각자의 vars 재조립 규칙이 필요하다. `BOUNCED`·`COMPLAINED`는 새 이메일 주소를 받기 전까지 이메일로 다시 보낼 수 없다. 알림톡 1차는 한국어만이라 영어·일본어·중국어 수신자는 이메일·웹 푸시만 받는다. 실제 계정·계약·발신번호·템플릿 심사·번역 검토·부하 시험은 뒤 몫이다.
- 검토한 다른 안: CS가 SQL로 `notification_job`을 직접 넣기(권한·감사·멱등이 없다), 다시 보내기를 모든 종류에 바로 열기(vars 재조립이 종류마다 달라 위험), SMS 대체를 예산 100%에서도 계속(비용 상한이 없다), 발신번호를 여러 개 두기(등록·답장·평판 관리가 늘어 1차에는 하나).
