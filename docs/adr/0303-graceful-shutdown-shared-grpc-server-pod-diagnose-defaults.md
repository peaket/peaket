# ADR-0303: 우아한 종료는 공용 gRPC 서버와 종료 차례로 하고, 파드 진단 수집의 첫 구현 값을 정한다(2026-11-19)

- **상태**: 채택(추천 적용, 2026-11-19, BAT-075 계획, 전체 감독 결정으로 ADR 하나에 모음). 이 묶음에서 쓴 추천 값이라 소유자 결정이 아니다. [ADR-0082](0082-istio-ambient-mesh-app-boundary-meshless-portfolio-runs.md)의 '메시 없는 실행에서는 우아한 종료가 롤링 재시작 때 요청을 지킨다'와 [ADR-0070](0070-incident-response-evidence-probes-timeouts-throughput-soak.md) 결정 1 '수동(RB-31)'·결정 2 '프로브'를 구현하는 값이다. 두 ADR의 결정은 바꾸지 않는다.
- **관련**: [docs/devops.md](../devops.md) §6.4 '일반 서비스'·§14 D-T18·D-T19·D-T27·§15 '운영 진단 경로', [docs/architecture.md](../architecture.md) §5 '프로브 규칙', [docs/observability.md](../observability.md) §3 'gRPC 서버 지표'·'진단 수집 지표', [docs/security/asvs/delivery.md](../security/asvs/delivery.md) 14.2.1·14.2.2, [docs/infra.md](../infra.md) RB-31, 계획 [docs/review/plans/BAT-075.md](../review/plans/BAT-075.md)
- **관련 ID**: D-T18, D-T19, D-T27, D-T29, BAS-080, ASVS v5.0.0-14.2.1·14.2.2·16.5.2

## 맥락

- 옛 정본(devops §6.4)은 '서비스 템플릿이 NestJS `app.enableShutdownHooks()`와 gRPC 마이크로서비스 옵션 `gracefulShutdown: true`를 켠다'고 적었다. 그런데 PEAKET 서비스는 NestJS gRPC 마이크로서비스를 쓰지 않는다. 업무 gRPC 포트는 서비스 여섯(identity·payment·purchase·queue·ticket·trust)이 저마다 grpc-js로 열었고, 부하 분산 프로필은 모두 `'service'`로 박혀 있었다.
- SIGTERM 처리는 서비스 시작 파일마다 따로였고, 준비 상태를 내리는 서비스와 내리지 않는 서비스가 섞여 있었다.
- ADR-0070은 파드 진단의 차례(준비 내림 → 마감 → 보고서 → 스냅샷 → 올리기 → 끝내기)만 정했다. 주석을 언제 읽는지, 준비를 내린 뒤 얼마나 기다리는지, 다시 뜬 뒤 되풀이를 무엇으로 막는지, 저장소 설정이 없을 때 어떻게 하는지는 비어 있었다.
- docs/features/bot-defense.md §15는 'gRPC 호출별 오류 지표는 서비스 템플릿의 gRPC 서버 틀이 생겨야 나온다'고 기다리고 있었다.

## 결정

1. **우아한 종료는 공용 gRPC 서버와 종료 차례로 한다**:
   - `createService`가 SIGTERM을 받자마자 준비 상태를 내린다(남은 작업 `shutting-down`). 서비스의 종료 처리기보다 먼저 건다. `/livez`는 끝날 때까지 200이다.
   - 업무 gRPC 포트는 `packages/platform`의 공용 서버로 연다. 닫을 때 새 호출을 받지 않고(`tryShutdown`) 처리 중인 호출을 10초 [가정]까지 기다린다. 넘었을 때만 끊는다(`forceShutdown`). 호출이 끝나면 바로 돌아온다.
   - 서비스 시작 파일의 SIGTERM 처리기가 공용 종료 차례를 부른다: gRPC 마감 → 돌던 일 멈춤 → 그 일을 받는 쪽 멈춤 → 앱 닫기 → 연결 닫기. 앞 단계가 실패해도 다음 단계를 하고, 두 번 불러도 한 번만 한다.
   - NestJS `app.enableShutdownHooks()`는 켜지 않는다. 켜면 같은 신호에 Nest가 앱을 따로 먼저 닫아 gRPC 마감·서비스별 종료 차례와 겹친다. 앱을 닫는 `app.close()`가 모듈의 종료 훅을 부른다.
   - 서버 옵션은 공용 설정의 부하 분산 프로필(`PEAKET_GRPC_LB_PROFILE`)을 쓴다. 포트는 `PEAKET_GRPC_PORT`(기본 50051 [가정], 1~65535)다. 0(빈 포트)은 local·ci 시험에서만 받는다. payment-svc(50051)·ticket-svc(50052)는 이미 있던 자기 설정 포트를 그대로 쓴다.
