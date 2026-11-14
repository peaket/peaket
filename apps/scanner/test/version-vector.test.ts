// Scanner version vector freshness tests (GAT-160).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearVersionVector,
  compareVersionVectors,
  isSnapshotStale,
  loadVersionVector,
  needsResync,
  saveVersionVector,
  VERSION_VECTOR_STORAGE_KEY,
  type ScannerVersionVector,
  type VersionVectorStorage,
} from '../src/storage/version-vector.ts';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const HOUR = 3_600_000;
const vector = (over: Partial<ScannerVersionVector> = {}): ScannerVersionVector => ({
  eventId: 'ev-1',
  seq: 10,
  ticketSeq: 4,
  keySeq: 5,
  policySeq: 1,
  placementSeq: 2,
  flagSeq: 3,
  issuedAt: new Date(NOW).toISOString(),
  maxOfflineMs: 24 * HOUR,
  ...over,
});

function memoryStorage(): VersionVectorStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

test('compares each vector component', () => {
  assert.equal(compareVersionVectors(vector(), vector()), 'same');
  assert.equal(compareVersionVectors(vector({ seq: 11 }), vector()), 'ahead');
  assert.equal(compareVersionVectors(vector(), vector({ keySeq: 6 })), 'behind');
  assert.equal(compareVersionVectors(vector({ ticketSeq: 5 }), vector({ keySeq: 6 })), 'diverged');
});

test('treats exactly maxOfflineMs as fresh and one ms over as stale', () => {
  const v = vector();
  assert.equal(isSnapshotStale(v, NOW, NOW + 24 * HOUR), false);
  assert.equal(isSnapshotStale(v, NOW, NOW + 24 * HOUR + 1), true);
  assert.equal(isSnapshotStale(vector({ issuedAt: new Date(NOW - 25 * HOUR).toISOString() }), NOW, NOW), true);
});

test('requires full resync only when stale, behind, or diverged', () => {
  assert.equal(needsResync(vector(), vector({ seq: 11 }), NOW, NOW), false);
  assert.equal(needsResync(vector({ keySeq: 6 }), vector(), NOW, NOW), true);
  assert.equal(needsResync(vector({ ticketSeq: 5 }), vector({ keySeq: 6 }), NOW, NOW), true);
  assert.equal(needsResync(vector(), vector(), NOW, NOW + 25 * HOUR), true);
  assert.equal(needsResync(vector({ eventId: 'ev-2' }), vector(), NOW, NOW), true);
});

test('stores and loads the vector, ignoring a broken value', () => {
  const storage = memoryStorage();
  saveVersionVector(storage, vector());
  assert.equal(storage.map.has(VERSION_VECTOR_STORAGE_KEY), true);
  assert.deepEqual(loadVersionVector(storage), vector());

  storage.setItem(VERSION_VECTOR_STORAGE_KEY, '{bad');
  assert.equal(loadVersionVector(storage), undefined);
  storage.setItem(VERSION_VECTOR_STORAGE_KEY, JSON.stringify({ eventId: 'ev-1' }));
  assert.equal(loadVersionVector(storage), undefined);
  storage.setItem(VERSION_VECTOR_STORAGE_KEY, JSON.stringify({ eventId: 'ev-1', issuedAt: new Date(NOW).toISOString(), maxOfflineMs: 1000 }));
  assert.equal(loadVersionVector(storage), undefined);
  storage.setItem(VERSION_VECTOR_STORAGE_KEY, JSON.stringify({ ...vector(), issuedAt: 'not-a-date' }));
  assert.equal(loadVersionVector(storage), undefined);
  clearVersionVector(storage);
  assert.equal(loadVersionVector(storage), undefined);
});
