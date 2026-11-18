// Who an address belongs to (provider) and roughly where it is, from DB-IP's free Lite databases.
// Read locally; nothing about the visitor is sent anywhere. The files are fetched once a month
// into NETTEST_GEO_DIR. Without them the test still runs and the provider shows as "Not known".

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import maxmind, { type Reader } from 'maxmind';
import { config } from './config.js';

let asnDb: Reader<any> | null = null;
let cityDb: Reader<any> | null = null;

export interface Geo { asn: number | null; provider: string | null; place: string | null }

export function lookup(ip: string): Geo {
  const out: Geo = { asn: null, provider: null, place: null };
  try {
    const a = asnDb?.get(ip);
    if (a) { out.asn = a.autonomous_system_number ?? null; out.provider = a.autonomous_system_organization ?? null; }
    const c = cityDb?.get(ip);
    if (c) {
      const city = c.city?.names?.en, sub = c.subdivisions?.[0]?.names?.en, country = c.country?.iso_code;
      out.place = [city, sub, country].filter(Boolean).join(', ') || null;
    }
  } catch { /* an address the files don't know */ }
  return out;
}

async function fresh(file: string): Promise<boolean> {
  try { return Date.now() - (await stat(file)).mtimeMs < 35 * 864e5; } catch { return false; }
}

async function fetchDb(kind: 'asn' | 'city', file: string): Promise<void> {
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  for (const month of months) {
    const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) continue;
      await pipeline(Readable.fromWeb(res.body as any), createGunzip(), createWriteStream(`${file}.part`));
      await rename(`${file}.part`, file);
      return;
    } catch { /* try the month before */ }
  }
  throw new Error(`could not download the ${kind} database`);
}

export async function loadGeo(log: (m: string) => void): Promise<void> {
  if (!config.geo) return;
  await mkdir(config.geoDir, { recursive: true }).catch(() => {});
  for (const kind of ['asn', 'city'] as const) {
    const file = path.join(config.geoDir, `dbip-${kind}-lite.mmdb`);
    try {
      if (!(await fresh(file))) await fetchDb(kind, file);
      const db = await maxmind.open(file);
      if (kind === 'asn') asnDb = db; else cityDb = db;
      log(`IP database ready: ${kind}`);
    } catch (e) {
      // An older copy is better than none.
      try { const db = await maxmind.open(file); if (kind === 'asn') asnDb = db; else cityDb = db; log(`IP database (older copy) in use: ${kind}`); }
      catch { log(`IP database not available: ${kind} (${(e as Error).message})`); }
    }
  }
}
