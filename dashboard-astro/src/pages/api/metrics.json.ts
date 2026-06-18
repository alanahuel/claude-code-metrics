import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export const prerender = false;

const DATA_FILE = join(homedir(), '.local', 'share', 'claude-metrics', 'metrics.json');
const BIN = join(homedir(), '.local', 'bin', 'claude-metrics');
const STALE_MS = 10 * 60 * 1000;

// Sirve el JSON de métricas que escribe el CLI de Python. Si falta o está
// rancio (>10 min), pide al CLI que lo re-exporte (vuelca la DB; el `ingest`
// periódico lo hace el timer de systemd). 100% local.
export const GET: APIRoute = async () => {
  try {
    let raw = await readFile(DATA_FILE, 'utf8').catch(() => null);
    let stale = !raw;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        stale = Date.now() - Date.parse(j.generated_at) > STALE_MS;
      } catch {
        stale = true;
      }
    }
    if (stale) {
      await pexec(BIN, ['export'], { timeout: 20000 }).catch(() => {});
      raw = await readFile(DATA_FILE, 'utf8');
    }
    return new Response(raw, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'No se pudo leer metrics.json', detail: String(err) }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
};
