# 설계: 기반 PoC(wbs 0.5.1)

## Context

docs/architecture.md §9.4는 PoC로 먼저 볼 위험과 공식 판정 기준을 정한다. 이 변경은 그 가운데 wbs 0.5.1의 몫을 잰다: Redis 한 키 `INCR` 20만/s, Redis 클라이언트 셋 비교(V-T33), 좌석 샤드 하나의 처리량(S-T27), HTTP 어댑터·검사 방식(V-T41), Kafka 기본 클라이언트와 MSK IAM 토큰 함수(ST-T14 ①), 키 단위 소비 전체(ST-T18). 측정 환경은 PC 한 대다(성능 장부 프로파일, docs/perf-ledger.md §4). 소유자는 외부 계정·클라우드 비용 없이 진행하기로 했다(2026-10-31 결정).

## Goals / Non-Goals

- Goals: 정본의 판정 기준대로 재고, 결과를 '실측(PC)'으로 성능 장부에 남기고, 판정을 새 ADR과 정본에 적는다. FND-070·090이 넘긴 코드 몫(MSK IAM 토큰 함수를 공용 설정 함수에 붙이기, ST-T18 전체)을 시험부터 만든다.
- Non-Goals: 실제 MSK·EKS에서 자격 갱신을 넘는 재인증(ST-T14 ②, 선택 클라우드 보정 `cloud-msk-iam`, 소유자 몫). 게이트웨이·인증·멱등을 포함한 실제 서비스 경로의 홀드 p99(S-T1, wbs 2.x). 운영 홀드 Lua(seat-hold wbs 2.x). Kafka TLS(MSK는 TLS지만 PoC 브로커는 평문).

## Decisions

1. **측정 무대는 kind가 아니라 같은 Docker 망의 컨테이너다**(추천 적용 2026-11-01). Valkey 클러스터(주 노드 셋·복제 셋), Kafka 3.9.2 셋, 측정 도구, V-T41 앱과 k6가 한 망 `peaket-poc`에 있고 컨테이너마다 CPU 한도를 둔다. kind 클러스터에는 Strimzi·PostgreSQL·흉내 서버가 함께 돌아 구성 요소 하나를 재는 측정에 잡음이 되고, Docker Desktop 포트 전달을 거치면 그 비용이 측정에 섞인다. 성능 장부에 이 구성을 프로파일 `local-poc`로 더한다(docs/perf-ledger.md §4).
2. **측정 도구는 뿌리 작업 공간 밖의 작은 작업 공간이다**(`loadtest/poc/bench`, 자기 잠금 파일과 같은 보안 설정). Valkey GLIDE가 Windows 실행 파일을 내지 않아(2.5.3의 플랫폼 묶음은 Linux·macOS뿐) Linux 컨테이너에서만 돈다. 뿌리 작업 공간에 넣으면 모든 개발 설치와 CI 설치에 GLIDE·ioredis가 붙는다. V-T41 앱은 플랫폼 원본을 그대로 써야 해서 `packages/platform/bench/vt41`에 둔다(Express 어댑터는 플랫폼 개발 의존성).
3. **오픈 모델**: Node 측정 도구는 1ms마다 밀린 만큼 요청을 내고 지연을 '보내기로 한 시각'부터 잰다. 동시에 기다리는 요청이 상한을 넘으면 보내지 않고 '못 보낸 요청'으로 세며, 하나라도 있으면 무효다(k6 `dropped_iterations`와 같은 규칙). V-T41은 k6 `constant-arrival-rate`다. 최대 처리량은 닫힌 모델로 따로 재고 장부에 닫힌 모델로 표시한다.
4. **엔진 쪽 지연**: Valkey `latency-tracking`(`INFO latencystats`)과 SLOWLOG(10ms)로 잰다. 홀드 Lua만 EVALSHA(클라이언트의 스크립트 도구)로 보내고 스냅샷은 EVAL_RO, 만료 작업은 EVAL로 보내 명령 이름으로 나눈다.
5. **PoC 홀드 Lua는 대역이다**: 정본 실행 계약(seat-hold §3)의 키를 같은 횟수로 만진다(세대·정지 사본·멱등·보유 수·비트·홀드 Hash·만료 인덱스·사건 흐름·구역 일련번호). 오버셀은 회차마다 Lua가 늘리는 순번으로 좌석마다 잡기·놓기가 번갈아 오는지와, 끝에 켜진 비트 수 = 만료 인덱스 수로 본다.
6. **MSK IAM 토큰 함수**: `generateAuthTokenFromRole`로 작업자 전용 역할을 고정 세션 이름 `<작업자>-<환경>`으로 맡는다. 공용 설정 함수는 인증을 고르면 KafkaJS 호환 묶음에 TLS와 OAUTHBEARER 토큰 함수를 싣고(클라이언트가 `security.protocol=sasl_ssl`을 만든다), 덧붙일 설정으로 보안 방식·SASL 이름을 못 바꾸게 한다(겉의 librdkafka 값이 호환 묶음을 이긴다). 환경 값 `PEAKET_KAFKA_AUTH=msk-iam`·`PEAKET_KAFKA_MSK_ROLE_ARN`·`AWS_REGION`으로 고른다. 토큰 만료 값은 '지금부터 몇 ms'가 아니라 만료 시각(epoch ms)이다(librdkafka `md_lifetime_ms`). 시험은 가짜 STS(`AWS_ENDPOINT_URL_STS`)로 한다.
7. **ST-T18 강제 종료는 자식 프로세스를 SIGKILL로 죽인다**: 같은 프로세스에서 끊으면 그룹을 떠나 재조정이 바로 일어나 '죽음'이 아니다. 자식은 빌드한 플랫폼(dist)을 쓴다(원본 TS에 Node 타입 지우기로 돌지 않는 문법이 있다). 커밋 위치는 브로커 쪽 도구(`kafka-consumer-groups.sh`)로 읽는다: 같은 프로세스에서 소비자가 도는 동안 Confluent 관리 연결로 `fetchOffsets`를 거듭 부르면 Windows에서 프로세스가 네이티브 오류(0xC0000005)로 죽었다. Linux 측정 컨테이너에서는 같은 일(30초 110번)에 죽지 않았다.
8. **판정 기록**: 결과와 판정은 새 ADR(ADR-0176)에 모으고, 정본의 시험 행·§9.4 행·설정 이름을 고친다. 정본 기준이 없는 값(Kafka 거래 토픽 `acks=all` p99 100ms)은 추천 적용으로 적는다.

## Risks / Trade-offs

- PC 한 대: 발생기와 대상이 CPU를 나눠 쓴다. 컨테이너 CPU 한도만 두고 코어는 고르지 못한다(WSL). 호스트 CPU·실행 대기 수를 측정마다 남긴다.
- PoC 홀드 Lua와 PoC 앱은 운영 코드가 아니다. 운영 코드가 생기면(wbs 2.x) 같은 측정 도구로 다시 잰다.
- TLS: Valkey는 켬·끔 짝으로 잰다(판정은 켬). Kafka는 평문만 쟀다.
