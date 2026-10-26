# ADR-0057: 100만 검증은 규칙 검사, 부품별 측정, 표시한 외삽으로 하고 운영·스테이징 인프라는 설계로만 둔다

- **상태**: 채택 (2026-10-13. 소유자 결정 '인프라는 구조상으로만 둘거고(비용문제로 인해) 데모같은경우는 비용을 최소화해서 보여줄거에요'와, 트래픽을 감당한다·설계가 옳다를 어떻게 증명하느냐는 질문에 드린 검증 방법 제안의 '승인'. 00-summary §7 질문 24(상시 데모)를 닫는다. 명세 도구(Quint 우선), 검사 범위, 대체 장애 대응표, 외삽 판정 기준, 선택 보정의 규모는 추천 적용(2026-10-13)이다. ADR-0031 결정 1의 스테이징·데모와 ADR-0054의 스테이징 측정 캠페인·상시 데모를 보완하고, 성능 장부의 '2차 다항식 외삽'을 대체한다. ADR-0012의 Phase 6 정렬 방식 비교 규모를 로컬 10만 명으로 바꾼다. ADR-0058(2026-10-13)이 R-58(CloudFront 배포 한도)을 고친다.) 2026-10-21(ADR-0080): 포렌식 리플레이 1단계 데모는 서버 없는 정적 파일이라 운영 비용이 없지만 늘 열린 주소가 되므로, 공개 위치는 출시 준비 때 소유자가 정한다. 정하지 못하면 이 ADR의 녹화 영상·재현 스크립트 방식으로 보인다. 2026-10-22(ADR-0082): 포트폴리오 실행(로컬·CI·데모)에는 서비스 메시를 두지 않는다. 메시 아래 동작은 재지 않고(docs/verification.md §8) 메시 비교 PoC는 선택이다. 2026-10-26(4차 점검 3부): 결정 8의 문제 대장 기준은 설계 피크가 한도의 80% [가정, 0.5.5에서 확정]를 넘을 때로 읽는다(docs/verification.md §4). 결과의 면접 문장은 셔플 결과 조회를 더한 '대기 인원에 비례하는 세 곳'으로 읽는다. 오픈 순간 진입은 진입 서버 처리량 곡선(USL)으로, 대기 상태 조회는 원 서버 응답의 설계 식 대조로 외삽하고, CDN 자체와 셔플 결과 조회는 공개 한도와 대조한 문서 인용으로 보인다(docs/verification.md §1.1·§3.1, ADR-0058).
- **관련**: ADR-0002(순번 카운터), ADR-0014(Soft Hold·Hard Sale), ADR-0015·0044(결제 승인과 결제사 선택), ADR-0031(환경), ADR-0036(외부 한도 추정), ADR-0041(묶음 셔플), ADR-0049(Game Day), ADR-0051(입장 중 소유권 동결), ADR-0054(배포·변경 동결), ADR-0056(리더 펜싱), docs/verification.md, docs/perf-ledger.md §4·§6·§7, docs/infra.md §3·§11, docs/devops.md §5·§11·§15, docs/architecture.md §9, wbs 0.9·6.1
- **관련 ID**: NFR-001, NFR-002, NFR-007, NFR-013, NFR-015, NFR-023, NFR-025, POL-026, POL-027

## 맥락

