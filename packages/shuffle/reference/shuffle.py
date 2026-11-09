# 셔플 재현 규격의 독립 참조 구현(파이썬, 표준 라이브러리만). 시험 기준값 test/vectors.json을 만들고, 누구나 결과 파일을 다시 계산할 때 쓴다(ADR-0050 결정 7, queue-admission §3 '묶음의 첫 구현')
import hashlib
import json
import struct


def sha(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def commitment(event_id, seed):
    return sha(b'PEAKET-shuffle-v1', event_id.encode('utf-8'), seed)


def mth(leaves):
    # RFC 6962: 잎 0x00, 노드 0x01, k = n보다 작은 가장 큰 2의 거듭제곱
    n = len(leaves)
    if n == 0:
        return sha(b'')
    if n == 1:
        return sha(b'\x00', leaves[0])
    k = 1
    while k * 2 < n:
        k *= 2
    return sha(b'\x01', mth(leaves[:k]), mth(leaves[k:]))


# 시드만 쓰는 비상 셔플(RB-35)의 비콘 자리 고정값(재현 규격의 값을 적어 둔 것, ADR-0239). 이 파일은 기준값을 만드는 참조 구현이라 응답을 입력받지 않는다
EMERGENCY_BEACON = sha(b'PEAKET-shuffle-v1-no-beacon')


def combined_key(seed, beacon, root, event_id):
    return sha(seed, beacon, root, event_id.encode('utf-8'))


def words(key):
    i = 0
    while True:
        block = sha(key, struct.pack('>Q', i))
        for w in struct.unpack('>8I', block):
            yield w
        i += 1


def shuffle(items, key):
    return shuffle_with(items, words(key))


def shuffle_with(items, g):
    a = list(items)
    for i in range(len(a) - 1, 0, -1):
        bound = i + 1
        limit = (2 ** 32 // bound) * bound
        while True:
            r = next(g)
            if r < limit:
                break
        j = r % bound
        a[i], a[j] = a[j], a[i]
    return a


# drand quicknet 라운드 규칙(ADR-0231 결정 7): 정수 계산만 쓴다
DRAND_GENESIS_MS = 1692803367000
DRAND_PERIOD_MS = 3000
BEACON_MIN_DELAY_MS = 3000


def drand_round_time_ms(round_no):
    return DRAND_GENESIS_MS + (round_no - 1) * DRAND_PERIOD_MS


def drand_round_after(at_ms, min_delay_ms=BEACON_MIN_DELAY_MS):
    # at_ms + min_delay_ms 이후(같아도 된다)의 첫 라운드. 올림 나눗셈은 음수 몫의 내림으로 쓴다
    return -((-(at_ms + min_delay_ms - DRAND_GENESIS_MS)) // DRAND_PERIOD_MS) + 1


def h(s):
    return hashlib.sha256(s.encode()).digest()


event = 'evt-ref-1'
seed = h('seed')
beacon = h('beacon')
tokens = sorted([h(f'token-{i}') for i in range(10)])
root = mth(tokens)
key = combined_key(seed, beacon, root, event)
out = shuffle(tokens, key)
# 비상 셔플(RB-35, ADR-0239 결정 11): 비콘 자리에 고정값을 넣고 나머지는 같은 규격이다. 검증 화면(SCR-019)의 다시 계산과 대조한다
emergency_key = combined_key(seed, EMERGENCY_BEACON, root, event)
print(json.dumps({
    'event': event,
    'seed': seed.hex(),
    'beacon': beacon.hex(),
    'tokens': [t.hex() for t in tokens],
    'commitment': commitment(event, seed).hex(),
    'merkleRoot': root.hex(),
    'roots': {str(n): mth(tokens[:n]).hex() for n in [0, 1, 2, 3, 5, 7, 8]},
    'key': key.hex(),
    'shuffled': [t.hex() for t in out],
    'small': shuffle(list(range(5)), key),
    'emergency': {'beacon': EMERGENCY_BEACON.hex(), 'key': emergency_key.hex(), 'shuffled': [t.hex() for t in shuffle(tokens, emergency_key)]},
    # 블록 번호는 0부터: 처음 열 단어(두 블록에 걸친다)
    'firstWords': [w for w, _ in zip(words(key), range(10))],
    # 거부 표본추출: 셋을 섞을 때 첫 단어 0xFFFFFFFF는 한도 floor(2^32/3)*3 이상이라 버린다
    'drand': {
        'genesisMs': DRAND_GENESIS_MS,
        'periodMs': DRAND_PERIOD_MS,
        'minDelayMs': BEACON_MIN_DELAY_MS,
        'cases': [{'atMs': at, 'round': drand_round_after(at), 'timeMs': drand_round_time_ms(drand_round_after(at))}
                  for at in [DRAND_GENESIS_MS, DRAND_GENESIS_MS + 1, DRAND_GENESIS_MS + 2999, DRAND_GENESIS_MS + 3000,
                             1794000000000, 1794000000001, 1794000002999, 1794000003000]],
    },
    'rejection': {'items': [0, 1, 2], 'words': [0xFFFFFFFF, 1, 0], 'out': shuffle_with([0, 1, 2], iter([0xFFFFFFFF, 1, 0]))},
}, indent=1))
