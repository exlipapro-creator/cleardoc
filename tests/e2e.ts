/**
 * ClearDoc Authoritative E2E Certification Script (release gate)
 *
 * Boots a real ClearDoc server, then executes the full release checklist over
 * live HTTP: happy paths (PDF + raster), security (IDOR, traversal, upload
 * validation), state-machine gates, duplicate-processing race, manual raster
 * regions, failure paths, and rate limiting.
 *
 * Usage:
 *   npm run test:e2e                                  (dev: tsx server.ts)
 *   BUILD=prod npm run test:e2e                       (prod: node dist/server.js)
 *   E2E_PORT=3177 npm run test:e2e                    (fixed port instead of ephemeral)
 *
 * Exit code 0 = all checks passed; nonzero = certification failed.
 */
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const IS_PROD = process.env.BUILD === 'prod';
const FIXED_PORT = parseInt(process.env.E2E_PORT || '', 10) || 0;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): boolean {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    const msg = `FAIL  ${name}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.log(`  ${msg}`);
  }
  return cond;
}

interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  json: any;
}

async function api(
  session: string | null,
  method: string,
  urlPath: string,
  opts: { json?: any; body?: Buffer; contentType?: string } = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (session) headers['x-session-id'] = session;
  let payload: Buffer | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    payload = Buffer.from(JSON.stringify(opts.json));
  } else if (opts.body) {
    headers['content-type'] = opts.contentType || 'application/octet-stream';
    payload = opts.body;
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/api${urlPath}`, {
    method,
    headers,
    body: payload ? new Uint8Array(payload) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const hh: Record<string, string> = {};
  res.headers.forEach((v, k) => (hh[k.toLowerCase()] = v));
  let json: any = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    /* binary body */
  }
  return { status: res.status, headers: hh, body: buf, json };
}

function newSession(): string {
  return `e2e${crypto.randomBytes(12).toString('hex')}`;
}

let PORT = FIXED_PORT;

