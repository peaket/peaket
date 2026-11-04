# 분야 편 5: 디자인 시스템

- **기준 시점**: ADR-0177까지, 2026-11-01
- **맡는 정본**: [docs/design/d2-design-system.md](../../design/d2-design-system.md) 전체, [docs/design/d4-handoff-checklist.md](../../design/d4-handoff-checklist.md) 전체, [docs/design/tokens.json](../../design/tokens.json)(구조만), docs/design/icons/genre/의 장르 아이콘 SVG 10개, [ADR-0040](../../adr/0040-design-system-base-seed.md)
- **규범이 아니다**: 정본을 풀어 쓴 해설이다. 숫자와 규칙이 정본과 다르면 정본이 맞다([ADR-0177](../../adr/0177-walkthrough-explain-in-interview.md)).
- **한 판 문서와의 관계**: [한 판 문서](../01-system-design.md)에 디자인 시스템을 직접 다루는 단계는 없다. 9단계가 좌석맵을 Web Worker(화면과 따로 도는 작업 스레드)와 OffscreenCanvas(화면 밖에서 그리는 캔버스)로 그리는 이야기(K5: 5만 석 화면의 조작 반응)를 하는데, 그 부품이 이 편의 CMP-021이다.
- **측정 전이다**: 대비 수치는 공식으로 낸 계산값이다. 서비스 수준 측정(NFR 목표를 운영 규모로 잰 것)은 아직 없어 번들 크기 같은 성능 숫자는 목표값이고 `[실측 전]`이다. 이 편의 시험(FE-T18·FE-T30 등)과 화면 쪽 PoC(본 개발 전에 위험한 부분을 미리 재 보는 시험)는 결과가 없다. 2026-11-01의 기반 PoC(wbs 0.5.1)는 PC 한 대에서 서버 쪽만 쟀다([ADR-0176](../../adr/0176-foundation-poc-results.md), 숫자는 '실측(PC)'이고 운영 규모 증거가 아니다). 정본의 `[가정]`·`[보완]`은 그대로 옮겼다.

## 1. 이 문서가 정하는 것

docs/design/d2-design-system.md는 피켓 화면의 공용 재료를 정한다. 재료는 셋이다. 디자인 토큰(색·글자 크기·간격 같은 디자인 값에 이름을 붙여 둔 것), 컴포넌트(화면을 조립하는 부품) 83개, 그리고 폼·표·빈 화면·모달·확인 절차·비활성 버튼의 공통 패턴과 문구 규칙이다. 토대는 당근이 공개한 디자인 시스템 SEED Design 3.0(Apache-2.0 라이선스)이다. 피켓은 SEED의 토큰과 부품을 그대로 쓰고, 브랜드 색(인디고)과 웹 접근성 국제 기준 WCAG 2.2 AA에 못 미치는 글자색만 덮어쓴다. 토큰 값의 원본은 docs/design/tokens.json 한 파일이다(SSOT: 값의 원본을 한곳에만 두는 것). 토큰 빌드 도구 Style Dictionary가 이 파일에서 CSS 변수(이름 붙인 스타일 값), Tailwind(클래스 이름으로 스타일을 붙이는 CSS 도구) v4 테마, TypeScript 상수를 만든다. docs/design/d4-handoff-checklist.md는 시안을 넘기기(핸드오프) 전과 리뷰를 요청하기 전에 디자이너와 개발자가 함께 보는 점검표다. 공통 26항목, 화면군 28개의 추가 점검, 넘길 산출물을 정하고 항목마다 자동 검사 장치(없으면 '수동')를 적는다.

> **30초 설명**: "화면 재료는 당근의 공개 디자인 시스템 SEED Design 위에 얹었습니다. 부품 100여 종과 라이트·다크 테마를 바로 쓰고, 출처와 라이선스를 댈 수 있어서입니다. 다른 회사 화면에서 값을 뽑는 안은 약관에 어긋나 버렸습니다. SEED는 대비를 APCA라는 다른 기준으로 맞춰서, 피켓 기준인 WCAG 2.2 AA에 못 미치는 글자색과 포커스 링만 진하게 덮어썼습니다. 값은 tokens.json 한 파일에 두고 CSS 변수, Tailwind 테마, TypeScript 상수로 빌드합니다. 좌석맵은 Canvas라 CSS 변수를 못 읽어 TS 상수를 씁니다. 부품은 83개이고, 좌석 상태는 색만이 아니라 무늬와 글자로 함께 알립니다. 핸드오프 점검표 26항목에는 axe나 Playwright 같은 자동 검사를 붙이고, 장치가 없는 항목은 수동이라고 적었습니다. 아직 돌린 결과는 없습니다."

## 2. 절마다 읽기

