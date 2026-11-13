# BAT-175·BAT-180 웨이브 끝 비싼 검사

- **무엇**: 웨이브 3 두 배치의 `heavy gate go` 결과다. 가지 `wave/lane2-BAT-175-180`를 `origin/develop` `fa36d0d2` 위로 rebase한 뒤 브라우저 확인·측정(가능한 범위)·변이·4관점 리뷰·로컬 CI 등가 게이트를 돌렸다.
- **커밋**: R-520 `8729e519`(rebase 뒤), R-521 `3efddb5e`(rebase 뒤). 이 문서와 시험 보강은 R-524로 커밋한다.
- **정본**: docs/BUILD_ORDER.md BAT-175·BAT-180, docs/features/seat-hold.md S-T19, docs/features/queue-admission.md Q-T57, docs/review/plans/BAT-175.md·BAT-180.md.

## 1. 게이트 요약

| 게이트 | 결과 |
| --- | --- |
| rebase | 성공. `origin/develop` `fa36d0d2` 위 R-520·R-521 |
| 브라우저 확인 | 통과. 로케일 셸 4·`/_q/` 6키·PWA 아이콘/manifest·SCR-053 휴대폰/태블릿. 대기실 세 엔진 36개 통과. 자세한 것은 docs/review/browser-check/BAT-175-180.md |
| S-T19 | **미실행(막힘)**. purchase-svc가 아직 `auto`를 400 `auto-assign-not-supported`로 거절한다 |
| Q-T57 | **부분**. 실제 siteverify 20회·동시 20으로 200회는 쟀고, 실제 사이트 키·trust-svc 로비 부하는 없다 |
| 변이 | 8개 넣어 8개 잡음(놓침 0) |
| 4관점 리뷰 | 높음 0·중간 0·낮음 4 |
| 로컬 CI 등가 | typecheck·lint·단위·doc-check·ledger·trace-check 통과 |
| test-int | DB 변경이 없어 필수 아님. purchase-svc hold 단위 140개는 돌렸다 |

## 2. S-T19 자동 배정 1,000건 — 막힌 사유

- `services/purchase-svc/src/modules/inventory/application/hold-seats.ts`는 `auto`가 있으면 `AUTO_NOT_SUPPORTED`(400 `auto-assign-not-supported`)를 낸다. 주석도 “자동 배정은 아직 받지 않는다(wbs 2.5.4)”다.
- `services/purchase-svc/src/modules/inventory/domain/ports.ts`도 “직접 선택만 있다(자동 배정 AUTO는 wbs 2.5.4)”라고 적는다.
- `node node_modules/vitest/vitest.mjs run test/hold-seats.test.ts` 140개 통과. 그 가운데 `FR010_ auto가 있으면 … 400(AUTO_NOT_SUPPORTED)` 시험이 현재 동작을 고정한다.
- 그래서 1,000건 동시 자동 배정·연석 부족·중복 홀드 0을 실제 서버로 잴 수 없다. 가짜 API의 auto 모드는 좌석을 고정으로 돌려주므로 측정에 쓰지 않았다. 서버 기능이 생기는 배치에서 S-T19를 다시 연다.

## 3. Q-T57 로비 사람 확인 — 가능한 범위

**실제 siteverify(공개 시험 키, 더미 토큰)**:

| 표본 | 성공/오류 | p50 | p95 | p99 | 최대 |
| --- | --- | --- | --- | --- | --- |
| 순차 20회 | 20/0 | 15.5ms | 20.7ms | 71.7ms | 71.7ms |
| 동시 20·200회 | 200/0 | 11.0ms | 84.7ms | 86.2ms | 105.2ms |

- 시험 키는 늘 통과하므로 챌린지 풀이 시간은 빠져 있다. 실제 사이트 키·trust-svc 판정·로비 참가 1,700/s는 이 환경에 없다.
- 모의 API로 로비 참가를 1,700/s로 돌리는 것은 trust-svc·Turnstile을 흉내 내지 않아 Q-T57 판정으로 쓰지 않았다. 실제 키가 생기면 로비 개방 몰림·검증 p99·검증 보류 비율을 잰다.
- 지금 수치는 p99 86ms로 trust-svc 판정 데드라인 800ms [가정] 안이지만, 표본·동시성이 작아 설계 변경 근거로 쓰지 않는다.

## 4. 변이 8개

변이를 잠시 넣고 해당 시험을 돌린 뒤 `git checkout`으로 되돌렸다(커밋에 남기지 않는다).

