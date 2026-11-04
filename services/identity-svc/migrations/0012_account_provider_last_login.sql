-- 로그인 수단의 마지막 로그인 시각(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', docs/data.md account_provider, BUILD_ORDER BOT-041).
-- 기본값 없는 null 허용 칸 더하기라 표를 다시 쓰지 않는다. 이 칸 전의 로그인은 null이다.
ALTER TABLE "account_provider" ADD COLUMN "last_login_at" timestamp with time zone;