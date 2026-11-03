# infra/

인프라 코드(Terraform)가 들어갈 자리다. 재사용 모듈은 `modules/`, 상태 하나에 구성 요소 하나인 스택은 `stacks/`에 둔다.

- 폴더 구조·상태·판 고정 규칙: [docs/devops.md](../docs/devops.md) §9.1, 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10
- 지금 있는 것: GitHub 조직 설정 스택(`stacks/global/github`, wbs 0.1.1). AWS 스택은 wbs 0.4.2에서 채운다.
