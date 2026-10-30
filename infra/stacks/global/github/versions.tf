# 판 고정(docs/devops.md §9.1). 제공자 잠금 파일 .terraform.lock.hcl을 함께 커밋한다.
# 상태: 처음에는 로컬 상태로 적용하고, wbs 0.4.2에서 backend.tf(S3, use_lockfile)를 더해 옮긴다(ADR-0167의 첫 변경 design.md 결정 6).
terraform {
  required_version = "~> 1.16"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.13"
    }
  }
}

# 토큰은 GITHUB_TOKEN 환경 변수로 받는다(조직 관리 권한, 소유자가 다룬다)
provider "github" {
  owner = var.github_owner
}
