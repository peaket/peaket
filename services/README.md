# services/

서버에서 도는 배포 단위가 모두 들어갈 자리다. 서비스 10개, 스트림 작업자, 작업(CronJob·Job) 이미지를 `services/<이름>`에 하나씩 둔다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 서비스를 나눈 근거: 같은 문서 §3
- 처음 채우는 작업: wbs 0.3(서비스 템플릿)과 Phase 1(v0). 지금은 비어 있다.
