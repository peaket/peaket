# ADR-0341: 감사 체인 mac의 첫 구현 — 입력 바이트, 키와 복제 키, 체인 작업자, 빈 행 경보, 5분 앵커, 검증 잡, 다른 서비스의 감사 기록(2026-11-21)

- **상태**: 채택(추천 적용, 2026-11-21, BAT-355 계획). [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md) 결정 12(키 건 해시 체인·5분 앵커·1시간 검증)와 [ADR-0102](0102-control-plane-direct-grpc-dedicated-pool-ops-db-audit-chain-worker-break-glass.md)(커밋 뒤 체인 작업자·빈 행 SEV2·복제 키)를 처음 구현하면서 정본에 없던 세부를 정한다. 소유자 결정이 아니다. 공개 체크포인트·OpenTimestamps·공개 검증 도구는 [ADR-0075](0075-public-audit-anchor-signed-merkle-checkpoints.md)와 OPS-280 몫이다.
- **관련**: [docs/features/control-tower.md](../features/control-tower.md) §7('감사 체인 mac의 첫 구현' 문단)·§16, [docs/data.md](../data.md) `audit_chain`·`audit_chain_head`·`ops_worker_lease`·`audit_mac_anchor`·`audit_verification_run`·`audit_record_intake`·§4 6번·§5, [docs/security/secrets-and-keys.md](../security/secrets-and-keys.md) '감사 체인 키', [docs/api/guidelines.md](../api/guidelines.md) §8·§8.1, [docs/verification.md](../verification.md) §4.1·G-27, [ADR-0232](0232-shuffle-result-object-store-root-first-seed-reveal-proof.md) 결정 10, `docs/review/plans/BAT-355.md`
- **관련 ID**: OPS-270, C-T27 ①③, C-T49, ASVS v5.0.0-11.2.2·11.3.3·11.4.1·11.5.1·16.2.1·16.4.2

## 맥락

- `audit_chain`에는 빈틈 없는 `seq`, 기록 해시, 직전 해시, 정규화 기록, 잎 솔트가 있고, 감사 체크포인트(Ed25519 서명)가 있다(R-584·R-614). 키를 건 mac은 칸만 있고 늘 비어 있다. 그래서 DB 쓰기 권한만 있으면 기록과 키 없는 해시를 함께 다시 계산해 바꿀 수 있다.
- 정본은 mac 식(`HMAC(감사 체인 키, "PEAKET-audit-v1" ‖ seq ‖ 직전 mac ‖ 기록 해시)`)만 정했다. 바이트 꼴, 키가 없는 환경, 작업자 고르는 법, 앵커 자리, 검증 잡이 보는 범위는 정하지 않았다.
- ADR-0053 결정 12의 검증은 '마지막 검증 지점부터'다. 그대로 하면 이미 검증한 기록을 나중에 고친 것은 그 구간을 다시 보지 않아 드러나지 않는다. C-T27은 앵커가 찍힌 기록을 고쳐도 다음 검증에서 드러나야 한다고 한다.
- AWS KMS·S3 흉내 서버(moto)는 통합 시험에서 이미 쓴다(identity-svc `test-int/kms-failover.int.test.ts`). 운영 계정은 없다.

## 결정

