// Stitch Network Test: the server. It serves the site, runs the speed transfers, hands out
// passes for the test call, works out each result and keeps it for support to look up.

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { migrate, pool, sweep } from './db.js';
import { loadGeo, lookup } from './geo.js';
import { callRegion, makePass } from './livekit.js';
import { sendCopy } from './mail.js';
import { cleanReport, describeDevice, score } from './score.js';
import type { PublicConfig, RawReport, Result, StaffDetail } from './types.js';

const VERSION = '0.1.0';
const STREAMS = 4;                       // parallel transfers the site uses
const CHUNK = randomBytes(64 * 1024);    // random, so nothing on the way can compress it
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const app: FastifyInstance = Fastify({ logger: { level: 'info' }, disableRequestLogging: true, trustProxy: config.trustProxy as unknown as boolean, bodyLimit: 256 * 1024 });
await app.register(fastifyWebsocket, { options: { maxPayload: 1024 } });

// ---- Small in-memory helpers -----------------------------------------------

/** Counts things per key over a sliding window. */
function limiter(max: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [k, v] of seen) { const f = v.filter((t) => t > cut); if (f.length) seen.set(k, f); else seen.delete(k); }
  }, 60_000).unref();
  return (key: string): boolean => {
    const cut = Date.now() - windowMs;
    const v = (seen.get(key) ?? []).filter((t) => t > cut);
    if (v.length >= max) { seen.set(key, v); return false; }
    v.push(Date.now()); seen.set(key, v); return true;
  };
}
const testLimit = limiter(config.perIpHour, 3600_000);
const emailLimit = limiter(5, 3600_000);
const loginLimit = limiter(10, 3600_000);

/** Tests in progress: who may use the speed endpoints, and until when. */
interface Live { tokenHash: string; until: number; speedUntil: number }
const live = new Map<string, Live>();
setInterval(() => { const now = Date.now(); for (const [k, v] of live) if (v.until < now) live.delete(k); }, 30_000).unref();
const speedNow = () => { const now = Date.now(); let n = 0; for (const v of live.values()) if (v.speedUntil > now) n++; return n; };

function liveTest(id: unknown, token: unknown): Live | null {
  if (typeof id !== 'string' || typeof token !== 'string') return null;
  const t = live.get(id);
  if (!t || t.until < Date.now()) return null;
  const a = Buffer.from(t.tokenHash), b = Buffer.from(sha(token));
  return a.length === b.length && timingSafeEqual(a, b) ? t : null;
}

