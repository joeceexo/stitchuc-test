import { useState } from 'react';
import type { SiteConfig } from './api';
import { Foot, Head, go } from './ui';

const icon = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: '#1B1918', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export function Start({ cfg, error, onStart }: { cfg: SiteConfig | null; error: string | null; onStart: () => void }) {
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const link = cfg?.link;
  return (
    <div className="page">
      <Head cfg={cfg} right={
        <nav className="nav">
          {asking ? (
            <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) go(`/r/${code.trim().toUpperCase()}`); }} style={{ display: 'flex', gap: 8 }}>
              <label className="noprint" style={{ position: 'absolute', left: -9999 }} htmlFor="code">Result code</label>
              <input id="code" className="field mono" style={{ height: 40, width: 150, fontSize: 14 }} placeholder="NT-XXX-XXX" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <button className="btn sm" style={{ height: 40 }} type="submit">Open</button>
            </form>
          ) : <button className="link" type="button" onClick={() => setAsking(true)}>Have a result code?</button>}
          <a href={`mailto:${cfg?.supportEmail ?? 'support@stitchuc.com'}`}>Help</a>
          <a className="pill" href="https://login.stitchuc.com">Open Stitch</a>
        </nav>
      } />
      <main className="main" style={{ paddingTop: 56, gap: 40 }}>
        <div className="hero">
          {link ? (
            <div className="for"><i aria-hidden="true" /><span><strong style={{ fontWeight: 600 }}>{link.company}{link.office ? ` · ${link.office}` : ''}.</strong> Your result goes straight to Stitch support.</span></div>
          ) : null}
          {cfg?.linkMissing ? <div className="for"><span>That link isn't one we know, so this test won't be filed for you. You can still run it and read us the result code.</span></div> : null}
          <h1>Can your internet carry your calls?</h1>
          <p>One minute, nothing to install. We place a short test call through Stitch and tell you what we find, in plain words.</p>
          <button className="go" type="button" onClick={onStart} disabled={!cfg}>Start the test</button>
          {error ? <p className="err" role="alert">{error}</p> : null}
        </div>
        <div className="wrap four">
          <div className="card">
            <svg {...icon}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>
            <b>Call quality</b><span>A real 20-second test call: lost sound, delay and choppiness.</span>
          </div>
          <div className="card">
            <svg {...icon}><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-6" /></svg>
            <b>Speed</b><span>How many calls fit at once, and whether a busy line breaks them up.</span>
          </div>
          <div className="card">
            <svg {...icon}><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.800-1-8-4.500-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></svg>
            <b>Firewall</b><span>Whether your router or firewall lets Stitch calls through.</span>
          </div>
          <div className="card">
            <svg {...icon}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.500 2.500 3.800 5.500 3.800 9s-1.300 6.500-3.800 9c-2.500-2.500-3.800-5.500-3.800-9S9.500 5.500 12 3z" /></svg>
            <b>Network</b><span>Your internet provider and how far you are from Stitch.</span>
          </div>
        </div>
        <div className="wrap note tips">
          <strong>For the truest result</strong>
          <span>Test from the computer you take calls on.</span>
          <span>Stay on the same Wi-Fi or cable you use for work.</span>
          <span>Leave everything else running as it normally is.</span>
        </div>
      </main>
      <Foot cfg={cfg} />
    </div>
  );
}
