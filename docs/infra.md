# 인프라·배포·운영

- **독자와 용도**: 플랫폼 엔지니어와 온콜 운영자가 시스템 배포 토폴로지, 신뢰 경계, 다중 환경 분리 전략, 구성 요소별 고가용성 및 이중화, 백업 및 DR 계획, CI/CD 파이프라인, 서비스 디스커버리 및 분산 리더 선출, 비상 운영 런북 구성을 파악할 때 참조하는 기준 문서이다. IaC 원본 코드는 `peaket-infra`(Terraform) 및 `peaket-gitops`(Helm·ArgoCD) 저장소에 위치하며, 본 문서는 인프라 아키텍처의 설계 결정과 운영 원칙을 규정한다.
- **원문 출처**: 설계서 §3 온세일 타임라인 2번(프리워밍 절차), §6 API 게이트웨이(트래픽 경로 및 이중화), 서비스 디스커버리, 장애 격리 경계, 관제 시스템의 '자체 감시' 메커니즘, §9 Degraded Mode(대체 우회 경로), 19장(Kubernetes·GitOps·오토스케일링·CNCF 생태계), 23장(AWS DevOps 운영), 15장(저장소 구조), `docs/security/secrets-and-keys.md`, ADR-0008·0009·0010·0022·0028.
- **기준 기획 버전**: v1.0.
- **표시 규칙**: 원문에 세부 명세가 부재했던 인프라 설정(노드 풀 분리, 복제본 수, 백업 주기, 환경 단계, 리전 장애 대응 범위, 운영 관제 도구 선정)은 소유자가 추천대로 정하도록 맡겨 추천안을 적용해 확정하였다(추천 적용 2026-10-09, ADR-0031·0032). 실제 부하 시험 및 클라우드 비용 산정 결과에 따라 사양이 조정될 경우 ADR을 통해 개정한다. 실측 측정을 통해 최종 확정할 지표값만 [가정]으로 표기한다.

## 1. 배포 구성도

```mermaid
flowchart TB
    subgraph Client["클라이언트"]
        FAN["소비자 웹 / 월렛 PWA"]
        PARTNER["파트너 콘솔"]
        OPS["관제 콘솔"]
        SCAN["게이트 스캐너 PWA"]
    end
    subgraph Edge["AWS 엣지"]
        CF["CloudFront + AWS WAF(Bot Control, rate-based) + Shield Standard\n배포 3개: 공연 페이지·대기열 파일·대기열 API\nOrigin Shield, 대기 상태 파일 1초 캐시\n엣지 함수: 매진 응답, 도착 시각 쿠키"]
        S3STATIC["S3 정적 객체\n(대기 상태 파일 대체 경로, 매진 페이지)"]
    end
    subgraph VPC["VPC (단일 리전, 3 AZ)"]
        NLB["NLB(L4), 교차 영역 분산 ON"]
        subgraph EKS["EKS (Karpenter, 서비스 메시 mTLS)"]
            subgraph GW["Envoy Gateway (Gateway API)"]
                GQ["gw-queue"]; GF["gw-fan"]; GP["gw-partner"]; GO["gw-ops"]; GS["gw-scanner(mTLS 종료)"]
            end
            subgraph HOT["핫패스 노드 풀"]
                QS["queue-svc"]; AC["admission-ctrl(리더 1)"]; PS["purchase-svc"]; RG["realtime-gw"]
            end
            subgraph GEN["일반 노드 풀"]
                ID["identity-svc"]; PAY["payment-svc"]; TK["ticket-svc"]; TR["trust-svc"]; OPSS["ops-svc"]; CORE["core-svc + notify 워커"]
            end
            subgraph OBS["관측 스택 노드 풀(분리, 원문)"]
                PROM["Prometheus·Mimir, Loki, Tempo, Pyroscope, Alertmanager, Grafana, OTel 수집기(게이트웨이·클러스터. 에이전트는 모든 노드의 DaemonSet, ADR-0076), Tempo 쓰기 경로는 관측 전용 MSK(ADR-0077)"]
            end
            subgraph DATA["데이터 노드 풀"]
                FLINK["Flink(K8s Operator)"]; CH["ClickHouse"]; MONGO["MongoDB(오퍼레이터)"]
            end
        end
        subgraph Managed["관리형 데이터"]
            AUR["Aurora PostgreSQL ×4 클러스터\n(purchase, payment, ticket, 공유: identity·ops·core)"]
            RED["ElastiCache Valkey/Redis 클러스터 모드 ×3\n(대기열, 좌석, 세션·캐시)"]
            MSK["MSK ×2(거래·제어 / 텔레메트리)"]
            S3["S3(Iceberg 아카이브, 백업, Flink 체크포인트)"]
        end
        KMS["KMS, Secrets Manager(External Secrets Operator), ACM"]
    end
    subgraph Ext["외부"]
        TOSS["PG: 토스페이먼츠(기본)·포트원"]; TURN["사람 확인: Cloudflare Turnstile"]; KYC["본인확인 업체"]; OAUTH["카카오·네이버·구글"]; DRAND["drand 비콘"]; MSG["이메일·문자·Web Push"]; SYN["외부 합성 점검(Grafana Synthetic Monitoring)\n데드맨 수신(Healthchecks.io)"]
    end
    FAN & PARTNER & OPS --> CF --> NLB
    SCAN -->|"API: TCP 통과, CloudFront 미경유"| NLB
    SCAN -.->|"화면: 정적 PWA"| CF
    NLB --> GQ & GF & GP & GO & GS
    GQ --> QS; GF --> PS & RG & ID & TK & CORE; GP --> CORE & PAY & ID; GO --> OPSS & ID; GS --> TK
    QS & AC --> RED; PS & RG --> RED; ID & CORE --> RED
    PS & PAY & TK & ID & OPSS & CORE --> AUR
    QS & PS & PAY & TK & ID & OPSS & CORE & TR --> MSK --> FLINK --> CH --> OPSS
    CORE --> MONGO
    TR --> CH
    CF -.대체 경로.-> S3STATIC
    PAY <--> TOSS; TR --> TURN; ID --> KYC; FAN --> OAUTH; AC --> DRAND; CORE --> MSG
    SYN -.-> CF; PROM -.Watchdog.-> SYN
```

- 일반 사용자 및 관리자 트래픽의 기본 유입 경로는 CloudFront(AWS WAF 통합) → NLB(L4) → Envoy Gateway → 백엔드 마이크로서비스로 구성된다. 소비자 트래픽은 CloudFront 배포 셋(공연 페이지, 대기열 파일, 대기열 API)으로 나눠 받고 배포마다 한도를 미리 올린다(§4.1, ADR-0058). 중간에 ALB를 중복 배치하지 않음으로써 이중 HTTP 프록시 경유에 따른 불필요한 지연시간과 오버헤드를 배제한다(ADR-0008). 반면 현장 게이트 스캐너는 엣지 캐싱이나 WAF 검사가 불필요하므로 CloudFront를 경유하지 않고 NLB의 순수 TCP 패스스루를 통해 `gw-scanner`로 직접 연결되며, 게이트웨이 파드에서 mTLS를 종단하여 기기 인증서를 직접 검증하고, 서비스가 요청마다 기기 상태와 스태프 세션 상태를 확인한다(ADR-0051). 스캐너 PWA 화면 자체는 정적 앱이라 `scanner.peaket.example`에서 mTLS 없이 낸다(§4.1 화면 호스트, ADR-0065).
- 프로덕션 아키텍처는 단일 리전(서울 리전)을 기준으로 구축된다(분산 DB 복잡성을 피하기 위한 ADR-0021 CockroachDB 기각의 핵심 전제). 재해 복구(DR) 리전에는 ticket 데이터베이스의 교차 리전 읽기 복제본(Aurora Global Database의 도쿄 보조 클러스터, ADR-0083)과 백업 데이터 사본만을 상시 유지한다. 리전 전체 마비와 같은 전면 장애 발생 시에는 자동 장애 조치를 수행하지 않고 예매 판매를 즉시 중단한 뒤 콜드 백업 데이터를 기반으로 순차 복원하는 비상 절차를 밟는다(§6, ADR-0031).
- 클러스터 규모와 CNI(추천 적용 2026-10-21, ADR-0078 결정 7): 운영 EKS 클러스터는 하나다. 피크 노드·파드 수 추정 칸과 클러스터 하나로 가는 기준(노드 1,000개·파드 3만 개 [가정] 이하)은 docs/architecture.md §9.5에 있다. CNI는 EKS 기본 Amazon VPC CNI이고 파드마다 VPC 사설 IP를 쓰므로, 파드가 쓰는 서브넷의 IP 합이 피크 파드 수의 2배 [가정] 이상이 되게 가용 영역 셋에 나눠 잡는다. 정확한 CIDR은 피크 추정(wbs 4.8.1) 뒤 Terraform에서 정한다.
- CloudFront 엣지 함수는 CloudFront Functions와 Lambda@Edge 중 HMAC 서명 검증 가능 여부와 실행 비용을 비교하여 최종 선정한다. AWS 계정이 있으면 무료 범위 안에서 함수를 시험하고, 없으면 문서로 비교한다(wbs 0.5.3, docs/architecture.md §9.4 PoC 검증 과제).

## 2. 데이터 흐름도(DFD)와 신뢰 경계

```mermaid
flowchart LR
    subgraph TB0["경계 0: 사용자 기기(신뢰하지 않음)"]
        B["브라우저·PWA\n기기 개인키(추출 불가), IndexedDB"]
    end
    subgraph TB1["경계 1: 엣지(CDN·WAF·엣지 함수)"]
        E["캐시된 대기 상태·셔플 결과 파일\n매진 정적 응답, 도착 시각 쿠키 서명"]
    end
    subgraph TB2["경계 2: 게이트웨이(무상태)"]
        G["JWT 공개키 검증, 경로 권한, 로컬 레이트 리밋\n내부 헤더(사용자·세션·권한·pid) 주입"]
    end
    subgraph TB3["경계 3: 서비스 메시(mTLS, 내부 신원)"]
        Q["queue-svc / admission-ctrl"]; P["purchase-svc / payment-svc / ticket-svc"]; I["identity-svc / trust-svc"]; O["ops-svc / core-svc"]
    end
    subgraph TB4["경계 4: 데이터 저장소(KMS 암호화)"]
        R["Redis ×3"]; DB["Aurora ×4(P2 저장소 암호화, P1 필드 암호화)"]; K["Kafka"]; C["ClickHouse(원시 신호 30일·브론즈·실버 90일·골드 2년·실시간 표 90일)"]; L["접속기록 저장소(3개월)"]; A["감사 로그(변조 탐지)"]
    end
    subgraph TB5["경계 5: 외부"]
        X1["PG: 토스(기본)·포트원(승인·취소·웹훅)"]; X2["본인확인 업체(연계정보 → HMAC만 저장)"]; X3["사람 확인(Turnstile)"]; X4["파트너 웹훅 수신처(https, SSRF 방지)"]; X5["신고기관·수사기관(서면)"]
    end
    B -->|"HTTPS, 쿠키(httpOnly)"| E --> G --> Q & P & I & O
    Q <--> R; P <--> R; P <--> DB; I <--> DB; O <--> DB; P & O & I --> K --> C; G --> L; O --> A
    P <-->|"시크릿 키 Basic, 호출 IP 제한"| X1; X1 -->|"웹훅(토스 결제 웹훅은 서명 없음·지급 웹훅은 서명 검증, 포트원은 서명 검증. 모두 조회 API 재확인)"| G
    I <--> X2; I -->|"위험 점수"| X3; O -->|"HMAC 서명"| X4; O -.문서.-> X5
```

