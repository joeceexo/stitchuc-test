import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callFigures, cleanReport, qualityScore, score, type ScoreContext } from './score.js';
import type { CallSample, RawReport } from './types.js';

const ctx: ScoreContext = {
  code: 'NT-TST-001', at: new Date('2026-11-18T19:14:00Z'), company: null, office: null, sent: false,
  provider: 'Example Cable', device: 'Chrome on Windows, network cable', callConfigured: true,
  mediaHosts: ['lk.example.net'], appHosts: ['login.example.com'], mediaUdp: null, maxMbps: 200, natChecked: false,
};
const seconds = (n: number, f: (t: number) => Partial<CallSample>): CallSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i + 1, rtt: 38, jitterUp: 6, jitterDown: 5, sentUp: 50, lostUp: 0, recvDown: 50, lostDown: 0, ...f(i + 1) }));
const good: RawReport = {
  regions: [{ id: 'us-east', ms: 38 }, { id: 'sa-east', ms: 142 }, { id: 'apac', ms: 231 }],
  call: { region: 'us-east', connected: true, samples: seconds(20, () => ({})), path: { type: 'srflx', protocol: 'udp' } },
  speed: { downMbps: 250, upMbps: 22, capped: true, idleMs: 20, loadedMs: 29, spikes: 0 },
  reach: [{ url: 'https://login.example.com', ms: 80 }], nat: 'unknown', connection: 'ethernet',
};

test('a clean line is ready for Stitch', () => {
  const r = score(good, ctx);
  assert.equal(r.verdict, 'good');
  assert.equal(r.headline, 'Ready for Stitch');
  assert.equal(r.calls, 154);            // 22 Mbps up x 70% / 100 kbps
  assert.equal(r.video, 7);
  assert.equal(r.score, 4.4);
  assert.equal(r.fixes.length, 0);
  assert.deepEqual(r.nearest, { id: 'us-east', ms: 38 });
  assert.equal(r.groups.find((g) => g.id === 'speed')!.rows[0]!.value, 'at least 200 Mbps');
  assert.equal(r.groups.find((g) => g.id === 'firewall')!.rows.length, 2); // no router row without STUN
});

test('a busy, lossy Wi-Fi line behind a UDP block is flagged, worst first', () => {
  const raw: RawReport = {
    ...good,
    call: { region: 'us-east', connected: true, path: { type: 'relay', protocol: 'udp', relayProtocol: 'tls' },
      samples: seconds(20, (t) => ({ rtt: 61, jitterUp: 34, lostUp: t > 2 && t % 5 === 0 ? 10 : 1 })) },
    speed: { downMbps: 48, upMbps: 1.4, capped: false, idleMs: 30, loadedMs: 270, spikes: 0 },
    connection: 'wifi',
  };
  const r = score(raw, ctx);
  assert.equal(r.verdict, 'poor');
  assert.equal(r.calls, 9);
  assert.equal(r.video, 0);
  assert.deepEqual(r.fixes.map((f) => f.grade), [...r.fixes.map((f) => f.grade)].sort((a, b) => (a === b ? 0 : a === 'poor' ? -1 : 1)));
  const ids = r.fixes.map((f) => f.id);
  assert.ok(ids.includes('busy') && ids.includes('loss') && ids.includes('udp') && ids.includes('room'));
  assert.equal(r.fixes.find((f) => f.id === 'loss')!.title, 'Your Wi-Fi is losing sound');
  assert.equal(r.it.find((l) => l.text.startsWith('UDP'))!.state, 'blocked');
  assert.match(r.sub, /fixing/);
});

test('no path for the test call is a firewall problem', () => {
  const r = score({ ...good, call: { region: 'us-east', connected: false, samples: [], path: null, error: 'timed out connecting' } }, ctx);
  assert.equal(r.verdict, 'poor');
  assert.equal(r.fixes[0]!.id, 'blocked');
  assert.equal(r.score, null);
});

test('without LiveKit settings the call is skipped, not failed', () => {
  const r = score({ ...good, call: null }, { ...ctx, callConfigured: false });
  assert.equal(r.verdict, 'fair');
  assert.equal(r.headline, "We couldn't finish the test");
  assert.equal(r.groups.find((g) => g.id === 'call')!.grade, null);
});

test('figures skip the first two seconds and never go negative', () => {
  const f = callFigures(seconds(10, (t) => ({ lostUp: t <= 2 ? 40 : 0 })));
  assert.equal(f.lossUp, 0);
  assert.equal(f.seconds, 8);
  assert.equal(qualityScore(38, 6, 0), 4.4);
  assert.ok(qualityScore(400, 80, 10) < 2.5);
});

test('what a browser sends is clamped', () => {
  const c = cleanReport({ regions: [{ id: 'x'.repeat(100), ms: -5 }], speed: { downMbps: 1e12, upMbps: 'NaN' }, nat: 'weird', connection: 'satellite', call: { connected: 'yes', samples: [{ t: 1, rtt: 'x', sentUp: -3 }] } });
  assert.equal(c.regions[0]!.id.length, 40);
  assert.equal(c.regions[0]!.ms, 0);
  assert.equal(c.speed, null);
  assert.equal(c.nat, 'unknown');
  assert.equal(c.connection, null);
  assert.equal(c.call!.connected, false);
  assert.equal(c.call!.samples[0]!.sentUp, 0);
});
