# entities — 파트너 콘솔 목업

퍼블리싱 단계의 합성 데이터(고정 값)다. 실제 회사·사람·계좌가 아니다. 데이터를 잇는 단계(ADR-0170)에서 api-client 훅으로 바꾼다. 다른 담당은 이 폴더의 기존 파일을 고치지 않고 읽기만 한다(새 목업은 자기 페이지 폴더의 `model/`이나 새 entities 폴더에).

- `partner-org` — 조직 (주)스텔라엔터테인먼트(`stellaOrg`): 판매자 정보 7항목(`SELLER_FIELDS` 순서), 정산 계좌, 수수료율.
- `partner-user` — 로그인한 사람 `me`(파트너 담당자, 파트너 관리자)와 팀 계정 `team`, 역할 이름 `PARTNER_ROLE_LABEL`, 관리자 전용 이유 글 `ADMIN_ONLY_REASON`.
- `production` — 공연 6건 `productions`(SCR-062 보드 순서), `getProduction(id)`·`requireProduction(id)`(없으면 404, 공연 문맥 페이지에서), 기본 공연 `PRIMARY_PRODUCTION_ID`(evt-lumen-2026), 판매 승인·판매 상태 이름과 배지 클래스, `formatWon`.
- `venue` — 공연장 `venues`(피켓 아레나 등 지어낸 이름), `getVenue(id)`.
- `artist` — 아티스트 `artists`(LUMEN 등).
- `seatmap` — 좌석 템플릿 10종 `seatmapTemplates`·분류 `TEMPLATE_FAMILIES`, LUMEN 배치본 요약 `lumenSeatmapSummary`.
- `notification` — 셸 알림함 `notifications`, 긴급 공지 `urgentNotice`.