| 신뢰 경계를 통과하는 개인정보 흐름 | 보호 등급 (data-classification) | 보안 통제 및 암호화 조치 |
| --- | --- | --- |
| 외부 본인확인 대행사 ↔ identity-svc (연계정보 CI) | P1 (최고 민감도) | 대행사 API 인증 자격 증명은 AWS Secrets Manager에 보관한다. 수신된 연계정보 원문은 메모리에서 즉시 폐기하고 AWS KMS 관리형 키로 HMAC-SHA256 해시값만 저장한다. 대기열 진입 핫패스에서는 외부 대행사 통신을 일체 배제한다(ADR-0006·0008). |
| 예매자 개인 식별 정보 (성명, 전화번호) 단말 브라우저 → purchase-svc → Aurora PostgreSQL | P2 (일반 개인정보) | 전송 구간은 TLS로 보호하고, 구매 세션 쓰기 요청에는 단말 임시 키로 합의한 키의 요청 서명(소지 증명)을 싣는다(본문 암호화 아님, ADR-0050 결정 8). 스토리지 레벨 KMS 암호화와 어플리케이션 로그 마스킹을 강제한다. |
| 예매자 명단 데이터 Aurora PostgreSQL → gw-partner → 파트너 콘솔 | P2 | 제3자 제공 동의를 획득한 필수 항목에 한해 선별 제공한다. 파트너의 조회 사유와 열람 건수를 접속기록 대장에 필수 기록하며, 대용량 파일 다운로드는 일괄 전송 대신 스트리밍 방식으로 제한한다(FR-027, POL-023). |
| 시스템 접속기록 (접속 일시, IP 주소, 단말 정보) 게이트웨이 파이프라인 → 전용 접속기록 저장소 | P2 | 업무용 데이터베이스와 물리 분리된 전용 저장소에 3개월간 보존하며, 수사기관의 영장 등 적법한 법적 절차가 확인된 경우에만 엄격히 반출한다(POL-025). |
| 단말 행동 신호 데이터 클라이언트 → trust-svc → Kafka → Flink(`trust-reassess`) → ClickHouse | P2 | 사용자 실명 대신 pid와 기기 식별값의 탐지 가명(trust-svc가 넣기 전에 HMAC-SHA256, 탐지 가명 키)만 싣는다(ADR-0053). 대기 중 재평가 후보(`telemetry.trust-candidates`)에는 키인 pid와 회차·패턴·근거 수만 싣는다(ADR-0071). ClickHouse 테이블 TTL로 30일 경과 시 자동 파기하며, S3 장기 레이크에는 비식별 집계 통계만 보존한다. |
| 모바일 월렛 공개키 브라우저 → ticket-svc, 티켓 공개키 및 폐기 목록 → 게이트 스캐너 단말 | P3 (공개 가능 키) | 단말 서명용 ECDSA 개인키는 서버로 보내지 않고 브라우저 IndexedDB의 WebCrypto 키(`extractable=false`)로 둔다. 하드웨어 보관은 아니다(ADR-0050 결정 1). 스캐너 단말은 운영자가 등록한 기기의 mTLS 기기 인증서(PEAKET 스캐너 사설 CA)로 상호 인증한다(ADR-0051). |

## 3. 환경 분리

| 환경 | 주요 용도 | 인프라 구성 | 데이터 정책 | 비밀 관리 | 배포 방식 |
| --- | --- | --- | --- | --- | --- |
| 로컬 (Local) | 기능 개발, 1천·1만·10만 명 측정(포트폴리오 기간의 기본 측정 환경), 단위·통합·계약 테스트 (PG 시뮬레이터 연동), Game Day와 합성 봇 시험(ADR-0057) | kind 또는 k3d 기반 로컬 K8s + LocalStack + Strimzi (로컬 Kafka). CI 테스트 환경도 동일 구성 적용 | Faker 기반 완전 합성 데이터 | `.env` 로컬 파일 (Git 커밋 절대 금지), `.env.example` 템플릿 제공 | 로컬 수동 실행 |
| 스테이징 (Staging) | (설계) 대규모 부하 시험, 카오스 엔지니어링 (Chaos Mesh·AWS FIS), 합성 봇 침투 시험 (POL-026: 봇 공격 실험은 격리 환경에만 국한), Game Day, 교차 리전 재해 복구 훈련. 포트폴리오 기간에는 띄우지 않고 이 역할을 로컬 측정 환경과 선택 보정이 맡는다(ADR-0057, docs/verification.md §5) | 운영과 동일한 Terraform 모듈 기반 프로비저닝. 부하 측정 및 Game Day 기간에만 동적 생성 후 즉시 자원 회수 (Spot 인스턴스 + 시간 단위 빌링) | 대규모 합성 데이터, 토스·포트원 테스트 연동 키, PG 시뮬레이터 어댑터 | AWS Secrets Manager (staging 네임스페이스) | ArgoCD, 운영과 동일한 Helm 차트 배포 |
| 데모 (Demo) [보완] | 포트폴리오 시연과 E2E 시나리오 검증. 상시 환경은 두지 않는다(질문 24 결론, ADR-0057) | 로컬 kind의 데모 오버레이(서비스별 1복제본). 선택: 면접·발표 때만 몇 시간 띄우는 임시 클라우드(TTL·예산 경보) | 경량 합성 데이터, 결제사 샌드박스 테스트 키 | 로컬 `.env`(커밋 금지), 임시 클라우드는 AWS Secrets Manager (demo 네임스페이스) | ArgoCD 자동 배포(데모 오버레이), 녹화 영상과 재현 스크립트 |
| 운영 (Production) | 실제 상용 서비스 환경 (본 포트폴리오의 최종 아키텍처 목표 사양). 포트폴리오 기간에는 설계와 코드로만 두고 띄우지 않는다(ADR-0057) | 본 문서 1절의 다중 AZ 고가용성 구성 | 실제 고객 데이터 (엄격한 암호화 및 법정 보존·파기 정책 준수) | AWS Secrets Manager (prod 네임스페이스), AWS KMS 전용 키 | ArgoCD + Argo Rollouts 기반 카나리 점진 배포, 온세일 윈도우 배포 엄격 차단 |

- 환경별 배포 경로(데모 자동 승격, 스테이징 캠페인 고정, 운영 승격 조건)와 GitOps 저장소 구조는 docs/devops.md §5에 정했다(ADR-0054).
- **포트폴리오 기간의 원칙(소유자 결정 2026-10-13, ADR-0057)**: 운영·스테이징은 이 문서와 Terraform·매니페스트 코드로만 두고 띄우지 않는다. 문서가 '스테이징에서' 한다고 적은 시험·훈련은 로컬 측정 환경에서 하고, 관리형 서비스 장애 주입은 대체 장애로 바꾸며, 관리형 서비스의 장애 조치 시간과 노드 기동 시간은 문서 인용으로 둔다(docs/verification.md §5).
- 상시 가동되는 유휴 dev 클러스터는 비용 절감을 위해 운영하지 않는다. 분산 컴포넌트 간 통합 및 계약 테스트는 CI 단계의 로컬 컨테이너 환경에서 처리하고, 실 브라우저 기반 E2E 검증은 로컬·CI의 데모 오버레이에서 한다(ADR-0031, ADR-0057).
- Terraform 원격 상태 파일(State)은 환경별로 철저히 물리 분리하여 상호 간섭을 차단한다(23장). 운영 환경의 실제 데이터를 스테이징이나 데모 환경으로 덤프하거나 복사하는 행위는 개인정보 보호 원칙상 엄격히 금지된다(POL-026).
- 클라우드에서 부하를 내는 선택 보정(ADR-0057) 전에는 AWS의 네트워크 스트레스 테스트 정책을 사전 점검하고, 반드시 회사 계정 소유의 테스트 리소스만을 대상으로 트래픽을 인가해야 한다.

## 4. 구성 요소별 가용성·이중화