const CODE_LETTERS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const pick = (n: number) => Array.from({ length: n }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
const newCode = () => `NT-${pick(3)}-${pick(3)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for addresses that never belong to a visitor: private, loopback, link-local, carrier NAT. */
const internal = (ip: string) =>
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ||
  /^(::1$|f[cd]|fe80:)/i.test(ip) || ip === '';
/**
 * The visitor's address. Fastify's own answer when it is a public one; otherwise the last public
 * address the proxies in front wrote down (EasyPanel's proxy can sit behind Docker's own network).
 */
function clientIp(req: FastifyRequest): string {
  const direct = req.ip.replace(/^::ffff:/, '');
  if (!internal(direct) || config.trustProxy === 0) return direct;
  const chain = [String(req.headers['x-forwarded-for'] ?? ''), String(req.headers['x-real-ip'] ?? '')]
    .join(',').split(',').map((x) => x.trim().replace(/^::ffff:/, '')).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!internal(chain[i]!)) return chain[i]!;
  return direct;
}

// ---- Staff sign-in ---------------------------------------------------------

const sign = (v: string) => createHmac('sha256', config.sessionSecret).update(v).digest('hex');
function staffCookie(): string {
  const exp = String(Date.now() + 12 * 3600_000);
  return `${exp}.${sign(exp)}`;
}
function isStaff(req: FastifyRequest): boolean {
  if (!config.staffPassword) return false;
  const m = /(?:^|;\s*)nt_staff=([^;]+)/.exec(req.headers.cookie ?? '');
  if (!m) return false;
  const [exp, mac] = m[1]!.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
const needStaff = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (!isStaff(req)) { await reply.code(401).send({ error: 'Sign in first.' }); }
};

// ---- Public API ------------------------------------------------------------

app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('X-Frame-Options', 'DENY');
  if (req.url.startsWith('/api') || req.url.startsWith('/r/') || req.url.startsWith('/staff')) {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex');
  }
});

app.get('/healthz', async (_req, reply) => {
  try { await pool.query('select 1'); return { ok: true, version: VERSION, call: config.livekit.size > 0 }; }
  catch { return reply.code(503).send({ ok: false, version: VERSION }); }
});

app.get('/api/config', async (req) => {
  const q = req.query as { link?: string };
  let link: { company: string; office: string | null } | null = null;
  if (q.link) {
    const r = await pool.query('select company, office from links where slug = $1', [String(q.link).slice(0, 80)]);
    link = r.rows[0] ?? null;
  }
  const cfg: PublicConfig = {
    regions: config.regions, reach: config.reach, stun: config.stun,
    email: !!config.resendKey, staff: !!config.staffPassword,
    phone: config.phone, supportEmail: config.supportEmail, badge: config.badge, maxMbps: config.maxMbps,
  };
  return { ...cfg, link, linkMissing: !!q.link && !link };
});

app.post('/api/tests', async (req, reply) => {
  if (!testLimit(clientIp(req))) {
    return reply.code(429).send({ error: 'This connection has run a lot of tests in the last hour. Please try again a little later.' });
  }
  const body = (req.body ?? {}) as { link?: string; nearest?: string };
  let link: { id: number; company: string; office: string | null } | null = null;
  if (body.link) {
    const r = await pool.query('select id, company, office from links where slug = $1', [String(body.link).slice(0, 80)]);
    link = r.rows[0] ?? null;
  }
  const ip = clientIp(req);
  const id = randomUUID();
  const token = randomBytes(24).toString('hex');
  const geo = lookup(ip);
  let code = newCode();
  for (let i = 0; i < 5; i++) {
    try {
      await pool.query(
        `insert into tests (id, code, token_hash, link_id, company, office, origin, ip, asn, provider, place, ua)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, code, sha(token), link?.id ?? null, link?.company ?? null, link?.office ?? null, link ? 'Support link' : 'Self-serve',
          ip, geo.asn, geo.provider, geo.place, String(req.headers['user-agent'] ?? '').slice(0, 400)],
      );
      break;
    } catch (e: any) {
      if (e?.code === '23505' && i < 4) { code = newCode(); continue; }
      throw e;
    }
  }
  req.log.info({ code, direct: req.ip, forwarded: req.headers['x-forwarded-for'] ? 'yes' : 'no', hops: String(req.headers['x-forwarded-for'] ?? '').split(',').length, publicIp: !internal(ip) }, 'test started');
  live.set(id, { tokenHash: sha(token), until: Date.now() + 10 * 60_000, speedUntil: 0 });
  const nearest = typeof body.nearest === 'string' ? body.nearest.slice(0, 40) : null;
  const call = await makePass(id, nearest).catch((e) => { req.log.warn({ err: e }, 'could not make a test call pass'); return null; });
  return { id, token, code, provider: geo.provider, call };
});

app.register(async (ws) => {
  // A tiny echo, on its own connection, for timing the line while a transfer runs.
  ws.get('/api/ws', { websocket: true }, (socket) => {
    let n = 0;
    const end = setTimeout(() => socket.close(), 120_000);
    socket.on('message', (data: Buffer) => { if (++n > 2000) return socket.close(); socket.send(data.toString().slice(0, 64)); });
    socket.on('close', () => clearTimeout(end));
  });
});