| 정본 절 | 무엇을 정하나 | 왜 | 해설서에서 |
| --- | --- | --- | --- |
| docs/design/d2-design-system.md §1 토큰 규칙 | 토큰 원칙 열네 가지(아래 여섯 줄로 나눠 읽는다) | 값은 SEED에서 검증된 것이라 임의 추정치가 아니다. SEED 판이 오르면 `$extensions.seed`의 원본 이름으로 맞춘다 | — |
| docs/design/d2-design-system.md §1 '디자인 토대'·'단일 소스 관리 체계' | SEED 토큰·부품이 토대다. tokens.json은 DTCG(W3C 디자인 토큰 커뮤니티 그룹) 형식이되 값은 이전 초안의 문자열('16px')이다. 이름에 마침표·중괄호를 쓰지 않고, 좌석 무늬는 확장 칸 `com.peaket.pattern`에 둔다 | Style Dictionary 5가 2025.10 판 객체 값을 다 지원하지 않는다. 점 든 이름은 별칭 `{space.1.5}`를 space → 1 → 5로 읽어 깨뜨린다(중간-099) | — |
| docs/design/d2-design-system.md §1 '원시 팔레트와 시맨틱 토큰의 엄격한 분리'·'라이트·다크 모드 제어' | 화면 코드는 의미 토큰(`color.semantic.*`)만 쓰고, 원시 색 참조는 ESLint(코드 검사 도구)가 막는다. 관제 데스크톱은 다크, 스캐너는 라이트 고정, 웹·파트너는 OS 설정 | 라이트·다크가 같은 의미 키로 바뀐다. SEED 기본 색과 피켓이 보정한 문구색이 섞이지 않게 한다(ADR-0040 결과). 스캐너는 낮에 잘 보여야 한다 | — |
| docs/design/d2-design-system.md §1 'SEED 스타일 속성과 화면 CSP'·'SEED CSS 싣기'·'CSS 층 순서' | CSP(페이지가 적용할 스크립트·스타일의 출처를 정하는 브라우저 규칙)는 `style` 속성만 받는다. SEED CSS는 쓰는 부품의 recipe(부품별 CSS)만 층 판으로 싣고, CSS 층(규칙 묶음 사이의 우선순위) 순서를 한 줄로 정한다 | 서버가 그린 SEED 부품의 스타일이 CSP에 막힌다(ADR-0111). 전체 CSS gzip(전송용 압축) 42.2KiB는 경로별 예산 20~30KB를 넘는다. 층 순서가 있어야 SEED 부품과 Tailwind 유틸이 겹칠 때 이기는 쪽이 정해진다(중간-097) | [결정 카드 D-34](../decisions/D34-styling-forms-test-tools.md)(CSP) |
| docs/design/d2-design-system.md §1 '좌석 상태의 다중 감각 표현' | 좌석 상태는 색 토큰과 무늬 `pattern.seat.*`를 함께 쓴다 | 색만으로 정보를 가르지 않는다(NFR-020, WCAG 1.4.1) | 분야 편 10(NFR-020 줄) |
| docs/design/d2-design-system.md §1 '타이포그래피 스케일'·'간격, 라운드, 그림자, 모션'·'재배치와 글자 확대' | SEED 스케일을 잇는다. 중단점(배치가 바뀌는 화면 폭)은 SEED 값 넷이다. 폭 320 CSS px에서도 세로로만 스크롤하고, 글자 상자는 높이를 고정하지 않는다 | 중단점이 SEED와 다르면 SEED 부품과 Tailwind 접두사가 1024~1279px 같은 폭에서 다르게 바뀐다(중간-096). 재배치·확대는 WCAG 1.4.10·1.4.4·1.4.12다 | — |
| docs/design/d2-design-system.md §1 '버전 관리 및 시각 회귀 테스트'·'UI 아이콘' | `@peaket/ds`는 모노레포(여러 앱·패키지를 한 저장소에 두는 방식)의 `packages/ds`에 두고 게시하지 않는다. 토큰을 바꾼 PR(코드 변경을 합쳐 달라는 요청)은 Playwright(브라우저를 자동으로 움직이는 시험 도구) 화면 비교를 통과해야 한다. 아이콘은 24 격자·2px 선·`currentColor` | 브라우저 그리기는 OS·판마다 달라 판을 고정한 컨테이너에서 찍는다. 같은 뜻은 같은 아이콘이다(`ic-cart` 장바구니, `ic-bag` 굿즈 상점) | [결정 카드 D-31](../decisions/D31-one-monorepo.md)(모노레포) |
| docs/design/d2-design-system.md §1.1 SEED 컴포넌트 대응표 | 83개를 SEED 순수 활용 16, SEED 기반 커스텀 확장 26, 피켓 전용 41로 나누고, SEED 추가 활용 부품을 적는다. 당근 로고·상호·carrot 오렌지는 쓰지 않는다 | SEED에 있는 것은 그대로 쓰고, SEED에 없는 표·차트·선형 진행 막대와 도메인 부품만 직접 만든다(ADR-0040 결정 6). 브랜드 자원은 NOTICE(라이선스 고지)가 제한한다 | — |
| docs/design/d2-design-system.md §2 컴포넌트 카탈로그 [보완] | 부품마다 용도·안티패턴, 변형, 상태, 접근성 요건, 쓰는 화면 | 화면설계서의 UI 요구사항에서 끌어낸 목록이라 전체가 `[보완]`이다 | 한 판 9단계(CMP-021), 분야 편 9~14(그 편의 부품) |
| docs/design/d2-design-system.md §3 공통 패턴 | 반복 패턴 여섯(아래 줄) | 같은 문제를 화면마다 다르게 풀지 않게 한다 | — |
| docs/design/d2-design-system.md §3.1 폼 입력 및 검증 패턴 | RHF(React Hook Form) + Zod(스키마 검증 도구)를 쓴다. 길이는 grapheme(눈에 한 글자로 보이는 단위)로 세고, 성명 문자와 빠른 입력은 막지 않는다. 비동기 검증은 300ms 디바운스(입력이 멈춘 뒤 보내기)다. 민감 입력은 브라우저 저장소에 두지 않고, 앞서 넣은 값은 다시 묻지 않는다 | 빠른 입력 차단은 붙여넣기·음성 입력·'ㅋㅋㅋㅋㅋ'를 막고 봇에는 효과가 없다. 앞선 요청을 취소해 늦은 응답이 최신 결과를 덮지 않게 한다 | [결정 카드 D-34](../decisions/D34-styling-forms-test-tools.md)(RHF + Zod) |
| docs/design/d2-design-system.md §3.2 테이블 및 대규모 데이터 그리드 패턴 | `aria-sort`, 커서 페이지네이션(마지막으로 받은 위치 다음부터 이어 받는 쪽 나누기), 검색 결과 페이지 번호, '더 보기', 가상 스크롤(보이는 행만 그리기) | 5만 행 목록을 브라우저가 그릴 수 있게 한다 | — |
| docs/design/d2-design-system.md §3.3 빈 화면, 로딩, 에러, 권한 없음 패턴 | 이유와 다음 행동, 스켈레톤(받는 동안 보이는 자리 그림) 우선, 관제 위젯마다 Error Boundary(오류를 그 칸에 가두는 React 장치), 오프라인 배너 | 위젯 하나의 장애가 대시보드 전체를 막지 않게 한다 | — |
| docs/design/d2-design-system.md §3.4 토스트 및 모달 다이얼로그 패턴 | 토스트는 가벼운 결과만. 포커스 트랩(초점을 모달 안에 가두기), 모달 위 모달 금지, 법정 고지는 본문에 | 겹친 모달은 초점 가둠이 둘이 된다(ADR-0066 대안) | — |
| docs/design/d2-design-system.md §3.5 취소 불가능한 중요 작업의 단계적 확인 절차 | 팬은 재인증 → 환급 명세 → 결과를 적은 버튼. 관제는 사유 → dry-run(바꾸지 않고 영향만 계산) → 재인증 → 1·2인 승인 → 전파 → ack(받았다는 확인) → 되돌리기 | 결과를 먼저 보고 고르게 한다. 탈퇴를 가입보다 어렵게 만들지 않는다(POL-033) | — |
| docs/design/d2-design-system.md §3.6 이유를 알려야 하는 비활성 버튼 | 권한 밖·조건 미충족·품절 버튼은 `aria-disabled="true"`(ARIA: 보조기기에 역할·상태를 알리는 웹 표준 속성)로 두고 늘 보이는 이유 글을 `aria-describedby`로 잇는다. 보안 통제가 아니다 | HTML `disabled`는 초점을 못 받아 Tab에서 건너뛰고 툴팁도 뜨지 않는다. 휴대폰에는 마우스 올리기가 없다(중간-101) | — |
| docs/design/d2-design-system.md §4 UX 라이팅 규칙 [보완] | '~합니다'체, 법정 문안은 글자 그대로, 재촉 문구 금지, 동사형 버튼, 오류는 '문제 + 해결', 셔플 공연에 '선착순' 금지, 과금 안심 고지, 자동화된 결정 고지 | 차분하고 믿음을 주는 안내자의 말투다(d1 §3). 섞는 공연에서 '선착순'은 기만적이다 | — |
| docs/design/d2-design-system.md §5 색 대비 검증 | 의미 색 쌍 37개의 라이트·다크 대비 계산표, SEED에서 바꾼 색 | SEED는 APCA(본문 Lc 75) 기준이라 WCAG 2.2 AA와 다르다 | — |
| docs/design/d4-handoff-checklist.md §1 모든 화면 공통 체크리스트 | 26항목마다 통과 기준과 자동 검사(토큰 린트, 접근성 위반을 찾는 axe, Playwright, 부품을 상태별로 띄우는 Storybook). 없으면 '수동' | 사람이 보기 전에 장치가 막게 한다(높음-28). #18~#25는 놓치기 쉬운 WCAG 2.2 AA 기준이다 | — |
| docs/design/d4-handoff-checklist.md §2 화면 유형별 추가 점검 | 대기실·좌석·결제·관제·스캐너·홈·좌석맵 에디터 등 화면군 28개 | 화면마다 법정 고지·개인정보·접근성 요구가 다르다 | — |
| docs/design/d4-handoff-checklist.md §3 핸드오프 산출물 요건 | 시안 링크, 5대 상태 프레임, 토큰 대응표, 모션·접근성 노트, 문구 대조표 | 포트폴리오는 사람 사이 인계가 없어 Storybook·린트·axe·FE-T19 결과로 대신한다 | — |
| docs/design/tokens.json 최상위 그룹(JSON이라 절이 없다) | `color`(primitive·primitive-dark·semantic), `pattern`, `typography`, `space`, `size`, `radius`, `shadow`, `motion`, `breakpoint`, `layout`, `z-index` | SEED 팔레트가 적응형(라이트·다크 값이 다름)이라 다크 원시를 따로 두고, 의미 토큰은 두 모드가 같은 키를 쓴다 | — |
| docs/design/icons/genre/(SVG 10개) | 장르 타일 아이콘의 정본(전체 장르·콘서트·뮤지컬·연극·클래식·팬미팅·페스티벌·굿즈 스토어·공연장·기타) | 홈 장르 아이콘 그림은 피켓이 그린다(CMP-002 tile, ADR-0063) | — |

