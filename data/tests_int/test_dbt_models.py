"""dbt 모델 통합 시험(F-04-4 빠른 길, docs/features/analytics.md §4·§5·§7, A-T18·A-T21 성격).

실제 ClickHouse 컨테이너(이 PC에 받아 둔 24.12)에 브론즈 표(data/clickhouse/bronze)를 만들고, 합성 브론즈 행을 넣은 뒤
`dbt build`(실버 delete+insert, 골드 run_id 판)를 돌려 사실 표의 숫자가 정답과 같은지 본다. 자기가 띄운 컨테이너 ID만 지운다.

돌리기(data 폴더에서, Docker 잠금을 잡은 뒤):  PYTHONUTF8=1 .venv/Scripts/python -m unittest tests_int.test_dbt_models -v
"""
import json
import os
import re
import socket
import subprocess
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import clickhouse_connect

DATA = Path(__file__).resolve().parents[1]
DBT = str(DATA / ('.venv/Scripts/dbt.exe' if os.name == 'nt' else '.venv/bin/dbt'))
IMAGE = 'clickhouse/clickhouse-server:24.12'
USER, PASSWORD = 'it', 'It-Ch-Pa55word'

E = str(uuid.uuid4())
OPEN = datetime(2026, 7, 1, 11, 0, tzinfo=timezone.utc)
RUN1, RUN2 = str(uuid.uuid4()), str(uuid.uuid4())


def free_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def statements(sql: str) -> list[str]:
    body = '\n'.join(l for l in sql.split('\n') if not l.lstrip().startswith('--'))
    out = []
    for s in re.split(r';\s*(?:\n|$)', body):
        s = s.strip()
        if not s:
            continue
        s = re.sub(r"\s+ON CLUSTER '\{cluster\}'", '', s)
        if 'ENGINE = ReplicatedMergeTree' in s:
            s = s.replace('ENGINE = ReplicatedMergeTree', 'ENGINE = MergeTree', 1) + '\nSETTINGS non_replicated_deduplication_window = 1000'
        out.append(s)
    return out


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


