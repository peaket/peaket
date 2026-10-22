# ADR-0018: Enzyme은 채택하지 않는다

- **상태**: 채택 (2026-10-05 설계서 §13·8장에 기록, 2026-10-08 ADR로 옮김)
- **관련**: 설계서 §13 의도적 기각, 8장 테스트, docs/appendix-learning-map.md
- **관련 ID**: NFR-023(변경 실패율), 테스트 전략

## 맥락
- 프론트엔드 테스트 자동화 전략 수립 시 과거 널리 쓰였던 Enzyme이 후보로 검토되었으나, 공식 React 어댑터는 React 16까지만 유지보수되었으며 React 18용 어댑터는 커뮤니티 제작자조차 '실험적이고 비공식적인 임시방편'이라고 밝힌 상태이다([cfaester/enzyme-adapter-react-18](https://github.com/cfaester/enzyme-adapter-react-18)).
- PEAKET 프론트엔드 플랫폼은 React 19 최신 런타임을 전면 채택하고 있으므로 Enzyme을 테스트 기반으로 채택하는 것은 불가능하다.

## 결정
- Enzyme을 전면 배제(기각)하고 최신 표준 테스트 도구 체인을 도입한다.
- 사용자 관점의 컴포넌트 통합 테스트는 React Testing Library(RTL) + jest-dom을 활용하고, 단위 테스트는 Vitest를, 브라우저 E2E 테스트는 Playwright를, jsdom 환경에 부재한 실제 브라우저 Web API 검증에는 `@web/test-runner` + mocha + chai + sinon을 채택한다.

## 검토한 대안
| 대안 | 문제 |
| --- | --- |
| 비공식 React 18 어댑터 사용 | React 19 프로젝트의 공식 테스트 기반이 될 수 없으며 React Server Components(RSC) 환경 미지원 |

## 결과와 트레이드오프
- 컴포넌트의 내부 구현 세부사항(State, Props)에 결합되지 않고 사용자 인터랙션과 접근성 트리 중심의 견고한 테스트 스위트를 구축한다.
- 트레이드오프: 얕은 렌더링(Shallow Rendering) 기반의 내부 인스턴스 단언이 불가하므로, 사용자 관점의 쿼리(`getByRole`, `findByText`) 중심 테스트 작성 패러다임이 요구된다.