| 변이 | 시험 | 결과 |
| --- | --- | --- |
| 로케일 선택을 항상 ko로 | `apps/web/queue-room/test/vite-config.test.mjs` | 잡음 |
| `assets/*` 캐시를 no-cache로 | `apps/web/queue-room/test/upload-manifest.test.mjs` | 잡음 |
| preview·소스 맵 제외 삭제 | `apps/web/queue-room/test/upload-manifest.test.mjs` | 잡음 |
| edge 함수 로케일을 항상 ko로 | `apps/web/queue-room/test/edge.test.mjs` | 잡음 |
| 마스커블 아이콘 purpose를 any로 | `apps/web/src/_app/brand.test.mjs` | 잡음 |
| `manifest` 머리 링크 삭제 | `apps/web/src/_app/brand.test.mjs` | 잡음 |
| 순열 검사를 항상 참으로 | `tools/poc/shuffle-1m/shuffle.test.mjs` | 잡음 |
| 백분위를 항상 최댓값으로 | `tools/poc/turnstile-latency/siteverify.test.mjs` | 잡음 |

## 5. 4관점 리뷰

- **보안(높음 0·중간 0·낮음 1)**: edge 함수는 `/queue/{id}`의 id 모양을 따로 검사하지 않지만, 결과 URI는 고정 셸 파일 넷뿐이라 경로를 바꿔 다른 객체를 읽게 할 수 없다. 낮음으로 남긴다.
- **정합(높음 0·중간 0·낮음 2)**: ① 로케일 셸은 셸 글자만 번역하고 화면 문구는 아직 한국어다(계획된 다국어 단계). ② 소비자 웹 PWA `start_url`은 `/`라 월렛에서 설치해도 홈이 열린다(월렛 서비스 워커 뒤).
- **시험(높음 0·중간 0·낮음 1)**: 로케일→셸 이름이 vite 설정·edge 함수·검사 서버에 세 번 적힌다. edge 시험이 vite 설정과 대조하고, 셸 파일의 lang·제목 시험과 파비콘 도형 대조를 더해 드리프트를 줄였다. 검사 서버 preset은 자체 시험이 본다.
- **운영(높음 0·중간 0·낮음 0)**: 업로드 목록은 S3 메타데이터 계획이고 실제 적용은 HOT-012·BAT-185다. 로컬 정적 서버의 `no-store`와 다르다는 것을 브라우저 확인 기록에 적었다.
- **고친 것**: 스캐너 PWA에 마스커블 512 아이콘을 더했고, 로케일 셸 lang·제목·파비콘 도형·edge/빌드 매핑 대조 시험을 더했다.

## 6. 로컬 CI 등가 게이트

- `apps/web`: `tsc --noEmit` 0, `node --test` 799개 통과.
- `apps/web/queue-room`: `tsc --noEmit` 0, `node --test` 113개 통과, `vite build` 0(셸 넷·JS gzip 29.83KB·CSS 6.66KB).
- `apps/scanner`: `tsc --noEmit` 0, `vite build` 0(마스커블 포함).
- `apps/console-host`: `tsc --noEmit` 0, `node --test` 39개 통과.
- `services/purchase-svc`: `test/hold-seats.test.ts` 140개 통과(auto 400 고정).
- `tools/poc`: 셔플 4개·Turnstile 4개 통과.
- 루트 lint 0. `python -I -X utf8 tools/doc-check/check_all.py` 오류 0·경고 4(기존 openapi 3·mermaid 건너뜀 1).
- `ledger --batch BAT-175 --require` 12항목(자동 10·사람 1·다른 단계 1, 빈칸 0), `--batch BAT-180 --require` 0항목, `ledger --check` 통과.
- `trace-check` 7 ID 통과(시험 134개).

## 7. 남은 문제

- **S-T19**: purchase-svc 자동 배정 Lua·후보 목록·1,000건 부하가 아직 없다. 서버 배치에서 다시 연다.
- **Q-T57**: 실제 사이트 키·trust-svc·1,700/s 로비 몰림 측정은 계정·환경이 생기면 한다.
- **AWS·KIPRIS**: CloudFront 함수 게시·S3 업로드·무료 범위 요금, KIPRIS 대화형 검색은 소유자/계정 몫이다.
- **화면 문구 다국어**: 셸 뒤 화면은 아직 한국어다.
- **월렛 PWA**: `start_url`·서비스 워커는 월렛 SW PoC 뒤에 정한다.
