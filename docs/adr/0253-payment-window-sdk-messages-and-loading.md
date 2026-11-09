# ADR-0253: 결제창 창 메시지는 우리 코드가 받지 않고, 두 결제사 SDK는 좁은 창 인터페이스 뒤에서 동적으로 싣는다

- **상태**: 채택(2026-11-09, 추천 적용. 두 SDK를 받는 것은 소유자 허락 "받기 허락", 2026-11-09). BUILD_ORDER HOT-358(wbs 2.10.2 ⑱).
- **관련**: ADR-0044, ADR-0079 결정 7, ADR-0229, [docs/frontend.md](../frontend.md) §5.3 '결제사 SDK 싣기'·'결제창 방식', [docs/features/payment.md](../features/payment.md) §7, [docs/security/asvs/payment.md](../security/asvs/payment.md) 3.5.5
- **관련 ID**: ASVS v5.0.0-3.5.5, FE-T21

## 맥락

- docs/frontend.md §5.3은 '결제창이 보내는 창 메시지는 우리 코드가 받지 않는다'고 적었다. docs/security/asvs/payment.md 3.5.5는 '결제창과의 통신은 SDK가 맡고, SDK가 메시지를 받는지 확인하지 않았다'며 부분 적용으로 두었다. docs/features/payment.md §7과 §12도 같은 걱정을 적었다. 두 문장이 무엇을 약속하는지 엇갈렸다(BUILD_ORDER HOT-358).
- 받은 두 패키지를 열어 보니 둘 다 적재기다. `@tosspayments/tosspayments-sdk` 2.10.0은 `https://js.tosspayments.com/v2/standard`를, `@portone/browser-sdk` 0.1.13은 `https://cdn.portone.io/v2/browser-sdk.js`를 스크립트로 불러온다. 실제 창 처리 코드는 결제사 출처에서 오므로 npm 판을 읽어 동작을 증명할 수 없고, 판이 없는 주소라 언제든 바뀐다.
- docs/frontend.md의 '포트원은 npm 판을 쓰면 우리 묶음에 들어가 SRI 대상이 된다'는 적재기만 묶음에 든다는 점을 놓친 문장이었다.

## 결정

1. **약속의 범위를 나눈다.** 우리 코드(저장소의 화면 코드)는 결제 화면에서 `message` 수신기를 두지 않는다(공통 Semgrep 규칙). 결제사 스크립트가 자기 창과 주고받는 메시지는 결제사 책임이고 우리가 고칠 수 없다.
2. **창 메시지의 값을 믿는 길을 두지 않는다.** 결제 결과는 복귀 주소의 값을 서버가 대조해 정한다(금액·`attemptId`·포트원 `paymentId`, 활성 결제 시도 대조). 결제사 창이 메시지로 무엇을 보내도 우리 상태를 바꾸지 못한다. 두 결제사 모두 페이지 이동으로 끝낸다(ADR-0079 결정 7).
3. **ASVS 3.5.5는 부분 적용으로 둔다.** 사유를 '확인하지 않았다'에서 '결제사 출처의 스크립트라 확인할 수 없고, 위 2와 CSP로 받친다'로 바꾼다. 결제 화면 CSP의 `script-src`는 두 출처만 더한다.
4. **SDK는 좁은 인터페이스 뒤에 둔다.** 결제 화면은 `PaymentWindow`(`mount(그릴 자리)`·`pay()`) 하나만 알고, 결제사마다의 구현을 결제사 값(`pg`)에 따라 동적 import한다. SDK를 부르는 파일은 결제 화면 조각에만 있고 첫 화면 JS에 들지 않는다.
5. **데모 결제창은 운영 묶음에 넣지 않는다.** `SIMULATOR` 창은 빌드 값 `NEXT_PUBLIC_PEAKET_PG_SIMULATOR`가 `1`일 때만 묶음에 든다(그 밖은 분기째 지워진다). 시뮬레이터 비밀 키는 브라우저로 보내지 않는다. 데모 전용 서버 경로가 `PEAKET_ENV`가 `local`·`ci`일 때만 시뮬레이터를 대신 부르고 그 밖은 404다.
6. **토스 위젯에서 막힌 수단을 고르면 결제를 시작하지 않는다.** 위젯은 수단을 창 안에서 고르므로, 결제 요청 직전에 고른 수단(`getSelectedPaymentMethod`)을 보고 `allowedPayMethods`에 없으면 멈춘다(BUILD_ORDER PRF-190이 넘긴 것). 위젯 자체에서 수단을 숨기는 일은 토스 상점관리자의 위젯 설정(`variantKey`) 몫이고 코드로 할 수 없다.

## 고르지 않은 안

- **수신기를 두고 출처를 확인한다**: 받을 메시지가 없는데 수신기를 만들면 공격 면만 는다.
- **SDK 스크립트를 우리 출처에 복사해 SRI를 건다**: 결제사가 주소를 판 없이 바꾸는 전제라 복사본이 금방 어긋나고, 결제사가 그렇게 쓰는 것을 지원하지 않는다.

## 결과

- 3.5.5는 부분 적용으로 남고 사유가 분명해진다. 결제창의 `frame-src`·`connect-src`·`form-action` 출처는 실제 결제사 창을 띄워 보고 모드로 모아야 하므로 이번에 정하지 않는다(docs/frontend.md §5.11 E, 스테이징 몫).
- 실제 결제사 서버와 키로 띄워 보는 일은 하지 않았다. 두 SDK 구현은 가짜 SDK로만 시험했다.
