import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const pexec = promisify(execFile);
export const prerender = false;

const BIN = join(homedir(), '.local', 'bin', 'claude-metrics');

// Mapea el rango de la web a los flags del CLI.
const RANGE_DAYS: Record<string, string> = { '24h': '1', '7d': '7', '30d': '30', '90d': '90' };
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Genera el informe PDF llamando al CLI (`claude-metrics report`), que usa un
// navegador headless local. Respeta el rango/proyecto seleccionados en la web
// vía query (?range=7d&project=foo). Devuelve el PDF como descarga. 100% local.
export const GET: APIRoute = async ({ url }) => {
  const out = join(tmpdir(), `claude-metrics-${Date.now()}.pdf`);
  const sp = url.searchParams;
  const args = ['report', out];
  const range = sp.get('range');
  const from = sp.get('from');
  const to = sp.get('to');
  if (isDate(from)) { args.push('--from', from); if (isDate(to)) args.push('--to', to); }
  else if (range === 'all') args.push('--all');
  else if (range && RANGE_DAYS[range]) args.push('--days', RANGE_DAYS[range]);
  else if (sp.get('days')) args.push('--days', String(parseInt(sp.get('days')!, 10) || 30));
  const project = sp.get('project');
  if (project) args.push('--project', project);
  try {
    await pexec(BIN, args, { timeout: 120000 });
    const buf = await readFile(out);
    unlink(out).catch(() => {});
    const today = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="claude-metrics-${today}.pdf"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'No se pudo generar el PDF', detail: String(err) }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
};