- **100만 실측은 지출 상한과 처음부터 맞지 않았다.** NFR-013과 wbs 6.1.1은 100만 명 엔드투엔드 실측을 1~2회 하기로 했다. 그런데 100만 명 온세일 70분의 대기 상태 조회만 약 2.2억 건이고(planning/01 §5.2), CloudFront 한국 요청 단가(1만 건당 0.009달러, 2026-10-13 가격표 확인)로 약 198달러(1,400원/달러 가정 시 약 27.7만 원)다. 웹 방화벽 요청 요금과 부하 발생기를 더하면 더 크다. 소유자 지출 상한은 총 5만 원이다(2026-10-10).
- **운영·스테이징을 띄우지 않기로 했다.** 소유자는 2026-10-13 인프라를 설계로만 두고 데모 비용을 최소화하기로 했다. 그러면 문서가 '스테이징에서', 'AWS FIS로', '상시 데모에서' 한다고 적은 시험·훈련·시연에 실행할 곳이 없다.
- **'100만을 버틴다'는 두 주장이다.** 규칙이 맞는가(차례 전 입장 0, 오버셀 0, 이중 결제 0)는 사람 수와 상관없다. 양을 버티는가는 대기 인원에 비례하는 부하만 규모 문제다. §9.1 산정에서 대기 인원에 비례하는 부하는 오픈 순간 진입(피크 20만 RPS)과 CDN 대기 상태 조회(초당 약 5.3만 건) 둘이다. 예매 계층(입장 초당 약 28명, 홀드 피크 초당 1~2천 건, 결제 피크 300 TPS, 좌석 연결 5,000개)은 입장 속도가 정한다(docs/architecture.md §9.1).
- **규칙 버그는 부하 시험으로 잘 나오지 않는다.** 타이밍이 맞아야 드러나는 버그(예: Lease 확인 뒤 멈춘 옛 리더의 쓰기, ADR-0056)는 서버 2대로도 생기지만 100만 명 부하에서도 드물게 나온다. AWS는 7개 팀이 10개 시스템에 TLA+를 썼고, DynamoDB의 데이터 유실 버그처럼 설계 리뷰·코드 리뷰·테스트를 통과한 버그를 찾았다고 보고했다. 그 버그의 가장 짧은 재현은 35단계였다(Newcombe 외, CACM 58(4), 2015). 작게 돌려도 되는 근거는 '작은 범위 가설'이다. Jackson·Vaziri(ISSTA 2000)는 많은 버그가 작은 범위에서 드러난다고 썼다. 증명이 아니라 경험칙이다.
- **외삽 방법이 근거가 없었다.** 성능 장부 §7은 100만 값을 'local-100k 곡선으로부터의 2차 다항식 외삽'으로 구한다고 적었다. 물리적 근거가 없는 곡선 맞추기는 잰 범위 밖에서 엉뚱하게 휜다. USL을 만든 Gunther도 측정 범위 밖은 예측하지 못한다며 '수정구슬이 아니다'라고 쓴다.
- **외부 한도를 대조하다 빈틈이 나왔다.** CloudFront 배포 하나의 기본 한도(초당 요청 25만 건, 전송 150 Gbps, 둘 다 상향 요청 가능)가 문서 어디에도 없고, 설계 피크(공연 페이지 30만 RPS, 오픈 직후 진입·셔플 결과 조회·대기 상태 조회의 합)가 이를 넘는다(review R-58).

## 검토한 대안

| 대안 | 문제 |
| --- | --- |
| 1. 계획대로 100만 실측 1~2회 | 요청 요금만 지출 상한의 몇 배이고, 인프라를 설계로만 두기로 한 결정과 맞지 않는다 |
| 2. 목표를 20만 명으로 낮춰 다시 쓰기 | 100만은 산정과 구조로 정한 설계 목표다. 낮추면 '대기 인원이 늘어도 예매 계층 부하는 그대로'라는 설계의 핵심을 보일 기회가 사라진다. 잰 규모를 정직하게 표시하면 된다 |
| 3. 수학 모델(시뮬레이션)만 | 실제 코드·Redis·Lua·PostgreSQL의 성능과 규칙 구현을 재지 않는다 |
| 4. 클라우드 무료 크레딧으로 전체 실측 | 크레딧 자격과 기간을 알 수 없고(소유자 계정 미확인), 초과 과금 위험이 상한 밖에 있다 |
| **5. 규칙 검사 + 부하 분해와 부품별 측정 + 설계 식·USL 외삽 + 표시 규칙(채택)** | 100만 명이 한꺼번에 돌 때만 생기는 상호작용은 증명하지 못한다(남는 한계로 기록) |

## 결정

