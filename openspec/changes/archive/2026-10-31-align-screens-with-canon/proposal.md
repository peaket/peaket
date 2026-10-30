# 제안: 퍼블리싱한 화면을 정본과 맞추기

## Why

화면 퍼블리싱(ADR-0170, 보관한 변경 `add-screen-publishing`)은 디자인 캔버스 보드를 시각 기준으로 옮겼다. 그런데 다섯 곳은 보드가 정본 문서와 다르거나 정본에 값이 없어, 보드를 따른 채 소유자 확인으로 남겼다(그 변경의 design.md '구현하며 정한 것과 정본과 다른 곳'). 소유자가 추천안대로 정리하라고 했다("추천대로 진행", 2026-10-31).

## What Changes

- **대기열 일시정지의 예상 시간**: SCR-008 '일시정지' 상태에서 예상 대기 숫자를 숨기고 '잠시 멈춤'으로 보인다(frontend §3.4). 진행 막대가 흐르는 모양도 멈춘다.
- **현장 운영의 입장 기록 마감 예정**: SCR-037 현장 운영 시간 띠의 '입장 기록 마감 예정'을 23:00에서 22:00으로 바꾼다(d5 §SCR-037, ADR-0051 결정 13: 역할 유효 끝 = 공연 종료 + 2시간).
- **SCR-021 토스페이먼츠 셀러 상태**: 휴대폰 읽기 전용 요약이 심사 상태에 따라 값을 고른다. 처음 판매 승인 전(초안·반려)은 데스크톱·태블릿 보드와 d5처럼 '승인 필요'(경고 배지, 공용 목업 값), 승인을 받은 뒤는 '부분 승인'이다.
- **토큰 둘을 정본에 넣기**: 대화상자·시트·서랍 뒤 덮개 색 `scrim`과 히트맵 면 위 글자색 `heat.ink`를 `docs/design/tokens.json`에 넣고, 키트 변수 `--scrim`·`--heat-ink`를 그 토큰에서 만든다. d2에 쓰임을 적는다.
- **목업 좌석 표기**: 소비자 웹 공용 티켓 목업의 좌석을 보드 표기('R석 · R구역 12열 7번'·'8번')로 바꾼다. 같은 값을 쓰는 탈퇴 요약·부스 본인확인 화면도 보드와 같아진다.

## Capabilities

### New Capabilities

없음. 화면 퍼블리싱의 후속 정리라 명세(spec)는 두지 않는다(`skip_specs`).

### Modified Capabilities

없음.

## Impact

- 코드: `apps/web/queue-room/src/screens/queue.ts`, `apps/partner/src/_pages/field-staff/ui/OpsPanel.tsx`, `apps/partner/src/_pages/event-wizard/ui/MobileSummary.tsx`, `apps/web/src/entities/ticket/model.ts`(와 그 값을 설명하는 주석), `packages/ds/scripts/build-tokens.mjs`와 다시 만든 `packages/ds/src/gen/*`.
- 정본 문서: `docs/design/tokens.json`, `docs/design/d2-design-system.md`(§3.4·§5 한 줄씩), `packages/ds/README.md`, ADR-0170 상태 줄(뒤에 덧붙임), `docs/review/consistency-review.md`(R-205), `docs/00-summary.md` §4.
- 동작이 바뀌는 서버·API는 없다. 화면은 여전히 목업이다.
