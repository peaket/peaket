# 문서 점검이 읽는 파일 목록의 시험(BUILD_ORDER BSL-030, R-235).
# drizzle-kit이 만드는 마이그레이션 메타(migrations/meta/*.json)는 문서가 아니다. 첫 스냅숏의 prevId가 0 UUID라
# '12자리 숫자' 규칙(공개 문서에 계정 번호 없음)에 걸렸다. pnpm-lock.yaml처럼 읽지 않는다.
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_all as dc  # noqa: E402


class LoadFilesTest(unittest.TestCase):
    def test_R235_drizzle마이그레이션메타는읽지않고_다른json은읽는다(self):
        with tempfile.TemporaryDirectory() as root:
            meta = os.path.join(root, 'services', 'svc', 'migrations', 'meta')
            os.makedirs(meta)
            with io.open(os.path.join(meta, '0000_snapshot.json'), 'w', encoding='utf-8') as f:
                f.write('{"prevId": "00000000-0000-0000-0000-000000000000"}\n')
            with io.open(os.path.join(root, 'services', 'svc', 'package.json'), 'w', encoding='utf-8') as f:
                f.write('{"name": "svc"}\n')
            old = dc.ROOT
            dc.ROOT = root
            try:
                texts = dc.load_files()
            finally:
                dc.ROOT = old
            self.assertIn('services/svc/package.json', texts)
            self.assertNotIn('services/svc/migrations/meta/0000_snapshot.json', texts)


if __name__ == '__main__':
    unittest.main()