## 3. 꼭 기억할 규칙과 숫자

| 항목 | 값 | 표시 | 정본 위치 |
| --- | --- | --- | --- |
| 컴포넌트 수 | CMP-001~083, 83개(SEED 순수 활용 16, 커스텀 확장 26, 피켓 전용 41) | 확정, 목록 전체 `[보완]` | d2 §1.1·§2 |
| tokens.json 크기 | 최상위 그룹 11개, 값이 있는 토큰 218개(색 142: 라이트 원시 39, 다크 원시 25, 의미 라이트·다크 39씩) | 이 편이 2026-11-01에 센 값 | tokens.json |
| 대비 기준 | 본문 글자 4.5:1. 포커스 링·입력 테두리·조작 가능한 좌석·SLO(팀이 정한 목표) 표시등 3.0:1. 남이 잡은·팔린·판매 불가 좌석과 비활성 문구는 WCAG 1.4.11 비활성 예외 | 확정 | d2 §5 |
| 피켓이 바꾼 색 | 라이트 성공·경고·위험 문구색 SEED 700(3.96·4.12·3.76:1) → 800(5.73·6.41·5.68:1). 포커스 링 blue-600(2.84:1) → indigo.500(5.11:1). 보조 글자는 `text-muted` gray-800(6.62:1). 흰 글자/`primary`는 라이트 7.90:1, 다크 5.11:1 | 계산값 | d2 §5 |
| 글자·간격·라운드 | 글자 12·14·16·20·24·32·48px, 두께 셋. 간격 4px 눈금과 의미 간격 16·12·20·56·8px(tokens.json에는 between-text 6px도 있다). 라운드 4·8·12·16·24px, 홈 배너 20px(`radius.banner`). 그림자 3단계 | 확정 | d2 §1, tokens.json |
| 모션 | 150·200·300ms, `transform`·`opacity`만. `motion.seat-shake` 300ms, `motion.qr-rotate` 15000ms | 확정 | d2 §1, tokens.json |
| 중단점·재배치 | 480·768·1280·1440px(SEED 값). 360px은 휴대폰 시안 폭이다. 320 CSS px에서 세로로만 스크롤 | 2026-10-28 바뀜 | d2 §1, d4 #17·#18 |
| 최대 폭 | 소비자 웹 1040px, 공연 탐색·좌석맵 1280px, 홈 본문 1240px, 거터 24px, 바깥 여백 32px | 확정 | d2 §1 |
| 누르는 영역 | 모든 조작 24×24px 이상, 휴대폰 주요 버튼 44×44px 이상, 스캐너 주요 버튼 높이 56px·사이 16px | 스캐너 값 `[가정]` | d4 #5 |
| 대기실 번들 | gzip JS 50KB 이하, CSS 10KB 미만 | 목표 `[실측 전]` | d4 §2 |
| 토스트·검증·페이지 | 토스트 5초(마우스를 올리면 멈춤). 비동기 검증 300ms 디바운스 + `AbortController`. 표 25·50·100건, 검색 결과 20개 | 페이지 크기 `[가정]` | d2 §3.1·§3.2·§3.4 |
| 낭독 주기 | 화면 낭독기(글자를 소리로 읽어 주는 프로그램) 알림은 로비 카운트다운 남은 5분·1분·10초, 대기열 1분에 한 번, 홀드 타이머 만료 1분 전 한 번 | 확정 | CMP-014·015, d4 #8 |
| heat 단계 | 남은 좌석 50% 이상 heat.1, 10% 이상 50% 미만 heat.2, 10% 미만 heat.3 | `[가정]`(디자인 시안에서 확정) | CMP-034 |
| 방금 놓은 좌석 | 그 화면에서만 30초 동안 테두리만 그리고 다시 고르지 못하게 한다 | `[가정]` | CMP-021·023 |