app.post('/api/tests/:id/speed/begin', async (req, reply) => {
  const { id } = req.params as { id: string };
  const t = liveTest(id, (req.body as any)?.token);
  if (!t) return reply.code(403).send({ error: 'This test has ended. Start it again.' });
  if (t.speedUntil < Date.now() && speedNow() >= config.atOnce) return reply.code(429).send({ waitMs: 3000 });
  t.speedUntil = Date.now() + 45_000;
  return { ok: true, streams: STREAMS };
});

app.post('/api/tests/:id/speed/end', async (req) => {
  const { id } = req.params as { id: string };
  const t = liveTest(id, (req.body as any)?.token);
  if (t) t.speedUntil = 0;
  return { ok: true };
});

const perStream = () => (config.maxMbps * 1.25 * 1e6) / 8 / STREAMS; // bytes a second

app.get('/api/speed/down', (req, reply) => {
  const q = req.query as { id?: string; t?: string };
  const t = liveTest(q.id, q.t);
  if (!t || t.speedUntil < Date.now()) { reply.code(403).send({ error: 'Not in a speed test.' }); return; }
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform',
    'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no',
  });
  const rate = perStream(), start = Date.now();
  let sent = 0, closed = false;
  res.on('close', () => { closed = true; });
  const tick = () => {
    if (closed) return;
    const gone = Date.now() - start;
    if (gone > 15_000) { res.end(); return; }
    const allowed = (gone / 1000) * rate + CHUNK.length;
    while (sent < allowed) {
      sent += CHUNK.length;
      if (!res.write(CHUNK)) { res.once('drain', tick); return; }
    }
    setTimeout(tick, 4);
  };
  tick();
});

app.register(async (up) => {
  up.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  up.post('/api/speed/up', { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const q = req.query as { id?: string; t?: string };
    const t = liveTest(q.id, q.t);
    if (!t || t.speedUntil < Date.now()) return reply.code(403).send({ error: 'Not in a speed test.' });
    const rate = perStream(), start = Date.now();
    let got = 0;
    for await (const chunk of req.body as Readable) {
      got += (chunk as Buffer).length;
      const ahead = got / rate - (Date.now() - start) / 1000;
      if (ahead > 0.05) await sleep(Math.min(250, ahead * 1000));
    }
    return { bytes: got };
  });
});

async function finish(id: string, raw: RawReport, row: any): Promise<Result> {
  const mediaHosts = [...new Set([...config.livekit.values()].map((k) => new URL(k.url.replace(/^ws/, 'http')).host))];
  const result = score(raw, {
    code: row.code, at: new Date(), company: row.company, office: row.office, sent: row.link_id != null,
    provider: row.provider, device: describeDevice(row.ua ?? '', raw.connection),
    callConfigured: callRegion(null) != null,
    mediaHosts: mediaHosts.length ? mediaHosts : config.regions.map((r) => r.host),
    appHosts: config.reach.map((u) => { try { return new URL(u).host; } catch { return u; } }),
    mediaUdp: config.mediaUdp, maxMbps: config.maxMbps, natChecked: config.stun.length >= 2,
  }, config.marks);
  const worst = result.fixes[0]?.title ?? null;
  await pool.query(
    `update tests set status = 'done', finished_at = now(), verdict = $2, worst = $3, result = $4, raw = $5 where id = $1`,
    [id, result.verdict, worst, JSON.stringify(result), JSON.stringify(raw)],
  );
  return result;
}

app.post('/api/tests/:id/result', { bodyLimit: 512 * 1024 }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { token?: string; report?: unknown };
  const t = liveTest(id, body.token);
  if (!t) return reply.code(403).send({ error: 'This test has ended. Start it again.' });
  const r = await pool.query(`select code, company, office, link_id, provider, ua, status from tests where id = $1`, [id]);
  const row = r.rows[0];
  if (!row || row.status !== 'running') return reply.code(409).send({ error: 'This test already has a result.' });
  const result = await finish(id, cleanReport(body.report), row);
  live.delete(id);
  return result;
});