1. **증명을 둘로 나눈다.** 설계 정확성(규칙)과 처리 용량(양)을 따로 증명하고 따로 표시한다(docs/verification.md §1).
2. **규칙 모델 검사.** 핵심 규칙 다섯 가지를 실행 가능한 명세로 쓰고 작은 범위에서 일어날 수 있는 모든 순서를 검사한다. 명세는 Quint(Apache-2.0)로 먼저 쓰고, 막히면 같은 대상을 TLA+로 옮긴다. 모델 검사는 TLC 또는 Apalache다. 대상은 ① 대기 순번과 Redis 장애 전환 때 세대 번호(ADR-0002·0041), ② 입장 제어 리더 교체·세대 확인과 1인 1순번 재확인(ADR-0056), ③ 좌석 홀드에서 판매 확정까지(ADR-0014), ④ 결제 흐름과 결제 시도 고정(ADR-0015·0044), ⑤ 입장 중 소유권 동결(ADR-0051)이다. 불변식과 범위는 docs/verification.md §2다. 결과는 범위(사람·좌석·서버·장애 횟수)와 탐색한 상태 수를 붙여 '검사한 범위 안에서 위반 없음'으로만 적는다.
3. **모델 기반 시험.** 실제 Lua·SQL·결제 코드에 명세와 같은 이름의 동작을 무작위 순서로 넣고 단순한 참조 모델과 결과를 비교한다(fast-check `fc.commands`, 비동기 응답 순서는 `fc.scheduler`). 실패하면 가장 짧은 재현 순서로 줄여 회귀 시험으로 남긴다. 모델과 코드 사이의 틈을 이 시험이 메운다.
4. **장애 주입과 기록 검사.** 로컬에서 Redis·PostgreSQL·결제 시뮬레이터 사이 연결에 지연·끊김을 넣고(Toxiproxy, 제어 API는 루프백에만 묶음), 모든 요청과 응답을 기록한 뒤 불변식 SQL(wbs 1.2.3)로 위반을 찾는다(Jepsen 방식). 판정 항목은 차례 전 입장, 같은 세대 순번 중복, 오버셀, 1인 한도 초과, 이중 결제, 정리되지 않은 결제-발권 불일치다.
5. **부하 분해.** 100만 부하를 대기 인원과의 관계로 나눈다. 대기 인원과 무관한 부하는 PC에서 실제 크기로 잰다. 비례하는 부하 중 진입은 Redis 단독 실측과 진입 서버 확장 곡선으로, CDN 조회는 원 서버 보호(같은 파일 요청 묶기)를 로컬 캐시로 실측하고 CDN 자체의 동작은 문서 인용으로 둔다(docs/verification.md §3).
6. **외삽 규칙.** 다항식 맞추기를 쓰지 않는다. 설계가 예측하는 식(원 서버 요청 = 활성 파일 수 ÷ 캐시 수명 등)이 1천·1만·10만 명 실측과 맞는지 보고, 맞으면 그 식으로 100만 값을 계산한다. 처리량 확장은 6점 이상의 측정에 USL을 맞춘다. 외삽 값에는 근거 실행, 식과 계수, 측정 범위, 외삽 배수(목표 ÷ 측정 최대치)를 붙인다(docs/perf-ledger.md §7).
7. **측정 정직성.** 요청은 정해진 도착률로 보낸다(k6 도착률 실행기). 부하 발생기가 시작하지 못한 반복(`dropped_iterations`)이 하나라도 있으면 그 측정은 무효다. 발생기 CPU는 80% 이하로 두고 결과는 3회 중앙값과 편차로 적는다. 같은 PC에서 발생기와 대상을 함께 돌리면 CPU를 나눠 쓰고 반복 사이 편차를 함께 적는다.
8. **외부 한도 대조표.** 경로 위 외부 서비스의 공개 한도와 추정 한도를 설계 피크와 한 표로 대조한다(docs/verification.md §4). 피크가 한도에 닿거나 넘으면 문제 대장에 올린다(R-58).
9. **표시 규칙.** 숫자는 실측(PC), 실측(클라우드), 외삽, 문서 인용, 설계 목표, 하한선 중 하나로 표시한다(docs/perf-ledger.md §7, planning/02 §3.1 원칙 5). 면접 답변과 블로그에도 같은 규칙을 쓴다.
10. **인프라는 설계로만 둔다.** 운영·스테이징은 Terraform·매니페스트 코드와 정적 검사까지 만들고 띄우지 않는다. 문서가 '스테이징에서' 한다고 적은 시험·훈련은 포트폴리오 기간에 로컬 측정 환경(kind, 성능 장부 `local-*` 프로파일)에서 하고, 관리형 서비스 장애 주입(AWS FIS 등)은 대체 장애로 바꾼다(docs/verification.md §5). 관리형 서비스의 장애 조치 시간과 노드 기동 시간은 문서 인용으로 둔다.
11. **선택 클라우드 보정.** 하지 않아도 이 전략은 성립한다. 한다면 두 가지만 한다. ① 환산 계수 1회: PC에서 잰 진입 서버 1대 처리량이 클라우드 서버로 얼마인지 잰다(예: 서울 리전 c7g.xlarge 8대 3시간이면 온디맨드 가격표 기준 약 4달러). ② CloudFront 무료 범위(월 요청 1,000만 건, 전송 1 TB) 안에서 같은 파일 요청 묶기를 확인한다. 시작 전에 예산 경보와 TTL을 건다(docs/devops.md §11). 비용은 소유자 상한 안에서만 쓴다.
12. **데모.** 상시 데모 환경을 두지 않는다(질문 24 결론). 로컬 실행 녹화 영상과 누구나 따라 할 수 있는 재현 스크립트를 기본으로 하고, 면접·발표 때만 몇 시간 켜는 임시 클라우드 데모를 선택으로 둔다. 환경 승격·카나리·변경 동결 창은 로컬 kind의 데모 오버레이에서 보여 준다. 무료 상시 VM은 쓰지 않는다. Oracle Cloud 무료 Arm(A1)은 2026년 6월에 월 1,500 OCPU-시간·9,000 GB-시간(2 OCPU·12 GB)으로 줄었고, 7일 동안 CPU 95퍼센타일·네트워크·메모리 사용률이 모두 20% 미만이면 회수될 수 있어 한가한 데모 서버가 걸리기 쉽다(2026-10-13 문서 확인).