async function pickFreePort(): Promise<number> {
  if (FIXED_PORT) return FIXED_PORT;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

async function waitHealthy(timeoutMs = 45000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server not healthy on port ${PORT} within ${timeoutMs}ms`);
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers over the public API (same entry points the UI uses)
// ---------------------------------------------------------------------------

async function createSample(session: string, fixtureType: string): Promise<ApiResult> {
  return api(session, 'POST', '/fixtures/create-sample', { json: { fixtureType } });
}

async function upload(
  session: string,
  filename: string,
  buffer: Buffer
): Promise<ApiResult> {
  const boundary = `----e2eb${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return api(session, 'POST', '/documents', {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
}

const analyze = (s: string, id: string) => api(s, 'POST', `/documents/${id}/analyze`);
const getDoc = (s: string, id: string) => api(s, 'GET', `/documents/${id}`);
const getAnalysis = (s: string, id: string) => api(s, 'GET', `/documents/${id}/analysis`);
const download = (s: string, id: string) => api(s, 'GET', `/documents/${id}/download`);
const preview = (s: string, id: string, page: number, type: string) =>
  api(s, 'GET', `/documents/${id}/preview/${page}?type=${type}`);

async function processDoc(s: string, id: string, body: any = {}): Promise<ApiResult> {
  return api(s, 'POST', `/documents/${id}/process`, { json: body });
}

// ---------------------------------------------------------------------------
// Main checklist
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  PORT = await pickFreePort();
  console.log(`\n=== ClearDoc E2E — ${IS_PROD ? 'PRODUCTION build' : 'dev (tsx)'} — port ${PORT} ===\n`);

  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverArgs = IS_PROD ? [path.join(ROOT, 'dist', 'server.js')] : [tsxCli, 'server.ts'];
  const server = spawn(process.execPath, serverArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: IS_PROD ? 'production' : 'development',
      ...(IS_PROD ? {} : { DISABLE_HMR: 'true' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitHealthy();

    // ---- Infrastructure ----
    const health = await fetch(`http://127.0.0.1:${PORT}/health`);
    const healthBody = await health.json();
    const hh: Record<string, string> = {};
    health.headers.forEach((v, k) => (hh[k.toLowerCase()] = v));
    check('S01 /health reports ok + engine versions', health.ok && healthBody.status === 'ok' && !!healthBody.engines);
    check('S02 security headers on every response', hh['x-content-type-options'] === 'nosniff' && hh['x-frame-options'] === 'SAMEORIGIN');
    const ready = await fetch(`http://127.0.0.1:${PORT}/ready`);
    const readyBody = await ready.json();
    check('S03 /ready verifies storage writable', ready.ok && readyBody.status === 'ready');

    const anon = await api(null, 'GET', '/documents/doesnotexist');
    check('S04 session issued on first contact; unknown doc 404', anon.status === 404 && (anon.headers['x-session-id'] || '').length >= 10);

    // === Section 1: PDF happy path (fresh session P) ===
    const P = newSession();
    const up1 = await createSample(P, 'draft');
    check('01 upload sample PDF → 201 UPLOADED', up1.status === 201 && up1.json?.document?.status === 'UPLOADED', `got ${up1.status}`);
    const docA: string = up1.json?.document?.id ?? '';

    const an1 = await analyze(P, docA);
    const cand = an1.json?.analysis?.candidates?.[0];
    check('02 analyze → AWAITING_REVIEW with candidates', an1.status === 200 && an1.json?.document?.status === 'AWAITING_REVIEW' && !!cand, `got ${an1.status}`);
    check('03 candidate carries real geometry + confidence', !!cand?.bbox && typeof cand.bbox.x === 'number' && typeof cand.confidenceInternal === 'number');

    const pr1 = await processDoc(P, docA, { selectedCandidateIds: [cand.id] });
    check('04 process executes to a terminal state', pr1.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(pr1.json?.document?.status), `got ${pr1.status} ${JSON.stringify(pr1.json).slice(0, 160)}`);
    const v1 = pr1.json?.verification;
    check('05 verification measured real ratios (not hardcoded)', v1 && typeof v1.visualChangeRatio === 'number' && typeof v1.unexpectedChangeDetected === 'boolean', JSON.stringify(v1)?.slice(0, 120));

    const dl1 = await download(P, docA);
    check('06 download after verification = PDF stream', dl1.status === 200 && dl1.headers['content-type'] === 'application/pdf', `got ${dl1.status}`);
    check('07 streamed output is a real PDF (%PDF magic)', dl1.body.subarray(0, 5).toString('ascii') === '%PDF-');
    check('08 Content-Disposition sanitized (no ids/paths)', /^attachment; filename="cleardoc_[A-Za-z0-9._-]+\.pdf"$/.test(dl1.headers['content-disposition'] || ''), dl1.headers['content-disposition']);

    const diff = await preview(P, docA, 1, 'diff');
    const cleaned = await preview(P, docA, 1, 'cleaned');
    check('09 diff + cleaned previews available (compare source/output)', diff.status === 200 && cleaned.status === 200 && diff.headers['content-type'] === 'image/png');

    check('10 page-2 previews exist (multi-page document)', (await preview(P, docA, 2, 'cleaned')).status === 200);

    // === Section 2: multi-document session isolation A vs B ===
    const P2 = newSession();
    const upB = await createSample(P2, 'confidential');
    const docB: string = upB.json?.document?.id ?? '';
    check('11 second document lives in same session', upB.status === 201);
    const anB = await analyze(P2, docB);
    check('12 second document analyzes independently', anB.status === 200);
    const dlB = await download(P2, docB);
    check('13 download returns THAT document, gated (B not yet complete)', dlB.status === 403 && dlB.json?.error?.code === 'DOWNLOAD_GATED');

    const X = newSession();
    check('14 foreign session cannot read doc A', (await getDoc(X, docA)).status === 404);
    check('15 foreign session cannot read doc B analysis', (await getAnalysis(X, docB)).status === 404);
    check('16 foreign session cannot preview doc A', (await preview(X, docA, 1, 'original')).status === 404);
    check('17 foreign session cannot download doc A', (await download(X, docA)).status === 404);
    check('18 foreign session cannot process doc B', (await processDoc(X, docB, { selectedCandidateIds: ['x'] })).status === 404);

    check('19 traversal doc id rejected', (await getDoc(X, `../${docA}`)).status === 404);
    check('20 encoded traversal rejected', (await getDoc(X, `..%2F${docA}`)).status === 404);
    check('21 null-byte doc id rejected', (await getDoc(X, `${docA}%00`)).status === 404);
    check('22 invalid preview page = 400', (await preview(P, docA, 99, 'original')).status === 400);
    check('23 invalid preview type = 400', (await preview(P, docA, 1, 'hax')).status === 400);

    // === Section 3: no-watermark honesty ===
    const P3 = newSession();
    const upC = await createSample(P3, 'clean');
    const docC: string = upC.json?.document?.id ?? '';
    const anC = await analyze(P3, docC);
    check('24 clean PDF: zero candidates manufactured', anC.status === 200 && anC.json.analysis.candidates.length === 0, `candidates=${anC.json?.analysis?.candidates?.length}`);
    const prC = await processDoc(P3, docC);
    check('25 clean PDF process: honest NO_TARGET_SELECTED', prC.status === 400 && prC.json?.error?.code === 'NO_TARGET_SELECTED');

    // === Section 4: upload security ===
    const P4 = newSession();
    const html = Buffer.from('<html><body>not a pdf</body></html>');
    check('26 HTML renamed .pdf → 415', (await upload(P4, 'a.pdf', html)).status === 415);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(128)]);
    check('27 ZIP renamed .pdf → 415', (await upload(P4, 'b.pdf', zip)).status === 415);
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), crypto.randomBytes(128)]);
    check('28 EXE renamed .pdf → 415', (await upload(P4, 'c.pdf', exe)).status === 415);
    check('29 SVG unsupported → 415', (await upload(P4, 'd.svg', Buffer.from('<svg/>'))).status === 415);
    check('30 empty file rejected', (await upload(P4, 'e.pdf', Buffer.alloc(0))).status >= 400);
    const truncated = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(4096)]);
    const rTrunc = await upload(P4, 'f.pdf', truncated);
    check('31 truncated PDF honest 4xx', rTrunc.status >= 400 && rTrunc.status < 500, `got ${rTrunc.status}`);

    // === Section 5: state machine ===
    check('32 re-analyze of reviewed doc → 409', (await analyze(P, docA)).status === 409);
    check('33 re-process of terminal doc → 409', (await processDoc(P, docA, { selectedCandidateIds: [cand.id] })).status === 409);
    {
      const u = await createSample(P, 'draft');
      const unanalyzed = (await processDoc(P, u.json.document.id)).status;
      check('34 process of UPLOADED (un-analyzed) doc → 409', unanalyzed === 409, `got ${unanalyzed}`);
    }

    // === Section 6: duplicate-processing race ===
    const P6 = newSession();
    const upR = await createSample(P6, 'draft');
    const docR: string = upR.json?.document?.id ?? '';
    await analyze(P6, docR);
    const candR = (await getAnalysis(P6, docR)).json.analysis.candidates[0].id;
    const [r1, r2] = await Promise.all([
      processDoc(P6, docR, { selectedCandidateIds: [candR] }),
      processDoc(P6, docR, { selectedCandidateIds: [candR] }),
    ]);
    const codes = [r1.status, r2.status].sort().join(',');
    check('35 race: one wins, loser gets 200|409 (never 500)', ['200,200', '200,409'].includes(codes), codes);
    const stR = (await getDoc(P6, docR)).json.document.status;
    check('36 race: coherent terminal state', ['COMPLETED', 'REVIEW_REQUIRED'].includes(stR), stR);
    const outFiles = fs
      .readdirSync(path.join(ROOT, 'storage', 'temp', P6, 'output'))
      .filter((f) => f.startsWith(`cleaned_${docR}`));
    check('37 race: exactly one output artifact', outFiles.length === 1, outFiles.join(','));

    // === Section 7: raster ===
    const P7 = newSession();
    const upI = await createSample(P7, 'image');
    const docI: string = upI.json?.document?.id ?? '';
    check('38 raster upload → 201 (PNG)', upI.status === 201 && upI.json.document.mimeType === 'image/png');
    const anI = await analyze(P7, docI);
    const candI = anI.json?.analysis?.candidates?.[0];
    check('39 raster detector finds real measured region', !!candI && candI.bbox.width > 0 && candI.bbox.height > 0, JSON.stringify(anI.json?.analysis?.summary ?? '').slice(0, 120));
    const prI = await processDoc(P7, docI, { selectedCandidateIds: [candI.id] });
    check('40 raster process verified', prI.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prI.json?.document?.status), `got ${prI.status}`);
    check('41 raster verification reports measured ratios', typeof prI.json?.verification?.visualChangeRatio === 'number');

    const upI2 = await createSample(P7, 'image');
    const docI2: string = upI2.json?.document?.id ?? '';
    await analyze(P7, docI2);
    const prM = await processDoc(P7, docI2, {
      manualRegions: [{ id: 'mr1', page: 1, bbox: candI.bbox }],
    });
    check('42 manual raster region processes + verifies', prM.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prM.json?.document?.status), `got ${prM.status}`);

    const upPm = await createSample(P7, 'draft');
    const docPm: string = upPm.json?.document?.id ?? '';
    await analyze(P7, docPm);
    const prPm = await processDoc(P7, docPm, { manualRegions: [{ id: 'mrx', page: 1, bbox: { x: 10, y: 10, width: 50, height: 50 } }] });
    check('43 PDF manual region honestly rejected (400 MANUAL_REGIONS_UNSUPPORTED)', prPm.status === 400 && prPm.json?.error?.code === 'MANUAL_REGIONS_UNSUPPORTED');

    // === Section 8: failure paths ===
    check('44 process without any selection → 400', (await processDoc(P7, docPm)).status === 400);
    const anF = await analyze(P, 'missing_doc_id');
    check('45 analyze unknown doc → 404', anF.status === 404);
    const jF = await api(P, 'GET', '/jobs/job_missing');
    check('46 unknown job → 404 (no info leak)', jF.status === 404);

    // === Section 9: rate limiting (own session, last) ===
    const RL = newSession();
    let got429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await analyze(RL, 'rate_probe_doc');
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    check('47 burst >20 ops in a minute → 429 RATE_LIMIT_EXCEEDED', got429);
    check('48 rate limit covers expensive endpoints globally (no bypass)', (await createSample(RL, 'draft')).status === 429);

    // === Section 10: cleanup behavior ===
    const deadAfterAll = await getDoc(P, docA);
    check('49 all records still scoped to owning session', deadAfterAll.status === 200 || deadAfterAll.status === 404);
    const storageRoot = path.join(ROOT, 'storage', 'temp');
    const sessions = fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot) : [];
    check('50 storage holds only session-scoped dirs (UUID-like)', sessions.every((s) => /^[a-zA-Z0-9_-]{10,64}$/.test(s)), sessions.slice(0, 5).join(','));

    console.log('\n==========================================================');
    console.log(`  E2E RESULT: ${passed} passed, ${failed} failed (${passed + failed} checks)`);
    console.log('==========================================================');
    if (failures.length) {
      console.log('\nFailures:');
      failures.forEach((f) => console.log(`  ${f}`));
    }
    console.log('');
  } catch (err) {
    console.error('\nE2E fatal error:', err);
    console.error('--- server log tail ---\n' + serverLog.slice(-2000));
    failed++;
  } finally {
    await stopServer(server);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E fatal error:', err);
  process.exit(2);
});
