# ADR-0250: 새 결제 진입 정지의 commander 해제는 새 제어 종류와 `{pg}`로 정하고, 이 단계는 쓰임새까지만 만든다

- **상태**: 채택(2026-11-09, 추천 적용. wbs 2.7.5 세부는 추천 적용이라는 승인을 따른다). BUILD_ORDER PRF-202(wbs 2.7.5 ②).
- **관련**: POL-021, POL-029, ADR-0095, ADR-0102, ADR-0103, ADR-0105 결정 7·8, ADR-0143, [docs/features/payment.md](../features/payment.md) §2 '정지 판정자의 첫 구현'·§9, [docs/features/control-tower.md](../features/control-tower.md) §3 명령 6, [docs/security/asvs/payment.md](../security/asvs/payment.md)
- **관련 ID**: P-T43, C-T44, ASVS v5.0.0-2.2.1, 8.2.1, 16.5.3

## 맥락

- ADR-0105 결정 7은 commander(관제 책임자) 한 사람이 명령 6의 해제로 그 결제사의 새 결제 진입을 바로 모두 열게 정했다. 받은 파드가 판 번호 조건으로 `payment_entry_pause` 행을 쓴 뒤 ack(받아서 적용했다는 응답)한다고도 적었다.
- 정본에는 이 해제를 부르는 계약이 없다. 제어 gRPC의 종류 목록(`docs/api/proto/peaket/control/v1/control.proto`의 `ControlKind`)에 해당 값이 없고, 범위 칸은 'PLATFORM' 또는 회차 ID뿐이라 결제사를 가리킬 자리가 없다.
- 제어 수신(받는 쪽 포트, ack, 재인증, 감사 로그, 운영 사건 줄)은 OPS-300·OPS-310 단계다. PRF-202가 그것을 함께 만들면 범위를 넘는다.

## 결정

1. **종류 이름은 `CONTROL_KIND_ENTRY_PAUSE_RELEASE`다.** 명령 6의 대체 결제사 전환(`CONTROL_KIND_PG_SWITCH`)과 나눈다. 전환은 2인 승인이고 이 해제는 1인 승인이라 종류가 달라야 승인 규칙을 잘못 탈 일이 없다. proto에 넣는 일은 전송을 만드는 OPS-310이 한다.
2. **결제사는 바라는 상태의 `{pg}`로 준다.** `ApplyControl`의 범위(`scope`)는 그대로 `PLATFORM`이고 `desired_state_json`은 `{"pg":"TOSS"}`다. `pg`는 `TOSS`·`PORTONE`·`SIMULATOR` 가운데 하나다. 범위 칸의 뜻을 넓히지 않으려는 것이다.
3. **쓰임새는 `ReleaseEntryPause`다.** 입력은 `{pg, actor, reason}`이다.
   - `actor`는 commander 계정 ID(1~128자 [가정])이고 `reason`은 사유 글(1~500자 [가정])이다. 틀리면 쓰지 않고 입력 오류다.
   - 행을 캐시 없이 읽어 행이 없거나 `OPEN`이면 쓰지 않고 '이미 열림'으로 답한다(멱등, 다시 보내도 결과가 같다).
   - 아니면 읽은 판 번호 조건으로 `stage = OPEN`, `actor`, `reopened_at = 지금`, `trial_started_at` 비움, `version + 1`을 쓴다. `since`는 둔다.
   - 겨루어 지면(판정자가 먼저 썼으면) 다시 읽어 2회 [가정] 더 한다. 그래도 지면 '겨룸'으로 답하고 쓰지 않는다.
4. **다시 멈추는 조건은 건드리지 않는다.** 해제는 행만 연다. 판정자는 다음 틱부터 평소대로 본다. 서킷 열림은 바로 보고, p99는 `reopened_at` 뒤의 표본만 본다(ADR-0105 결정 6).
5. **사유 글은 이 층에서 저장하지도 로그에 쓰지도 않는다.** 자유 글에 개인정보가 섞일 수 있고, 남길 곳은 감사 로그다. `payment_entry_pause.reason`은 정지 사유 칸(`PG_FAILURE`·`CHANNEL_WAIT`)이라 이 글과 다른 값이다. 로그에는 결제사와 `actor`만 쓴다.
6. **이 단계는 쓰임새까지다.** 호출자가 아직 없다. 전송(제어 gRPC·Kafka), 콘솔, 재인증, 감사 로그, `ops_event`, 파드 캐시 무효화(`CachedEntryPauseReader.invalidate`)는 OPS-310이 잇는다.

## 검토한 대안

| 대안 | 채택하지 않은 이유 |
| --- | --- |
| `CONTROL_KIND_PG_SWITCH`의 바라는 상태에 해제를 함께 싣는다 | 승인 강도가 달라(전환 2인, 해제 1인) 한 종류에 묶으면 승인 규칙이 값마다 갈린다 |
| 범위(`scope`)에 결제사 이름을 넣는다 | 범위는 'PLATFORM' 또는 회차 ID로 정해져 있어 받는 쪽 네 서비스의 검사가 모두 달라진다 |
| 이 단계에서 제어 gRPC까지 연다 | 제어 수신과 ack는 OPS-300·OPS-310의 몫이고, 재인증과 감사 로그 없이 여는 것이 더 위험하다 |

## 결과

- 쓰임새와 시험은 지금 돌지만, 운영자가 부를 길은 OPS-310 전에는 없다. 그동안 자동 판정이 막히면(Prometheus 입력 없음 등) 다시 여는 길은 DB 행을 손으로 고치는 것뿐이다.

### 되돌릴 조건

- OPS-310에서 제어 수신의 범위 모양이 바뀌면 결정 2를 함께 고친다.

## 남는 한계

- 호출자가 없어 P-T43 ②의 '감사 로그에 사유와 commander가 남는다'는 OPS-310에서 본다. 이 단계의 시험은 행의 `actor`까지 본다.
- 해제 뒤 다른 파드는 다음 읽기(1초 [가정])까지 옛 정지를 본다. 무효화는 OPS-310이다.
