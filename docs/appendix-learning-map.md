# 부록: 학습 항목 매핑(1~33장), 의도적 기각 항목, 면접 답변 문장

- **독자와 용도**: 프로젝트 엔지니어가 컴퓨터 공학 및 웹 풀스택 학습 로드맵(1~33장)의 세부 기술 요소가 시스템 내 어느 지점에 어떠한 공학적 당위성으로 채택되었는지 추적하고, 특정 기술을 의도적으로 배제하거나 대체한 합리적 배경과 기술 면접 대응 논리를 검토할 때 참조하는 색인 문서이다. 개별 설계 결정의 원천 문서는 docs/architecture.md 및 docs/adr/ 디렉터리에 위치하며, 본 부록은 학습 커리큘럼 항목을 기준으로 한 역색인 매핑을 제공한다.
- **원문 출처**: 설계서 §11(1~14장 프론트엔드), §12(15~33장 백엔드·인프라), §13(의도적 기각 및 대체 10대 항목), §9 '면접 답변 문장'. 본문은 원문 매핑 체계를 충실히 반영하여 섹션 구조를 유지하였으며, 도입부와 말미의 'ADR 대응' 요약 표는 [보완]으로 구성하였다.
- **기준 기획 버전**: v1.0.
- **문서 처리 방침**: 최종 산출물 표준 문서 체계 외 항목이나, 학습과 기술 결정 간의 정밀한 추적성을 보존하기 위해 원형을 유지한다(00-diagnosis §2.1). 삭제 대상이 아니며 영구 보존한다.

## 11. 챕터별 매핑 — 프론트엔드 (1~14장)

학습 목록의 모든 세부 항목을 시스템 내 '적용 위치'와 '채택 이유(공학적 당위성)'로 체계화하여 매핑하였다. 항목 명칭은 원본 학습 목록의 표현을 충실히 준수하여 상호 대조가 용이하도록 구성하였다.

본 매핑 표는 특정 기술이 시스템 내 어느 컴포넌트나 사용자 인터페이스에 적용되었는지 명시하고, 단순 유행이 아닌 대안 기술 대비 해당 기술을 선정해야만 했던 필연적 근거를 설명한다. 관심 도메인에 따라 개별 장을 선별 검토할 수 있다.

### 1장. 런타임 구조

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 콜 스택, 스택 오버플로 | 파트너 판매정책 DSL 인터프리터 | 깊게 중첩된 규칙이 `RangeError`로 서버를 죽이는 DoS 벡터가 됨 → 파서 깊이 제한 + 트램펄린 평가기로 해결하고 회귀 테스트로 증명 |
| 경쟁 조건 | 좌석 더블클릭·응답 역전, 다중 탭 동시 홀드, Node `await` 사이 check-then-act, Worker 간 공유 비트맵 | 요청 시퀀스 번호 + AbortController, Web Locks API, Redis Lua 원자 연산, SharedArrayBuffer + `Atomics` |
| 데드락, 데드락 4조건 | v0의 다중 좌석 `FOR UPDATE`, 다중 탭 Web Locks | 상호배제·점유대기·비선점·순환대기 중 순환 대기를 정렬 잠금으로 깨고, `lock_timeout`으로 무한 대기를 끊음(K3) |
| 실행 컨텍스트, VO, 스코프 체인, 렉시컬 스코프, 함수 중첩, 정적 vs 동적 스코프 | DSL 인터프리터의 Environment 체인 직접 구현 | 변수 해석을 렉시컬 스코프로 구현하고, 동적 스코프였다면 결과가 달라지는 테스트로 차이를 문서화. 개념을 코드로 증명하는 자리 |
| this 5가지 바인딩, 화살표 함수의 렉시컬 this | 프레임워크 독립 텔레메트리 SDK(`@peaket/telemetry`, class 기반) | 메서드를 콜백으로 넘길 때 this가 유실되는 버그를 재현하고 `bind`·클래스 필드 화살표 함수로 해결. 단독 호출·메서드·call/apply/bind·new·화살표 규칙을 리뷰 가이드로 정리 |
| 클로저(생성 상황 5가지, 정적 스코프, 메모리 관리) | `createQueueClient()` 팩토리의 비공개 상태, IIFE 설정 모듈, WS 이벤트 핸들러, 폴링 콜백 | 언마운트 후에도 WS 핸들러 클로저가 5만석 배열을 붙잡는 누수를 memlab으로 재현하고 cleanup + WeakMap으로 해결. React stale closure(대기열 interval) 사례 포함 |
| Map(용법·반복·초기화, 함수 결과 캐싱, 사이즈 추적, 동적 폼 필드, 순서 보장) | single-flight 요청 dedupe `Map<key, Promise>`, O(1) LRU, 선택 좌석 순서, 파트너 동적 폼 필드, @hello-pangea/dnd 가격 등급 정렬 | 순서 보장과 잦은 추가·삭제가 필요한 곳. JSON 직렬화 불가라는 한계는 전용 직렬화기로, 고정 대량 키는 TypedArray로 대체 |
| Map이 추가·삭제에 빠른 이유, Hidden Class, Dictionary Mode | 좌석 상태 캐시 마이크로 벤치마크 | Object에 키를 반복 추가·삭제하면 Dictionary Mode로 바뀌는 것을 `node --allow-natives-syntax`의 `%HasFastProperties`로 보여 주고 tinybench로 ops/sec 비교 |
| WeakMap(힙 누수 해결, 캐시 누수 방지, DOM-메타데이터 연결) | 접근성 좌석 리스트 DOM ↔ 좌석 모델, 스냅샷 객체 키 파생 캐시, 게이트웨이 소켓 ↔ 연결 메타데이터 | 키 객체가 사라지면 값도 GC되므로 스냅샷 교체·연결 종료 때 누수가 없음 |
| WeakMap 한계(키만 약한 참조, 순회 불가), 대안 WeakRef + FinalizationRegistry | 연결 수 집계, 대용량 좌석 지오메트리 디코딩 캐시 | 순회 불가라 연결 수는 별도 카운터로. 재계산 가능한 대용량 캐시는 WeakRef로 GC가 회수하게 두고 FinalizationRegistry로 리소스 정리(비결정성 문서화) |
| Set(배열과 차이, 중복 제거, 태그 입력, 장바구니, 좋아요 캐싱, 집합 연산, 참조형 주의) | 선택 좌석 집합, 관심 공연(찜) 캐시, 파트너 장르 태그 입력, 티켓 장바구니, 홀드 델타 계산 | `has` O(1), 배열로 직렬화해 localStorage 저장. 이전·현재 홀드의 차집합으로 델타 계산. 좌석 객체를 넣어 `has`가 false가 되는 버그를 재현해 원시 ID만 넣는 규칙 확정 |
| WeakSet(정의·특징, Set과의 차이, 불변성 강제, 순환 참조 감지, 사용 시나리오) | 텔레메트리 SDK 계측 대상 표시, 에러 리포트 안전 직렬화기, 관제 커맨드 페이로드 봉인 | Set과 달리 객체만 담고 약하게 참조하며 순회가 안 되므로 '이미 본 객체 표시' 용도에 맞음. 이중 래핑 방지, 순환 참조가 있는 상태도 Sentry 브레드크럼으로 안전하게 직렬화 |
| 힙과 스택, 힙 누수 주요 원인 | 좌석맵 페이지, realtime-gw | 분리된 DOM·타이머·리스너·전역 캐시 점검(memlab CI). realtime-gw의 힙 스냅샷 비교, 컨테이너 메모리 한도와 `--max-old-space-size` 정렬 |
| 이벤트 루프(콜스택 → 마이크로태스크 → 렌더링 → 매크로태스크) | 좌석 델타 적용, 대기 카운트다운 | 메시지마다 렌더하면 프레임 드랍 → rAF 단위 배치. 긴 Promise 체인이 렌더링을 굶기는 현상을 재현하고 `scheduler.yield()`로 해결(INP 측정). 카운트다운은 rAF + `performance.now()`로 드리프트 보정 |
| Promise.race / allSettled / any / withResolvers | 홀드 요청, 공연 상세, 좌석맵 지오메트리, WS 요청-응답, 토큰 갱신 | race: 3초 타임아웃. allSettled: 독립 섹션 부분 실패 허용. any: 멀티 CDN 중 가장 빠른 응답. withResolvers: 상관관계 ID별 resolver Map, 401 동시 발생 시 토큰 갱신 single-flight |
| p-limit(순차 실행, 싱글턴·팩토리) | 스캐너 동기화 업로드, 파트너 이미지 일괄 업로드 | `getLimiter('upload')` 팩토리가 자원 종류별 싱글턴 리미터를 돌려줘 동시성 상한을 앱 전체가 공유 |
| AbortController | 섹션 전환, 머리 검색창 연관 검색어(ADR-0063), 닉네임 중복 확인, 대기 상태 폴링 취소 | `AbortSignal.any([사용자 취소, AbortSignal.timeout()])`로 취소와 타임아웃 결합 |
| Fetch, LocalStorage, SessionStorage | 텔레메트리 전송(`keepalive`), 사용자 설정·최근 검색, 탭별 예매 진행 상태, 대기 화면 진행 막대의 처음 앞 인원(ADR-0063) | `useLocalStorage`: SSR 가드 `typeof window`, 직렬화, `QuotaExceededError` 시 LRU 정리. `useSessionStorage`: 폼 임시 저장, 진행 상태, 멀티탭 격리, 페이지 전환 데이터, 임시 대용량 선택 요약 |
| Intersection Observer, Web Workers, Canvas, WebSocket | 무한 스크롤·이미지 지연 로드·노출 측정, 좌석맵 연산, 좌석맵·QR 렌더, 좌석 델타 | 각 API가 대체 불가능한 자리에 배치 |
| Geolocation, Clipboard, navigator.share | 주변 공연장·공연 당일 게이트 안내, 예매번호·양도 링크 복사, 공연·양도 링크 네이티브 공유 | 모바일 친화 기능, 미지원 브라우저는 폴백 |
| navigator.getBattery, navigator.mediaDevices | 대기실 저전력 모드, 게이트 스캐너 카메라 | 배터리 15% 이하면 대기실 애니메이션을 끄고, 예상 대기가 길 때는 폴링 간격을 상한까지 늘림(대기가 30분 이상일 수 있음). 스캐너는 카메라 프레임을 Worker로 넘겨 디코딩 |
| Proxy 객체와 Reflect(트랩 메서드) | 텔레메트리 자동 계측(`fetch`·`WebSocket` 생성자), 피처 플래그 노출 로깅(`get` 트랩), dev 불변 가드(`set` 트랩) | `Reflect.apply`/`construct`로 원래 동작 보존. 좌석 렌더 루프 같은 핫패스엔 쓰지 않고 오버헤드를 벤치마크로 수치화 |

