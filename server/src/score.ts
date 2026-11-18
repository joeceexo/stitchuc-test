// Turns a browser's raw readings into the result a customer sees.
// Everything a customer is told is decided here, so the pass marks live in one place.

import type { CallSample, Fix, Grade, Group, ItLine, RawReport, Result, Row } from './types.js';

export interface PassMarks {
  lossGood: number; lossFair: number;         // percent
  jitterGood: number; jitterFair: number;     // ms
  rttGood: number; rttFair: number;           // ms
  scoreGood: number; scoreFair: number;       // 1 to 5
  loadGood: number; loadFair: number;         // extra ms while the line is busy
  callKbps: number;                           // each way, per voice call
  videoKbps: number;                          // each way, per person on video
  usableShare: number;                        // how much of the measured speed is counted
  callsGood: number;                          // calls at once that count as plenty of room
  reachSlowMs: number;
}

export const defaultMarks: PassMarks = {
  lossGood: 0.5, lossFair: 2,
  jitterGood: 15, jitterFair: 30,
  rttGood: 100, rttFair: 250,
  scoreGood: 4.0, scoreFair: 3.5,
  loadGood: 30, loadFair: 100,
  callKbps: 100, videoKbps: 2000, usableShare: 0.7, callsGood: 10,
  reachSlowMs: 1500,
};

export interface ScoreContext {
  code: string;
  at: Date;
  company: string | null;
  office: string | null;
  sent: boolean;
  provider: string | null;
  device: string;
  callConfigured: boolean;
  mediaHosts: string[];
  appHosts: string[];
  mediaUdp: string | null;
  maxMbps: number;
  natChecked: boolean;                        // two STUN servers are set up, so the router check ran
}

const worst = (grades: (Grade | null | undefined)[]): Grade | null => {
  const g = grades.filter(Boolean) as Grade[];
  if (!g.length) return null;
  if (g.includes('poor')) return 'poor';
  if (g.includes('fair')) return 'fair';
  return 'good';
};
const band = (v: number, good: number, fair: number): Grade => (v <= good ? 'good' : v <= fair ? 'fair' : 'poor');
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (v: number) => `${v.toFixed(1)}%`;
const ms = (v: number) => `${Math.round(v)} ms`;
const mbps = (v: number) => (v >= 10 ? `${Math.round(v)} Mbps` : `${v.toFixed(1)} Mbps`);
const label = (g: Grade) => (g === 'good' ? 'Good' : g === 'fair' ? 'Fair' : 'Poor');
const graded = (text: string, g: Grade) => (g === 'good' ? text : `${text} · ${label(g)}`);

/** A 1 to 5 call quality estimate from delay, jitter and loss (a simplified E-model). */
export function qualityScore(rttMs: number, jitterMs: number, lossPct: number): number {
  const delay = rttMs / 2 + jitterMs * 2 + 10;
  let r = 93.2 - (delay < 160 ? delay / 40 : (delay - 120) / 10);
  r -= lossPct * 6;
  r = Math.max(0, Math.min(100, r));
  const mos = 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r);
  return Math.max(1, Math.min(5, Math.round(mos * 10) / 10));
}

export interface CallFigures {
  lossUp: number | null; lossDown: number | null;
  jitter: number | null; rtt: number | null; spikes: number; seconds: number;
}

/** Sums the per-second samples, leaving out the first two seconds while the call settles. */
export function callFigures(samples: CallSample[]): CallFigures {
  const s = samples.filter((x) => x.t > 2);
  const sent = s.reduce((a, x) => a + x.sentUp, 0);
  const lostUp = s.reduce((a, x) => a + x.lostUp, 0);
  const recv = s.reduce((a, x) => a + x.recvDown, 0);
  const lostDown = s.reduce((a, x) => a + x.lostDown, 0);
  const rtts = s.map((x) => x.rtt).filter((v): v is number => v != null);
  const jit = s.map((x) => Math.max(x.jitterUp ?? 0, x.jitterDown ?? 0)).filter((_, i) => s[i]!.jitterUp != null || s[i]!.jitterDown != null);
  const rtt = median(rtts);
  let spikes = 0;
  for (const x of s) {
    const lossNow = x.sentUp > 0 ? x.lostUp / x.sentUp : 0;
    const lossIn = x.recvDown + x.lostDown > 0 ? x.lostDown / (x.recvDown + x.lostDown) : 0;
    const late = rtt != null && x.rtt != null && x.rtt > rtt * 2 + 50;
    if (late || lossNow > 0.05 || lossIn > 0.05) spikes++;
  }
  return {
    lossUp: sent > 0 ? Math.max(0, (lostUp / sent) * 100) : null,
    lossDown: recv + lostDown > 0 ? Math.max(0, (lostDown / (recv + lostDown)) * 100) : null,
    jitter: mean(jit), rtt, spikes, seconds: s.length,
  };
}

