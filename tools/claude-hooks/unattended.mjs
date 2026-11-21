#!/usr/bin/env node
// 무인 모드 켜고 끄기(소유자 결정 2026-11-21, ADR-0330 보충).
// 소유자가 자리를 비운 동안(밤 등) 훅의 '묻기'를 묻지 않고 허용으로 바꾼다. 허용한 명령은 .claude/unattended/allowed.jsonl에 남는다.
// '막기'(강제 푸시·reset --hard 등)와 main 푸시는 무인 모드에서도 막는다. 끝 시각이 지나면 저절로 꺼진다.
//   node tools/claude-hooks/unattended.mjs on [시간]   켠다(기본 12시간 뒤 저절로 꺼짐)
//   node tools/claude-hooks/unattended.mjs off         끈다. 켜 둔 동안 허용한 명령 수를 보여 준다
//   node tools/claude-hooks/unattended.mjs status      지금 상태와 최근 허용 기록
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir, unattended } from './lib.mjs';

const DEFAULT_HOURS = 12;
const MAX_HOURS = 24;
const ON = () => path.join(stateDir(), 'on.json');
const LOG = () => path.join(stateDir(), 'allowed.jsonl');
const local = (ms) => new Date(ms).toLocaleString('ko-KR', { hour12: false });

function allowedSince(since) {
  try {
    return fs
      .readFileSync(LOG(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && Date.parse(e.at) >= since);
  } catch {
    return [];
  }
}

export function main(argv, now = Date.now()) {
  const [cmd = 'status', arg] = argv;
  if (cmd === 'on') {
    const hours = arg == null ? DEFAULT_HOURS : Number(arg);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
      return { code: 2, text: `시간은 0보다 크고 ${MAX_HOURS} 이하인 수다(받은 값: ${arg})` };
    }
    fs.mkdirSync(stateDir(), { recursive: true });
    const state = { since: now, until: now + Math.round(hours * 3_600_000) };
    fs.writeFileSync(ON(), `${JSON.stringify(state)}\n`);
    return { code: 0, text: `무인 모드 켬: ${local(state.until)}까지(${hours}시간). 훅의 '묻기'를 허용으로 바꾸고 ${LOG()}에 남긴다. main 푸시와 '막기'는 그대로 막는다` };
  }
  if (cmd === 'off') {
    let since = null;
    try {
      since = JSON.parse(fs.readFileSync(ON(), 'utf8')).since ?? null;
    } catch {
      // 켜져 있지 않았다
    }
    fs.rmSync(ON(), { force: true });
    const n = since == null ? 0 : allowedSince(since).length;
    return { code: 0, text: since == null ? '무인 모드는 이미 꺼져 있다' : `무인 모드 끔. 켜 둔 동안 묻지 않고 허용한 명령 ${n}개(${LOG()})` };
  }
  if (cmd === 'status') {
    const s = unattended(now);
    const recent = allowedSince(0).slice(-10);
    const lines = [s ? `무인 모드 켜짐: ${local(s.until)}까지` : '무인 모드 꺼짐'];
    if (recent.length) {
      lines.push(`최근 허용 기록 ${recent.length}개(${LOG()}):`);
      for (const e of recent) lines.push(`- ${e.at} ${String(e.command).split('\n')[0].slice(0, 160)}`);
    }
    return { code: 0, text: lines.join('\n') };
  }
  return { code: 2, text: '쓰는 법: node tools/claude-hooks/unattended.mjs on [시간] | off | status' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2));
  process.stdout.write(`${r.text}\n`);
  process.exit(r.code);
}
