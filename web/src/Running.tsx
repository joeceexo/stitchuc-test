import type { SiteConfig } from './api';
import { fmt, type Progress } from './runner';
import { Check, Head } from './ui';

const titles = ['Network', 'Call quality', 'Speed', 'Firewall'];
const waits = ['', 'A 20-second test call.', 'Download, upload, and delay while the line is busy.', 'Whether calls get through your router.'];

export function Running({ cfg, p, onStop }: { cfg: SiteConfig | null; p: Progress; onStop: () => void }) {
  const who = cfg?.link ? `${cfg.link.company}${cfg.link.office ? ` · ${cfg.link.office}` : ''}` : null;
  const done = [p.network, p.callDone, p.speedDone, null];
  const bars = Array.from({ length: 20 }, (_, i) => p.call?.bars[i] ?? null);
  const top = Math.max(60, ...bars.map((b) => b ?? 0)) * 1.25;
  const num = (v: number | null | undefined, digits = 0) => (v == null ? '–' : v.toFixed(digits));
  return (
    <div className="page">
      <Head cfg={cfg} right={who ? <span className="who">{who}</span> : undefined} />
      <main className="main" style={{ paddingTop: 48, gap: 32 }}>
        <div className="wrap run-top">
          <div className="row">
            <h1>Testing your connection</h1>
            <span style={{ fontSize: 15, color: 'var(--muted)' }}>About {p.secondsLeft} seconds left. Keep this tab open.</span>
          </div>
          <div className="track" role="progressbar" aria-label="Test progress" aria-valuenow={Math.round(p.pct)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${p.pct}%` }} /></div>
        </div>
        <div className="wrap run">
          <section className="card raised live" aria-live="polite">
            {p.step === 1 ? (
              <div><div className="eyebrow">Step 1 of 4 · Network</div><h2 style={{ marginTop: 6 }}>Finding the nearest Stitch region</h2><p className="sub" style={{ marginTop: 6 }}>Timing a small request to each one.</p></div>
            ) : p.step === 2 ? (
              <>
                <div><div className="eyebrow">Step 2 of 4 · Call quality</div><h2 style={{ marginTop: 6 }}>Placing a test call through Stitch</h2>
                  <p className="sub" style={{ marginTop: 6 }}>{p.call ? `Sending and receiving sound for 20 seconds. You won't hear anything. ${p.call.left} seconds to go.` : 'Connecting.'}</p></div>
                <div className="three">
                  <div><small>Sound lost</small><b>{num(p.call?.loss, 1)}<span> %</span></b></div>
                  <div><small>Choppiness (jitter)</small><b>{num(p.call?.jitter)}<span> ms</span></b></div>
                  <div><small>Delay (round trip)</small><b>{num(p.call?.rtt)}<span> ms</span></b></div>
                </div>
                <div>
                  <div className="bars" role="img" aria-label="Round trip time for each second of the test call so far">
                    {bars.map((b, i) => <div key={i} className={b != null ? 'on' : ''} style={{ height: b != null ? `${Math.max(6, (b / top) * 100)}%` : '4%' }} />)}
                  </div>
                  <div className="axis"><span>Start</span><span>Delay, second by second</span><span>20 s</span></div>
                </div>
              </>
            ) : p.step === 3 ? (
              <>
                <div><div className="eyebrow">Step 3 of 4 · Speed</div>
                  <h2 style={{ marginTop: 6 }}>{p.speed?.phase === 'wait' ? 'Waiting for a free slot' : p.speed?.phase === 'up' ? 'Measuring your upload' : p.speed?.phase === 'down' ? 'Measuring your download' : 'Timing your line while it is quiet'}</h2>
                  <p className="sub" style={{ marginTop: 6 }}>{p.speed?.phase === 'wait' ? 'A few other people are testing right now. Yours starts in a few seconds.' : 'We also watch what a busy line does to the delay, since that is what breaks calls up.'}</p></div>
                <div className="three">
                  <div><small>Download</small><b style={{ fontSize: 32 }}>{p.speed?.down != null ? fmt(p.speed.down).replace(' Mbps', '') : '–'}<span> Mbps</span></b></div>
                  <div><small>Upload</small><b style={{ fontSize: 32 }}>{p.speed?.up != null ? fmt(p.speed.up).replace(' Mbps', '') : '–'}<span> Mbps</span></b></div>
                  <div><small>Delay right now</small><b style={{ fontSize: 32 }}>{num(p.speed?.ping)}<span> ms</span></b></div>
                </div>
              </>
            ) : (
              <div><div className="eyebrow">Step 4 of 4 · Firewall</div><h2 style={{ marginTop: 6 }}>Checking your firewall</h2><p className="sub" style={{ marginTop: 6 }}>Reaching Stitch's addresses and looking at how your router handles calls.</p></div>
            )}
          </section>
          <aside className="steps">
            {titles.map((t, i) => {
              const n = i + 1, state = n < p.step ? 'done' : n === p.step ? 'now' : 'wait';
              return (
                <div key={t} className={`step ${state}`}>
                  <span className="dot" aria-hidden="true">{state === 'done' ? <Check size={14} /> : state === 'wait' ? n : null}</span>
                  <div>
                    <b>{t} <em>· {state === 'done' ? 'Done' : state === 'now' ? 'Testing now' : n === p.step + 1 ? 'Up next' : 'Waiting'}</em></b>
                    <span className="t">{state === 'done' ? done[i] : waits[i] || 'Your provider and the nearest Stitch region.'}</span>
                  </div>
                </div>
              );
            })}
            <button className="btn sm" type="button" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={onStop}>Stop the test</button>
          </aside>
        </div>
      </main>
    </div>
  );
}
