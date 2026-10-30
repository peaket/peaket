# packages/

여러 앱·서비스가 함께 쓰는 공용 패키지가 들어갈 자리다. 화면용(`ds`, `telemetry`, `validation`, `api-client`, `console-contract`, `seatmap`, `config`), 서버용(`platform`), 계약에서 만든 코드(`contracts`)를 둔다. 게시하지 않고 `workspace:` 프로토콜로만 잇는다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 잇는 규칙: [docs/devops.md](../docs/devops.md) §4.4
- 지금 있는 것(2026-10-31, ADR-0170): `ds`(디자인 토큰 빌드, 디자인 캔버스 키트 CSS, 공용 부품, 퍼블리싱 도우미)와 `config`(TypeScript 설정). 나머지는 wbs 0.2.1(`contracts`), 0.3(`platform`), 0.6.4(화면용)에서 채운다.
