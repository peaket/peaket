"""공연 리포트·파트너 판매 요약 데이터 시험(F-04-7 빠른 길, docs/features/analytics.md §8).
실제 ClickHouse 컨테이너에 합성 브론즈를 넣고 dbt로 R3 현재 판을 만든 뒤 `mtr_event_report`와
`partner_sales_gold`의 숫자·모양을 본다. 자기가 띄운 컨테이너 ID만 지운다.

돌리기(data 폴더에서, Docker 잠금을 잡은 뒤): PYTHONUTF8=1 .venv/Scripts/python -m unittest tests_int.test_report_views -v
"""
import json
import os
import subprocess
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import clickhouse_connect

from tests_int.test_dbt_models import DATA, DBT, IMAGE, PASSWORD, USER, free_port, statements

E = str(uuid.uuid4())
RUN = str(uuid.uuid4())
OPEN = datetime(2026, 7, 1, 11, 0, tzinfo=timezone.utc)
STARTS = OPEN + timedelta(days=120)


class ReportViews(unittest.TestCase):
    container: str
    ch = None
    offset = 0

    @classmethod
    def setUpClass(cls):
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
        cls.seed()
        cls.dbt('seed')
        cls.dbt('build')
        cls.dbt('run-operation', 'swap_current_run', '--args', json.dumps({'event_id': E, 'run_id': RUN}))

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker', 'rm', '-f', '-v', cls.container], capture_output=True)

    @classmethod
    def row(cls, table: str, record: str, at: datetime, payload: dict):
        cls.offset += 1
        p = {'eventId': E, **payload}
        cls.ch.insert(f'bronze.{table}', [[E, str(uuid.uuid4()), record, at, 'local-v1', 1, json.dumps(p), 't', 0, cls.offset, at]],
                      column_names=['event_id', 'event_key', 'record', 'occurred_at', 'key_version', 'schema_id', 'payload', 'kafka_topic', 'kafka_partition', 'kafka_offset', 'kafka_ts'])

    @classmethod
    def seed(cls):
        cls.ch.insert('bronze.brz_ref_event', [[E, 'prod-1', '리포트 공연', 'CONCERT', 'v-1', '피켓 아레나', STARTS, OPEN, None, 22, '{}', '피켓 기획', 'MEDIUM']],
                      column_names=['event_id', 'production_id', 'production_name', 'genre', 'venue_id', 'venue_name', 'starts_at', 'open_at', 'sale_end_at', 'seat_count', 'sale_policy', 'promoter_name', 'size_grade'])
        cls.ch.insert('bronze.brz_ref_seat_map', [[E, 1, 'A', 'A구역', 'R', 150_000, 2, 1, 2], [E, 1, 'B', 'B구역', 'S', 100_000, 20, 1, 20]],
                      column_names=['event_id', 'layout_version', 'section_id', 'section_name', 'tier_id', 'price', 'seat_count', 'seat_index_from', 'seat_index_to'])
        R = lambda s: {'seatId': s, 'tierId': 'R', 'sectionId': 'A', 'price': 150_000}
        S = lambda s: {'seatId': s, 'tierId': 'S', 'sectionId': 'B', 'price': 100_000}
        # 오픈 5분: R 두 장(토스), 6분: S 한 장(포트원). R 등급은 2석이라 5분에 매진이다.
        cls.row('brz_order_event', 'OrderEvent', OPEN + timedelta(minutes=5), {'orderId': 'o1', 'type': 'CONFIRMED', 'amount': 300_000, 'items': [R('A-1'), R('A-2')], 'firstInStage': True})
        cls.row('brz_payment_event', 'PaymentEvent', OPEN + timedelta(minutes=5), {'orderId': 'o1', 'pg': 'TOSS', 'type': 'APPROVED', 'amount': 300_000, 'payMethodCategory': 'CARD', 'latencyMs': 300})
        cls.row('brz_order_event', 'OrderEvent', OPEN + timedelta(minutes=6), {'orderId': 'o2', 'type': 'CONFIRMED', 'amount': 100_000, 'items': [S('B-1')], 'firstInStage': True})
        cls.row('brz_payment_event', 'PaymentEvent', OPEN + timedelta(minutes=6), {'orderId': 'o2', 'pg': 'PORTONE', 'type': 'APPROVED', 'amount': 100_000, 'payMethodCategory': 'TRANSFER', 'latencyMs': 900})
        for s, t, sec in [('A-1', 'R', 'A'), ('A-2', 'R', 'A'), ('B-1', 'S', 'B')]:
            cls.row('brz_seat_event', 'SeatEvent', OPEN + timedelta(minutes=6), {'seatId': s, 'tierId': t, 'sectionId': sec, 'type': 'SOLD'})
        cls.row('brz_event_sale', 'EventSaleChanged', OPEN + timedelta(minutes=30), {'status': 'SOLD_OUT', 'previousStatus': 'ON_SALE'})
        # R2 뒤(8일째) S 한 장(토스) — F15에만 들어가고 F2(온세일)에는 없다.
        cls.row('brz_order_event', 'OrderEvent', OPEN + timedelta(days=8), {'orderId': 'o3', 'type': 'CONFIRMED', 'amount': 100_000, 'items': [S('B-2')], 'firstInStage': True})
        cls.row('brz_payment_event', 'PaymentEvent', OPEN + timedelta(days=8), {'orderId': 'o3', 'pg': 'TOSS', 'type': 'APPROVED', 'amount': 100_000, 'payMethodCategory': 'EASY_PAY', 'latencyMs': 300})
        cls.row('brz_seat_event', 'SeatEvent', OPEN + timedelta(days=8), {'seatId': 'B-2', 'tierId': 'S', 'sectionId': 'B', 'type': 'SOLD'})
        # 30일째 o2 고객 취소 환불 100,000·좌석 반환
        cls.row('brz_order_event', 'OrderEvent', OPEN + timedelta(days=30), {'orderId': 'o2', 'type': 'REFUNDED', 'amount': 100_000, 'refundAmount': 100_000, 'items': [S('B-1')], 'firstInStage': False})
        cls.row('brz_seat_event', 'SeatEvent', OPEN + timedelta(days=30), {'seatId': 'B-1', 'tierId': 'S', 'sectionId': 'B', 'type': 'RETURNED'})

    @classmethod
    def dbt(cls, *args: str):
        env = {**os.environ, 'PYTHONUTF8': '1', 'PEAKET_ANALYTICS_CLICKHOUSE_HOST': '127.0.0.1', 'PEAKET_ANALYTICS_CLICKHOUSE_PORT': str(cls.port),
               'PEAKET_ANALYTICS_CLICKHOUSE_USER': USER, 'PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD': PASSWORD}
        v = json.dumps({'event_id': E, 'run_id': RUN, 'stage': 'R3'})
        r = subprocess.run([DBT, *args, '--profiles-dir', '.', '--vars', v], cwd=DATA, env=env, capture_output=True, text=True, encoding='utf-8')
        if r.returncode != 0:
            raise AssertionError(f'dbt {" ".join(args)} 실패\n{r.stdout[-4000:]}\n{r.stderr[-2000:]}')

    def q(self, sql: str):
        return self.ch.query(sql).result_rows

    def test_partner_sales_and_event_report(self):
        partner = self.q(f"SELECT sold_seats, sold_out_at, by_tier, sales_curve, refunds, recommendations FROM gold.partner_sales_gold WHERE event_id = '{E}'")
        self.assertEqual(len(partner), 1)
        sold_seats, sold_out_at, by_tier, sales_curve, refunds, recommendations = partner[0]
        self.assertEqual(sold_seats, 3)  # 4 판매 − 0 되돌림 − 1 반환 = F11 R3
        self.assertEqual(sold_out_at.strftime('%Y-%m-%d %H:%M'), (OPEN + timedelta(minutes=30)).strftime('%Y-%m-%d %H:%M'))
        tiers = {t[0]: t[1:] for t in by_tier}
        self.assertEqual(tiers['R'][0:2], (2, 0))
        self.assertEqual(tiers['R'][2], 300_000)
        self.assertEqual(tiers['R'][3].strftime('%Y-%m-%d %H:%M'), (OPEN + timedelta(minutes=5)).strftime('%Y-%m-%d %H:%M'))
        self.assertEqual(tiers['S'][0:2], (2, 1))
        self.assertEqual(tiers['S'][2], 200_000)
        self.assertIsNone(tiers['S'][3])
        self.assertEqual(refunds, (1, 100_000))
        self.assertEqual(recommendations, [])
        curve = {(r[0], r[1], r[2], r[4]): r[3] for r in sales_curve}
        self.assertEqual(curve, {('A', 0, 9, 1): 2, ('B', 0, 11529, 1): 2})  # 5건 미만 칸은 구역 안에서 합친다(merged=1)
        cols = [r[0] for r in self.q("SELECT name FROM system.columns WHERE database = 'gold' AND table = 'partner_sales_gold'")]
        self.assertEqual([c for c in cols if 'bot' in c or 'pseudonym' in c or 'promoter' in c], [])  # 봇 범주·가명·다른 테넌트 비교 칸이 없다

        report = self.q(f"SELECT stage, metrics, rule_checks, quality_coverage_ok, quality_failed_metrics, quality_checks FROM gold.mtr_event_report WHERE event_id = '{E}'")
        self.assertEqual(len(report), 1)
        stage, metrics, rule_checks, coverage_ok, failed_metrics, checks = report[0]
        self.assertEqual(stage, 'R3')
        m = {row[0]: row[2] for row in metrics if row[1] == ''}
        self.assertEqual(m['sales_amount'], 500_000)  # F15 판매 500,000 − 되돌림 0
        self.assertEqual(m['sold_seats'], 3)
        # 지표 카드의 마지막 칸(확정 여부)은 R3라 참이다
        self.assertTrue(all(row[9] == 1 for row in metrics))
        rules = {row[0]: row for row in rule_checks}
        self.assertEqual(len(rules), 18)
        self.assertEqual(rules['sold_out_minutes'][1], 'TRIGGERED')  # 30분 > 22분
        self.assertEqual(rules['admission_to_purchase_rate'][1], 'DEFERRED')  # 입장 표본 부족
        self.assertEqual((coverage_ok, failed_metrics, checks), (1, [], 2))  # time_order·sold_le_target·tier_reference 중 행 수
        print(f'[F-04-7] 파트너 판매: 판매 좌석 {sold_seats}, R 2석/300,000·5분 매진, S 2석/200,000(환불 1석), 환불 1건 100,000, 곡선 {len(sales_curve)}칸; '
              f'공연 리포트: R3 지표 {len(metrics)}개(판매 금액 {m["sales_amount"]:,}), 규칙 {len(rules)}개(매진 30분 TRIGGERED, 전환율 DEFERRED), 품질 통과')


if __name__ == '__main__':
    unittest.main()
