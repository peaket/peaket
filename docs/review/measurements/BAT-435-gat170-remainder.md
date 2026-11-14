# BAT-435 GAT-170 잔여(mTLS PoC·SCR-036 실제 QR) heavy gate 기록 (R-591, 2026-11-15)

가지 `wave/lane1-BAT-435-gat170-remainder`, 기준 `origin/develop` `105a8ab8`(R-590).

## 1. 이번에 넣은 것

- **mTLS 검증 경로 PoC**: `packages/platform` `ScannerGuard`가 게이트웨이 신뢰 머리(`x-peaket-mtls-authenticated` 비밀 값·`x-peaket-client-cert-sha256`·`x-user-x5t`)가 모두 맞을 때 DPoP 증명 없이 인증서 지문으로 기기를 찾는다. `ScannerAuthWiring.mtls`가 없으면 머리를 믿지 않고 기존 DPoP로 내려간다. ticket-svc는 `PEAKET_SCANNER_MTLS_SECRET`이 있을 때만 이 경로를 켠다.
- **실제 인증서 PoC**: `selfsigned`로 만든 자체 서명 인증서 DER의 `x5t#S256`을 `mtlsConfirmationOf`로 계산하고, `ScannerGuard`가 그 지문으로 기기를 찾는 시험을 넣었다. 다른 인증서 지문은 `mismatch`로 거절한다.
- **SCR-036 실제 QR**: `apps/scanner`가 `qrcode`를 동적 import해 `verificationUriComplete`의 실제 QR(data URL)을 만들고, `DeviceApprovalPanel`이 가짜 무늬 대신 그 QR을 그린다. QR 청크는 초기 번들에서 분리됐다(빌드 `browser-*.js` 23.45kB, 초기 `index-*.js` 330.78kB).

## 2. cheap gate

| 항목 | 결과 |
| --- | --- |
| ticket-svc 단위 | 97 통과(17파일) |
| identity-svc 단위 | 550 통과(45파일) |
| scanner 단위 | 31 통과(7파일) |
| web 단위 | 833 통과 |
| ops-svc 단위 | 91 통과(21파일) |
| platform 단위 | 542 통과(43파일, 새 mTLS 가드·실제 인증서 6건 포함) |
| contracts 단위 | 41 통과(11파일) |
| api-client 단위 | 113 통과(8파일) |
| console-host 단위 | 57 통과 |
| typecheck | ticket·identity·scanner·web·ops·platform·contracts·api-client·console-host·ds 통과 |
| lint | 바뀐 서비스·패키지·앱 통과 |
| doc-check | 오류 0, 기존 경고 4 |
| ledger BAT-435 | O-T37 자동 시험 8, 빈칸 0 |
| trace-check O-T37 | 통과 |
| records `--check` | 통과 |
| contracts `gen:check` | 생성물이 계약과 같다 |

## 2.1 heavy gate

### Docker test-int

| 서비스 | 결과 |
| --- | --- |
| ticket-svc | **44 통과**(8파일) |
| identity-svc | **169 통과**(29파일) |
| ops-svc | **40 통과**(9파일, 기준 37보다 3건 많다. 이번 변경은 DB 스키마를 바꾸지 않았다) |

- Docker `29.8.1` ready. 시험 컨테이너는 `afterAll`에서 정리됐고 `docker ps`에 남은 시험 컨테이너가 없다.

### 변이(등급 B, 26개)

- **26/26 잡힘, 놓침 0, 무효 0.**
- 범위: mTLS 비밀 값·인증서/cnf 불일치·wiring 없음·기기 상태·실제 인증서 지문·blocker 목록, QR 동적 import 실패·data URL·폭·로더 주입.
- 첫 실행에서 2개가 놓였다. QR 폭 1px는 PNG IHDR 폭(320) 단언으로, mTLS 지문 잘라내기는 기기 찾기 시험으로 보강해 26/26이 됐다. 결과 표는 `.cache/bat435-mtls-mutations.md`(커밋하지 않음).

