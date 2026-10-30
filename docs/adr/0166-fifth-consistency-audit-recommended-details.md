# ADR-0166: 5차 정합성 점검(구현 전 마지막 점검)에서 정본끼리 갈린 곳을 정한다(추천 적용, 2026-10-30)

- **상태**: 채택 (2026-10-30. 소유자가 "구현 전 마지막 점검 합시다"라고 요청했다. 9bcdc81 뒤에 바뀐 문서 100개와 ADR-0148~0165를 점검 갈래 8개가 읽어 282곳을 찾았고, 265곳을 반영했다. 같은 곳을 두 갈래가 함께 짚은 18곳은 하나로 합쳤다(review R-194). 이 ADR의 결정은 정본끼리 갈려 문서만으로 정할 수 없던 곳의 추천 적용이다. 정본이 분명한 곳은 정본을 따라 고쳤을 뿐이라 결정으로 적지 않는다.)
- **관련**: ADR-0155(알림), ADR-0156(봇 탐지), ADR-0157(인증 통제·권한), ADR-0158(내부 관리계획), ADR-0159(좌석·관제 ASVS), ADR-0161(로비·재홀드·예매 제한), ADR-0162(수사기관 자료·정산), ADR-0163(관리 계정 API), ADR-0164(허용 역할), ADR-0165(저장소 4개), [review/consistency-review.md](../review/consistency-review.md) R-194

## 맥락

- 마지막 전체 대조(2026-10-29, 커밋 9bcdc81) 뒤로 이틀 동안 ADR 18건과 새 문서(알림·봇 탐지 설계서, 보안 문서 다섯, ASVS 추적 표 셋, proto 여럿)가 생겼다. openapi 작업 241개에 허용 역할 칸이 붙었고, 저장소도 4개로 바뀌었다.
- 구현은 문서를 그대로 옮긴다. 그래서 문서끼리 다르게 말하는 곳을 구현 전에 잡으려 했다.
- 점검 갈래는 다음 여덟이다. 읽기만 하고, 고칠 문장을 보고했다.
  - REST 계약
  - 이벤트·gRPC 계약
  - 보안 문서
  - ASVS 추적 표
  - 기능 설계서 둘(구매 쪽, 계정·관제·정산 쪽)
  - 상위 설계 문서
  - 기획·화면·요약·WBS

## 결정

1. **관리 계정 잠금은 이미 열린 세션을 끝내지 않는다.** 잠금 규칙 정본(auth-controls §3.2)과 용어 정본(planning/03 §4)을 따른다.
   - identity §4, asyncapi·avsc의 `ACCOUNT_LOCKED`, d5 세션 종료 문구 표가 이와 반대였다.
   - `ACCOUNT_LOCKED`는 지금 내지 않는 예약 값으로 남긴다. 첫 등록 전이지만 기호는 지우지 않는다.
   - d5의 그 문구는 로그인 화면(SCR-020·028)의 잠김 문구로만 쓴다.
2. **재초대(`PROTECT_LOCK`·`CREDENTIAL_LOST`)로 끝낸 세션의 종료 사유는 `ADMIN_FORCE`다.** 운영자가 한 조치이고, 새 열거 값 없이 d5 문구가 그대로 맞는다.
   - 역할 변경의 종료 사유는 `ROLE_CHANGED`, 삭제는 `DELETE`, 비밀번호 바꾸기는 `PASSWORD_CHANGED`다.
   - d5 세션 종료 문구 표에 세 값의 관리 계정 문구를 더했다.
3. **시간 잠금 중인 계정에도 분실 재초대(`CREDENTIAL_LOST`)를 받는다.** 상태 정본 planning/03 §2.7의 A12를 살린다.
   - openapi·auth-controls·d5가 '활성 계정만'으로 적었던 것을 맞췄다.
   - 보호 잠금 해제(`PROTECT_LOCK`)를 시간 잠금 계정에 보내면 409인 것은 그대로다.
4. **승인 업무의 재인증 요소는 승인하는 역할에 따라 다르다.**
   - commander가 하는 승인·실행: 비밀번호·TOTP·패스키
   - cs_lead가 하는 승인·실행: 비밀번호·TOTP
   - cs_lead에게는 패스키 등록 의무가 없다(POL-020). d5 SCR-046의 '패스키 확인' 단계는 commander에게만 있다.
