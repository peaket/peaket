# BAT-086 데모 재현 측정

- **커밋(작성 시점)**: `aaf87493`(계획) + 이 묶음 구현 변경
- **날짜**: 2026-11-21
- **PC/OS**: Windows · Node 24.18.0 · Playwright `tools/web-checks` 1.64.1
- **도구 판**: Docker 있음 · kind v0.33.0 · kubectl v1.35.8 · helm v3.22.1 · oasdiff 1.34.1(고정 이미지)
- **명령**: `node tools/local/demo.mjs all` (예정. 이 글을 쓴 시점에는 실행하지 않았다)
- **콜드 스타트**: — (미실행)
- **정리**: — (미실행)
- **결과**: **미실행** — 구현 담당은 Docker·kind를 돌리지 않는다(시험 담당 몫). 아래는 구현이 하는 일과 지금 확인한 정적 결과다.

## 이 글을 쓴 시점에 실제로 돌린 것

| 확인 | 명령 | 결과 |
| --- | --- | --- |
| 시나리오 정의와 정본 대조 | `node tools/local/demo.mjs plan --check` | 통과(S1~S9, 화면 번호·순서가 d5 §10.6과 같다) |
| 클라우드 값 산술 | `node tools/local/demo.mjs cloud-plan --check` | 통과(시간당 0.8629달러 × 6시간 = 7,508원, 예산 50,000원) |
| 선행 점검 | `node tools/local/demo.mjs doctor` | 실패(Playwright 미설치·kind/helm은 `.cache`에서 찾음). `pnpm --dir tools/web-checks install --frozen-lockfile` 뒤 다시 본다 |
| 운영 판 호환 시연 | `node tools/local/demo.mjs compat --work .cache/peaket-tools/demo-compat` | 통과(같은 커밋 0, `v0.0.0` 태그와 견주면 `type` 삭제를 잡아 1). 자세한 것은 `BAT-086-compat.md` |
| 문법 점검 | `node --check tools/local/demo.mjs` 외 새 모듈 6개 | 통과 |

## 시나리오별(구현이 재생하는 것)

| # | 시나리오 | 재생 방식 | 결과 확인(checks) | 이 글을 쓴 시점 |
| --- | --- | --- | --- | --- |
| S1 | 지민의 하이브리드 예매 | 화면 SCR-001·002·007·008·010·011·012·013 + 실제 구매 API(대기열 진입·입장·홀드 2석·주문·시뮬레이터 결제·발권) | `seat-hold-2`·`payment-approved`·`ticket-qr` | 미실행(kind 필요) |
| S2 | 매진과 취소표 알림 | 화면 SCR-008·018·054 | `sold-out`·`cancel-alert-subscribed` | **실패 예정**: 기본 시드에 매진 픽스처가 없고 취소표 알림 API 자동화가 없다 |
| S3 | 결제 실패·결과 불명 | 화면 SCR-011·012·055·010 + 시뮬레이터 장애(승인 거절·응답 유실) + 같은 좌석 재홀드 | `unknown-result`·`seat-released` | 미실행(kind 필요) |
| S4 | 선착순·자동 배정 | 화면 SCR-002·008·010·011 + 자동 배정 홀드·결제 | `auto-assign`·`payment-approved` | 미실행(kind 필요) |
| S5 | 양도와 취소 | 화면 SCR-013·014·041·038 | `transfer-offer`·`cancel-with-fee` | **실패 예정**: 팬 재인증(카카오/구글 다시 로그인) 의식을 자동화하지 않았다 |
| S6 | 공연 등록과 판매 승인 | 화면 SCR-020·062·021·048 + 파트너 등록·좌석맵·판매 심사 제출·관제 승인·공개 조회 | `production-created`·`sale-approved`·`status-visible` | 미실행(kind 필요) |
| S7 | T=0 관제 | 화면 SCR-029·030·031 | `self-approval-403`·`second-approval-ok`·`audit-entry` | **실패 예정**: 콘솔의 패스키 재인증(WebAuthn) 승인 조작을 자동화하지 않았다 |
| S8 | 공연 당일 입장 | 화면 SCR-037·036 | 판정 넷 | **실패 예정**: 시드가 스캐너 등록 코드·기기 자격을 남기지 않아 기기 로그인부터 막힌다 |
| S9 | 회차 취소와 배상 | 화면 SCR-044·045·047·013·043 | `refunded` | **실패 예정**: 2인 승인(패스키)·일괄 환불 진행을 자동화하지 않았다 |

## 실행하면 남는 것

`node tools/local/demo.mjs all`은 ① 선행 점검 ② `cluster.mjs demo` ③ `demo-seed --apply` ④ S1~S9 재생 ⑤ 이 파일 다시 쓰기 ⑥ `demo-down` + kind 클러스터 삭제를 한다. 측정 파일에는 커밋·날짜·PC·도구 판·콜드 스타트(명령 시작~첫 화면)·시나리오별 시작/끝/걸린 시간/결과/실패 단계·정리 결과가 들어간다. 실패한 실행도 지우지 않고, 확인하지 못한 시나리오는 통과로 세지 않는다.

## 남는 한계(이 묶음)

- S2·S5·S7·S8·S9는 화면을 열고 실패 사유를 남기는 데까지다. 조용히 건너뛰지 않지만, V-T7의 'S1~S9 모두 통과'는 아직 아니다. 다음 몫: 매진 픽스처(E-3), 팬 재인증 의식, 콘솔 패스키 승인, 스캐너 기기 등록·합성 티켓, 회차 취소 2인 승인.
- 데모 무대의 S7 재인증은 `deploy/envs/local/demo/ops-svc.yaml`의 `PEAKET_IDENTITY_JWKS_URL`·`PEAKET_IDENTITY_ISSUER`로 켜져 있고, 재인증 jti는 Redis 주소가 없어 메모리에 둔다(파드가 다시 뜨면 1회용 기록이 사라진다).
- 클라우드 데모는 실행하지 않았다(첫 출시 뒤 서명 GHCR 다이제스트). `deploy/demo/cloud-plan.yaml`의 값과 `docs/devops.md` §5.1 절차만 있다.
- Docker/kind 실행·측정은 시험 담당 몫이다. 이 파일은 그 실행이 끝나면 같은 명령이 다시 쓴다.
