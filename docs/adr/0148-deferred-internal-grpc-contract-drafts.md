# ADR-0148: 미뤄 둔 내부 gRPC 계약 초안(스캐너 기기 관리, 계정 병합 사전 확인, 관제의 CS·카탈로그 반영, 이미지 처리)(추천 적용 묶음, 2026-10-29)

- **상태**: 채택 (2026-10-29. 소유자가 "남은것들도 전부 해주세요."라고 요청했다. docs/api/proto/README.md §4에 '구현 때 더한다'로 남아 있던 내부 호출 가운데 정본에 동작이 정해진 것의 계약 모양을 정했다. 방향은 소유자 요청이고, 세부는 모두 추천 적용이다.) 2026-11-01(정합 점검, ADR-0177 해설서 검토 네 번째 묶음): 결정 10의 '계약 저장소(`peaket-contracts`)로 옮길 때'는 옮길 저장소 없이 읽는다. 저장소가 공개 모노레포 `peaket` 하나가 되어(ADR-0165·0169) 초안은 `docs/api/proto/`에 그대로 있고, 같은 저장소 CI의 계약 검사(`contract-check.yml`)가 `buf lint`·`buf breaking`을 돌린다(docs/devops.md §3.1, wbs 0.2.2).
- **관련**: ADR-0010(gRPC L7 분산), ADR-0038(계정 병합), ADR-0051(현장 입장, 기기 등록), ADR-0062(기기 등록 코드), ADR-0066(CS 처리함·문의), ADR-0082(메시와 앱 경계), ADR-0084(proto 초안), ADR-0093(공연 엔터티), ADR-0102(제어 평면 의존), ADR-0130(이미지 처리 격리), ADR-0145(API 계약 보완), [docs/api/proto/README.md](../api/proto/README.md), [docs/architecture.md](../architecture.md) §3.2, [docs/features/identity.md](../features/identity.md) §2.1, POL-034

## 맥락

통신 표(docs/architecture.md §3.2 gRPC 행)와 openapi 설명에는 호출이 있지만 proto 초안이 없는 것이 넷 남아 있었다. ① ops-svc → ticket-svc 스캐너 기기 등록·폐기·등록 코드 새로 만들기(기기 원장의 주인은 ticket-svc, ADR-0145 대조 반영). ② 계정 병합을 확정하기 전 흡수 계정의 티켓·후기 수 확인. ③ ops-svc → core-svc의 CS 건 읽기·답변·진행 경과·문의 닫기와 홈 구성·아티스트·공연장·다른 이름 반영. ④ core-svc 작업 워커 → image-worker 이미지 처리.

②를 정하려고 POL-034의 병합 차단 사유를 다시 보니, 사유마다 데이터의 주인이 다르다. 좌석 홀드·구매 세션·결제 승인 대기 주문은 purchase-svc, 티켓과 입장 중 회차는 ticket-svc, 후기와 한정 MD 상품 보유량은 core-svc, 탈퇴 진행과 두 계정의 본인확인 내역은 identity-svc 자신, 이상 거래 이의 제기(CS 처리함 `VERIFICATION_APPEAL`·`DISPUTE` 건)와 소명(`appeal`)은 ops-svc 데이터다. 그런데 어떻게 묻는지는 정본에 없었다. ops-svc는 업무 gRPC를 받는 쪽으로 두지 않기로 했다(ADR-0082·0102, ADR-0145 상태 줄). 그래서 ops-svc 데이터는 물을 수 없고, ops-svc가 먼저 알려 줘야 한다.

## 결정