5. **빠진 REST 경로를 더한다.**
   - 통보 철회에 따른 노출 복원: `POST /v1/ops/compliance/notices/{noticeId}/withdrawal`
   - 보안 사고 해당 판단: `…/incidents/{incidentId}/determination`, commander
   - 보안 사고 종결: `…/closure`
   - 통보 차단 경로는 사유 본문과 멱등 키를 받는다. 명령 10은 이 경로로만 낸다.
   - 법정 조치의 통보·자료 요청·보안 사고 등록은 멱등 키를 받고, `Location`을 준다.
   - `POST /v1/ops/approval-requests`는 `COMMANDER_ROLE_CHANGE`를 받지 않는다(422). 역할 변경은 역할 경로의 202만 만든다.
   - 파트너 웹훅 목록은 커서로 나눈다.
6. **아직 없는 경로는 미룬 곳을 적는다.**
   - 관리 계정이 자기 세션을 보고 끊는 경로는 wbs 0.2.3에서 더한다(identity §13).
   - 지급 묶음 목록 `GET /v1/ops/payout-batches`도 같은 때 더한다 [가정](settlement §10).
7. **봇 판정 이의와 추가 검증 사유.**
   - queue-svc는 격리 기록 `q:{event:E}:verify`에 사유 범주를 함께 적는다.
   - 화면은 `LobbyToken`·`QueueTicket`·`AdmissionResult`의 `verificationReason`으로 그 범주를 받는다(FR-020).
   - 이의 ID로 찾는 색인 `q:appealid:{appealId}`를 같은 처리에서 쓴다. queue.proto 두 호출이 이의 ID만 받기 때문이다.
8. **예매 제한의 판 번호는 계정마다 늘어난다.**
   - 원본 칸은 `booking_restriction.version`이다.
   - 계정 단위 사본(`q:rst`·`s:rst`·`sup:rst`)이 판 번호로 늦게 온 것을 거르므로, 새 제한의 판은 그 계정의 앞선 제한보다 커야 한다.
   - CS 처리함 건에도 판 번호 칸 `cs_case.version`을 둔다. 세 호출(`SetAccountHold`·`ResolveVerificationAppeal`·`ApplyLabel`)이 이 값을 쓴다.
9. **이벤트 열거 값을 더한다.** 모두 첫 등록 전이다.
   - `TrustVerdict.category`에 `CHALLENGED`를 더한다. `BLOCK`·`BLOCKED`는 쓰지 않는다(ADR-0156 결정 1).
   - `HoldAttempt.result`에 `RECENTLY_RELEASED`를 더한다(ADR-0161 결정 2).
   - 알림(notify)은 `trade.tickets`를 받아 양도 알림을 보낸다.
   - `control.settings`의 `AUTOMATION_STOP`은 쓰지 않는다. 명령 11은 제어 gRPC로만 보낸다(ADR-0103).
10. **데이터 칸을 채운다.**
    - `takedown_notice`·`provision_ledger`의 칸을 openapi와 같게 둔다.
    - `security_incident.decision`·`decided_at`을 둔다.
    - `data_request`의 기관·종류 값은 대문자로 쓴다.
    - 관리 계정 로그인의 익숙한 출발지 목록은 identity DB에 둔다 [가정]. Redis를 잃어도 알림이 쏟아지지 않게 하려는 것이다.
    - 권한 표의 테넌트 표 목록에 `admin_account`를 더한다.
11. **ASVS 판정을 맞춘다.**
    - 12.1.3(메시 mTLS 인증서로 서비스 신원 인가)은 처지가 같은 표를 모두 '적용(운영 설계만)'으로 둔다(seat-hold·control-tower·queue-admission).
    - 전달 표 13.2.2는 정산 표처럼 '부분 적용 + 위험 수용(ADR-0165)'이다.
    - 위협 모델에 VAPID 키 위장 행을 더한다.
