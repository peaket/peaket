output "ruleset_ids" {
  description = "규칙 세트 이름별 ID"
  value = {
    main           = github_repository_ruleset.main.ruleset_id
    develop        = github_repository_ruleset.develop.ruleset_id
    release_hotfix = github_repository_ruleset.release_hotfix.ruleset_id
    release_tags   = github_repository_ruleset.release_tags.ruleset_id
  }
}
