output "repositories" {
  description = "저장소 이름과 주소"
  value       = { for name, r in github_repository.this : name => r.html_url }
}

output "teams" {
  description = "팀 이름표와 ID"
  value       = { for slug, t in github_team.this : slug => t.id }
}

output "git_flow_rulesets" {
  description = "저장소별 git flow 규칙 세트 ID"
  value       = { for repo, m in module.git_flow : repo => m.ruleset_ids }
}
