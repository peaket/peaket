-- 판매 승인 잔여(LCH-080)의 관제 연결 권한이다(ADR-0093 결정 4·ADR-0198 결정 4).
-- core_ops가 아티스트·공연장을 찾아 만들고, 승인 트랜잭션에서 production_artist를 쓰고 requested_artists를 비운다.
-- 팬(core_app)·파트너(core_partner) 권한은 넓히지 않는다. 다른 이름 고치기(search_alias 쓰기)는 이 몫이 아니다.
GRANT SELECT ON artist TO core_ops;
--> statement-breakpoint
GRANT INSERT ON artist TO core_ops;
--> statement-breakpoint
-- 찾기 목록은 공연장의 이름·주소·지역·상태와 다른 이름을 읽는다(주소를 새 공연장 중복 검사에 쓴다).
GRANT SELECT (id, name, address, region, status) ON place TO core_ops;
--> statement-breakpoint
GRANT INSERT ON place TO core_ops;
--> statement-breakpoint
GRANT SELECT ON search_alias TO core_ops;
--> statement-breakpoint
-- 승인은 이미 등록된 아티스트 행을 그대로 두고, 새 이름 요청분만 더한다.
GRANT SELECT, INSERT ON production_artist TO core_ops;
--> statement-breakpoint
-- 승인 저장소가 requested_artists를 비운다(place_id·requested_place는 0012에 있다).
GRANT UPDATE (requested_artists) ON production TO core_ops;