1. **스캐너 기기 관리는 ticket-svc `ScannerDeviceService`다**: `ListScannerDevices`(커서·개수), `RegisterScannerDevice`(이름·배정 파트너), `RevokeScannerDevice`(사유 필수), `ReissueEnrollmentCode` 넷이다. 부르는 쪽은 ops-svc뿐이다. ops-svc가 권한(operator 이상)을 확인하고 감사 기록을 남긴 뒤 부른다. 바꾸는 호출 셋은 ops-svc 감사 기록 ID(`request_id`)로 멱등하다. 응답과 필드는 openapi `/v1/ops/scanner-devices*`의 `ScannerDevice`와 같다. 다만 '지금 로그인한 세션'은 identity 데이터(`scanner_session`)라, ops-svc가 identity-svc `ListActiveScannerSessions`(기기 ID 목록 → 세션 별명)로 따로 읽어 목록에 합친다. 폐기·퇴역한 기기의 `ReissueEnrollmentCode`는 `FAILED_PRECONDITION`이다(새 기기로 등록한다).
2. **등록 코드 원문은 응답에만 싣는다**: `RegisterScannerDevice`·`ReissueEnrollmentCode` 응답의 등록 코드(XXXX-XXXX-XXXX)와 만료 시각은 ticket-svc가 만들어 이 응답에만 싣는다. ticket-svc는 코드의 SHA-256만 Redis에 10분 [가정] 둔다(openapi와 같다). ops-svc는 받은 코드를 브라우저 응답으로만 넘기고 DB·로그·추적 속성에 남기지 않는다. 같은 `request_id`로 다시 오면 새 코드를 만들지 않고 '이미 만듦'만 돌려준다(코드를 다시 보이려면 새로 만들기를 한다). 폐기는 ticket-svc가 기기 상태를 `REVOKED`로 바꾸는 것이다. 스캐너 요청은 요청마다 기기 상태를 확인하므로 다음 요청부터 막히고, 그 기기의 스태프 세션도 그때 끝난다(docs/features/offline-gate.md §6.1).
3. **계정 병합 사전 확인은 데이터 주인 서비스마다 같은 모양으로 묻는다**: purchase-svc·ticket-svc·core-svc가 `CheckAccountMerge(primary_account_id, absorbed_account_id)`를 두고, 자기 데이터로 본 막는 사유 목록(`reason` + 참조 ID)을 돌려준다. purchase-svc는 두 계정의 진행 중 좌석 홀드·구매 세션·결제 승인 대기 주문, ticket-svc는 흡수 계정의 티켓(있으면 불변식 위반)과 어느 계정이든 입장 시작부터 입장 기록 마감 사이인 회차의 티켓, core-svc는 흡수 계정의 후기(있으면 불변식 위반)와 두 계정을 더한 한정 MD 보유량의 1인 한도 초과를 본다. 흡수 계정은 본인확인 전이라 티켓이 없으므로, 티켓의 합산 한도는 ticket-svc의 불변식 사유가 대신한다. 읽기라 멱등 키는 없다.
4. **부르는 때와 실패 처리**: identity-svc는 병합 제안을 만들 때(막는 사유를 화면에 보이려고)와 확정 트랜잭션 바로 앞에 셋을 함께 부른다. 호출마다 기한은 1초 [가정]이다. 셋 가운데 하나라도 답하지 않거나 기한을 넘기면 확정하지 않고 503과 `Retry-After`로 '잠시 뒤 다시' 안내한다(모르면 막는 쪽으로 닫는다). 불변식 사유는 지금처럼 409와 SEV3이다(docs/features/identity.md §2.1).
5. **ops-svc 데이터의 막는 사유는 ops-svc가 identity-svc에 알린다**: ops-svc는 계정에 걸린 이의 제기(CS 처리함 `VERIFICATION_APPEAL`·`DISPUTE`)나 소명(`appeal`)이 열리고 닫힐 때 identity-svc `AccountHoldService.SetAccountHold`를 부른다(`source_ref` = 건 ID로 멱등, 열림·닫힘). identity-svc는 identity DB `account_hold`(계정 ID, 종류, 출처 건 ID, 상태, 출처 판 번호) 행으로 두고, 병합 때 자기 데이터처럼 본다. 요청에는 ops 건 상태의 판 번호(`source_version`)를 싣고, identity-svc는 저장한 판보다 클 때만 반영한다. 닫힌 건도 행을 `CLOSED`로 30일 [가정] 남겨, 재시도로 늦게 온 '열림'이 닫힌 건을 다시 열지 않게 한다. 문의로 접수한 분쟁 건의 계정 ID는 ops-svc가 `SupportCaseService.GetInquiryRecord`로 읽는다. ops-svc는 부르는 쪽으로만 남는다. 호출이 실패하면 ops-svc 작업 워커가 성공할 때까지 다시 보낸다(건 상태 변경과 같은 트랜잭션에 보낼 일을 적는다).
6. **확정 뒤 틈은 계정 묶음으로 센다**: 확정 직전 확인과 확정 트랜잭션 사이(수백 ms)에 대표 계정으로 새 홀드나 MD 주문이 생길 수 있다. 흡수 계정은 확정 트랜잭션에서 `MERGED`로 잠겨 새 홀드·주문을 만들지 못한다. 병합 뒤 core-svc shop과 purchase-svc의 1인 한도 검사는 대응표(`merged_account`)로 대표 계정과 흡수 계정의 묶음을 함께 센다. 그래서 틈에서 생긴 주문도 다음 주문부터 한도에 든다.
7. **관제의 CS·카탈로그 반영은 core-svc `SupportCaseService`·`CatalogAdminService`다**: `SupportCaseService`는 CS 건 상세의 문의 기록 읽기, 답변·진행 경과 남기기, 문의 닫기를 둔다. `CatalogAdminService`는 홈 구성 읽기·게시, 홈 배너 이미지 올리기 주소 만들기, 아티스트·공연장 찾기·만들기·고치기, 아티스트·공연장·공연의 다른 이름 반영을 둔다. 게시물 신고 건 상세(사유별 신고 수, 신고 상세, 후기 본문과 사진 파생본 키)는 `ReviewModerationService`의 읽기로 둔다. 신고한 계정은 싣지 않는다. 홈 배너 이미지는 후기 사진처럼 처리가 끝난 뒤 응답한다(openapi `ReviewImageUpload`와 같은 방식). ops-svc가 `CreateBannerUpload`로 받은 올리기 주소(5분 [가정])로 서버 쪽에서 격리 버킷에 넣고, `CompleteBannerUpload`로 처리를 맡긴다. core-svc는 이 호출 안에서 image-worker 결과를 기다려(기한 30초 [가정]) 받았으면 미리보기 파생본 키를, 받지 않았으면 거절 사유를 돌려준다. 그래서 REST는 지금처럼 201(imageId, 미리보기 주소) 또는 415·422다. 부르는 쪽은 ops-svc뿐이고, ops-svc가 권한과 감사 기록을 처리한 뒤 관리 계정 ID(`acted_by`)를 실어 부른다. core-svc는 관리 권한을 다시 판정하지 않고, 받는 신원을 웨이포인트 허용 목록으로 ops-svc만 받는다. 바꾸는 호출은 `request_id`로 멱등하고, 본문은 openapi 같은 경로의 본문과 같다. 팬에게는 '피켓 고객센터'로만 보이도록 담당자 이름은 싣지 않는다.
8. **이미지 처리는 image-worker `ImageService.ProcessImage`다**: core-svc 작업 워커가 원본 객체 키와 종류(공연 이미지·홈 배너·후기 사진)를 보내고, 상태(`ACCEPTED`·`REJECTED`), 파생본 키, 폭·높이, 거절 사유를 받는다. 원본 키로 멱등하다(같은 원본은 같은 결과). 기한은 30초 [가정]이고, 넘으면 작업 워커가 작업 원장에서 다시 맡긴다. 악성 코드 검사 결과가 아직 붙지 않은 원본은 처리하지 않고 `SCAN_PENDING`으로 답하며(작업 워커가 1분 [가정] 뒤 다시 맡긴다), 위협으로 나온 원본은 `REJECTED`(악성 코드)로 답한다. image-worker는 DB·Kafka 자격 증명이 없다(ADR-0130, D-T35).
9. **통신 표와 받는 쪽 허용 목록을 맞춘다**: §3.2 gRPC 행에 identity-svc → purchase-svc·ticket-svc·core-svc(`CheckAccountMerge`), ops-svc → identity-svc(`SetAccountHold`, `ListActiveScannerSessions`)를 더하고, '이 호출들의 proto 초안은 구현 때 더한다' 문장을 지운다. §4 '포트별 허용 표'의 업무 gRPC 포트 허용 신원에 같은 부르는 쪽을 더한다. proto README §3 호출 표에 행을 더하고 §4의 해당 행을 지운다.
10. **컴파일 검사는 CI의 buf에 맡긴다**: 이 초안들은 계약 저장소(`peaket-contracts`)로 옮길 때 `buf lint`·`buf breaking`으로 검사한다(wbs 0.2.2). 이 저장소에는 buf·protoc를 설치하지 않았다. 2026-10-29에는 문법 구조(괄호 짝, 메시지·열거 이름, 필드 번호 겹침, 열거 0값, 가져온 파일)만 스크립트로 확인했다.

