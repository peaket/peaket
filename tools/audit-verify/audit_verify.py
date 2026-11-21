#!/usr/bin/env python3
"""PEAKET 감사 체크포인트 공개 검증 도구(ADR-0348 결정 7, ADR-0075 결정 7).

피켓을 믿지 않고 내려받은 공개 파일(transparency/v1/)과 검증 묶음만으로 확인한다.
파이썬 3.11 이상 표준 라이브러리와 시스템 openssl(서명 확인)만 쓴다. 곡선 계산을 손으로 만들지 않는다.

    python audit_verify.py <폴더> [<폴더> ...] [--bundle <묶음.json>] [--json] [--skip-bitcoin] [--openssl <경로>]

끝 코드: 0 통과, 1 어긋남(하나라도), 2 입력 오류, 3 일부 확인 못 함(어긋남은 없음).
바이트 꼴의 원천은 services/ops-svc/src/modules/audit/의 merkle.ts·checkpoint-json.ts·ots.ts·publisher.ts·bundle.ts다.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

if sys.version_info < (3, 11):  # pragma: no cover - 판 확인
    print("audit-verify: 파이썬 3.11 이상이 필요하다", file=sys.stderr)
    sys.exit(2)

CHECKPOINT_VERSION = "PEAKET-checkpoint-v1"
SIGNATURE_ALG = "ECDSA_P256_SHA256"
LEAF_DOMAIN = b"PEAKET-audit-leaf-v1"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ISO_MS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
CHECKPOINT_FILE = re.compile(r"^(\d{10})\.json$")
CHECKPOINT_KEYS = {"v", "no", "firstSeq", "lastSeq", "leafCount", "merkleRoot", "prevCheckpointHash", "accessLogDayAnchor", "closedEvents", "createdAt"}
SAFE_INT = 2**53 - 1

# OpenTimestamps 파일 꼴(ots.ts 머리 주석)
OTS_MAGIC = bytes.fromhex("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294")
OTS_PENDING_TAG = bytes.fromhex("83dfe30d2ef90c8e")
OTS_BITCOIN_TAG = bytes.fromhex("0588960d73d71901")
OTS_MAX_MSG = 4096
OTS_MAX_PAYLOAD = 8192
OTS_RECURSION = 256

OK, MISMATCH, UNVERIFIED, ABSENT, SKIPPED = "ok", "mismatch", "unverified", "absent", "skipped"
STATUS_KO = {OK: "통과", MISMATCH: "어긋남", UNVERIFIED: "확인 못 함", ABSENT: "없음", SKIPPED: "건너뜀"}


class InputError(Exception):
    """입력 전체를 읽지 못함(끝 코드 2)"""


@dataclass
class Report:
    steps: list[dict[str, Any]] = field(default_factory=list)
    input_errors: list[str] = field(default_factory=list)

    def add(self, step: str, target: str, status: str, detail: str = "") -> None:
        self.steps.append({"step": step, "target": target, "status": status, "detail": detail})

    def exit_code(self) -> int:
        statuses = {s["status"] for s in self.steps}
        if MISMATCH in statuses:
            return 1
        if self.input_errors:
            return 2
        if UNVERIFIED in statuses:
            return 3
        return 0


# ---- RFC 8785(JSON 정규화) ----

def _es_number(x: float) -> str:
    """ECMAScript Number → 글(RFC 8785 §3.2.2.3). 정수 칸만 쓰지만 소수가 오면 정규형과 견주려고 만든다"""
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("NaN·무한은 JSON 값이 아니다")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    # repr는 되돌려 읽히는 가장 짧은 자릿수다(ECMAScript와 같은 자릿수). 값 = 0.digits × 10^n 꼴로 바꾼다
    t = Decimal(repr(abs(x))).as_tuple()
    digits = "".join(map(str, t.digits)).lstrip("0")
    exp = int(t.exponent)
    while digits.endswith("0"):
        digits = digits[:-1]
        exp += 1
    k = len(digits)
    n = k + exp
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        out = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + es
    return sign + out


def _es_string(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\r":
            out.append("\\r")
        elif c < 0x20:
            out.append("\\u%04x" % c)
        elif 0xD800 <= c <= 0xDFFF:
            raise ValueError("짝 없는 대리 코드는 정규형으로 쓸 수 없다")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical_json(v: Any) -> str:
    """RFC 8785 정규형 글. 키는 UTF-16 코드 단위 차례다"""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        if abs(v) > SAFE_INT:
            raise ValueError("안전한 정수 밖의 수는 정규형이 원래 값을 지키지 못한다")
        return str(v)
    if isinstance(v, float):
        return _es_number(v)
    if isinstance(v, str):
        return _es_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(_es_string(k) + ":" + canonical_json(v[k]) for k in keys) + "}"
    raise ValueError(f"JSON 값이 아니다: {type(v).__name__}")


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, val in pairs:
        if k in out:
            raise ValueError(f"같은 키가 두 번 있다: {k}")
        out[k] = val
    return out


def strict_json(text: str) -> Any:
    return json.loads(text, object_pairs_hook=_no_duplicate_keys)


# ---- 체크포인트 JSON ----

@dataclass
class Checkpoint:
    no: int
    raw: bytes
    body: dict[str, Any]
    hash: str
    source: str


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def parse_checkpoint(raw: bytes, source: str) -> tuple[Checkpoint | None, str]:
    """체크포인트 JSON을 읽고 꼴·정규형을 본다. 틀리면 (None, 까닭)"""
    try:
        text = raw.decode("utf-8", errors="strict")
        body = strict_json(text)
    except (UnicodeDecodeError, ValueError) as e:
        return None, f"JSON을 읽지 못함: {e}"
    if not isinstance(body, dict):
        return None, "객체가 아니다"
    extra = set(body) - CHECKPOINT_KEYS
    if extra:
        return None, f"모르는 칸: {', '.join(sorted(extra))}"
    if body.get("v") != CHECKPOINT_VERSION:
        return None, f"판(v)이 {CHECKPOINT_VERSION}이 아니다"
    for k in ("no", "firstSeq", "lastSeq", "leafCount"):
        val = body.get(k)
        if not isinstance(val, int) or isinstance(val, bool) or val < 1 or val > SAFE_INT:
            return None, f"{k}가 1 이상의 안전한 정수가 아니다"
    if body["lastSeq"] < body["firstSeq"] or body["lastSeq"] - body["firstSeq"] + 1 != body["leafCount"]:
        return None, "leafCount가 lastSeq − firstSeq + 1이 아니다"
    if not isinstance(body.get("merkleRoot"), str) or not HEX64.match(body["merkleRoot"]):
        return None, "merkleRoot가 16진 소문자 64자가 아니다"
    prev = body.get("prevCheckpointHash")
    if not isinstance(prev, str) or (prev != "" and not HEX64.match(prev)):
        return None, "prevCheckpointHash가 빈 글이거나 16진 소문자 64자가 아니다"
    if "accessLogDayAnchor" in body and (not isinstance(body["accessLogDayAnchor"], str) or not HEX64.match(body["accessLogDayAnchor"])):
        return None, "accessLogDayAnchor가 16진 소문자 64자가 아니다"
    if "closedEvents" in body:
        ce = body["closedEvents"]
        if not isinstance(ce, list) or not ce or not all(isinstance(x, str) and UUID.match(x) for x in ce):
            return None, "closedEvents가 소문자 UUID 목록이 아니다"
        if ce != sorted(set(ce)):
            return None, "closedEvents가 정렬·중복 없음 꼴이 아니다"
    if not isinstance(body.get("createdAt"), str) or not ISO_MS.match(body["createdAt"]):
        return None, "createdAt이 UTC 밀리초 ISO 8601이 아니다"
    try:
        canon = canonical_json(body)
    except ValueError as e:
        return None, f"정규형으로 쓸 수 없다: {e}"
    if canon.encode("utf-8") != raw:
        return None, "RFC 8785 정규형 바이트가 아니다(공백·키 차례·숫자 꼴·이스케이프가 다름)"
    return Checkpoint(no=body["no"], raw=raw, body=body, hash=sha256_hex(raw), source=source), ""


# ---- 머클 트리(RFC 9162) ----

def leaf_input(seq: int, record_sha256: bytes, leaf_salt: bytes) -> bytes:
    return LEAF_DOMAIN + seq.to_bytes(8, "big") + record_sha256 + leaf_salt


def leaf_hash(inp: bytes) -> bytes:
    return hashlib.sha256(b"\x00" + inp).digest()


def node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()


def verify_inclusion(leaf_index: int, tree_size: int, leaf: bytes, path: list[bytes], root: bytes) -> bool:
    """RFC 9162 §2.1.3.2"""
    if leaf_index < 0 or leaf_index >= tree_size:
        return False
    fn, sn, r = leaf_index, tree_size - 1, leaf
    for p in path:
        if sn == 0:
            return False
        if fn % 2 == 1 or fn == sn:
            r = node_hash(p, r)
            if fn % 2 == 0:
                while fn % 2 == 0 and fn != 0:
                    fn >>= 1
                    sn >>= 1
        else:
            r = node_hash(r, p)
        fn >>= 1
        sn >>= 1
    return sn == 0 and r == root


# ---- OpenTimestamps 파일 ----

class OtsError(Exception):
    pass


class _Reader:
    def __init__(self, buf: bytes) -> None:
        self.buf, self.at = buf, 0

    def byte(self) -> int:
        if self.at >= len(self.buf):
            raise OtsError("잘림")
        b = self.buf[self.at]
        self.at += 1
        return b

    def bytes(self, n: int) -> bytes:
        if self.at + n > len(self.buf):
            raise OtsError("잘림")
        out = self.buf[self.at:self.at + n]
        self.at += n
        return out

    def varuint(self) -> int:
        value, shift = 0, 0
        while True:
            b = self.byte()
            value |= (b & 0x7F) << shift
            if not b & 0x80:
                return value
            shift += 7
            if shift > 63:
                raise OtsError("varuint가 너무 길다")

    def varbytes(self, limit: int) -> bytes:
        n = self.varuint()
        if n > limit:
            raise OtsError("varbytes가 상한을 넘는다")
        return self.bytes(n)


@dataclass
class OtsSummary:
    version: int
    hash_op: int
    digest: bytes
    pending: list[str] = field(default_factory=list)
    bitcoin: list[int] = field(default_factory=list)
    unknown_attestations: int = 0
    unsupported_ops: list[str] = field(default_factory=list)


def _apply_op(tag: int, arg: bytes | None, msg: bytes) -> bytes | None:
    """연산 결과. 표준 라이브러리로 못 하는 연산은 None(그 갈래는 확인 못 함)"""
    if tag == 0x08:
        out = hashlib.sha256(msg).digest()
    elif tag == 0x02:
        out = hashlib.sha1(msg).digest()
    elif tag == 0x03:
        try:
            out = hashlib.new("ripemd160", msg).digest()
        except ValueError:
            return None
    elif tag == 0x67:
        return None  # keccak256: hashlib의 sha3_256과 다른 꼴이다
    elif tag == 0xF0:
        out = msg + (arg or b"")
    elif tag == 0xF1:
        out = (arg or b"") + msg
    elif tag == 0xF2:
        out = msg[::-1]
    elif tag == 0xF3:
        out = msg.hex().encode("ascii")
    else:
        raise OtsError(f"모르는 연산 0x{tag:02x}")
    if len(out) > OTS_MAX_MSG:
        raise OtsError("연산 결과가 너무 길다")
    return out


def _read_timestamp(r: _Reader, msg: bytes | None, s: OtsSummary, depth: int) -> None:
    if depth > OTS_RECURSION:
        raise OtsError("갈래가 너무 깊다")

    def one(tag: int) -> None:
        if tag == 0x00:
            att_tag = r.bytes(8)
            payload = r.varbytes(OTS_MAX_PAYLOAD)
            pr = _Reader(payload)
            if att_tag == OTS_PENDING_TAG:
                uri = pr.varbytes(1000)
                if pr.at != len(payload):
                    raise OtsError("대기 증명 내용 뒤에 바이트가 남았다")
                s.pending.append(uri.decode("utf-8", errors="replace"))
            elif att_tag == OTS_BITCOIN_TAG:
                s.bitcoin.append(pr.varuint())
            else:
                s.unknown_attestations += 1
            return
        arg = r.varbytes(OTS_MAX_MSG) if tag in (0xF0, 0xF1) else None
        if tag not in (0x08, 0x02, 0x03, 0x67, 0xF0, 0xF1, 0xF2, 0xF3):
            raise OtsError(f"모르는 연산 0x{tag:02x}")
        nxt = _apply_op(tag, arg, msg) if msg is not None else None
        if nxt is None:
            s.unsupported_ops.append(f"0x{tag:02x}")
        _read_timestamp(r, nxt, s, depth + 1)

    tag = r.byte()
    while tag == 0xFF:
        one(r.byte())
        tag = r.byte()
    one(tag)


def parse_ots(data: bytes) -> OtsSummary:
    r = _Reader(data)
    if r.bytes(len(OTS_MAGIC)) != OTS_MAGIC:
        raise OtsError("머리 바이트가 OpenTimestamps 증명 파일이 아니다")
    version = r.varuint()
    if version != 1:
        raise OtsError(f"판 {version}은 모른다(1만 읽는다)")
    hash_op = r.byte()
    if hash_op != 0x08:
        raise OtsError(f"대상 해시 연산 0x{hash_op:02x}는 SHA-256(0x08)이 아니다")
    digest = r.bytes(32)
    s = OtsSummary(version=version, hash_op=hash_op, digest=digest)
    _read_timestamp(r, digest, s, 0)
    if r.at != len(data):
        raise OtsError("증명 파일 끝 뒤에 바이트가 남았다")
    return s


# ---- 서명(openssl) ----

class OpenSsl:
    def __init__(self, path: str | None) -> None:
        self.path = path
        self._curve_cache: dict[str, bool] = {}

    @property
    def available(self) -> bool:
        return self.path is not None

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        assert self.path is not None
        return subprocess.run([self.path, *args], capture_output=True, text=True, timeout=30)

    def is_p256(self, pem: str, tmp: Path) -> bool:
        if pem in self._curve_cache:
            return self._curve_cache[pem]
        f = tmp / f"key-{len(self._curve_cache)}.pem"
        f.write_text(pem, encoding="ascii")
        p = self._run(["pkey", "-pubin", "-in", str(f), "-noout", "-text"])
        ok = p.returncode == 0 and ("prime256v1" in p.stdout or "P-256" in p.stdout)
        self._curve_cache[pem] = ok
        return ok

    def verify(self, pem: str, signature_der: bytes, message: bytes, tmp: Path) -> tuple[bool, str]:
        pub, sig, msg = tmp / "pub.pem", tmp / "sig.der", tmp / "msg.bin"
        pub.write_text(pem, encoding="ascii")
        sig.write_bytes(signature_der)
        msg.write_bytes(message)
        p = self._run(["dgst", "-sha256", "-verify", str(pub), "-signature", str(sig), str(msg)])
        out = (p.stdout + p.stderr).strip()
        if p.returncode == 0 and "Verified OK" in out:
            return True, ""
        return False, "Verification failure" if "Verification failure" in out else (out.splitlines()[0] if out else f"openssl 끝 코드 {p.returncode}")


def decode_signature(text: bytes) -> bytes | None:
    """.sig 글(DER의 base64, 줄바꿈 없음). 끝 줄바꿈만 봐준다"""
    try:
        s = text.decode("ascii", errors="strict").strip()
        der = base64.b64decode(s, validate=True)
    except (UnicodeDecodeError, binascii.Error, ValueError):
        return None
    if not der or base64.b64encode(der).decode("ascii") != s:
        return None
    return der


# ---- 폴더 읽기 ----

@dataclass
class Folder:
    root: Path
    v1: Path
    index: dict[str, Any] | None
    keys: list[dict[str, Any]]
    files: dict[int, Path]


def find_v1(p: Path) -> Path:
    for cand in (p / "transparency" / "v1", p / "v1", p):
        if (cand / "checkpoints").is_dir() or (cand / "index.json").is_file() or (cand / "public-keys.json").is_file():
            return cand
    raise InputError(f"{p}: transparency/v1 꼴 폴더(checkpoints/·index.json·public-keys.json)를 찾지 못했다")


def read_json_file(path: Path, what: str) -> Any:
    try:
        return strict_json(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise InputError(f"{what}({path})를 읽지 못했다: {e}") from e


def load_folder(p: Path, rep: Report) -> Folder | None:
    if not p.is_dir():
        rep.input_errors.append(f"폴더가 없다: {p}")
        return None
    try:
        v1 = find_v1(p)
        index = None
        if (v1 / "index.json").is_file():
            index = read_json_file(v1 / "index.json", "index.json")
            if not isinstance(index, dict) or index.get("version") != 1 or not isinstance(index.get("checkpoints"), list):
                raise InputError(f"{v1 / 'index.json'}: 꼴이 틀렸다(version 1, checkpoints 목록)")
        keys: list[dict[str, Any]] = []
        if (v1 / "public-keys.json").is_file():
            kj = read_json_file(v1 / "public-keys.json", "public-keys.json")
            if not isinstance(kj, dict) or kj.get("version") != 1 or not isinstance(kj.get("keys"), list):
                raise InputError(f"{v1 / 'public-keys.json'}: 꼴이 틀렸다(version 1, keys 목록)")
            for k in kj["keys"]:
                if not isinstance(k, dict) or not isinstance(k.get("keyId"), str) or not isinstance(k.get("publicKeyPem"), str) or not isinstance(k.get("alg"), str):
                    raise InputError(f"{v1 / 'public-keys.json'}: 키 항목 꼴이 틀렸다(keyId·alg·publicKeyPem)")
                keys.append(k)
    except InputError as e:
        rep.input_errors.append(str(e))
        return None
    files: dict[int, Path] = {}
    cdir = v1 / "checkpoints"
    if cdir.is_dir():
        for f in sorted(cdir.iterdir()):
            m = CHECKPOINT_FILE.match(f.name)
            if m:
                files[int(m.group(1))] = f
    return Folder(root=p, v1=v1, index=index, keys=keys, files=files)


def index_path(folder: Folder, rel: Any) -> Path | None:
    if not isinstance(rel, str) or not rel or ".." in rel.split("/") or rel.startswith("/"):
        return None
    rel = rel[len("transparency/v1/"):] if rel.startswith("transparency/v1/") else rel
    return folder.v1.joinpath(*rel.split("/"))


# ---- 확인 ----

def check_ots_file(path: Path, expect_hash: str, label: str, complete: bool, rep: Report, skip_bitcoin: bool) -> None:
    try:
        s = parse_ots(path.read_bytes())
    except (OSError, OtsError) as e:
        rep.add("ots", label, MISMATCH, f"증명 파일을 읽지 못함: {e}")
        return
    if s.digest.hex() != expect_hash:
        rep.add("ots", label, MISMATCH, f"대상 해시 {s.digest.hex()} ≠ 체크포인트 해시 {expect_hash}")
        return
    if s.unsupported_ops:
        rep.add("ots", label, UNVERIFIED, f"표준 라이브러리로 계산 못 하는 연산이 있다({', '.join(sorted(set(s.unsupported_ops)))}). 공식 클라이언트로 확인한다")
    else:
        rep.add("ots", label, OK, f"머리·판 1·SHA-256·대상 해시가 맞다(대기 증명 {len(s.pending)}개, 비트코인 증명 {len(s.bitcoin)}개)")
    if complete and not s.bitcoin:
        rep.add("ots-complete", label, MISMATCH, "완료 증명 파일인데 비트코인 증명이 없다")
        return
    if skip_bitcoin:
        rep.add("bitcoin", label, SKIPPED, "비트코인 단계는 공식 클라이언트(ots verify)로 따로 본다(--skip-bitcoin)")
    elif s.bitcoin:
        rep.add("bitcoin", label, UNVERIFIED, f"비트코인 블록 {', '.join(map(str, sorted(set(s.bitcoin))))}의 헤더 대조는 이 도구가 하지 않는다. 공식 클라이언트로 `ots verify {path.name}`을 돌린다")
    else:
        rep.add("bitcoin", label, UNVERIFIED, "아직 대기 증명뿐이다(비트코인 증명이 붙기 전). 완료 증명(.complete.ots)이 나오면 공식 클라이언트로 확인한다")


def verify_signature(cp: Checkpoint, sig_text: bytes, keys: list[dict[str, Any]], ossl: OpenSsl, tmp: Path, label: str, rep: Report, trusted: bool = True) -> None:
    der = decode_signature(sig_text)
    if der is None:
        rep.add("signature", label, MISMATCH, "서명이 DER의 base64 글이 아니다")
        return
    if not ossl.available:
        rep.add("signature", label, UNVERIFIED, "openssl을 찾지 못했다(--openssl로 경로를 준다)")
        return
    usable = [k for k in keys if k.get("alg") == SIGNATURE_ALG]
    if not usable:
        rep.add("signature", label, UNVERIFIED if not keys else MISMATCH, "확인할 공개키가 없다" if not keys else f"{SIGNATURE_ALG} 공개키가 없다")
        return
    last_err = ""
    for k in usable:
        pem = k["publicKeyPem"]
        if not ossl.is_p256(pem, tmp):
            last_err = f"{k['keyId']}: P-256 공개키가 아니다"
            continue
        ok, err = ossl.verify(pem, der, cp.raw, tmp)
        if ok:
            if trusted:
                rep.add("signature", label, OK, f"키 {k['keyId']}({SIGNATURE_ALG})로 확인")
            else:
                rep.add("signature", label, UNVERIFIED, f"묶음에 실린 키 {k['keyId']}로는 맞지만, 그 키가 공개 키 목록(public-keys.json)에 있는지 보지 못했다(폴더를 함께 준다)")
            return
        last_err = f"{k['keyId']}: {err}"
    rep.add("signature", label, MISMATCH, f"어느 공개키로도 맞지 않는다({last_err})")


def check_folders(folders: list[Folder], ossl: OpenSsl, tmp: Path, rep: Report, skip_bitcoin: bool) -> dict[int, Checkpoint]:
    """폴더들의 체크포인트를 모아 번호·사슬·서명·증명을 본다. 번호 → 기준 체크포인트(같은 번호가 엇갈리면 첫 것)"""
    by_no: dict[int, list[Checkpoint]] = {}
    keys: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()
    for f in folders:
        for k in f.keys:
            t = (k["keyId"], k["publicKeyPem"])
            if t not in seen_keys:
                seen_keys.add(t)
                keys.append(k)
    key_by_id: dict[str, set[str]] = {}
    for k in keys:
        key_by_id.setdefault(k["keyId"], set()).add(k["publicKeyPem"])
    for kid, pems in key_by_id.items():
        if len(pems) > 1:
            rep.add("public-keys", kid, MISMATCH, "같은 키 ID에 다른 공개키가 있다")
    if not keys:
        rep.add("public-keys", "public-keys.json", UNVERIFIED, "공개 키 목록이 없다")

    for f in folders:
        # index.json 항목
        indexed: dict[int, list[dict[str, Any]]] = {}
        if f.index is None:
            rep.add("index", str(f.v1), UNVERIFIED, "index.json이 없어 목록 대조를 못 했다")
        else:
            for e in f.index["checkpoints"]:
                if not isinstance(e, dict) or not isinstance(e.get("no"), int) or isinstance(e.get("no"), bool) or e["no"] < 1 or not isinstance(e.get("checkpointHash"), str):
                    rep.input_errors.append(f"{f.v1 / 'index.json'}: 항목 꼴이 틀렸다(no·checkpointHash)")
                    continue
                indexed.setdefault(e["no"], []).append(e)
            for no, entries in sorted(indexed.items()):
                hashes = sorted({e["checkpointHash"] for e in entries})
                if len(entries) > 1:
                    rep.add("same-number", f"index.json no {no}", MISMATCH, f"목록에 같은 번호가 {len(entries)}번 있다: {', '.join(hashes)}")
                if no not in f.files:
                    p = index_path(f, entries[0].get("json"))
                    if p is None or not p.is_file():
                        rep.add("file", f"no {no}", UNVERIFIED, "목록에 있는 체크포인트 파일을 받지 못했다")
                        continue
                    f.files[no] = p
        # 파일 읽기
        for no, path in sorted(f.files.items()):
            label = f"no {no}"
            raw = path.read_bytes()
            cp, why = parse_checkpoint(raw, str(path))
            if cp is None:
                rep.add("checkpoint-json", label, MISMATCH, f"{path.name}: {why}")
                continue
            if cp.no != no:
                rep.add("checkpoint-json", label, MISMATCH, f"{path.name}: 파일 이름 번호 {no}와 JSON의 no {cp.no}가 다르다")
                continue
            rep.add("checkpoint-json", label, OK, f"정규형·칸 꼴이 맞다(해시 {cp.hash})")
            by_no.setdefault(no, []).append(cp)
            for e in indexed.get(no, []):
                if e["checkpointHash"] != cp.hash:
                    rep.add("same-number", label, MISMATCH, f"목록의 해시 {e['checkpointHash']}와 파일 {path.name}의 해시 {cp.hash}가 다르다")
            if "accessLogDayAnchor" not in cp.body:
                rep.add("access-log-day-anchor", label, ABSENT, "일 앵커 칸이 없다(접속기록 저장소 전이거나 일 체크포인트가 아님, 실패로 세지 않는다)")
            # 서명
            sig_path = path.with_suffix(".sig")
            if not sig_path.is_file():
                rep.add("signature", label, UNVERIFIED, f"{sig_path.name}을 받지 못했다")
            else:
                verify_signature(cp, sig_path.read_bytes(), keys, ossl, tmp, label, rep)
            # 증명 파일
            ots = path.with_suffix(".ots")
            complete = path.with_name(f"{path.stem}.complete.ots")
            index_complete = any(isinstance(e.get("completeOts"), str) for e in indexed.get(no, []))
            if complete.is_file():
                check_ots_file(complete, cp.hash, f"{label} 완료", True, rep, skip_bitcoin)
            elif index_complete:
                rep.add("ots-complete", label, UNVERIFIED, "목록에 있는 완료 증명 파일을 받지 못했다")
            if ots.is_file():
                if complete.is_file():
                    try:
                        s = parse_ots(ots.read_bytes())
                        rep.add("ots", f"{label} 대기", OK if s.digest.hex() == cp.hash else MISMATCH,
                                "대상 해시가 맞다" if s.digest.hex() == cp.hash else f"대상 해시 {s.digest.hex()} ≠ {cp.hash}")
                    except (OSError, OtsError) as e:
                        rep.add("ots", f"{label} 대기", MISMATCH, f"증명 파일을 읽지 못함: {e}")
                else:
                    check_ots_file(ots, cp.hash, label, False, rep, skip_bitcoin)
            elif not complete.is_file():
                rep.add("ots", label, UNVERIFIED, f"{ots.name}을 받지 못했다")

    # 같은 번호의 다른 체크포인트(폴더 사이)
    chosen: dict[int, Checkpoint] = {}
    for no, cps in sorted(by_no.items()):
        distinct: dict[str, Checkpoint] = {}
        for c in cps:
            distinct.setdefault(c.hash, c)
        if len(distinct) > 1:
            rep.add("same-number", f"no {no}", MISMATCH, "같은 번호의 다른 체크포인트: " + "; ".join(f"{c.source} 해시 {h}" for h, c in distinct.items()))
        chosen[no] = cps[0]

    # 번호 빈틈과 사슬
    if not chosen:
        rep.add("numbers", "checkpoints", UNVERIFIED, "읽은 체크포인트가 없다")
        return chosen
    top = max(chosen)
    listed = set(chosen)
    for f in folders:
        if f.index is not None:
            listed |= {e["no"] for e in f.index["checkpoints"] if isinstance(e, dict) and isinstance(e.get("no"), int)}
    top = max(top, max(listed))
    missing = [n for n in range(1, top + 1) if n not in listed]
    if missing:
        rep.add("numbers", "checkpoints", MISMATCH, f"번호 빈틈: {', '.join(map(str, missing))}(1부터 {top}까지 이어져야 한다)")
    else:
        rep.add("numbers", "checkpoints", OK, f"1부터 {top}까지 빈틈 없음")
    for no in range(1, top + 1):
        cp = chosen.get(no)
        if cp is None:
            continue
        label = f"no {no}"
        if no == 1:
            ok_prev = cp.body["prevCheckpointHash"] == ""
            ok_seq = cp.body["firstSeq"] == 1
            rep.add("chain", label, OK if ok_prev and ok_seq else MISMATCH,
                    "첫 체크포인트(직전 해시 빈 글, seq 1부터)" if ok_prev and ok_seq else
                    ("첫 체크포인트의 prevCheckpointHash가 빈 글이 아니다" if not ok_prev else f"공개 사슬이 seq 1부터가 아니다(firstSeq {cp.body['firstSeq']})"))
            continue
        prev = chosen.get(no - 1)
        if prev is None:
            rep.add("chain", label, UNVERIFIED, f"직전 체크포인트 {no - 1}을 읽지 못해 사슬을 보지 못했다")
            continue
        problems = []
        if cp.body["prevCheckpointHash"] != prev.hash:
            problems.append(f"prevCheckpointHash {cp.body['prevCheckpointHash'] or '(빈 글)'} ≠ 직전 체크포인트 해시 {prev.hash}")
        if cp.body["firstSeq"] != prev.body["lastSeq"] + 1:
            problems.append(f"firstSeq {cp.body['firstSeq']}가 직전 lastSeq {prev.body['lastSeq']} + 1이 아니다")
        rep.add("chain", label, MISMATCH if problems else OK, "; ".join(problems) if problems else "직전 해시와 seq 구간이 이어진다")
    return chosen


def check_bundle(path: Path, folders_given: bool, chosen: dict[int, Checkpoint], folder_keys: list[dict[str, Any]], ossl: OpenSsl, tmp: Path, rep: Report, skip_bitcoin: bool) -> None:
    try:
        b = strict_json(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        rep.input_errors.append(f"검증 묶음({path})을 읽지 못했다: {e}")
        return
    try:
        if not isinstance(b, dict) or b.get("version") != 1:
            raise InputError("판(version)이 1이 아니다")
        c, r, ip = b.get("checkpoint"), b.get("record"), b.get("inclusionProof")
        if not isinstance(c, dict) or not isinstance(r, dict) or not isinstance(ip, dict):
            raise InputError("checkpoint·record·inclusionProof가 객체가 아니다")
        for k in ("json", "checkpointHash", "signature", "keyId", "publicKeyPem"):
            if not isinstance(c.get(k), str):
                raise InputError(f"checkpoint.{k}가 글이 아니다")
        for k in ("recordJson", "prevHash", "recordSha256", "leafSalt"):
            if not isinstance(r.get(k), str):
                raise InputError(f"record.{k}가 글이 아니다")
        seq = r.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            raise InputError("record.seq가 1 이상의 정수가 아니다")
        li, ts, pth = ip.get("leafIndex"), ip.get("treeSize"), ip.get("path")
        if not isinstance(li, int) or not isinstance(ts, int) or not isinstance(pth, list) or not all(isinstance(x, str) for x in pth):
            raise InputError("inclusionProof 꼴이 틀렸다(leafIndex·treeSize 정수, path 16진 목록)")
    except InputError as e:
        rep.input_errors.append(f"검증 묶음({path}): {e}")
        return

    label = f"묶음 seq {seq}"
    cp, why = parse_checkpoint(c["json"].encode("utf-8"), f"{path} checkpoint.json")
    if cp is None:
        rep.add("bundle-checkpoint", label, MISMATCH, f"묶음의 체크포인트 JSON: {why}")
        return
    if c.get("no") is not None and c.get("no") != cp.no:
        rep.add("bundle-checkpoint", label, MISMATCH, f"checkpoint.no {c.get('no')}와 JSON의 no {cp.no}가 다르다")
    if c["checkpointHash"] != cp.hash:
        rep.add("bundle-checkpoint", label, MISMATCH, f"checkpointHash {c['checkpointHash']} ≠ SHA-256(json) {cp.hash}")
    else:
        rep.add("bundle-checkpoint", label, OK, f"체크포인트 no {cp.no} 정규형·해시가 맞다")

    # 폴더의 같은 번호와 같은 바이트인가
    if folders_given:
        same = chosen.get(cp.no)
        if same is None:
            rep.add("bundle-folder", label, UNVERIFIED, f"폴더에 체크포인트 no {cp.no}가 없다")
        elif same.raw != cp.raw:
            rep.add("same-number", f"no {cp.no}", MISMATCH, f"같은 번호의 다른 체크포인트: 묶음 해시 {cp.hash}; {same.source} 해시 {same.hash}")
        else:
            rep.add("bundle-folder", label, OK, f"폴더의 no {cp.no}와 같은 바이트")

    # 기록 → 기록 해시 → 잎 → 포함 증명 → 루트
    prev_hash, rec_json, rec_sha, salt = r["prevHash"], r["recordJson"], r["recordSha256"], r["leafSalt"]
    try:
        rec = strict_json(rec_json)
    except ValueError:
        rep.add("record", label, MISMATCH, "recordJson이 JSON이 아니다")
        return
    kind = rec.get("recordType") if isinstance(rec, dict) else None
    if prev_hash != "" and not HEX64.match(prev_hash):
        rep.add("record", label, MISMATCH, "prevHash가 빈 글이거나 16진 소문자 64자가 아니다")
        return
    computed = hashlib.sha256(prev_hash.encode("utf-8") + rec_json.encode("utf-8")).hexdigest()
    if computed != rec_sha:
        rep.add("record", label, MISMATCH, f"SHA-256(prevHash ‖ recordJson) {computed} ≠ recordSha256 {rec_sha}")
        return
    rep.add("record", label, OK, f"기록 해시가 맞다(종류 {kind or '?'})")
    if not HEX64.match(salt):
        rep.add("leaf", label, MISMATCH, "leafSalt가 16진 소문자 64자가 아니다")
        return
    first, last, count = cp.body["firstSeq"], cp.body["lastSeq"], cp.body["leafCount"]
    if not first <= seq <= last:
        rep.add("leaf", label, MISMATCH, f"seq {seq}가 체크포인트 구간 {first}~{last} 밖이다")
        return
    if li != seq - first or ts != count:
        rep.add("leaf", label, MISMATCH, f"leafIndex {li}·treeSize {ts}가 seq − firstSeq {seq - first}·leafCount {count}와 다르다")
        return
    if not all(HEX64.match(x) for x in pth):
        rep.add("inclusion", label, MISMATCH, "path 항목이 16진 소문자 64자가 아니다")
        return
    leaf = leaf_hash(leaf_input(seq, bytes.fromhex(rec_sha), bytes.fromhex(salt)))
    ok = verify_inclusion(li, ts, leaf, [bytes.fromhex(x) for x in pth], bytes.fromhex(cp.body["merkleRoot"]))
    rep.add("inclusion", label, OK if ok else MISMATCH, "잎 → 포함 증명 → merkleRoot가 맞다" if ok else "잎과 포함 증명으로 다시 모은 루트가 merkleRoot와 다르다")

    # 서명: 폴더의 공개 키 목록이 믿는 기준이다. 묶음에 실린 키만으로는 남이 만든 키일 수 있다
    bundle_key = {"keyId": c["keyId"], "alg": c.get("signatureAlg", SIGNATURE_ALG), "publicKeyPem": c["publicKeyPem"]}
    if folders_given and folder_keys:
        listed = [k for k in folder_keys if k["keyId"] == c["keyId"] and k["publicKeyPem"].strip() == c["publicKeyPem"].strip()]
        if not listed:
            rep.add("signature", label, MISMATCH, f"묶음의 키 {c['keyId']}가 공개 키 목록(public-keys.json)에 없다")
        verify_signature(cp, c["signature"].encode("ascii", errors="replace"), folder_keys, ossl, tmp, label, rep)
    else:
        verify_signature(cp, c["signature"].encode("ascii", errors="replace"), [bundle_key], ossl, tmp, label, rep, trusted=False)

    otsb = c.get("otsProof")
    if otsb is None:
        rep.add("ots", label, UNVERIFIED, "묶음에 증명 파일이 없다")
    elif isinstance(otsb, str):
        try:
            data = base64.b64decode(otsb, validate=True)
        except (binascii.Error, ValueError):
            rep.add("ots", label, MISMATCH, "otsProof가 base64가 아니다")
            return
        f = tmp / "bundle.ots"
        f.write_bytes(data)
        check_ots_file(f, cp.hash, label, False, rep, skip_bitcoin)
    else:
        rep.input_errors.append(f"검증 묶음({path}): checkpoint.otsProof가 글이 아니다")


def find_openssl(explicit: str | None) -> str | None:
    if explicit is not None:
        return explicit if Path(explicit).is_file() or shutil.which(explicit) else None
    return shutil.which("openssl")


def main(argv: list[str] | None = None) -> int:
    # 출력은 늘 UTF-8이다(Windows 콘솔·파이프의 지역 인코딩에 흔들리지 않게)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog="audit_verify.py", description="PEAKET 감사 체크포인트 공개 검증(ADR-0348 결정 7). 끝 코드 0 통과·1 어긋남·2 입력 오류·3 일부 확인 못 함")
    ap.add_argument("folders", nargs="*", help="내려받은 공개 폴더(transparency/v1 또는 그 위). 둘 이상이면 같은 번호끼리도 견준다")
    ap.add_argument("--bundle", action="append", default=[], help="검증 묶음 JSON 파일(여러 번 줄 수 있다)")
    ap.add_argument("--json", action="store_true", help="단계마다 결과를 JSON 한 덩이로 낸다")
    ap.add_argument("--skip-bitcoin", action="store_true", help="비트코인 단계를 공식 클라이언트로 따로 본다(확인 못 함으로 세지 않는다)")
    ap.add_argument("--openssl", default=None, help="openssl 실행 파일 경로(기본: PATH에서 찾는다)")
    try:
        args = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code not in (0, None) else 0
    rep = Report()
    if not args.folders and not args.bundle:
        rep.input_errors.append("폴더나 --bundle 가운데 하나는 줘야 한다")
    ossl = OpenSsl(find_openssl(args.openssl))
    with tempfile.TemporaryDirectory(prefix="audit-verify-") as td:
        tmp = Path(td)
        folders = [f for f in (load_folder(Path(p), rep) for p in args.folders) if f is not None]
        chosen: dict[int, Checkpoint] = {}
        keys: list[dict[str, Any]] = []
        if folders:
            chosen = check_folders(folders, ossl, tmp, rep, args.skip_bitcoin)
            for f in folders:
                keys.extend(f.keys)
        for b in args.bundle:
            check_bundle(Path(b), bool(folders), chosen, keys, ossl, tmp, rep, args.skip_bitcoin)
    code = rep.exit_code()
    if args.json:
        print(json.dumps({"exitCode": code, "inputErrors": rep.input_errors, "steps": rep.steps, "openssl": ossl.path}, ensure_ascii=False, indent=2))
    else:
        for s in rep.steps:
            print(f"[{STATUS_KO[s['status']]}] {s['step']} {s['target']}: {s['detail']}")
        for e in rep.input_errors:
            print(f"[입력 오류] {e}")
        counts = {k: sum(1 for s in rep.steps if s["status"] == k) for k in STATUS_KO}
        print(f"결과: 끝 코드 {code} — 통과 {counts[OK]}, 어긋남 {counts[MISMATCH]}, 확인 못 함 {counts[UNVERIFIED]}, 없음 {counts[ABSENT]}, 건너뜀 {counts[SKIPPED]}, 입력 오류 {len(rep.input_errors)}")
        if any(s["step"] == "bitcoin" and s["status"] == UNVERIFIED for s in rep.steps):
            print("안내: 비트코인 단계는 공식 OpenTimestamps 클라이언트로 확인한다(예: ots verify <번호>.complete.ots). 따로 봤다면 --skip-bitcoin을 준다")
    return code


if __name__ == "__main__":
    sys.exit(main())
