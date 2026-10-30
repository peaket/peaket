# 저장소 4개(docs/devops.md §2.1, ADR-0165)와 기본 가지(§2.3).
# peaket은 지금 있는 이력을 밀어 넣으므로 빈 저장소로 만든다(auto_init = false).

locals {
  repositories = {
    "peaket" = {
      description    = "PEAKET(피켓) 모노레포: 문서, 계약, 화면 앱, 서버, 공용 패키지, 데이터 모델, 인프라 코드"
      visibility     = "public"
      auto_init      = false
      default_branch = "develop"
    }
    "peaket-gitops" = {
      description    = "PEAKET 클러스터 상태(환경 오버레이, 공용 Helm 차트, Kyverno 정책)"
      visibility     = "public"
      auto_init      = true
      default_branch = "main"
    }
    ".github" = {
      description    = "PEAKET 조직 공용 재사용 워크플로와 조직 첫 화면 소개"
      visibility     = "public"
      auto_init      = true
      default_branch = "develop"
    }
    "peaket-loadtest" = {
      description    = "PEAKET 부하 시험과 합성 봇 시뮬레이터(비공개, POL-026)"
      visibility     = "private"
      auto_init      = true
      default_branch = "develop"
    }
  }

  # 처음 커밋(main)에서 develop을 만들어야 하는 저장소
  develop_from_main = { for name, r in local.repositories : name => r if r.auto_init && r.default_branch == "develop" }
}

resource "github_repository" "this" {
  for_each = local.repositories

  name        = each.key
  description = each.value.description
  visibility  = each.value.visibility
  auto_init   = each.value.auto_init

  has_issues      = true
  has_wiki        = false
  has_projects    = false
  has_discussions = false

  # 작업 가지는 스쿼시, 릴리스·핫픽스·역병합은 병합 커밋(docs/devops.md §2.2.1). 스쿼시 커밋 메시지는 PR 제목이다(§2.2.5)
  allow_merge_commit          = true
  allow_squash_merge          = true
  allow_rebase_merge          = false
  squash_merge_commit_title   = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"
  delete_branch_on_merge      = true

  # 실수로 destroy해도 지우지 않고 보관 처리한다
  archive_on_destroy = true
}

resource "github_branch" "develop" {
  for_each = local.develop_from_main

  repository    = github_repository.this[each.key].name
  branch        = "develop"
  source_branch = "main"
}

# peaket의 develop은 밀어 넣은 뒤에 있으므로, 적용 순서는 README의 순서를 따른다
resource "github_branch_default" "this" {
  for_each = local.repositories

  repository = github_repository.this[each.key].name
  branch     = each.value.default_branch

  depends_on = [github_branch.develop]
}
