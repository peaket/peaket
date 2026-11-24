# F-03-4 실제 서버 화면 시험(console-commands)

T13~T16: 관제 콘솔이 **실제 ops-svc·identity-svc·받는 쪽 넷**에 붙어 명령 1·3·6을 보내고, 재인증(비밀번호·TOTP·패스키)·2인 승인·ack·되돌리기를 브라우저에서 끝까지 본다.
계획은 `docs/review/plans/F-03-4.md` §8, 정본은 `docs/features/control-tower.md` §3·§4·§6·§12와 `docs/design/d5-screen-blueprint.md` §7.3이다.

## 무대(`stage.mjs`)

한 프로세스에 받는 쪽 넷을 띄운다(`services/bundle`의 `startBundle`: payment-svc·purchase-svc·admission-ctrl·queue-svc). 그 밖은 실제 프로세스다.

- PostgreSQL 18·Valkey 8.1 컨테이너(이름 `gate-f034-*`, 실행마다 `docker rm -f -v`)
- identity-svc(`dist/main.js`)와 관리 계정 둘(commander·operator, 비밀번호·TOTP·패스키). 계정 시드는 `scripts/seed-demo.mjs --apply`
- ops-svc(`dist/main.js`)와 콘솔 미리보기 서버(`apps/console-host/scripts/preview-server.mjs`, 운영 빌드)
- `/v1/ops`는 ops-svc로, `/v1/ops/auth/*`는 identity-svc로 넘긴다(`apps/console-host/scripts/ops-proxy.mjs`의 identity 갈래)
- T16은 `POST /stage/ops/restart`로 ops-svc의 받는 곳 목록에 닿지 않는 주소를 더했다 뺀다

**Docker 자리**: `docker`가 아니라 **docker-2**만 쓴다. `D:/ticketpass-locks/docker-2/owner.txt`의 첫 줄이 `gate-F-03-4`인지 시작할 때 확인한다.
`lock.sh`의 `single` 파일이 켜져 있으면 `take docker`가 docker-2를 주지 않으므로, 이 gate는 docker-2 자리를 직접 만들고 쓴다(다른 자리는 건드리지 않는다).

## 실행

먼저 운영 빌드를 만든다(콘솔은 관제 API 주소를 빌드에 넣는다).

```bash
# 저장소 뿌리
pnpm build
PEAKET_OPS_API_ORIGIN=http://localhost:4280 pnpm --filter @peaket/console-host build

# tools/web-checks
pnpm run console-commands
```

`playwright.console-commands.config.mjs`의 `webServer`가 무대를 띄운다. 로컬에서 무대를 손으로 띄워 두고 반복할 때는 그 무대를 재사용한다(`CI`가 있으면 늘 새로 띄운다).
무대가 서지 않으면 표준 오류에 어느 단계에서 멈췄는지 남는다(비밀번호·TOTP 시드·패스키 개인키는 로그에 싣지 않는다).

## 브라우저 확인(계획 §9, OPS-390)

```bash
# tools/web-checks
pnpm run console-browser-check
```

`browser-check.spec.mjs`가 시스템 Chrome(Playwright, 새 시험 프로필)으로 역할·실제 API·Tab 초점·대화상자 상태·명령 3·6·1·320/768을 본다. 패스키는 CDP 가상 인증기가 답한다. 결과는 `docs/review/browser-check/OPS-390.md`에 적었다.

연결된 Chrome에서 사람이 눌러 보는 확인은 무대의 자동 로그인 길을 쓴다(비밀번호·TOTP를 대화에 옮기지 않는다).
`http://localhost:4281/stage/login?account=commander|operator&next=/commands?event=<회차>`가 identity-svc에 실제 로그인하고 쿠키를 브라우저에 넘긴 뒤 콘솔로 보낸다.
같은 Chrome 프로필에서 계정을 바꾸면 이전 계정의 토큰 갱신과 `admin-login-busy`(30초)가 겹칠 수 있으므로, 두 계정이 동시에 필요한 확인은 Playwright 문맥 둘로 한다.

## 알려진 무대 한계

- identity-svc의 로그인 셈·패스키 챌린지와 ops-svc의 재인증 jti는 이 프로세스 메모리에 둔다(`PEAKET_ENV=local`). 받는 쪽 넷이 쓰는 Valkey의 100ms 마감과 같은 Redis를 나눠 쓰면 로그인·재인증이 503으로 흔들린다(무대 확인 2026-11-24).
- ops-svc의 dry-run 센 값 원천(BAT-365)은 아직 서버에 연결되지 않았다. 명령 1의 dry-run은 `predicted` 없이 `unavailable`만 오고, 화면은 그 응답 그대로 '세지 못함'을 그린다. T15 ②는 화면이 서버 응답과 같은지를 본다.
- Chromium 가상 인증기의 서명 횟수는 identity DB의 `admin_passkey.sign_count`에서 시작한다. 0에서 시작하면 서명 횟수 퇴행으로 422 `passkey-assertion-invalid`가 난다.