2. **gRPC 서버 지표 이름**: `rpc_server_call_duration_seconds{service, method, code}`(OpenTelemetry `rpc.server.call.duration`). `method`는 proto 이름이고 등록 밖 메서드는 `unknown`, `code`는 gRPC 상태 이름, 마감을 넘겨 끊은 호출은 `CANCELLED`다. 등록 밖 메서드를 세려고 grpc-js 1.14의 내부 처리기 찾기(`_retrieveHandler`)를 감싼다. 그 함수가 없는 판에서는 감싸지 않고 그 호출만 세지 않으며, 등록 밖 메서드 시험이 실패해 판 올림 때 알아챈다.
3. **파드 진단 수집(RB-31)의 첫 구현 값**:
   - 주석 `peaket.io/diagnose`(값 `report` 또는 `heap`과 `@<UTC 시각>`)를 Downward API 파일에서 5초 [가정]마다 읽는다. 형식에 맞지 않는 값은 경고 한 번만 남기고 무시한다.
   - 준비를 내리고(남은 작업 `diagnosing`) 새 일을 멈춘 뒤 30초 [가정](준비 프로브 5초 × 연속 6회) 기다려 Service에서 빠질 시간을 준다. 그동안 HTTP는 그대로 받는다. 그다음 진행 중인 일을 최대 10초 [가정] 마감한다.
   - 힙 스냅샷은 (메모리 한도 − RSS) > 2 × 쓰는 힙일 때만 뜬다. 한도 값이 없으면 건너뛰고 까닭을 남긴다.
   - 증거 객체 이름은 `<서비스>/<파드>/<요청 시각>/<파일>`뿐이다. 올리기에 성공한 파일만 지운다. 처리한 요청 값은 `/diag` 안 표시 파일에 남겨, 다시 뜬 뒤 같은 요청을 되풀이하지 않는다. 다 하면 자기에게 SIGTERM을 보내 결정 1의 종료 차례로 끝나고 kubelet이 다시 띄운다. 시작할 때 `/diag`에 남은 보고서도 올리고 지운다.
   - 수집은 주석 파일 환경 값(`PEAKET_DIAG_ANNOTATIONS_FILE`, 공용 차트가 넣는다)이 있을 때만 켜진다. 그때 증거 저장소 설정이 없으면 local·ci는 경고 한 줄과 함께 끈다(버킷과 moto 주소가 둘 다 있어야 켠다). 그 밖의 환경은 빠진 이름을 대며 시작하지 않는다.
   - Outbox 릴레이 프로세스에는 이번에 진단 수집을 붙이지 않는다. 실행 옵션(`--disable-sigusr1`·치명 오류 보고서)은 공용 차트가 릴레이 파드에도 준다.
   - 결과 지표는 `diagnose_collections_total{service, result}`다.
4. **프로브 값**: 공용 차트의 준비 프로브를 정본 값(5초·3초·6회)으로 맞춘다. 로컬 kind에서 이벤트 루프를 2초씩 막는 비교(D-T19 ③④)를 근거로 남긴다. 온세일 부하의 이벤트 루프 지연 p99로 다시 보는 일은 측정 창 BAT-095가 한다(전체 감독 결정 2026-11-19).

## 결과

- 서비스 여섯의 `src/grpc-server.ts`가 공용 서버를 부르는 얇은 파일이 되고, 부하 분산 프로필이 실제로 서버 옵션에 걸린다.
- 종료 차례 시험(D-T27)과 진단 수집 시험(D-T18 ①)은 `packages/platform`과 로컬 kind에서 본다. `--disable-sigusr1`이 없는 파드를 거부하는 정책(D-T18 ②)은 BAS-150이다.
- 남는 것: 서비스마다 따로인 SIGTERM 처리기를 공용 감싸개로 모으는 일, 릴레이 파드의 진단 수집, 운영 kubelet에서 주석이 파일에 닿는 시간.

## 다른 선택지

| 선택지 | 고르지 않은 까닭 |
| --- | --- |
| NestJS gRPC 마이크로서비스로 바꾸고 `gracefulShutdown: true` | 서비스 여섯의 gRPC 처리기와 내부 토큰 검사를 다시 써야 하고, 종료 때 Nest가 서버를 닫는 차례를 서비스별 종료 차례와 맞출 수 없다 |
| `enableShutdownHooks()`를 켜고 서비스 처리기를 Nest 종료 훅으로 옮김 | 같은 신호를 두 곳이 받으면 차례가 엇갈린다. 앱 닫기가 gRPC 마감보다 먼저 끝날 수 있다 |
| 진단 때 준비를 내리자마자 마감 | 준비 프로브가 30초 동안 파드를 Service에 두므로 그 사이 들어온 요청이 끊긴다 |
| 진단 주석을 `fs.watch`로만 봄 | Downward API 파일은 링크를 바꿔 고쳐져 알림을 놓칠 수 있다. 5초 읽기가 단순하다 |
| 저장소 설정이 없으면 어느 환경이든 경고만 | 운영에서 진단 요청이 조용히 사라진다 |
