variable "github_owner" {
  description = "GitHub 조직 이름(소유자 결정 2026-10-30)"
  type        = string
  default     = "peaket"
}

variable "owner_login" {
  description = "가상 팀 아홉에 관리자로 넣을 사람의 GitHub 로그인(1인 기간에는 소유자 한 사람)"
  type        = string
}

variable "release_bot_app_id" {
  description = "릴리스 봇 GitHub 앱 ID. 앱을 만들기 전에는 null이다"
  type        = number
  default     = null
}

variable "prod_reviewer_user_ids" {
  description = "prod 환경 배포를 승인할 사람의 GitHub 사용자 ID(숫자, 1~6명). 1인 기간에는 소유자 한 사람이다"
  type        = list(number)

  validation {
    condition     = length(var.prod_reviewer_user_ids) >= 1 && length(var.prod_reviewer_user_ids) <= 6
    error_message = "prod 승인자는 1~6명이어야 한다(GitHub 환경 검토자 상한 6)."
  }
}

variable "required_approvals" {
  description = "PR 필수 승인 수. 1인 기간에는 0이다(docs/devops.md §2.3)"
  type        = number
  default     = 0
}

variable "require_code_owner_review" {
  description = "코드 주인 검토 요구. 1인 기간에는 끈다"
  type        = bool
  default     = false
}

variable "actions_patterns_allowed" {
  description = "허용할 제3자 액션 패턴. 비워 두고 wbs 0.1.2에서 쓰는 것만 더한다(docs/devops.md §4.5)"
  type        = list(string)
  default     = []
}
