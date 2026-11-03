# ADR-0145: 상위 설계와 하위 문서 대조에서 나온 API 계약 보완(추천 적용 묶음, 2026-10-29)

- **상태**: 채택 (2026-10-29. 소유자가 "이제 /docs 경로에 있는 설계문서들의 내용이 그 아래 경로인 /api, /features, /quality, /security 에 온전히 잘 반영되어있는지 검토해주고 미진한 부분은 보완 다해주세요."라고 요청했다. 대조 점검(review R-166)에서 문서만으로 정할 수 없던 계약 세부를 아래처럼 정했다. 방향은 소유자 요청이고, 세부는 모두 추천 적용이다.) 2026-10-29(문서 대조 반영 뒤 고쳐 읽기, R-166): 결정 5의 `ListUpcomingOnsales` gRPC는 두지 않는다. ops-svc를 업무 gRPC를 받는 쪽으로 만들면 웨이포인트가 붙어 관제 분리(ADR-0082·0102)와 부딪히기 때문이다. 대신 ops-svc가 10분마다와 일정이 바뀔 때 S3(ops 버킷)에 온세일 일정 파일 `ops-calendar/upcoming-onsales.json`(앞으로 7일, 판 번호)을 쓰고, `freeze-calendar`·배경 작업 일정기는 그 파일을 읽는다(docs/devops.md §8.2). 결정 9의 Alertmanager 웹훅은 관측 도구 연결이라 '서비스끼리는 REST 금지' 규칙 밖으로 읽는다(docs/architecture.md §3.2).
- **관련**: ADR-0065(호스트·쿠키), ADR-0081(REST 규칙), ADR-0100(관제·파트너 통신), ADR-0102(제어 평면 의존), ADR-0119(파트너 로그인), ADR-0121(좌석 저장소 장애), ADR-0125(꼬리 표본), ADR-0144(엣지), [docs/api/guidelines.md](../api/guidelines.md) §6·§9·§12, [docs/api/openapi.yaml](../api/openapi.yaml), [docs/api/proto/README.md](../api/proto/README.md)

## 맥락

상위 설계 문서(architecture·frontend·devops·observability 등)에는 있는데 API 계약 문서에는 없거나, 계약끼리 어긋난 곳이 대조 점검에서 나왔다. 대부분은 상위 문서의 규칙을 옮기면 되지만, 아래는 상위 문서도 값을 정하지 않아 고를 것이 있었다.

## 결정

1. **gw-ops 경로의 계정당 한도는 gw-ops 로컬 버킷으로 건다**: gw-ops는 전역 레이트 리밋 서비스에 붙이지 않는다. 전역 레이트 리밋은 공유 세션·캐시 Redis와 일반 노드 풀에 기대는데, ADR-0102가 관제 입구를 거기서 뗐기 때문이다. gw-ops 계정당 한도는 내부 사용자 머리 기준의 파드별 토큰 버킷이고, 실효 상한은 'gw-ops 파드 수 × 한도'다(guidelines §6에 적는다).
2. **파트너·관제 로그아웃 작업**: `DELETE /v1/partner/auth/sessions/me`(gw-partner)와 `DELETE /v1/ops/auth/sessions/me`(gw-ops)를 둔다. 204로 답하고, 그 앱의 쿠키만 같은 이름·Domain·Path의 `Max-Age=0`으로 지운다. `Clear-Site-Data`는 보내지 않는다(docs/features/identity.md). 세션 종료 사건을 낸다. 소비자 웹 로그아웃은 로그인처럼 앱 서버 경로로 두고 openapi에 넣지 않는다.
3. **operationId 이름 규칙**: camelCase 동사 + 자원으로 짓는다(예 `createHold`, `getPaymentStatus`, `createPartnerAuthSession`). 화면 코드 생성기가 이 이름으로 훅을 만든다. tRPC 프로시저 이름에 맞춘다는 옛 문장은 지운다(ADR-0100).
4. **스캐너 앱 최소 판**: 근무 준비 때 받는 회차 목록·동기화 응답에 `minAppVersion`(SemVer 문자열)을 싣는다. 스캐너 API는 최근 앱 판 2개와 호환되게 하고, 호환을 깨는 변경은 guidelines §1의 폐기 절차를 따른다. 입장 시간 중에는 판이 낮다고 거부하지 않는다.
5. **온세일 일정 읽기 gRPC**: ops-svc에 읽기 전용 `ListUpcomingOnsales`(앞으로 7일 안의 승인된 회차·오픈 시각·규모 등급과 판 번호)를 둔다. 부르는 쪽은 변경 동결 달력(`freeze-calendar`)과 배경 작업 일정기 신원뿐이고, 읽기라 멱등 키는 없다. 지금 ops-svc의 proto 초안이 없으므로 proto README 호출 표에 '초안 없음'으로 올린다.
6. **브라우저 텔레메트리 입구 `/_t/*`의 계약은 guidelines §9에 둔다**: `/_t/rum`·`/_t/csp`·`/_t/err`는 화면 호스트 넷의 같은 출처 POST 전용 경로이고 `/v1` REST 규칙의 예외다. openapi에는 넣지 않는다(외부 API가 아니고 경로 규칙 검사의 예외만 늘기 때문이다). 게이트웨이 라우트 생성기는 openapi 작업과 이 고정 목록을 함께 읽는다(D-T42).
7. **드문 경로 꼬리 표본 표시**: 하루 수십 건 아래의 쓰기 작업(회차 취소 환불, 양도, 정산 지급, 포트원 실행, 계정 병합)에 openapi 확장 필드 `x-peaket-trace-rare: true`를 단다. 게이트웨이 수집기 설정 생성기가 이 표시로 성공 사례도 남기는 하위 정책을 만든다(ADR-0125, docs/observability.md §6).
8. **경보 라벨 값 목록**: `journey` 값은 여정 일곱의 이름 `detail`·`queue_entry`·`queue_state`·`hold`·`seat_status`·`payment_accept`·`payment_confirm`이다(앞 셋은 [가정], wbs 4.2.1). `dependency` 값은 외부 제공자와 내부 의존(`outbox-relay`, `kafka-trade` 등)을 함께 적는다. 감축 사유 라벨에 좌석 저장소 장애 감축 `seat_store`를 더한다(ADR-0121 결정 3).
9. **경보를 ops-svc가 받는 길**: ops-svc는 클러스터 안 Alertmanager 웹훅(메시 신원 alertmanager만 허용)으로 경보를 받아 `OpsAlert`로 바꾼다. 억제 상태는 Alertmanager 경보 목록 API를 30초 [가정]마다 읽어 채운다. 외부 계약(openapi)이 아니라 control-tower §13과 docs/data.md(ops 표)에 적는다.

## 검토한 대안

- gw-ops도 전역 레이트 리밋에 붙이기: 상한은 정확해지지만 관제 입구가 공유 Redis에 다시 묶인다.
- 스캐너 최소 판을 응답 머리로 알리기: 모든 응답에 붙여야 하고 교차 출처 노출 머리가 는다.
- `/_t/*`를 openapi 작업으로 넣기: 경로 규칙 검사(`check_all.py api`)에 예외가 늘고 외부 API로 오해된다.

## 결과와 트레이드오프

- 관제 경로의 계정당 한도는 파드 수만큼 느슨하다. 관제 사용자가 적어 받아들인다.
- 계약 초안이 조금 늘지만, 상위 문서와 계약이 같은 이름을 쓴다.

## 되돌릴 조건

- 관제 경로에 정확한 계정당 상한이 필요해지면 ops-svc가 ops DB로 센다.
