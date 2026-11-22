// BAT-455 웹 푸시 주소의 이름 해석(기본값). 시험은 같은 모양의 함수를 끼운다.
import { lookup } from 'node:dns/promises';
import type { PushLookup } from '../domain/fan-notify-ports.js';

export const dnsLookup: PushLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });
