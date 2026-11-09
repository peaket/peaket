-- 계정의 이메일 검증 여부(docs/features/identity.md §2.1 '가입 때 연결 제안의 첫 구현', docs/data.md account, BUILD_ORDER BOT-040).
-- 상수 기본값이 있는 칸 더하기라 표를 다시 쓰지 않는다(PostgreSQL 11 이상). 이 칸 전에 만든 계정은 false라 연결 대상이 아니다.
-- 이메일 찾기 인덱스는 트랜잭션 밖 인덱스 파일을 돌리는 실행기(BAS-060) 뒤에 따로 더한다(docs/devops.md §7.2).
ALTER TABLE "account" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;