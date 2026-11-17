# W9-ci-route 계획·기록(웨이브 9 합친 뒤 develop CI 게이트웨이 백엔드 대조 고침)

- 까닭: W9-fix3을 합친 뒤(2fb306ac, R-675) develop CI 실행 44058851916의 `tools-check / tools`가 `deploy/gateways/test/route-contract.test.mjs`의 "infra §4.1 '백엔드 대조'" 시험에서 빨갰다. `GET`·`POST /v1/partner/events/{eventId}/cancellation`의 생성 라우트 백엔드가 core-svc인데 처리기는 ops-svc에 있다(BAT-420 `e9999e87`의 `partner-event-cancellation.controller.ts`). 이 시험은 게이트웨이·라우트 생성기 파일이 바뀔 때 도는 잡이라, BAT-420을 합칠 때(R-673)에는 돌지 않았고 W9-fix3이 생성기를 고치면서 처음 드러났다. 같은 실행의 `node / node` 실패(`event-refund.int` N1·N2 시계 의존)는 W9-fix1(`992bc9c2`, R-676)이 고쳤다.
- 정본: docs/features/transfer-refund.md T1 'gw-partner는 이 경로만 ops-svc로 보내고 나머지 /v1/partner/*는 core-svc로 보낸다', docs/infra.md §4.1 '백엔드 대조'(작업의 정본은 처리기가 있는 서비스).
- 고친 것: 라우트 원천 `deploy/gateways/routes/gw-partner.yaml`의 `gw-partner-api`에서 그 경로를 core-svc 규칙에서 빼고 같은 필터의 ops-svc 규칙(`ops-svc`, 네임스페이스 `core`, 포트 8080)을 새로 두었다. 생성 파일 `gw-partner.routes.yaml`은 `node tools/ci/gateway-routes.mjs --write`로 다시 만들었다. 실패하던 재현 시험은 이미 있는 route-contract 시험이다.

## 실패 확인

감독이 고치기 전 트리(develop `41defc73`, 이 가지의 출발점)에서 `node --test deploy/gateways/test/route-contract.test.mjs`를 돌려 15개 가운데 1개('백엔드 대조')가 CI와 같은 두 줄로 실패함을 봤다. 새 시험은 쓰지 않았다(이미 있는 시험이 재현이다).

## 리뷰

리뷰 담당 `w9cr-review`(claude-sonnet-5-5), 2026-11-17, 커밋 `737ad3b0`. 커밋 없이 보고를 감독이 옮겨 적는다.

- 판정: 합쳐도 됨. 높음·중간 없음.
- 정본 일치(transfer-refund.md:294·212·225·299). 새 규칙은 같은 HTTPRoute `gw-partner-api` 안이라 라우트 단위 정책 `gw-partner-api-security`(jwt·인가)와 `gw-partner-api-edge`가 그대로 걸리고 이름표 `peaket.io/auth: token`도 같다. 생성 정규식은 완전 일치라 `/cancellation-…` 같은 경로를 삼키지 않고, core-svc 규칙에서 빠져 두 규칙이 겹치지 않는다. 백엔드 이름·네임스페이스·포트는 gw-ops.yaml과 같다.
- 낮음 둘: ① docs/infra.md:86 표의 gw-partner ops-svc 칸이 '실시간 판매 현황'뿐이다(회차 취소 요청·상태를 더하면 맞음, 정리 목록). ② 원천 규칙에 응답 머리 `X-Trace-Id` 고치기가 없으나 생성기가 넣으므로 다른 규칙과 같다(문제 아님).
- 돌린 시험: deploy/gateways 82 통과, `gateway-routes.mjs --check` 통과.

## 검증

따로 검증 담당을 두지 않았다(감독 예외, 아래 기록). 리뷰 담당이 deploy/gateways 시험 82개와 `--check`를 다시 돌렸고, 합친 뒤 develop CI `tools-check / tools`가 확인한다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| impl | w9cr-impl | claude-sonnet-5-5 | 2026-11-17T19:15:00+09:00 | 2026-11-17T19:19:04+09:00 |
| review | w9cr-review | claude-sonnet-5-5 | 2026-11-17T19:20:00+09:00 | 2026-11-17T19:22:00+09:00 |

감독(기록·합치기)은 2026-11-17 소유자 세션(`3e1ce3e9-393d-4f7a-af50-c929a7b974a9`)이다.

## 기록

- 구현 `737ad3b0`(impl). 리뷰는 커밋 없이 이 파일에 옮겨 적었다.
- 게이트: deploy/gateways 시험 82 통과(전에는 route-contract 1 실패), `tools/ci/gateway-routes.test.mjs` 41 통과, `--check` 0, doc-check 오류 0.
- 역할 확인: 감독 예외 하나. CI를 깨뜨린 라우트 원천 한 경로 고침이고 재현 시험이 이미 있어 계획·시험·검증 커밋을 따로 두지 않았고, 리뷰는 보고를 이 파일에 옮겼다([구성] 실패, W8-ci-gitleaks와 같은 꼴).
