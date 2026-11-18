// Shapes shared by the server and the site. The site imports these as types only.

export type Grade = 'good' | 'fair' | 'poor';

export interface RegionReading { id: string; ms: number | null }

export interface CallSample {
  t: number;                 // second of the test call, from 1
  rtt: number | null;        // round trip, ms
  jitterUp: number | null;   // ms, as the far end saw what we sent
  jitterDown: number | null; // ms, on what we received
  sentUp: number;            // packets sent this second
  lostUp: number;            // of those, reported lost
  recvDown: number;          // packets received this second
  lostDown: number;          // packets missing this second
}

export interface CallPath { type: string; protocol: string; relayProtocol?: string }

export interface RawCall {
  region: string;
  connected: boolean;
  samples: CallSample[];
  path: CallPath | null;
  error?: string;
}

export interface RawSpeed {
  downMbps: number;
  upMbps: number;
  capped: boolean;           // download reached the test's ceiling
  idleMs: number | null;     // round trip with the line quiet
  loadedMs: number | null;   // worst median round trip while a transfer ran
  spikes: number;            // pings far above the idle round trip while quiet
}

export interface RawReport {
  regions: RegionReading[];
  call: RawCall | null;
  speed: RawSpeed | null;
  reach: { url: string; ms: number | null }[];
  nat: 'normal' | 'symmetric' | 'unknown';
  connection: string | null; // 'wifi', 'ethernet', 'cellular' where the browser says
}

export interface Row { label: string; value: string; grade?: Grade }
export interface Group { id: 'call' | 'speed' | 'firewall' | 'network'; title: string; grade: Grade | null; rows: Row[] }
export interface Fix { id: string; grade: Grade; title: string; why: string; action: string; link?: 'it' }
export interface ItLine { state: 'open' | 'blocked' | 'info'; text: string }

export interface Result {
  code: string;
  at: string;
  company: string | null;
  office: string | null;
  sent: boolean;             // came in on a support link, so support already has it
  verdict: Grade;
  headline: string;
  sub: string;
  calls: number | null;
  callsAtLeast: boolean;      // both speeds hit the test's ceiling, so the real figure is higher
  video: number | null;
  score: number | null;
  scoreText: string;
  nearest: { id: string; ms: number } | null;
  provider: string | null;
  groups: Group[];
  fixes: Fix[];
  it: ItLine[];
  device: string;
}

export interface StaffDetail {
  ip: string | null;
  asn: number | null;
  place: string | null;
  path: string;
  ua: string;
  samples: CallSample[];
  origin: string;
}

export interface PublicConfig {
  regions: { id: string; host: string }[];
  reach: string[];
  stun: string[];
  email: boolean;
  staff: boolean;
  phone: string;
  supportEmail: string;
  badge: string | null;
  maxMbps: number;
}
