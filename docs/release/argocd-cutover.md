# Argo CD 릴리스 소스 전환 준비

- **독자와 용도**: v1 출시 때 Argo CD가 읽는 배포 상태를 `develop`에서 릴리스 태그(`v1.0.0`) 또는 `main`으로 바꾸는 절차를 미리 확인한다. 지금은 **준비 문서**이고, 실제 전환·태그 푸시·클러스터 적용은 소유자 승인 뒤에 한다.
- **정본**: `docs/devops.md` §2.2.5(Argo CD는 `develop`의 `deploy/`만 읽는다), §5.4(릴리스 플래그·배포), ADR-0169·ADR-0386, `docs/release/v1-scope.md` §5.
- **상태**: 2026-11-25 초안. 소유자 승인 전에는 어떤 Application의 `targetRevision`도 바꾸지 않는다.

## 1. 지금과 바꿀 뒤

| | 지금 | v1 출시 뒤 |
| --- | --- | --- |
| Argo CD가 읽는 가지 | `develop` | `v1.0.0` 태그(권장) 또는 `main` |
| 배포 상태의 원천 | `deploy/`의 최신 develop | 출시 후보를 자른 `release/1.0.0`을 `main`에 병합한 태그의 `deploy/` |
| 이미지 | 환경 값의 다이제스트 | 출시 후보 다이제스트로 고정 |
| 동결 기능 | `freeze/*` 가지에만 있어 develop에 없음 | 그대로 release에 넣지 않음 |

- 태그를 읽게 하면 같은 태그의 `deploy/`가 두 벌이 되지 않고, `main`이 움직여도 출시본이 바뀌지 않는다.
- `main`을 읽게 하면 핫픽스 병합이 곧 배포가 된다. v1 첫 배포는 **태그 고정**을 권장한다.

## 2. 전환 전에 갖출 것

1. `docs/release/v1-scope.md`의 gate 5개 결과가 모두 기록됐다.
2. `node tools/ci/release-scope.mjs --check`·`--release`와 전체 CI가 초록이다.
3. `release/1.0.0`을 `develop`에서 자르고, 릴리스 가지에는 버그 수정·출시 메타데이터만 넣었다.
4. 릴리스 후보를 데모에서 검증하고 `main`에 병합한 뒤 `v1.0.0` 태그를 달았다.
5. `deploy/envs/prod/`(또는 운영 환경 값)의 이미지 다이제스트가 릴리스 후보와 같다.
6. 소유자가 아래 4의 승인 항목을 확인했다.

## 3. 전환 절차(소유자 승인 뒤)

1. Argo CD Application/ApplicationSet의 `spec.source.targetRevision`을 `v1.0.0`(또는 `main`)으로 바꾼다. 이 설정은 저장소 밖(부트스트랩·Terraform·관리 도구)에 있을 수 있으므로, 실제 파일 위치는 소유자 환경에서 확인한다.
2. 같은 소스의 `path`가 `deploy/envs/prod`(또는 운영 환경 값)를 가리키는지 확인한다.
3. `argocd app diff`로 출시 태그와 현재 클러스터의 차이를 본다. 이미지 다이제스트·마이그레이션·플래그가 출시 계약과 같은지 확인한다.
4. `argocd app sync`는 소유자 또는 commander가 VPN 경로에서 직접 부른다(웹훅 경로는 열지 않는다, ADR-0133).
5. 동기화 뒤 `argocd app get`의 Health/Sync, 게이트웨이 5개의 준비, 핵심 SLO를 확인한다.
6. 문제가 있으면 `targetRevision`을 이전 값(`develop` 또는 이전 태그)으로 되돌리고 `argocd app sync`를 부른다. 이미지 다이제스트도 함께 되돌린다.

## 4. 소유자 승인 체크리스트

- [ ] Argo CD 소스를 `develop`에서 `v1.0.0` 태그(또는 `main`)로 바꾸는 것을 승인한다.
- [ ] `release/1.0.0` 가지와 `v1.0.0` 태그를 원격에 푸시하는 것을 승인한다.
- [ ] 출시 후보 다이제스트와 `deploy/envs/prod`의 값이 같은지 확인한다.
- [ ] 동기화 담당(소유자 또는 commander)과 되돌리기 담당을 정한다.
- [ ] 동결 기능(F-01-8·F-02-4·F-04-9~19 등)이 release에 없다는 `release-scope --release` 결과를 확인한다.

## 5. 하지 않는 것

- 지금 `targetRevision`을 바꾸지 않는다.
- `develop` 밖 가지·태그를 소유자 확인 없이 푸시하지 않는다.
- 이 문서만으로 클러스터를 동기화하지 않는다.