## 4. 이 문서가 다루는 ID

CMP는 모두 d2 §2에서 정의한다. 뜻은 d2 §2의 용도 칸을 줄였다.

| ID | 한 줄 |
| --- | --- |
| CMP-001 | Button. 행동을 실행한다. 화면 이동에는 Link를 쓴다 |
| CMP-002 | Link. 다른 주소·화면으로 옮긴다. tile·venue는 홈 장르·공연장 변형이다 |
| CMP-003 | IconButton. 아이콘 하나뿐인 버튼, `aria-label` 필수. 카드 주 행동의 자리다 |
| CMP-004 | TextField. 한 줄 입력. search는 머리 검색창과 자동완성 창(ARIA combobox) |
| CMP-005 | TextArea. 여러 줄 입력(후기, 명령 사유). 길이는 grapheme 단위 |
| CMP-006 | PasswordField. 파트너·운영자 비밀번호. 붙여넣기와 비밀번호 관리자를 허용한다 |
| CMP-007 | OTPField. 인증 앱 코드 6자리. 입력 칸 하나를 여섯 칸 모양으로 그린다 |
| CMP-008 | PhoneField. 휴대폰 번호(숫자만) |
| CMP-009 | ConsentCheckbox. 약관·개인정보 동의. checklist는 운영 화면 확인 항목 |
| CMP-010 | Select / Radio. 하나 고르기. rating은 후기 별점 |
| CMP-011 | Toggle. 켜고 끄는 스위치(알림, 관제 기능 플래그) |
| CMP-012 | FormErrorSummary. 제출 실패 때 오류를 위에 모으고 첫 오류로 초점을 옮긴다 |
| CMP-013 | Stepper. 단계별 입력 화면의 지금 단계(1/4) |
| CMP-014 | Countdown. 오픈·홀드 남은 시간. `setTimeout`과 보정한 벽시계, 503 동안 paused |
| CMP-015 | QueuePanel(QueuePosition). 앞 인원·예상 시간·판매 상태 |
| CMP-016 | ProgressBar. 선형 진행 막대. queue는 대기열 진행도이고 뒤로 물러나지 않는다 |
| CMP-017 | NoticeBanner. 운영 공지(승인된 문구만)·오프라인·긴급 경고 띠 |
| CMP-018 | Toast. 잠깐 보이는 가벼운 결과 알림. 치명적 오류에는 쓰지 않는다 |
| CMP-019 | Dialog(Modal). 확인과 중요한 입력. info·list·form·alert 변형, 겹치지 않는다 |
| CMP-020 | DangerConfirm. 되돌릴 수 없는 작업 직전, 결과를 적은 버튼으로 확인. fan·ops |
| CMP-021 | SeatMap(Canvas). 5만 석 좌석맵. Worker + OffscreenCanvas, 전체 배치 → 확대 |
| CMP-022 | SeatList(접근성 대안). 구역 → 열 → 좌석 ARIA `tree` 목록과 자동 좌석 배정 버튼 |
| CMP-023 | SeatStatusBadge. 좌석 상태를 색 + 무늬 + 글자로 |
| CMP-024 | PriceTierLegend. 등급별 가격 범례. 색·무늬는 상태 전용이라 등급에 쓰지 않는다 |
| CMP-025 | SeatSummary. 고른 좌석, 합계 금액, 남은 매수 한도 |
| CMP-026 | SeatPicker(Compound). Legend·Map·Summary를 묶는 루트, `useSeatSelection` 훅 |
| CMP-027 | PaymentWidgetFrame. 결제사 결제 UI를 감싸는 보안 프레임. toss·portone |
| CMP-028 | TicketCard. 티켓 요약 카드. 받은 티켓에는 '결제자에게 돌려주기'만 |
| CMP-029 | RotatingQR. 기기 안에서 15초마다 바뀌는 회전 QR과 움직이는 둘레·지금 시각 |
| CMP-030 | Tabs. 탭. chip(장르 칩)·anchor(섹션 바로가기) 변형 |
| CMP-031 | DataTable. 표. 논리는 TanStack Table 9(표 논리 라이브러리), 모양은 SEED 토큰, 가상 스크롤 |
| CMP-032 | StatTile. 수치 하나와 SLO(팀이 정한 목표) 기준선·상태(ok·burning·breached) |
| CMP-033 | TimeSeriesChart. 시계열 선·영역·막대 차트. 콘솔은 Canvas 2D(차트 라이브러리 Chart.js 4) |
| CMP-034 | HeatmapGrid. 구역별 남은 좌석 히트맵(heat.1~3) |
| CMP-035 | Widget(Compound). 관제 위젯 루트. 위젯마다 Error Boundary |
| CMP-036 | CommandCard. 운영 명령 하나의 권한 요건·안전 한계·되돌리기 |
| CMP-037 | ApprovalStepper. 사유 → dry-run → 재인증(위험 명령만) → 2인 승인(2인 명령만) → 전파 ack 단계 |
| CMP-038 | DryRunPreview. 명령을 실행하면 생길 영향의 미리 계산 요약 |
| CMP-039 | AuditTimeline. 장애 주입부터 지표 복구까지의 타임라인 재생. scrub 변형 |
| CMP-040 | DeadlineBadge. 법정 처리 기한의 남은 시간(시간·일·영업일, cancel-deadline) |
| CMP-041 | ScanResult. 스캐너 판정(통과·거부·확인 필요)을 화면 절반 이상에 |
| CMP-042 | CameraView. 스캐너 카메라 뷰파인더. 디코딩은 Web Worker |
| CMP-043 | EmptyState. 빈 화면. 이유와 다음 행동 버튼 |
| CMP-044 | Skeleton. 받는 동안 원래 모양을 유지하는 자리 그림 |
| CMP-045 | ErrorState. 오류 원인과 해결 방법, 다시 시도 버튼 |
| CMP-046 | PermissionDenied. 권한 없음과 사유, 로그인·돌아가기 경로 |
| CMP-047 | HumanCheckBox. 사람 확인 챌린지(Cloudflare의 사람 확인 서비스 Turnstile)를 담는 컨테이너 |
| CMP-048 | ReportButton. 후기마다 둔 [신고] 버튼. outbound는 신고기관 바로가기 |
| CMP-049 | ShuffleProofPanel. 셔플 증거(시드 해시, 참가자 목록을 요약한 머클 루트, 공개 난수 drand 값, 결과 파일)와 내 토큰 검증기 |
| CMP-050 | ReorderList(옛 DnDList). 짧은 목록의 순서를 [위로]·[아래로] 버튼으로 바꾼다 |
| CMP-051 | SeatMapEditorCanvas. 파트너 좌석맵 편집 캔버스(MIT 캔버스 라이브러리 Konva, 네 단계 도구 막대) |
| CMP-052 | DeviceSessionList. 로그인된 기기 목록과 기기별 원격 로그아웃 |
| CMP-053 | DeviceApprovalPanel. 스캐너 승인용 일회용 QR과 8자 확인 코드 |
| CMP-054 | RefundQuote. 남은 일수별 공제율·법적 근거·환급 예상액 |
| CMP-055 | AccountLinkPrompt. 같은 검증 이메일 계정이 하나면 연결할지 고르게 한다 |
| CMP-056 | MergeSummary. 계정 병합 전 옮겨지는 자산과 되돌릴 수 없다는 요약 |
| CMP-057 | AutoAssignPanel. 자동 배정 공연의 희망 조건 입력과 배정 결과 |
| CMP-058 | SellerNotice. 판매자 신원정보 7항목과 통신판매중개자 고지 |
| CMP-059 | TransferOfferCard. 양도 요청의 수락·거절·철회 |
| CMP-060 | ApprovalPanel. 승인 업무·회차 취소·판매 승인·지급·부정 예매 조치의 승인·반려 |
| CMP-061 | BulkRefundProgress. 일괄 환불 진행률과 결제사별 상태 |
| CMP-062 | BankAccountForm. 환불·배상·정산 계좌 입력(저장하지 않는다) |
| CMP-063 | AppealForm. 예매 제한·양도 회수·부정 예매 소명 입력 |
| CMP-064 | ReauthPrompt. 되돌리기 어려운 작업 전 재인증(팬은 소셜, 관리 계정은 비밀번호 + TOTP(인증 앱 코드), 5분) |
| CMP-065 | AppShell. 앱마다 머리·내비·바닥글·상태 띠를 그리는 셸. 어디서나 로그아웃 |
| CMP-066 | RoundPicker. 같은 공연의 회차 고르기와 판매 상태 배지 |
| CMP-067 | AddressForm. 굿즈 택배 배송지 입력 |
| CMP-068 | NotifyPermissionSheet. 웹 푸시 권한을 묻기 전에 이유를 설명하는 시트 |
| CMP-069 | MediaUploader. 파트너의 포스터·상세 이미지 올리기와 순서 바꾸기 |
| CMP-070 | RichTextEditor. 공연 설명 서식 글. 허용 노드만 담은 구조 문서로 저장한다 |
| CMP-071 | Carousel. 홈 배너 슬라이드(자동, [일시정지])와 가로 카드 줄 |
| CMP-072 | ProductionCard. 공연(회차 묶음) 카드. 옛 이름 EventCard |
| CMP-073 | ReviewCard. 관람 후기 하나와 사진 썸네일 줄 |
| CMP-074 | ProductCard. 굿즈·티켓 연동 부가 상품 카드와 장바구니 아이콘 버튼 |
| CMP-075 | ReportDialog. 후기 신고 모달과 신고 확인 모달(자리를 바꿔 연다) |
| CMP-076 | ImageUploader. 팬의 후기 사진 올리기(최대 3장 `[가정]`) |
| CMP-077 | SeatFillPanel. 좌석맵 에디터의 좌석 채우기 패널과 도형 손잡이 |
| CMP-078 | TemplatePicker. 좌석 템플릿 10종 고르기. 실제 공연장 배치도가 아니다 |
| CMP-079 | ScatterBrush. 점 수십만 개 산포도와 끌어 고르기(GPU로 그리는 WebGL2) |
| CMP-080 | LinkGraph. 부정 예매 사건의 계정·공유 속성 연결 그래프 |
| CMP-081 | CaseStatusBadge. 사건 상태·소명 결과·점수 범주를 글자와 색으로 |
| CMP-082 | ReplaySourceBadge. 포렌식 리플레이가 연 데이터 원천(조사·연구·합성) |
| CMP-083 | StepBaselineChart. 조사 원천의 단계별 걸린 시간 점과 기준선 띠 |
| NFR-012 | 사용자 체감. INP(조작 반응) 200ms·LCP(가장 큰 요소가 그려지는 시간) 2.5초 이하, CLS(화면 밀림) 0.1 이하 `[실측 전]` |
| NFR-019 | 지원 플랫폼·브라우저. 새 기술은 미지원 환경에서도 핵심 기능이 남게 한다 |
| NFR-020 | 접근성. WCAG 2.2 AA 위반 0건, axe 위반 0건, 본문 대비 4.5:1, 색만으로 구별 금지 |
| NFR-024 | 국제화. ko·en·ja·zh 4개 언어, 공연장 현지 시각과 단말 시각을 함께 |
| POL-004 | 정렬 방식 고지와 표현. 상세·대기실·결제 직전에 같은 표준 문구 |
| POL-006 | 추가 검증 큐(자동화된 결정). 순번을 바꾸지 않고 떼어 내며 설명 요청 권리를 알린다 |
| POL-013 | 결제 규칙. 2단계 승인 PG만 쓰고, 승인 전에 끝난 실패는 과금이 없다(안심 고지의 근거) |
| POL-024 | 암표 방지 법정 조치. 부정구매·부정판매 고지와 신고 기능 |
| POL-033 | 회원 탈퇴와 재가입. 탈퇴를 가입보다 어렵게 만들지 않는다 |
| POL-037 | 판매 구조와 법적 지위. 피켓은 통신판매중개자이고 판매자 정보를 고지한다 |