12. **나머지 추천.**
    - 성능 장부의 실행 폴더는 공개 `peaket`에 두고, manifest에 비공개 시나리오 저장소의 커밋 `commit.loadtest`를 적는다.
    - 새 작업 `seatmap-worker`·`waf-block-expirer`는 `core` 네임스페이스에 둔다. 운영 명령과 함께 움직이는 `waf-block-expirer`만 관제·시스템 노드 풀이다.
    - `waf-block-expirer`는 C4 그림에 상자 밖 컨테이너로 그린다.
    - 명령 유형별 `Command.params` 스키마는 구현 전에 oneOf로 더한다.
    - 화면 문안 넷을 정했다: SCR-049 viewer의 정산 건수 요약, SCR-025 '계속 실패해 꺼짐', SCR-054 신청 끝 까닭별 문구, 관리 계정 세션 종료 문구.
    - WBS: 2026-10-30 결정의 새 일은 기존 작업(2.9.2·2.9.5·3.5.3·4.4.1·4.5.2·5.8.3)의 범위에 적고, 일수는 처음 묶음을 마친 뒤 다시 어림한다.
13. **캔버스(open-items 81번)를 그리며 찾은 화면 정본의 빈칸 21곳을 d5에 넣는다.** 보드가 그린 쪽을 기본으로 하고, 다른 정본과 어긋나면 그쪽을 따랐다. 추천으로 정한 것은 다섯이다.
    - 꺼진(DISABLED) 웹훅 엔드포인트에는 [다시 보내기]를 막고, 다시 켠 뒤 DLQ 행을 다시 보낸다. 받지 못하는 주소로 다시 쌓으면 주소를 끄는 까닭과 어긋나기 때문이다.
    - 통보와 자료 요청은 따로 다룬다. 둘을 잇는 칸이 openapi에 없다.
    - cs_lead는 이의 없는 수기 조정의 정산서 ID를 operator·commander나 파트너 웹훅의 `statementId`로 받는다. cs_lead에게 정산서 목록·검색은 두지 않는다(권한은 좁게).
    - operator·commander가 처리하는 정산 건은 [처리 기록 남기기]·[처리하고 닫기] 꼴로 처리하고, `PATCH /v1/ops/cases`로 보낸다.
    - 남은 시간 표기는 '0:24'(분:초) 꼴로 맞춘다.
    - 이 과정에서 남은 API 빈칸 다섯은 open-items 84번으로 넘긴다(wbs 0.2.3).

## 검토한 대안

- **잠금이 세션을 끝냄(보호 잠금만이라도)**: 비밀번호가 샌 신호에는 맞다. 하지만 정본 둘(auth-controls §3.2, planning/03 §4)과 그 위의 위험 판단(auth-controls §3.7)을 함께 바꿔야 해서 고르지 않았다.
- **A12를 지움**: 시간 잠금은 최대 1시간이면 풀리므로 기다린 뒤 A11로 처리할 수 있다. 하지만 상태 정본을 바꾸는 쪽이라 고르지 않았다.
- **cs_lead에게도 패스키 의무**: 승인 업무 모두에 패스키를 요구하면 더 강하다. 하지만 POL-020과 등록 의무를 바꿔야 해서 고르지 않았다.
- **새 경로 대신 기존 경로의 본문 값으로 처리**: 동작을 기록 하위 자원으로 두는 규칙(guidelines §10)과 맞지 않아 고르지 않았다.

## 결과와 트레이드오프

- 구현자가 문서 둘 사이에서 고를 일이 줄었다.
- openapi 작업은 241개에서 244개로 늘었다(경로 221개).
- 새 열거 값과 칸은 모두 첫 등록 전이라, 호환 검사에 걸리지 않는다.
- 이 점검은 9bcdc81 뒤에 바뀐 부분을 중심으로 봤다. 그보다 앞서 쓰고 그 뒤 바뀌지 않은 문서끼리의 어긋남은 4차 점검(ADR-0087~0089)과 전파 대조(ADR-0145~0147)에 기댄다.
- 갈래가 '못 본 곳'으로 적은 것이 있다. data.md ERD 변경의 칸 단위 대조, observability 새 지표 이름 전체, d5의 바뀌지 않은 절이다. 이것들은 review R-194에 남긴다.

## 되돌릴 조건

- 구현 중 결정 1~4의 규칙이 실제 운영 요구와 맞지 않으면, 그 정본(auth-controls, planning/03, POL-020)을 고치는 새 ADR을 쓴다.