| 구성 요소 | 이중화 및 고가용성 설계 | 장애 발생 시 시스템 동작 | 설계 근거 및 검증 방식 |
| --- | --- | --- | --- |
| CloudFront + AWS WAF | 글로벌 엣지 다중화 배포 | 오리진 장애 발생 시 `stale-if-error` 정책에 따라 캐시된 공연 안내 페이지를 응답하며, 매진 상태 파일과 대기 순번 파일 요청은 CloudFront 원본 그룹(주 원본 → S3 사본, 장애 조치 상태 코드 500·502·503·504, 연결 시간 초과 2초·시도 1회 [가정]. 기본값은 10초씩 3회라 30초 뒤에야 넘어간다)이 요청마다 S3 정적 오리진 대체 경로로 자동 우회하고, 다음 요청은 다시 주 원본으로 보낸다. 원본이 살아 있어도 S3 사본으로 고정하는 것은 명령 6이고 해제도 명령 6이다(RB-04, ADR-0078 결정 2). 보조 원본은 같은 요청 경로를 받으므로 S3 사본 키를 요청 경로에 맞춘다 [가정, wbs 2.2.2에서 확인]. | NFR-007, NFR-002 Degraded 우회 설계. 배포 셋과 배포별 한도는 §4.1(ADR-0058) |
| NLB | 3개 가용 영역(AZ) 분산, 교차 영역 로드 밸런싱 활성화 | 특정 가용 영역의 게이트웨이 파드가 전면 마비되더라도 타 AZ의 정상 파드로 트래픽을 즉시 재분배한다. | ADR-0008 (AZ 간 네트워크 전송 비용은 K9 비용 추정에 가격표와 외삽 요청 수로 넣는다, ADR-0057) |
| Envoy Gateway ×5 | 게이트웨이 유형별 최소 3 복제본을 3 AZ에 균등 배치, PodDisruptionBudget(PDB) 설정, 초당 요청 수 기반 수평 오토스케일링, 오픈 전 프리워밍 | 전체 파드의 절반이 예기치 않게 종료되는 카오스 상황에서도 사전에 정의된 서비스 수준 목표(SLO) 내에서 자동 복구된다. | NFR-011 무중단 가용성 목표 |
| queue-svc | PodTopologySpreadConstraints 기반 AZ 분산, KEDA 기반 이벤트 주도 스케일링 (RPS 및 Redis 대기열 길이 연동), 온세일 프리워밍 | Redis 인메모리 병목 징후 감지 시 `INCRBY` 파드별 마이크로 배치 모드로 전환하며, 심각한 장애 시 도착 시각 쿠키 기반 진입 Degraded 모드로 전환한다. | NFR-001 대기열 처리 목표 |
| admission-ctrl | Kubernetes Lease 기반 활성 리더 1대 + 상시 대기(Standby) 2대 구성. Lease 유지 기간 및 갱신 주기는 리더 공백이 제어 루프 몇 회분에 해당하는지 실측하여 확정한다 (초기 권장값: 유효 기간 15초, 갱신 주기 5초 [가정, Phase 2 부하 시험에서 확정]). | 리더 교체 발생 시 서빙 번호 전진을 일시 중단(대기 순번은 유지)하고, 신규 리더가 분산 Lease를 정상 획득한 직후 서빙을 안전하게 재개한다. 제어 명령 실행 직전 Lease 소유권을 재확인한다. | 33장 분산 리더 강제 종료 카오스 검증 |
| purchase-svc | 최소 3 복제본 이상, 3 AZ 분산 배치, Node.js 이벤트 루프 지연시간(lag) 기반 오토스케일링 | 좌석 Redis 클러스터 장애 조치 중에는 PostgreSQL 정렬 잠금 비상 경로로 우회하며, 동시 예매 허용 목표치를 즉시 50% 감축한다. | NFR-003 좌석 홀드 처리 목표 |
| realtime-gw | WebSocket 동시 연결 수 기반 오토스케일링, 파드당 최대 활성 커넥션 한도 설정 | 클라이언트 재연결 발생 시 구역 버전 갭을 감지하여 전체 스냅샷 재동기화를 자동 요청한다. | NFR-004 실시간 좌석 브로드캐스트 목표 |
| identity·payment·ticket·trust·ops·core | 도메인별 최소 2 복제본 이상, PodDisruptionBudget 적용 | trust-svc 장애 시 캐시된 정적 규칙과 보수적 IP 레이트 리밋 모드로 전환하여 정상 사용자의 예매 진입을 보장한다. ops-svc 마비 시에는 대역 외 비상 CLI 도구로 제어권을 유지한다. | NFR-022, NFR-008 장애 격리 목표 |
| Redis Cluster ×3 | 클러스터당 샤드 3개 × 복제본 1개 구성, 다중 AZ 배치, 비동기 복제 | 마스터 장애 조치 시 비동기 복제 지연에 따른 쓰기 유실 가능성에 대비하여, 대기열 순번은 세대 번호 부여 및 카운터 건너뛰기로 해결하고, 좌석 홀드 누락은 DB 유니크 제약으로 차단하며, 세션은 리프레시 토큰으로 자동 재로그인을 유도한다. 샤드 추가와 슬롯 이동(리샤딩)은 정비 시간에만 한다(docs/devops.md §12.1, ADR-0082). | NFR-015, ADR-0002·0014·0082 |
| Aurora PostgreSQL ×4 | 다중 AZ Writer 인스턴스 1대 + Reader 인스턴스 구성, 장애 시 자동 장애 조치 | 목표 복구 시점(RPO) 0, 목표 복구 시간(RTO) 5분을 보장한다. 장애 조치 전환 구간에 인입된 쓰기 요청 실패는 클라이언트 및 어플리케이션의 멱등 재시도 파이프라인으로 흡수한다. | NFR-015 데이터 신뢰성 목표 |
| ticket DB 교차 리전 읽기 복제본 | Aurora Global Database의 보조 클러스터(도쿄, 읽기 인스턴스 1대)로 상시 동기화한다. Aurora PostgreSQL은 교차 리전 Aurora 복제본을 지원하지 않아 다른 리전에 읽기 클러스터를 두는 관리형 방법은 이것이다. 평소에는 읽기에만 쓰고 관리형 전환(switchover·failover)으로 쓰기를 옮기지 않는다. 나머지 세 Aurora 클러스터는 Global Database에 넣지 않는다(추천 적용 2026-10-22) | 공연 당일 메인 리전에 네트워크 장애가 발생하더라도 현장 스캐너의 티켓 유효성 검증 조회를 중단 없이 유지하며, 리전 전면 장애 시 티켓 원장 데이터를 보존한다. | 원문 '가용성 시간대', ADR-0031, ADR-0083 |
| MSK (Kafka) | 3대 브로커 노드를 3 AZ에 분산, Replication Factor 3, `min.insync.replicas=2`, 프로듀서 `acks=all` 강제 | 단일 브로커 노드가 물리적으로 다운되더라도 무중단 메시징을 유지한다. 거래·제어 토픽과 대용량 텔레메트리 클러스터를 물리 분리하여 핵심 원장 토픽을 보호한다. 관측 전용 클러스터(Tempo 쓰기 경로)는 세 번째로 따로 둔다(ADR-0077). | ADR-0026 토픽 분리 아키텍처 |
| ClickHouse | 데이터 노드 2 복제본 구성, 비동기 일괄 삽입 처리 | 적재 파이프라인 지연 시 실시간 관제 대시보드의 비즈니스 패널 조회를 Prometheus 인메모리 메트릭으로 축소 표출한다. | NFR-009 Degraded 관제 우회 |
| MongoDB | MongoDB 커뮤니티 오퍼레이터 기반 3 노드 복제 세트 구성 | 카탈로그 저장소 장애 시 프론트엔드 정적 캐시 및 ISR 캐시로 읽기 요청을 흡수한다. | ADR-0013 상품 카탈로그 아키텍처 |
| Apache Flink | Kubernetes Operator 1.16.1, Flink 2.2.x 고정. 잡마다 애플리케이션 모드(세션 클러스터 없음), JobManager 쿠버네티스 HA, 체크포인트·세이브포인트 S3 영구 저장, 관리 REST는 Operator만 닿음, 자동 확장 끔. 관제 실시간 잡은 예비 TaskManager 1대(docs/streaming.md §2, ADR-0071) | 관제 실시간 표 신선도(심장 박동)가 5초를 3분 넘게 넘으면 실시간 표 패널을 Prometheus 대체 표시로 바꾸는 Degraded 모드를 켠다. 체크포인트 지연은 원인 패널이다 | NFR-009 관제 스트리밍 신뢰성 |
| 관측 스택 (Prometheus·Grafana 등) | 일반 비즈니스 파드와 격리된 전용 노드 풀에 배포, 외부 서드파티 데드맨 스위치 연동 | 사내 관측 인프라 전체가 붕괴하더라도 외부 모니터링이 즉시 온콜 담당자를 호출한다. Grafana도 같은 노드 풀이라 함께 멈추므로 외부 합성 점검과 콘솔의 Prometheus 밖 숫자(입장 제어 상태, 관제 실시간 표)와 비상 런북 CLI로 관제권을 유지한다(ADR-0073). | docs/observability.md §10 |
| EKS 워커 노드 풀 | Karpenter 오토스케일러 운용. Spot 인스턴스는 스테이징·데모 환경과 비핵심 워커(notify, Flink 원본 적재 잡의 TaskManager)에만 허용하고, 핵심 핫패스 노드는 온디맨드 인스턴스로 강제한다. 관제 실시간 잡·봇 재평가 잡의 TaskManager는 창·중복 제거 상태를 가져 회수되면 잡이 재시작하므로 온디맨드다(ADR-0071) | 불시의 노드 축출 상황에서도 PDB와 토폴로지 분산 제약에 따라 시스템 처리 용량을 안전하게 유지한다. | 19장 쿠버네티스 아키텍처 |

### 4.1 CloudFront 배포와 한도 (ADR-0058)

| 배포 | 호스트 | 받는 것 | 설계 피크(100만 기준) | 요청 한도(기본 → 상향 목표) | 전송(기본 150 Gbps) |
| --- | --- | --- | --- | --- | --- |
| 공연 페이지 | `www.peaket.example` | 공연 페이지, 홈(ISR), 대기실 셸, 웹 정적 자산, 장르별 랭킹 파일·회차 좌석맵 파일(S3 원본, ADR-0063), 공개 감사 체크포인트(`/transparency/`, S3 원본, ADR-0075) | 초당 30만 건(NFR-007) | 25만 → 45만 [가정] | 기본 |
| 대기열 파일 | `queue-files.peaket.example` | 대기 상태 파일, 셔플 결과 파일, 묶음 결과 파일 | 초당 약 17.8만 건(셔플 결과 분산 조회 약 12.5만 + 대기 상태 조회 약 5.3만), 전송 약 36 Gbps | 25만 → 27만 [가정] | 기본(목표 54 Gbps) |
| 대기열 API | `queue.peaket.example` | 로비 입장, 사전 검증, 진입, 입장 확정, 엣지 함수(매진 응답, 도착 시각 쿠키) | 초당 20만 건(NFR-001) | 25만 → 30만 [가정] | 기본 |

- 다른 호스트(gw-fan `api`, 파트너, 관제)는 따로 배포를 두고 피크가 기본 한도보다 훨씬 작다. 게이트 스캐너(gw-scanner)는 CloudFront를 거치지 않는다.
- **브라우저 지표 경로(추천 적용 2026-10-21, ADR-0079 결정 13)**: 화면 배포 넷(`www`·`partner`·`console`·`scanner`)은 같은 출처 `/_t/*`(POST만, 캐시 안 함)를 gw-fan의 텔레메트리 입구로 보내는 캐시 동작을 두고, 원본 요청에 원본 확인 헤더와 화면 앱 이름 `X-Peaket-App`을 붙인다(CloudFront는 같은 이름의 시청자 헤더를 덮어씀, AWS 개발자 안내서 2026-10-21 확인). gw-scanner는 CloudFront를 거치지 않고 gw-ops는 허용 IP만 받으므로 앱마다 그 앱 게이트웨이로 보내지 않는다(docs/observability.md §11).
- **대기실 경로(추천 적용 2026-10-21, ADR-0079 결정 2)**: 공연 페이지 배포는 `/queue/*`·`/{en,ja,zh}/queue/*`·`/shop/*/queue`를 CloudFront Function(시청자 요청)으로 대기실 경량 셸 `/_q/shell.{locale}.html`(S3 원본)로 바꿔 읽는다 [가정, PoC wbs 2.10.6]. 셸 응답 헤더 정책의 CSP는 docs/frontend.md §5.14의 묶음 A′다.
- **사전 요청 없는 진입(추천 적용 2026-10-15, ADR-0065 결정 6)**: 대기열 API의 설계 피크 초당 20만 건에는 CORS 사전 요청(OPTIONS)이 들어 있지 않다. www에서 `queue` 호스트로 가는 진입과 입장 확정은 교차 출처라 JSON 본문이면 요청마다 사전 요청이 붙고, 사전 요청 캐시는 URL별인데 진입 주소는 회차마다 달라 미리 데울 수 없다. 그래서 두 요청은 사전 요청이 생기지 않는 형식(`Content-Type: text/plain;charset=UTF-8`, safelisted 헤더만)으로 보낸다(docs/features/queue-admission.md §3). 사전 요청이 생기는 다른 대기열 경로(로비 입장·사전 검증·대기 취소)는 대부분 T=0 전에 일어나고, 사전 요청 응답에 `Access-Control-Max-Age: 7200`을 줘 같은 주소의 반복을 줄인다(Chromium 상한 2시간, MDN). 사전 요청이 정말 없는지는 Phase 2의 브라우저 시험으로 확인하고 그 형식으로 낸 지연은 부하 시험에서 잰다(queue-admission Q-T41).

**화면 호스트(추천 적용 2026-10-15, ADR-0065 결정 1)**: 앱마다 호스트를 달리해 동일 출처 정책으로 나눈다(ASVS v5.0.0-3.5.4). API 호스트(`api`·`queue`·`queue-files`·`partner-api`·`ops-api`·`scanner-api`, openapi `servers`)는 그대로다.

| 화면 | 호스트 | 내는 것 | 배포 | 부르는 API 호스트 |
| --- | --- | --- | --- | --- |
| 소비자 웹(월렛 PWA 포함) | `www.peaket.example` | Next.js 앱 서버(ISR·동적 화면), 정적 셸, 웹 정적 자산 | 공연 페이지 배포(위 표) | `api`·`queue`·`queue-files` |
| 파트너 콘솔 | `partner.peaket.example` | Next.js 앱 서버(동적 렌더링)와 정적 자산 | 파트너 화면 배포 [가정, wbs 2.11.2에서 확정] | `partner-api` |
| 관제 콘솔 | `console.peaket.example` | Module Federation 호스트와 원격 모듈(같은 출처 `/remotes/`, docs/devops.md §6.6), 포렌식 리플레이 2단계 페이지(`/forensics/`, 출시 뒤 선택), 정적 파일 | 관제 화면 배포 [가정, wbs 2.11.2에서 확정]. 관리자 콘솔 IP 제한(§9)을 받는다 | `ops-api` |
| 게이트 스캐너 PWA | `scanner.peaket.example` | Vite 정적 앱(mTLS 없음) | 스캐너 화면 배포 [가정, wbs 2.11.2에서 확정] | `scanner-api`(mTLS, CloudFront 미경유) |

