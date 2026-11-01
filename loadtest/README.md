# loadtest/

부하 시험이 들어갈 자리다. k6 시나리오(오픈 모델 도착률)와 카오스 실험 스크립트를 둔다. 합성 봇 시뮬레이터는 공개하지 않으므로 여기 두지 않고 비공개 저장소 `peaket-bots`에 둔다(POL-026).

- 측정 규칙과 기록: [docs/perf-ledger.md](../docs/perf-ledger.md), 저장소 구성: [docs/devops.md](../docs/devops.md) §2.1, 결정: ADR-0169
- 처음 채우는 작업: wbs 1.2.1(k6 시나리오).
- `poc/`: 기반 PoC 측정 틀(wbs 0.5.1, [poc/README.md](poc/README.md)). Redis 한 키·클라이언트 셋·좌석 샤드, HTTP 어댑터·검사 방식, Kafka 기본 클라이언트를 PC의 Docker 망 안에서 잰다.