## 5. 결정과 버린 길

옛 판은 ADR 상태 줄과 docs/architecture.md §11에서 옮겼다. 자리표([결정 카드 목록](../decisions/README.md) §2)가 이 편에 둔 ADR은 ADR-0040 하나다. 나머지는 다른 편이나 결정 카드가 자리이고, 여기서는 디자인 시스템에 닿는 부분만 적는다.

**[ADR-0040](../../adr/0040-design-system-base-seed.md) SEED Design 토대와 피켓 브랜드(이 편의 자리)**
- 고른 것: `@seed-design/css` 토큰과 `@seed-design/react` 부품이 토대다. 브랜드 역할 다섯(`fg.brand` 등)은 carrot 대신 인디고로 덮어쓴다. 대비 미달 색은 한 단계 진하게 바꾼다. 타이포·간격·라운드·그림자·모션은 SEED를 잇는다. 도메인 부품은 SEED 토큰으로 직접 만든다. Apache-2.0 제4조대로 라이선스 사본과 NOTICE 고지를 싣고(wbs 0.6.2), 당근과의 제휴로 읽히게 쓰지 않는다.
- 버린 길: NOL(야놀자 티켓) 화면에서 토큰 추출(약관 제15호·제20호와 추출 도구의 이용 정책에 어긋나고 지식재산권 분쟁 위험이 크다), 관찰만으로 피켓 값 정하기(합법이지만 값이 모두 추정이라 근거가 약하다), 밑바닥부터 개발(부품 100여 종과 접근성 조작에 공수가 크다), Bezier·Montage(업무 메신저·채용 서비스 중심이라 티켓 소비자 흐름과 거리가 있다), SEED 색 그대로 두고 기준을 APCA로 바꾸기(NFR-020이 WCAG 2.2 AA라 요구사항을 고쳐야 하고, 색 몇 개를 진하게 바꾸는 쪽이 변경이 작다), carrot을 브랜드 색으로(당근 제품처럼 보이고 NOTICE의 '오인하게 하는 사용'에 가깝다).
- 옛 판: 결정 5의 중단점 360/768/1024/1440은 2026-10-28에 SEED 값 480/768/1280/1440으로 바뀌었다(상태 줄, 중간-096). 2026-10-26에 `radius.banner` 20px와 홈 본문 1240px가 더해졌다. 홈은 NOL의 섹션 구성을 따르되 로고·이미지·문구·색은 쓰지 않는다(ADR-0063 결정 1). 맥락의 'Ticketmaster를 본뜨되'는 그때 요청의 말이고, 지금은 참고 사례로만 적는다.
- 되돌릴 조건: SEED가 라이선스를 바꾸거나 1년 넘게 갱신이 멈추면 토큰 값을 복사한 채 부품만 바꾼다. 시안에서 SEED 부품의 axe 위반이 되풀이되면 그 부품만 피켓 구현으로 바꾼다.