app.get('/api/results/:code', async (req, reply) => {
  const { code } = req.params as { code: string };
  const r = await pool.query(`select result from tests where code = $1 and status = 'done'`, [code.toUpperCase().slice(0, 20)]);
  if (!r.rows[0]) return reply.code(404).send({ error: 'No result with that code. Results are kept for a limited time.' });
  return r.rows[0].result as Result;
});

app.post('/api/results/:code/email', async (req, reply) => {
  if (!config.resendKey) return reply.code(404).send({ error: 'Email is not set up.' });
  const { code } = req.params as { code: string };
  const email = String((req.body as any)?.email ?? '').trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return reply.code(400).send({ error: 'That email address does not look right.' });
  if (!emailLimit(clientIp(req))) return reply.code(429).send({ error: 'Too many emails from this connection. Try again in an hour.' });
  const r = await pool.query(`select result from tests where code = $1 and status = 'done'`, [code.toUpperCase().slice(0, 20)]);
  if (!r.rows[0]) return reply.code(404).send({ error: 'No result with that code.' });
  try { await sendCopy(email, r.rows[0].result as Result); }
  catch (e) { req.log.error({ err: e }, 'email copy failed'); return reply.code(502).send({ error: 'The email could not be sent. Try again in a moment.' }); }
  return { ok: true };
});

// ---- Staff API -------------------------------------------------------------

