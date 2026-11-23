"""마감 실행기 끝까지 시험(F-04-6 빠른 길, docs/features/analytics.md §3.2·§4·§7, A-T7·A-T9·A-T18 성격).

실제 ClickHouse 컨테이너 + dbt + 빌드한 마감 실행기(`node services/close-runner/dist/main.js run-once --now <데모 시각>`)로
판매 기간 120일 비매진 회차 L을 R0 → R1 → R2 → 매일 → (원시 90일 지움 흉내) → 매일 → R3까지 돌리고, 짧은 회차 M의 R3 정산서 1원 차이를 본다.
기준 자료는 수집 폴더 파일로 실행기가 싣는다. 자기가 띄운 컨테이너 ID만 지운다.

돌리기(data 폴더에서, Docker 잠금을 잡은 뒤, 먼저 `pnpm --filter @peaket/close-runner build`):
  PYTHONUTF8=1 .venv/Scripts/python -m unittest tests_int.test_close_runner -v
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import clickhouse_connect

from tests_int.test_dbt_models import DATA, DBT, IMAGE, PASSWORD, USER, free_port, statements

ROOT = DATA.parent
RUNNER = ROOT / 'services' / 'close-runner' / 'dist' / 'main.js'
KST = timezone(timedelta(hours=9))
L, M = str(uuid.uuid4()), str(uuid.uuid4())
L_OPEN = datetime(2026, 3, 6, 11, 0, tzinfo=KST)   # 금요일
L_STARTS = datetime(2026, 7, 4, 19, 0, tzinfo=KST)  # 토요일 → R3는 7월 6일(월) 10시
M_OPEN = datetime(2026, 3, 2, 11, 0, tzinfo=KST)
M_STARTS = datetime(2026, 3, 5, 19, 0, tzinfo=KST)  # 목요일 → R3는 3월 6일(금) 10시
COLS = ['event_id', 'event_key', 'record', 'occurred_at', 'key_version', 'schema_id', 'payload', 'kafka_topic', 'kafka_partition', 'kafka_offset', 'kafka_ts']


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


class CloseRunner(unittest.TestCase):
    container: str
    ch = None
    offset = 0

    @classmethod
    def setUpClass(cls):
        assert RUNNER.exists(), f'{RUNNER}가 없다. pnpm --filter @peaket/close-runner build를 먼저 돌린다'
        cls.port = free_port()
        cls.container = subprocess.check_output([
            'docker', 'run', '-d', '-e', f'CLICKHOUSE_USER={USER}', '-e', f'CLICKHOUSE_PASSWORD={PASSWORD}', '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
            '-p', f'127.0.0.1:{cls.port}:8123', '--ulimit', 'nofile=262144:262144', IMAGE,
        ], text=True).strip()
        end = time.time() + 120
        while True:
            try:
                cls.ch = clickhouse_connect.get_client(host='127.0.0.1', port=cls.port, username=USER, password=PASSWORD)
                cls.ch.command('SELECT 1')
                break
            except Exception:
                if time.time() > end:
                    raise
                time.sleep(0.5)
        for f in sorted((DATA / 'clickhouse' / 'bronze').glob('*.sql')):
            for s in statements(f.read_text(encoding='utf-8')):
                cls.ch.command(s)
        cls.intake = tempfile.mkdtemp(prefix='intake-')
        cls.holidays = str(Path(cls.intake) / 'holidays.json')
        Path(cls.holidays).write_text(json.dumps({'holidays': ['2026-03-10']}), encoding='utf-8')
        cls.write_refs()

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker', 'rm', '-f', '-v', cls.container], capture_output=True)

    # ---- 합성 원천 ----
    @classmethod
    def write_refs(cls):
        ev = Path(cls.intake) / 'ref-event'
        sm = Path(cls.intake) / 'ref-seat-map'
        ev.mkdir()
        sm.mkdir()
        rows = [
            {'event_id': L, 'production_id': 'prod-l', 'production_name': '긴 판매 공연', 'genre': 'MUSICAL', 'venue_id': 'v-1', 'venue_name': '피켓 홀', 'starts_at': iso(L_STARTS), 'open_at': iso(L_OPEN),
             'sale_end_at': None, 'seat_count': 10, 'sale_policy': '{}', 'promoter_name': '피켓 기획', 'size_grade': 'MEDIUM'},
            {'event_id': M, 'production_id': 'prod-m', 'production_name': '짧은 공연', 'genre': 'CONCERT', 'venue_id': 'v-1', 'venue_name': '피켓 홀', 'starts_at': iso(M_STARTS), 'open_at': iso(M_OPEN),
             'sale_end_at': None, 'seat_count': 10, 'sale_policy': '{}', 'promoter_name': '피켓 기획', 'size_grade': 'SMALL'},
        ]
        (ev / '2026-03-01.json').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), encoding='utf-8')
        seats = [{'event_id': e, 'layout_version': 1, 'section_id': 'S', 'section_name': 'S구역', 'tier_id': 'S', 'price': 100_000, 'seat_count': 10, 'seat_index_from': 1, 'seat_index_to': 10} for e in (L, M)]
        (sm / '2026-03-01.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in seats), encoding='utf-8')

    @classmethod
    def rows(cls, table: str, record: str, items: list[tuple[str, datetime, dict]]):
        out = []
        for e, at, payload in items:
            cls.offset += 1
            out.append([e, str(uuid.uuid4()), record, at, 'local-v1', 1, json.dumps({'eventId': e, **payload}), 't', 0, cls.offset, at])
        cls.ch.insert(f'bronze.{table}', out, column_names=COLS)

    @classmethod
    def sale(cls, e: str, at: datetime, order: str, seat: str, pg: str):
        item = {'seatId': seat, 'tierId': 'S', 'sectionId': 'S', 'price': 100_000}
        cls.rows('brz_order_event', 'OrderEvent', [(e, at, {'orderId': order, 'type': 'CONFIRMED', 'amount': 100_000, 'items': [item], 'firstInStage': True})])
        cls.rows('brz_payment_event', 'PaymentEvent', [(e, at, {'orderId': order, 'pg': pg, 'type': 'APPROVED', 'amount': 100_000, 'payMethodCategory': 'CARD', 'latencyMs': 300})])
        cls.rows('brz_seat_event', 'SeatEvent', [(e, at, {'seatId': seat, 'tierId': 'S', 'sectionId': 'S', 'type': 'SOLD'})])

    @classmethod
    def statement(cls, e: str, pg: str, sales: int, refund: int, revision: int = 1):
        cls.rows('brz_settlement_event', 'SettlementEvent', [(e, datetime.now(timezone.utc), {'promoterId': 'p-1', 'statementId': f'st-{e[:6]}-{pg}-{revision}', 'kind': 'EVENT', 'pg': pg,
                                                                                           'type': 'STATEMENT_NOTIFIED', 'salesAmount': sales, 'refundAmount': refund, 'revision': revision})])

    # ---- 실행기 ----
    def run_once(self, now: datetime, dbt_bin: str | None = None) -> tuple[int, list[dict]]:
        env = {**os.environ, 'PYTHONUTF8': '1', 'PEAKET_ANALYTICS_CLICKHOUSE_HOST': '127.0.0.1', 'PEAKET_ANALYTICS_CLICKHOUSE_PORT': str(self.port),
               'PEAKET_ANALYTICS_CLICKHOUSE_USER': USER, 'PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD': PASSWORD,
               'PEAKET_DBT_BIN': dbt_bin or DBT, 'PEAKET_DBT_PROJECT_DIR': str(DATA), 'PEAKET_CLOSE_INTAKE_DIR': self.intake,
               'PEAKET_HOLIDAY_CALENDAR_FILE': self.holidays}
        r = subprocess.run(['node', str(RUNNER), 'run-once', '--now', iso(now)], cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8', timeout=1500)
        lines = [json.loads(l) for l in r.stdout.splitlines() if l.startswith('{')]
        return r.returncode, lines

    def runs(self, lines: list[dict]) -> list[tuple]:
        return [(l['eventId'], l['stage'], l['task'], l['result']) for l in lines if l.get('kind') == 'close-run']

    def q(self, sql: str):
        return self.ch.query(sql).result_rows

    def current(self, e: str) -> str:
        return self.q(f"SELECT argMax(run_id, switched_at) FROM gold.current_run WHERE event_id = '{e}'")[0][0]

    def stage(self, e: str) -> str:
        return self.q(f"SELECT close_stage FROM gold.fct_event_summary WHERE event_id = '{e}' AND run_id = '{self.current(e)}'")[0][0]

    def test_long_sale_through_r3_and_statement_mismatch(self):
        # 오픈 첫날 L 판매 둘(토스), M 판매 하나(토스)와 M 정산서(판매 대금 100,001 → 1원 차이, A-T9)
        self.sale(L, L_OPEN + timedelta(minutes=5), 'l1', 'S-1', 'TOSS')
        self.sale(L, L_OPEN + timedelta(minutes=6), 'l2', 'S-2', 'TOSS')
        self.sale(M, M_OPEN + timedelta(minutes=5), 'm1', 'S-1', 'TOSS')
        self.statement(M, 'TOSS', 100_001, 0)

        # ① 3월 6일 12:40: 기준 자료 파일 둘을 싣고, M은 R3(공연 다음 영업일 10시가 지남), L은 R0
        code, lines = self.run_once(datetime(2026, 3, 6, 12, 40, tzinfo=KST))
        self.assertEqual(self.runs(lines), [(M, 'R3', 'STAGE', 'DONE'), (L, 'R0', 'STAGE', 'DONE')], lines)
        self.assertEqual(code, 0)
        self.assertEqual(self.q("SELECT target, result, rows FROM bronze.brz_intake_log ORDER BY target"), [('bronze.brz_ref_event', 'LOADED', 2), ('bronze.brz_ref_seat_map', 'LOADED', 2)])
        # 날짜 차원의 영업일·공휴일 칸은 마감 실행기가 넘긴 달력(2026-03-10 휴일)을 따른다
        self.assertEqual(self.q("SELECT holiday, business_day FROM gold.dim_date WHERE day IN ('2026-03-09', '2026-03-10') ORDER BY day"), [(0, 1), (1, 0)])
        m = [l for l in lines if l.get('kind') == 'close-run' and l['eventId'] == M][0]
        self.assertEqual(m['qualityFailed'], ['sales_amount'])
        self.assertIn('100001', m['detail'])
        self.assertEqual(self.q(f"SELECT status, affects FROM gold.mtr_data_quality WHERE event_id = '{M}' AND check_name = 'external'"), [('FAIL', ['sales_amount'])])
        self.assertEqual(self.stage(L), 'R0')
        r0 = self.current(L)

        # ② A-T7: 3월 9일 10:05 R1을 dbt 실패로 돌리면 판을 바꾸지 않고 FAILED, 같은 시각에 다시 돌리면 R1
        code, lines = self.run_once(datetime(2026, 3, 9, 10, 5, tzinfo=KST), dbt_bin=sys.executable)
        self.assertEqual((code, self.runs(lines)), (1, [(L, 'R1', 'STAGE', 'FAILED')]))
        self.assertEqual(self.current(L), r0)
        code, lines = self.run_once(datetime(2026, 3, 9, 10, 5, tzinfo=KST))
        self.assertEqual((code, self.runs(lines)), (0, [(L, 'R1', 'STAGE', 'DONE')]))

        # ③ 3월 13일 11:05 R2(오픈 + 7일)
        code, lines = self.run_once(datetime(2026, 3, 13, 11, 5, tzinfo=KST))
        self.assertEqual(self.runs(lines), [(L, 'R2', 'STAGE', 'DONE')])
        r2 = self.current(L)

        # ④ 3월 16일 판매 하나(포트원) → 3월 17일 매일 쌓기: F15에는 들어오고, 온세일 F2는 R2 판 그대로(동결)
        self.sale(L, datetime(2026, 3, 16, 14, 0, tzinfo=KST), 'l3', 'S-3', 'PORTONE')
        code, lines = self.run_once(datetime(2026, 3, 17, 9, 0, tzinfo=KST))
        self.assertEqual(self.runs(lines), [(L, 'R2', 'DAILY', 'DONE')])
        cur = self.current(L)
        self.assertEqual(self.q(f"SELECT sum(sold_seats) FROM gold.fct_sales_daily WHERE event_id = '{L}' AND run_id = '{cur}'")[0][0], 3)
        f2 = lambda run: self.q(f"SELECT sum(sold_seats) FROM gold.fct_sales_minute WHERE event_id = '{L}' AND run_id = '{run}'")[0][0]
        self.assertEqual((f2(r2), f2(cur)), (2, 2))
        # 같은 날 다시 돌리면 할 일 없음
        self.assertEqual(self.runs(self.run_once(datetime(2026, 3, 17, 15, 0, tzinfo=KST))[1]), [])

        # ⑤ 원시 90일 지움 흉내: 3월 20일 앞의 브론즈 사건과 L 기준 자료를 지운다(실버는 다음 빌드가 브론즈에서 다시 만든다)
        for t in ['brz_order_event', 'brz_payment_event', 'brz_seat_event']:
            self.ch.command(f"ALTER TABLE bronze.{t} DELETE WHERE event_id = '{L}' AND occurred_at < '2026-03-20 00:00:00' SETTINGS mutations_sync = 2")
        for t in ['brz_ref_event', 'brz_ref_seat_map']:
            self.ch.command(f"ALTER TABLE bronze.{t} DELETE WHERE event_id = '{L}' SETTINGS mutations_sync = 2")
        self.assertEqual(self.q(f"SELECT count() FROM bronze.brz_order_event WHERE event_id = '{L}'")[0][0], 0)

        # ⑥ 6월 14일: 판매 하나(토스), l3 예매 취소 환불 100,000·좌석 반환. 정산서(토스 300,000·포트원 100,000, 환급 100,000)
        d100 = datetime(2026, 6, 14, 15, 0, tzinfo=KST)
        self.sale(L, d100, 'l4', 'S-4', 'TOSS')
        self.rows('brz_order_event', 'OrderEvent', [(L, d100 + timedelta(hours=1), {'orderId': 'l3', 'type': 'REFUNDED', 'amount': 100_000, 'refundAmount': 100_000,
                                                                                    'items': [{'seatId': 'S-3', 'tierId': 'S', 'sectionId': 'S', 'price': 100_000}], 'firstInStage': False})])
        self.rows('brz_seat_event', 'SeatEvent', [(L, d100 + timedelta(hours=1), {'seatId': 'S-3', 'tierId': 'S', 'sectionId': 'S', 'type': 'RETURNED'})])
        self.statement(L, 'TOSS', 300_000, 0)
        self.statement(L, 'PORTONE', 100_000, 100_000)
        # 6월 15일 매일 쌓기: 기준 자료가 브론즈에서 사라졌어도 골드 현재 판 차원으로 회차를 찾고, 80일 앞(3월 27일 전)의 날은 앞 판에서 잇는다
        code, lines = self.run_once(datetime(2026, 6, 15, 9, 0, tzinfo=KST))
        self.assertEqual(self.runs(lines), [(L, 'R2', 'DAILY', 'DONE')])
        cur = self.current(L)
        days = self.q(f"SELECT toString(day), pg, sold_seats, sales_amount, returned_seats FROM gold.fct_sales_daily WHERE event_id = '{L}' AND run_id = '{cur}' ORDER BY day, pg")
        self.assertEqual([(d, p, s, a) for d, p, s, a, _ in days if s > 0], [('2026-03-06', 'TOSS', 2, 200_000), ('2026-03-16', 'PORTONE', 1, 100_000), ('2026-06-14', 'TOSS', 1, 100_000)])
        self.assertEqual(self.q(f"SELECT count() FROM gold.dim_event WHERE event_id = '{L}' AND run_id = '{cur}'")[0][0], 1)

        # ⑦ 7월 6일 10:05 R3: 정산서와 0원 차이, F11 판매 좌석 = F15 판매 − 되돌림 − 반환 = 3, 판매 금액 400,000, 온세일 F2는 여전히 R2 판 값
        code, lines = self.run_once(datetime(2026, 7, 6, 10, 5, tzinfo=KST))
        self.assertEqual((code, self.runs(lines)), (0, [(L, 'R3', 'STAGE', 'DONE')]))
        r3 = [l for l in lines if l.get('kind') == 'close-run'][0]
        self.assertEqual((r3['qualityFailed'], r3['detail']), ([], '정산서와 0원 차이'))
        cur = self.current(L)
        self.assertEqual(self.q(f"SELECT sold_seats, sales_amount, close_stage FROM gold.fct_event_summary WHERE event_id = '{L}' AND run_id = '{cur}'"), [(3, 400_000, 'R3')])
        self.assertEqual(f2(cur), 2)
        self.assertEqual(self.q(f"SELECT value FROM gold.mtr_event_metric WHERE event_id = '{L}' AND metric = 'sales_amount'"), [(400_000.0,)])
        self.assertEqual(self.q(f"SELECT dim, value FROM gold.mtr_event_metric WHERE event_id = '{L}' AND metric = 'refunds'"), [('SELF', 100_000.0)])
        self.assertEqual(self.q(f"SELECT count() FROM gold.mtr_data_quality WHERE event_id = '{L}' AND status = 'FAIL'")[0][0], 0)
        # 실행 기록: L은 R0·R1(실패)·R1·R2·매일 둘·R3, M은 R3
        log = self.q(f"SELECT stage, kind, result FROM gold.close_run_log WHERE event_id = '{L}' ORDER BY started_at, result DESC")
        self.assertEqual(log, [('R0', 'STAGE', 'DONE'), ('R1', 'STAGE', 'FAILED'), ('R1', 'STAGE', 'DONE'), ('R2', 'STAGE', 'DONE'), ('R2', 'DAILY', 'DONE'), ('R2', 'DAILY', 'DONE'), ('R3', 'STAGE', 'DONE')])
        print(f"[F-04-6] L: R0→R1(실패 뒤 다시)→R2→매일(F15 3석, F2 2석 동결)→90일 지움→매일(앞 판에서 3월 날 잇기)→R3 정산서 0원 차이, "
              f"판매 좌석 3·판매 금액 400,000; M: R3 정산서 1원 차이 → quality_failed sales_amount")


if __name__ == '__main__':
    unittest.main()
