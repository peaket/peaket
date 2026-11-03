# ADR-0020: 폼 검증 라이브러리로 React Hook Form과 Zod 채택 (Formik 및 Yup 배제)

- **상태**: 채택 (2026-10-05 설계서 §13 및 7장에 최초 수립, 2026-10-08 아키텍처 결정 레코드(ADR)로 공식 이관). 2026-10-14 ADR-0060이 쿠폰 기능을 두지 않기로 해, 맥락과 근거의 '할인 쿠폰'·'프로모션 쿠폰'은 폼 부하를 설명하는 예시일 뿐 기능이 아니다. 2026-10-26(4차 점검 3부): 결정 3의 공통 패키지 `@ticketpass/contracts`는 `peaket-frontend`의 `packages/validation`(`@peaket/validation`, Zod 4와 판매 정책 DSL AST 평가기)으로 읽는다. GitHub Packages(`@peaket` 범위)에 게시해 NestJS 서비스도 같은 스키마를 쓴다. `peaket-contracts`는 proto·OpenAPI·AsyncAPI·Avro 계약 저장소다(docs/frontend.md §2.2, docs/devops.md §3.2·§4.1, ADR-0079 결정 21). 2026-10-28(기술 검토 중간-085, 소유자 승인 '추천안 동의'): 맥락의 '단일 진실 공급원'은 openapi 계약으로 읽는다. 요청·응답 Zod 스키마는 openapi에서 orval이 만들어 `@peaket/validation`의 `src/gen/`에 두고, 화면과 서버(`nestjs-zod`)가 함께 쓴다. 손으로 쓰는 Zod는 계약에 적을 수 없는 규칙(grapheme 단위 길이, 금칙어, 판매 정책 DSL)만 남기고, 그 이름을 그 필드의 openapi 설명에 적는다. 서비스의 `@nestjs/swagger` 출력은 CI에서 계약과 견주는 데만 쓴다(docs/api/guidelines.md §1, design/d2 §3.1, docs/devops.md §3.1).
- **관련 문서**: 설계서 7장(폼 상태 관리), §13(기술 스택 선정), design/d2 §3.1
- **관련 ID**: FR-005, FR-011, FR-021~024, NFR-012, NFR-020

## 맥락
- 프론트엔드 학습 및 구현 대상 목록에는 React Hook Form(RHF) + Zod 조합과 Formik + Yup 조합이 상호 배타적인 선택지로 제시되어 있다.
- 티켓 예매 시스템의 특성상 주문자 정보 입력, 배송지 등록, 할인 쿠폰 적용 등 결제 직전 단계의 폼 입력 과정에서 발생하는 렌더링 지연은 사용자 이탈과 최종 전환율 저하에 직접적인 악영향을 미친다.
- 또한 입력 폼의 유효성 검증 규칙은 브라우저(프론트엔드)뿐만 아니라 백엔드 API 계층(`nestjs-zod`)에서도 단일 진실 공급원(Single Source of Truth)을 통해 일관되게 공유 및 재사용될 수 있어야 한다.

## 결정
1. 프론트엔드 폼 상태 관리 및 스키마 검증 라이브러리로 `React Hook Form`과 `Zod`, 그리고 `@hookform/resolvers` 어댑터를 공식 채택한다.
2. React Hook Form의 비제어 컴포넌트(Uncontrolled Component) 기반 상태 참조 방식을 활용하여, 사용자가 글자를 타이핑할 때마다 전체 폼 컴포넌트가 불필요하게 리렌더링되는 비용을 근본적으로 차단한다.
3. 데이터 검증 스키마는 `Zod`로 정의하여 monorepo 내 공통 패키지(`@ticketpass/contracts`)에 배치하며, 백엔드 NestJS 서비스의 DTO 검증 파이프라인과 프론트엔드 클라이언트가 동일한 스키마를 상호 공유하도록 구성한다.
4. 재사용 가능한 복합 유효성 검증 규칙은 `ValidatorBuilder` 패턴을 통해 선언적으로 조립하여 런타임 Zod 스키마를 동적으로 생성한다.

## 검토한 대안
| 대안 | 기각 사유 및 한계점 |
| --- | --- |
| Formik + Yup | 제어 컴포넌트(Controlled Component) 구조로 인해 키 입력마다 최상위 폼이 재평가되어 불필요한 리렌더링 오버헤드가 발생하며, TypeScript와의 정적 타입 추론 결합도가 Zod에 비해 현저히 떨어져 백엔드와의 스키마 공유에 불리하다. |

## 결과와 트레이드오프
- 비동기 유효성 검증(예: 아이디/이메일 중복 확인, 프로모션 쿠폰 유효성 검사 등 `refine` 비동기 로직)을 별도의 분리된 상태 관리자 없이 React Hook Form의 폼 라이프사이클 내부에서 자연스럽게 통합 처리할 수 있다.
- 비제어 입력 방식을 기본으로 채택함에 따라, 외부 서드파티 제어형 UI 컴포넌트(예: 커스텀 셀렉트 박스, 캘린더 피커 등)를 결합할 때는 `Controller` 래퍼 컴포넌트를 명시적으로 사용해야 하는 구현상의 번거로움이 수반된다.
