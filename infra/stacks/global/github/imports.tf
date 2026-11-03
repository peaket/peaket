# 소유자가 웹에서 먼저 만든 저장소를 Terraform 관리로 가져온다(2026-11-03 조직 peaket으로 옮긴 peaket, FND-160).
# 가져온 뒤에는 아무것도 하지 않는다(이미 상태에 있으면 건너뛴다). 비공개 peaket-bots는 bots_repository_enabled를 켤 때(wbs 1.2.2) 여기에 더한다.
import {
  to = github_repository.this["peaket"]
  id = "peaket"
}

import {
  to = github_branch_default.this["peaket"]
  id = "peaket"
}