- 화면 호스트의 피크는 공연 페이지 배포를 빼면 기본 한도보다 훨씬 작다. 화면 호스트마다 응답 보안 헤더와 CSP가 다르다(§9, docs/architecture.md §6.3).
- 팬·파트너 쿠키처럼 `Domain=peaket.example`을 쓰는 쿠키는 PEAKET의 모든 하위 호스트로 가므로, 하위 호스트에는 PEAKET이 운영하는 앱과 게이트웨이만 둔다(docs/features/identity.md §3). 알림 메일용 하위 도메인처럼 웹을 내지 않는 이름은 예외다.
- gw-fan `api` 배포의 공개 카탈로그 읽기(홈 피드, 검색, 연관 검색어, 후기 요약)는 쿠키를 캐시 키와 원본 요청에서 뺀 캐시 정책으로 받는다. 오픈 직전 100만 명이 몰릴 때 연관 검색어는 입력마다 요청이 나가지만 정규화한 입력이 키라 같은 앞부분이 한 캐시를 쓴다. 이 배포의 피크는 아직 셈하지 않았고 기본 한도 안으로 본다 [가정]. 부하 분해(docs/verification.md §3.1)에 연관 검색어 요청 수를 더해 셈한 뒤 위 표에 넣을지 정한다(추천 적용 2026-10-14, ADR-0063).
- **상향 요청**: 상향 목표는 배포 설계 피크의 1.5배 [가정]다. 처리 기간을 모르므로 출시 준비에서 운영 계정을 만들 때 요청하고(포트폴리오 기간에는 설계 값이다, ADR-0057), 승인 값과 요청일을 외부 한도 대조표(docs/verification.md §4)에 적는다. 200만(docs/architecture.md §9.2)이면 대기열 API 60만, 3년차 합산 300만(§9.5)이면 대기열 파일 약 43만이 필요하므로 그 규모가 되기 전에 다시 요청한다 [가정].
- **확인**: 대형 회차는 판매 승인 때 운영자가 그 회차 예상 피크가 승인 값 안인지 대조표로 확인하고, T-30분 점검(§5)이 다시 확인한다.
- **대기열 파일 배포 설정**: 셔플·묶음 결과 파일 경로의 404 오류 캐시 최소 TTL을 1초 [가정]로 둔다(CloudFront 기본 10초. 기본값이면 게시 뒤에도 최대 10초 동안 '셔플 전'이 나간다). 대체 원본은 S3이고, S3에는 회차별 접두사(`queue/{eventId}/shuffle/…`, `queue/{eventId}/fallback/…`)로 쓴다(접두사마다 초당 PUT 3,500건 이상, AWS S3 성능 문서). 소비자 웹 스크립트가 다른 출처의 파일과 `Retry-After`를 읽도록 이 배포와 S3 대체 원본은 `Access-Control-Allow-Origin: https://www.peaket.example`과 `Access-Control-Expose-Headers: Retry-After, Date`를 낸다(`Date`는 브라우저 시계 보정, ADR-0079 결정 3). 쿠키를 받지 않으므로 `Access-Control-Allow-Credentials`는 두지 않고, 값이 하나로 고정이라 캐시가 출처마다 갈리지 않는다(추천 적용 2026-10-15, ADR-0065 결정 7).
- **감시**: 배포별 한도 사용률(배포 요청 수 ÷ 승인 한도)이 80% [가정]를 넘으면 SEV3 경고를 낸다(docs/observability.md §5).
- 한도를 넘었을 때 CloudFront가 어떤 응답을 주는지와 상향 처리 기간은 AWS 문서에서 확인하지 못했다.

## 5. 프리워밍과 오토스케일 (프리워밍 T-40분 시작, 점검 T-30분)

1. **KEDA Cron 트리거 (T-40분 [가정, Phase 4 4.6.1에서 확정])**: T-30분 점검(5번) 전에 끝나도록 정기 크론 트리거가 가동되어 Envoy 게이트웨이군, queue-svc, admission-ctrl, purchase-svc, realtime-gw, identity-svc(오픈 직전 대규모 동시 로그인 집중), trust-svc의 최소 파드 복제본 수를 사전 프로비저닝 수치로 스케일업한다. 구체적인 목표 파드 수는 docs/architecture.md §9의 용량 산정 공식과 사전 부하 시험 실측치에 기반하여 KEDA 매니페스트에 정의한다.
2. **Karpenter 선제적 노드 프로비저닝**: 새로운 파드 스케줄링 요구에 맞춰 Karpenter가 온디맨드 EC2 노드를 사전에 대량 기동한다(신규 노드 부팅 리드타임이 전체 스케일링 지연의 대부분을 차지하므로 60초 신속 스케일링 목표 달성을 위해 오픈 전 선제적 노드 워밍이 필수적이다, NFR-023·K9).
3. **다계층 캐시 예열 (Cache Warming)**: 신규 오픈 공연 상세 페이지의 ISR 재검증을 선제 트리거하고, 회차 좌석맵 파일(배치·좌석 두 층, ADR-0063)과 JWT 공개키(JWKS) 캐시를 로드하며, Redis 좌석 상태 비트맵을 초기화하고, CloudFront Origin Shield 캐시를 예열한다.
4. **런타임 스케일러 연동**: 오픈 이후에는 KEDA가 실시간 Redis 대기열 길이(인입량), Kafka 컨슈머 지연(lag), Prometheus 수집 지표(Node.js 이벤트 루프 지연 p99, 게이트웨이 초당 요청 수)를 종합 관측하여 오토스케일링을 동적 제어한다. 포화 상태 지표는 AIMD 동시 입장 목표 조절 알고리즘의 제어 입력으로도 사용된다(docs/observability.md §3 규칙 4). KEDA는 지표를 3회 [가정] 연속 못 읽으면 지금 복제 수를 유지하고(`fallback`의 behavior `currentReplicas`), 확장 기준을 AIMD 감축 기준보다 낮게 두어 확장이 먼저 걸리게 한다. 오토스케일이 잘못 움직이면 RB-30으로 멈춘다(docs/architecture.md §5, ADR-0069).
5. **T-30분 Pre-flight 체크리스트 점검 (관제 SCR-029)**: 사전 노드 및 파드 프리워밍 완료 여부, 다계층 캐시 적중률(권고: 직전 15분 공연 상세·정적 자산 배포의 엣지 적중률 90% 이상 [가정], 요청 1,000건 미만이면 판정 보류, 추천 적용 2026-10-14, ADR-0062), Redis·Kafka·Aurora 데이터베이스 헬스체크, 그 공연 결제사(ADR-0044)의 상태와 한도 초과 응답 여부, 본인확인·사람 확인 제공자 상태, CloudFront 배포별 요청·전송 한도(적용된 상향 값)가 그 회차의 설계 피크 이상(§4.1, ADR-0058), 외부 합성 점검 정상 여부, 온콜 알림 채널 시험 발송 결과, 노드 시계 오프셋 20ms 이하, 만료 7일 이하 인증서 없음, 마지막 교차 리전 백업 성공, 진행 중 배포(롤아웃·마이그레이션) 0건(대형·중형 회차. 소형 회차는 동결 대상 핫패스 롤아웃을 T-15분 자동 중단으로 대신해 이 항목을 판정에서 빼고 표시만 한다, ADR-0054 결정 10), 그 회차의 변경 동결 창 적용(ArgoCD·Karpenter), 동결 창에 겹치는 예정 관리형 유지보수 없음을 종합 검토하여 티켓팅 오픈 강행 여부(Go/No-Go)를 최종 판정한다. 캐시 적중률을 뺀 항목은 필수이고, 필수가 하나라도 실패하면 오픈 시각에 입장 일시정지와 대기실 공지로 시작해 회복 뒤 재개한다(docs/features/control-tower.md §2, ADR-0049, ADR-0054).
6. **변경 동결 창 강제**: 온세일 윈도우(T-10분 ~ T+60분)에는 배포하지 않고(POL-028), 그 앞을 변경 동결 창으로 넓힌다. 대형·중형 온세일은 T-90분부터 T+60분까지 모든 운영 변경을 시작하지 않고 T-45분에 끝나지 않은 롤아웃을 자동 중단하며, 소형 온세일은 핫패스 묶음만 T-50분부터 막는다. 장애의 약 70%가 운영 중인 시스템의 변경에서 나온다는 구글의 내부 관찰(SRE Book 1판 1장)을 근거로 한다. 오픈 시각이 공연마다 다르므로 고정 일정이 아니라 변경 동결 달력이 오픈 일정에서 ArgoCD 동기화 창(deny)과 Karpenter 노드 중단 예산을 자동으로 만들고, 관리형 서비스 유지보수 창은 정비 시간(매일 04:00~06:00 KST) 안의 수요일 04:00(KST)부터로 고정한다(docs/devops.md §8, ADR-0054)[보완].
7. **온세일 종료 후 자원 회수 및 비용 분석**: 티켓팅 집중 구간이 종료되면 KEDA 크론이 최소 복제본 수를 평상시 수준으로 복원하고 Karpenter가 유휴 EC2 노드를 안전하게 드레인하여 반납한다. FinOps 관점에서 1회 온세일 이벤트에 소요된 총 인프라 비용과 티켓 1,000장 발권당 인프라 비용을 OpenCost 메트릭과 AWS 비용 할당 태그를 기반으로 정밀 산출한다(K9). 포트폴리오 기간에는 운영을 띄우지 않으므로 가격표와 외삽한 요청 수로 추정한다(ADR-0057).

## 6. 백업·DR (NFR-015, ADR-0031)

| 데이터 원장 | RPO | RTO | 백업 정책 | 복구 절차 | 검증 및 훈련 계획 |
| --- | --- | --- | --- | --- | --- |
| Aurora PostgreSQL (purchase, payment, ticket) | 0 (다중 AZ 동기 복제) | 5분 (자동 장애 조치) | 지속적 자동 백업 및 시점 복구(PITR) 35일 보존, 일 단위 전체 스냅샷 교차 리전 복제 | 인스턴스 다운 시 자동 장애 조치가 수행된다. 논리적 데이터 손상 발생 시 PITR로 정상 시점 클러스터를 복원한 후 Outbox 테이블 및 Kafka 오프셋과 대조하여 미반영 트랜잭션을 재처리한다. | AWS FIS 장애 조치 주입 시험(운영 설계, RB-10 절차), 분기 1회 PITR 복원 훈련 실시(포트폴리오 기간: 로컬 대체 장애와 PITR 리허설, docs/verification.md §5.3) |
| Aurora PostgreSQL 공유 클러스터 (identity, ops, core) | 0 | 5분 | 지속적 자동 백업 및 PITR 35일 보존, 일 단위 전체 스냅샷 교차 리전 복제 | 상동. 특히 운영 감사 로그(`command_event`)는 매일 S3 Object Lock(WORM 정책) 저장소로 별도 백업 사본을 보관하고, 감사 기록 전체는 키 건 해시 체인(`audit_chain`)의 마지막 값을 5분마다 같은 저장소에 앵커로 남겨 고치면 드러나게 한다(ADR-0053). | 상동 |
| Redis 대기열 클러스터 | 비동기 복제 지연분 (수백 ms 이내) | 30초 | 영구 백업 미적용 (회차 키는 그 회차의 판매 종료(공연 시작 24시간 전, ADR-0064) TTL 뒤 휘발. 판매는 온세일 윈도우가 아니라 판매 종료·매진까지 이어진다, ADR-0063 결정 11) | 마스터 페일오버 발생 시 신규 마스터의 순번 카운터를 보수적 안전 여유치만큼 일괄 전진시키고 세대 번호를 증가시킨다. 판매 기간이 길어 장애로 사람별 입장 키(`q:adm`)가 사라지면 이미 입장한 사람이 다시 줄을 설 수 있다. 그래도 1인 매수 한도는 DB 원장(`purchase_quota`)이 지킨다. 대기열 셔플 결과는 CDN 엣지에 캐시된 정적 파일이 최종 진실 원천 역할을 담당한다. | FIS 페일오버 시뮬레이션, K1 순번 중복 0건 실측 검증(포트폴리오 기간: 로컬 Redis 주 노드 강제 종료) |
| Redis 좌석 클러스터 | 비동기 복제 지연분 (수백 ms 이내) | 30초 | 영구 백업 미적용 | 페일오버 진행 구간에는 PostgreSQL 정렬 잠금 경로로 안전 우회 처리하며, 인메모리 노드 복구 완료 후 관계형 DB의 `seat_sale` 및 홀드 원장을 기반으로 비트맵 상태를 동기화 재구성한다. | FIS 페일오버 테스트, 불변식 검사기를 통한 오버셀 0건 입증(포트폴리오 기간: 로컬 Redis 주 노드 강제 종료) |
| Redis 세션·캐시 클러스터 | 데이터 유실 허용 | 30초 | 영구 백업 미적용 | 캐시 데이터는 원본 DB 조회를 통해 재적재하며, 세션 만료 건은 클라이언트의 리프레시 토큰 재인증을 통해 무중단 재발급한다. | 정기 재기동 테스트 |
| MSK (Kafka) | 0 (Replication Factor 3, `acks=all`) | 브로커 자동 재시작 | 메시지 보존 기간 7일 설정, 핵심 거래 토픽은 Compaction 없이 Append-only 유지 | 브로커 복구 후 컨슈머가 마지막 커밋 오프셋부터 재처리하며 멱등 컨슈머 로직으로 중복을 제거한다. | 단일 브로커 강제 종료 Game Day 시나리오 수행 |
| ClickHouse | 1일 | 1시간 | 일 1회 S3 원격 스냅샷 백업(분석 레이크와 다른 백업 전용 버킷, SSE-KMS, 백업 역할만 읽음). 원시 IP가 든 접속기록 DB와 30일 행동 신호가 들어가므로 7일 [가정, Phase 4 4.3.7에서 확정]만 둔다(ADR-0053) | 스냅샷을 복원하고, 그 뒤 구간은 분석 대상 Kafka 토픽(보관 7일 이상 [가정])을 다시 읽어 브론즈를 채운 다음 dbt로 실버·골드를 다시 만든다. 동결된 회차는 Iceberg 아카이브에서 되살린다(docs/features/analytics.md §3.5). | 분기별 스냅샷 복원 훈련 |
| Prometheus·Mimir (관제 메트릭) | 수 초 [가정, Phase 4 4.1.1에서 확정](장애 AZ의 Prometheus가 아직 원격 쓰기로 보내지 못한 분량) | — (핫패스 밖, 관측 스택 장애는 외부 감시가 받는다) | Prometheus 로컬 15일, Mimir 오브젝트 스토리지(S3) 원본 90일·5분 집계 13개월(테넌트 분리), 고전 구조 인제스터 영역 인식 3중 복제(AZ마다 한 벌, 쓰기·읽기 정족수 2, ADR-0077) | 남은 AZ의 인제스터 복제본으로 수집과 조회를 이어 가고, Prometheus는 다시 떠서 원격 쓰기를 재개한다. 관제 읽기 모델(ClickHouse 실시간 표)은 Kafka 보관분을 다시 읽어 채운다 | 관측 스택 AZ 장애 Game Day(G-26)와 전체 정지(G-11) |
| MongoDB | 1일 | 1시간 | MongoDB 오퍼레이터 기반 일 1회 S3 스냅샷 백업(백업 전용 버킷, SSE-KMS) | 데이터 복원 후 Change Stream을 재가동하여 카탈로그 캐시를 재검증한다. | 분기별 복원 훈련 |
| S3 (아카이브 레이크 및 백업 버킷) | — | — | 버킷 버전 관리 활성화 및 백업 전용 버킷 대상 교차 리전 복제(CRR) 적용 | — | — |
| 비밀 정보 및 암호화 키 | — | — | AWS Secrets Manager 및 AWS KMS 관리형 백업. 암호화 키 버전을 데이터 원장과 함께 영구 기록 | 키 순환 절차는 `docs/security/secrets-and-keys.md`의 표준 지침을 준수한다. | — |

