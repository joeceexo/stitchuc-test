// Every setting the service reads, with its default. See .env.example for what each one is for.

import { randomBytes } from 'node:crypto';
import { defaultMarks, type PassMarks } from './score.js';

const env = process.env;
const num = (k: string, d: number): number => {
  const v = Number(env[k]);
  return env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : d;
};
const list = (k: string, d: string): string[] => (env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);

export interface Region { id: string; host: string }
export interface LiveKitKeys { url: string; key: string; secret: string }

// "us-east=lk-001.example.net,apac=lk-001.apac.example.net"
const regions: Region[] = list('NETTEST_REGIONS', '').map((pair) => {
  const [id, host] = pair.split('=').map((s) => s.trim());
  return { id: id ?? '', host: (host ?? '').replace(/^\w+:\/\//, '').replace(/\/.*$/, '') };
}).filter((r) => r.id && r.host);

// LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET serve LIVEKIT_REGION (the first region if unset).
// Other regions can have their own: LIVEKIT_SA_EAST_URL, LIVEKIT_SA_EAST_API_KEY, LIVEKIT_SA_EAST_API_SECRET.
const livekit = new Map<string, LiveKitKeys>();
const mainRegion = env.LIVEKIT_REGION || regions[0]?.id || 'default';
if (env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
  livekit.set(mainRegion, { url: env.LIVEKIT_URL, key: env.LIVEKIT_API_KEY, secret: env.LIVEKIT_API_SECRET });
}
for (const r of regions) {
  const p = `LIVEKIT_${r.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
  const url = env[`${p}URL`], key = env[`${p}API_KEY`], secret = env[`${p}API_SECRET`];
  if (url && key && secret) livekit.set(r.id, { url, key, secret });
}

let marks: PassMarks = defaultMarks;
if (env.NETTEST_PASS_MARKS) {
  try { marks = { ...defaultMarks, ...JSON.parse(env.NETTEST_PASS_MARKS) }; }
  catch { console.warn('NETTEST_PASS_MARKS is not valid JSON; using the defaults'); }
}

export const config = {
  port: num('PORT', 4000),
  databaseUrl: env.DATABASE_URL ?? '',
  publicUrl: (env.NETTEST_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  trustProxy: num('NETTEST_TRUST_PROXY', 1),
  regions,
  livekit,
  mainRegion,
  reach: list('NETTEST_REACH', 'https://login.stitchuc.com'),
  stun: list('NETTEST_STUN', ''),
  mediaUdp: env.NETTEST_IT_MEDIA_UDP || null,
  maxMbps: num('NETTEST_MAX_MBPS', 200),
  perIpHour: num('NETTEST_PER_IP_HOUR', 12),
  atOnce: num('NETTEST_AT_ONCE', 4),
  keepDays: num('NETTEST_KEEP_DAYS', 90),
  marks,
  staffPassword: env.NETTEST_STAFF_PASSWORD ?? '',
  sessionSecret: env.NETTEST_SESSION_SECRET || randomBytes(32).toString('hex'),
  resendKey: env.RESEND_API_KEY ?? '',
  mailFrom: env.MAIL_FROM ?? 'StitchUC <support@stitchuc.com>',
  phone: env.NETTEST_SUPPORT_PHONE ?? '(877) 699-8181',
  supportEmail: env.NETTEST_SUPPORT_EMAIL ?? 'support@stitchuc.com',
  badge: env.STITCH_BADGE || null,
  geoDir: env.NETTEST_GEO_DIR ?? '/data/geo',
  geo: (env.NETTEST_GEO ?? 'true') !== 'false',
  webDir: env.NETTEST_WEB_DIR ?? '',
};
