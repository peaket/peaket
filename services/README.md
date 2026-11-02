# services/

서버에서 도는 배포 단위가 모두 들어갈 자리다. 서비스 10개, 스트림 작업자, 작업(CronJob·Job) 이미지를 `services/<이름>`에 하나씩 둔다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 서비스를 나눈 근거: 같은 문서 §3
- 처음 채우는 작업: wbs 0.3(서비스 템플릿)과 Phase 1(v0).
- 지금 있는 것(2026-11-02, wbs 1.2.3·1.1.1):
  - `invariant-checker`: 불변식 검사기. 시험이 끝난 뒤 서비스 DB와 시험 기록을 대조해 차례 전 입장·순번 중복·오버셀·1인 한도 초과·이중 결제·결제-발권 불일치·정산 돈 불변식을 센다([docs/verification.md](../docs/verification.md) §2.5). 명령 `peaket-invariants`
  - `pg-simulator`: 결제사(PG) 흉내 서버. 토스페이먼츠 모양 API와 시험용 장애 넣기. 로컬·CI·데모·스테이징 전용([docs/features/payment.md](../docs/features/payment.md) §2.1)
  - `payment-svc`: 결제 모듈의 결제 포트·시뮬레이터 어댑터·공통 계약 시험만 있다. 서비스 나머지는 v0·v1 결제 단계에서 서비스 뼈대(`packages/platform/template`)로 채운다
  - `v0-monolith`: v0 모놀리스. K1~K10을 v1과 견주는 '처음 만들 법한 단순한 설계'의 비교 기준선이고 운영에 배포하지 않는다. 모듈 경계는 v1 서비스와 같다([docs/architecture.md](../docs/architecture.md) §9.3). 지금은 대기열 v0(`queue` 모듈: 조회마다 `ZRANK`로 앞 인원을 세는 대기 상태 API, [docs/features/queue-admission.md](../docs/features/queue-admission.md) §13)만 있다. 실행은 `PEAKET_V0_REDIS_URL`
