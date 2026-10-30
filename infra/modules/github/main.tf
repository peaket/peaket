# 저장소 하나의 git flow 규칙 세트 넷(docs/devops.md §2.2.6, ADR-0074).
# 릴리스 봇 우회는 봇만 하는 일(release/*·hotfix/* 만들기, v* 태그)에만 둔다.
# main·develop은 봇도 PR과 필수 검사를 거친다.

locals {
  bot_bypass = var.release_bot_app_id == null ? [] : [var.release_bot_app_id]
}

resource "github_repository_ruleset" "main" {
  name        = "main"
  repository  = var.repository
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
      allowed_merge_methods           = ["merge"]
      required_approving_review_count = var.required_approvals
      require_code_owner_review       = var.require_code_owner_review
      dismiss_stale_reviews_on_push   = true
    }

    required_status_checks {
      dynamic "required_check" {
        for_each = var.required_checks_main
        content {
          context        = required_check.value
          integration_id = var.status_check_integration_id
        }
      }
    }

    required_deployments {
      required_deployment_environments = var.main_required_deployments
    }
  }
}

resource "github_repository_ruleset" "develop" {
  name        = "develop"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/develop"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    # 작업 가지는 스쿼시, 역병합은 병합 커밋. 역병합 때문에 선형 이력은 요구하지 않는다
    pull_request {
      allowed_merge_methods           = ["squash", "merge"]
      required_approving_review_count = var.required_approvals
      require_code_owner_review       = var.require_code_owner_review
      dismiss_stale_reviews_on_push   = true
    }

    required_status_checks {
      dynamic "required_check" {
        for_each = var.required_checks_develop
        content {
          context        = required_check.value
          integration_id = var.status_check_integration_id
        }
      }
    }
  }
}

resource "github_repository_ruleset" "release_hotfix" {
  name        = "release-hotfix"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/release/*", "refs/heads/hotfix/*"]
      exclude = []
    }
  }

  dynamic "bypass_actors" {
    for_each = local.bot_bypass
    content {
      actor_id    = bypass_actors.value
      actor_type  = "Integration"
      bypass_mode = "always"
    }
  }

  rules {
    creation         = true # 릴리스 봇만 만든다
    non_fast_forward = true

    # 받는 것은 bugfix/* 스쿼시와 역병합
    pull_request {
      allowed_merge_methods           = ["squash", "merge"]
      required_approving_review_count = var.required_approvals
      require_code_owner_review       = var.require_code_owner_review
    }
  }
}

resource "github_repository_ruleset" "release_tags" {
  name        = "release-tags"
  repository  = var.repository
  target      = "tag"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/tags/v*"]
      exclude = []
    }
  }

  dynamic "bypass_actors" {
    for_each = local.bot_bypass
    content {
      actor_id    = bypass_actors.value
      actor_type  = "Integration"
      bypass_mode = "always"
    }
  }

  # 만든 태그는 옮기거나 지우지 않는다(docs/devops.md §2.2.5)
  rules {
    creation = true
    update   = true
    deletion = true
  }
}
