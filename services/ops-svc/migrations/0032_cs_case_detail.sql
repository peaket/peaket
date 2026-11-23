-- F-07-7 LCH-120(ADR-0370 결정 7·8, 계획 §5.1 (타) 결정 2): CS 처리함 건의 본문 글(선택).
-- payment-svc 정산 일꾼이 '포트원 일괄 지급 실행'·'포트원 원장 불일치' 건에 뺀 정산서 ID·사유·'commander 확인 필요'·'실행 멈춤'만 싣는다.
-- 처음 연 건에만 저장하고 같은 사건 키를 다시 받아도 바꾸지 않는다. 주문 ID·계정 ID·계좌번호·예금주명은 싣지 않는다(architecture §8.3).
-- null 허용이라 옛 행은 그대로다. 번호 0031은 갈래 3 F-06-7 몫으로 비워 둔다(합칠 때 감독이 맞춘다).

ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE cs_case DROP CONSTRAINT IF EXISTS cs_case_detail_check;
ALTER TABLE cs_case ADD CONSTRAINT cs_case_detail_check CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 2000);
