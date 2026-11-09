# ADR-0192: SEED React는 동작 부품으로 쓰고 모양은 캔버스 키트를 따른다 — 대화상자부터 바꾸고, 네이티브 입력은 그대로 둔다

- **상태**: 채택(2026-11-04, 추천 적용. ADR-0170 결정 4 "보드와 정본 문서가 다르면 보드를 따르되 다른 곳은 목록으로 남긴다"를 BAS-180에 적용한 것이다). docs/design/d2-design-system.md §1.1의 'SEED 순수 활용'을 이 ADR대로 읽는다.
- **관련**: ADR-0040(SEED를 디자인 토대로), ADR-0170(퍼블리싱, 결정 4 캔버스가 시각 기준), ADR-0191(SEED 판 예외), [docs/design/d2-design-system.md](../design/d2-design-system.md) §1·§1.1·§3.4·§3.6, [docs/frontend.md](../frontend.md) §5.17, [docs/BUILD_ORDER.md](../BUILD_ORDER.md) BAS-180(wbs 0.6.2), `packages/ds`
- **관련 ID**: CMP-001, CMP-019, CMP-020, FE-T18, FE-T36, FE-T40

## 맥락

- d2 §1.1은 CMP-001 Button·CMP-019 Dialog 등 16개를 'SEED 순수 활용'(`@seed-design/react` 부품을 그대로 쓴다)으로 적었다. BAS-180은 `@peaket/ds` 부품의 속을 같은 API로 SEED React로 바꾸는 단계다.
- 그런데 화면의 시각 기준은 디자인 캔버스(보드 417개, 키트 `peaket.css` → `packages/ds/src/styles/kit.css`)다(ADR-0170 결정 4). 2026-11-04 Storybook에서 SEED 스타일 부품(`ActionButton`, recipe CSS + 피켓 토큰)과 키트 버튼을 나란히 재 보니 치수가 달랐다.

| 키트 | SEED `ActionButton` | 차이 |
| --- | --- | --- |
| md 높이 40px, 글자 14px | medium 39px(위아래 여백 10 + 줄 높이 19), 글자 14px | 1px |
| sm 32px, 글자 13px | small 35px, 글자 14px | 3px·1px |
| lg 52px, 글자 16px | large 52px, 글자 18px | 글자 2px |
| danger 바탕 피켓 위험색(red.800) | criticalSolid 바탕 SEED red.700(피켓 토큰이 덮지 않음, 흰 글자 대비 약 3.8:1) | 색·대비 |

- 같은 측정에서 결함 둘이 나왔다. ① 키트의 바탕 정리 규칙(`kit.css` 2절, `button{font:inherit;color:inherit}`)이 `components` 층에 있어, 더 약한 `seed-components` 층의 SEED recipe 글자색·굵기를 덮는다(SEED 기본 버튼 글자가 흰색 대신 검은색, 굵기 400). ② `--seed-color-bg-critical-solid`를 피켓 토큰이 덮지 않는다.
- 화면 코드는 키트 클래스를 직접 많이 쓴다(2026-11-04 `apps/`의 `btn` 1,295곳, `badge` 2,097곳, `banner` 1,050곳). 그래서 키트 CSS 절은 부품 속을 바꿔도 뺄 수 없다.
- SEED React는 모양을 입힌 부품(`@seed-design/react`)과 모양 없는 동작 부품(`@seed-design/react-dialog` 등, headless)으로 나뉜다. 동작 부품은 class를 그대로 받으므로 키트 마크업에 동작만 얹을 수 있다.
  - `react-dialog`: 바깥 내용을 보조기기에서 숨기기(`aria-hidden` 라이브러리의 `hideOthers`), 초점 가두기(FocusScope), 겹친 층의 Esc·바깥 누르기 차례(`react-dismissible-layer`), iOS에서도 도는 바탕 스크롤 잠금(`react-prevent-scroll`)을 준다. 손으로 짠 지금 Dialog에는 바깥 숨기기가 없었다.
  - `react-checkbox`·`react-switch`·`react-radio-group`·`react-text-field`·`react-field`는 네이티브 입력에 상태 속성(`data-checked` 등)과 숨긴 입력 + 따로 그린 상자 구조를 더한다. 네이티브 입력이 이미 역할·키보드·폼 제출을 주므로 동작 이득이 작고, 마크업이 바뀌어 키트 모양(`.cb`·`.rd`·`.switch`가 네이티브 입력을 꾸민다)을 다시 짜야 한다.

