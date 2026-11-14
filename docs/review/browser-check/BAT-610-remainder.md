# BAT-610 잔여 브라우저 확인 (R-588)

- **환경**: Windows, Docker 없음. `apps/partner` 운영 빌드(`next start -p 4201`, `NEXT_PUBLIC_PARTNER_API_ORIGIN=http://127.0.0.1:4012`), 가짜 API `tools/web-checks/partner-api/server.mjs --port 4012`.
- **도구**: 소유자 Chrome, browse(Playwright). `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`는 임시 난수 32바이트로 넣었다.
- **가짜 API**: 예매자 명단은 계약 모양(`buyerNameMasked`·`buyerPhoneMasked`·`seats`·`ticketCount`), 내려받기는 `X-Reauth-Token`이 `test-booker-export-token`일 때만 200이다. XLSX는 최소 ZIP 머리와 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`를 준다.

## 확인한 흐름

| # | 흐름 | 결과 |
| --- | --- | --- |
| 1 | `/events/evt-lumen-2026/settlement` → [예매자 명단] | 4건·9매, `김*수`·`010-****-1234`, 좌석·매수 표시 |
| 2 | [명단 내려받기] 사유·비밀번호·TOTP, CSV 선택 | `POST …/attendee-exports` 200 `text/csv`, `x-reauth-token` 실림, 파일 이름 `예매자명단.csv`, 성공 배너 |
| 3 | 같은 흐름, XLSX 선택 | 200 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 파일 이름 `예매자명단.xlsx`, 성공 배너 |
| 4 | [다운로드 이력] | 사유·건수(4건)·형식(XLSX)·결과(완료) 표시 |
| 5 | ops 지급 승인 | console-host에 SCR-049 화면이 없어 브라우저 대신 `services/ops-svc/test/payout-approval.test.ts`의 HTTP·유스케이스 시험으로 대체 |

- 콘솔 오류는 비밀번호 입력 칸의 DOM 안내 한 줄뿐이고 화면을 막는 오류는 없었다.
- 운영 빌드 서버 4201, 가짜 API 4012를 끝냈다. Docker 컨테이너는 만들지 않았다.
