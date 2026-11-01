# 작업: 기반 PoC(wbs 0.5.1)

## 1. 성능 장부 도구: k6가 아닌 측정 도구의 요약

- [x] 1.1 실패하는 시험 쓰기: `collect.py --selftest`에 측정 도구 요약(`--bench-summary`)의 p99·오류율·요청 수가 manifest `bench`와 장부 표에 들어가고, 못 보낸 요청이 있으면 무효인 경우를 더한다
- [x] 1.2 실패 확인(`KeyError: 'bench'`)
- [x] 1.3 구현: `collect.py --bench-summary`, `index.py`가 k6 요약이 없으면 `bench`를 쓰고 10ms 미만 p99를 소수 둘째 자리로 적는다
- [x] 1.4 통과 확인: `python -I tools/perf-ledger/collect.py --selftest`

## 2. MSK IAM 토큰 함수(ST-T14 ①)

- [x] 2.1 실패하는 시험 쓰기: `packages/platform/test/msk-iam.test.ts`(가짜 STS로 고정 세션 이름·맡은 역할 자격 서명·만료 시각, 역할 거부 시 실패, 세션 이름 규칙, 공용 설정 함수의 TLS·OAUTHBEARER, 인증 설정 덧붙이기 거절, 환경 값으로 고르기)
- [x] 2.2 실패 확인(6개 실패)
- [x] 2.3 구현: `src/msk-iam.ts`(`mskIamTokenProvider`·`mskSessionName`·`kafkaAuthFromEnv`), `kafka-config.ts`의 `auth`와 `KAFKA_AUTH_LOCKED`, 서비스 뼈대 릴레이 시작 파일의 `kafkaAuthFromEnv`
- [x] 2.4 통과 확인: `pnpm --filter @peaket/platform test`

## 3. ST-T18 키 단위 소비 전체

- [x] 3.1 시험 쓰기: `test-int/keyed-consumer.int.test.ts`(처리 중 소비자 추가·강제 종료(자식 프로세스 SIGKILL)·일시 실패로 멈춘 파티션을 넘긴 뒤 다시 받기·넘기기 기다림 30초 한도 뒤 새 주인이 받기)
- [x] 3.2 결과: 키 단위 실행기에 결함 없음. 시험이 살아 있는지 일부러 깨 본다: 배정 때 멈춤 풀기를 빼면 ③이 실패, 끝나지 않은 사건을 넘겨 커밋하면 ①의 커밋 위치 확인이 위반 11건으로 실패
- [x] 3.3 시험 도구 고침: 커밋 위치를 브로커 쪽 도구로 읽는다(`containers.ts` `groupOffsets`, 컨테이너 안 리스너)
- [x] 3.4 통과 확인: `pnpm --filter @peaket/platform test:integration`

## 4. 측정 틀(`loadtest/poc/`)

- [x] 4.1 측정 무대 `stack.mjs`(TLS 인증서, Valkey 클러스터 TLS 켬·끔, Kafka 셋), 측정 도구 이미지(`bench/`), V-T41 앱(`packages/platform/bench/vt41`)과 k6 시나리오(`http/vt41.js`)
- [x] 4.2 짧은 점검: 세 클라이언트 연결, 홀드 Lua, 좌석 샤드, 동작 시험, V-T41 표본 묶음(세 구성 17개 결과 같음), Kafka 혼합·묶음 크기·관리 연결
- [x] 4.3 실행기 `run.mjs`(측정을 차례로, TLS 켬 3회·끔 1회)와 장부 수집기 `record.mjs`
- [x] 4.4 본측정: `node loadtest/poc/run.mjs` → `node loadtest/poc/record.mjs`

## 5. 판정과 정본

- [x] 5.1 ADR-0176(PoC 판정), docs/architecture.md §5·§9.4, docs/verification.md V-T33·V-T41, docs/features/seat-hold.md S-T27, docs/streaming.md §2.1·§2.6·ST-T14·ST-T18, docs/devops.md §4.4, docs/perf-ledger.md §4, docs/security/asvs/delivery.md 13.2.1, docs/observability.md 운영 확인 표
- [x] 5.2 확인: `python -I tools/doc-check/check_all.py` 오류 0, `pnpm exec openspec validate --all`

## 6. 새 맥락 리뷰(1차) 고침

- [x] 6.1 실패하는 시험 쓰기: 관리 연결 설정 함수·TLS 검증과 CA 잠금·`auth.caLocation`(단위 `test/msk-iam.test.ts`), TLS + OAUTHBEARER 리스너만 연 브로커에 생산자·관리 연결·키 단위 소비자·방송형 읽기를 띄운다(통합 `test-int/kafka-auth.int.test.ts`, 시험 브로커 `startKafka({ oauth: true })`)
- [x] 6.2 실패 확인: 단위 3개 실패. 통합은 방송형 읽기 옵션에 인증 칸이 없어 형식 오류, 넘긴 뒤에는 첫 관리 요청이 한도와 상관없이 시간 초과(한도 5·8·20·30초 모두)
- [x] 6.3 구현: 키 단위 소비자·방송형 읽기·관리 연결에 인증 넘기기, `kafkaAdminConfig`, `KAFKA_AUTH_LOCKED`에 TLS 검증·CA 이름, 인증 관리 연결은 연결 때 메타데이터 요청(`listTopics`)으로 데운다, 서비스 이미지 실행 단계에 `ca-certificates`
- [x] 6.4 통과 확인: 단위·통합 시험
- [x] 6.5 측정 도구 고침(시험 대상 코드가 아니라 측정 정확성): 예열 뒤 요청 수를 분모로, 보낸 시각 기준 지연도 남김, 작업 프로세스 시작 맞추기, V-T41 본구간 끝 값·닫힌 모델 예열·이벤트 루프 지연에서 표본 간격 빼기·Express ETag 끔, 다시 잰 측정을 덮어쓰는 기록 도구, 클러스터 배치 확인, 오버셀 판정 가능 표시. 고치기 전 판으로 잰 V-T41 오픈 모델은 k6 가상 사용자 부족으로 무효라 다시 잰다
- [x] 6.6 ST-T18 강제 종료 시험 강화: 커밋 위치가 나아간 뒤 죽이고, 다시 받아 걸러진 수가 0보다 크고 죽기 전 반영 수보다 작은지(커밋 위치부터 이어받음) 본다

## Workflow follow-up

- 화면 변경 없음: 브라우저 확인은 해당 없음(browser-check.md)