## 결정

1. **모양은 캔버스 키트를 따른다.** `@peaket/ds` 부품은 키트 마크업과 클래스를 그대로 낸다. 같은 이야기의 FE-T40 기준 이미지를 바꾸기 전 구현으로 먼저 찍고, 바꾼 뒤 같은지 본다(픽셀 차이 0.1% 이하).
2. **SEED React는 동작 부품으로 쓴다.** 손으로 짠 동작보다 나은 것이 있는 부품부터 속을 SEED 동작 부품으로 바꾼다. 이번(BAS-180)은 CMP-019 Dialog(`@seed-design/react-dialog`)와 그 위에 짠 CMP-020 DangerConfirm이다.
3. **네이티브 입력(체크박스·라디오·스위치·선택·글 입력), 탭, 토스트는 지금 구현을 둔다.** 동작은 브라우저 시험(`tools/web-checks/ds/behavior.spec.mjs`, 세 엔진)과 axe 검사(FE-T18)로 지킨다. 바꿀 조건: 그 부품에서 동작 결함이 나오거나, SEED 동작 부품에 손으로 짠 것보다 나은 동작(예: 탭 캐러셀, 스낵바 대기열)이 화면에 필요해질 때.
4. **버튼은 네이티브 `<button>`에 키트 클래스를 둔다.** 이유 있는 비활성(d2 §3.6)은 `aria-disabled`에 SEED의 비활성 표시 `data-disabled`를 함께 단다.
5. **SEED 스타일 부품을 쓸 때 고칠 것**(d2 §1.1 'SEED 추가 활용' 줄의 상단 내비게이션·수량 선택기·날짜 선택기 등을 처음 쓰는 단계): ① `kit.css` 2절 바탕 정리를 `base` 층으로 옮겨 SEED recipe를 덮지 않게 한다 ② 피켓 토큰이 덮지 않은 SEED 역할 색(`--seed-color-bg-critical-solid` 등)을 덮고 대비를 다시 잰다 ③ 키트와 SEED 치수가 다른 곳(위 표)을 보드에 맞출지 정한다. 키트 CSS 절은 화면이 키트 클래스를 더는 쓰지 않을 때 뺀다(FE-T36 크기 기준선도 그때 낮춘다).

## 결과

- 좋아지는 점: 화면 모양이 캔버스와 같게 남는다. 대화상자가 바깥 내용을 보조기기에서 숨기고, 겹친 층 닫기 차례와 스크롤 잠금을 SEED의 시험된 구현에 맡긴다. 부품마다 Storybook 이야기·axe·동작·시각 회귀 시험이 생겨, 다음에 속을 바꿀 때 같은 틀로 본다.
- 나빠지는 점: d2 §1.1의 'SEED 순수 활용' 16개 가운데 이번에 SEED 동작 부품을 쓰는 것은 둘이다. SEED가 부품을 고쳐도 키트 모양은 저절로 따라가지 않는다. 키트 CSS와 SEED base CSS를 함께 싣는다(BAS-170과 같다).
- 되돌릴 조건: 소유자가 캔버스 대신 SEED 모양을 시각 기준으로 정하면, 결정 5의 셋을 고친 뒤 스타일 부품(`@seed-design/react`)으로 옮기고 FE-T40 기준 이미지를 다시 만든다.
