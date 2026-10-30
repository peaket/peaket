# git flow 규칙 세트(docs/devops.md §2.2.6). peaket과 .github은 같은 규칙을 쓴다(§2.2.5).
# 비공개 peaket-loadtest에는 걸지 않는다(무료 등급에는 비공개 저장소 규칙 세트가 없다).

module "git_flow" {
  source   = "../../../modules/github"
  for_each = toset(["peaket", ".github"])

  repository                = github_repository.this[each.key].name
  release_bot_app_id        = var.release_bot_app_id
  required_approvals        = var.required_approvals
  require_code_owner_review = var.require_code_owner_review

  depends_on = [github_branch_default.this]
}

# peaket-gitops는 main 하나와 짧은 작업 가지·봇 승격 PR만 쓴다(§2.2.5). 필수 검사는 wbs 0.4.4에서 더한다
resource "github_repository_ruleset" "gitops_main" {
  name        = "main"
  repository  = github_repository.this["peaket-gitops"].name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count = var.required_approvals
      require_code_owner_review       = var.require_code_owner_review
    }
  }
}
