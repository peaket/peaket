terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.13" # 규칙 세트의 allowed_merge_methods가 6.10.0부터 있다(docs/devops.md §2.2.6)
    }
  }
}