## 결과

- WBS: 규칙 모델 검사 4건(0.9.1~0.9.3, 5.2.2), 모델 기반 시험 3건(2.3.4·2.5.5·2.7.6), 장애 기록 검사(2.12.3), 외부 한도 대조표(0.5.5에 더함), 6.1.1을 '100만 외삽 보고서와 선택 보정'으로 바꿈(6일 → 4일). 순증 11일, 합계 287.5일(57.5주).
- 문서: docs/verification.md 신설, 성능 장부 §4·§6·§7, infra §3·§11, devops §5.1·§11·§15, planning/01·02, architecture §9, Game Day 실행 방식(observability §12), 쉬운 설명서 12편.
- 도구: `charts.py usl`(USL 적합과 필요 대수 계산, 외삽 구간 표시)을 더했다(tools/perf-ledger/README.md).
- 면접 문장: "100만 명은 실측하지 않았습니다. 규칙은 작은 범위에서 가능한 모든 순서를 검사했고, 대기 인원과 무관한 예매 계층은 실제 크기로 쟀고, 대기 인원에 비례하는 두 곳은 1천~10만 명 측정이 설계 식과 맞는지 확인한 뒤 그 식으로 100만을 계산했습니다. 그래서 100만이라는 숫자에는 '외삽'이라고 붙어 있습니다."

## 남는 한계

- 100만 명이 한꺼번에 돌 때만 생기는 상호작용(예: 여러 부품의 지연이 겹쳐 생기는 재시도 폭주)은 증명하지 못한다. 형식 명세로도 지속적 성능 저하는 찾지 못한다(AWS 논문이 같은 한계를 적었다).
- 클라우드 노드 기동 시간(K9), 관리형 DB·Redis 장애 조치 시간, CDN의 한도 근처 동작은 재지 않고 문서 인용으로 둔다.
- 실제 인터넷 구간과 사용자 행동(새로고침 배수 2배 등)은 가정이다. 온세일 1회 비용(K9)은 가격표와 외삽한 요청 수로 낸 추정이다.
- 모델은 코드가 아니고, 검사한 범위 밖의 버그는 찾지 못한다. PC 실측은 클라우드 서버 성능과 다르다. IaC는 정적 검사까지만 검증된다.

## 되돌릴 조건

- 지출 상한이 늘거나 후원 크레딧이 생기면 진입 폭발(20만 RPS) 클라우드 측정 1회를 먼저 한다(성능 장부 `cloud-burst`).
- 규칙 검사나 모델 기반 시험에서 위반이 나오면 해당 ADR을 고치는 새 ADR을 낸다.
- 설계 식과 1천·1만·10만 실측이 맞지 않으면 그 식으로 100만을 계산하지 않고 원인을 찾는다.

## 참고 자료(2026-10-13 확인)

- Newcombe 외, [How Amazon Web Services Uses Formal Methods](https://cdn.amazon.science/67/f9/92733d574c11ba1a11bd08bfb8ae/how-amazon-web-services-uses-formal-methods.pdf), CACM 58(4):66–73, 2015, DOI 10.1145/2699417
- Jackson·Vaziri, [Finding Bugs with a Constraint Solver](https://people.csail.mit.edu/dnj/publications/issta00.pdf), ISSTA 2000('many bugs will be detectable in small scopes')
- [Quint](https://github.com/quint-co/quint), [Quint 모델 검사기](https://quint.sh/docs/model-checkers), [TLA+ 도구](https://lamport.azurewebsites.net/tla/tools.html)
- fast-check [모델 기반 시험](https://fast-check.dev/docs/advanced/model-based-testing/), [경쟁 조건](https://fast-check.dev/docs/advanced/race-conditions/)
- Kingsbury·Alvaro, [Elle](https://www.vldb.org/pvldb/vol14/p268-alvaro.pdf), PVLDB 14(3), 2020(인용 표기 2021); [Jepsen](https://jepsen.io/); [Toxiproxy](https://github.com/Shopify/toxiproxy)
- Gunther, [Universal Scalability Law](http://www.perfdynamics.com/Manifesto/USLscalability.html), Guerrilla Capacity Planning(Springer, 2007)
- k6 [open과 closed 모델](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/), [대규모 시험](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/), [dropped iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/); [wrk2](https://github.com/giltene/wrk2)(coordinated omission)
- AWS [CloudFront 할당량](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html), [Origin Shield](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-shield.html), [CloudFront 요금](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/), [S3 성능](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- nginx [proxy 모듈](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)(`proxy_cache_lock`, `proxy_cache_use_stale updating`)
- Oracle [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
