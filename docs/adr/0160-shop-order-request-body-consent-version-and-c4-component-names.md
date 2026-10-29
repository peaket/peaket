# ADR-0160: 굿즈 주문 요청 본문은 수령 방식으로 갈리고 판매자 제공 동의를 고지 문안 판과 함께 받으며, 서비스 넷의 C4 3단계 구성 요소를 정한다(2026-10-30)

- **상태**: 채택 (2026-10-30. 소유자가 ADR-0154 결정 3으로 굿즈 주문 요청 본문(open-items 17번)과 나머지 서비스의 C4 3단계 그림(29번)을 지금 쓰기로 정했다. 본문 모양과 구성 요소 이름은 추천 적용이다. 정본은 docs/api/openapi.yaml `POST /v1/shop/orders`와 docs/architecture.md §3.3이다.)
- **관련**: ADR-0062(택배·현장 수령 결제 상점), ADR-0084·0090(C4 3단계 그림), ADR-0089('남는 한계'의 굿즈 주문 본문), ADR-0101(상품 유형 속성), ADR-0107(한정 재고 예약), ADR-0138(그림 쓰기 규칙), ADR-0154, POL-016, [docs/api/openapi.yaml](../api/openapi.yaml), [docs/architecture.md](../architecture.md) §3.3, [docs/data.md](../data.md)

## 맥락

- 굿즈 주문 생성 경로에는 응답만 있고 요청 본문이 없었다. 그래서 택배 주문의 판매자 제공 동의(받는 자·목적·항목·보유 기간을 알리고 따로 받는 동의, planning/03 §1.2)를 받을 칸도 없었다(ADR-0089 '남는 한계').
- data.md에는 `merch_order.consent_version`(화면에 보인 고지 문안의 판)이 이미 있었다. 판매 조건 동의는 예매에만 있다.
- C4 3단계 그림은 예매 핵심 경로의 세 묶음(purchase-svc, payment-svc, queue-svc와 admission-ctrl)만 있었다.

## 결정

1. **본문은 수령 방식 칸 `fulfillment`로 갈린다**: 결제 접수 본문(`PaymentAccept`)과 같은 방식(oneOf + discriminator)을 쓴다. 갈래마다 정한 칸 밖은 받지 않아(`additionalProperties: false`), 현장 수령 주문에 배송지를 보내면 400이다.
2. **동의는 `consents.provisionToSeller`와 `consents.consentVersion`으로 받는다**: 서버는 지금 고지 문안의 판만 받는다. 판이 다르면 422 `consent-version-outdated`로 답해, 화면이 문안을 다시 보이게 한다. 동의가 없으면 422 `consent-required`다(docs/api/guidelines.md §12).
3. **택배는 `delivery`(받는 분·연락처·우편번호·기본 주소·상세 주소)를 받는다**: data.md의 `delivery_address` 한 칸에 우편번호·기본 주소·상세 주소를 함께 담는다. 우편번호는 국가기초구역 5자리다(2026-10-30 확인).
4. **현장 수령은 수령 시간대 `pickupSlotId`가 필수다** [가정]: 고른 시간대가 마감이면 422 `pickup-slot-unavailable`이다. 수령 시간대 엔터티는 굿즈 상세 설계 때 다듬는다.
5. **금액은 본문으로 받지 않고 서버가 계산한다.** 형식 상한은 모두 [가정]이다: 항목 20개, 수량 99, 옵션 10개, 받는 분 50자, 연락처 숫자 8~12자리, 기본 주소 200자, 상세 주소 100자.
6. **C4 3단계 구성 요소(추천 적용)**:
   - ops-svc 7: 명령 접수, 명령 전달, 운영 업무, 관제 콘솔 읽기와 흐름, 경보 수신, 감사 체인 작업자, 감사 앵커 잡
   - identity-svc 5: 계정·세션·토큰, 계정 연결·병합, 휴대폰 본인확인, 관리 계정 인증, 현장 스태프·스캐너 로그인
   - ticket-svc 6: 발권과 티켓 조회, 월렛·기기 키·양도, 스캐너 기기 관리, 스캐너 경로 가드, 근무 준비와 동기화, 스캔 수신과 현장 판정
   - trust-svc 9: 판정 수신, 판정 파이프라인, 사람 확인 검증, 피처 저장, 허니팟 기록, 라벨 반영, 재평가 후보 처리, 설정 수신, 판정 기록 발행
   - 저장소 선은 묶음 하나로 그리고, 자세한 연결은 그림 아래 표로 옮긴다(선 겹침 ops 5·identity 4·ticket 6 → 0·1·0).
   - core-svc는 굿즈·후기·문의 기능 설계를 쓸 때 그린다. realtime-gw를 그릴지는 그때 정한다.

7. **그림의 계약 없는 선을 초안 호출로 만들었다(2026-10-30 맞추기·마지막 정리)**: ticket-svc → identity-svc `CheckScannerSession`, ops-svc → ticket-svc `ReclaimTicket`을 더했다. 기기 승인 요청과 토큰 발급 때 identity-svc가 ticket-svc의 `GetScannerDeviceByCredential`로 기기 상태를 캐시 없이 본다(답이 없으면 503, I-T57). 세 호출 모두 ADR-0148의 초안 표시를 단다.
8. **다른 주문의 동의도 같은 방식이다**: 예매 주문(`POST /v1/orders`)과 현장 스태프 초대 수락도 동의를 선택 칸과 고지 문안 판으로 받고, 없으면 422 `consent-required`, 판이 다르면 422 `consent-version-outdated`다.

## 검토한 대안

- **서버가 지금 문안 판을 채우기(예매 주문의 지금 방식)**: 주문서를 연 뒤 문안이 바뀌면, 기록된 판과 이용자가 실제로 본 판이 어긋난다. 기각.
- **동의 누락을 스키마로 막기(`enum: [true]`)**: 동의 누락은 422로 답한다는 규칙(guidelines §12)과 다르다. 기각.
- **구성 요소마다 저장소 선을 따로 그리기**: 선 겹침이 늘고 선이 25개를 넘는다. 기각.

## 결과와 트레이드오프

- 택배 주문은 화면이 본 고지 문안 판으로 동의를 남긴다. 문안이 바뀌는 순간 주문서를 연 사람은 한 번 더 동의한다.
- 굿즈 상세 설계 전이라 수령 시간대·저장 배송지는 최소한만 정했다.
- 그림에는 계약이 아직 없는 호출 둘을 그렸다(ticket-svc → identity-svc 스캐너 세션 확인, ops-svc → ticket-svc 승인된 양도 회수). 이 호출은 docs/api/proto/README.md에 더한다.

## 되돌릴 조건

- 굿즈 상세 설계에서 수령 시간대를 주문이 아니라 상품에 두기로 하면 결정 4를 고친다.
