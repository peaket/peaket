# Alertmanager 설정 원천

경보를 받는 곳 다섯으로 나눠 보내는 설정이다. 정본은 [docs/observability.md](../../../../docs/observability.md) §5 '경보 보내는 길'·§5 심각도별 채널 표이고, 이 글은 파일과 비밀을 어떻게 두는지만 적는다. 실제 배포(Alertmanager, 비밀 파일, 받는 곳 주소)는 INF-020·INF-040이 맡는다(ADR-0331 결정 9).

## 파일

| 자리 | 무엇 | 검사 |
| --- | --- | --- |
| `alertmanager.yaml` | 받는 곳 다섯·경로·묶음 값·문구 틀 자리 | `tools/ci/alertmanager-config.test.mjs`(V-T53 ③), `packages/platform/test-int/alertmanager-routes.int.test.ts`(V-T53 ①⑤) |
| `templates/peaket.tmpl` | Slack 제목·본문(정한 라벨·주석만 싣는다) | `tools/ci/alertmanager-config.test.mjs`(V-T53 ⑤), 통합 시험 |

## 받는 곳과 비밀

주소·토큰은 설정 파일에 적지 않는다. Alertmanager가 컨테이너 안 `/etc/alertmanager/secrets/` 아래 파일을 읽는다(`url_file`·`api_url_file`·`http_config.authorization.credentials_file`).

| 받는 곳 | 비밀 파일 |
| --- | --- |
| `irm-oncall` | `irm-oncall-url` |
| `slack-ops` | `slack-ops-url` |
| `github-issues` | `alert-issue-relay-url`·`alert-issue-relay-token` |
| `deadman` | `healthchecks-ping-url` |
| `evidence-collector` | `evidence-collector-url`·`evidence-collector-token` |

`alert-issue-relay-url`은 `services/alert-issue-relay`의 Alertmanager 웹훅 받는 경로를 가리키고, 토큰은 그 서비스의 `PEAKET_ALERT_RELAY_TOKEN`과 같다. IRM·Slack·Healthchecks 계정과 GitHub 앱은 소유자 몫이다.

## 시험에 쓰는 이미지

플랫폼 통합 시험(`packages/platform/test-int/alertmanager-routes.int.test.ts`·`alertmanager-deadman.int.test.ts`, V-T53 ①②⑤)이 아래 판을 Docker로 띄운다. 값의 원본은 도우미 `packages/platform/test-int/alertmanager.ts`의 `ALERTMANAGER_IMAGE`이고, 판을 올리면 그 상수와 이 줄을 함께 고친다.

- Alertmanager: `prom/alertmanager:v0.35.0@sha256:e638797febd034838eca8b98cdbd46f951e9bf7f178777aa8669167406a9946c`

## 바꾸는 법

1. `alertmanager.yaml`을 고친다. 받는 곳을 더하면 위 표와 `tools/ci/alertmanager-config.test.mjs`의 받는 곳·비밀 목록도 함께 고친다.
2. `node --test tools/ci/alertmanager-config.test.mjs`로 설정 키를 확인한다.
3. Docker 잠금을 잡고 `pnpm --filter @peaket/platform test:integration test-int/alertmanager-routes.int.test.ts test-int/alertmanager-deadman.int.test.ts`를 돌린다(실제 Alertmanager·Prometheus).
4. 배포는 INF-020·INF-040에 넘긴다. 비밀 파일 일곱과 문구 틀 싣기는 그쪽 몫이다.
