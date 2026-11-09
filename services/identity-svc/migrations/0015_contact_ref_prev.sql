-- 조사용 가명 키 회전의 이음: 연락처 가명의 옛 판 값(docs/features/identity.md §9.1 '조사용 가명 키 회전 이음의 첫 구현', docs/data.md account_contact_ref.ref_prev, BUILD_ORDER BOT-046).
-- 널 허용 칸을 더할 뿐이라 표를 다시 쓰지 않는다.
ALTER TABLE "account_contact_ref" ADD COLUMN "ref_prev" text;