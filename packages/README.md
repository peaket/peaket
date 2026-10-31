# packages/

여러 앱·서비스가 함께 쓰는 공용 패키지가 들어갈 자리다. 화면용(`ds`, `telemetry`, `validation`, `api-client`, `console-contract`, `seatmap`, `config`), 서버용(`platform`), 계약에서 만든 코드(`contracts`)를 둔다. 게시하지 않고 `workspace:` 프로토콜로만 잇는다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 잇는 규칙: [docs/devops.md](../docs/devops.md) §4.4
- 지금 있는 것: `ds`(디자인 토큰 빌드, 디자인 캔버스 키트 CSS, 공용 부품, 퍼블리싱 도우미)와 `config`(TypeScript 설정, 2026-11-01부터 서비스 안 구조의 층 의존 방향 ESLint 설정 `eslint/service-layers.mjs`도)는 2026-10-31(ADR-0170), `contracts`(계약에서 만든 Zod 스키마·타입, [contracts/README.md](contracts/README.md))는 2026-11-01(wbs 0.2.1 ①)에 더했다. `platform`(서비스 공용 시작 코드: 네 신호 계측, RFC 9457 Problem, 남은 시간 전파, 서비스 OpenAPI 문서 뽑기, 정규 로그 줄·로그 가명, OTel SDK 시작, 외부 호출 클라이언트, 요청 검사·경로 스키마·본문 형식, 인증 가드·종료 세션 목록·역할 가드, Drizzle 설정, 서비스 뼈대 `template/`, [platform/README.md](platform/README.md))은 2026-11-01(wbs 0.3.1 ①·②, 0.3.2 ①)에 더했고 0.3의 나머지 단계에서 채운다. 화면용 나머지는 0.6.4에서 채운다.
