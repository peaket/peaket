# ADR-0237: 화면 낭독기 수동 시험의 iOS VoiceOver 몫은 기기를 구할 때까지 미실행으로 남긴다

- **상태**: 채택(2026-11-09, 소유자 결정 "미실행으로 남기기"). NFR-020의 기준은 바꾸지 않고, 그 기준을 지금 어디까지 실행할 수 있는지만 정한다.
- **관련**: ADR-0227, [docs/planning/02-requirements.md](../planning/02-requirements.md) NFR-020, [docs/frontend.md](../frontend.md) §5.11, [docs/features/seat-hold.md](../features/seat-hold.md) S-T18, [docs/review/open-items.md](../review/open-items.md) 108번
- **관련 ID**: NFR-020, FE-T18, S-T18, wbs 2.6.3, wbs 7.5.1

## 맥락

- NFR-020은 화면 낭독기(화면의 글자를 소리로 읽어 주는 프로그램) 조합 셋 × 핵심 시나리오 셋(좌석 선택·결제·양도) × 시나리오마다 3회 [가정] = 27회를 모두 끝까지 마치기를 요구한다. 조합은 NVDA·Windows Chrome, VoiceOver·iOS Safari, TalkBack·Android Chrome이다.
- VoiceOver는 애플 기기에 들어 있는 낭독 기능이라 macOS와 iOS에서만 돈다. 지금 개발 PC는 Windows이고 소유자에게 맥과 아이폰이 없다.
- 소유자 여건상 외부 서비스 계정을 만들지 않고 비용이 드는 클라우드도 쓰지 않는다. 그래서 실기기 대여 클라우드는 쓸 수 없다.
- Windows에 macOS 가상 머신을 까는 길은 애플 사용 허가가 애플 기기에서만 가상 실행을 허용해 쓰지 않는다. iOS 시뮬레이터도 맥이 있어야 돈다.
- 낭독기는 제품마다 읽는 방식이 달라, 다른 낭독기로 통과해도 VoiceOver 통과로 칠 수 없다.

## 결정

1. NFR-020의 27회 기준은 그대로 둔다. VoiceOver 조합을 빼거나 다른 낭독기로 바꾸지 않는다.
2. 개발 PC에서는 NVDA·Windows Chrome과 TalkBack·Android Chrome(PC 안의 가상 안드로이드폰인 에뮬레이터) 18회를 한다. NVDA와 에뮬레이터를 받는 일은 그 시험을 할 때 소유자에게 묻는다.
3. VoiceOver·iOS Safari 9회는 '미실행'으로 적는다. 결과는 실행 횟수와 미실행 횟수를 나눠 적고(예: 18회 실행, 9회 미실행), 9회가 끝나기 전에는 완주율 100%를 달성했다고 쓰지 않는다. SeatList를 구현하기 전에 시안으로 돌리는 완주(FE-T18, wbs 2.6.3)의 VoiceOver 몫도 같다.
4. 아이폰을 구할 수 있을 때 9회를 한다. 잠깐 빌리는 것으로 충분하고, 실제 출시 전에 하는 것을 추천으로 둔다(open-items 108번).
5. GitHub의 macOS 빌드 서버로 VoiceOver를 자동으로 돌리는 검사는 지금 넣지 않는다. 맥 Safari의 문제는 일찍 찾을 수 있어도 iOS 몫을 채우지 못하고, 새 패키지가 필요하며, 빌드 서버에서 되는지도 아직 확인하지 않았다.

## 결과

- **좋은 점**: 없는 기기 때문에 개발이 멈추지 않고, 기준을 몰래 낮추지도 않는다. 무엇을 안 했는지가 결과에 그대로 남는다.
- **남는 한계**: iOS VoiceOver에서만 나는 낭독 문제는 기기를 구할 때까지 찾지 못한다. 특히 좌석 목록의 트리 구조(ADR-0227)가 위치와 상태를 제대로 읽지 못하면 d2의 대안으로 바꿔야 하는데, 그 일이 늦게 드러날 수 있다.
