# Tasks

## 1. 화면 고치기

- [x] 1.1 대기실 SCR-008 '일시정지'에서 예상 대기를 '잠시 멈춤'으로 보이고 진행 막대 흐름을 멈춘다(design.md 결정 1). 확인: `pnpm --filter @peaket/queue-room build` 통과, `?state=일시정지`에서 숫자 대신 '잠시 멈춤'이 보이고 '대기 중'은 그대로 숫자가 보인다.
- [x] 1.2 파트너 SCR-037 현장 운영 시간 띠의 '입장 기록 마감 예정'을 22:00으로 바꾼다(결정 2). 확인: 휴대폰·데스크톱 배치 모두 22:00, 마감 뒤 상태는 23:12 그대로.
- [x] 1.3 파트너 SCR-021 휴대폰 요약의 토스페이먼츠 셀러 상태를 심사 상태로 고른다(처음 승인 전은 공용 목업 값과 경고 배지, 승인 뒤는 '부분 승인', 결정 3). 확인: 판매 승인 요청 화면은 폭 360과 1280에서 같은 '승인 필요', 판매 승인된 공연의 휴대폰 요약은 '부분 승인'.
- [x] 1.4 소비자 웹 공용 티켓 목업의 LUMEN 좌석을 보드 표기로 바꾸고 관련 주석을 고친다(결정 5). 확인: 탈퇴 요약이 'R구역 12열 7번·8번', 부스 본인확인이 'R구역 12열 7번'.

## 2. 토큰

- [x] 2.1 `docs/design/tokens.json`에 `scrim`과 `heat.ink`를 라이트·다크로 넣고, `build-tokens.mjs` 키트 대응표를 토큰 경로로 바꿔 `src/gen/`을 다시 만든다. d2 §3.4·§5와 `packages/ds/README.md`에 적는다(결정 4). 확인: `pnpm --filter @peaket/ds tokens:check` 통과, `kit-tokens.css`에 'tokens.json에 없음' 줄이 없다.

## 3. 기록과 통합 확인

- [x] 3.1 ADR-0170 상태 줄 덧붙임, consistency-review R-205, 00-summary §4 한 줄(결정 6). 확인: 문서 점검 오류 0.
- [x] 3.2 전체 확인: `pnpm turbo run typecheck build`, `node --test "tools/ci/*.test.mjs"`, 저장소 규칙 검사 셋, OpenSpec 검증, 바꾼 파일의 줄바꿈 LF. 확인: 모두 통과.

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 바뀐 화면 넷(SCR-008 일시정지, SCR-037 현장 운영, SCR-021 휴대폰 요약, SCR-017 탈퇴 요약)과 덮개가 있는 대화상자 하나를 라이트·다크로 연다. 결과는 `browser-check.md`.
- 코드 리뷰: 새 맥락의 리뷰, 나온 것은 이 사이클에서 고친다.
- 보관: `pnpm exec openspec archive align-screens-with-canon --yes`, 작업 가지에 커밋하고 `develop`에 병합한다.
