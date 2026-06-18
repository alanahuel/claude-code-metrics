import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const pexec = promisify(execFile);
export const prerender = false;

const BIN = join(homedir(), '.local', 'bin', 'claude-metrics');

// Genera el informe PDF llamando al CLI (`claude-metrics report`), que usa un
// navegador headless local. Devuelve el PDF como descarga. 100% local.
export const GET: APIRoute = async () => {
  const out = join(tmpdir(), `claude-metrics-${Date.now()}.pdf`);
  try {
    await pexec(BIN, ['report', out], { timeout: 120000 });
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
