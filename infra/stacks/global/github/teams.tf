# 가상 팀 아홉(teams.json이 정본 목록이다. .github/CODEOWNERS 검사도 같은 파일을 읽는다).
# 권한(docs/devops.md §10.1): 모든 팀은 모노레포 peaket에 쓰고, 플랫폼 팀은 비공개 봇 저장소 peaket-bots에도 쓴다(ADR-0169).

locals {
  teams = { for t in jsondecode(file("${path.module}/teams.json")).teams : t.slug => t }

  team_repositories = merge(
    { for slug, t in local.teams : "${slug}/peaket" => { team = slug, repository = "peaket" } },
    { for repo in ["peaket-bots"] : "platform/${repo}" => { team = "platform", repository = repo } },
  )
}

resource "github_team" "this" {
  for_each = local.teams

  name        = each.key
  description = "${each.value.description}(${each.value.type})"
  privacy     = "closed"
}

resource "github_team_membership" "owner" {
  for_each = local.teams

  team_id  = github_team.this[each.key].id
  username = var.owner_login
  role     = "maintainer"
}

resource "github_team_repository" "this" {
  for_each = local.team_repositories

  team_id    = github_team.this[each.value.team].id
  repository = github_repository.this[each.value.repository].name
  permission = "push"
}