**백업 신선도와 복원 시험 감시(ADR-0049)**: 저장소별 마지막 성공 백업 경과 시간과 교차 리전 복제 지연을 지표로 낸다. 교차 리전 스냅샷이 26시간(RPO 24시간 + 2시간) 넘게 없으면 SEV2, ClickHouse·MongoDB 일 단위 백업이 26시간 넘게 없으면 SEV3를 내고 [가정, Phase 4 관측 구축에서 확정], 마지막 교차 리전 백업 성공은 오픈 30분 전 점검의 필수 항목이다(§5). 분기 복원 훈련의 실제 복구 시간은 성능 장부에 남기고 RTO를 넘으면 포스트모템을 쓴다(ISMS-P 2.9.3·2.12.2, docs/observability.md §5).

**리전 전체 재해 복구 절차 (ADR-0031)**: 리전 전면 마비 시 자동 장애 조치는 수행하지 않으며 다음 절차에 따라 통제 복구를 진행한다.
1. 티켓 예매 판매를 즉시 공식 중단하고 외부 호스팅 기반 상태 페이지(Upptime)와 대기실 진입 안내 화면을 통해 서비스 일시 정지 및 복구 일정을 공지한다.
2. 당일 공연 관람객의 현장 입장은 단말 로컬의 오프라인 검증 로직으로 중단 없이 진행하며, 타 리전에 구축된 ticket 읽기 복제본을 활용하여 실시간 티켓 목록 조회를 유지한다(복제 지연분만 일시 조회 제한).
3. 핵심 주문 및 결제 데이터는 DR 리전에 복제된 일 단위 스냅샷(목표 복구 시점 RPO 24시간)을 기반으로 복원하고, 스냅샷 이후 시점의 미반영 거래는 PG사 정산 거래 내역 단건 대사 조회를 통해 전수 복원한다. 티켓 원장은 DR 리전의 ticket 보조 클러스터를 Global Database에서 떼어 읽기·쓰기가 되는 독립 클러스터로 만든 뒤(사람이 실행, ADR-0083) 그것을 기준으로 최종 동기화한다.
4. Terraform 자동화 코드를 활용하여 DR 리전에 메인 인프라와 동일한 스택을 신규 프로비저닝하고, 목표 복구 시간(RTO) 24시간 이내에 티켓 예매 서비스를 재개한다(RB-18). 스테이징 환경에서 분기 1회 교차 리전 전면 복구 모의훈련을 정기 실시한다(운영 설계. 포트폴리오 기간에는 복구 계획과 런북을 대조하는 모의 진행으로 한다, docs/verification.md §5.3).

## 7. CI/CD

상세 설계(저장소 14개와 공개 범위, 공용 재사용 워크플로, 공급망 증명, 환경 승격, 워크로드별 배포, 마이그레이션, 변경 동결 달력, 정비 시간)는 [docs/devops.md](devops.md)가 정본이다(ADR-0054). 이 절은 요약이다.

```mermaid
flowchart LR
    PR["PR(작업 가지 → develop, 릴리스·핫픽스 → main)"] --> CI["GitHub Actions 공용 재사용 워크플로\n테스트(유닛·통합·계약 Pact·buf breaking·마이그레이션)\nSAST·의존성·이미지·IaC 검사(조치 기한을 넘긴 High 이상 0, POL-041)\ngitleaks, Lighthouse CI 예산, axe\nTerraform plan + Infracost 코멘트"]
    CI -->|"OIDC로 AWS 자격 증명(장기 키 금지)"| ECR["ECR(이미지 스캔, SBOM, cosign 서명, SLSA 출처 증명)"]
    ECR --> GITOPS["peaket-gitops 승격 PR(같은 다이제스트, 변경 PR 목록)"]
    GITOPS --> ARGO["ArgoCD(환경별 Application, 변경 동결 달력의 deny 창)"]
    ARGO --> ROLL["Argo Rollouts 카나리\nPrometheus 분석(SLO 지표) 자동 롤백"]
    ROLL --> PROD["운영"]
    BUDGET["28일 에러 버짓 소진"] -.파이프라인 잠금.-> ARGO
```

- 가지 규칙: 코드 저장소는 git flow(`main`·`develop`과 작업·릴리스·핫픽스 가지)를 따르고, 데모에는 릴리스·핫픽스 가지의 출시 후보만, 운영에는 `main`에 출시 태그가 붙은 그 후보 다이제스트만 간다. GitOps 저장소는 `main` 하나다([docs/devops.md](devops.md) §2.2, ADR-0074).
- 저장소별 독립 CI/CD 파이프라인 구성: 프론트엔드 모노레포(Turborepo 원격 캐시 기반 최적화 및 애플리케이션별 분기 배포), 백엔드 서비스 폴리레포(서비스별 경량 컨테이너 이미지 빌드), `peaket-contracts`(API 스키마 계약 패키지 버전 관리 및 buf 하위 호환성 검증), `peaket-infra`(Terraform plan/apply 자동화 및 인프라 승인 절차), `peaket-gitops`(ArgoCD가 감시하는 쿠버네티스 선언형 매니페스트).
- 게이트웨이 라우팅 구성(Gateway, HTTPRoute, EnvoyFilter 정책) 변경 역시 애플리케이션 코드와 동일하게 GitOps 카나리 배포 절차를 거친다. 최상위 Gateway 리소스는 플랫폼 엔지니어링 팀이 통제하고, 개별 서비스의 HTTPRoute는 서비스 팀 저장소에서 관리한다.
- Kyverno 기반 쿠버네티스 거버넌스 정책(CEL 기반 `ValidatingPolicy`·`ImageValidatingPolicy`. 기존 ClusterPolicy 형식은 Kyverno v1.19에서 폐기 예정): 서명 신원과 SLSA 출처 증명이 공용 빌드 워크플로와 맞지 않는 이미지 기동 차단(데모는 감사 모드), 컨테이너 리소스 요청(requests) 및 상한(limits) 명시 강제, 핫패스 네임스페이스 내 저가형 Spot 인스턴스 스케줄링 엄격 차단. 검증이 외부 투명성 로그 가용성에 묶여 온세일 확장을 막지 않는지는 PoC로 확인한다(docs/devops.md §4.3).
- 프로덕션 에러 버짓 연동: 최근 28일 기준 SLO 에러 버짓이 전량 소진된 경우 신규 기능 배포 파이프라인이 자동 잠금 처리되며, 시스템 안정화 작업 배포만 허용된다(POL-022). 변경 동결 창(POL-028, docs/devops.md §8)과 취약점 조치 기한(POL-041)도 운영 승격 게이트가 강제한다.
- DORA 핵심 지표 5종(변경 리드타임, 배포 빈도, 변경 실패율, 실패한 배포 복구 시간, 배포 재작업률)을 CI/CD 이벤트 및 인시던트 관리 시스템과 연동 수집하여 엔지니어링 생산성 추세를 지속 관측한다(NFR-023).
- 본 프로젝트의 정적 문서 품질을 보증하기 위해 문서 검증 스크립트(`tools/doc-check/check_all.py`)를 문서 저장소의 모든 풀 리퀘스트(PR) 검사 단계에서 필수 실행한다(00-summary §8).

## 8. 서비스 디스커버리, 무중단 배포, 리더 선출 (ADR-0010)

