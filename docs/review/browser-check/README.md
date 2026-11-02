# 브라우저 확인 결과

- **독자와 용도**: 화면이 바뀐 단계를 AI가 Claude in Chrome으로 눌러 본 결과를 찾아볼 때 본다. 관문이 아니라 참고 증거다.
- **규칙**: 절차는 [docs/architecture.md](../../architecture.md) §8.6의 6단계와 `.claude/skills/peaket-browser-check/SKILL.md`, 결정은 ADR-0178이다(조건은 ADR-0167 결정 5).
- **파일**: 단계마다 `<단계 ID>.md` 하나(예: `BAS-170.md`). 화면이 없는 단계는 파일을 만들지 않는다.
- **이전 기록**: 2026-11-02까지의 결과는 OpenSpec 변경 폴더의 `browser-check.md`였고, git 태그 `archive-openspec`에 남아 있다.
