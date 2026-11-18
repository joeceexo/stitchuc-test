// The service's own small Postgres database: support links and test results.

import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });

export async function migrate(): Promise<void> {
  await pool.query(`
    create table if not exists links (
      id serial primary key,
      slug text not null unique,
      company text not null,
      office text,
      created_at timestamptz not null default now()
    );
    create table if not exists tests (
      id uuid primary key,
      code text not null unique,
      token_hash text not null,
      link_id integer references links(id) on delete set null,
      company text,
      office text,
      origin text not null default 'self-serve',
      status text not null default 'running',
      created_at timestamptz not null default now(),
      finished_at timestamptz,
      ip text,
      asn integer,
      provider text,
      place text,
      ua text,
      verdict text,
      worst text,
      result jsonb,
      raw jsonb
    );
    create index if not exists tests_created_idx on tests (created_at desc);
    create index if not exists tests_company_idx on tests (lower(company));
  `);
}

/** Removes results past their keep time, and tests that never finished. */
export async function sweep(): Promise<void> {
  await pool.query(`delete from tests where created_at < now() - ($1 || ' days')::interval`, [String(config.keepDays)]);
  await pool.query(`delete from tests where status = 'running' and created_at < now() - interval '1 day'`);
}