- 내부 마이크로서비스 간 통신은 쿠버네티스 표준 Service DNS 명칭만을 사용한다. 정적 IP 주소는 환경 설정에 일체 하드코딩하지 않으며, Netflix Eureka와 같은 별도의 외부 서비스 레지스트리는 운영하지 않는다. 백엔드 파드 목록의 실시간 엔드포인트 갱신(EndpointSlice)은 쿠버네티스 컨트롤 플레인이 전담한다.
- 내부 gRPC 서비스 간 통신은 서비스 메시(Service Mesh)를 통해 L7 요청 단위로 균등 부하 분산된다(L4 연결 단위 로드 밸런싱 적용 시 특정 파드로의 커넥션 쏠림 현상이 발생하므로 배제). 메시는 Istio 앰비언트 모드다(ADR-0082). 노드 프록시(ztunnel)가 모든 서비스 사이 연결을 L4 mTLS로 감싸고, 서비스 사이 gRPC를 받는 서비스만 서비스 단위 웨이포인트가 요청 단위 분산·재시도·시간 초과를 맡는다. 웨이포인트 경로의 p99 증가폭이 2ms를 넘는 서비스만 사이드카로 둔다 [가정, PoC(선택)에서 확정]. 포트폴리오 실행(로컬·CI·데모)은 메시 없이 돈다(docs/verification.md §5.1).
- 중앙 집중형 내부 '서비스 게이트웨이'는 SPOF 및 병목을 방지하기 위해 배치하지 않는다. 노드 프록시와 서비스마다 따로 둔 웨이포인트(여러 AZ에 여러 벌, PDB, 오토스케일)가 라우팅 책임을 나눠 맡는다. 웨이포인트는 서비스 하나만 맡는 작은 프록시라 한 단계를 더 거치며, 그 지연은 PoC(선택) 기준으로 본다(ADR-0082).
- 롤링 업데이트 시 무중단 배포 보장: 쿠버네티스 readiness probe를 통해 웜업이 완료된 정상 파드만 엔드포인트 풀에 편입하고(준비 상태는 공유 의존성을 보지 않는다. 프로브 세 종류의 규칙은 docs/architecture.md §5, ADR-0070), 종료 파드에는 `preStop` 수명주기 훅을 적용하여 엔드포인트 제외 전파가 완료될 때까지 안전하게 대기한 후 프로세스를 종료한다. PodDisruptionBudget(PDB) 설정을 통해 최소 가용 파드 비율을 보장하며 변경 동결 창에는 배포를 시작하지 않는다(POL-028). 단일 리더(admission-ctrl), WebSocket(realtime-gw), Flink 잡, 프론트엔드·PWA처럼 일반 롤링이나 카나리가 맞지 않는 워크로드의 배포 방법은 docs/devops.md §6에 따른다.
- admission-ctrl 분산 리더 선출 메커니즘: Kubernetes Lease 리소스를 성공적으로 획득한 파드가 활성 리더 라벨을 부여받으며, 컨트롤 플레인 전용 Service는 해당 리더 파드만을 엔드포인트로 노출한다. 관제 시스템의 TCP 제어 명령은 본 Service를 통해 리더 파드로 직결된다. 명령을 수신한 리더 파드는 비즈니스 로직을 집행하기 직전 자신이 여전히 Lease 소유권을 유지하고 있는지 재차 검증하고, 대기열 Redis 쓰기는 Lease의 `leaseTransitions`로 얻은 리더 세대를 Lua로 확인해 Lease를 잃은 옛 리더의 쓰기를 거절한다(ADR-0056). Lease 객체를 지우면 세대가 0부터 다시 시작하므로 온세일 윈도우와 변경 동결 창에는 지우지 않고, 다시 만들었으면 진행 중인 회차의 `q:{event:E}:leader`를 지운 뒤 리더를 띄운다.
- Redis Cluster 및 MSK Kafka 클라이언트는 부트스트랩 시 클러스터의 최신 토폴로지 구성을 직접 동적으로 조회하며, 마스터 페일오버나 브로커 재배치 이벤트 발생 시 토폴로지 맵을 즉시 재로드하도록 구성한다.

## 9. 보안 구성 (인프라 측면)

| 보안 계층 | 핵심 인프라 통제 조치 |
| --- | --- |
| 엣지 보안 계층 | AWS WAF(Bot Control 규칙, IP 기반 Rate-based 규칙), AWS Shield Standard DDoS 방어, 관리자 콘솔 경로에 대한 소스 IP 접근 제한(gw-ops는 사전 등록된 사내망 IP 및 VPN 접속만 허용), 응답 보안 헤더(아래 행) |
| 응답 보안 헤더(추천 적용 2026-10-15, ADR-0065 결정 3) | **붙이는 곳**: CloudFront를 거치는 응답(S3 원본의 정적 자산·대기열 파일 포함)은 배포·캐시 동작마다 단 응답 헤더 정책(`peaket-infra`)이, 게이트웨이 응답(CloudFront를 거치지 않는 `gw-scanner` 포함)은 Envoy Gateway 공통 정책(`peaket-gitops`, docs/architecture.md §4)이 붙인다. 응답 헤더 정책의 원본 값 재정의를 끄면 원본이 보낸 값을 두고 없을 때만 정책 값을 붙인다(CloudFront 문서). **정책 값으로 통일(재정의 켬)**: `Strict-Transport-Security: max-age=31536000; includeSubDomains`(preload 목록은 신청하지 않음), `X-Content-Type-Options: nosniff`. **앱이 보낸 값을 둠(재정의 끔)**: CSP(API·정적 파일 기본 `default-src 'none'; frame-ancestors 'none'`, 화면별 정책은 docs/architecture.md §6.3. 소비자 웹은 CDN이 캐시하는 화면(ISR, 대기실·복귀 화면·`/staff/*` 정적 셸)이 해시 방식(SRI), 요청마다 렌더링하는 화면이 nonce다. SRI는 실험 기능이라 PoC 전이다), Referrer-Policy(소비자 웹 `strict-origin-when-cross-origin`이 기본이고 본인확인 복귀 화면은 `no-referrer`, 콘솔·스캐너 `no-referrer`), COOP(소비자 웹 `same-origin-allow-popups`(본인확인 새 창), 좌석맵 라우트 `same-origin`과 COEP, 콘솔·스캐너 `same-origin`. 콘솔의 포렌식 리플레이 2단계 페이지 `/forensics*`는 여기에 COEP `require-corp`를 더함, 출시 뒤 선택). 모든 화면은 `frame-ancestors 'none'`이다. **CORS**: 게이트웨이마다 허용 출처를 화면 호스트 하나로 고정하고(`gw-fan`·`gw-queue`는 `www`, `gw-partner`는 `partner`, `gw-ops`는 `console`, `gw-scanner`는 `scanner`, §4.1) 요청의 `Origin`을 그대로 되돌려 주지 않는다. 쿠키를 받는 API는 `Access-Control-Allow-Credentials: true`와 `Vary: Origin`을 두고, 사전 요청 응답은 `Access-Control-Max-Age: 7200`이다. `queue` API와 `queue-files` 배포(S3 대체 원본 포함)는 `Access-Control-Expose-Headers: Retry-After`를 더한다(`queue-files`는 쿠키가 없어 Credentials를 두지 않는다, ADR-0065 결정 7). **출처 검사(CSRF)**: 쿠키로 인증하는 쓰기 요청의 `Origin`·`Sec-Fetch-Site`를 게이트웨이가 확인한다(docs/architecture.md §4, ADR-0065 결정 5) |
| 네트워크 격리 계층 | AWS 보안 그룹(Security Group) 및 서브넷 네트워크 ACL을 통한 최소 포트 개방 통제(개인정보의 안전성 확보조치 기준 고시 §6① 침입차단시스템 운영 준수), 쿠버네티스 네임스페이스 간 NetworkPolicy 기본 차단(Default Deny), 외부 PG사(토스·포트원) 호출은 전용 NAT 게이트웨이의 고정 탄력적 IP(EIP)를 통해서만 아웃바운드되어 PG사 방화벽 화이트리스트에 사전 등록 [보완] |
| 서비스 간 통신 계층 | 서비스 메시 기반 상호 TLS(mTLS) 전면 암호화 적용(내부망 전송 구간 암호화 의무 준수, 개인정보보호 기술적 안내서 82쪽), 내부 인증 헤더는 API 게이트웨이 및 검증된 내부 신원 파드에서만 주입 가능하도록 제한. TLS 기준은 외부 TLS 1.2 이상·1.3 우선(1.2는 ECDHE와 AEAD 스위트만, CloudFront TLSv1.2_2021 이상), 내부 메시 TLS 1.3, 관리형 저장소는 지원하는 최고 버전이다(Aurora `rds.force_ssl=1`·클라이언트 `verify-full`, ElastiCache 전송 암호화, MSK TLS 1.2. ADR-0050 결정 6). CloudFront에서 원본으로 가는 구간은 HTTPS만(최소 TLS 1.2) 쓰고, 원본 NLB 보안 그룹은 CloudFront 관리형 접두사 목록만 받으며, 게이트웨이는 원본 확인 헤더 값을 확인한다(gw-scanner는 다른 리스너와 mTLS, ADR-0053 결정 9) |
| 저장소 인증 계층 | 저장소마다 서비스 사용자로 인증한다(ADR-0053 결정 9). Aurora는 서비스별 DB 사용자, ElastiCache는 RBAC 사용자(접근 문자열로 명령·키 접두사 제한, 기본 사용자 끔, 전송 암호화 필수), MSK는 IAM 접근 제어(SASL/IAM)와 토픽별 권한, MongoDB는 SCRAM-SHA-256과 TLS(평문 연결 거부), ClickHouse는 역할별 사용자와 TLS 포트만 연다. Pyroscope와 관측 백엔드는 자체 인증을 켜지 않으므로 클러스터 내부 주소와 메시 정책으로만 연다. MongoDB·ClickHouse 볼륨과 모든 저장소 백업은 KMS로 암호화한다 |
| 비밀 정보 및 키 관리 | AWS Secrets Manager와 AWS KMS 관리형 봉투 암호화 결합, External Secrets Operator를 통한 쿠버네티스 시크릿 동적 주입, 서비스별 IAM 역할 기반 최소 권한 부여 원칙 준수. 파드 권한은 EKS Pod Identity로 주고 IRSA는 Pod Identity를 지원하지 않는 곳에만 쓴다(AWS 권고, ADR-0054) (상세 목록은 `docs/security/secrets-and-keys.md` 참조) |
| 인증서 라이프사이클 | CloudFront 및 NLB 전면은 AWS Certificate Manager(ACM)를 통해 자동 갱신, 내부 게이트웨이 인증서는 cert-manager 기반 사설 CA로 자동 발급·관리하고, 게이트 스캐너 기기 인증서는 같은 사설 CA로 관리 앱(Android Enterprise 기기 관리)이 받아 30일 [가정] 주기로 갱신한다(대안 B는 기기 키와 DPoP, ADR-0051), 서비스 메시(제품은 PoC로 선정, wbs 0.5.2)의 내부 CA가 발급하는 단기 인증서 운용. 자동 갱신이 실패하는 경우에 대비해 인증서와 서명 키마다 만료까지 남은 일수를 지표로 내고 30일 이하 SEV3, 7일 이하 SEV2로 알린다 [가정, Phase 4 관측 구축에서 확정]. 근거는 인증서 목록 관리와 지속 감시를 권하는 NIST SP 1800-16이다(ADR-0049, docs/observability.md §5) |
| 소프트웨어 공급망 보안 | GitHub Actions 워크플로우에 OIDC 기반 단기 AWS 임시 자격 증명 연동(장기 IAM Access Key 발급 금지), ECR 이미지 푸시 시 자동 취약점 스캔, cosign 키 없는 서명과 SLSA 출처 증명(공용 재사용 워크플로에서 빌드해 Build L3 목표), gitleaks 시크릿 유출 차단, Renovate 의존성 자동 갱신(새 버전 3일 대기), SBOM(CycloneDX) 생성, 서드파티 액션 전체 SHA 고정과 허용 목록, 워크플로 토큰 최소 권한, 자체 호스트 러너 없음, 취약점 조치 기한(치명 7일·높음 30일·중간 90일, POL-041). 상세는 docs/devops.md §4와 docs/security/asvs/delivery.md(ADR-0054) |
| 침입 탐지 및 감사 모니터링 | 관리 콘솔 비정상 로그인 시도 급증 및 비인가 원격 IP 이상 접근 탐지(trust-svc 및 관제 시스템 연동), AWS WAF 실시간 로깅 분석(고시 §6① 침입탐지시스템 운영 준수) |
| 불변 감사 추적성 보장 | 관리자 계정 접속기록 최소 2년 이상 보존, 시스템 접근 권한 부여 및 변경 내역 최소 3년 이상 보존(NFR-017 준수), 운영 감사 로그의 S3 Object Lock(WORM 모드) 사본 보관, 감사 기록의 키 건 해시 체인·5분 앵커·1시간 대조로 고치거나 지우면 드러나게 함(ADR-0053). 서명한 머클 체크포인트를 매일·회차 마감에 공개 타임스탬프(OpenTimestamps)에 고정해 `www.peaket.example/transparency/`에 게시한다(공개 게시 버킷 Object Lock 7년, 게시 잡의 외부 송신은 캘린더 주소만, ADR-0075) |
| 비상 런북 통제 | 런북 CLI는 클러스터 안 `ops-breakglass` 네임스페이스의 Job으로만 돌고(서명을 확인한 고정 이미지, Kyverno), 메시 mTLS 신원으로 제어 TCP 포트에 연결한다. 포트는 메시 정책과 NetworkPolicy로 ops-svc와 런북 Job 신원만 받는다. 명령 묶음은 서로 다른 두 운영자의 KMS 비대칭 키 서명(ES256, 유효 5분)이 있어야 실행되고(판매 일시정지(명령 3)와 비상 셔플(RB-35)은 서로 다른 commander 두 명), Job을 만드는 권한은 비상 역할(MFA, CloudTrail 기록)에만 있다(ADR-0053 결정 11) |
| 진단 증거 통제(추천 적용 2026-10-20, ADR-0070) | 진단 증거(치명 오류 보고서, 힙 스냅샷, DB·Redis 순간 상태)는 운영 계정의 전용 S3 버킷에만 둔다. 전용 KMS 키의 정책에서 복호화는 긴급 접근 역할만, 서비스 역할은 암호화만 하고, 서비스는 자기 접두사에 쓰기만 한다. 공개 차단·버전 관리, 14일 [가정] 수명 주기 삭제, 읽기는 CloudTrail S3 데이터 이벤트로 남겨 접속기록 월 점검(RB-21)에 넣는다. 파드 진단은 주석 신호로만 부르고 셸·`kubectl exec`·임시 디버그 컨테이너·진단 HTTP 끝점을 쓰지 않으며, Node는 `--disable-sigusr1`로 SIGUSR1 디버거 시작을 끈다. 증거 수집기는 PostgreSQL `pg_monitor`와 `INFO`·`SLOWLOG GET`·`CLIENT LIST`만 허용한 ElastiCache RBAC 사용자로 읽는다 |

