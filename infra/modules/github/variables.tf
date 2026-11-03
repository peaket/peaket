variable "repository" {
  description = "규칙 세트를 걸 저장소 이름"
  type        = string
}

variable "required_checks_develop" {
  description = "develop으로 가는 PR의 필수 검사(wbs 0.1.2의 잡 이름과 같아야 한다, docs/devops.md §2.2.6)"
  type        = list(string)
  default     = ["ci-summary", "branch-policy"]
}

variable "required_checks_main" {
  description = "main으로 가는 PR의 필수 검사. merge-tree는 병합 결과 트리 검사다(docs/devops.md §2.2.4)"
  type        = list(string)
  default     = ["ci-summary", "branch-policy", "merge-tree"]
}

variable "status_check_integration_id" {
  description = "필수 검사를 받아 줄 출처 GitHub 앱 ID. 기본은 GitHub Actions(15368, gh api apps/github-actions로 2026-10-30 확인). 다른 앱이 같은 이름의 검사를 '통과'로 찍지 못하게 한다"
  type        = number
  default     = 15368
}

variable "main_required_deployments" {
  description = "main에 병합하기 전에 배포가 성공해야 하는 환경. 비우면 배포 요구를 걸지 않는다"
  type        = list(string)
  default     = ["demo"]
}

variable "release_bot_app_id" {
  description = "릴리스 봇 GitHub 앱 ID. null이면 우회 주체를 두지 않는다(앱은 소유자가 웹에서 만든다)"
  type        = number
  default     = null
}

variable "required_approvals" {
  description = "필수 승인 수. 1인 기간에는 0이다(docs/devops.md §2.3)"
  type        = number
  default     = 0
}

variable "require_code_owner_review" {
  description = "코드 주인 검토 요구. 1인 기간에는 끈다(작성자는 자기 PR을 승인할 수 없다)"
  type        = bool
  default     = false
}

variable "develop_admin_bypass" {
  description = "develop 규칙 세트에서 조직 관리자가 우회해 바로 푸시할 수 있게 할지. 1인 기간의 소유자 결정(2026-11-03, docs/devops.md §2.2.6)"
  type        = bool
  default     = false
}