export function score(raw: RawReport, ctx: ScoreContext, m: PassMarks = defaultMarks): Result {
  const fixes: Fix[] = [];
  const wifi = raw.connection === 'wifi' || raw.connection === 'cellular';

  // ---- Network -------------------------------------------------------------
  const reached = raw.regions.filter((r): r is { id: string; ms: number } => r.ms != null).sort((a, b) => a.ms - b.ms);
  const nearest = reached[0] ?? null;
  const regionGrade = nearest ? band(nearest.ms, m.rttGood, m.rttFair) : null;
  const networkRows: Row[] = [
    { label: 'Internet provider', value: ctx.provider ?? 'Not known' },
    {
      label: 'Stitch regions',
      value: reached.length ? reached.map((r) => `${r.id} ${ms(r.ms)}`).join(' · ') : 'None reached',
      grade: regionGrade && regionGrade !== 'good' ? regionGrade : undefined,
    },
    { label: 'This device', value: ctx.device },
  ];
  if (regionGrade && regionGrade !== 'good' && nearest) {
    fixes.push({
      id: 'far', grade: regionGrade,
      title: 'You are a long way from Stitch',
      why: `The nearest Stitch region is ${ms(nearest.ms)} away. People will notice a pause before each reply.`,
      action: 'If you use a VPN, try the test with it off. Otherwise tell Stitch support where you are, so we can look at a closer region.',
    });
  }

  // ---- Call quality --------------------------------------------------------
  const call = raw.call;
  const fig = call && call.connected ? callFigures(call.samples) : null;
  const measured = !!fig && fig.seconds >= 5 && fig.rtt != null;
  let callGrade: Grade | null = null;
  let quality: number | null = null;
  const callRows: Row[] = [];
  if (measured && fig) {
    const lossUp = fig.lossUp ?? 0, lossDown = fig.lossDown ?? 0, jitter = fig.jitter ?? 0, rtt = fig.rtt ?? 0;
    const gUp = band(lossUp, m.lossGood, m.lossFair), gDown = band(lossDown, m.lossGood, m.lossFair);
    const gJit = band(jitter, m.jitterGood, m.jitterFair), gRtt = band(rtt, m.rttGood, m.rttFair);
    quality = qualityScore(rtt, jitter, Math.max(lossUp, lossDown));
    const gScore: Grade = quality >= m.scoreGood ? 'good' : quality >= m.scoreFair ? 'fair' : 'poor';
    callGrade = worst([gUp, gDown, gJit, gRtt, gScore]);
    callRows.push(
      { label: 'Sound lost, sending', value: graded(pct(lossUp), gUp), grade: gUp === 'good' ? undefined : gUp },
      { label: 'Sound lost, receiving', value: graded(pct(lossDown), gDown), grade: gDown === 'good' ? undefined : gDown },
      { label: 'Choppiness (jitter)', value: graded(ms(jitter), gJit), grade: gJit === 'good' ? undefined : gJit },
      { label: 'Delay (round trip)', value: graded(ms(rtt), gRtt), grade: gRtt === 'good' ? undefined : gRtt },
    );
    const gLoss = worst([gUp, gDown])!;
    if (gLoss !== 'good') {
      const dir = lossUp >= lossDown ? 'sent' : 'received';
      const who = lossUp >= lossDown ? 'The other person hears gaps in your words.' : 'You hear gaps in what the other person says.';
      fixes.push({
        id: 'loss', grade: gLoss,
        title: wifi ? 'Your Wi-Fi is losing sound' : 'Your connection is losing sound',
        why: `${pct(Math.max(lossUp, lossDown))} of what you ${dir} during the test call never arrived. ${who}`,
        action: wifi
          ? 'Plug this computer into the router with a network cable, or move closer to the Wi-Fi box, then test again.'
          : 'If this computer is on Wi-Fi, plug it into the router with a network cable and test again. If it already is, ask your internet provider to check the line.',
      });
    }
    if (gJit !== 'good') {
      fixes.push({
        id: 'jitter', grade: gJit,
        title: wifi ? (gJit === 'poor' ? 'Your Wi-Fi is choppy' : 'Your Wi-Fi is a little choppy') : 'Sound is arriving unevenly',
        why: `Sound arrived unevenly during the test call (${ms(jitter)} of jitter). Voices can sound robotic or clipped.`,
        action: wifi
          ? 'Move closer to the Wi-Fi box, or use a network cable on the computer you take calls on.'
          : 'Use a network cable if you are on Wi-Fi, and pause large downloads or video streams during calls.',
      });
    }
    if (gRtt !== 'good' && !(regionGrade && regionGrade !== 'good')) {
      fixes.push({
        id: 'delay', grade: gRtt,
        title: 'There is a delay on your calls',
        why: `Sound took ${ms(rtt)} to make the round trip. People talk over each other.`,
        action: 'Turn off any VPN and test again. If it stays high, ask your internet provider to check the line.',
      });
    }
  } else if (ctx.callConfigured) {
    callRows.push({ label: 'Test call', value: call?.connected ? 'Too short to measure' : 'Could not connect', grade: 'poor' });
    callGrade = 'poor';
  } else {
    callRows.push({ label: 'Test call', value: 'Not run' });
  }

  // ---- Speed ---------------------------------------------------------------
  const sp = raw.speed;
  let speedGrade: Grade | null = null;
  let calls: number | null = null, video: number | null = null;
  let callsAtLeast = false;
  const speedRows: Row[] = [];
  if (sp) {
    const downAtTop = sp.capped || sp.downMbps >= ctx.maxMbps * 0.97, upAtTop = sp.upMbps >= ctx.maxMbps * 0.97;
    callsAtLeast = downAtTop && upAtTop;
    const usableKbps = Math.min(sp.downMbps, sp.upMbps, ctx.maxMbps) * 1000 * m.usableShare;
    calls = Math.floor(usableKbps / m.callKbps + 1e-6);
    video = Math.floor(usableKbps / m.videoKbps + 1e-6);
    const gRoom: Grade = calls >= m.callsGood ? 'good' : calls >= 1 ? 'fair' : 'poor';
    const upIsLimit = sp.upMbps <= sp.downMbps;
    const extra = sp.idleMs != null && sp.loadedMs != null ? Math.max(0, sp.loadedMs - sp.idleMs) : null;
    const gLoad = extra != null ? band(extra, m.loadGood, m.loadFair) : null;
    const spikes = sp.spikes + (fig?.spikes ?? 0);
    const gSteady: Grade = spikes === 0 ? 'good' : spikes <= 2 ? 'fair' : 'poor';
    speedGrade = worst([gRoom, gLoad, gSteady]);
    const down = downAtTop ? `at least ${Math.round(ctx.maxMbps)} Mbps` : mbps(sp.downMbps);
    const upText = upAtTop ? `at least ${Math.round(ctx.maxMbps)} Mbps` : mbps(sp.upMbps);
    speedRows.push(
      { label: 'Download', value: !upIsLimit && gRoom !== 'good' ? graded(down, gRoom) : down, grade: !upIsLimit && gRoom !== 'good' ? gRoom : undefined },
      { label: 'Upload', value: upIsLimit && gRoom !== 'good' ? graded(upText, gRoom) : upText, grade: upIsLimit && gRoom !== 'good' ? gRoom : undefined },
      extra != null && gLoad
        ? { label: 'Extra delay while the line is busy', value: graded(`+${Math.round(extra)} ms`, gLoad), grade: gLoad === 'good' ? undefined : gLoad }
        : { label: 'Extra delay while the line is busy', value: 'Not measured' },
      { label: 'Steadiness', value: spikes === 0 ? 'No spikes' : graded(`${spikes} spike${spikes === 1 ? '' : 's'}`, gSteady), grade: gSteady === 'good' ? undefined : gSteady },
    );
    if (gLoad && gLoad !== 'good' && extra != null) {
      fixes.push({
        id: 'busy', grade: gLoad,
        title: 'Calls break up when the line is busy',
        why: `While we moved a file, the delay on your line jumped by ${Math.round(extra)} ms. Anyone sending email attachments or backing up will make calls choppy for everyone.`,
        action: 'Ask whoever looks after your router to turn on its traffic-priority setting (often called QoS or Smart Queue), or ask your internet provider for a faster upload.',
      });
    }
    if (gRoom !== 'good') {
      fixes.push({
        id: 'room', grade: gRoom,
        title: calls < 1 ? 'This line is too slow for a call' : 'There is not much room for calls',
        why: `Your ${upIsLimit ? 'upload' : 'download'} speed is ${mbps(upIsLimit ? sp.upMbps : sp.downMbps)}. That carries about ${calls} call${calls === 1 ? '' : 's'} at once with nothing else going on.`,
        action: `Ask your internet provider for a faster ${upIsLimit ? 'upload' : 'download'} speed.`,
      });
    }
    if (gSteady !== 'good' && !(gLoad && gLoad !== 'good')) {
      fixes.push({
        id: 'steady', grade: gSteady,
        title: 'Your connection stutters now and then',
        why: `We saw ${spikes} short stall${spikes === 1 ? '' : 's'} during a one-minute test. On a call, each one is a word or two going missing.`,
        action: 'Use a network cable if you are on Wi-Fi. If it carries on, ask your internet provider to check the line.',
      });
    }
  } else {
    speedRows.push({ label: 'Speed test', value: 'Not run' });
  }

  // ---- Firewall ------------------------------------------------------------
  const firewallRows: Row[] = [];
  let gUdp: Grade | null = null;
  let udpBlocked = false;
  if (call && call.connected && call.path) {
    const direct = call.path.type !== 'relay' && call.path.protocol === 'udp';
    const relayUdp = call.path.type === 'relay' && (call.path.relayProtocol ?? 'udp') === 'udp' && call.path.protocol === 'udp';
    gUdp = direct || relayUdp ? 'good' : 'fair';
    udpBlocked = gUdp !== 'good';
    firewallRows.push({
      label: 'Calls take the fast path (UDP)',
      value: gUdp === 'good' ? 'Yes' : graded('No, fallback used', 'fair'),
      grade: gUdp === 'good' ? undefined : 'fair',
    });
    if (udpBlocked) {
      fixes.push({
        id: 'udp', grade: 'fair',
        title: 'Your firewall sends calls the slow way',
        why: 'The fast path for calls is blocked, so Stitch fell back to a slower one. Calls work, with a little more delay.',
        action: 'Send the list below to your IT person.', link: 'it',
      });
    }
  } else if (ctx.callConfigured) {
    gUdp = 'poor';
    udpBlocked = true;
    firewallRows.push({ label: 'Calls take the fast path (UDP)', value: graded('No path found', 'poor'), grade: 'poor' });
    fixes.push({
      id: 'blocked', grade: 'poor',
      title: 'Your firewall is blocking Stitch calls',
      why: 'The test call could not get through at all. Calls in the Stitch app will fail or connect with no sound.',
      action: 'Send the list below to your IT person.', link: 'it',
    });
  } else {
    firewallRows.push({ label: 'Calls take the fast path (UDP)', value: 'Not checked' });
  }
  const blocked = raw.reach.filter((r) => r.ms == null);
  const slow = raw.reach.filter((r) => r.ms != null && r.ms > m.reachSlowMs);
  const gReach: Grade | null = raw.reach.length ? (blocked.length ? 'poor' : slow.length ? 'fair' : 'good') : null;
  firewallRows.push({
    label: 'Stitch reachable',
    value: !raw.reach.length ? 'Not checked' : blocked.length ? graded(`${blocked.length} of ${raw.reach.length} blocked`, 'poor') : slow.length ? graded('Slow to answer', 'fair') : 'All addresses',
    grade: gReach && gReach !== 'good' ? gReach : undefined,
  });
  if (gReach === 'poor') {
    fixes.push({
      id: 'reach', grade: 'poor',
      title: 'Something is blocking Stitch itself',
      why: `This computer could not reach ${blocked.map((b) => hostOf(b.url)).join(' or ')}. Stitch will not load or sign in.`,
      action: 'Send the list below to your IT person.', link: 'it',
    });
  }
  const gNat: Grade | null = raw.nat === 'symmetric' ? 'fair' : raw.nat === 'normal' ? 'good' : null;
  if (ctx.natChecked || raw.nat !== 'unknown') firewallRows.push({
    label: 'Router type',
    value: raw.nat === 'normal' ? 'Normal' : raw.nat === 'symmetric' ? graded('Strict, or a VPN', 'fair') : 'Could not tell',
    grade: gNat === 'fair' ? 'fair' : undefined,
  });
  if (gNat === 'fair' && !udpBlocked) {
    fixes.push({
      id: 'nat', grade: 'fair',
      title: 'Your router or a VPN is strict about calls',
      why: 'Your network gives every connection a different public address. Calls work, but more of them take the slower path.',
      action: 'If you are on a VPN, test again with it off. Otherwise mention this result to your IT person.',
    });
  }
  const firewallGrade = worst([gUdp, gReach, gNat]);

  // ---- Putting it together -------------------------------------------------
  const order: Record<Grade, number> = { poor: 0, fair: 1, good: 2 };
  fixes.sort((a, b) => order[a.grade] - order[b.grade]);
  const groups: Group[] = [
    { id: 'call', title: 'Call quality', grade: callGrade, rows: callRows },
    { id: 'speed', title: 'Speed', grade: speedGrade, rows: speedRows },
    { id: 'firewall', title: 'Firewall', grade: firewallGrade, rows: firewallRows },
    { id: 'network', title: 'Network', grade: regionGrade, rows: networkRows },
  ];
  const missing = [callGrade == null ? 'test call' : null, speedGrade == null ? 'speed test' : null].filter(Boolean) as string[];
  let verdict = worst(groups.map((g) => g.grade)) ?? 'fair';
  const partial = verdict === 'good' && missing.length > 0;
  if (partial) verdict = 'fair';
  const nPoor = fixes.filter((f) => f.grade === 'poor').length;
  const nFair = fixes.filter((f) => f.grade === 'fair').length;
  const count = (n: number, one: string, many: string) => `${numberWord(n)} ${n === 1 ? one : many}`;
  let headline: string, sub: string;
  if (partial) {
    headline = "We couldn't finish the test";
    sub = `The ${missing.join(' and the ')} did not run, so this is only part of the picture. Nothing we did measure looks wrong. Try again, and if it keeps happening tell Stitch support.`;
  } else if (verdict === 'good') {
    headline = 'Ready for Stitch';
    sub = 'This connection carries calls comfortably. Nothing to fix.';
  } else if (verdict === 'fair') {
    headline = 'Calls will work, with some trouble';
    sub = `${cap(count(nFair, 'thing is', 'things are'))} worth fixing. Until then, calls may sound choppy now and then.`;
  } else {
    headline = 'This connection will cause call problems';
    const tail = nFair ? ` and ${count(nFair, 'more is', 'more are')} worth a look` : '';
    sub = `${cap(count(nPoor, 'thing needs', 'things need'))} fixing${tail}.`;
  }
  const scoreText =
    quality == null ? 'Not measured'
      : quality >= 4.3 ? 'Clear, with no noticeable delay'
      : quality >= m.scoreGood ? 'Clear'
      : quality >= m.scoreFair ? 'Mostly clear'
      : quality >= 3 ? 'Words drop out; people ask you to repeat'
      : 'Hard to hold a conversation';

  const it: ItLine[] = [
    { state: 'info', text: 'Allow outbound, from every computer that uses Stitch:' },
    {
      state: udpBlocked ? 'blocked' : gUdp === 'good' ? 'open' : 'info',
      text: `UDP ${ctx.mediaUdp ?? '(ask Stitch support for the port range)'}  to ${ctx.mediaHosts.join(', ') || 'the Stitch media servers'}`,
    },
    { state: call?.connected ? 'open' : 'info', text: `TCP 443  to ${ctx.mediaHosts.join(', ') || 'the Stitch media servers'} (fallback)` },
    ...ctx.appHosts.map((h): ItLine => {
      const r = raw.reach.find((x) => hostOf(x.url) === h);
      return { state: r ? (r.ms == null ? 'blocked' : 'open') : 'info', text: `TCP 443  to ${h}` };
    }),
    { state: 'info', text: "Desk phones: turn off SIP ALG on the router. This test can't check it." },
  ];

  return {
    code: ctx.code, at: ctx.at.toISOString(), company: ctx.company, office: ctx.office, sent: ctx.sent,
    verdict, headline, sub, calls, callsAtLeast, video, score: quality, scoreText,
    nearest: nearest ? { id: nearest.id, ms: Math.round(nearest.ms) } : null,
    provider: ctx.provider, groups, fixes, it, device: ctx.device,
  };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
function numberWord(n: number): string {
  return ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Clamps and tidies what a browser sent, so nothing odd is stored or shown. */
export function cleanReport(input: unknown): RawReport {
  const o = (input ?? {}) as Record<string, any>;
  const n = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
  const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const regions = Array.isArray(o.regions)
    ? o.regions.slice(0, 12).map((r: any) => ({ id: s(r?.id, 40), ms: n(r?.ms, 0, 60000) })).filter((r: any) => r.id)
    : [];
  let call: RawReport['call'] = null;
  if (o.call && typeof o.call === 'object') {
    const samples: CallSample[] = Array.isArray(o.call.samples)
      ? o.call.samples.slice(0, 400).map((x: any, i: number) => ({
          t: n(x?.t, 0, 4000) ?? i + 1,
          rtt: n(x?.rtt, 0, 60000),
          jitterUp: n(x?.jitterUp, 0, 60000),
          jitterDown: n(x?.jitterDown, 0, 60000),
          sentUp: n(x?.sentUp, 0, 100000) ?? 0,
          lostUp: n(x?.lostUp, 0, 100000) ?? 0,
          recvDown: n(x?.recvDown, 0, 100000) ?? 0,
          lostDown: n(x?.lostDown, 0, 100000) ?? 0,
        }))
      : [];
    const p = o.call.path;
    call = {
      region: s(o.call.region, 40),
      connected: o.call.connected === true,
      samples,
      path: p && typeof p === 'object' ? { type: s(p.type, 20), protocol: s(p.protocol, 10).toLowerCase(), relayProtocol: p.relayProtocol ? s(p.relayProtocol, 10).toLowerCase() : undefined } : null,
      error: o.call.error ? s(o.call.error, 200) : undefined,
    };
  }
  let speed: RawReport['speed'] = null;
  if (o.speed && typeof o.speed === 'object') {
    const d = n(o.speed.downMbps, 0, 100000), u = n(o.speed.upMbps, 0, 100000);
    if (d != null && u != null) {
      speed = { downMbps: d, upMbps: u, capped: o.speed.capped === true, idleMs: n(o.speed.idleMs, 0, 60000), loadedMs: n(o.speed.loadedMs, 0, 60000), spikes: n(o.speed.spikes, 0, 1000) ?? 0 };
    }
  }
  const reach = Array.isArray(o.reach) ? o.reach.slice(0, 12).map((r: any) => ({ url: s(r?.url, 200), ms: n(r?.ms, 0, 60000) })).filter((r: any) => r.url) : [];
  const nat = o.nat === 'normal' || o.nat === 'symmetric' ? o.nat : 'unknown';
  const connection = ['wifi', 'ethernet', 'cellular'].includes(o.connection) ? o.connection : null;
  return { regions, call, speed, reach, nat, connection };
}

/** "Chrome on Windows 11, Wi-Fi" from a user agent and what the browser said about its link. */
export function describeDevice(ua: string, connection: string | null): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'unknown device';
  const link = connection === 'wifi' ? ', Wi-Fi' : connection === 'ethernet' ? ', network cable' : connection === 'cellular' ? ', mobile data' : '';
  return `${browser} on ${os}${link}`;
}
