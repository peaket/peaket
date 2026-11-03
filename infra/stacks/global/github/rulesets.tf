# git flow 규칙 세트(docs/devops.md §2.2.6)는 공개 모노레포 peaket에만 건다(ADR-0169).
# 비공개 peaket-bots에는 걸지 않는다(무료 등급에는 비공개 저장소 규칙 세트가 없다).
# main 규칙 세트는 demo 환경 배포 성공을 요구하므로 환경을 먼저 만든다.

module "git_flow" {
  source = "../../../modules/github"

  repository                = github_repository.this["peaket"].name
  release_bot_app_id        = var.release_bot_app_id
  required_approvals        = var.required_approvals
  require_code_owner_review = var.require_code_owner_review
  # 1인 기간: develop은 조직 관리자(소유자)만 우회해 바로 푸시한다(소유자 결정 2026-11-03, FND-160)
  develop_admin_bypass = true
  # 데모 환경(클라우드)이 없는 기간에는 main 병합 전 데모 배포 성공을 요구하지 않는다. 데모가 생기면 ["demo"]로 되돌린다(소유자 결정 2026-11-03)
  main_required_deployments = []

  depends_on = [
    github_branch_default.this,
    github_repository_environment.this,
    github_repository_environment_deployment_policy.this,
  ]
}
