# ADR-0227: 접근성 좌석 목록은 Worker가 구역 자료까지 주고, DOM은 한 줄로 늘어놓는다

- **상태**: 채택(2026-11-09, 추천 적용). BUILD_ORDER HOT-354.
- **관련**: [docs/frontend.md](../frontend.md) §4.7·§5.2, [docs/design/d2-design-system.md](../design/d2-design-system.md) CMP-022, [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §5.10, ADR-0221, ADR-0224, ADR-0225
- **관련 ID**: SCR-010, CMP-022, FE-T18

## 맥락

- 정본은 목록이 구역을 열면 `sectionState{section, version, states}`를 받는다고만 적었다. 메인 스레드에는 좌석맵 파일이 없어(파일 해석은 Worker 몫이다) 열과 좌석 이름, 구역 목록을 어디서 얻는지 빈칸이었다.
- d2는 트리의 사이를 `group`으로 둔다고 적었다. 가상 스크롤(보이는 줄만 DOM에 둔다)에서는 펼친 묶음을 DOM으로 감쌀 수 없다.

## 결정

1. **메시지**: `listSections` → `sectionList{sections[{section, name, status}]}`, `listSection{section|null}` → `sectionState{section, version, baseIndex, states, seats{seatId, row, number, tier, wheelchair}, tiers}`, 그 뒤 바뀐 좌석만 `stateChanged{section, version, offsets, states}`.
   - 구역의 열·좌석 이름은 `sectionState`에 한 번만 실린다. 좌석맵 파일을 메인 스레드에서 다시 읽으면 긴 작업이 생긴다.
   - `states`·`offsets`는 복사하지 않고 소유권을 넘긴다(§5.2). 값은 `LIST_STATES`의 색인이다.
   - 지금 `stateChanged`는 고르기·풀기에서 나간다. 실시간 델타에서 같은 메시지를 보내는 것은 구독을 여는 HOT-357이다.
2. **한 번에 한 구역만 연다**: 다른 구역을 열면 앞 구역 자료는 버린다('지금 구역의 열·좌석만 DOM으로', §5.2).
3. **DOM은 한 줄로 늘어놓는다**: `tree` 바로 아래에 `treeitem`을 두고 계층은 `aria-level`·`aria-setsize`·`aria-posinset`으로만 알린다. WAI-ARIA가 허용하는 꼴이고, `group`으로 감싸면 가상 스크롤과 맞지 않는다.
4. **초점은 줄이 직접 갖는다(roving tabindex)**: 지금 줄만 `tabindex="0"`이고, 스크롤로 화면을 벗어나도 지금 줄은 DOM에 남긴다. 목록을 열면 첫 줄로 초점을 옮긴다.
5. **보이는 글은 낭독 이름 안에 그대로 든다**(WCAG 2.5.3). 좌석 줄은 "12번, 예매 가능, R석 ₩150,000", 낭독 이름은 그 앞에 구역과 열을 붙인다.
6. **고르기 경로는 지도와 같다**: 목록은 `SeatPick`과 좌석 색인을 예매 흐름 기계로 넘긴다. 한도·홀드·실패 처리는 ADR-0225 그대로이고 지도 표시도 함께 바뀐다.
7. **늦게 가져온다**: 목록과 가상 스크롤은 [목록으로 보기]를 누른 사람만 받는다(첫 JS 예산, §5.8). `@tanstack/react-virtual`은 §5.14의 판 표에 있는 3.14.23을 쓴다.

## 결과

- 화면 낭독기와 키보드 사용자가 지도 없이 구역 → 열 → 좌석으로 골라 홀드까지 갈 수 있다.
- **아직 못 한 것**: NVDA·VoiceOver 완주 시험(FE-T18의 수동 칸, 사람이 한다). 낭독이 위치와 상태를 제대로 읽지 못하면 d2의 대안('구역 제목 + 열마다 좌석 버튼 목록')으로 바꾼다.
- [자동 좌석 배정] 버튼은 직접 선택 공연에서 자동 배정을 여는 서버 단계(HOT-080) 뒤에 단다(ADR-0225 결정 6).

## 검토한 다른 안

- **메인 스레드가 좌석맵 파일을 다시 받아 읽기**: 5만 석 JSON 해석이 긴 작업이 된다.
- **`aria-activedescendant`로 초점을 트리에 두기**: 가상 스크롤과 잘 맞지만 화면 낭독기마다 읽는 정도가 달라, 실제 초점을 옮기는 쪽을 골랐다.
