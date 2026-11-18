// The test itself. Everything is measured here, in the visitor's browser; the server only
// hands out a pass for the test call, moves bytes for the speed test and works out the verdict.

import type { CallPath, CallSample, RawCall, RawReport, RawSpeed, RegionReading, Result } from '../../server/src/types';
import { api, ApiError, type SiteConfig } from './api';

export interface Progress {
  step: 1 | 2 | 3 | 4;
  pct: number;
  secondsLeft: number;
  network: string | null;       // filled when step 1 is done
  callDone: string | null;
  speedDone: string | null;
  call: { left: number; loss: number | null; jitter: number | null; rtt: number | null; bars: (number | null)[] } | null;
  speed: { phase: 'wait' | 'idle' | 'down' | 'up'; down: number | null; up: number | null; ping: number | null } | null;
}

interface Started {
  id: string; token: string; code: string; provider: string | null;
  call: { region: string; url: string; room: string; send: string; listen: string } | null;
}

const CALL_SECONDS = 20;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((yes, no) => {
  const t = setTimeout(yes, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); no(new DOMException('Stopped', 'AbortError')); }, { once: true });
});
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Times one small request. null means it never got there. */
async function timeFetch(url: string, timeoutMs = 5000): Promise<number | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const start = performance.now();
  try {
    await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Math.random().toString(36).slice(2)}`, { mode: 'no-cors', cache: 'no-store', signal: c.signal });
    return performance.now() - start;
  } catch { return null; } finally { clearTimeout(t); }
}

/** The round trip to a host: the best of a few requests after the connection is warm. */
async function probe(url: string): Promise<number | null> {
  if ((await timeFetch(url, 6000)) == null) return null;
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) { const v = await timeFetch(url, 4000); if (v != null) xs.push(v); }
  return xs.length ? Math.min(...xs) : null;
}

/** Whether the router keeps one public address for every destination, using two STUN servers. */
async function natType(stun: string[]): Promise<'normal' | 'symmetric' | 'unknown'> {
  if (stun.length < 2 || typeof RTCPeerConnection === 'undefined') return 'unknown';
  const pc = new RTCPeerConnection({ iceServers: stun.map((urls) => ({ urls })) });
  const mapped = new Map<string, Set<string>>();
  let failed = false;
  try {
    pc.createDataChannel('nat');
    pc.addEventListener('icecandidateerror', () => { failed = true; });
    pc.addEventListener('icecandidate', (e) => {
      const c = e.candidate?.candidate ?? '';
      const m = /^candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ srflx raddr (\S+) rport (\d+)/i.exec(c);
      if (!m || m[1]!.includes(':')) return;
      const base = `${m[3]}:${m[4]}`;
      if (!mapped.has(base)) mapped.set(base, new Set());
      mapped.get(base)!.add(`${m[1]}:${m[2]}`);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((done) => {
      const t = setTimeout(done, 3500);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); } });
    });
  } catch { return 'unknown'; } finally { pc.close(); }
  if (!mapped.size) return 'unknown';
  for (const set of mapped.values()) if (set.size > 1) return 'symmetric';
  return failed ? 'unknown' : 'normal';
}

function connectionKind(): string | null {
  const t = (navigator as any).connection?.type;
  return t === 'wifi' || t === 'ethernet' || t === 'cellular' ? t : null;
}

// ---- The test call ---------------------------------------------------------

async function testCall(
  pass: NonNullable<Started['call']>, audio: AudioContext | null, signal: AbortSignal,
  tick: (left: number, samples: CallSample[]) => void,
): Promise<RawCall> {
  const out: RawCall = { region: pass.region, connected: false, samples: [], path: null };
  const { Room, RoomEvent, Track } = await import('livekit-client');
  const sender = new Room({ adaptiveStream: false, dynacast: false });
  const listener = new Room({ adaptiveStream: false, dynacast: false });
  const ctx = audio ?? new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  let el: HTMLMediaElement | null = null;
  try {
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    osc.frequency.value = 440; gain.gain.value = 0.08;
    osc.connect(gain).connect(dest); osc.start();

    const within = <T,>(p: Promise<T>, ms: number, what: string) => Promise.race([
      p, new Promise<T>((_, no) => setTimeout(() => no(new Error(what)), ms)),
    ]);
    await within(Promise.all([
      sender.connect(pass.url, pass.send, { autoSubscribe: false }),
      listener.connect(pass.url, pass.listen, { autoSubscribe: true }),
    ]), 15000, 'timed out connecting');
    signal.throwIfAborted();

    let remote: any = null;
    listener.on(RoomEvent.TrackSubscribed, (track) => {
      remote = track;
      try { el = track.attach() as HTMLMediaElement; el.muted = true; el.volume = 0; } catch { /* stats still flow */ }
    });
    const pub = await within(sender.localParticipant.publishTrack(dest.stream.getAudioTracks()[0]!, {
      source: Track.Source.Microphone, name: 'nettest', dtx: false, red: false,
    }), 10000, 'timed out sending sound');
    out.connected = true;

    let pSent = 0, pLostUp = 0, pRecv = 0, pLostDown = 0, first = true;
    for (let t = 1; t <= CALL_SECONDS; t++) {
      await sleep(1000, signal);
      let sent = pSent, lostUp = pLostUp, recv = pRecv, lostDown = pLostDown;
      let rtt: number | null = null, jitterUp: number | null = null, jitterDown: number | null = null;
      try {
        const report = await pub.track?.getRTCStatsReport();
        let pairId: string | null = null;
        const pairs = new Map<string, any>(), locals = new Map<string, any>();
        report?.forEach((s: any) => {
          if (s.type === 'outbound-rtp' && s.kind === 'audio') sent = s.packetsSent ?? sent;
          if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') {
            lostUp = Math.max(0, s.packetsLost ?? lostUp);
            if (typeof s.jitter === 'number') jitterUp = s.jitter * 1000;
            if (typeof s.roundTripTime === 'number') rtt = s.roundTripTime * 1000;
          }
          if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
          if (s.type === 'candidate-pair') pairs.set(s.id, s);
          if (s.type === 'local-candidate') locals.set(s.id, s);
        });
        const pair = (pairId && pairs.get(pairId)) || [...pairs.values()].find((p) => p.nominated && p.state === 'succeeded');
        if (pair) {
          if (typeof pair.currentRoundTripTime === 'number') rtt = pair.currentRoundTripTime * 1000;
          const local = locals.get(pair.localCandidateId);
          if (local) {
            const path: CallPath = { type: String(local.candidateType ?? ''), protocol: String(local.protocol ?? '') };
            if (local.relayProtocol) path.relayProtocol = String(local.relayProtocol);
            out.path = path;
          }
        }
      } catch { /* keep the last figures */ }
      try {
        const report = await remote?.getRTCStatsReport();
        report?.forEach((s: any) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            recv = s.packetsReceived ?? recv;
            lostDown = Math.max(0, s.packetsLost ?? lostDown);
            if (typeof s.jitter === 'number') jitterDown = s.jitter * 1000;
          }
        });
      } catch { /* keep the last figures */ }
      const sample: CallSample = first
        ? { t, rtt, jitterUp, jitterDown, sentUp: 0, lostUp: 0, recvDown: 0, lostDown: 0 }
        : { t, rtt, jitterUp, jitterDown, sentUp: Math.max(0, sent - pSent), lostUp: Math.max(0, lostUp - pLostUp), recvDown: Math.max(0, recv - pRecv), lostDown: Math.max(0, lostDown - pLostDown) };
      first = false;
      pSent = sent; pLostUp = lostUp; pRecv = recv; pLostDown = lostDown;
      out.samples.push(sample);
      tick(CALL_SECONDS - t, out.samples);
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    out.error = String((e as Error).message ?? e).slice(0, 180);
  } finally {
    try { osc.stop(); } catch { /* not started */ }
    try { (el as HTMLMediaElement | null)?.remove(); } catch { /* nothing attached */ }
    void sender.disconnect().catch(() => {});
    void listener.disconnect().catch(() => {});
    if (!audio) void ctx.close().catch(() => {});
  }
  return out;
}

export function callSoFar(samples: CallSample[]) {
  const s = samples.filter((x) => x.t > 2);
  const sent = s.reduce((a, x) => a + x.sentUp, 0), lostUp = s.reduce((a, x) => a + x.lostUp, 0);
  const recv = s.reduce((a, x) => a + x.recvDown, 0), lostDown = s.reduce((a, x) => a + x.lostDown, 0);
  const up = sent > 0 ? (lostUp / sent) * 100 : null;
  const down = recv + lostDown > 0 ? (lostDown / (recv + lostDown)) * 100 : null;
  const last = samples[samples.length - 1];
  const jit = last ? Math.max(last.jitterUp ?? 0, last.jitterDown ?? 0) : null;
  return {
    loss: up == null && down == null ? null : Math.max(up ?? 0, down ?? 0),
    jitter: last && (last.jitterUp != null || last.jitterDown != null) ? jit : null,
    rtt: median(samples.map((x) => x.rtt).filter((v): v is number => v != null)),
  };
}

// ---- The speed test --------------------------------------------------------

class Pinger {
  private ws: WebSocket | null = null;
  private waiting = new Map<string, number>();
  private n = 0;
  readonly got: { at: number; ms: number }[] = [];
  async open(): Promise<boolean> {
    return new Promise((done) => {
      try {
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
        const t = setTimeout(() => done(false), 5000);
        ws.onopen = () => { clearTimeout(t); this.ws = ws; done(true); };
        ws.onerror = () => { clearTimeout(t); done(false); };
        ws.onmessage = (e) => {
          const sent = this.waiting.get(String(e.data));
          if (sent != null) { this.waiting.delete(String(e.data)); this.got.push({ at: performance.now(), ms: performance.now() - sent }); }
        };
      } catch { done(false); }
    });
  }
  ping() { if (this.ws?.readyState === 1) { const k = String(++this.n); this.waiting.set(k, performance.now()); this.ws.send(k); } }
  /** Pings every `every` ms until stopped; returns the round trips seen from `skipMs` on. */
  async run(ms: number, every: number, skipMs: number, signal: AbortSignal): Promise<number[]> {
    const start = performance.now();
    while (performance.now() - start < ms) { this.ping(); await sleep(every, signal); }
    await sleep(300, signal);
    return this.got.filter((g) => g.at >= start + skipMs).map((g) => g.ms);
  }
  last(): number | null { return this.got.length ? this.got[this.got.length - 1]!.ms : null; }
  close() { try { this.ws?.close(); } catch { /* already closed */ } }
}

const WINDOW_MS = 8000, RAMP_MS = 1500;

async function download(q: string, streams: number, signal: AbortSignal, live: (mbps: number) => void): Promise<number> {
  const c = new AbortController();
  signal.addEventListener('abort', () => c.abort(), { once: true });
  const start = performance.now();
  let counted = 0, total = 0;
  const one = async () => {
    while (performance.now() - start < WINDOW_MS) {
      try {
        const res = await fetch(`/api/speed/down?${q}&_=${Math.random().toString(36).slice(2)}`, { cache: 'no-store', signal: c.signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          const now = performance.now() - start;
          if (now >= RAMP_MS && now <= WINDOW_MS) counted += value.byteLength;
          if (now > WINDOW_MS) { void reader.cancel().catch(() => {}); return; }
        }
      } catch { return; }
    }
  };
  const shower = setInterval(() => {
    const now = performance.now() - start;
    live(now > RAMP_MS ? (counted * 8) / 1e6 / ((now - RAMP_MS) / 1000) : (total * 8) / 1e6 / Math.max(0.2, now / 1000));
  }, 250);
  const stop = setTimeout(() => c.abort(), WINDOW_MS + 200);
  await Promise.all(Array.from({ length: streams }, one));
  clearInterval(shower); clearTimeout(stop);
  signal.throwIfAborted();
  return (counted * 8) / 1e6 / ((WINDOW_MS - RAMP_MS) / 1000);
}

async function upload(q: string, streams: number, signal: AbortSignal, live: (mbps: number) => void): Promise<number> {
  const start = performance.now();
  let counted = 0, total = 0;
  const open = new Set<XMLHttpRequest>();
  const junk = new Uint8Array(1 << 20);
  for (let i = 0; i < junk.length; i += 65536) crypto.getRandomValues(junk.subarray(i, i + 65536));
  const one = async () => {
    let size = 256 * 1024;
    while (performance.now() - start < WINDOW_MS && !signal.aborted) {
      const body = new Blob(Array.from({ length: Math.ceil(size / junk.length) }, () => junk)).slice(0, size);
      const began = performance.now();
      const ok = await new Promise<boolean>((done) => {
        const x = new XMLHttpRequest();
        open.add(x);
        let seen = 0;
        x.open('POST', `/api/speed/up?${q}`);
        x.setRequestHeader('Content-Type', 'application/octet-stream');
        x.upload.onprogress = (e) => {
          const d = e.loaded - seen; seen = e.loaded; total += d;
          const now = performance.now() - start;
          if (now >= RAMP_MS && now <= WINDOW_MS) counted += d;
        };
        x.onload = () => { open.delete(x); done(x.status === 200); };
        x.onerror = x.onabort = () => { open.delete(x); done(false); };
        x.send(body);
      });
      if (!ok) return;
      if (performance.now() - began < 1000) size = Math.min(size * 2, 32 * 1024 * 1024);
    }
  };
  const shower = setInterval(() => {
    const now = performance.now() - start;
    live(now > RAMP_MS ? (counted * 8) / 1e6 / ((now - RAMP_MS) / 1000) : (total * 8) / 1e6 / Math.max(0.2, now / 1000));
  }, 250);
  const stop = setTimeout(() => open.forEach((x) => x.abort()), WINDOW_MS);
  const onAbort = () => open.forEach((x) => x.abort());
  signal.addEventListener('abort', onAbort, { once: true });
  await Promise.all(Array.from({ length: streams }, one));
  clearInterval(shower); clearTimeout(stop);
  signal.throwIfAborted();
  return (counted * 8) / 1e6 / ((WINDOW_MS - RAMP_MS) / 1000);
}

async function speedTest(
  started: Started, maxMbps: number, signal: AbortSignal,
  show: (s: NonNullable<Progress['speed']>) => void,
): Promise<RawSpeed | null> {
  let streams = 4;
  let open = false;
  for (let i = 0; i < 12 && !open; i++) {
    try {
      const r = await api<{ streams: number }>(`/api/tests/${started.id}/speed/begin`, { body: { token: started.token }, signal });
      streams = r.streams; open = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) { show({ phase: 'wait', down: null, up: null, ping: null }); await sleep(e.body?.waitMs ?? 3000, signal); }
      else if ((e as Error).name === 'AbortError') throw e;
      else return null;
    }
  }
  if (!open) return null;
  const q = `id=${started.id}&t=${started.token}`;
  const pinger = new Pinger();
  const hasPing = await pinger.open();
  try {
    show({ phase: 'idle', down: null, up: null, ping: null });
    const idle = hasPing ? await pinger.run(2000, 150, 0, signal) : [];
    const idleMs = median(idle);
    const spikes = idleMs == null ? 0 : idle.filter((v) => v > idleMs * 2 + 50).length;

    let down = 0, up = 0;
    const [d, pd] = await Promise.all([
      download(q, streams, signal, (v) => { down = v; show({ phase: 'down', down, up: null, ping: pinger.last() }); }),
      hasPing ? pinger.run(WINDOW_MS, 250, RAMP_MS, signal) : Promise.resolve([] as number[]),
    ]);
    down = d;
    const [u, pu] = await Promise.all([
      upload(q, streams, signal, (v) => { up = v; show({ phase: 'up', down, up, ping: pinger.last() }); }),
      hasPing ? pinger.run(WINDOW_MS, 250, RAMP_MS, signal) : Promise.resolve([] as number[]),
    ]);
    up = u;
    const loaded = [median(pd), median(pu)].filter((v): v is number => v != null);
    return {
      downMbps: down, upMbps: up, capped: down >= maxMbps * 0.97,
      idleMs, loadedMs: loaded.length ? Math.max(...loaded) : null, spikes,
    };
  } finally {
    pinger.close();
    void api(`/api/tests/${started.id}/speed/end`, { body: { token: started.token } }).catch(() => {});
  }
}

// ---- The whole run ---------------------------------------------------------

export async function runTest(
  cfg: SiteConfig, link: string | null, audio: AudioContext | null, signal: AbortSignal,
  onProgress: (p: Progress) => void,
): Promise<Result> {
  const p: Progress = { step: 1, pct: 2, secondsLeft: 60, network: null, callDone: null, speedDone: null, call: null, speed: null };
  const began = performance.now();
  const push = (patch: Partial<Progress>) => { Object.assign(p, patch); p.secondsLeft = Math.max(3, Math.round(58 - (performance.now() - began) / 1000)); onProgress({ ...p }); };
  push({});

  // 1. Network: how far each Stitch region is, and who the provider is.
  const regions: RegionReading[] = await Promise.all(cfg.regions.map(async (r) => ({ id: r.id, ms: await probe(`https://${r.host}/`) })));
  signal.throwIfAborted();
  const near = regions.filter((r): r is { id: string; ms: number } => r.ms != null).sort((a, b) => a.ms - b.ms)[0] ?? null;
  const started = await api<Started>('/api/tests', { body: { link, nearest: near?.id ?? null }, signal });
  const who = started.provider ? `${started.provider}. ` : '';
  push({
    step: 2, pct: 10,
    network: near ? `${who}Nearest Stitch region: ${near.id}, ${Math.round(near.ms)} ms away.` : `${who}No Stitch region answered.`,
    call: started.call ? { left: CALL_SECONDS, loss: null, jitter: null, rtt: null, bars: [] } : null,
  });

  // 2. Call quality: a real 20-second call through Stitch.
  let call: RawCall | null = null;
  if (started.call) {
    call = await testCall(started.call, audio, signal, (left, samples) => {
      push({ pct: 10 + ((CALL_SECONDS - left) / CALL_SECONDS) * 38, call: { left, ...callSoFar(samples), bars: samples.map((s) => s.rtt) } });
    });
  }
  const so = call?.connected ? callSoFar(call.samples) : null;
  push({
    step: 3, pct: 50,
    callDone: !started.call ? 'Skipped.' : so && so.rtt != null ? `${(so.loss ?? 0).toFixed(1)}% lost, ${Math.round(so.rtt)} ms round trip.` : 'The test call could not connect.',
    speed: { phase: 'idle', down: null, up: null, ping: null },
  });

  // 3. Speed, and what a busy line does to the delay.
  const speed = await speedTest(started, cfg.maxMbps, signal, (s) => {
    push({ pct: s.phase === 'up' ? 72 + Math.min(16, (s.up ?? 0) > 0 ? 8 : 0) : s.phase === 'down' ? 56 : 50, speed: s });
  });
  push({
    step: 4, pct: 90,
    speedDone: speed ? `${fmt(speed.downMbps)} down, ${fmt(speed.upMbps)} up.` : 'Could not run.',
  });

  // 4. Firewall: Stitch's addresses, and the router.
  const [reach, nat] = await Promise.all([
    Promise.all(cfg.reach.map(async (url) => ({ url, ms: await probe(url) }))),
    natType(cfg.stun),
  ]);
  signal.throwIfAborted();
  push({ pct: 98 });

  const report: RawReport = { regions, call, speed, reach, nat, connection: connectionKind() };
  return api<Result>(`/api/tests/${started.id}/result`, { body: { token: started.token, report }, signal });
}

export const fmt = (mbps: number) => (mbps >= 10 ? `${Math.round(mbps)} Mbps` : `${mbps.toFixed(1)} Mbps`);