### 2장. 프로그래밍 패러다임

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 싱글턴(클로저+IIFE, private 생성자 클래스, 유틸리티, DB 커넥션 풀)과 올바른 사용 원칙 | 텔레메트리 SDK 인스턴스, Nest 기본 스코프 provider(DB 풀·Redis·Kafka 프로듀서) | 로깅·연결처럼 진짜 하나여야 하는 곳만. 나머지는 Nest DI로 주입해 테스트 대역 교체 가능하게 하고 ADR로 명문화 |
| 팩토리 메서드 | `TransportFactory.create()`(WebSocket/폴링), `NotificationChannelFactory`(이메일/Web Push/웹훅) | 브라우저 능력과 채널에 따른 생성 결정을 한곳에 모음 |
| 추상 팩토리(데이터 파서) | 좌석맵 import(SVG/JSON/CSV마다 Parser + Validator + Normalizer 묶음), PG 패밀리(토스페이먼츠와 PG 시뮬레이터마다 승인·조회·취소 클라이언트 + 웹훅 처리기 묶음) | 서로 맞물리는 객체군을 통째로 교체 |
| 빌더(Form Validator) | `ValidatorBuilder().required().maxGraphemes(20).noEmoji().forbidden(list).build()` → Zod 스키마 | 회원가입·파트너 폼 검증 규칙을 FE/BE 공용으로 조립 |
| 프로토타입 | 공연장 배치 템플릿 레지스트리(`structuredClone` 후 회차별 수정), 관제 위젯 설정 복제 | 무거운 기본 배치를 매번 새로 만들지 않음 |
| 데코레이터 | Nest 커스텀 데코레이터 `@Idempotent` `@RequireAdmission` `@Audit` `@Traced`, API 클라이언트의 retry·cache·log 적층 | 횡단 관심사를 비즈니스 코드 밖으로 |
| OCP, OCP 준수 사례 | 결제수단·알림 채널·봇 탐지 시그널·관제 위젯 레지스트리 | 새 구현은 등록만 하고 기존 코드 수정 0줄을 PR diff로 증명 |
| 컴포지트(메뉴 UI) | Venue → Level → Section → Row → Seat 트리, 파트너 좌석맵 에디터 트리 메뉴, 관제 패널 레이아웃 | 일관된 인터페이스(용량·잔여석·렌더), 재귀 구조, 확장성 |
| 플라이웨이트(텍스트 포맷터, 테마 + Context API) | 5만석 렌더(공유: 도형 Path2D·등급 색 / 외재: 좌표·상태 TypedArray), 로케일별 `Intl` 포맷터 캐시, 테마 토큰 | 힙 사용량을 K5에서 수치로 비교 |
| 브릿지(컴포넌트-데이터 계층, 훅-서비스 계층) | SeatMapView(Canvas/SVG/접근성 리스트) × 데이터 소스(실시간 WS/정적 스냅샷/MSW), `useQueue` × 갱신 전략(적응형 폴링/고정 주기/MSW) | 두 축이 서로 독립적으로 늘어남 |
| 퍼사드(커스텀 훅, Next.js 인증, Axios+캐싱+에러 처리) | `useBooking()`(XState·Query·WS 은닉), `getSessionWithFreshToken()`, 통합 API 클라이언트 | 화면 코드가 내부 복잡도를 모르게 |
| 프록시 패턴(Lazy, 접근 보호, 로깅·이벤트 모니터링 HOC, 개발용 API 프록시, 상태관리 프록시)과 주의사항 | React.lazy 좌석맵, 입장 토큰 보호 HOC, 로깅·이벤트 모니터링 HOC, Next rewrites·MSW, dev 불변 가드 | Proxy 성능 영향, 오버엔지니어링, React.memo·useMemo와의 차이를 팀 가이드로 문서화 |
| 의존성 주입 | Nest IoC(토큰으로 PG·시계·난수 주입), FE Context 서비스 컨테이너 | 고정 시계·고정 난수로 홀드 만료와 로비 셔플을 결정적으로 테스트 |
| 어댑터(결제 시스템 통합, API 버전 어댑터)와 주의사항 | 토스페이먼츠 API와 부하 테스트용 PG 시뮬레이터를 `PaymentGatewayPort`로 통합, API v1→v2 응답 변경 흡수 | 헥사고날 어댑터 그 자체. 어댑터 중첩 금지를 리뷰 체크리스트로 |
| 책임 연쇄(이벤트 핸들러, 변환 파이프라인, 폼 검증 체인, 조건부 실행, 점진적 기능 감지) | 로비·사전 검증 파이프라인(trust-svc: Turnstile 결과 → DeviceTrust → BehaviorScore → 추가 검증 큐 분기. T=0 진입 경로 자체는 서명·권한 확인만, ADR-0006), 렌더러 감지(OffscreenCanvas → Worker Canvas → 메인 Canvas → SVG), 좌석맵 import 변환, 폼 검증 | 단계를 추가·교체해도 나머지가 바뀌지 않음 |
| 전략(결제수단 처리) | 결제수단, 큐 정렬(FIFO·프리큐 셔플·하이브리드, 섹션 7), 동시 입장 목표 조절(고정/AIMD/수동), 좌석 추천(최저가/최적 시야/연석), 상품 유형별 환불·수령 정책 | 런타임에 자주 바뀌는 정책 |
| 템플릿 메서드 | `AbstractPaymentFlow`(금액 검증 → 승인 → 기록 → 실패 시 취소), Saga 스텝 골격(execute/compensate), 정산 리포트 내보내기(CSV/XLSX/PDF) | 순서는 고정, 단계 구현만 다름 |
| 커맨드(Undo 편집기, 버튼 액션, 작업 큐) | 관제 운영 명령(execute/undo/validate + 큐 + 감사), 좌석맵 에디터 Undo/Redo, Redux 미들웨어 작업 큐 | 실행 취소·감사·재생이 필요한 행동 |
| 인터프리터(동적 검증, 동적 API 요청, 조건부 fetch, 동적 헤더, 조건 검증) | 판매정책 DSL(JSON AST): "팬클럽 선예매 기간엔 1인 2매", 조건부 필드 노출, 조건부 fetch·헤더 | 같은 AST를 FE(UX)와 BE(강제)가 공유 |
| 역할 변경 패턴(동적 연동, 상태 기반 전환, 조건부 렌더링 대체)과 주의사항 | `Seat` 컴포넌트가 구매자 선택·에디터 편집·관제 히트맵·스크린리더 항목 역할 객체를 교체, 관제 운영자 역할(viewer/operator/commander) 런타임 전환 | 조건문 폭발 제거. 전환 시 상태 초기화 규칙을 명시하고 단순 분기에는 쓰지 않음 |
| 중재자(폼 관리)와 주의사항 | 결제 폼(쿠폰 ↔ 결제수단 ↔ 약관 ↔ 제출 버튼), 관제 대시보드(기간·필터·위젯 동기화) | prop drilling 제거와 결합도 감소. 중재자 책임 한계를 문서화해 God object 방지 |
| 옵저버 | 좌석 섹션 구독, RxJS, Node EventEmitter, Zustand subscribe | 이벤트 기반 시스템의 기본 단위 |
| 메멘토(Undo/Redo, 상태 트리 저장) | 에디터 Undo/Redo(immer patches 구조적 공유), 관제 설정 스냅샷 롤백, 예매 폼 드래프트 복구 | 복잡한 상태 트리를 싸게 저장 |
| 상태 패턴 | 예매 플로우, WS 연결(연결 중/열림/재연결/닫힘), 서킷 브레이커(closed/open/half-open) | 상태별 행동을 객체로 분리 |
| 방문자 패턴 | 공연장 트리에 CapacityVisitor·RevenueEstimateVisitor·A11yAuditVisitor(휠체어석 검증)·SvgExportVisitor, DSL AST에 TypeChecker·Evaluator | 컴포지트 트리에 연산을 더해도 노드 클래스는 그대로 |
| 반복자 패턴 | 트리 DFS 제너레이터, 커서 페이지네이션 async iterator(`for await`), Kafka 컨슈머 async iterator | 순회 방식을 자료구조에서 분리 |
| 람다, 클로저, 불변 컬렉션(Object.freeze, immer), 고차함수, 재귀, 체이닝, 커링, 모나드 | 가격 계산(수수료·쿠폰·세금) 순수 함수, `withRetry(withTimeout(fn))` 합성, 커링 로거 `logEvent('booking')('seat_click')(payload)`, 트리 재귀 + 트램펄린 | 핵심 계산을 테스트하기 쉬운 순수 함수로 |
| 리액트와 FP(순수 컴포넌트, 커링 로깅 HOC, HOC 에러 처리, Suspense, Error Boundary, react-query + Suspense) | 좌석 범례 순수 컴포넌트, `withLogging(category)(action)(Component)`, 위젯 단위 Error Boundary + `useSuspenseQuery` + QueryErrorResetBoundary | 위젯 하나가 실패해도 대시보드 전체가 비지 않음. 워터폴은 라우트 프리페치와 `useSuspenseQueries`로 방지 |
| 제너레이터(지연 평가, 메모이제이션, 무한 스트림, 파이프라인, Worker 연동, 트램펄린, 백프레셔, 시간 분할) | 연석 탐색(N석을 찾으면 즉시 중단), 개발용 무한 대기열 이벤트 스트림, map/filter/take 지연 파이프라인, Worker 청크 처리, async generator로 WS 버퍼를 소비 속도에 맞춰 pull, N개마다 yield 후 `scheduler.yield()` | 5만석을 한 번에 펼치지 않고 필요한 만큼만 계산 |
| FP 에러 처리, 모나딕 체이닝 | 예약 흐름 `validate → hold → createOrder → pay`를 Result 타입으로 연결 | 에러를 값으로 다뤄 BE는 RFC 9457 Problem Details, FE는 사용자 메시지로 매핑 |

### 3장. 컴포넌트 디자인 패턴

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| Atomic Design | 디자인 시스템 `@peaket/ds`: atoms(Button, SeatStatusBadge), molecules(PriceTierLegend, Countdown), organisms(SeatPicker, QueuePanel, CheckoutForm), templates | 4개 앱이 같은 부품을 공유 |
| FSD(Feature-Sliced Design) | 앱 구조: app / pages / widgets(seat-map, queue-status) / features(join-queue, hold-seats, apply-coupon) / entities(event, seat, order, ticket) / shared | Atomic은 `shared/ui` 내부 규칙, FSD는 앱 전체 의존 방향 규칙으로 역할을 나누고 Steiger·eslint-plugin-boundaries로 강제 |
| Presentational & Container | SeatMapContainer(구독·데이터) vs SeatMapCanvas(순수 렌더) | 렌더 테스트와 데이터 테스트 분리 |
| Custom Hooks | useQueueStatus, useHoldTimer, useSeatSelection, useNetworkStatus, useBattery, useReducedMotion, useBroadcastChannel | 브라우저 API와 도메인 로직 재사용 |
| Compound Components | `<SeatPicker>` + `.Legend` `.Map` `.Summary`, 관제 `<Widget>` + `.Header` `.Body` `.Actions` | 조합 자유도와 암묵적 상태 공유 |
| Render Props | `<QueuePosition>{({ position, eta }) => …}</QueuePosition>` | 대기실·알림 배너·파트너 미리보기가 같은 계산을 다르게 시각화 |
| Higher-Order Components | withAdmissionGuard, withErrorBoundary, withTracking(커링) | 라우트 보호·관측 같은 횡단 관심사 |
| Memoization | React.memo·useMemo·useCallback vs React Compiler 자동 메모이제이션 | React Profiler로 렌더 횟수를 비교해, 수동 메모이제이션이 남아야 할 곳을 근거로 결정 |
| Virtualization | 5만 행 접근성 좌석 리스트, 관제 이벤트 로그, 파트너 예매자 목록(TanStack Virtual) | DOM 노드 수를 화면 크기에 비례하게 |
| Props Collections & Getters | `getSeatProps(seat)`가 role·aria·onKeyDown·onClick을 한 번에 제공 | 접근성 속성 누락을 구조적으로 방지 |
| Slot | DS 컴포넌트 `asChild`·슬롯, Next.js Parallel Routes `@modal` 슬롯(좌석 상세 모달) | 레이아웃 소유권은 부모, 내용은 자식 |
| State Reducer | `useSeatSelection({ stateReducer })`로 정책 주입(팬클럽 선예매 '연석만 허용') | 제어의 역전으로 훅 수정 없이 규칙 변경 |
| Lifted State | 선택 좌석을 SeatPicker 루트로 올려 Map·Summary·결제 바가 공유 | 단일 진실 공급원 |

### 4장. 상태관리: 상태 소유권 매트릭스

챕터 지시대로 취사선택하되, '앱 × 상태 종류'마다 도구 하나만 소유하게 해 중복이 아닌 역할 분담임을 보여 줍니다.