### 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 처리 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 0 | 중간: mTLS는 게이트웨이가 클라이언트가 보낸 같은 이름 머리를 지우고 비밀 값을 넣는다는 신뢰 경계에 기댄다(문서화). 중간: `x-user-x5t`와 토큰 서명 검증은 게이트웨이 몫이고 서비스는 전달값을 믿는다(기존 `x-user-*` 경계와 같다, 문서화). |
| 정합 | 0 | 1 | 0 | 중간: `ScannerShiftAuth.confirmation`은 실제 인증 방식이 아니라 기기 `credentialType`에서 만든다. mTLS 기기는 `MTLS_CERT`로 등록해야 하며, 두 자격을 함께 쓰는 기기는 아직 없다(문서화). |
| 시험 | 0 | 1 | 0 | 중간: `DeviceApprovalPanel`의 실제 QR/가짜 무늬 분기는 단위 시험이 아니라 브라우저 확인으로 덮었다(문서화). |
| 운영 | 0 | 2 | 0 | 중간: mTLS 비밀 값은 단일 env라 회전 절차가 없다(후속). 중간: mTLS 수락·거절 지표가 없다(후속). |

**높음 0, 중간 6(전부 문서화·후속), 낮음 0.** 브라우저 확인에서 기기 인증만 하는 mTLS 경로가 cnf를 요구해 실패하는 결함과, React StrictMode가 로그인 흐름을 두 번 돌려 승인 화면을 덮어쓰는 결함을 찾아 웨이브 안에서 고쳤다.

### 브라우저 확인(소유자 Chrome, browse)

- **SCR-036 `/login?live=1`**: 실제 QR `<img src="data:image/png;base64,...">` 표시, QR alt와 화면 확인 코드가 `BCDF-GHJK`로 일치. 승인 뒤 "로그인했습니다"와 함께 IndexedDB `session/staff-token`에 `{token, expiresAtMs}` 저장.
- **만료·재로그인**: 만료 토큰(`expiresAtMs: 1`)을 넣고 `/setup?live=1`을 새로고침하면 "스태프 로그인이 필요합니다"로 돌아가고, `/login?live=1`에서 다시 승인하면 토큰이 새 값으로 저장됐다.
- 스크린샷: `.cache/browser-r591-scr036-qr.png`(실제 QR·코드)·`.cache/browser-r591-scr036-approved.png`(승인 완료). 작업 기록이라 커밋하지 않는다.

### 화면/번들

- `pnpm --filter @peaket/ds test`: **71 통과**.
- web visual: `node lib/docker.mjs visual` **348 통과**(Chromium·WebKit, 1.9분). `DeviceApprovalPanel` 스토리는 없어 이 화면 자체의 스냅샷은 아니고, 기존 시각 회귀가 없다는 확인이다.
- scanner 운영 빌드: 초기 `index-*.js` **330.78kB**, QR 동적 청크 `browser-*.js` **23.45kB**. QR은 로그인 화면에서만 내려받는다.

## 3. 남은 막힘(정확한 기록)

- **외부 관리형 기기·사설 CA 없음**: 실제 Android Enterprise 관리형 기기, PEAKET 사설 CA, Envoy Gateway `ClientValidationContext`·`mtls_authenticated` RBAC, 브라우저 `AutoSelectCertificateForUrls` PoC는 이 저장소·환경에 없다. 그래서 실제 배포 경로는 켜지 않았고, 게이트웨이 머리 신뢰 경계와 자체 서명 인증서 PoC까지만 넣었다. 정확한 막힘: `managed-device`, `private-ca`, `gateway-client-cert-verification`, `browser-auto-select-certificate`.
- **identity mTLS 토큰 발급**: identity-svc의 기기 승인 로그인은 아직 DPoP `cnf.jkt`만 발급한다. mTLS `cnf.x5t#S256` 스태프 토큰 발급은 사설 CA·관리형 기기 PoC 뒤에 붙인다(이번 PoC는 게이트웨이가 검증한 `x-user-x5t`를 받는 자원 서버 쪽 경로다).
- **SCR-036 QR**: 실제 QR 표시·코드 일치·승인·토큰 저장·재로그인은 확인했다. 휴대폰 카메라로 스캔해 승인 화면을 여는 실제 기기 흐름은 관리형 기기 PoC 뒤에 본다.
- **mTLS 수락·거절 지표·비밀 값 회전**은 후속이다. 현재는 로그와 시험으로만 확인한다.
