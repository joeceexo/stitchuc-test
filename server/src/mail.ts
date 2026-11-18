// "Email me a copy": a short message with the verdict and a link to the result.

import { config } from './config.js';
import type { Result } from './types.js';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function sendCopy(to: string, r: Result): Promise<void> {
  const link = `${config.publicUrl}/r/${r.code}`;
  const fixes = r.fixes.map((f) => `- ${f.title}. ${f.action}`).join('\n');
  const text = [
    `Stitch Network Test, result ${r.code}`, '', r.headline, r.sub, '',
    r.calls != null ? `Calls at once: ${r.calls}` : '', r.score != null ? `Call quality score: ${r.score} of 5` : '',
    fixes ? `\nWhat to fix:\n${fixes}` : '', '', `The full result: ${link}`, '',
    `Need a hand? Call ${config.phone} or write to ${config.supportEmail}.`,
  ].filter((l) => l !== '').join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#1B1918;max-width:560px">
<p style="color:#6A615C;font-size:13px;margin:0 0 8px">Stitch Network Test · ${esc(r.code)}</p>
<h1 style="font-size:24px;margin:0 0 8px">${esc(r.headline)}</h1>
<p style="font-size:16px;margin:0 0 16px">${esc(r.sub)}</p>
${r.calls != null ? `<p style="margin:0 0 4px"><strong>Calls at once:</strong> ${r.calls}</p>` : ''}
${r.score != null ? `<p style="margin:0 0 16px"><strong>Call quality score:</strong> ${r.score} of 5</p>` : ''}
${r.fixes.length ? `<p style="margin:0 0 4px"><strong>What to fix</strong></p><ul style="margin:0 0 16px;padding-left:20px">${r.fixes.map((f) => `<li>${esc(f.title)}. ${esc(f.action)}</li>`).join('')}</ul>` : ''}
<p><a href="${esc(link)}" style="display:inline-block;background:#DD2B0F;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold">Open the full result</a></p>
<p style="color:#6A615C;font-size:13px">Need a hand? Call ${esc(config.phone)} or write to ${esc(config.supportEmail)}.</p></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject: `Your Stitch network test: ${r.headline}`, text, html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`email service answered ${res.status}`);
}