class DbtModels(unittest.TestCase):
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

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker', 'rm', '-f', '-v', cls.container], capture_output=True)

    # ---- 합성 브론즈 ----
    @classmethod
    def row(cls, table: str, record: str, at: datetime, payload: dict, key: str | None = None):
        cls.offset += 1
        p = {'eventId': E, **payload}
        cls.ch.insert(f'bronze.{table}', [[E, key or str(uuid.uuid4()), record, at, 'local-v1', 1, json.dumps(p), 't', 0, cls.offset, at]],
                      column_names=['event_id', 'event_key', 'record', 'occurred_at', 'key_version', 'schema_id', 'payload', 'kafka_topic', 'kafka_partition', 'kafka_offset', 'kafka_ts'])

    @classmethod
    def seed(cls):
        d1, d8, d30 = OPEN + timedelta(minutes=5), OPEN + timedelta(days=7, hours=2), OPEN + timedelta(days=29)
        cls.ch.insert('bronze.brz_ref_event', [[E, 'prod-1', '합성 공연', 'CONCERT', 'v-1', '피켓 아레나', OPEN + timedelta(days=120), OPEN, None, 30, '{}', '피켓 기획', 'MEDIUM']],
                      column_names=['event_id', 'production_id', 'production_name', 'genre', 'venue_id', 'venue_name', 'starts_at', 'open_at', 'sale_end_at', 'seat_count', 'sale_policy', 'promoter_name', 'size_grade'])
        cls.ch.insert('bronze.brz_ref_seat_map', [[E, 1, 'A', 'A구역', 'R', 150_000, 10, 1, 10], [E, 1, 'B', 'B구역', 'S', 100_000, 20, 1, 20]],
                      column_names=['event_id', 'layout_version', 'section_id', 'section_name', 'tier_id', 'price', 'seat_count', 'seat_index_from', 'seat_index_to'])
        R = lambda s: {'seatId': s, 'tierId': 'R', 'sectionId': 'A', 'price': 150_000}
        S = lambda s: {'seatId': s, 'tierId': 'S', 'sectionId': 'B', 'price': 100_000}
        # 1일째: o1(R 두 장, 토스), o2(S 한 장, 포트원)
        cls.row('brz_order_event', 'OrderEvent', d1, {'orderId': 'o1', 'type': 'CONFIRMED', 'amount': 300_000, 'items': [R('A-1'), R('A-2')], 'firstInStage': True})
        cls.row('brz_payment_event', 'PaymentEvent', d1, {'orderId': 'o1', 'pg': 'TOSS', 'type': 'APPROVED', 'amount': 300_000, 'payMethodCategory': 'CARD', 'latencyMs': 420})
        cls.row('brz_order_event', 'OrderEvent', d1, {'orderId': 'o2', 'type': 'CONFIRMED', 'amount': 100_000, 'items': [S('B-1')], 'firstInStage': True})
        cls.row('brz_payment_event', 'PaymentEvent', d1, {'orderId': 'o2', 'pg': 'PORTONE', 'type': 'APPROVED', 'amount': 100_000, 'payMethodCategory': 'TRANSFER', 'latencyMs': 900})
        for s, t, sec in [('A-1', 'R', 'A'), ('A-2', 'R', 'A'), ('B-1', 'S', 'B')]:
            cls.row('brz_seat_event', 'SeatEvent', d1, {'seatId': s, 'tierId': t, 'sectionId': sec, 'type': 'SOLD'})
        cls.row('brz_event_sale', 'EventSaleChanged', d1 + timedelta(minutes=1), {'status': 'SOLD_OUT', 'previousStatus': 'ON_SALE'})
        cls.row('brz_event_sale', 'EventSaleChanged', d1 + timedelta(minutes=30), {'status': 'ON_SALE', 'previousStatus': 'SOLD_OUT'})
        # 8일째(R2 뒤): o3(S 한 장, 토스) — 같은 사건을 두 번(eventKey 같음), o2 입금 되돌림
        k3 = str(uuid.uuid4())
        for _ in range(2):
            cls.row('brz_order_event', 'OrderEvent', d8, {'orderId': 'o3', 'type': 'CONFIRMED', 'amount': 100_000, 'items': [S('B-2')], 'firstInStage': True}, key=k3)
        cls.row('brz_payment_event', 'PaymentEvent', d8, {'orderId': 'o3', 'pg': 'TOSS', 'type': 'APPROVED', 'amount': 100_000, 'payMethodCategory': 'EASY_PAY', 'latencyMs': 300})
        cls.row('brz_seat_event', 'SeatEvent', d8, {'seatId': 'B-2', 'tierId': 'S', 'sectionId': 'B', 'type': 'SOLD'})
        cls.row('brz_order_event', 'OrderEvent', d8, {'orderId': 'o2', 'type': 'DEPOSIT_REVERSED', 'amount': 100_000, 'items': [S('B-1')], 'firstInStage': False})
        cls.row('brz_payment_event', 'PaymentEvent', d8, {'orderId': 'o2', 'pg': 'PORTONE', 'type': 'DEPOSIT_REVERSED', 'amount': 100_000})
        cls.row('brz_seat_event', 'SeatEvent', d8, {'seatId': 'B-1', 'tierId': 'S', 'sectionId': 'B', 'type': 'PENDING'})
        # 30일째: o1 고객 취소 환불, 좌석 둘 반환
        cls.row('brz_order_event', 'OrderEvent', d30, {'orderId': 'o1', 'type': 'REFUNDED', 'amount': 300_000, 'refundAmount': 300_000, 'items': [R('A-1'), R('A-2')], 'firstInStage': False})
        for s in ['A-1', 'A-2']:
            cls.row('brz_seat_event', 'SeatEvent', d30, {'seatId': s, 'tierId': 'R', 'sectionId': 'A', 'type': 'RETURNED'})
        # 홀드 시도 셋, 판정 둘(그림자 하나는 빠진다)
        for res, retry in [('HELD', 0), ('CONFLICT', 0), ('HELD', 1)]:
            cls.row('brz_hold_attempt', 'HoldAttempt', d1, {'purchaseSessionId': 'ps-1', 'mode': 'PICK', 'tierId': 'R', 'sectionId': 'A', 'seatIds': ['A-1'], 'result': res, 'heldAt': ms(d1), 'firstHeldInSession': retry == 0 and res == 'HELD', 'retryNo': retry, 'latencyMs': 120})
        cls.row('brz_trust_verdict', 'TrustVerdict', d1, {'queueEntryId': 'qe-1', 'category': 'PASS', 'source': 'REALTIME', 'shadow': False})
        cls.row('brz_trust_verdict', 'TrustVerdict', d1, {'queueEntryId': 'qe-2', 'category': 'BLOCKED', 'source': 'REALTIME', 'shadow': True})

    def dbt(self, *args: str, run_id: str = RUN1) -> subprocess.CompletedProcess:
        env = {**os.environ, 'PYTHONUTF8': '1', 'PEAKET_ANALYTICS_CLICKHOUSE_HOST': '127.0.0.1', 'PEAKET_ANALYTICS_CLICKHOUSE_PORT': str(self.port),
               'PEAKET_ANALYTICS_CLICKHOUSE_USER': USER, 'PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD': PASSWORD}
        v = json.dumps({'event_id': E, 'run_id': run_id, 'stage': 'R3'})
        r = subprocess.run([DBT, *args, '--profiles-dir', '.', '--vars', v], cwd=DATA, env=env, capture_output=True, text=True, encoding='utf-8')
        if r.returncode != 0:
            raise AssertionError(f'dbt {" ".join(args)} 실패\n{r.stdout[-4000:]}\n{r.stderr[-2000:]}')
        return r

    def q(self, sql: str):
        return self.ch.query(sql).result_rows

    def test_1_build_and_numbers(self):
        self.dbt('seed')
        self.dbt('build')
        # 실버: 같은 사건을 두 번 보낸 o3 CONFIRMED는 한 줄, 그림자 판정은 빠짐
        self.assertEqual(self.q(f"SELECT count() FROM silver.slv_order WHERE event_id = '{E}' AND type = 'CONFIRMED'")[0][0], 3)
        self.assertEqual(self.q(f"SELECT count() FROM silver.slv_trust_label WHERE event_id = '{E}'")[0][0], 1)
        # F15 날짜별 판매(A-T18 성격): 1일째 R 2석 토스 300,000 · S 1석 포트원 100,000 / 8일째 S 1석 토스 100,000 · 되돌림 S 1석 100,000 / 30일째 반환 R 2석
        f15 = {(str(d), t, p): (s, a, rs, ra, ret) for d, t, p, s, a, rs, ra, ret in self.q(
            f"SELECT day, tier_id, pg, sold_seats, sales_amount, reversed_seats, reversed_amount, returned_seats FROM gold.fct_sales_daily WHERE event_id = '{E}' AND run_id = '{RUN1}'")}
        self.assertEqual(f15[('2026-07-01', 'R', 'TOSS')][:2], (2, 300_000))
        self.assertEqual(f15[('2026-07-01', 'S', 'PORTONE')][:2], (1, 100_000))
        self.assertEqual(f15[('2026-07-08', 'S', 'TOSS')][:2], (1, 100_000))
        self.assertEqual(f15[('2026-07-08', 'S', 'PORTONE')][2:4], (1, 100_000))
        self.assertEqual(f15[('2026-07-30', 'R', '')][4], 2)
        sales, reversed_ = self.q(f"SELECT sum(sales_amount), sum(reversed_amount) FROM gold.fct_sales_daily WHERE event_id = '{E}' AND run_id = '{RUN1}'")[0]
        # R3 판매 대금 = 판매 금액 합 − 되돌림 금액 합 = 결제 승인 − 입금 되돌림(F11, 지표 26)
        f11 = self.q(f"SELECT sold_seats, sales_amount, sold_out_at IS NOT NULL, sold_out_releases, close_stage FROM gold.fct_event_summary WHERE event_id = '{E}' AND run_id = '{RUN1}'")[0]
        self.assertEqual(sales - reversed_, 400_000)
        self.assertEqual(f11[1], 400_000)
        # 판매 좌석(좌석마다 마지막 판매 상태 SOLD): A-1·A-2 반환, B-1 되돌림, B-2만 SOLD
        self.assertEqual(f11[0], 1)
        self.assertEqual(f11[2:], (True, 1, 'R3'))
        # 공연 전날 판매율 분자(지표 7) = 판매 − 되돌림 − 반환 좌석
        sold, rev, ret = self.q(f"SELECT sum(sold_seats), sum(reversed_seats), sum(returned_seats) FROM gold.fct_sales_daily WHERE event_id = '{E}' AND run_id = '{RUN1}'")[0]
        self.assertEqual(sold - rev - ret, 1)
        # F8 환불: 셀프 300,000
        self.assertEqual(self.q(f"SELECT route, refunds, refund_amount FROM gold.fct_refund_daily WHERE event_id = '{E}' AND run_id = '{RUN1}'"), [('SELF', 1, 300_000)])
        # F2 오픈 기준 분: 1일째 5분째 칸에 R 2석·S 1석
        self.assertEqual(self.q(f"SELECT sum(sold_seats) FROM gold.fct_sales_minute WHERE event_id = '{E}' AND run_id = '{RUN1}' AND open_minute = 5")[0][0], 3)
        # F4 홀드: 시도 3, 첫 시도 2
        self.assertEqual(self.q(f"SELECT sum(attempts), sum(first_attempts) FROM gold.fct_hold_attempt WHERE event_id = '{E}' AND run_id = '{RUN1}'")[0], (3, 2))
        # 차원: 구역 둘·등급 둘(R이 1순위)
        self.assertEqual(self.q(f"SELECT tier_id, tier_rank FROM gold.dim_tier WHERE event_id = '{E}' ORDER BY tier_rank"), [('R', 1), ('S', 2)])
        print(f'[F-04-4] F15 판매 {sales:,} − 되돌림 {reversed_:,} = {sales - reversed_:,} = F11 판매 금액 {f11[1]:,}, 판매 좌석 {f11[0]}, 공연 전날 판매 좌석 {sold - rev - ret}/30')

    def test_2_rerun_is_idempotent_and_current_run(self):
        # 실버는 회차 단위 delete+insert라 다시 돌려도 같은 수, 골드는 새 판(run_id)으로 더해지고 현재 판 표가 고른다
        self.dbt('build', run_id=RUN2)
        self.assertEqual(self.q(f"SELECT count() FROM silver.slv_order WHERE event_id = '{E}'")[0][0], 5)
        self.assertEqual(self.q(f"SELECT uniqExact(run_id) FROM gold.fct_sales_daily WHERE event_id = '{E}'")[0][0], 2)
        self.dbt('run-operation', 'swap_current_run', '--args', json.dumps({'event_id': E, 'run_id': RUN2}), run_id=RUN2)
        cur = self.q(f"SELECT run_id FROM gold.current_run FINAL WHERE event_id = '{E}'")
        self.assertEqual(cur, [(RUN2,)])
        n = self.q(f"SELECT sum(sold_seats) FROM gold.fct_sales_daily WHERE event_id = '{E}' AND run_id = (SELECT run_id FROM gold.current_run FINAL WHERE event_id = '{E}')")[0][0]
        self.assertEqual(n, 4)
        print(f'[F-04-4] 다시 실행: 실버 주문 5행 그대로, 골드 판 2개, 현재 판 {RUN2[:8]}… 판매 좌석 합 {n}')


if __name__ == '__main__':
    unittest.main()