1. **mac 입력 바이트**: `mac = HMAC-SHA256(감사 체인 키, "PEAKET-audit-v1"(UTF-8 15바이트) ‖ seq(부호 없는 8바이트 빅엔디언) ‖ 직전 행의 mac(32바이트. seq가 가장 작은 행은 0바이트) ‖ record_sha256(32바이트))`. `record_sha256`은 지금 코드 그대로 SHA-256(직전 기록 해시의 16진 글자 ‖ 정규화 기록 JSON 글자)이다(R-614). docs/data.md `audit_chain.record_sha256` 설명을 이 뜻으로 고친다. 이미 있는 행도 작업자가 `seq` 1부터 채운다.
2. **키와 복제 키**: 운영은 KMS HMAC 다중 리전 키(`GenerateMac`, `HMAC_SHA_256`)이고 환경 값은 `PEAKET_AUDIT_CHAIN_KMS_KEY_ID`(`mrk-`로 시작)다. 넘길 리전과 흉내 끝점은 identity-svc와 같은 이름·뜻(`PEAKET_KMS_FAILOVER_REGION`, `PEAKET_KMS_ENDPOINT`, `PEAKET_KMS_FAILOVER_ENDPOINT`, docs/features/identity.md §6 '복제 키 넘기기의 첫 구현')이다. 서울이 응답하지 않으면(연결 실패·시간 초과·5xx·한도) 도쿄 복제 키로 한 번 더 하고, 거절(권한 없음·키 꺼짐)은 넘기지 않는다. 시간 값은 연결 1초·요청 2초 [가정]이다(trust-svc의 같은 호출과 같다). local·ci·demo에서 키 ID가 없으면 `PEAKET_AUDIT_CHAIN_LOCAL_KEY`(base64, 32바이트 이상)의 메모리 HMAC을, 그것도 없으면 시작 때 만든 임시 키와 경고 한 줄을 쓴다. 그 밖의 환경에서 키 ID나 넘길 리전이 없으면 시작하지 않는다. 검증 잡은 `VerifyMac`만 쓴다(ADR-0053 결정 12). 키 바꾸기는 이 묶음에서 하지 않고, 앵커에 키 ID를 남겨 둔다(결정 5).
3. **체인 작업자**: ops-svc 파드 가운데 하나가 ops DB 임대 행 `ops_worker_lease`(이름 `audit-chain-mac`, 쥔 파드, 끝 시각)로 일을 맡는다. ADR-0102의 'Lease'를 쿠버네티스 Lease 대신 DB 행으로 한다(로컬·CI·운영이 같고 연결 풀 방식과 무관하다). 임대는 15초 [가정]이고 5초 [가정]마다 늘린다. 1초 [가정]마다 `mac_seq` 뒤의 행을 `seq` 차례로 100개 [가정]까지 읽어 트랜잭션 밖에서 mac을 계산하고, 짧은 트랜잭션에서 빈 `mac`과 `audit_chain_head.mac_seq`·`last_mac`을 `mac_seq = 읽은 값` 조건으로 쓴다(맞지 않으면 그 바퀴를 버린다). 기록 트랜잭션은 `mac_seq`·`last_mac`을 읽지 않고 KMS를 부르지 않는다. 다음 `seq`가 없는데 그 뒤 행이 있으면(빈틈) 멈추고 결정 6의 SEV2를 연다.
4. **빈 행 경보**: 10초 [가정]마다 mac이 빈 가장 오래된 행의 `created_at`을 본다(부분 색인 `WHERE mac IS NULL`). 지금과의 차이가 60초를 넘으면(60초 정각은 아직 아니다) ops 경보 SEV2 `audit-mac-lag`(event_key `audit-chain`)를 열고, 빈 행이 없어지면 푼다. 지표는 `ops_audit_mac_lag_seconds`(가장 오래된 빈 행의 나이, 없으면 0)와 `ops_audit_kms_failover_total{op}`다. Prometheus 경보 규칙과 대시보드는 구간 5(배포) 몫이다.
5. **5분 앵커**: 5분 [가정]마다 `mac_seq`가 마지막 앵커보다 크면 `{v: 1, seq, mac(16진), keyId, at}`를 감사 앵커 버킷 객체 `audit-chain/anchors/v1/{seq를 20자리로}.json`에 쓴다(S3 Object Lock 컴플라이언스 모드, 보존 7년). 쓴 것은 ops DB `audit_mac_anchor`에도 남겨 다음 바퀴가 겹쳐 쓰지 않게 한다(같은 `seq`는 기본 키가 막는다. 객체를 쓴 뒤 행을 넣으므로, 행을 넣다 실패하면 다음 바퀴가 같은 이름으로 다시 쓴다). 설정은 `PEAKET_AUDIT_ANCHOR_BUCKET`, 흉내 끝점 `PEAKET_AUDIT_ANCHOR_S3_ENDPOINT`(local·ci만)다. local·ci·demo에 버킷이 없으면 폴더 `PEAKET_AUDIT_ANCHOR_DIR`에, 그것도 없으면 메모리에 쓰고 경고 한 줄이다. 그 밖의 환경은 버킷이 없으면 시작하지 않는다.
6. **검증 잡**: 1시간 [가정]마다 따로 띄우는 작업(ops-svc 이미지의 둘째 진입점. 운영은 CronJob이고 차트는 구간 5)이 아래를 본다.
   - (가) 마지막 검증 지점 뒤의 행과 지난 25시간 [가정]에 쓴 행: `seq` 빈틈, `record_json`으로 다시 계산한 기록 해시와 `prev_hash` 연쇄, 직전 mac 연결, `VerifyMac`. 25시간은 하루 한 번 만드는 체크포인트(ADR-0075)와 겹치게 둔 창이다.
   - (나) 그 구간의 앵커마다 같은 `seq` 행이 있고 mac이 앵커 값과 같은지.
   - (다) 25시간보다 오래된 행은 모든 체크포인트의 검증(지금의 `AuditCheckpointService.verify`, 로컬 해시라 KMS를 부르지 않는다)을 다시 돌려 지킨다.
   - 하나라도 어긋나면 ops 경보 SEV2 `audit-chain-mismatch`(detail에 첫 어긋난 `seq`·까닭)와 감사 기록 `AUDIT_CHAIN_MISMATCH`를 남긴다. 결과는 `audit_verification_run`에 남고, 검증하지 못했으면(두 리전 KMS 실패 등) `ERROR`이고 통과로 적지 않는다. 보안 사고 기록(FR-063)은 그 저장소가 생기면 잇는다(BAT-355 계획 '감독에게' 3, C-T27 ②).
   - 남는 한계: 마지막 앵커 뒤(최대 5분 [가정])의 맨 끝 기록 삭제는 드러나지 않는다(ADR-0053 남는 한계, C-T27 ③). mac이 빈 동안의 행도 변조 탐지를 받지 않는다(ADR-0102).
   - 무게: VerifyMac 호출은 하루 감사 행 수 × 약 25회 [추정]이다. 하루 행 수가 1만 [가정]을 넘으면 창을 줄이거나 체크포인트 간격을 줄인다(되돌릴 조건).