## 검토한 대안

- **identity-svc가 각 서비스 DB를 직접 읽기**: 호출 하나가 줄지만 논리 DB 사이를 넘는다. 기각.
- **병합 사전 확인을 이벤트로 모으기**(각 서비스가 계정별 '막는 사유' 상태를 Kafka로 내고 identity가 모아 두기): 확정 때 호출이 없지만, 홀드·구매 세션처럼 몇 분짜리 상태까지 계속 흘려야 한다. 병합은 드문 작업이라 그때 묻는 쪽이 싸다. 기각.
- **ops-svc에 `CheckAccountMerge`를 두기**: 모양은 같아지지만 ops-svc가 업무 gRPC를 받는 쪽이 되어 웨이포인트와 공유 노드 풀에 다시 묶인다(ADR-0102). 기각하고 결정 5로 한다.
- **등록 코드를 ops-svc가 만들기**: ops-svc가 코드 해시를 ticket-svc에 넘겨야 하고 코드 원문이 두 서비스를 지난다. 원장의 주인이 만드는 쪽이 짧다. 기각.

## 결과와 트레이드오프

- 계정 병합 확정은 세 서비스 가운데 하나만 아파도 미뤄진다. 병합은 드물고 되돌릴 수 없는 작업이라 받아들인다.
- ops-svc의 이의 제기·소명 알림이 늦으면(재시도 중) 그 사이 병합이 지나갈 수 있다. 재시도 지연은 작업 워커 주기(1분 [가정]) 안팎이고, 남는 한계로 둔다.
- identity-svc의 업무 gRPC 포트가 ops-svc 신원을 하나 더 받는다.

## 되돌릴 조건

- 병합 요청이 하루 수천 건을 넘어 확정 지연이 문제가 되면 결정 3을 이벤트 모으기로 바꾼다.
- ops-svc가 업무 gRPC를 받아도 된다는 결정이 나오면 결정 5를 `CheckAccountMerge`로 바꾼다.
