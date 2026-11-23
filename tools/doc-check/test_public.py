"""문서 점검 도구 `public` 검사의 공인 대역 시험(ADR-0153, docs/devops.md §2.1, BUILD_ORDER BSL-060).

공개 문서에 실제 운영 망 주소를 적지 않게 하되, 사설·공유·링크 로컬·루프백·문서용(RFC 5737)과 성능 측정용(RFC 2544,
198.18.0.0/15) 대역은 적을 수 있다. 측정용 대역은 부하 시험의 가상 사용자 IP다(docs/verification.md §3.9 '신원').
실행: python -I -m unittest discover -s tools/doc-check -p "test_*.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_all as dc  # noqa: E402


def errors(line):
    rep = dc.Report()
    dc.check_public({'docs/x.md': line}, rep)
    return [e['msg'] for e in rep.errors if e['check'] == 'public']


class 공인대역(unittest.TestCase):
    def test_NFR013_측정용대역_198_18_0_0_15와_그안의_대역은_적을수있다(self):
        for line in ('가상 사용자 IP는 198.18.0.0/15에서 붙인다', '198.19.0.0/16', '198.18.1.0/24'):
            self.assertEqual([], errors(line), line)

    def test_PRF192_나가는연결제외목록의_특수용도대역은_적을수있고_그밖의대역은_여전히오류다(self):
        for line in ('0.0.0.0/8', '192.0.0.0/24', '224.0.0.0/4', '240.0.0.0/4'):
            self.assertEqual([], errors(line), line)
        for line in ('192.0.0.0/23', '192.0.1.0/24', '223.0.0.0/8'):
            self.assertEqual(1, len(errors(line)), line)

    def test_NFR013_측정용대역을_넘는_대역과_실제공인대역은_오류다(self):
        for line in ('198.18.0.0/14', '198.20.0.0/16', '8.8.8.0/24', '52.95.0.0/16'):
            self.assertEqual(1, len(errors(line)), line)

    def test_NFR013_사설·문서용대역은_그대로_통과한다(self):
        for line in ('10.0.0.0/8', '192.168.1.0/24', '100.64.0.0/10', '203.0.113.0/24', '0.0.0.0/0'):
            self.assertEqual([], errors(line), line)


ACCOUNT_MSG = '12자리 숫자(계정 번호로 읽힘)'


def account_errors(line):
    return [m for m in errors(line) if m.startswith(ACCOUNT_MSG)]


class 열두자리숫자(unittest.TestCase):
    """쉼표 없는 12자리 숫자는 실제 계정 번호로 읽혀 오류다(ADR-0153 결정 2, docs/devops.md §2.1, tools/doc-check/README.md `public`).

    영숫자 덩어리(sha256 같은 해시) 안에 우연히 든 12자리 숫자는 계정 번호가 아니다(FIX-gw-routes).
    """

    SHA_LINE = ('# openapi info.version 1.0.0-draft · 계약 sha256 '
                'e938bd0059856fe657339cc3b0f63b3afa6ad1f308842924757b6dffe810d7d7')

    def test_DT42_1_게이트웨이라우트_생성물의_계약sha256줄은_계정번호로_잡지않는다(self):
        self.assertEqual([], account_errors(self.SHA_LINE))
        self.assertEqual([], errors(self.SHA_LINE))

    def test_DT42_2_공백·문장부호·줄끝에_둘러싸인_단독12자리숫자는_여전히오류다(self):
        for line in ('계좌 123456789012', '123456789012', '계정 번호 123456789012 를 쓴다',
                     '(123456789012)', '계정: 123456789012', '`123456789012`', 'id=123456789012'):
            self.assertEqual(1, len(account_errors(line)), line)

    def test_DT42_3_영숫자에_붙은_12자리숫자는_잡지않는다(self):
        for line in ('abc123456789012def', 'abc123456789012', '123456789012def', 'F308842924757B'):
            self.assertEqual([], account_errors(line), line)

    def test_DT42_4_쉼표·마침표·숫자_경계는_그대로다(self):
        for line in ('금액 123,456,789,012원', '1,123456789012', '1.123456789012', '123456789012,5',
                     '1234567890123', '12345678901'):
            self.assertEqual([], account_errors(line), line)


if __name__ == '__main__':
    unittest.main()