| 상태 종류 | 앱 | 도구 | 선택 이유 | 탈락 후보와 이유 |
| --- | --- | --- | --- | --- |
| 서버 상태 캐시 | 소비자 웹 | TanStack Query | 중복 제거, 재시도, `offlineFirst`, Suspense | SWR(기능 부족), Redux(보일러플레이트) |
| 대기실 상태 | 대기실 페이지 | SWR | 100만 명이 머무는 페이지라 번들 최소화, `refreshInterval`을 예상 대기 시간에 맞춰 바꾸는 적응형 폴링 | TanStack Query(이 페이지엔 기능 과잉) |
| 전역 UI 상태 | 소비자 웹 | Zustand | 작은 번들, selector로 리렌더 최소화, React 밖 구독 | Context(잦은 갱신 시 전체 리렌더) |
| 세밀한 대량 편집 상태 | 파트너 좌석맵 에디터 | Jotai(atomFamily) | 수천 노드 중 하나를 고치면 그 노드만 리렌더 | Zustand(전역 selector 비용) |
| 흐름 상태 | 예매 플로우, WS 연결, 스캐너 동기화 | XState | 불가능한 상태 제거, 시각화, 모델 기반 테스트 | boolean 플래그 조합 |
| 스트림·운영 상태 | 관제 콘솔 | Redux Toolkit + redux-observable + RxJS | 액션 로그가 곧 감사·리플레이, RxJS로 스트림 결합·배치·취소, RTK `combineSlices`·`inject`로 MF 리모트 리듀서 지연 주입 | Zustand(액션 로그·미들웨어 생태계 약함) |
| 유연한 조회 + 구독 | 관제 콘솔 ↔ ops-svc | GraphQL(urql + graphql-ws) | 위젯마다 다른 집계 모양, subscription, urql exchange 체인 | REST(오버·언더페칭) |
| 내부 툴 E2E 타입 안정성 | 파트너 콘솔 ↔ BFF | tRPC | TS 타입 공유, 빠른 CRUD 개발, 외부 계약 불필요 | GraphQL(스키마 운영 비용) |
| DI·환경 | 전 앱 | Context API | 서비스 컨테이너·테마·i18n·피처 플래그처럼 드물게 바뀌는 값만 | 고빈도 상태엔 사용 금지 |

### 5장. React.js & Next.js 생태계

| 라우트 | 렌더링 전략 | 이유 |
| --- | --- | --- |
| `/`, `/events/[id]` | ISR(Next.js 16에서는 Cache Components의 `use cache` + `cacheLife`·`cacheTag`로 표현) | 오픈 직전 100만 명이 보는 페이지를 CDN이 처리. 파트너가 수정하면 태그로 즉시 무효화 |
| `/search` | SSR + 클라이언트 필터 | 검색어별 SEO 랜딩. 결과는 페이지 번호(`?q=&page=`), 연관 검색어는 ARIA combobox(ADR-0063) |
| `/queue/[eventId]` | 정적 셸 + CSR | origin SSR을 절대 거치지 않게 해 버스트를 CDN이 흡수(K1) |
| `/booking/[eventId]/seats` | CSR(입장 토큰 게이트) | 인터랙션 집약, SEO 불필요 |
| `/my/tickets` | CSR + PWA 오프라인 | 공연장 현장의 불안정한 네트워크 |
| 파트너·관제 | CSR | 내부 도구, SEO 불필요 |

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| React 깊은 이해 | useTransition(섹션 필터), useDeferredValue(검색), React 19 Actions·useOptimistic, RSC/Client 경계(상호작용 섬만 클라이언트), 스트리밍 SSR, 하이드레이션 비용 측정 | 렌더링 비용을 구간별로 설명할 수 있어야 리드 |
| NestJS 깊은 이해 | 16장 매핑 참조 | — |
| Fetching 전략(axios, TanStack Query, SWR) | axios: BFF·SDK 인터셉터(토큰 갱신 single-flight, Idempotency-Key 주입, 구매 세션 요청 서명, 에러 정규화). TanStack Query: 앱 서버 상태. SWR: 대기실. RSC: fetch + 캐시 태그 | 화면 성격별로 도구를 나눈 근거를 4장 매트릭스와 일치시킴 |
| Next.js SEO | Metadata API, `next/og` 동적 OG 이미지, schema.org `Event` JSON-LD(가격·판매 상태·장소), sitemap·robots, canonical, hreflang(4개 언어) | 공연 검색 유입 확보, Search Console로 효과 측정 |

