import { useEffect, useRef, useState } from 'react';
import type { Result } from '../../server/src/types';
import { getConfig, type SiteConfig } from './api';
import { ResultPage } from './ResultPage';
import { Running } from './Running';
import { runTest, type Progress } from './runner';
import { Staff } from './Staff';
import { Start } from './Start';
import { go } from './ui';

function route(path: string) {
  const t = /^\/t\/([^/]+)\/?$/.exec(path);
  if (t) return { page: 'start' as const, link: decodeURIComponent(t[1]!) };
  const r = /^\/r\/([^/]+)\/?$/.exec(path);
  if (r) return { page: 'result' as const, code: decodeURIComponent(r[1]!).toUpperCase() };
  if (/^\/staff\/?$/.test(path)) return { page: 'staff' as const };
  return { page: 'start' as const, link: null };
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [fresh, setFresh] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState('/');
  const stopper = useRef<AbortController | null>(null);
  const r = route(path);
  const link = r.page === 'start' ? r.link : null;

  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  useEffect(() => {
    if (r.page === 'start') { getConfig(link ?? undefined).then(setCfg).catch(() => setError('We could not reach the test server. Check that you are online and reload.')); }
    else if (!cfg) { getConfig().then(setCfg).catch(() => {}); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.page, link]);
  useEffect(() => { if (r.page === 'start') document.title = 'Stitch Network Test'; }, [r.page]);

  const start = async () => {
    if (!cfg) return;
    setError(null);
    let audio: AudioContext | null = null;
    try { audio = new AudioContext(); } catch { /* the call makes its own */ }
    const c = new AbortController();
    stopper.current = c;
    setAgain(link ? `/t/${link}` : '/');
    try {
      const result = await runTest(cfg, link, audio, c.signal, setProgress);
      setFresh(result);
      go(`/r/${result.code}`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message || 'The test stopped unexpectedly. Please try again.');
    } finally {
      setProgress(null);
      stopper.current = null;
      void audio?.close().catch(() => {});
    }
  };

  if (r.page === 'staff') return <Staff cfg={cfg} />;
  if (r.page === 'result') return <ResultPage cfg={cfg} code={r.code} fresh={fresh} again={again} />;
  if (progress) return <Running cfg={cfg} p={progress} onStop={() => stopper.current?.abort()} />;
  return <Start cfg={cfg} error={error} onStart={start} />;
}