**[ADR-0111](../../adr/0111-csp-style-src-attr-for-server-rendered-seed-style-props.md) 서버가 그린 SEED 스타일 속성과 CSP(자리: [결정 카드 D-34](../decisions/D34-styling-forms-test-tools.md))**
- 고른 것: 기본안 (가). 화면 묶음 A·B(E·F 포함)에 `style-src-attr 'unsafe-inline'`만 더한다. `style-src`는 그대로라 `<style>` 요소와 스크립트 규칙은 바뀌지 않는다. 스타일 속성 값은 토큰 이름과 코드 상수만 쓴다. PoC FE-T30으로 확정한다.
- 버린 길: (나) 서버 부품은 클래스만(거의 모든 화면에서 SEED 스타일 속성을 못 쓰고 `next/image` 속성은 린트로 못 잡는다. 바꿀 조건이 오면 이쪽이다), 해시로 허용(조합을 셀 수 없고 CSP 상한 1,783자에 걸린다), `style-src`에 `'unsafe-inline'`(`<style>` 주입까지 열린다), 서버에서 그리지 않기(LCP와 검색 노출이 나빠진다), 하이드레이션(서버 HTML에 브라우저가 동작을 붙이는 단계) 뒤 스크립트로 넣기(화면이 밀린다).
- 옛 판: 본문이 지금 판이다. FE-T30 결과는 아직 없다.

**[ADR-0132](../../adr/0132-tech-review-medium-doc-fixes-frontend-planning-guide.md) 중간-096~099·101·[ADR-0135](../../adr/0135-tech-review-low-doc-fixes-gate-accounts-settlement-frontend.md) 낮음-098·100·101·106·107(자리: 분야 편 23)**
- 고른 것: 중단점은 SEED 값(검토 (가)안), SEED CSS는 recipe 층 판과 층 순서 한 줄, 빠른 입력 허용, SeatList는 ARIA `tree`, 인증 앱 코드는 칸 하나, 토큰은 문자열 표기·점 없는 이름, 이유 있는 비활성은 `aria-disabled`(0132). 끌어 놓기 라이브러리 없이 버튼만, 시각 회귀는 Playwright 하나, 표 논리는 TanStack Table, 카운트다운은 `setTimeout`, QR은 겹치는 전환 없이 바꾸기, 표·트리에 전체 개수·위치 ARIA(0135).
- 버린 길: 두 ADR에는 검토한 대안 표가 없고, 바꾼 까닭은 항목의 '문제' 칸이다. 이름은 같고 값이 다른 중단점, 예산을 넘는 전체 CSS, ARIA에 맞지 않는 중첩 `listbox`, 붙여넣기를 깨는 여섯 칸, 키보드·휴대폰에서 전해지지 않는 툴팁, 1초 표시에 배터리를 더 쓰는 `requestAnimationFrame`, 겹치는 동안 읽히지 않는 QR, 2025-02 뒤로 새 판이 없던 `@hello-pangea/dnd`다.
- 옛 판: 본문이 지금 판이다. Next.js(웹·파트너 화면의 React 프레임워크) 앱이 층 판을 고르는지는 FE-T36 전이다.

**[ADR-0063](../../adr/0063-screen-redesign-owner-feedback.md)·[ADR-0066](../../adr/0066-screen-feedback-12-items.md) 화면 개편과 부품 추가(자리: [분야 편 4](04-screens-and-flows.md))**
- 고른 것: CMP-071~073과 Dialog의 info·list·form, 좌석맵 전체 → 확대(0063). CMP-074~078, 카드 주 행동은 아이콘 버튼, 신고 모달은 자리를 바꿔 열기, 템플릿 10종(0066).
- 버린 길: 홈을 일반 패턴 참고로만(약관 위험은 가장 낮지만 소유자가 NOL 구성을 골랐다), 좌석맵을 배경 이미지와 클릭 영역으로(좌석 좌표가 없으면 확대·구역별 구독을 못 한다), 신고 확인을 겹친 모달로(초점 가둠이 둘이 된다), 실제 공연장 배치도 템플릿(허락이 필요하고 베끼면 저작권 문제가 생긴다).