### 6장. 스타일링

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| UI 디자인 시스템(디자인 토큰, 컴포넌트 라이브러리, 문서화 & 가이드라인) | `@peaket/ds`: Style Dictionary 토큰 단일 소스 → CSS 변수 + Tailwind `@theme` + TS 상수, Radix 프리미티브 + cva 변형, Storybook Docs(MDX, Do/Don't, 접근성 노트), Changesets 버전 관리 | Canvas 좌석맵은 CSS 변수를 못 쓰므로 TS 토큰이 필요. 좌석 상태 토큰은 색각이상 안전 팔레트 + 패턴 병행(색만으로 정보 전달 금지) |
| Tailwind | Tailwind v4 CSS-first 설정, 컨테이너 쿼리(관제 위젯), 다크 모드(관제실) | 빌드타임 CSS라 RSC와 충돌 없음 |
| CSS 번들링 최적화: Next.js | Turbopack 기본 빌드, CSS 청킹, critical CSS 인라인, `next/font`로 한글 웹폰트 서브셋·self-host | 대기실 CSS < 10KB, 한글 폰트 용량 감소를 Coverage 탭으로 측정 |
| CSS 번들링 최적화: Vite | 게이트 스캐너·Storybook: cssCodeSplit, Lightning CSS | 저사양 스태프 기기의 초기 로드 최소화 |
| CSS 번들링 최적화: Webpack | 관제 콘솔 Module Federation 호스트·리모트: MiniCssExtractPlugin + splitChunks, 공유 CSS 중복 제거 | MF 원격 위젯마다 CSS가 중복 로드되는 문제를 수치로 확인하고 제거 |

### 7장. 폼 관리

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 라이브러리(RHF, Zod, Formik + Yup 중 취사선택) | RHF + Zod + @hookform/resolvers 채택, Formik + Yup은 ADR로 기각 | 비제어 입력으로 리렌더 최소화, Zod 스키마를 nestjs-zod로 BE와 공유 |
| 적용 폼 | 회원가입, 예매자 정보, 파트너 공연 등록 위저드(다단계·동적 필드), 좌석맵 에디터 속성 패널, 상품 빌더(유형별 동적 필드), 관제 명령 파라미터(2인 승인), 관람 후기(별점·본문, 이모지 허용), 닉네임(이모지 금지), 양도 수신자 | 검증 정책이 서로 다른 폼이 실제로 필요 |
| 길이 제한 | grapheme 기준(`Intl.Segmenter`) | ZWJ 이모지 시퀀스 길이가 FE/BE에서 달라지는 버그 방지 |
| 중복 확인 | 닉네임(팬)·이메일(파트너·운영자) 비동기 검증(디바운스 + AbortController) | 이전 요청 취소로 응답 역전 방지 |
| 금칙어·금지 단어 | NFKC 정규화 + 제로폭 문자 제거 후 매칭 | 전각·제로폭 문자로 우회하는 것을 차단 |
| 허용 문자 집합 | 이름(한글·영문·공백), 전화번호(숫자), 예매번호(영대문자 + 숫자) | 입력별 화이트리스트 |
| 비밀번호 규칙 | 파트너·운영자 계정만 해당(팬은 소셜 로그인 전용이라 비밀번호 없음). 최소 15자, 64자 이상도 허용, 조합 규칙 없음, 흔한 비밀번호·서비스 관련 금지 단어·유출 비밀번호(HIBP k-익명성 API) 대조 | 복잡한 조합 규칙보다 실효성 높은 NIST SP 800-63B 방향, ASVS V6.2 |
| 의미 없는 입력 차단 | 키보드 연타 패턴('ㅁㄴㅇㄹ', 'asdf'), 동일 문자 반복 휴리스틱 | 예매자 이름·관람 후기 품질 |
| 이모지 처리(차단/허용 규칙, 서버 처리, 주의사항) | 닉네임 차단, 관람 후기 허용, 서버는 UTF-8 4바이트 고려, 정렬·검색 시 정규화 | 필드 성격별 정책 분리 |
| 유니코드 정규화, 공백 처리 | NFC 저장(macOS 한글 NFD 입력 문제), trim·연속 공백 축약·비가시 문자 제거 | 같은 이름이 다른 문자열로 저장되는 문제 방지 |
| 자동입력(봇) 방지, 캡차, Cloudflare Turnstile | 로비 진입 시 Turnstile | 사람 확인을 버스트 이전(T-10분)으로 분산 |
| 캡차 없는 봇 판단(마우스 이동, 타이핑 간격, IP/기기 신뢰도, 쿠키/세션, HTTP 헤더) | trust-svc 위험 점수: 포인터 이동 엔트로피, 타이핑 간격 분산, IP/ASN·기기 신뢰도, 쿠키·세션 나이, UA와 Client Hints 불일치·헤더 순서 | K6 봇 탐지의 피처 |
| SQL/스크립트 인젝션 방지(DOMPurify, sanitize-html) | 파트너 공연 설명(리치 텍스트): 서버 sanitize-html + 렌더 시 DOMPurify + CSP, SQL은 Drizzle 파라미터 바인딩 | 파트너 입력이 수십만 팬에게 노출되는 저장형 XSS 경로 차단 |
| 비동기 폼 관리 | RHF + Zod + @hookform/resolvers의 비동기 refine(중복 확인, 쿠폰 유효성) | 비동기 검증 상태를 폼 상태와 하나로 |
| Form UX 1(레이블, 플레이스홀더, 힌트) | 모든 필드에 레이블, 플레이스홀더는 예시만, 힌트는 `aria-describedby` | 명확성과 접근성 |
| Form UX 2(검증 피드백, 모바일·접근성, 편의성, 진행 상태, 제출 명확성, 오류 예방·복구, 시각 계층, 개인화, 성능) | onBlur 후 onChange 재검증, `inputmode`·`autocomplete`(`tel`, `one-time-code`), 첫 오류 필드 포커스, 다단계 진행 표시(1/3), 중복 제출 방지 + Idempotency-Key, 실패 시 SessionStorage 드래프트 복구, 저장된 예매자 정보 자동 채움, Profiler로 리렌더 측정 | 결제 직전 이탈을 줄이는 것이 곧 매출 |
| Form UX 3(낙관적 UI) | 좌석 클릭 즉시 '선택됨' 표시 → 경합에서 지면 롤백 + 흔들림 + 대안 좌석 추천, 찜하기 `useOptimistic` | 체감 속도와 실패 처리의 균형 |

### 8장. 테스트

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| TDD | 가격 계산, 연석 탐색, DSL 인터프리터, 순번·ETA 계산 | Red → Green → Refactor 커밋 이력으로 증명 |
| BDD | 핵심 시나리오를 Gherkin(playwright-bdd)으로: "앞 인원 1,000명, 차례 진행 속도 초당 50번호면 예상 대기 20초" | 기획·운영과 공유하는 실행 가능한 명세 |
| Unit(Jest, Vitest) | FE는 Vitest, BE(NestJS 기본)는 Jest | 생태계 기본값을 따르고 이유를 ADR로 |
| 통합(Vitest, RTL, MSW, jest-dom, Playwright, next-router-mock, faker) | 예매 플로우: RTL + jest-dom 단언, MSW로 API·WS 대체, next-router-mock으로 라우팅, faker로 좌석맵·사용자 시드 | 사용자 행동 단위 검증 |
| MSW | OpenAPI에서 orval로 핸들러 생성, WebSocket 모킹으로 좌석 델타·대기열 진행 재현, 개발용 데모 모드 | 계약 → 목 → 테스트가 한 줄로 이어짐 |
| E2E(Playwright) | 다중 탭(1인 1토큰), 오프라인 전환, 지오로케이션·권한, 토스페이먼츠 테스트 환경, @axe-core/playwright | 브라우저 기능을 실제로 검증 |
| 브라우저 개발자 도구 Recorder | 예매 플로우 녹화 → Puppeteer·Playwright 스크립트 export → 합성 모니터링 시드, 봇 탐지용 사람 세션 데이터 | 녹화 하나를 테스트·모니터링·데이터셋에 재사용 |
| mocha + chai + sinon.js | @web/test-runner(기본 러너 mocha) + chai로 jsdom에 없는 API(Service Worker, IndexedDB, OffscreenCanvas, Web Locks)를 실제 브라우저에서 테스트, sinon fake timers로 QR 회전 주기·Background Sync 재시도 검증 | jsdom 한계를 넘는 자리에서 의미가 있는 조합 |
| Enzyme | 채택하지 않음(ADR) | React 17 이후 공식 어댑터가 없고(React 18용은 비공식뿐) React 19 프로젝트의 테스트 기반으로 쓸 수 없음. '의도적 기각' 섹션 참조 |
| Storybook | 인터랙션 테스트(play function), addon-a11y, 시각 회귀, DS 문서 | 컴포넌트 단위 품질 게이트 |

### 9장. 애니메이션

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| Motion.js | 대기열 진행 바·순번 감소 숫자, 좌석 선택 마이크로 인터랙션(실패 시 흔들림), 결제 바 레이아웃 애니메이션, 페이지 전환 | 상태 변화를 사용자가 이해하게 |
| 뷰포트 유닛에 따른 높이 | 모바일 전체 높이 대기실에 `100dvh`·`svh` | iOS 주소창 높이 변화로 레이아웃이 튀는 문제 |
| 과도한 동적 애니메이션의 프레임 드랍 | transform·opacity만 애니메이트, will-change 남용 금지, Performance 패널·FPS 미터로 측정 | 저가 안드로이드에서도 매끄럽게 |
| UX 기본 고려, Easing | 모션 토큰(진입 ease-out, 퇴장 ease-in, 지속시간 3단계) | 디자인 시스템과 일관성 |
| 접근성: 과도한 애니메이션 감소(Motion) | `useReducedMotion`으로 이동 애니메이션 축소 | `prefers-reduced-motion` 준수 |
| 접근성: 투명도 변경 대체(Motion) | 축소 모드에서 이동 대신 opacity 전환 | 정보는 유지하고 어지럼 유발 요소는 제거 |
| 접근성: 텍스트 애니메이션 처리(GSAP) | 입장 직전 '곧 입장합니다' 글자 단위 연출: 원문은 `aria-label`, 글자 span은 `aria-hidden` | 스크린리더가 글자를 하나씩 읽는 문제 방지 |

### 10장. 인증 및 보안

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| OAuth 2.0 | 카카오·네이버·구글 로그인(Authorization Code + PKCE), state·nonce 검증. 팬 계정의 유일한 인증 수단이며 계정은 (제공자, 제공자 사용자 ID)로 식별 | 국내 사용자 흐름 + 표준 |
| NextAuth.js(Auth.js) | 소비자 웹(소셜 프로바이더)과 파트너 콘솔(Credentials: 이메일 + 비밀번호 + TOTP를 identity에 위임)의 로그인 흐름과 Auth.js 세션 쿠키. 세션 생성은 메시 mTLS 내부 경로로 identity를 부름. 관제 콘솔은 Next.js가 없어 Auth.js를 쓰지 않고 gw-ops → identity 로그인 API를 직접 호출. PEAKET 세션·액세스·리프레시 토큰은 identity-svc가 발급(섹션 6 '계정·인증'의 쿠키 표, ADR-0011) | App Router와 통합된 인증 |
| Next.js 토큰 전략 | BFF 패턴: 액세스·리프레시 토큰은 httpOnly·Secure·SameSite 쿠키에만 두고, Route Handler가 내부 API를 호출할 때 첨부. 대기열 진입·좌석 홀드·결제 접수 같은 핫패스는 Next.js를 거치지 않고, 게이트웨이가 쿠키에서 액세스 토큰을 꺼내 공개키로 검증(ADR-0008) | 브라우저 JS에 토큰 노출 0 → XSS 피해 축소. 핫패스에서 홉 하나를 줄임 |
| 세션 및 토큰 관리 | Redis 세션 저장소, 리프레시 토큰 회전 + 재사용 탐지(토큰 패밀리 무효화), 액세스 토큰(15분, ES256, 세션 ID 포함)은 게이트웨이가 무상태로 검증하고 세션 종료는 Kafka 이벤트로 서비스에 전파(종료 세션 목록 15분 보관, ASVS 7.4.1), 계정당 동시 대기열 1개·기기 바인딩, 참가 토큰·대기열 토큰(queue-svc가 HMAC으로 발급·검증) → 입장 토큰(한 구매 세션 전용. 만료는 최대 체류 시각, 첫 사용 기한 5분, queue-svc가 ES256으로 서명, 게이트웨이는 공개키로 검증, purchase-svc가 jti를 Redis `SET NX`로 구매 세션에 묶어 다른 세션의 재사용 차단). 입장 토큰은 차례가 온 사용자가 예매 화면을 처음 열 때 발급하고, 이 요청이 입장 자리 확정을 겸함(섹션 6 '입장 흐름'). 본인확인을 마친 계정의 액세스 토큰에만 구매 권한(`ticket:buy`)을 넣음(ADR-0011) | 다중 탭·다중 기기 어뷰징과 토큰 재사용 방지 |
| 양방향 Payload 암호화 | 입장 시 ECDH(P-256) 키 교환 + HKDF + AES-GCM(WebCrypto)으로 홀드·주문 요청과 응답을 암호화, nonce·timestamp로 재전송 방지, Nest 인터셉터에서 복호화. 서버 ECDH 키는 고정(Secrets Manager)이고 클라이언트 임시 공개키는 구매 세션에 저장해 요청이 어느 purchase-svc 파드로 가든 같은 구매 세션 키를 계산 | 클라이언트 키는 결국 노출된다는 한계를 명시하고, 봇 제작 비용 증가와 프록시 변조 차단을 노린 다층 방어의 한 층으로 정의. 오버헤드(ms) 측정 |

### 11장. 성능 최적화

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| Core Web Vitals, web-vitals.js | 텔레메트리 SDK가 LCP·INP·CLS(attribution 빌드로 원인 요소 포함) 수집 → sendBeacon → OTel Collector → 관제 콘솔 RUM 패널 | 사용자 체감을 관제 지표로 |
| 엔터프라이즈 분석 도구(New Relic, Datadog, Sentry, Raygun) | Sentry는 에러·릴리스 헬스·세션 리플레이(결제 실패 재현)에 상시 사용. 나머지는 OTel Collector exporter만 바꿔 같은 데이터를 보내는 벤더 평가 매트릭스(기능·비용·락인) | 계측은 OTel 하나로 두고 백엔드는 교체 가능함을 증명 |
| 성과 지표 측정(RUM, 합성 모니터링) | RUM(p75 실사용) + 합성(Recorder 기반 Playwright 스크립트를 5분 주기 실행) | 온세일 직전 합성 체크가 사전 경보 역할 |
| CWV 개선 + 테스트 시나리오 통합 + 이벤트 전파 시스템 | Lighthouse CI 성능 예산을 넘으면 PR 차단, 성능 이벤트를 내부 이벤트 버스 → 수집기 → 대시보드 → 알림으로 전파 | 성능을 회귀 테스트처럼 관리 |
| Critical CSS, Aphrodite/Fela | critical CSS는 빌드 단계에서 인라인. Aphrodite/Fela는 PoC 비교 후 기각 | 런타임 CSS-in-JS는 RSC와 맞지 않음 → FCP·TBT 비교 수치를 ADR에 첨부 |
| 코드 스플리팅 | 라우트·컴포넌트 단위 + 입장 임박 프리페치(순번 ≤ N이면 requestIdleCallback으로 좌석맵 청크 선로드) | 입장 후 좌석맵 표시 < 1초(K5) |
| Lazy Load | next/image, Intersection Observer, 좌석맵 지오메트리는 입장 후 로드 | 대기실 번들 최소화 |
| 이미지·폰트·번들 최적화 | AVIF/WebP + sizes, 한글 웹폰트 서브셋, 번들 예산(대기실 JS ≤ 50KB gzip) | 대기실은 100만 명이 동시에 받는 페이지 |

### 12장. 병렬 처리

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| Web Worker 사용법 | 좌석맵 디코딩·히트 테스트·연석 탐색, 스캐너 QR 디코딩 | 메인 스레드는 입력 처리만 |
| requestIdleCallback | 텔레메트리 배치 전송, 프리페치, IndexedDB 캐시 정리 | 사용자 입력과 경쟁하지 않는 작업 |
| OffscreenCanvas + requestAnimationFrame | Worker에서 좌석맵 렌더 | 5만석 렌더를 메인 스레드 밖으로 |
| Chunking | 5만석 초기 처리를 청크로 나누고 사이사이 양보 | 긴 작업(Long Task) 제거 |
| IndexedDB 백그라운드 I/O, Dexie 사용 시나리오 | 공연장 지오메트리 캐시(버전 키), 오프라인 월렛, 스캐너 공개키·폐기 목록·스캔 이벤트 큐 | 구조화된 대용량 데이터를 비동기로 |
| 오프라인 감지, Graceful Fallback, UI/UX 전략 | `navigator.onLine` + 요청 성공 여부, 오프라인이면 월렛만 활성화하고 예매 버튼은 사유와 함께 비활성, 오프라인 배너와 마지막 동기화 시각 | 공연장 현장 네트워크는 불안정 |
| Service Worker + Cache API, 오프라인 우선 설계 | 앱 셸·월렛 캐시(Serwist/Workbox), 월렛과 스캐너는 오프라인 우선 | 입장 순간 네트워크에 의존하지 않음 |
| 오프라인 큐, React Query offlineFirst | 찜·알림 설정·스캔 이벤트를 큐에 쌓고 복귀 시 재전송, `networkMode: 'offlineFirst'` | 사용자 행동 유실 방지 |
| Background Sync, Periodic Background Sync | 스캔 이벤트 업로드 재시도, 월렛 주기 갱신(Chromium 설치형 PWA 한정, 미지원 브라우저는 앱 실행 시 동기화로 폴백) | 브라우저 지원 차이를 점진적 향상으로 흡수 |

### 13장. 접근성 및 국제화

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| WCAG 2.1 웹 접근성 | 목표는 현행 W3C 권고인 WCAG 2.2 AA(2.1의 상위 호환). 좌석맵 대안 UI(섹션 → 열 → 좌석 키보드 탐색 리스트, '자동 좌석 배정' 버튼), aria-live로 대기 순번·홀드 남은 시간 안내(스로틀), 홀드 시간 1회 연장(2.2.1 Timing Adjustable), 색 + 패턴 좌석 상태(1.4.1), 대비 4.5:1 | Canvas 좌석맵은 스크린리더 사용자가 예매할 수 없는 대표적 장벽 |
| 접근성 테스트 도구 | axe DevTools, Lighthouse, WAVE, Firefox·Chrome 접근성 검사기, NVDA·VoiceOver 수동 시나리오, storybook-addon-a11y, CI에 @axe-core/playwright | 자동 검사 + 실제 보조기기 검증 |
| i18n 구현(i18next) | ko·en·ja·zh, 네임스페이스 분리, 공연 시간은 '공연장 현지 시간 + 내 시간' 병기(`Intl.DateTimeFormat` timeZone), 통화(`Intl.NumberFormat`) | 해외 원정 팬의 시간대 혼동 방지 |
| ICU MessageFormat | 복수형·select("남은 좌석 {count, plural, …}") | 언어별 문법 차이를 번역 파일에서 처리 |
| 현지화 성능(정적 생성, 동적 임포트, 번들 분할, CDN 캐싱, 번역 파일 관리) | 로케일별 정적 생성, 네임스페이스 동적 import, 라우트별 분할, 해시 파일명 + CDN 장기 캐시, 키 누락 CI 검사 | 언어가 늘어도 첫 로드 크기는 그대로 |

### 14장. 개발 도구

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| Elements, Console, Utility API, Sources, 스니펫, 디버그 | 좌석 접근성 마크업 검증, `$0`·`monitorEvents`·`queryObjects`로 누수 객체 확인, 로그포인트·Local Overrides로 API 응답 변조 테스트, 관제 디버그 스니펫 공유 | 재현 → 원인 → 수정의 증거를 남김 |
| 메모리 | 힙 스냅샷 비교, 할당 타임라인 | K5 힙 감소 수치의 근거 |
| 성능(코드 실행 수동 지연, scheduler.yield(), 녹화 분석, Flame 차트, 성능 세부 항목) | CPU 4배 스로틀, 수동 지연 삽입으로 INP 재현, scheduler.yield 전후 Flame 차트 비교 | K5의 근거 자료 |
| 라이트하우스, 애니메이션 테스팅, 녹음기 | Lighthouse CI, Animations 패널로 easing 조정, Recorder로 E2E·합성 모니터링 시드 | 측정의 자동화 |
| 네트워크, 오프라인 에뮬레이션 | 스로틀링, HAR, 요청 차단으로 CDN 장애 시뮬레이션, 오프라인 큐 검증 | 실패 경로 테스트 |
| 렌더링, 보안, 애플리케이션, 리소스 | Paint flashing·Layout Shift Regions·FPS, 인증서·혼합 콘텐츠·COOP/COEP 확인, SW·Cache·IndexedDB·스토리지 할당량, 매니페스트·리소스 타이밍 | 오프라인·보안 설정 점검 |
| 센서, 미디어, 커버리지, CSS 개요 | 지오로케이션 덮어쓰기, 스캐너 카메라 스트림 디버깅, 대기실 미사용 JS/CSS, 토큰 밖 색상 탐지 | 기능마다 대응하는 패널 |
| 웹 분석 도구(memlab) | 좌석맵 열기·닫기 반복 누수 탐지를 CI에 | 누수 회귀 방지 |
| 번들 분석(@next/bundle-analyzer, webpack-bundle-analyzer, source-map-explorer) | Next 앱은 webpack 빌드 모드 비교와 소스맵 기반 source-map-explorer, 관제 MF는 webpack-bundle-analyzer | 번들 예산의 근거 |

## 12. 챕터별 매핑 — 백엔드·인프라·분산 시스템 (15~33장)

백엔드 챕터는 '단일 좌석에 수천 명이 동시 집중되는 고동시성 트래픽 문제'를 핵심 축으로 설정하여 구성하였다. 학습 목록에서 별도 장 번호가 부여되지 않았던 Node.js 런타임, NestJS 프레임워크, 백엔드 테스트 방법론은 15~17장에 체계적으로 배치하였다.

본 절의 표 구성은 11절과 동일하다. 서비스 명칭의 세부 정의는 docs/architecture.md의 서비스 맵을 참조하고, 도메인 용어의 표준 정의는 planning/03-policies-glossary.md를 교차 확인한다.

### 15장. Node.js

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 이벤트 루프 페이즈, nextTick vs 마이크로태스크 vs setImmediate | realtime-gw 대량 브로드캐스트 | 수천 소켓에 좌석 델타를 한 번에 쓰면 루프가 막힘 → 배치 + setImmediate 양보, `monitorEventLoopDelay`·ELU를 오토스케일 지표로 사용 |
| libuv 스레드풀 | 비밀번호 해시(argon2), zlib, DNS | 스레드풀(기본 4개) 포화로 무관한 요청까지 느려지는 현상을 재현하고 `UV_THREADPOOL_SIZE` 튜닝 효과 측정 |
| worker\_threads(Piscina) | 티켓 PDF·QR 대량 생성, 봇 점수 계산 | CPU 작업을 이벤트 루프에서 분리 |
| Streams와 백프레셔 | 파트너 예매자 명단(수십만 행) CSV: DB 커서 → Transform → S3 업로드를 `pipeline()`으로 | 메모리 사용량이 행 수와 무관하게 일정 |
| AsyncLocalStorage | 요청 컨텍스트(traceId·userId) 전파 | REQUEST 스코프 provider 없이 컨텍스트 유지(16장 벤치마크) |
| 메모리·GC | 컨테이너 한도 대비 힙 설정, realtime-gw의 연결당 메모리 측정 | OOMKilled 방지와 파드당 연결 수 산정 근거 |
| Graceful shutdown | SIGTERM → 신규 연결 거부 → WebSocket 드레이닝 → 종료, K8s preStop | 배포 중 좌석 화면 연결 끊김 방지 |
| HTTP keep-alive 에이전트(undici) | Turnstile 검증, 토스페이먼츠 API 호출 | 핸드셰이크 비용 제거로 꼬리 지연 감소 |

### 16장. NestJS

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 모듈, DI, Provider 스코프 | 서비스별 모듈, 기본 싱글턴 | REQUEST 스코프가 부하 시 처리량을 떨어뜨리는 것을 벤치마크로 보이고 AsyncLocalStorage로 대체 |
| Guards | AdmissionTokenGuard(purchase-svc: 입장 토큰 재사용 차단·구매 세션 확인. 서명 확인과 레이트 리밋은 게이트웨이, ADR-0008), RolesGuard(관제 RBAC의 세부 인가) | 인가·입장 검증을 라우트 선언으로 |
| Interceptors | 로깅·타이밍, 멱등성(홀드는 좌석 Redis, 주문·결제는 작업과 같은 PostgreSQL 트랜잭션), 구매 세션 요청 인증 확인(일련번호·HMAC, ADR-0050), 응답 매핑 | 횡단 관심사 분리 |
| Pipes | ZodValidationPipe(nestjs-zod) | FE와 같은 스키마로 검증 |
| Exception Filters | RFC 9457 Problem Details, 도메인 Result 에러 매핑 | 일관된 에러 계약 |
| Custom Decorators | `@Idempotent` `@Audit` `@Traced` `@CurrentUser` | 2장 데코레이터 패턴의 실전 |
| Lifecycle hooks | `onModuleInit` 캐시 워밍, `enableShutdownHooks` 드레이닝 | 15장 graceful shutdown과 연결 |
| @nestjs/cqrs | purchase-svc(booking 모듈)·ops-svc·core-svc(catalog 모듈)의 CommandBus·QueryBus·EventBus | 28장 CQRS 구현 |
| Microservices 트랜스포터 | gRPC·TCP·Kafka | 18장 통신 선택 |
| Fastify 어댑터 | queue-svc, purchase-svc | HTTP 처리 비용을 줄임(JSON Schema를 컴파일한 검증·직렬화, Pino 로깅, [Fastify](https://github.com/fastify/fastify)). Redis I/O와는 무관. Express 대비 처리량을 같은 조건에서 측정 |
| RxJS(백엔드 사용 범위) | 백엔드에서는 채택 기술로 두지 않음. NestJS가 RxJS를 필수 의존성으로 쓰고 인터셉터가 Observable을 반환하므로, 그 자리에서만 `timeout`·`catchError` 같은 연산자를 최소로 씀. admission-ctrl 제어 루프와 스트림 처리는 async/await·타이머·Node 스트림(15장)으로 | I/O를 줄이지 않고 요청마다 추상화 비용만 더함. RxJS는 스트림을 결합·배치·취소할 일이 많은 관제 콘솔(프론트)에서 씀 |
| Terminus, Swagger, GraphQL, WebSocket Gateway | 의존성 헬스체크(Redis·Kafka·DB), OpenAPI 생성, 관제 GraphQL, Socket.IO 게이트웨이(Redis adapter) | 운영 필수 모듈 |

### 17장. 테스트 이론과 백엔드 테스트(TDD, 유닛, 통합, E2E)

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| TDD | 홀드 정책, Saga 상태 전이, AIMD 제어기 | 도메인 규칙을 테스트로 먼저 고정 |
| 유닛 테스트 | Jest + 가짜 시계·난수 DI | 결정적 테스트 |
| 통합 테스트 | Testcontainers(PostgreSQL, Redis, Kafka, MongoDB) | Lua·SQL·트랜잭션을 실제 의존성으로 검증 |
| 계약 테스트 | Pact(BFF ↔ 서비스), buf breaking(gRPC proto), Schema Registry 호환성(Kafka) | 폴리레포에서 독립 배포를 가능하게 하는 안전망 |
| E2E 테스트 | supertest API E2E + Playwright 전체 플로우(대기열 → 결제 → 발권) | 사용자 여정 전체 검증 |
| 부하·카오스 테스트 | k6, Chaos Mesh, AWS FIS | KPI 측정 도구 |

### 18장. REST API, 마이크로서비스 내부 gRPC, TCP 통신(NestJS)

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| REST API | 소비자·파트너 공개 API | CDN 캐시 가능, OpenAPI 문서, 외부 개발자 친화 |
| 내부 gRPC | purchase-svc → payment·ticket 동기 호출(inventory·booking은 같은 서비스 안이라 함수 호출), core-svc shop → ticket·payment, queue-svc → trust-svc(위험 점수), identity 본인확인 상태 조회, 관제 지표 서버 스트리밍 | protobuf 계약, HTTP/2 다중화, deadline 전파(상위 타임아웃을 하위로 내려 낭비 작업 차단). 연결 하나에 요청이 몰리므로 메시가 요청 단위로 분산(ADR-0010) |
| TCP(Nest TCP 트랜스포터) | 관제 제어 평면: ops-svc → admission-ctrl(동시 입장 목표·입장 일시정지, 리더 전용 Service)·purchase-svc(킬스위치)·queue-svc(대기실 공지). 나머지 명령은 설정 이벤트(Kafka)나 각 서비스 API로(섹션 6 운영 명령 카탈로그의 '전달 경로') | 주 데이터 경로(gRPC·Kafka)가 장애여도 동작해야 하는 명령의 상시 대역 외 채널. 코드 생성 없이 단순 |
| 프로토콜 벤치마크 | 같은 페이로드로 REST(JSON/HTTP 1.1) vs gRPC vs Nest TCP의 p50·p99·CPU 비교 | 선택 근거를 ADR에 수치로 첨부 |

### 19장. MSA, Kubernetes와 CNCF 생태계

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| MSA 분리 기준 | 부하·가용성·실행 방식이 다른 경계로만 나눠 서비스 10개(ADR-0007). v0는 같은 모듈 경계의 모놀리스로 시작하고, v1에서 나눈 효과를 K1에서 비교 | MSA를 위한 MSA가 아니라 측정 근거로 분리. 1인 개발이라 팀 소유권은 분리 근거로 쓰지 않음 |
| Kubernetes(EKS) | 전 서비스 배포, PDB, 리소스 요청·한도, 토폴로지 분산 | 온세일 중 노드 장애에도 용량 유지 |
| GitOps·배포 | Helm, ArgoCD, Argo Rollouts(카나리 + Prometheus 분석 자동 롤백) | 온세일 직전 배포 위험 관리 |
| 오토스케일링 | KEDA(Redis 대기열 길이·Kafka lag·Prometheus 쿼리, cron 프리워밍), Karpenter(Spot 노드 신속 확장) | K9 측정 대상 |
| 서비스 메시·게이트웨이 | Gateway API(Envoy Gateway)로 클라이언트 유형별 게이트웨이 5개(ADR-0008). 메시는 Linkerd·Istio를 같은 시나리오로 재서 선택(mTLS, 요청 단위 분산, 예산 안 재시도, 장애 파드 제외, ADR-0010) | 서비스 간 보안과 회복탄력성을 앱 밖에서. 게이트웨이는 얇게, 메시는 측정으로 고름 |
| CNCF 오퍼레이터 | cert-manager, External Secrets Operator, OpenTelemetry Operator, kube-prometheus-stack, Chaos Mesh, Kyverno, OpenCost, Strimzi(로컬 Kafka), Flink Kubernetes Operator, MongoDB 쿠버네티스 오퍼레이터 | 생태계 도구를 실제 문제에 하나씩 매핑 |
| etcd(Raft)와 리더 선출 | K8s Lease로 admission-ctrl 단일 리더 | serving 번호를 두 인스턴스가 동시에 올리면 입장이 폭주 → 33장 합의와 연결 |

### 20장. 캐싱, Redis, 태스크 스케줄링, 세션/토큰 인증

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 다계층 캐시 | CDN(공연 페이지, 구간별 대기 상태 파일 1초 TTL) → Next.js 캐시 → Redis → 프로세스 내 LRU(Map) | 계층마다 TTL과 무효화 경로를 명시 |
| 캐시 스탬피드 방지 | single-flight(Promise Map), 확률적 조기 만료(XFetch), 재계산 락 | 오픈 직전 공연 상세 캐시 만료가 DB 폭주로 번지지 않게 |
| Redis 자료구조 | `INCR`·`INCRBY`(순번), 비트맵·`BITFIELD`(좌석), Hash(홀드), Sorted Set(입장 자리·홀드 만료 인덱스·지연 큐), 샤드 Pub/Sub(좌석 델타 팬아웃), HyperLogLog(고유 방문자), Bloom filter(차단 기기), Lua(원자 다중 좌석 홀드) | 자료구조 선택이 곧 성능. 대기 순서에 Sorted Set을 쓰지 않는 이유는 ADR-0002 |
| Redis Cluster | 용도별 클러스터 분리(대기열·좌석·세션), 해시 태그 `{event:123}`는 함께 바뀌어야 하는 키에만, 1인 1순번 중복 확인 키는 사람 식별값(pid) 기준으로, 셔플 결과는 참가 토큰 해시 기준으로 분산, 장애 전환 시 순번 카운터 세대 번호 | 샤딩과 원자성의 충돌 해결, 한 공연의 키가 한 서버에 몰리는 것 방지 |
| Redis 클라이언트 | 자동 파이프라이닝(ioredis `enableAutoPipelining` 또는 node-redis 기본 동작)으로 같은 이벤트 루프 차례의 명령을 한 번에 전송. 여러 단계는 Lua 스크립트로 왕복 한 번에. 핫패스는 JSON 대신 Buffer·바이너리. ioredis와 node-redis는 클러스터·Lua 사용성을 PoC로 비교해 선택 | 파이프라이닝 없이 명령을 하나씩 보내면 비용 대부분이 소켓 I/O 시스템 호출이라, 왕복 수를 줄이는 것이 효율의 핵심([Redis 파이프라이닝](https://redis.io/docs/latest/develop/using-commands/pipelining/)). 자동 파이프라이닝을 켜고 끌 때 queue-svc 처리량·p99와 Redis CPU를 성능 장부에 기록 |
| 태스크 스케줄링 | BullMQ 지연 작업(이메일·Web Push 발송, 정산 리포트), 반복 작업(정산), 온세일 예약 작업(T-30분 프리워밍), K8s CronJob(일 배치). 홀드 만료는 BullMQ가 아니라 purchase-svc가 좌석 Redis의 만료 인덱스를 주기적으로 정리 | 중복 실행은 리더 선출·잡 ID 고유성으로 방지 |
| 세션/토큰 인증 및 관리 | Redis 세션, 종료 세션 목록(세션 종료 이벤트로 전파, 서비스 메모리에 액세스 토큰 수명 15분만 보관. Redis 블랙리스트는 두지 않음, ADR-0011), 리프레시 토큰 재사용 탐지(10장과 동일 설계) | 프론트와 백엔드가 같은 토큰 수명 모델을 공유 |

### 21장. DB와 SQL 엔지니어링·튜닝

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 인덱스 설계 | 복합 `(event_id, section_id, status)`, 부분 인덱스 `WHERE status = 'AVAILABLE'`, 커버링 `INCLUDE` | 좌석 조회·잔여석 집계 |
| 실행 계획 | `EXPLAIN (ANALYZE, BUFFERS)` 전후 비교, `pg_stat_statements` 상위 쿼리 튜닝 | K3의 근거 |
| 격리 수준 | READ COMMITTED, REPEATABLE READ, SERIALIZABLE에서 오버셀(쓰기 스큐) 재현 실험 | 유니크 제약을 최종 방어선으로 두는 이유를 보여 줌 |
| 잠금 | `FOR UPDATE SKIP LOCKED`(로컬·v0의 Outbox 폴링 릴레이, 작업 큐), 정렬 잠금(데드락 제거), `lock_timeout` | 경합 패턴별 잠금 전략 |
| MVCC·VACUUM | 좌석 상태의 잦은 UPDATE로 생기는 bloat → fillfactor 조정으로 HOT 업데이트 비율 향상, autovacuum 튜닝 | 쓰기 많은 테이블의 숨은 비용 |
| 파티셔닝 | 주문·결제·티켓 테이블을 월 단위 범위로 분할, 5년 보관이 끝난 달은 파티션째 삭제(전자상거래법 시행령 §6의 보존 기간), 파티션 프루닝 확인 | 목적은 처리량이 아니라 보관·파기와 인덱스 크기 유지. 쓰기 처리량은 서버 1대로 충분해 샤딩하지 않음(섹션 8) |
| 커넥션 풀 | PgBouncer(transaction 모드) + prepared statement 주의점 | 수백 파드가 DB 연결을 고갈시키는 문제 |
| 읽기 복제본 | 복제 지연과 read-your-writes(주문 직후 조회는 primary) | 일관성 요구별 라우팅 |
| 전문 검색 | `pg_trgm`(공연명·아티스트 검색) | 별도 검색 엔진 없이 시작 |

### 22장. 로깅, 버저닝, Swagger 문서화

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 로깅 | pino 구조화 JSON + traceId·spanId 상관관계 → Loki, 관제에서 로그 레벨 동적 변경, PII 마스킹, 샘플링 | 로그에서 트레이스로 한 번에 이동 |
| 버저닝 | REST URI 버전(`/v1`, `/v2`) + Nest versioning, Deprecation·Sunset 헤더, Kafka 이벤트 스키마 버전(Schema Registry BACKWARD 호환), 패키지 SemVer(Changesets) | API·이벤트·패키지 세 층의 버전 정책 |
| Swagger 문서화 | @nestjs/swagger로 OpenAPI 생성 → orval로 FE 타입·클라이언트·MSW 핸들러 생성, 파트너 개발자 포털 | 문서가 코드와 테스트까지 이어짐 |

### 23장. AWS DevOps

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| IaC | Terraform 모듈, 환경별 상태 분리, Infracost PR 코멘트 | 비용이 보이는 인프라 변경 |
| 컴퓨트·네트워크 | EKS + Karpenter, NLB(L4) → Envoy Gateway(L7, 클라이언트 유형별 5개, WebSocket 포함. 스캐너 경로는 CloudFront 없이 NLB TCP 통과 → gw-scanner mTLS), CloudFront(+ AWS WAF, Origin Shield, 구간별 대기 상태 파일 1초 캐시, 엣지 함수로 매진 응답·도착 시각 쿠키) | Envoy가 HTTP 처리를 하므로 ALB를 두지 않아 HTTP 프록시를 두 번 거치지 않음(ADR-0008) |
| 보안 | AWS WAF(Bot Control, rate-based rule), Shield Standard, KMS(봉투 암호화·HMAC 키), Secrets Manager(토큰 서명 키·페이로드 ECDH 키), ECR 이미지 스캔 | 엣지에서 먼저 거름 |
| 데이터 | Aurora PostgreSQL, ElastiCache(Valkey/Redis 클러스터 모드), MSK, S3 | 관리형으로 운영 부담 축소 |
| CI/CD | GitHub Actions(OIDC로 AWS 자격 증명, 장기 키 금지) → ECR → ArgoCD → Argo Rollouts | 공급망 보안(31장)과 연결 |
| 카오스·비용 관측 | AWS FIS 장애 주입, 비용 태그 + Cost Explorer | K8·K9 측정 |
| 비용 통제 | 로컬은 kind/k3d + LocalStack, 100만 부하 테스트는 Spot + 시간 단위 생성·삭제 | 개인 예산 안에서 대규모 검증 |

### 24장. WebSocket·Socket.IO, SSE, Webhook, Polling, Long polling

| 기술 | 사용처 | 선택 이유 |
| --- | --- | --- |
| SSE | 파트너 콘솔 실시간 판매 현황 | 서버 → 브라우저 단방향이고 접속자가 수백 명이라 연결 유지 비용이 작음. 자동 재연결 + Last-Event-ID로 놓친 갱신 복구, HTTP/2 필수(HTTP/1.1은 브라우저·도메인당 연결 6개 제한, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)). 대기실에는 쓰지 않음: 100만 명에게 같은 데이터를 주는 데는 CDN 캐시 폴링이 연결 유지보다 싸고 단순함(ADR-0003) |
| WebSocket(ws) | 좌석 델타 | 양방향(섹션 구독·해제), 바이너리 프레임, 최소 오버헤드 |
| Socket.IO | 관제 콘솔 | 룸(공연별), ack(명령 수신 확인), presence, 자동 재연결. 운영자는 수십 명이라 기능이 원시 성능보다 중요. Redis adapter로 멀티 파드 |
| Polling | 대기실 상태 조회(주 경로) | 같은 번호 구간의 사용자가 같은 대기 상태 파일을 CDN 1초 캐시로 받아 origin 부하가 사용자 수와 무관. 예상 대기 시간에 따라 1·5·20초 적응형 주기 + ±20% 지터, 서버가 `Retry-After`로 간격 지시(백프레셔). Cloudflare Waiting Room(20초 새로고침)과 AWS Virtual Waiting Room(serving 번호 주기적 갱신)도 같은 방식 |
| Long polling | 결제 결과 대기 화면 | 토스 승인 결과가 확정될 때까지 수 초간 상태 변화 1회만 기다림. 인프라가 가장 단순 |
| Webhook | 토스페이먼츠 결제 웹훅 수신(서명이 없어 결제 조회 API로 재확인, 전송 ID로 중복 제거), 파트너에게 판매 이벤트 발송(HMAC 서명, 지수 백오프 재시도, DLQ, SSRF 방지) | 외부 시스템과의 비동기 계약 |

### 25장. ORM, RDBMS, NoSQL, NewSQL

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| ORM(TypeORM, Prisma, Drizzle 중 1택) | Drizzle 채택 | SQL이 그대로 보여 `FOR UPDATE SKIP LOCKED`·CTE 같은 핫패스 쿼리를 통제하기 쉽고 런타임이 가벼움. Prisma·TypeORM은 비교 후 ADR로 기각 |
| RDBMS | PostgreSQL(Aurora): 주문·결제·판매 확정·감사·티켓 소유권(양도) | 트랜잭션과 제약이 필요한 원장 |
| NoSQL(Key-Value) | Redis: 대기열·홀드·세션·캐시 | 마이크로초 단위 원자 연산 |
| NoSQL(Wide-column): Cassandra | 실험 후 기각: 대기열 활동 로그·봇 원시 신호를 같은 쓰기량으로 Cassandra와 ClickHouse에 넣고 쓰기·조회·운영 비용을 비교 | 이 데이터에는 실시간 조회 경로가 없어 이미 운영하는 ClickHouse(TTL 30일)로 충분하고, 장기 분석은 S3의 비식별 집계로 함. 저장소 하나를 줄여 운영 부담 감소(13장, ADR-0004) |
| Bigtable | Cassandra 기각 실험 문서에 Bigtable 논문의 SSTable·LSM·wide-column 모델을 정리 | Bigtable 자체는 GCP 전용이라 개념으로 적용(의도적 대체) |
| NewSQL: CockroachDB (실험 후 기각) | 운영에는 쓰지 않고 실험 2개로 검증: 좌석 홀드 경합 벤치마크(Redis·PostgreSQL·CockroachDB 비교), 3리전 클러스터에서 리전 장애 생존 시 쓰기 지연과 장애 동작 측정 | 단일 리전이고 양도 쓰기량이 적어 PostgreSQL로 충분. 리전 장애 생존에 최소 3개 리전과 쓰기 지연 증가가 따른다는 점을 수치로 보이고 ADR로 기각(섹션 13) |
| NoSQL(Document): MongoDB | core-svc의 shop 모듈 상품 카탈로그(굿즈·부가 상품 정의): 유형별 $jsonSchema 검증, 속성 패턴 + 다중키 인덱스, change stream으로 게시 → 페이지 재검증 | 상품 유형마다 속성·배송·환불 규칙이 달라 문서 모델이 자연스러움. 돈과 재고는 PostgreSQL에 두는 polyglot persistence(섹션 6의 MongoDB 채택 근거) |
| OLAP: ClickHouse | 관제 실시간 비즈니스 지표 | 초 단위 집계 쿼리 |

### 26장. Observability

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| OpenTelemetry | Node SDK 자동·수동 계측, 브라우저 SDK(RUM), Collector 테일 기반 샘플링(에러·지연 트레이스는 전부 보존, 정상은 일부만), Baggage로 eventId·queueSeq 전파 | 저장 비용을 줄이면서 중요한 트레이스는 놓치지 않음 |
| Prometheus | Four Golden Signals(요청 계층은 RED, 자원 계층은 USE로 구현), recording rule로 SLI 계산, exemplar로 메트릭 → 트레이스 이동 | SLO 알림의 기반, 섹션 6 '모니터링 신호' |
| Grafana | Dashboards as Code(Git 버전 관리), 온세일 전용 대시보드, 장애 주입 주석 | 재현 가능한 대시보드 |
| Loki | 구조화 로그, LogQL | 트레이스 ID로 로그 연결 |
| Tempo, Mimir, Pyroscope, Alertmanager | 트레이스 저장, 장기 메트릭 HA, 연속 프로파일링(부하 중 CPU 핫스팟), 알림 라우팅 | 관측 스택 완성 |
| 관측가능성에서 관제로 | 위 데이터를 관제 콘솔 GraphQL로 통합하고 운영 명령과 연결 | 관찰과 제어를 한 화면에 |

### 27장. 데이터 엔지니어링

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| CDC | Debezium(PostgreSQL Outbox → Kafka) | 상태 변경과 이벤트 발행의 원자성 |
| 스트림 처리 | Flink: 1초 간격 슬라이딩 윈도우(입장 속도·입장 비율·오류율·결제 성공률, 관제 반영 p95 5초 미만), 그 외 집계는 10초 텀블링 윈도우, 세션 윈도우(사용자 행동 피처 → 봇 점수), CEP(일정 간격 반복 클릭 같은 매크로 패턴), 워터마크로 지연 데이터 처리 | 관제와 봇 탐지의 실시간 입력 |
| 저장 계층 | Kafka → ClickHouse(실시간. 원시 신호는 TTL 30일), Iceberg on S3(레이크. 사용자를 식별할 수 없는 집계·표본만) → Athena·Trino | 실시간과 이력 분석 분리 |
| 배치·오케스트레이션 | dbt(정산·퍼널·매진 소요시간 마트), Airflow, dbt tests로 데이터 품질 검사 | 정산 숫자의 신뢰성 |
| 데이터 → 운영 피드백 | 공연별 수요 예측으로 다음 온세일의 초기 동시 입장 목표·프리워밍 규모 결정 | 데이터가 운영 결정으로 돌아오는 루프 |

### 28장. 아키텍처 스타일

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| Layered | identity-svc, core-svc의 catalog·notify·review 모듈 | 단순 CRUD엔 단순한 구조 |
| Hexagonal | payment-svc(토스페이먼츠·PG 시뮬레이터 어댑터 교체), queue-svc, core-svc의 shop 모듈 | 외부 의존이 자주 바뀌는 곳 |
| Clean Architecture | purchase-svc의 inventory·booking 모듈 | 도메인 규칙을 프레임워크 없이 테스트 |
| MSA·서비스 분리 | 부하·가용성·실행 방식 경계로 서비스 10개, 같은 경계가 아닌 도메인은 모듈(ADR-0007) | 1인 개발의 운영 비용과 장애 격리의 균형 |
| API Gateway·BFF | 클라이언트 유형별 Envoy 게이트웨이 5개, 게이트웨이는 인증·인가·공통 정책·라우팅·변환·관측만(ADR-0008) | 클라이언트별 장애 격리, 서비스는 비즈니스 로직에 집중 |
| DDD | 바운디드 컨텍스트, 애그리거트(Order, SeatInventory, Ticket), 도메인 이벤트, 유비쿼터스 언어 사전(홀드·확정·양도·입장) | 팀·코드·용어 경계를 일치 |
| Polyrepository | 도메인 리포 + 계약 리포 + 프론트 모노레포 하이브리드('리포지토리와 가상 팀 구조' 섹션) | Conway의 법칙을 의도적으로 설계 |
| EDA & Kafka | 도메인 이벤트, 토픽 성격별 파티션 키(거래 이벤트는 eventId로 공연 단위 순서 보장, 대량 텔레메트리는 userId로 분산해 한 공연이 파티션 하나에 몰리는 것 방지), 제어·보안 이벤트(운영 설정·세션 종료)는 별도 토픽, 거래·텔레메트리 클러스터 분리, 컨슈머 그룹, DLQ, 정확히 한 번 대신 멱등 컨슈머를 택한 근거 | 서비스 간 시간적 결합 제거 |
| CQRS | 적용처는 세 곳(16장 @nestjs/cqrs 행과 같음): purchase-svc booking 모듈(주문 이벤트 스토어 + 조회 모델), ops-svc(명령 이벤트 스토어 + ClickHouse 읽기 모델), core-svc catalog 모듈(쓰기 PostgreSQL + Redis 읽기 모델). 좌석 비트맵은 읽기 모델이 아니라 Soft Hold의 원본 저장소 | 읽기·쓰기 부하 특성이 정반대 |
| Saga | 주문 오케스트레이션(주문 생성 → 결제 접수 → 판매 행 PENDING 예약 → 결제 승인 → 판매 확정 → 발권, 실패 시 역순 보상. 섹션 6 '결제 연동'과 같은 순서), 타임아웃·재시도·보상 멱등 | 분산 트랜잭션의 실용적 대안 |
| Event Sourcing | Order 애그리거트, 관제 명령 감사 로그(이벤트 스토어 + 스냅샷) | "그 시각 그 좌석의 상태"를 재구성해 CS 분쟁에 답함 |
| Outbox | 상태 변경과 이벤트 발행 원자성. 릴레이는 Debezium(CDC)이 기본이고(27장), 로컬·v0에서는 같은 Outbox 테이블을 `SKIP LOCKED` 폴링 릴레이로 읽음(21장). 홀드·구매 세션 종료처럼 원본이 Redis인 이벤트는 Redis Stream 릴레이(섹션 6 '좌석') | 이중 쓰기 문제 제거 |

### 29장. 대규모 트래픽, 동시성, 시스템·인프라 설계

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 대규모 트래픽 처리 | 가상 대기열, 프리큐 셔플, CDN 오프로드, 적응형 입장 제어(AIMD) | K1 |
| 동시성 문제, 데드락 | Lua 원자 홀드, 정렬 잠금 | K2·K3 |
| 시스템 설계, 인프라 설계, 운영 인프라 설계 | 서비스 맵·온세일 핫패스·제어 평면 도식, 런북 | 시스템 아키텍처 섹션 |
| 샤딩 | Redis Cluster 해시 슬롯(공연별 키 분산, 대기열 중복 확인 키는 사용자별 분산), Kafka 텔레메트리 토픽의 사용자 키 분산. PostgreSQL은 샤딩하지 않고 동시 온세일이 늘면 셀 단위로 확장 | 인기 공연 하나에 쏠리는 핫키 대응, 샤드 간 트랜잭션 회피 |
| 파티셔닝 | PostgreSQL 선언적 파티셔닝, Kafka 파티션 | 데이터·이벤트 병렬성 |
| 서킷 브레이커 | 1차 게이트웨이(Envoy 동시 요청·대기 상한, 장애 파드 제외, 즉시 503 + `Retry-After`), 2차 서비스 내부(opossum, 의존성별 연결 풀), 재시도는 메시 한 층에서 예산 안에서만, deadline 전파(ADR-0009) | 장애가 시스템 전체로 번지는 것 차단 |
| 멱등성 | Idempotency-Key 헤더(결제·주문), 멱등 컨슈머, 스캔 이벤트 ID | 재시도해도 안전한 시스템 |
| Strong vs Eventual consistency | 데이터별 일관성 선택표(시스템 아키텍처 섹션) | 일관성 수준은 데이터마다 다르게 |
| Outbox | 28장과 같은 구현을 결제·좌석 이벤트에 적용 | 이벤트 유실 0 |
| 그레이스풀 디그레이데이션 | 부하 시 관람 후기, 좌석 추천, 찜 같은 비핵심 기능을 피처 플래그로 끔(섹션 6 운영 명령 카탈로그) | 핵심 경로에 용량 집중 |

### 30장. RUM, SLI, SLO, SLA

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| SLI | 대기열 진입 성공률, 입장 지연, 홀드 성공률(경합 패배 제외), 결제 완료율(카드 거절·사용자 취소 제외, 섹션 9와 같은 기준), WS 연결 성공률, INP·LCP·CLS p75(Google Core Web Vitals 기준) | 사용자 경험을 대표하는 지표만 |
| SLO | 여정별 SLO 9개, 기본 SLO(일반 API·내부 호출), 온세일 윈도우(70분)와 28일 윈도우 이원화, Degraded Mode, 에러 버짓 정책('SLO 설계' 섹션) | 신뢰성과 속도 사이의 거래 규칙 |
| 알림 | 멀티 윈도우·멀티 번 레이트 알림(Google SRE Workbook 방식) | 노이즈는 줄이고 빠른 소진은 빨리 잡음(K8) |
| SLA | 파트너(프로모터) 대상 가용성 약정 문서(크레딧 조건), SLO보다 느슨하게 | 대외 약속과 내부 목표 분리 |
| RUM | 텔레메트리 SDK → 관제 콘솔 '사용자 체감' 패널 | 서버 지표가 정상이어도 사용자가 느린 경우를 잡음 |

### 31장. 웹 보안: [OWASP Top 10:2025](https://top10.owasp.org/2025/) 기준

섹션 0의 지침대로 10개 항목 모두에 대응이 있어야 합니다. '대응 ASVS 장'은 그 항목이 어느 기능별 ASVS 추적 표에서 검증되는지를 가리킵니다.

| 항목 | 적용 위치 | 대응 ASVS 5.0 장 |
| --- | --- | --- |
| A01 Broken Access Control | 주문·티켓 ID는 UUIDv7 + 소유자 검증(IDOR 방지), 관제 RBAC + 2인 승인, 파트너 테넌트 분리, 파트너 웹훅 URL의 SSRF 방지(2025판에서 A01로 통합) | V8 인가, V1.3 새니타이징(SSRF) |
| A02 Security Misconfiguration | helmet 보안 헤더, CSP, COOP·COEP, S3 퍼블릭 차단, Kyverno 정책 | V13 설정, V3 웹 프론트엔드 보안 |
| A03 Software Supply Chain Failures | Renovate, npm audit, Trivy, SBOM(Syft), 이미지 서명(cosign), GitHub Actions OIDC, 의존성 고정 | V15.2 보안 아키텍처와 의존성 |
| A04 Cryptographic Failures | TLS, KMS 봉투 암호화, 구매 세션 소지 증명(요청 HMAC), 회전 QR 서명 키를 스크립트가 꺼낼 수 없는 WebCrypto 키로 보관(하드웨어 보관은 아님, ADR-0050) | V11 암호화, V12 보안 통신 |
| A05 Injection | Drizzle 파라미터 바인딩, sanitize-html·DOMPurify, CSP | V1 인코딩·새니타이징 |
| A06 Insecure Design | 좌석·한정 굿즈 사재기, 홀드 남발 같은 비즈니스 로직 남용을 STRIDE 위협 모델링으로 다룸, 1인 매수 제한 | V2.3 비즈니스 로직 보안, V2.4 자동화 방지 |
| A07 Authentication Failures | 팬은 소셜 로그인 전용(비밀번호 없음), 파트너·운영자는 다중 인증 필수, PKCE, 리프레시 토큰 재사용 탐지, 관리 계정 크리덴셜 스터핑 방어(레이트 리밋 + 유출 비밀번호 검사) | V6 인증, V7 세션 관리, V9 자체 포함 토큰, V10 OAuth·OIDC |
| A08 Software or Data Integrity Failures | 웹훅 HMAC 서명, SRI, 서명된 대기열·입장 토큰 | V3.6 외부 리소스 무결성, V1.5 안전한 역직렬화, V9 자체 포함 토큰 |
| A09 Security Logging and Alerting Failures | 이벤트 소싱 감사 로그, 보안 이벤트 알림(관제 연동) | V16.1~16.4 보안 로깅 |
| A10 Mishandling of Exceptional Conditions | 위험 점수 서비스 장애 시 캐시 규칙 + 보수적 레이트 리밋으로 축소 운영(무조건 통과 금지), 에러 응답에 내부 정보 노출 금지, 예외 경로를 카오스 테스트로 검증 | V16.5 오류 처리, V15.3 방어적 코딩 |

점검 도구는 ZAP(DAST)과 Semgrep·CodeQL(SAST)입니다. CI에서 High 이상 발견이 남아 있으면 배포하지 않습니다.

### 32장. CS 지식(네트워크, 운영체제, 컴퓨터 구조, 알고리즘)

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 네트워크 | HTTP/2 다중화로 HTTP/1.1의 브라우저·도메인당 연결 6개 제한 회피(파트너 콘솔 SSE 다중 탭), HTTP/3(QUIC)로 모바일 패킷 손실 시 HOL 블로킹 완화, CDN 캐시 키 설계(대기 상태 파일에 사용자별 값을 넣지 않음), WebSocket 업그레이드, 작은 델타 지연을 줄이는 TCP\_NODELAY, 부하 발생기의 ephemeral port 고갈·TIME\_WAIT, 백로그(somaxconn) | 100만 명의 요청을 실제로 만들고 받으려면 필요한 지식 |
| 운영체제 | epoll 기반 이벤트 루프, 파일 디스크립터 한도(ulimit), cgroup 메모리 한도와 OOM, 컨텍스트 스위칭 | 파드당 연결 수 산정 |
| 컴퓨터 구조 | TypedArray 연속 메모리로 좌석 순회의 캐시 지역성 확보, SharedArrayBuffer·Atomics 메모리 모델, Redis 단일 스레드 모델의 의미 | 5만석 처리 속도 |
| 알고리즘 | 연석 탐색(행별 비트셋에서 연속 N석을 비트 연산으로), Fisher–Yates 셔플(로비 공정 랜덤), 토큰 버킷·GCRA, AIMD, 일관된 해싱, Bloom filter, HyperLogLog, 스킵 리스트(ZSET) O(log N) vs `INCR` O(1), 지수 백오프 + 지터 | 알고리즘 선택이 곧 KPI |

### 33장. 분산 시스템 심화

| 학습 항목 | 적용 위치 | 채택 이유 |
| --- | --- | --- |
| 합의 알고리즘 | Raft: etcd(K8s Lease 리더 선출), Kafka KRaft, CockroachDB range 복제(3리전 실험 클러스터). 리더 파드를 강제 종료해 재선출 시간과 serving 번호 중복 증가 여부를 측정. Redlock 논쟁을 정리하고 펜싱 토큰을 채택 | 분산 락의 안전성을 근거로 설명 |
| CAP 정리와 트레이드오프 | 데이터별 일관성 선택표 + PACELC, Chaos Mesh 네트워크 분할 실험에서 컴포넌트별 실제 동작 기록 | 이론을 실험 결과로 |
| 분산 트랜잭션 | 2PC를 쓰지 않는 이유(블로킹, 코디네이터 단일 장애점) → Saga + Outbox. CockroachDB 실험 클러스터의 내부 분산 트랜잭션과는 구분 | 선택 근거를 ADR로 |
| 벡터 클록과 인과관계 | (1) 섹션별 버전 벡터로 스냅샷 + 델타 병합 (2) 오프라인 게이트 스캐너 동기화 때 '동시(concurrent) 스캔'을 판별해 스크린샷 공유 부정 입장과 정상 재입장을 구분(기기 시계를 믿지 않음) | 오프라인 다기기 환경의 정합성 |
| Google GFS, Hadoop HDFS | 이벤트 아카이브를 append-only 대용량 파일로 설계, small file problem은 Iceberg 컴팩션으로 해결, Flink 체크포인트는 S3(HDFS 호환 파일시스템 API) | 직접 운영 대신 설계 원리를 적용(의도적 대체) |
| Flink, Dataflow | 27장 Flink 잡을 Dataflow 모델(윈도우·워터마크·트리거·지연 데이터)로 설계·문서화 | Dataflow는 GCP 관리형이라 모델을 Flink로 구현 |
| Tail latency | 'The Tail at Scale'의 헤지 요청(좌석 스냅샷 읽기), 타임아웃 예산, GC·이벤트 루프 지연 억제, 오픈 모델 부하로 p99·p99.9 측정 | 100만 명의 1%는 1만 명 |

## 13. 의도적 기각·대체 항목 (정직한 예외)

목록 내 10개 기술 항목은 무비판적으로 도입할 경우 오히려 '합리적 공학적 이유에 기반한 기술 선정' 원칙을 위배하게 되므로, 시스템에서 배제하거나 상위 개념으로 대체한 객관적 근거를 벤치마크 수치와 공식 ADR 문서로 영구 보존하였다. 기술 검토 시 "해당 기술을 채택하지 않은 명확한 이유"를 정량 근거로 논증하는 과정은 아키텍처 리더십의 핵심 역량을 증명한다.

| 항목 | 처리 | 근거 | 매핑 증거물 |
| --- | --- | --- | --- |
| Enzyme | 기각 | 공식 어댑터는 React 16까지이고, React 18용은 제작자 스스로 '매우 비공식'이라 밝힌 어댑터뿐([GitHub](https://github.com/cfaester/enzyme-adapter-react-18)). React 19 프로젝트의 테스트 기반이 될 수 없음 | ADR, RTL 전환 근거 문서 |
| Aphrodite / Fela | PoC 후 기각 | 런타임 CSS-in-JS는 서버 컴포넌트에서 쓸 수 없고, Tailwind 빌드타임 CSS와 역할이 겹침 | PoC 브랜치의 FCP·TBT·CSS 바이트 비교표 + ADR |
| Formik + Yup | 취사선택에서 제외 | 챕터 지시대로 하나를 고름. RHF + Zod가 비제어 입력과 FE/BE 스키마 공유에서 유리 | ADR |
| Bigtable | 개념으로 대체 | GCP 전용 관리형 서비스 | Cassandra 기각 실험 문서에 SSTable·LSM·wide-column 모델 매핑 |
| Cassandra (Wide-column) | 실험 후 기각 | 맡기려던 대기열 활동 로그와 봇 원시 신호에는 실시간으로 조회하는 경로가 없음. 실시간 봇 판정은 Redis 피처로 하고, 원시 데이터는 이미 운영하는 ClickHouse(TTL 30일)로 충분하며 S3에는 비식별 집계만 남김. 하트비트도 없애 쓰기량 자체가 줄었음. 운영할 저장소를 하나 줄임 | 같은 쓰기량을 Cassandra와 ClickHouse에 넣은 쓰기·조회·운영 비용 비교 실험 + ADR-0004 |
| CockroachDB (NewSQL) | 실험 후 기각 | 단일 리전이고 양도 쓰기량이 적어 PostgreSQL로 충분. 리전 장애를 견디려면 데이터베이스 리전이 최소 3개 필요하고, 쓰기 지연이 가장 가까운 리전 왕복 시간만큼 늘어남([CockroachDB 문서](https://www.cockroachlabs.com/docs/stable/multiregion-survival-goals)). 2024년 11월부터 무료 Core가 없어지고 매년 갱신하는 Enterprise Free 라이선스로 바뀜([InfoQ](https://www.infoq.com/news/2024/09/cockroachdb-license-concerns/)) | 좌석 경합 벤치마크와 3리전 생존 실험 수치 + ADR |
| Dataflow | 모델로 대체 | GCP 관리형 서비스 | Beam/Dataflow 모델(윈도우·워터마크·트리거)을 Flink로 구현한 설계 문서 |
| GFS, HDFS | 원리로 대체 | 분산 파일시스템을 직접 운영하는 비용이 학습 효과보다 큼 | S3 + Iceberg 아카이브 설계에 append-only·대용량 블록·메타데이터 분리 원리 적용, 필요하면 EMR 단기 실험 |
| Datadog, New Relic, Raygun | 평가 전용 | 계측은 OTel 하나, 상시 운영은 Grafana 스택 + Sentry. 상용 벤더는 exporter만 바꿔 같은 데이터를 보내 비교 | 벤더 평가 매트릭스(기능·비용·락인) |
| 상태관리 도구 여러 개 | 경계 명시 | 4장 상태 소유권 매트릭스로 '앱 × 상태 종류'마다 도구 하나 | 매트릭스 + 앱별 import 제한 린트 규칙 |


### §13 항목의 ADR 대응 [보완]

| 원문 항목 | 결정 기록 |
| --- | --- |
| Enzyme | ADR-0018 |
| Aphrodite / Fela | ADR-0019 |
| Formik + Yup | ADR-0020 |
| CockroachDB | ADR-0021 |
| Cassandra | ADR-0004 |
| 상태관리 도구 여러 개 | ADR-0024(상태 소유권 매트릭스) |
| Bigtable, Dataflow, GFS/HDFS | ADR 없음. 위 표의 '근거·매핑 증거물'이 기록이며 실험·평가 문서는 작성 예정. 다만 Dataflow 모델(창·워터마크·늦은 사건)은 ADR-0071이 Flink 설계 문서(docs/streaming.md §3·§4)로 옮겼고, 그 과정에서 세션 창·CEP는 쓰지 않기로 했다(본문의 학습 항목 행과 면접 답변 문장은 원문이라 그대로 둔다) |
| Datadog·New Relic·Raygun | ADR-0067(관제 콘솔과 관측 도구의 역할 경계, Phase 4 비교 측정과 판정 규칙), ADR-0068(관측 스택 선택 근거와 대안 비교, AWS 관리형 후보 추가) |

## 면접 답변 문장(원문 §9)


- **대기열 진입**: "T=0 버스트 20만 RPS에서 진입 p99 200ms / 가용성 99.9% SLO를 정의했고, Redis 과부하 시 서명된 도착 시각 쿠키로 순서를 보존한 채 진입 p99 1초를 허용하는 Degraded Mode까지 설계했습니다."
- **대기 상태 전파**: "100만 동시 대기에서 입장 임박 사용자의 순번 반영 p99 2초 / 조회 가용성 99.95% SLO를 정의했습니다. 번호 구간별로 같은 대기 상태 파일을 CDN에 캐시하고 줄 위치에 따라 폴링 주기를 1~20초로 바꿔, 앞 인원을 정확히 보여 주면서도 origin 부하를 사용자 수와 무관하게 만들었습니다. 접속 여부가 아니라 대기표를 기준으로 인원을 세서 '살아 있음' 신호의 쓰기 부하도 없앴습니다. CDN 장애 시에는 폴링 주기를 늘리고 S3 정적 경로로 전환해 p99 5초를 허용하는 Degraded Mode까지 설계했습니다."
- **좌석 홀드**: "좌석 하나에 1,000명이 몰리는 초당 2,000건 홀드에서 p99 50ms / 가용성 99.95%와 오버셀 0을 정의했고, Redis 페일오버 중에는 DB 정렬 잠금 경로로 p99 300ms를 허용하는 Degraded Mode까지 설계했습니다."
- **좌석 상태 전파**: "동시 5,000명·초당 500건 변경에서 반영 p99 300ms SLO를 정의했고, 팬아웃 과부하 시 배치 간격을 1초로 늘려 p99 1.5초를 허용하는 Degraded Mode까지 설계했습니다."
- **결제**: "피크 300 TPS에서 결제 접수 p99 150ms 미만과 확정 p99 3초를 나눠 정의했습니다. 결제 접수 p99 150ms(자체 기준)를 지키려고 PG 호출을 응답 경로에서 빼고 202로 접수했고, 토스 승인 API 장애 시에는 인증 유효시간 10분 안에서 같은 멱등키로 재시도하고, 넘기면 승인하지 않아 과금 없이 만료시키는 Degraded Mode까지 설계했습니다."
- **공연 페이지**: "오픈 직전 30만 RPS에서 TTFB p99 150ms / 가용성 99.99% SLO를 정의했고, origin 장애 시 최대 10분 지난 데이터를 허용하는 stale-if-error Degraded Mode까지 설계했습니다."
- **관제 지표 반영**: "초당 3만 이벤트에서 관제 화면 반영 p95 5초 미만 SLO를 정의했고, 이를 위해 핵심 지표를 10초 텀블링에서 1초 간격 슬라이딩 윈도우로 바꿨으며, 파이프라인이 밀리면 시스템 지표로 축소해 신선도 p99 60초를 허용하는 Degraded Mode까지 설계했습니다."
- **관제 운영 명령**: "명령 접수 p95 500ms 미만과 대상 서비스 전파 p99 3초를 나눠 정의했고, ops-svc가 죽어도 런북 CLI와 TCP 대역 외 채널로 전파 p99 10초를 허용하는 Degraded Mode까지 설계했습니다."
- **게이트 입장**: "게이트당 분당 60명에서 판정 p95 150ms / 위조 통과 0 SLO를 정의했고, 네트워크가 끊기면 오프라인 검증으로 판정 SLO는 유지하고 동기화 지연만 허용하는 Degraded Mode까지 설계했습니다."
- **목표 설정 방식**: "초기 목표는 Google Core Web Vitals·W3C·NIST처럼 공신력 있는 기준에서 가져왔고, 공개 기준이 없는 서버 지연은 용량 산정 기반의 자체 기준으로 표시했습니다. v0·v1을 실측한 뒤 목표를 조일 때의 비용과 얻는 가치를 비교해 최종 목표를 정하고 ADR로 남겼습니다. 출처를 확인할 수 없는 '업계 통용' 수치는 근거에서 뺐습니다."

각 답변 문장의 후속 질의에 대해서는 "해당 목표 수치를 산정한 객관적 공학 근거(목표 근거)", "이를 지켜내기 위한 시스템 설계 및 레이턴시 버짓 분배(달성 메커니즘)", "Chaos Mesh 및 부하 시험을 통한 실측 증명(검증 방식)"의 3단계 프레임워크로 일관되게 소명한다.

