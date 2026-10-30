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

variable "main_required_deployments" {
  description = "main에 병합하기 전에 배포가 성공해야 하는 환경"
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
