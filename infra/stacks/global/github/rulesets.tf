# git flow 규칙 세트(docs/devops.md §2.2.6)는 공개 모노레포 peaket에만 건다(ADR-0169).
# 비공개 peaket-bots에는 걸지 않는다(무료 등급에는 비공개 저장소 규칙 세트가 없다).

module "git_flow" {
  source = "../../../modules/github"

  repository                = github_repository.this["peaket"].name
  release_bot_app_id        = var.release_bot_app_id
  required_approvals        = var.required_approvals
  require_code_owner_review = var.require_code_owner_review

  depends_on = [github_branch_default.this]
}