**그 밖에 닿는 ADR(한 줄씩)**
- [ADR-0089](../../adr/0089-leftover-values-senior-engineer-decisions.md) 결정 10(자리: 분야 편 23): heat는 파랑 한 색의 명도 3단계다. 등급마다 다른 색은 상태색과 겹치기 쉽고 등급에 가격 순서가 있어 버렸다.
- [ADR-0062](../../adr/0062-open-items-delegated-decisions.md) 결정 1·46(자리: [분야 편 4](04-screens-and-flows.md)): 네이버는 흰 바탕 세트, 레이블은 세 제공자 14px/20px·500이다. 녹색 세트는 대비 3.09:1로 NFR-020에 어긋나 버렸다.
- [ADR-0019](../../adr/0019-reject-aphrodite-fela.md)·[ADR-0020](../../adr/0020-forms-rhf-zod-over-formik.md)(자리: [결정 카드 D-34](../decisions/D34-styling-forms-test-tools.md)): 실행 중에 스타일을 만드는 CSS-in-JS를 쓰지 않고(서버 컴포넌트와 맞지 않고 Tailwind와 역할이 겹친다), 폼은 Formik + Yup 대신 RHF + Zod다.
- [ADR-0165](../../adr/0165-four-repositories-monorepo-gitops-shared-workflows-private-loadtest.md)(자리: [결정 카드 D-31](../decisions/D31-one-monorepo.md)): `@peaket/ds`는 모노레포 안에 두고 게시하지 않는다.
- [ADR-0171](../../adr/0171-post-sale-forensics-in-launch-scope.md)(자리: [분야 편 17](17-analytics-forensics.md)): CMP-080~083, CMP-060 fraud-action, CMP-063 fraud 변형을 더했다.

## 6. 읽는 요령

