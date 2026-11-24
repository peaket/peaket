-- 찜 목록(F-05-8, openapi listWishes): 검색 읽기 전용 연결(core_search)이 카드 원천 함수를 부를 수 있게 한다.
-- search_document_source_at은 SECURITY DEFINER이고 0023이 core_app·core_ops에만 실행을 허락했다.
-- 목록은 표(search_document)가 아니라 지금 값을 계산하는 이 함수를 읽어, 읽기 모델 동기화(1분) 지연 없이
-- 판매 승인 취소·중지를 반영한다. 읽기만 더하며 표·칸은 바꾸지 않는다.
GRANT EXECUTE ON FUNCTION search_document_source_at(timestamptz, uuid[]) TO core_search;
