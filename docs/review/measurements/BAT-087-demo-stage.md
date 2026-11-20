# BAT-087 데모 무대 측정(로컬 kind)

- **언제**: 2026-11-20(금) 19:50~22:30 KST
- **어디서**: Windows 11 PC, Docker Desktop(Linux 컨테이너), kind v0.33.0(`kindest/node:v1.35.8`), kubectl v1.35.8, helm v3.22.1
- **가지**: `feature/lane4-BAT-087`, 출발점 `origin/develop` `2943d73c7` + BAT-087 커밋
- **무엇**: `node tools/local/demo-images.mjs --build` → `node tools/local/cluster.mjs demo --skip-build` → `demo-seed --apply` → `demo-status` → `tools/local/e2e/demo-stage.e2e.mjs`
- **Docker 잠금**: `lane4-BAT-087`(30분마다 놓고 다시 잡음). 측정 중 다른 갈래의 Docker 작업은 돌리지 않았다.

## 이미지

| 이미지 | 크기 |
| --- | --- |
| `peaket/identity-svc:demo` | 629MB |
| `peaket/ticket-svc:demo` | 612MB |
| `peaket/trust-svc:demo` | 614MB |
| `peaket/core-svc:demo` | 620MB |
| `peaket/realtime-gw:demo` | 598MB |
| `peaket/web:demo` | 1.13GB |
| `peaket/partner:demo` | 388MB |
| `peaket/console-host:demo` | 94.6MB |
| `peaket/scanner:demo` | 82.5MB |
| `peaket/queue-room:demo` | 80.6MB |

- 새 이미지 10개 빌드: 19:52:47~20:08:01(15분 14초). web·partner는 `pnpm --filter …... build`로 고친 뒤 성공했다.
- 재사용 이미지 셋(`bundle`·`ops-svc`·`pg-simulator`)은 이전 시험 실행 것이 있었다. `--skip-build`로 실었다.

## 무대 준비

| 회차 | 무엇 | 시간 | 결과 |
| --- | --- | --- | --- |
| 1 | `demo`(이미지 빌드 포함) | 15분 14초 | pg-simulator가 차트 기본 명령(`template/dist/main.js`)으로 죽어 멈춤 |
| 2~4 | `demo`(고침 반복) | 8~12분 | ops 마이그레이션 역할·bundle·nodeSelector·웹 키를 하나씩 고침 |
| 5 | `demo`(clean) | 14분 | **준비됨**. 게이트웨이 조건 모두 참 |
| 6 | `demo`(최종, 22:04) | 12분 30초 | **준비됨**. `demo-status` 15/15 준비 |

- 최종 무대: 게이트웨이 이 PC 포트 `www/api 18441`, `queue 18442`, `partner 18443`, `ops/console 18444`, `scanner 18445`, identity gRPC 19051, 모의 기관 18920.
- 마이그레이션 잡 여섯(identity·ticket·core·ops·purchase·payment) 모두 `Complete`.

## 시드

- 첫 적용(빈 DB): `created {productions:4, events:7, seatMaps:4, staff:2, devices:3}`(좌석맵은 공연 단위로 한 번만 PUT).
- 두 번째 적용: `created {productions:0, events:0, seatMaps:0, staff:0, devices:0}`, `total`은 같다.
- 판매 심사는 BAT-616이 develop에 아직 병합되지 않아 404였고, 로컬 데모 예외로 `sale_review`만 `SUBMITTED`로 바꾼 뒤 관제 승인했다(경고를 stderr에 남긴다). BAT-616 병합 뒤 다시 rebase하면 이 예외는 쓰이지 않는다.

## 연기 시험(`tools/local/e2e/demo-stage.e2e.mjs`)

| 회차 | 시간 | 결과 | 멈춘 곳 |
| --- | --- | --- | --- |
| 1 | 915.8초 | exit 1 | `before`의 `cluster.mjs demo --skip-build`가 `ops-svc` helm 대기에서 실패(이전 실패 릴리스의 남은 상태) |
| 2 | 719.8초 | exit 1 | `demo` 준비 494초. DS-07·DS-10 통과, DS-02·DS-08·DS-09 실패(아래) |

- **DS-07 통과**: 15/15 준비, 마이그레이션 잡 여섯 `Complete`, scanner를 0으로 줄이면 `demo-status`가 exit 1.
- **DS-10 통과**: `demo-down` 두 번 exit 0, 데모 네임스페이스만 지우고 `lane4-demo`·다른 클러스터 유지.
- **DS-02 실패(시험 이의)**: 모든 이미지에 `node --version`을 부르는데 console-host·scanner·queue-room은 nginx 이미지라 node가 없다(exit 127). 계획은 nginx 이미지에 `nginx -t`만 보라고 적었다.
- **DS-09 실패**: 시드가 관리자 로그인 뒤 곧바로 재생기가 같은 TOTP 칸으로 로그인해 401(재사용)이 났다. `demo-auth`에 다음 칸 재시도를 넣었다. 그 뒤에도 `GET /v1/partner/productions`가 core-svc에 없어(404) 공연 수를 셀 수 없다(HOT-260, 이 묶음은 API를 만들지 않는다).
- **DS-08 실패**: DS-09가 회차 ID를 얻지 못해 `api` 공개 회차 조회를 부를 수 없다(게이트웨이 자체는 `www 200`, 인증 없는 `queue 401`·`partner-api 401`·`ops-api 404`·`scanner-api 404`로 5xx가 아니었다).

