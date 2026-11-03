# peaket의 환경 넷과 배포할 수 있는 가지(docs/devops.md §5.1, §2.2.6 릴리스 봇의 release 환경).
# 1인 기간에는 prod 승인자가 자기 배포를 승인할 수 있게 둔다(prevent_self_review = false).

locals {
  environments = {
    demo    = ["release/*", "hotfix/*"]
    staging = ["release/*", "hotfix/*"]
    prod    = ["main"]
    release = ["develop", "release/*", "hotfix/*", "main"]
  }

  environment_branches = merge([
    for env, patterns in local.environments : {
      for p in patterns : "${env}/${p}" => { environment = env, pattern = p }
    }
  ]...)
}

resource "github_repository_environment" "this" {
  for_each = local.environments

  repository          = github_repository.this["peaket"].name
  environment         = each.key
  prevent_self_review = false

  dynamic "reviewers" {
    for_each = each.key == "prod" ? [1] : []
    content {
      users = var.prod_reviewer_user_ids
    }
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "this" {
  for_each = local.environment_branches

  repository     = github_repository.this["peaket"].name
  environment    = github_repository_environment.this[each.value.environment].environment
  branch_pattern = each.value.pattern
}