## 10. 런북 목차 (예정: `runbooks/` 작성 대상)

| ID | 런북 명칭 | 주요 발동 신호 및 트리거 조건 | 연관 요구사항 및 아키텍처 연결 |
| --- | --- | --- | --- |
| RB-01 | 오픈 T-30분 Pre-flight 체크리스트 점검 | 티켓팅 오픈 30분 전 스케줄러 트리거 | §5, 관제 화면 SCR-029 |
| RB-02 | 프리워밍 실패 대응 (노드 및 파드 프로비저닝 지연) | T-30분 점검에서 목표 최소 복제본 수 미달(T-20분까지 회복하지 못하면 오픈을 입장 일시정지로 시작) | KEDA·Karpenter 스케줄러 점검 |
| RB-03 | 대기열 진입 Degraded 모드 수동 전환 및 해제 (도착 시각 쿠키) | 대기열 진입 레이턴시 p99 > 150ms 2분 지속 또는 Redis CPU 사용률 > 75% | NFR-001, CloudFront 엣지 함수 연동 |
| RB-04 | 대기 상태 파일 S3 사본 고정 전환과 해제(명령 6. 원본 오류 때 요청마다 S3 사본으로 넘기는 것은 CloudFront 원본 그룹이 자동으로 한다, ADR-0078) | 대기열 CDN 캐시 오류율 > 1% 1분 지속 | NFR-002 정적 오리진 우회 |
| RB-05 | 대기열 Redis 마스터 페일오버 후속 조치 (세대 번호 갱신 및 카운터 보정) | Redis 클러스터 장애 조치(Failover) 이벤트 수신 | ADR-0002 순번 무결성 보존 |
| RB-06 | 좌석 Redis 페일오버 대응 (DB 정렬 잠금 비상 경로 활성화 및 비트맵 재구성) | 좌석 Redis 클러스터 장애 조치 이벤트 수신 | NFR-003 비상 예매 경로 |
| RB-07 | 외부 PG사 승인 장애 대응 (재시도 큐 전환, 홀드 만료시간 연장, 신규 결제 진입 통제, 대체 결제사 전환 판단과 2인 승인, ADR-0044) | 결제사 서킷 브레이커 OPEN 또는 결제 확정 소요 p99 > 5초(같은 멱등키 재시도·결과 모름 조회 포함, `payment_confirm_resolution_seconds`. 승인 호출 하나는 2초 기한이라 호출 p99로는 5초를 잴 수 없다, ADR-0069) | NFR-006 결제 장애 격리 |
| RB-08 | ops-svc 장애 시 대역 외 비상 런북 가동 (비상 역할로 런북 Job 실행, 두 운영자 KMS 서명, 메시 신원으로 TCP 긴급 채널 연결, ADR-0053, `peaket-runbook` draft·sign·run, ADR-0062) | ops-svc 파드 다운 또는 관제 채널 단절 | NFR-008 대역 외 제어 |
| RB-09 | 관측 스택 장애와 제어 입력 없음 대응 (데드맨 스위치 발동, 관측 스택과 함께 멈춘 Grafana 대신 외부 합성 점검과 콘솔의 Prometheus 밖 숫자로 상황 판단, 입장 제어가 목표를 유지하는 동안 운영자가 명령 1·2로 판단, 입력이 돌아오면 자동 조절 복귀 확인) | 외부 모니터링 Watchdog 하트비트 수신 중단, 콘솔 SEV2 '자동 제어 입력 없음'(ADR-0069) | docs/observability.md §10 |
| RB-10 | Aurora PostgreSQL 장애 조치 검증 및 PITR 시점 복원 집행 | Aurora 장애 조치 알림 또는 대규모 논리적 데이터 손상 | §6 데이터 백업 원칙 |
| RB-11 | Kafka 컨슈머 Lag 급증 및 브로커 노드 손실 대응, 실패 메시지(DLQ) 재처리(원인을 고친 뒤 DLQ에서 원래 토픽으로 다시 넣기. 멱등 컨슈머가 이미 반영된 메시지는 건너뜀, ADR-0078) | 거래 토픽 소비 지연 30초 [가정]가 1분 이어짐 또는 브로커 오프라인(SEV2, docs/observability.md §5), DLQ 적재 1건 이상(SEV3) | ADR-0026 토픽 파티션 점검 |
| RB-12 | admission-ctrl 리더 파드 긴급 교체 및 Lease 복구 | 리더 부재 30초 [가정] 초과(SEV2, docs/observability.md §5) | §8 분산 리더 선출 |
| RB-13 | Envoy 게이트웨이 파드 대량 손실 및 NLB 가용 영역 마비 대응 | 게이트웨이 정상 가용 복제본 급감 경보 | §4 다중 AZ 부하 분산 |
| RB-14 | 전석 매진 처리 프로세스 점검 (CDN 정적 파일 갱신 및 오리진 차단 확인) | 공연장 잔여 좌석 0건 매진 판정 이벤트 | POL-015 매진 확정 규칙 |
| RB-15 | 비상 자동화 정지 스위치 발동 후 시스템 정상 복귀와 사후 검토 보고서(48시간 작성, 7일 검토, ADR-0062) | 관리자 긴급 정지 스위치 집행 시 | POL-021 C-4 운영 명령 |
| RB-16 | 법정 처리 기한 대응 (불법 게시물 24시간 내 차단, 수사기관 제공 대장 처리) | SEV2 법정 기한 임박 알림 | POL-024, POL-025 법적 통제 |
| RB-17 | 장애 종결 후 48시간 이내 포스트모템 작성 및 보고서 배포 | 인시던트 공식 종료 선언 시. 선언 기준은 POL-022(SEV1, 불변식 위반 의심, 명령 2·3·6 실행, SEV2 15분 [가정] 넘게 미해결, 온세일 예산 50% 이상, 사고 하나가 28일 예산 20% 넘게 사용, 사람·외부가 먼저 발견)이고 초안에 탐지 경로(경보·사람·외부)를 적는다(ADR-0069) | POL-022 장애 관리 규정 |
| RB-18 | 리전 전면 장애 대응: 판매 즉각 중단, 공지 게시, 교차 리전 복원(ticket 보조 클러스터 떼어 내기 포함) 및 PG 정산 대사 | AWS 리전 단위 전면 마비 공지 및 다수 핵심 서비스 불능 | §6, ADR-0031 재해 복구 |
| RB-19 | 예매 취소 및 환불 처리 지연 대응 (PG 취소 실패 건 재시도, 조회 API 기반 상태 동기화) | 환불 대기 큐 적체 건수 임계치 초과 경보 | POL-032 환불 정책 |
| RB-20 | 보안 사고 신고·통지 (침해사고 24시간 신고와 추가 사실 24시간 재신고, 공격으로 2시간 넘게 이어진 장애의 이용자 통지, 피해구제 조치 14일 안 과학기술정보통신부장관에게 제출(정보통신망법 §48의10②, 시행령 §60의16), 개인정보 유출등 72시간 통지·신고, 증거 보존과 피해 확산 방지) | 보안 사고 등록(SEV1), 신고·통지 기한 임박(SEV2) | FR-063, 정보통신망법 §48의3, 개인정보 보호법 §34, ADR-0049 |
| RB-21 | 접속기록 정기 점검과 이상 건 사후조치 (월 1회 점검, 사유 확인, 회수·파기 요청, 권한 회수, 유출 의심이면 RB-20) | 월 점검 일정, 매일 이상 탐지 등록, 월말 미완료(SEV3) | FR-064, 안전성 확보조치 기준 §8②, ADR-0049 |
| RB-22 | 스캐너 기기 분실·도난 대응 (SCR-053에서 즉시 폐기와 스태프 세션 종료, 파트너·현장 책임자에게 알림, 예비 기기 투입과 기기 배치, 그 기기의 미전송 기록 손실 범위를 CS 처리함에 기록, 회수하면 재등록 뒤 남은 기록 업로드) | 현장 분실·도난 신고, 폐기된 기기의 접속 시도 | FR-065, ADR-0051, docs/features/offline-gate.md §6.1 |
| RB-23 | 배포 되돌리기와 동결 중 긴급 변경 (카나리 중단, Git 되돌리기와 `rollbackWindow` 빠른 복귀, `emergency-change` 라벨과 인시던트 번호, commander 수동 동기화, 포스트모템) | 카나리 자동 중단 경보, 배포 직후 SLO 소진, 온세일 중 배포 원인 의심 | POL-028, POL-041, ADR-0054, docs/devops.md §6.7·§8.4 |
| RB-24 | DB 마이그레이션 실패와 잠금 대기 (재시도·중단 판단, 부분 적용 확인, 트랜잭션 밖 단계 정리, 앞으로 고침) | PreSync 마이그레이션 잡 실패, `lock_timeout` 반복 | docs/devops.md §7 |
| RB-25 | 배포 경로 장애 (GitHub Actions·ECR·ArgoCD·Sigstore 경로별 대체, 긴급 접근 적용과 사후 GitOps 정합) | 승격 실패 연속, 동기화 오류, 서명 실패 | docs/devops.md §10.2 |
| RB-26 | 비밀 유출 대응 (즉시 폐기와 재발급, 사용 이력 조사, 저장소 이력 정리, 보안 사고 해당 여부는 RB-20) | gitleaks 탐지, 비밀 사용 이상(CloudTrail), 외부 제보 | secrets-and-keys, docs/devops.md §4.5 |
| RB-27 | 입장 정책 검증 실패로 파드가 뜨지 않음 (서명·출처·Kyverno 장애, 검증 경로 확인, 정책 예외는 commander 승인과 만료) | 파드 생성 거부 급증, Kyverno 웹훅 오류 | docs/devops.md §4.3, Game Day G-20 |
| RB-28 | 변경 동결 달력 장애와 창 누락 (수동 창 등록 `argocd proj windows add`, Karpenter 예산 수동 적용, 달력 복구) | 달력 신선도 SEV2, T-30분 점검 '동결 창 적용' 실패 | POL-028, docs/devops.md §8.2 |
| RB-29 | 관리형 서비스 예정 유지보수와 플랫폼 버전 올리기 (예정 이벤트 확인, 일정 조정, 정비 시간 실행, EKS 표준 지원 종료 대비) | AWS Health 예정 이벤트, EKS 표준 지원 종료 90일 전 | docs/devops.md §8.3·§9.4 |
| RB-30 | 오토스케일 정지와 수동 고정 (KEDA ScaledObject에 미리 만든 `autoscaling.keda.sh/paused-replicas` 패치를 긴급 변경으로 적용(긴급 변경 허용 목록에는 이 패치만 있다, devops §8), 원인 확인 뒤 주석을 지워 재개, 포스트모템) | 오토스케일이 잘못 움직임(새 판이 일 없이 CPU를 쓰며 계속 늘림, 실패하는 의존성에 요청이 쌓여 늘림, 복제 수가 크게 흔들림), 명령 11과 함께 오토스케일도 멈춰야 할 때 | POL-021, POL-041, ADR-0069, docs/devops.md §8.4 |
| RB-31 | 진단 증거 보존(재시작 전): 긴급 접근으로 파드 하나에 주석 `peaket.io/diagnose`(값은 `report`·`heap`과 요청 시각, 처리한 요청은 `/diag`에 표시해 다시 뜬 뒤 되풀이하지 않음)를 달면 그 파드가 준비 상태를 내리고 진행 중인 일을 최대 10초 [가정] 마감한 뒤 진단 보고서(힙 스냅샷은 메모리 여유가 힙의 두 배를 넘을 때만)를 진단 증거 저장소에 올리고 다시 뜬다. 나머지 파드는 기다리지 않고 바로 다시 띄운다(피해 격리 먼저). 증거 수집기의 DB·Redis 스냅샷과 쿠버네티스 이벤트(Loki)를 함께 인시던트에 묶는다. 보안 사고가 의심되면 RB-20이 먼저다 | 재시작이 필요한 장애(이벤트 루프 멈춤, 메모리 증가, 원인 모를 오류 증가), 자원 누수 의심 경보 | ADR-0070, docs/observability.md §5·§9, docs/devops.md §10.2 |
| RB-32 | 느린 쿼리·긴 트랜잭션 끊기: 긴급 접근의 DB 조회 경로(SSM, IAM DB 인증, pgAudit)로 운영 역할 `ops_signal`(`pg_signal_backend`)을 써서 `pg_stat_activity`와 `pg_blocking_pids()`로 대상을 찾고, `pg_cancel_backend`로 쿼리만 취소한 뒤 10초 [가정] 뒤에도 남으면 `pg_terminate_backend(pid, 5000)`로 세션을 끊는다. 앱 풀의 재연결을 확인하고 쿼리 ID를 포스트모템에 남긴다 | 잠금 대기로 핫패스 p99 상승, 서버 상한(`statement_timeout`)이 긴 역할(배치·마감)의 쿼리가 DB를 붙잡음, 증거 수집기 스냅샷의 긴 대기 | ADR-0070, docs/architecture.md §5, docs/devops.md §10.3 |
| RB-33 | 처리량 급감(오류 없는 장애) 대응: 퍼널에서 막힌 단계를 찾고, 그 화면의 브라우저 오류(Sentry 새 오류 종류)·CSP 위반·결제사 SDK 로드 실패·최근 프런트엔드 배포를 본다. 최근 변경이면 되돌리기(RB-23), 결제 단계면 결제사 상태와 명령 6 검토, 원인을 모르면 명령 2로 들어오는 사람을 멈추고 엔지니어를 부른다 | SEV2 처리량 급감(온세일 단계 비율, 평시 지난주 대비) | ADR-0070, docs/observability.md §5 |
| RB-34 | Flink 잡 복구: ① Operator 상태(FlinkDeployment `status`)와 쿠버네티스 이벤트로 멈춤·되풀이 실패·업그레이드 실패를 가른다 ② 의존성 장애면 회복을 기다리고(docs/streaming.md §12), 코드 문제면 이전 이미지로 같은 세이브포인트 업그레이드를 한다 ③ 세이브포인트가 맞지 않으면 커밋된 오프셋에서 다시 시작하고 `ops-rt`는 마감 실행기의 시작값 명령으로 `rt.seed`를 만든다 ④ 원본 적재의 빈 구간과 거절 구간을 Kafka 보관(7일) 안에서 다시 적재한다 ⑤ 마감 리포트의 실시간 대비 대조와 커버리지를 확인한다 | Flink 잡 신호 SEV3(재시작 되풀이, 소비 대기 증가, 거래 소스 쉼, 체크포인트 연속 실패, 적재 거절), 관제 실시간 표 신선도 Degraded | ADR-0071·0072, docs/streaming.md §4.7·§8·§14 |
| RB-35 | 셔플 비콘 지연과 비상 셔플: ① 공시한 drand 라운드와 여러 공개 중계 주소의 상태, 대기실의 '순서 계산 중' 표시를 확인한다 ② 상한 60초가 지나 셔플이 멈췄으면 더 기다릴지 commander가 정한다(직전 공개 라운드로 대신하지 않는다) ③ 시드만 쓰는 비상 셔플은 런북 CLI로 서로 다른 commander 두 명이 각자 KMS 키로 서명한 묶음만 실행된다(되돌릴 수 없음) ④ 실행 뒤 검증 페이지에 사유와 한계('이 경우 시드를 아는 내부자가 결과를 미리 알 수 있다')를 공시하고 대기실 공지(명령 7)를 낸다 ⑤ 포스트모템(RB-17) | 셔플 비콘 대기 상한 초과 SEV1(셔플 멈춤) | POL-005, ADR-0050 결정 7, ADR-0073, docs/features/queue-admission.md §2 |
| RB-36 | 불변식 위반 의심 대응: ① 의심 건의 회차·좌석·주문·결제를 불변식 SQL(wbs 1.2.3)과 감사 기록으로 확인한다 ② 실제 위반이면 판매 일시정지(명령 3)를 검토하고, 오버셀은 좌석 판매 상태와 비트맵을 대조해 다시 맞춘다(RB-06 절차) ③ 이중 결제는 결제사 조회로 확정한 뒤 같은 멱등키로 취소해 돌려준다 ④ 60초 넘은 결제-발권 불일치는 보상(결제 취소 또는 다시 발권)으로 정리한다 ⑤ 인시던트로 선언하고(POL-022) 포스트모템(RB-17) | 불변식 SEV1(오버셀 의심, 이중 결제 의심, 60초 넘게 정리되지 않은 결제-발권 불일치) | NFR-003·006, POL-022, ADR-0073, docs/features/payment.md, docs/features/seat-hold.md |

