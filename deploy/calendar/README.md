# 변경 동결 달력(`deploy/calendar/`)

승인된 온세일 일정에서 앞으로 7일의 **변경 동결 창**을 계산해 두는 자리다. 정본은 [docs/devops.md](../../docs/devops.md) §8이고, 이 폴더의 파일은 `freeze-calendar`가 만든다(사람이 고치지 않는다). 기능 F-02-3(OPS-320)의 동결 범위 로컬 구현이며, v1 배포 범위 밖이다(ADR-0373).

## 파일

| 파일 | 무엇 |
| --- | --- |
| `freeze.json` | 계산한 창 목록. `windows[]`(회차·규모·범위·오픈·시작·끝·자동 중단 시각·ArgoCD 창·Karpenter 예산), `deployableHoursNext7d{all,hotpath}`. 10분마다 다시 그린다 |
| `rendered/argocd-windows.json` | AppProject 아홉에 걸 deny 창(UTC 크론·기간·`manualSync: true`). 실제 적용은 `CalendarApplier`(구간 5) |
| `rendered/karpenter-budgets.json` | 모든 NodePool에 걸 중단 예산 `nodes: "0"`. 실제 적용은 `NodePoolBudgetApplier`(구간 5) |

- 봇은 이 폴더 밖을 바꾸지 않는다(docs/devops.md §8.2 '봇 쓰기 범위'). 지난 창은 지우고, 오픈 시각이 7일 뒤보다 먼 회차는 넣지 않는다.
- 일정 파일(`ops-calendar/upcoming-onsales.json`)을 못 읽거나 30분 넘게 낡았으면 파일을 바꾸지 않는다(이미 걸린 창 유지). 이때 30분 경보 `FreezeCalendarStale`이 울리고, 2시간을 넘기면 `freeze-gate`가 운영 승격을 막는다.

## 명령

```bash
# 로컬: 일정 파일 하나로 달력 한 번 그리기
PEAKET_FREEZE_SCHEDULE_FILE=./upcoming-onsales.json pnpm --filter @peaket/freeze-calendar start -- calendar
# 운영: S3(ops 버킷)에서 읽기
PEAKET_FREEZE_SCHEDULE_BUCKET=<버킷> PEAKET_FREEZE_SCHEDULE_KEY=ops-calendar/upcoming-onsales.json pnpm --filter @peaket/freeze-calendar start -- calendar
# 가드: 창의 자동 중단 시각(T-45분·T-15분)에 진행 중 롤아웃 중단(로컬은 파일 원천)
PEAKET_FREEZE_ROLLOUTS_FILE=./rollouts.json pnpm --filter @peaket/freeze-calendar start -- guard
# 승격 게이트만 보기
node tools/ci/freeze-gate.mjs --check --env prod --changed deploy/envs/prod/queue-svc.yaml --now 2026-11-24T10:00:00Z
```

## 환경 값

| 이름 | 필수 | 뜻 |
| --- | --- | --- |
| `PEAKET_FREEZE_SCHEDULE_FILE` | 로컬 하나 | 온세일 일정 파일 경로(로컬·시험) |
| `PEAKET_FREEZE_SCHEDULE_BUCKET`·`_KEY` | 운영 | S3 버킷과 키(기본 `ops-calendar/upcoming-onsales.json`) |
| `PEAKET_FREEZE_S3_ENDPOINT` | 아니오 | 로컬 AWS 흉내 서버(moto) 주소 |
| `PEAKET_FREEZE_ROOT` | 아니오 | 산출물을 쓸 저장소 루트(기본 현재 폴더) |
| `PEAKET_FREEZE_CALENDAR_FILE` | 아니오 | 가드가 읽을 `freeze.json` 경로(기본 `<루트>/deploy/calendar/freeze.json`) |
| `PEAKET_FREEZE_ROLLOUTS_FILE` | 로컬 가드 | 롤아웃 목록 JSON(운영은 Argo Rollouts API, 구간 5) |

## 시험

```bash
pnpm --filter @peaket/freeze-calendar test
node --test tools/ci/freeze-gate.test.mjs
```

## 아직 없는 것(구간 5, INF-020)

- S3 일정 파일을 쓰는 ops-svc 쪽 작업과 버킷·KMS·IAM
- ArgoCD AppProject 창·Karpenter NodePool 예산·Argo Rollouts 중단의 실제 어댑터와 RBAC, CronJob 두 개(10분·1분), 같은 이미지

Docker·kind 없이 도는 로컬 시험은 계산·렌더·게이트·중단 판정까지다.
