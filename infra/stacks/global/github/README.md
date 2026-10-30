# GitHub 조직 설정 스택

GitHub 조직 `peaket`의 설정을 Terraform으로 관리한다. 무엇을 왜 이렇게 두는지는 정본에 있다. 규칙 세트는 [docs/devops.md](../../../../docs/devops.md) §2.2.6, 관리 대상 목록은 같은 문서 §2.3, 저장소 4개는 §2.1, Actions·토큰·OIDC는 §4.5, 환경은 §5.1이다. 이 안내서는 적용하는 방법만 적는다.

## 파일

| 파일 | 담는 것 |
| --- | --- |
| `teams.json` | 가상 팀 아홉의 목록. `.github/CODEOWNERS` 검사(`tools/ci/check-codeowners.mjs`)도 이 파일을 읽는다 |
| `repositories.tf` | 저장소 4개, `develop` 가지, 기본 가지 |
| `rulesets.tf` | git flow 규칙 세트(모듈 `infra/modules/github`)와 `peaket-gitops`의 `main` 규칙 세트 |
| `teams.tf` | 팀, 팀 관리자, 팀별 저장소 권한 |
| `environments.tf` | `peaket`의 환경 넷과 배포할 수 있는 가지 |
| `actions.tf` | 조직 Actions 허용 목록·SHA 고정, 워크플로 토큰 기본 권한, OIDC 주체 키 |

## 검사(조직 없이 할 수 있음)

```bash
terraform fmt -check -recursive infra
terraform -chdir=infra/stacks/global/github init -backend=false
terraform -chdir=infra/stacks/global/github validate
```

## 적용 순서(조직이 생긴 뒤)

1. 소유자가 GitHub 조직 `peaket`을 만든다. 조직 관리 권한이 있는 토큰을 `GITHUB_TOKEN` 환경 변수로 둔다. 토큰은 파일에 적지 않는다.
2. `terraform.tfvars.example`을 `terraform.tfvars`로 복사해 `owner_login`과 `prod_reviewer_user_ids`(prod 배포 승인자, 1인 기간에는 소유자)를 채운다(`terraform.tfvars`는 커밋하지 않는다).
3. 저장소만 먼저 만든다: `terraform apply -target=github_repository.this`
4. 이 저장소의 `main`과 `develop`을 원격 `peaket`에 밀어 넣는다. 공개 게시라 소유자가 다시 확인한다.
5. wbs 0.1.2의 CI(`ci-summary`, `branch-policy`, `merge-tree` 잡)가 한 번 돈 뒤 전체를 적용한다: `terraform apply`. 필수 검사가 한 번도 돌지 않은 채로 규칙 세트를 걸면 모든 PR이 그 검사를 기다리며 막힌다.
6. 릴리스 봇 GitHub 앱을 만들면 `release_bot_app_id`를 넣고 다시 적용한다. 그때 `release/*`·`hotfix/*`·`v*` 규칙 세트에 봇 우회가 생긴다.

## 상태

처음에는 로컬 상태(`terraform.tfstate`, 커밋하지 않음)로 적용한다. wbs 0.4.2에서 상태 버킷을 만들면 `backend.tf`(S3, `use_lockfile`)를 더하고 `terraform init -migrate-state`로 옮긴다([docs/devops.md](../../../../docs/devops.md) §9.1). 상태를 잃으면 이 스택의 자원은 `terraform import`로 되살린다.
