# 묶음 계획: R-550 화면 후속(SCR-016 후기 모달·SCR-053 스캐너 기기)

- **무엇**: 웨이브 끝 화면 후속 작업 목록이다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2`, 가지 `wave/lane2-ui-followups`, 출발점 `origin/develop` `e772c9d9`(R-545). 커밋은 R-550. 2026-11-14 작성.
- **정본**: docs/design/d5 §5.16(SCR-016)·§7.11(SCR-053), docs/frontend.md §2.5·§2.7·§3.11·§4.1, docs/features/offline-gate.md §6.1·§8, docs/api/openapi.yaml `GET/POST /v1/events/{eventId}/reviews`·`/v1/reviews/{reviewId}`·`/v1/reviews/{reviewId}/reports`·`/v1/ops/reviews/{reviewId}/moderation`·`/v1/ops/scanner-devices*`.

## 1. 한 것

1. **SCR-016 후기 모달을 core-svc API에 연결**
   - 목록 `GET /v1/events/{eventId}/reviews`(정렬·커서·더 보기), 요약 `GET /v1/events/{eventId}/review-summary`.
   - 쓰기 `POST /v1/events/{eventId}/reviews`(Idempotency-Key), 고치기 `PUT /v1/reviews/{reviewId}`, 지우기 `DELETE /v1/reviews/{reviewId}`.
   - 신고 `POST /v1/reviews/{reviewId}/reports`(사유 8종·권리 침해 본인·처리 결과 받을 곳).
   - 자격 `GET /v1/events/{eventId}/review-eligibility`로 쓰기 전 확인. 이미 쓴 회차는 `myReviewId`로 고치기 전환.
   - 목업 `REVIEW_ITEMS`·`REVIEW_SUMMARY`·`getReview`를 걷어 내고 API 매핑(`mapReview`·`mapReviewPage`·`mapReviewSummary`)로 바꿨다.
   - 로딩·빈 목록·오류·401/403/409/422/429/503 처리. 503은 기능 꺼짐, 401은 로그인 안내, 404는 지워졌거나 가려진 후기 안내.
   - 운영자 조치(임시조치·노출 차단·해제) `POST /v1/ops/reviews/{reviewId}/moderation` 컴포넌트를 더했다. 운영자 화면에서 `moderator`를 참으로 줄 때만 보이고, 개발 빌드는 `?moderator=1`로 확인할 수 있다.
2. **SCR-053 스캐너 기기 화면을 ticket-svc API에 연결**
   - 목록 `GET /v1/ops/scanner-devices`, 등록 `POST /v1/ops/scanner-devices`, 등록 코드 `POST /v1/ops/scanner-devices/{deviceId}/enrollment-code`, 폐기 `POST /v1/ops/scanner-devices/{deviceId}/revocation`.
   - 관제 API 클라이언트(`apps/console-host/src/shared/api`)를 새로 꽂고, `ops-api` 호스트 하나를 쓴다. 주소는 `PEAKET_OPS_API_ORIGIN`, 스캐너 PWA 주소는 `PEAKET_SCANNER_ORIGIN`이다.
   - 등록 코드 QR은 `qrcode`로 실제 QR을 만든다(내용 `https://<스캐너>/enroll#code=XXXX-XXXX-XXXX`). 코드 복사·만료 안내·새 코드 만들기.
   - viewer는 읽기, operator·commander는 등록·폐기. 파트너·상태 필터, 빈 목록·오류·권한 밖 안내.
   - 디자인 보드(ui/board-*.tsx)는 `?state=` 미리보기에 남기고 실제 경로는 ConnectedPage를 쓴다.

## 2. 시험

| 항목 | 시험 | 결과 |
| --- | --- | --- |
| SCR-016 API 매핑·정렬·신고 대상 | `apps/web/src/entities/review/model.test.mjs` | 5개 통과 |
| SCR-016 운영자 조치 입력 | `apps/web/src/widgets/reviews/model/moderation.test.mjs` | 2개 통과 |
| SCR-053 목록·상태·날짜·등록 코드 QR·필터 | `apps/console-host/src/pages/scanner-devices/model/devices.test.mjs` | 5개 통과 |
| 소비자 웹 전체 | `node --test` | 822개 통과 |
| 관제 콘솔 전체 | `node --test` | 46개 통과 |