## 실패·한계

- **파트너 공연 목록·상세·스태프 API 없음**: `GET /v1/partner/productions`·`GET /v1/partner/productions/{id}`·`GET /v1/partner/events/{eventId}/staff`는 HOT-260·R-548 몫이다. 시드는 직접 SQL로 대신하지만, `demo-stage.e2e.mjs` DS-09가 이 API를 직접 부르면 404다(시험 파일은 고치지 않았다). DS-08도 회차 ID를 DS-09에서 받으므로 함께 막힌다.
- **BAT-616 미병합**: 파트너 판매 심사 제출 경로가 없어 404 예외를 쓴다.
- **openssl**: 게이트웨이 인증서 생성에 필요하다. Windows PowerShell에서는 `C:\Program Files\Git\usr\bin`을 PATH에 둬야 한다.
- **합본·로컬 이미지·부트스트랩 감사 없음**: 계획·README의 한계와 같다.
- **이 절은 2026-11-20 실행의 기록이다.** 시험 이의 고침과 6/6 재실행은 아래 '2026-11-21 시험 이의 고침·재실행' 절에 있다.

## 2026-11-21 시험 이의 고침·재실행(6/6)

- **고친 것**: `tools/local/e2e/demo-stage.e2e.mjs`만 고쳤다(제품 코드 없음). DS-02는 nginx 이미지(console-host·scanner·queue-room)에 `nginx -t`, node 이미지(서비스 다섯·web·partner)에 `node --version`을 본다. DS-09는 `GET /v1/partner/productions`(HOT-260) 대신 시드 `--json`의 `total`과 core DB의 `production`·`event` 수를 견주고, 공개 회차 ID는 core DB에서 읽는다. DS-08은 그 ID로 `api` 공개 조회를 부른다(5xx 없음 유지).
- **게이트**: `demo-images --check` exit 0, `demo-seed --check` exit 0, `node --test "tools/local/*.test.mjs"` 204개 중 200 통과·4 건너뜀·0 실패(47.3초), `check-docker-timeouts` 통과.
- **실행**(모두 Docker 잠금 `lane4-BAT-087` 안):

| 회차 | `demo --skip-build` | e2e | 결과 | 비고 |
| --- | --- | --- | --- | --- |
| 1 | 619초 | 872.3초 | 5/6 | DS-09② 테스트 결함(`firstTotals`에 `devices`가 섞임) |
| 2 | 603초 | 764.2초 | 5/6 | 같은 결함(같은 객체를 복사하지 않음) |
| 3 | 614초 | 812.0초 | **6/6** | 고친 뒤 통과 |

- **최종 회차(3회)**: 23:41:39에 잠금, `demo --skip-build` 614초(23:41:39~23:51:53), e2e 812.0초(23:51:53~00:05:25, 시험 안 `demo` 준비 529초). DS-02 554.9초(준비 포함), DS-09① 24.5초, DS-07 13.6초, DS-08 0.1초, DS-09② 44.4초, DS-10 172.7초.
- **결과 값**: 첫 시드 `created {productions:4, events:7, seatMaps:4, staff:2, devices:3}`, `total {accounts:11, passkeys:3, promoters:1, productions:4, events:7, seatMaps:7, staff:2, devices:3}`. 두 번째 시드 `created {productions:0, events:0, seatMaps:0, staff:0, devices:0}`, DB 4/7. 게이트웨이 응답 `{"www":200,"queue":401,"partner-api":401,"ops-api":404,"scanner-api":404,"api":200}`.
- **정리**: `demo-down` 두 번 exit 0, 데모 네임스페이스 여섯 0, `demo-status` exit 1(15개 `missing`), `lane4-demo` 클러스터 유지, Docker 잠금 `drop`, `docker ps -a --filter name=peaket` 0건.
- **BAT-616**: 이 가지의 바탕 `57de13831`에는 파트너 판매 심사 제출 경로가 없다(`feature/lane5-BAT-616`에만 있다). 그래서 시드는 404일 때만 `sale_review`를 직접 `SUBMITTED`로 바꾸는 예외를 그대로 썼다.
- **문서 점검**: `python -I -X utf8 tools/doc-check/check_all.py`는 오류 2건이 난다. 둘 다 develop의 `docs/review/plans/BAT-182.md`가 없는 `tools/web-checks/reports/...` 경로를 가리키는 기존 결함이고, 이 묶음의 파일과 무관하다.