app.post('/api/staff/login', async (req, reply) => {
  if (!config.staffPassword) return reply.code(404).send({ error: 'The staff view is not set up.' });
  if (!loginLimit(clientIp(req))) return reply.code(429).send({ error: 'Too many tries. Wait an hour.' });
  const given = Buffer.from(sha(String((req.body as any)?.password ?? '')));
  const want = Buffer.from(sha(config.staffPassword));
  if (!timingSafeEqual(given, want)) return reply.code(401).send({ error: 'That password is not right.' });
  const secure = config.publicUrl.startsWith('https') ? ' Secure;' : '';
  reply.header('Set-Cookie', `nt_staff=${staffCookie()}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=43200`);
  return { ok: true };
});
app.post('/api/staff/logout', async (_req, reply) => {
  reply.header('Set-Cookie', 'nt_staff=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return { ok: true };
});
app.get('/api/staff/me', async (req) => ({ staff: isStaff(req), enabled: !!config.staffPassword }));

app.get('/api/staff/tests', { preHandler: needStaff }, async (req) => {
  const q = String((req.query as any)?.q ?? '').trim().slice(0, 80);
  const where = q ? `and (company ilike $1 or office ilike $1 or code ilike $1 or provider ilike $1)` : '';
  const r = await pool.query(
    `select code, company, office, origin, verdict, worst, provider, created_at from tests
     where status = 'done' ${where} order by created_at desc limit 200`, q ? [`%${q}%`] : [],
  );
  return { tests: r.rows, keepDays: config.keepDays };
});

app.get('/api/staff/tests/:code', { preHandler: needStaff }, async (req, reply) => {
  const { code } = req.params as { code: string };
  const r = await pool.query(`select result, raw, ip, asn, place, ua, origin from tests where code = $1 and status = 'done'`, [code.toUpperCase().slice(0, 20)]);
  const row = r.rows[0];
  if (!row) return reply.code(404).send({ error: 'No result with that code.' });
  const raw = row.raw as RawReport;
  const p = raw.call?.path;
  const pathText = !raw.call ? 'No test call' : !raw.call.connected ? `Did not connect${raw.call.error ? ` (${raw.call.error})` : ''}`
    : !p ? `Connected, ${raw.call.region}`
    : `${p.type === 'relay' ? `Relay over ${(p.relayProtocol ?? p.protocol).toUpperCase()}` : `Direct over ${p.protocol.toUpperCase()}`}, ${raw.call.region}`;
  const staff: StaffDetail = { ip: row.ip, asn: row.asn, place: row.place, path: pathText, ua: row.ua ?? '', samples: raw.call?.samples ?? [], origin: row.origin };
  return { result: row.result as Result, staff };
});

app.post('/api/staff/tests/:code/company', { preHandler: needStaff }, async (req, reply) => {
  const { code } = req.params as { code: string };
  const company = String((req.body as any)?.company ?? '').trim().slice(0, 120);
  const office = String((req.body as any)?.office ?? '').trim().slice(0, 120) || null;
  if (!company) return reply.code(400).send({ error: 'Give the company a name.' });
  const r = await pool.query(
    `update tests set company = $2, office = $3, origin = 'Result code, tied by staff',
       result = jsonb_set(jsonb_set(result, '{company}', to_jsonb($2::text)), '{office}', coalesce(to_jsonb($3::text), 'null'::jsonb))
     where code = $1 and status = 'done' returning code`, [code.toUpperCase().slice(0, 20), company, office],
  );
  if (!r.rows[0]) return reply.code(404).send({ error: 'No result with that code.' });
  return { ok: true };
});

app.get('/api/staff/links', { preHandler: needStaff }, async () => {
  const r = await pool.query(
    `select l.slug, l.company, l.office, l.created_at, count(t.id)::int as tests
     from links l left join tests t on t.link_id = l.id and t.status = 'done'
     group by l.id order by l.created_at desc limit 200`,
  );
  return { links: r.rows.map((l) => ({ ...l, url: `${config.publicUrl}/t/${l.slug}` })) };
});

app.post('/api/staff/links', { preHandler: needStaff }, async (req, reply) => {
  const company = String((req.body as any)?.company ?? '').trim().slice(0, 120);
  const office = String((req.body as any)?.office ?? '').trim().slice(0, 120) || null;
  if (!company) return reply.code(400).send({ error: 'Give the company a name.' });
  const base = `${company} ${office ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'test';
  const slug = `${base}-${pick(4).toLowerCase()}`;
  await pool.query('insert into links (slug, company, office) values ($1,$2,$3)', [slug, company, office]);
  return { slug, url: `${config.publicUrl}/t/${slug}`, company, office };
});

// ---- The site --------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = config.webDir || [path.join(here, '../web'), path.join(here, '../../dist/web')].find((d) => existsSync(path.join(d, 'index.html'))) || '';
if (webDir) {
  await app.register(fastifyStatic, {
    root: webDir, wildcard: false,
    setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      else res.header('Cache-Control', 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.code(404).send({ error: 'Not found.' });
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
} else {
  app.log.warn('The built site was not found; serving the API only.');
}

// ---- Start -----------------------------------------------------------------

if (!config.databaseUrl) { app.log.error('DATABASE_URL is not set.'); process.exit(1); }
for (let i = 0; ; i++) {
  try { await migrate(); break; }
  catch (e) { if (i >= 20) throw e; app.log.warn(`Waiting for the database (${(e as Error).message})`); await sleep(3000); }
}
await sweep().catch(() => {});
setInterval(() => { sweep().catch((e) => app.log.warn({ err: e }, 'sweep failed')); }, 6 * 3600_000).unref();
void loadGeo((m) => app.log.info(m));
setInterval(() => { void loadGeo((m) => app.log.info(m)); }, 7 * 864e5).unref();

if (!config.livekit.size) app.log.warn('No LiveKit settings: the test call is off, so call quality and the UDP check will not run.');
if (!config.staffPassword) app.log.warn('NETTEST_STAFF_PASSWORD is not set: the staff view is off.');
if (!process.env.NETTEST_SESSION_SECRET) app.log.warn('NETTEST_SESSION_SECRET is not set: staff are signed out whenever the service restarts.');

await app.listen({ port: config.port, host: '0.0.0.0' });
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
