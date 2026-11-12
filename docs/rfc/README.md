# RFC 초안

- **독자와 용도**: PEAKET의 기술 방향을 개발자·운영자·이해관계자에게 설명하는 RFC(요청 의견서) 초안을 둔다. 구현 전에 큰 그림과 남는 한계를 같은 말로 맞추는 것이 목적이다.
- **규범이 아니다**: 이 폴더의 글은 정본을 풀어 쓴 설명이다. 새 결정이나 새 숫자를 담지 않는다. 글과 정본이 다르면 정본이 맞고, 글을 고친다. 정본은 `docs/architecture.md`, `docs/verification.md`, `docs/features/`, `docs/observability.md`, `docs/streaming.md`, `docs/devops.md`다.
- **상태**: 3건 모두 초안(2026-11-12, BUILD_ORDER BAS-230, wbs 0.8.1)이다. 밖에 게시하거나 이해관계자에게 공식 배포하는 일은 소유자 몫이다.
- **파일 이름**: `NNNN-<주제>.md`. 번호는 초안 순서이고, 정본 문서 번호와 무관하다.

| 번호 | 제목 | 상태 | 정본 | WBS |
| --- | --- | --- | --- | --- |
| 0001 | [온세일 핫패스](0001-onsale-hot-path.md) | 초안(2026-11-12) | docs/architecture.md §9.1·§9.2·§9.5, docs/features/queue-admission.md·seat-hold.md·payment.md, docs/verification.md §3 | 0.8.1 |
| 0002 | [봇 방어](0002-bot-defense.md) | 초안(2026-11-12) | docs/features/bot-defense.md, docs/features/queue-admission.md §2·§3·§7, docs/features/analytics.md §13 | 0.8.1 |
| 0003 | [관제](0003-control-tower.md) | 초안(2026-11-12) | docs/features/control-tower.md, docs/observability.md §3~§9, docs/streaming.md §4 | 0.8.1 |

## 쓰는 규칙

- 숫자는 정본에서만 가져오고, 정본에 없는 값은 `[가정]`·`[추정]`을 붙인다(docs/verification.md §1).
- 결정의 대안과 되돌릴 조건은 ADR을 가리킨다. RFC가 결정을 새로 만들지 않는다.
- 개인정보·비밀 값·운영 주소를 싣지 않는다. 식별자는 가명 참조값만 쓴다.