원인 유형별 런북 색인(추천 적용 2026-10-21, ADR-0078 결정 4): 원인 유형은 docs/observability.md §5에 있고 포스트모템의 주 원인 유형과 같은 이름이다. 한 런북이 여러 유형에 들 수 있다.

| 원인 유형 | 먼저 볼 런북 |
| --- | --- |
| 변경 | RB-23(되돌리기·동결 중 긴급 변경), RB-24(DB 마이그레이션), RB-25(배포 경로), RB-27(입장 정책 검증), RB-28(동결 달력), RB-29(관리형 유지보수·버전 올리기) |
| 외부 의존 | RB-07(결제사 승인), RB-19(결제사 취소·환불 지연), RB-35(셔플 비콘), RB-04(대기 상태 파일 CDN·원본) |
| 내부 저장소·메시징 | RB-05·RB-06(대기열·좌석 Redis), RB-10(Aurora), RB-11(Kafka·DLQ), RB-32(느린 쿼리·긴 트랜잭션), RB-34(Flink) |
| 용량·포화 | RB-02(프리워밍), RB-03(진입 Degraded), RB-30(오토스케일 정지·수동 고정) |
| 코드 결함 | RB-23(되돌리기), RB-31(진단 증거), RB-36(불변식 위반 의심) |
| 데이터 | RB-36(불변식 위반 의심), RB-10(시점 복원), RB-24(부분 적용된 마이그레이션) |
| 보안 | RB-20(보안 사고 신고·통지), RB-22(스캐너 분실·도난), RB-26(비밀 유출) |
| 운영 조작 | 명령의 되돌리기(docs/features/control-tower.md §3), RB-15(비상 정지 뒤 복귀) |
| 기반 | RB-08(ops-svc 장애·대역 외 런북), RB-09(관측 스택·제어 입력 없음), RB-12(admission-ctrl 리더), RB-13(게이트웨이·가용 영역), RB-18(리전 장애) |
| 원인과 관계없는 절차 | RB-01(오픈 전 점검), RB-14(매진 처리), RB-16(법정 처리 기한), RB-17(포스트모템), RB-21(접속기록 점검), RB-31(진단 증거), RB-33(처리량 급감에서 막힌 단계 찾기) |

Game Day 26종(K8 장애 주입 시험 10종, 관제 시스템 자체 감시 4종, 마이크로서비스 장애 격리 3종, 보안 사고 모의훈련 1종, 변경 안전 3종, 자동 제어 안전 2종, 장애 대응 3종)의 상세 시나리오 목록은 docs/observability.md §12에 명시되어 있으며, 각 테스트 시나리오는 상기 런북의 실제 실행을 통해 절차적 유효성을 정기 검증한다.

## 11. 비용 통제 (FinOps)

- 로컬 개발과 측정은 kind/k3d와 LocalStack으로 무료 로컬 자원에서 한다. 100만 명 전체 클라우드 부하 시험은 하지 않고(요청 요금만 지출 상한을 넘음), 클라우드는 선택 보정(환산 계수 1회 약 4달러, CloudFront 무료 범위 확인)만 TTL과 예산 경보를 걸고 쓴다(ADR-0057, docs/verification.md §6).
- 클라우드 비용 할당 태그와 AWS Cost Explorer, 그리고 OpenCost를 연동하여 온세일 이벤트 1회당 발생 인프라 비용과 티켓 1,000장 발권당 단위 비용을 객관적으로 계측한다(K9). 가용 영역(AZ) 간 NLB 교차 데이터 전송 비용 또한 정밀 추적한다. 이것은 운영 설계이고, 포트폴리오 기간의 K9 비용은 가격표와 외삽한 요청 수로 낸 추정이다(ADR-0057).
- 인프라 코드의 비용 영향을 사전에 통제하기 위해 모든 Terraform 변경 PR에 Infracost 분석 봇을 연동하여 월별 예상 비용 증감 내역을 자동으로 코멘트한다.
- 상시 데모 환경은 두지 않는다. AWS EKS에 두면 노드·DB를 빼고도 EKS 제어 평면·NAT 게이트웨이·NLB만으로 월 약 133달러(서울 리전 가격, 2026-10-13 조회)라 소유자 지출 상한과 맞지 않기 때문이다(질문 24 결론, ADR-0057). 데모는 로컬 실행 녹화 영상과 재현 스크립트이고, 면접·발표 때만 임시 클라우드를 TTL로 띄운다. 스테이징·운영 구성은 포트폴리오 기간에 띄우지 않는다(ADR-0031, ADR-0057). 온콜 및 모니터링 도구는 Grafana Cloud 및 신뢰할 수 있는 오픈소스 무료 티어를 최우선 조합하여 운용한다(ADR-0032).
- 비용 가드레일: AWS Budgets 월 예산 경보(경보만 쓰는 예산은 무료), 비용 이상 탐지, 측정 스택의 `ttl` 태그 필수(기본 6시간 [가정])와 매시 자동 삭제, 시작 전 'Infracost 시간당 추정 × TTL ≤ 남은 예산' 확인을 둔다(docs/devops.md §11, POL-041, ADR-0054).
- Kafka 텔레메트리 클러스터는 거래·제어 클러스터와 물리적으로 나눈다(ADR-0026 원칙, §1 구성도의 MSK ×2). Flink 소스·IAM·네트워크 정책(docs/streaming.md §2)이 두 클러스터를 전제로 짜여 있어, 합치려면 그것까지 바꾸는 새 ADR로 한다(ADR-0073). 관측 전용 클러스터(Tempo 쓰기 경로)는 이 둘과 따로 둔 세 번째 클러스터다(ADR-0077).