- **읽는 순서**: d2 머리말 → §1 → §1.1 → §5 → §3 → §4 → d4 §1 → d4 §3. d2 §2와 d4 §2는 부품·화면을 찾을 때 읽는다.
- **찾는 법**: 부품은 d2 §2에서 ID로 찾고 '사용 화면' 열로 쓰는 화면을 본다. 화면마다의 부품은 docs/design/d3-screens.md에서, 토큰 값은 tokens.json에서, 대비는 d2 §5 표에서 본다.
- **새 부품을 더할 때**: CMP 번호를 받고, 모든 상태와 변형을 담은 Storybook 스토리를 올리고, `addon-a11y` 검사를 통과해야 한다(d4 #13).
- **'SEED 순수 활용'의 뜻**: 대응표는 목표 구조다. 지금 `@peaket/ds`는 화면 퍼블리싱(PUB-010)에서 디자인 캔버스 키트 마크업을 내는 부품으로 만들었고, 속을 `@seed-design/react`로 바꾸는 일은 남았다(docs/BUILD_ORDER.md BAS-180).
- **토큰 형식 함정**: 'DTCG 형식'이지만 2025.10 판의 객체 값이 아니라 이전 초안의 문자열 값이다. 좌석 무늬는 토큰이 아니라 `pattern` 그룹의 `$extensions`에 있다.
- **계산과 실제 화면**: d2 §5는 토큰 쌍의 계산값이다. 화면 위 실제 조합의 3:1 대비(1.4.11)는 axe가 보지 않아 수동이다(d4 #4).
- **비슷한 말**: DangerConfirm(결과를 적은 확인)과 ReauthPrompt(다시 인증)는 역할이 다르다. Toast는 잠깐, NoticeBanner는 계속 보인다. MediaUploader는 파트너용, ImageUploader는 팬용이다. recently-released는 그 화면에서만 쓰는 모양이고 좌석의 실제 상태가 아니다.
- **`[보완]`**: d2 카탈로그와 d4 점검 세부는 전체가 `[보완]`이다. 원문에 빠져 있던 것을 채웠다는 표시다.

## 7. 경계

| 이 정본이 정하지 않는 것 | 정하는 곳 |
| --- | --- |
| 서비스명·인디고 브랜드·로고, 참고 사례 규칙, 배치 원칙(밀도·열), 모션 원칙 | docs/design/d1-brief.md, [분야 편 4](04-screens-and-flows.md) |
| 화면마다 부품 배치와 상태, 와이어프레임 | docs/design/d3-screens.md, docs/design/d5-screen-blueprint.md, docs/planning/04-ia-flows-screens.md, [분야 편 4](04-screens-and-flows.md) |
| 번들 예산, CSP 묶음 문자열, Worker 그리기, FE-T 시험의 절차 | docs/frontend.md, [분야 편 6](06-frontend.md) |
| 법정 고지 문안(POL-004·024·037)과 용어 사전 | docs/planning/03-policies-glossary.md, [분야 편 3](03-policies-glossary.md) |
| 좌석 상태의 뜻과 전이 | docs/features/seat-hold.md §2, [분야 편 10](10-seat-hold.md) |
| 화면 보안 요구사항 추적(ASVS) | docs/security/asvs/frontend.md, [분야 편 21](21-security.md) |
| 토큰 파이프라인·`@peaket/ds`의 진행 상태 | docs/BUILD_ORDER.md(PUB-010, BAS-170·180), docs/wbs/wbs.md 0.6.1·0.6.2, [분야 편 23](23-plans-progress-reviews.md) |

## 8. 꼬리 질문

| 질문 | 답의 요지 | 근거 |
| --- | --- | --- |
| 왜 디자인 시스템을 직접 만들지 않았나요? | 부품 100여 종과 접근성 조작을 처음부터 만드는 공수가 크다. SEED는 모바일 우선 한국어 소비자 제품이고 출처와 라이선스를 댈 수 있다. NOL 토큰 추출은 약관 위반이라 하지 않았다 | ADR-0040 |
| SEED 색을 그대로 쓰면 안 되나요? | SEED는 APCA 기준이라 라이트 성공·경고·위험 700 단계가 3.96·4.12·3.76:1로 4.5:1에 못 미친다. 800 단계로, 포커스 링은 indigo.500(5.11:1)으로 바꿨다. 기준을 APCA로 바꾸면 NFR-020을 고쳐야 한다 | d2 §5, ADR-0040 결정 3 |
| 좌석맵은 왜 CSS 변수가 아니라 TS 상수를 쓰나요? | Canvas는 CSS 변수를 직접 읽지 못한다. 그래서 빌드가 같은 tokens.json에서 TS 상수를 만들고, 좌석 무늬도 `pattern.seat.*` 상수로 만든다 | d2 §1 |
| 색을 못 가리는 사람은 좌석 상태를 어떻게 아나요? | 색 + 무늬 + 글자를 함께 쓴다. 화면 낭독기 사용자는 SeatList(ARIA `tree`)로 탐색부터 홀드까지 혼자 끝낸다. 팔린 좌석 같은 비활성 요소는 1.4.11 예외지만 무늬는 의무다 | d2 §1·§5, CMP-021~023, d4 §2 |
| 비활성 버튼에 툴팁으로 이유를 붙이면 되지 않나요? | `disabled`는 초점을 받지 못해 Tab에서 건너뛰고 툴팁도 안 뜨며, 휴대폰에는 마우스 올리기가 없다. `aria-disabled`로 초점을 받게 하고 이유는 늘 보이는 글로 잇는다. 이것은 화면 장치이고 권한은 서버가 다시 본다 | d2 §3.6, d4 #26 |
| 서버가 그린 SEED 부품이 CSP에 막히면요? | `style` 속성만 받는 `style-src-attr 'unsafe-inline'`을 더하고, `<style>` 요소와 스크립트 규칙은 그대로 둔다. React가 CSS 문법을 거르지 않으므로 값은 토큰과 코드 상수만 넣는다. FE-T30이 실패하면 서버 부품은 클래스만 쓴다 | ADR-0111, d2 §1 |
| 토큰을 바꾸면 화면이 깨졌는지 어떻게 아나요? | 토큰을 바꾼 PR은 판을 고정한 Playwright 컨테이너에서 Storybook 스토리를 찍어 기준 이미지와 견준다. 대비는 토큰 CI(PR마다 도는 자동 검사)가 다시 계산한다. 유료 서비스는 측정 예산 5만 원 상한 때문에 쓰지 않는다 | d2 §1, d4 #3·#14 |
| 실제로 만들었나요? | PUB-010에서 `@peaket/ds`(tokens.json 토큰 빌드와 차이 검사 `tokens:check`, 캔버스 키트 CSS, 키트 마크업 부품, 셸 넷)와 69개 화면을 목업 데이터로 그렸다. SEED 연결, Storybook, NOTICE, 대비 CI, DTCG 검사, 시각 회귀는 남았고 시험 결과는 없다 | docs/BUILD_ORDER.md PUB-010·BAS-170·BAS-180 |

## 9. 확인 문제

1. tokens.json에서 좌석 무늬는 왜 토큰이 아니라 확장 칸에 있고, 화면에서는 어떻게 쓰이나?

<details><summary>답</summary>

DTCG 명세는 모든 토큰이 정해진 형식을 쓰게 하는데, 무늬(글자 값)에는 형식이 없다. 그래서 `pattern` 그룹의 `$extensions`(`com.peaket.pattern`)에 두고(기술 검토 중간-099), 빌드가 TS 상수 `pattern.seat.*`로 만든다. Canvas 좌석맵(CMP-021)과 SeatStatusBadge(CMP-023)가 이 상수를 색 토큰과 함께 쓴다.

</details>

2. SEED 기본값에서 피켓이 일부러 바꾼 색을 셋 들고, 왜 바꿨는지 숫자로 말하라.

<details><summary>답</summary>

라이트의 성공·경고·위험 문구색은 SEED 700이 흰 바탕에서 3.96·4.12·3.76:1로 4.5:1에 못 미쳐 800(5.73·6.41·5.68:1)으로 바꿨다. 포커스 링은 blue-600이 2.84:1로 3.0:1에 못 미쳐 indigo.500(5.11:1)으로 바꿨다. 보조 글자는 gray-700(3.42:1) 대신 gray-800(6.62:1)이다. 브랜드 주조색은 carrot 대신 딥 인디고다(d2 §5).

</details>

3. CSS 층 순서 한 줄을 적고, 같은 요소에 SEED 부품 클래스와 Tailwind 유틸이 겹치면 누가 이기는지 말하라. Next.js 앱에서 층 판을 고르지 못하면 어떻게 하나?

<details><summary>답</summary>

`@layer theme, base, seed-base, seed-components, components, utilities;`다. 뒤 층이 이겨 Tailwind 유틸이 이긴다. 선언은 처음 싣는 CSS 맨 앞에 둔다. Next.js 번들러 Turbopack이 `seed-layered` 조건을 고르지 못하면 SEED 부품 CSS가 층 밖에 실려 유틸을 이긴다. 그때는 SEED 부품 요소에 유틸을 겹치지 않고 SEED 부품 속성으로만 모양을 바꾸며, 린트가 막는다. PoC는 FE-T36이다(d2 §1).

</details>

4. 대기열 화면(SCR-008)의 진행 막대에 d4가 요구하는 것 셋을 들라.

<details><summary>답</summary>

막대는 0~100% 안에 있고 처음 앞 인원이 0이면 100%다. 더 오래된 대기 상태 파일은 버려 막대가 물러나지 않는다(serving이 10초 `[가정]` 넘게 되돌아간 장애 조치만 예외). 새로고침해도 처음 앞 인원이 세션 저장소에 남는다. 모션 축소·저전력에서는 값만 바뀌고 `aria-valuetext`는 "앞에 N명, 약 M분 남음"이다(d4 §2, CMP-016).

</details>

## 10. 정본에서 찾은 어긋남

| 어긋난 곳 | 내용 | 지금 읽는 법 |
| --- | --- | --- |
| d2 CMP-074 접근성 칸, docs/design/d5-screen-blueprint.md §5.15 ↔ d2 §3.6·CMP-003, docs/frontend.md §5.11 | CMP-074와 d5 §5.15가 품절 장바구니 버튼을 `disabled`로 두어 §3.6의 `aria-disabled="true"` 규칙과 달랐다. 고침(2026-11-01 정합 점검) | 모두 `aria-disabled="true"`(초점은 받고 동작만 막는다)와 `aria-describedby`로 적는다 |
| d2 CMP-048 reported 상태 | [신고함] 버튼이 `disabled`라 §3.6의 까닭과 맞지 않았다. 고침(2026-11-01 정합 점검) | `aria-disabled="true"`와 `aria-describedby`로 적는다 |
| d4 §1 #12 | '결과 불명·자동 취소 안내에는 쓰지 않는다'의 '자동 취소'가 ADR-0106 뒤에도 남아 있었다. 고침(2026-11-01 정합 점검) | '결과 불명과 발권 불가 결제 취소(환불) 안내'로 적는다. d2 §4가 정본이다 |
| d4 §2 좌석 선택(SCR-010) | '좌석의 6대 상태'라고 적어 2026-10-30에 더한 recently-released(무늬 outline)가 빠져 있었다. 고침(2026-11-01 정합 점검) | '좌석의 일곱 가지 표시'(d2 CMP-023)로 적는다 |