7. **다른 서비스의 감사 기록 받기**: 내부 경로 `POST /internal/v1/ops/audit-records`(내부 토큰)가 `{eventKey, recordType, recordId, payload, occurredAt}`를 받아 행위자 SYSTEM의 감사 기록으로 덧붙인다. 같은 `eventKey`는 한 번만이다(ops `audit_record_intake` 기본 키, 덧붙임과 같은 트랜잭션). 받는 `recordType`은 허용 목록이고 첫 값은 `SHUFFLE_COMMIT_DISCLOSED`(ADR-0232 결정 10의 공시 감사)다. payload에 개인정보 칸이 들면 400이다. queue-svc 쪽 어댑터는 BAT-355 계획 '감독에게' 2의 결정을 따른다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. DB 임대 행으로 작업자 하나, 트랜잭션 밖 KMS, 조건부 쓰기(이 결정) | 명령 커밋이 KMS를 기다리지 않고, 로컬·CI에서도 같은 코드가 돈다 | 임대가 끝날 때 잠깐 두 파드가 같은 mac을 계산할 수 있다(값이 같아 해는 없다) | 고른다 |
| B. 쿠버네티스 Lease | 정본 글 그대로다 | 로컬·CI 단위 실행에 쿠버네티스가 없다 | 쓰지 않는다 |
| C. 검증 잡이 마지막 검증 지점 뒤만 본다(ADR-0053 글 그대로) | KMS 호출이 가장 적다 | 이미 검증한 행을 나중에 고친 것이 드러나지 않는다(C-T27) | 25시간 창 + 체크포인트 재검증으로 바꾼다 |
| D. 검증 잡이 매번 모든 행을 VerifyMac | 가장 단단하다 | 행이 쌓일수록 KMS 호출과 비용이 끝없이 는다 | 쓰지 않는다 |

## 결과

- 감사 기록을 DB에서 고치면 키가 없는 한 다음 검증에서 드러나고, KMS가 멈춰도 명령은 커밋된다.
- 대가: ops-svc가 `@aws-sdk/client-kms`·`@aws-sdk/client-s3`(저장소의 다른 서비스와 같은 판)에 기대고, ops 마이그레이션 0022가 표 넷과 `audit_chain_head` 칸을 더한다. 검증 잡의 CronJob과 KMS·S3 권한은 구간 5 몫이다.
- 남는 한계: 결정 6의 둘, 그리고 두 리전 KMS를 함께 쓰지 못하면 mac이 밀린다(ADR-0102 남는 한계).

## 되돌릴 조건

- 체인 작업자가 평시에도 빈 행을 10초 넘게 남기면 묶음 mac(ADR-0102 되돌릴 조건)을 검토한다.
- 검증 잡의 VerifyMac 호출이 결정 6의 무게를 넘으면 창을 줄이고 체크포인트를 더 자주 만든다.
