# alert-issue-relay

Alertmanager의 SEV3 경보를 GitHub Issues 티켓으로 바꾸는 작은 플랫폼 서비스다. 같은 지문(경보 하나의 신원)의 발생은 열린 티켓 하나로 모으고, 해제가 오면 그 티켓에 댓글을 달고 닫는다. 기능 F-01-6(OPS-110), 정본은 [docs/observability.md](../../docs/observability.md) §5 '경보 보내는 길' 티켓 중계다.

## 받는 길

- Alertmanager 웹훅(판 4)을 받는 한 경로. `Authorization: Bearer <PEAKET_ALERT_RELAY_TOKEN>`이 맞아야 한다. (경로 이름은 계획 `docs/review/plans/F-01-6.md` §5에 있고, 계약 `docs/api/`에는 넣지 않는 내부 경로다.)
- 202 `{"accepted": <받은 경보 수>}` — GitHub 호출이 끝난 뒤 답한다.
- 400 `application/problem+json` — 몸이 판 4 모양이 아니다.
- 401 `application/problem+json` — 토큰이 없거나 틀리다. GitHub를 부르지 않는다(로그·지표에 토큰 값을 쓰지 않는다).
- 502 `application/problem+json` — GitHub 호출 실패. Alertmanager가 다시 보내고, 다시 받은 발생 경보는 지문 확인으로 겹치지 않는다.

## 환경 값(모두 필수)

| 이름 | 무엇 |
| --- | --- |
| `PEAKET_ALERT_RELAY_TOKEN` | 웹훅 공유 토큰(Alertmanager `alert-issue-relay-token`과 같은 값) |
| `PEAKET_GITHUB_API_URL` | GitHub REST 기본 주소(`https://api.github.com`) |
| `PEAKET_GITHUB_APP_ID` · `PEAKET_GITHUB_INSTALLATION_ID` | GitHub 앱과 설치 ID |
| `PEAKET_GITHUB_PRIVATE_KEY_FILE` | GitHub 앱 개인 키 PEM 파일 경로 |
| `PEAKET_GITHUB_REPOSITORY` | 경보 티켓을 여는 저장소(`owner/name`) |

배포는 INF-020·INF-040 몫이다(플랫폼 네임스페이스·복제 1·NetworkPolicy는 Alertmanager에서 받기와 GitHub API로 나가기만, 앱 키·웹훅 토큰은 ExternalSecret). 실제 GitHub 앱은 소유자가 만든다.

## 지표·로그

- `alert_relay_alerts_total{decision}` — `created`·`duplicate`·`closed`·`ignored`.
- `alert_relay_rejected_total{reason}` — `missing`·`mismatch`.
- 로그 `event=alert_relay_rejected`(까닭 `reason`) — 토큰 값은 어디에도 쓰지 않는다.

## 시험

```bash
corepack pnpm --filter @peaket/alert-issue-relay test
```

시험은 가짜 GitHub API(`node:http`)와 주입한 시계만 쓴다. 실제 GitHub 계정·Docker는 쓰지 않는다. 같은 지문 동시 두 번·쪽 나눔(100·101건)·GitHub 실패와 401 토큰 다시 받기·몸 형식·개인정보 가림·토큰 거절을 본다(V-T53 ④⑤⑥).
