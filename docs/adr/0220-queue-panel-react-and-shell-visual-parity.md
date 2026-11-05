# ADR-0220: React 대기 패널(CMP-015 QueuePanel)을 대기실 셸과 같은 마크업·같은 CSS로 두고, 셸 화면 위에서 견준다

- **상태**: 채택(2026-11-06, 추천 적용). BUILD_ORDER HOT-349.
- **관련**: [docs/frontend.md](../frontend.md) §4.8 QueuePanel 행·§6.3·§5.17 FE-T40, [docs/design/d2-design-system.md](../design/d2-design-system.md) CMP-015, [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §5.8, ADR-0063, ADR-0207 결정 10, ADR-0216 결정 1
- **관련 ID**: FE-T40, SCR-008

## 맥락

- BAS-170(→ HOT-340 → HOT-345 → 이 단계)이 다음 일을 넘겼다. React `QueuePanel`(CMP-015) 대기 화면을 같은 상태의 대기실 셸과 FE-T40 틀에서 같은 문턱(0.1%)으로 견주는 것이다(§6.3).
- 그런데 다음 빈칸이 있었다.
  - ds에 QueuePanel이 없었다.
  - 패널 배치 규칙(`.q-region`·`.q-count`·진행 막대·'나' 표시 등)은 대기실 앱의 CSS(`apps/web/queue-room/src/styles/app.css`)에만 있었다.
  - Storybook은 Tailwind·SEED 바탕을 함께 싣는다. 그래서 이야기 그림은 셸과 같은 CSS가 아니어서 픽셀로 견줄 수 없다.
- 견주다가 두 가지를 찾았다.
  - HOT-344 뒤 셸이 앞 인원을 숨긴 글과 화면 숫자 둘로 그려, 기존 FE-T40 시험의 `getByText('3,214명')`이 둘을 잡았다.
  - 화면 숫자가 inline-flex 안에서 글자마다 따로 놓였다. 그러면 하나로 이어진 글(React)과 자간이 달라질 수 있다.

## 결정

1. **QueuePanel**: 셸의 패널 자리(`.q-inqueue`)와 같은 마크업·클래스를 내는 React 부품이다(`packages/ds/src/components/QueuePanel`).
   - 상태: waiting·soon·paused·stale(기본 네 화면)과 loading·batching·all-held.
   - API는 §4.8을 따른다. `model: QueueViewModel`(앞 인원·진행률·예상 대기 글·곧 입장 남은 초·공지·구매 어려움), `onCancel`·`onNotify`·`onInfo`, `renderNotice(state)`(기본 안내 뒤에 붙는다).
   - 다시 줄 서기(onRejoin)는 만료 화면(CMP-045 page)이 맡아 이 부품에는 없다.
   - 남은 초처럼 시간에 따라 바뀌는 값은 부르는 쪽이 모델로 넘긴다. 부품이 갖는 타이머는 1분 낭독 하나다(셸 `announceEveryMinute`와 같게, 비웠다가 문장을 다시 넣는다).
   - 앞 인원이 바뀌면 바뀐 자리만 굴린다(셸 `ui/roll.ts`와 같은 규칙, 두 결과가 같은지 시험이 본다). 처음 그릴 때는 굴리지 않는다.
   - 매진은 화면을 바꾸는 쪽이 SCR-018로 그리므로 `variant` 칸은 두지 않는다. 상태는 `model.state`가 정한다.
2. **CSS 한 곳**: 대기실 화면 규칙을 `packages/ds/src/styles/queue-room-screens.css`(`@peaket/ds/queue-room-screens.css`)로 옮긴다.
   - 페이지 전체에 걸리는 규칙(본문 여백·숨김·스크롤 잠금·건너뛰기 링크·스피너와 진행 표시 움직임)은 대기실 앱의 `src/styles/page.css`에 남긴다. 다른 앱에 실려도 페이지 전체를 바꾸지 않게 하기 위해서다.
   - 대기실은 키트(`queue-room.css`) → 페이지 규칙 → 화면 규칙 차례로 싣는다(옮기기 전 한 파일일 때와 같은 차례).
   - React로 대기 패널을 그리는 곳은 자기 키트 위에 화면 규칙을 싣는다.
3. **견주는 법**
   - 셸 화면을 상태마다 연다(기존 FE-T40 틀, `visual/queue-room-states.mjs`로 나눔).
   - 패널 자리를 찍어 기준 이미지(`queue-panel-{state}-{theme}.png`)로 둔다.
   - Storybook의 QueuePanel 이야기에서 React가 그린 패널 마크업(`.q-inqueue`의 outerHTML)을 떼어, 같은 셸 화면의 그 자리와 바꾼다. 그리고 같은 기준 이미지와 0.1% 문턱으로 견준다(Chromium·WebKit, 라이트·다크).
   - 이야기 정적 빌드는 시각 회귀 컨테이너에 이미 붙으므로 검사 도구에 React를 따로 깔지 않는다. 이야기의 모델 값은 셸 틀의 고정 값과 같게 둔다.
   - 기준 이미지는 셸 시험만 만든다. React 시험은 다시 찍는 실행(`--update-snapshots` 모두·바뀐 것)에서 건너뛰어 셸 기준 이미지를 덮어쓰지 않는다.
   - 셸을 연 뒤 시계를 멈추고(Playwright `clock.install`은 시계를 흐르게 두어 폴링·카운트다운이 패널을 고쳐 쓸 수 있다), 곧 입장의 남은 초는 두 쪽 모두 5초로 맞춘다. 바꾼 마크업에 표지를 달아 찍은 것이 React 마크업인지 확인한다.
   - 이야기 그림 자체는 셸과 픽셀로 견주지 않는다(부품 목록·접근성 검사·ds 시각 회귀용).
4. **셸 고침**(견주다가 찾음)
   - HOT-341(계정 메뉴)·HOT-343([차례 알림 받기])로 바뀐 셸 그림의 FE-T40 기준 이미지 16장을 판 고정 컨테이너에서 다시 찍었다(차이는 그 둘뿐임을 옛·새 그림으로 확인).
   - 앞 인원 숫자에서 바뀌지 않은 글자는 이어 붙여 글 하나로 둔다. 굴리는 자리만 따로 놓아, React와 같은 그림이 된다.
   - FE-T40 틀은 앞 인원을 숫자 칸의 값(`data-v`)으로 확인한다.

## 결과

- React 대기 패널과 대기실 셸이 같은 상태에서 같은 그림임을 CI(visual 잡)가 막는다. 이 PC 연습(Chromium)에서 8개 모두 같았다.
- 남는 한계:
  - 패널 밖(집중 셸 머리·시트)은 견주지 않는다.
  - 소비자 웹에는 아직 React 대기 화면이 없다. 대기열 경로는 모두 셸이 낸다(§2.5).
  - React 패널을 쓰는 화면이 생기면 두 CSS를 그 화면에 싣는다.

## 다른 선택지

- Storybook 이야기와 셸을 바로 견주기: Storybook이 Tailwind 초기화·SEED 바탕을 더 실어 CSS가 달라, 같은 마크업이어도 픽셀이 다르다.
- 패널 규칙을 ds 기본 스타일(`styles.css`)에 넣기: 소비자 웹의 모든 화면 CSS 예산에 실린다. 대기 패널을 쓰는 곳만 싣는다.
