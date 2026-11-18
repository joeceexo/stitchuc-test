import type { ReactNode } from 'react';
import type { Grade } from '../../server/src/types';
import type { SiteConfig } from './api';

export const go = (path: string) => { history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); };

export function Chip({ grade, children }: { grade: Grade; children?: ReactNode }) {
  return <span className={`chip ${grade}`}><i aria-hidden="true" />{children ?? (grade === 'good' ? 'Good' : grade === 'fair' ? 'Fair' : 'Poor')}</span>;
}

export function Head({ cfg, right }: { cfg: SiteConfig | null; right?: ReactNode }) {
  return (
    <header className="head">
      <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go('/'); }}>
        <b>Stitch</b><i aria-hidden="true" /><span>Network Test</span>
        {cfg?.badge ? <em className="badge">{cfg.badge}</em> : null}
      </a>
      {right}
    </header>
  );
}

export function Foot({ cfg }: { cfg: SiteConfig | null }) {
  const phone = cfg?.phone ?? '(877) 699-8181', mail = cfg?.supportEmail ?? 'support@stitchuc.com';
  return (
    <footer className="foot">
      <span>Need a hand? Call <a href={`tel:+1${phone.replace(/\D/g, '')}`}>{phone}</a> or write to <a href={`mailto:${mail}`}>{mail}</a></span>
      <span>No sign-in. Your microphone is never used.</span>
    </footer>
  );
}

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export const Check = ({ size = 30 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
);
export const Bang = ({ size = 30 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 6v7" /><path d="M12 18h.01" /></svg>
);
