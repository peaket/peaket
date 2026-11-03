# 조직 Actions 정책(docs/devops.md §4.5): 허용 목록과 SHA 고정, 워크플로 토큰 기본 읽기, OIDC 주체 키.

resource "github_actions_organization_permissions" "this" {
  enabled_repositories = "all"
  allowed_actions      = "selected"
  sha_pinning_required = true

  allowed_actions_config {
    github_owned_allowed = true
    verified_allowed     = false
    patterns_allowed     = var.actions_patterns_allowed
  }
}

resource "github_actions_organization_workflow_permissions" "this" {
  organization_slug                = var.github_owner
  default_workflow_permissions     = "read"
  can_approve_pull_request_reviews = false
}

# AWS 역할의 신뢰 조건을 '저장소·환경·부른 재사용 워크플로'까지 고정한다(ADR-0165 결정 6)
resource "github_actions_organization_oidc_subject_claim_customization_template" "this" {
  include_claim_keys = ["repo", "context", "job_workflow_ref"]
}