## 3. 싼 게이트 결과(2026-11-14)

- root `pnpm typecheck`: 41/41 통과.
- root `pnpm lint`: 0.
- `apps/web` `tsc --noEmit`: 0, `next build`: 성공.
- `apps/console-host` `tsc --noEmit`: 0, `webpack --mode production`: 성공(scr-053 116 KiB).
- doc-check: 오류 0, 경고 4(기존 openapi 3·mermaid 건너뜀 1).
- `ledger --scope "C-T22,O-T37" --require`: 9항목(자동 7·다른 단계 2), 빈칸 0.
- `trace-check --ids "SCR-016,SCR-053"`: 2 ID, 시험 9+9, 보고 868개.
- `records --check`: 통과(기존 R-374·R-473 경고만).

## 5. 브라우저 확인·heavy gate(2026-11-14)

- Docker 없이 로컬 웹 3000·관제 3002·가짜 API 4020(기존 mock-api 4010 프록시)으로 확인했다.
- SCR-016: 목록·요약·정렬·더 보기·로딩·빈 목록·401·503, 쓰기·고치기·지우기, 신고 성공·429, 쓰기 403/409/422, 운영자 조치 성공·403·422.
- SCR-053: 목록·필터·상세·등록 코드·실제 QR·복사·새 코드·등록·폐기·빈 목록·503·로딩·viewer 권한.
- 변이 30/30 잡음. 4관점 리뷰 높음 0·중간 2(신고 오류 배너, 대화상자 초점) 모두 고침, 낮음 4 기록.
- 게이트: 웹 822·콘솔 46 통과, 양쪽 typecheck 0·build 성공, doc-check 오류 0, ledger 9항목, trace-check 9+9(보고 868), records 통과.
- 보고서 `docs/review/measurements/BAT-550-wave.md`.

## 3. 막힌 몫(후속)

- **후기 사진 올리기**: `ImageUploader`가 `File`을 넘기지 않고 `POST /v1/review-images` 연결도 없다. 이번에는 본문·별점만 보내고 사진은 화면에만 둔다.
- **운영자 조치 화면 자리**: 소비자 웹에는 ops 인증이 없다. 컴포넌트는 `moderator`를 참으로 주는 운영자 화면에서만 보인다. 관제 CS 처리함에 붙이는 것은 다음 화면 배치다.
- **SCR-053 기기 키 등록일**: `GET /v1/ops/scanner-devices` 응답에 등록일·파트너 상호가 없다. 표는 기기 키 등록일을 `—`로, mTLS는 인증서 만료일로 보이고 파트너 이름은 `GET /v1/ops/promoters`로 붙인다.
- **등록 코드 재발급·IP 제한·`last_seen_at`**: GAT-170 후속(ticket-svc·ops-svc) 몫이다.
- **브라우저 확인**: 2026-11-14 R-550에서 로컬 웹·관제·가짜 API로 했다. 기록 `docs/review/browser-check/BAT-550.md`.

## 4. 손댈 파일

| 곳 | 파일 |
| --- | --- |
| 소비자 웹 후기 | `apps/web/src/entities/review/model.ts`, `apps/web/src/widgets/reviews/**`, `apps/web/src/shared/api/index.ts`, `apps/web/src/shared/config/origins.ts` |
| 관제 콘솔 | `apps/console-host/src/shared/api/index.ts`, `apps/console-host/src/shared/config/origins.ts`, `apps/console-host/src/pages/scanner-devices/**`, `apps/console-host/webpack.config.mjs`, `apps/console-host/package.json` |
| 설정 | `eslint.config.mjs`(console-host shared/api도 setOrvalClient 허용), `pnpm-lock.yaml` |
| 문서 | `docs/BUILD_ORDER.md`, `docs/lanes/lane2.md`, 이 파일 |
