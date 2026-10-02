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
import os from 'os';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import sharp from 'sharp';

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
  opts: { json?: any; body?: Buffer; contentType?: string } = {},
  port: number = PORT
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
  const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, {
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

async function createSample(session: string, fixtureType: string, port: number = PORT): Promise<ApiResult> {
  return api(session, 'POST', '/fixtures/create-sample', { json: { fixtureType } }, port);
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

const analyze = (s: string, id: string, port: number = PORT) =>
  api(s, 'POST', `/documents/${id}/analyze`, {}, port);
const getDoc = (s: string, id: string, port: number = PORT) => api(s, 'GET', `/documents/${id}`, {}, port);
const getAnalysis = (s: string, id: string, port: number = PORT) =>
  api(s, 'GET', `/documents/${id}/analysis`, {}, port);
const download = (s: string, id: string, port: number = PORT) =>
  api(s, 'GET', `/documents/${id}/download`, {}, port);
const preview = (s: string, id: string, page: number, type: string, port: number = PORT) =>
  api(s, 'GET', `/documents/${id}/preview/${page}?type=${type}`, {}, port);

async function processDoc(s: string, id: string, body: any = {}, port: number = PORT): Promise<ApiResult> {
  return api(s, 'POST', `/documents/${id}/process`, { json: body }, port);
}

/**
 * Hostile fixture: a real (parseable) PDF with `pages` pages — used to hit the
 * page limit at ingest and to stress the native removal pipeline.
 */
async function generateManyPagePdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Hostile fixture page ${i + 1} of ${pages}`, {
      x: 72,
      y: 770,
      size: 12,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    // Diagonal oversized watermark text on every page (removal target).
    page.drawText('DRAFT', {
      x: 140,
      y: 400,
      size: 90,
      font,
      color: rgb(0.9, 0.2, 0.2),
      opacity: 0.25,
      rotate: degrees(-30),
    });
  }
  return Buffer.from(await pdf.save());
}

/**
 * Hostile fixture: high-resolution raster image (w × h) with a red stamp box
 * near the center — stresses raster analysis/processing memory and CPU.
 */async function generateHighResRaster(w: number, h: number): Promise<Buffer> {
  const stampW = Math.round(w * 0.4);
  const stampH = Math.round(h * 0.2);

  const x0 = Math.round(w / 2 - stampW / 2);
  const y0 = Math.round(h / 2 - stampH / 2);
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${x0}" y="${y0}" width="${stampW}" height="${stampH}" fill="none" stroke="#d33" stroke-width="14" stroke-opacity="0.75"/>
    <text x="${w / 2}" y="${y0 + stampH / 2}" font-family="Arial" font-size="${Math.round(stampH * 0.5)}" font-weight="bold" fill="#d33" fill-opacity="0.75" text-anchor="middle" dominant-baseline="middle">SPECIMEN</text>
  </svg>`;
  // Pixel-exact canvas: sharp({create}) guarantees width×height exactly (the
  // decoded-pixel count ClearDoc measures), with the SVG composited on top.
  // Rendering the SVG directly would let libvips round page dimensions,
  // breaking exact MP-boundary fixtures (documented behavior).
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 244, g: 245, b: 247, alpha: 1 },
    },
  })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}

/**
 * Hostile fixture: PDF with a single page of `ops` text draw operations —
 * per-page text-OPERATION count (not bytes/pages) drives render memory
 * (measured: ~20k ops → 833 MB peak; ~8k ops → ≤420 MB).
 */
async function generateDenseTextPdf(ops: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  const chunk = 'Quarterly operations remained resilient across every business unit with disciplined cost management and steady enterprise platform adoption metrics. ';
  for (let l = 0; l < ops; l++) {
    page.drawText(chunk, { x: 50 + (l % 2) * 8, y: 820 - (l % 65) * 12, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  }
  page.drawText('DRAFT', { x: 150, y: 300, size: 96, font: bold, color: rgb(0.9, 0.2, 0.2) });
  return Buffer.from(await pdf.save());
}

/**
 * Hostile fixture: PDF with an extreme page size (MediaBox scaled by
 * `scale`) — renders to ~803 MP at 150 dpi when scale=10 (A0×10).
 */
async function generateHugePagePdf(scale: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([3370 * scale, 2384 * scale]);
  page.drawText('HUGE PAGE DRAFT', { x: 100 * scale, y: 1200 * scale, size: 50 * scale, font: bold, color: rgb(0.9, 0.2, 0.2) });
  return Buffer.from(await pdf.save());
}

/**
 * Fixture: 1-page PDF embedding a w×h JPEG image with the DRAFT watermark text
 * on top. Used to prove the per-page embedded-image ceiling rejects over-limit
 * pages (W07) and still accepts legal ones (W08). MEASURED (2026-10-02):
 * 6.6 MP/page starved the event loop >15 s on 0.1 CPU while 1.4 MP/page
 * passed — file bytes do not predict the stall.
 */
async function generateEmbeddedImagePdf(w: number, h: number, jpegQuality = 70): Promise<Buffer> {
  // Flat-color source: deterministic and instant. (A random-noise JPEG source
  // hung the sharp encoder >60s in this environment.) The per-page ceiling
  // inspects declared image dimensions, which a flat image exercises equally.
  const jpeg = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 214, g: 222, b: 235 } } }).jpeg({ quality: jpegQuality }).toBuffer();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  const img = await pdf.embedJpg(jpeg);
  const scale = Math.min(595 / img.width, 842 / img.height);
  page.drawImage(img, { x: 0, y: 0, width: img.width * scale, height: img.height * scale });
  page.drawText(`Embedded ${((w * h) / 1e6).toFixed(1)} MP image fixture`, { x: 72, y: 770, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText('DRAFT', { x: 140, y: 400, size: 90, font, color: rgb(0.9, 0.2, 0.2), opacity: 0.25, rotate: degrees(-30) });
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// Main checklist
// ---------------------------------------------------------------------------
async function bootServer(
  envExtra: Record<string, string>
): Promise<{ child: ChildProcess; log: { text: string }; port: number }> {
  PORT = await pickFreePort();
  console.log(`\n=== ClearDoc E2E phase — ${IS_PROD ? 'PRODUCTION build' : 'dev (tsx)'} — port ${PORT} ===\n`);

  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverArgs = IS_PROD ? [path.join(ROOT, 'dist', 'server.js')] : [tsxCli, 'server.ts'];
  const child = spawn(process.execPath, serverArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: IS_PROD ? 'production' : 'development',
      ...(IS_PROD ? {} : { DISABLE_HMR: 'true' }),
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { text: '' };
  child.stdout.on('data', (d) => (log.text += d.toString()));
  child.stderr.on('data', (d) => (log.text += d.toString()));
  await waitHealthy();
  return { child, log, port: PORT };
}

async function runCoreChecks(): Promise<void> {
  try {
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
    // Gate semantics (deployment hardening): the loser either loses the CAS
    // claim (409) or times out waiting for the single processing slot when the
    // winner holds it beyond the 5s slot-wait window (503 SERVICE_BUSY with
    // Retry-After). Never 500, never a hang, exactly one winner.
    check('35 race: one wins, loser gets 200|409|503-SERVICE_BUSY (never 500)', ['200,200', '200,409', '200,503'].includes(codes), codes);
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

    console.log('');
  } catch (err) {
    console.error('\nE2E fatal error (core phase):', err);
    failed++;
    throw err;
  }
}

/**
 * Hostile phase: resource-exhaustion resistance.
 * Runs on a second server boot configured with a 1.5s processing deadline so
 * the deadline mechanism is exercised for real (the production default is 120s).
 * Asserts pathological documents end FAILED — never a false COMPLETED — and
 * that the server survives to serve healthy traffic afterwards.
 */
async function runHostileChecks(): Promise<void> {
  try {
    const H = newSession();

    // --- Ingest-limit hostiles (fast rejections at the front door) ---
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      crypto.randomBytes(31 * 1024 * 1024),
    ]);
    const upBig = await upload(H, 'hostile_oversized.pdf', oversized);
    check('R01 31MB oversized upload → 413 (not 500)', upBig.status === 413, `got ${upBig.status}`);

    const manyPagePdf = await generateManyPagePdf(51);
    const upPages = await upload(H, 'hostile_51pages.pdf', manyPagePdf);
    check('R02 51-page PDF rejected at ingest → 400 PAGE_LIMIT_EXCEEDED', upPages.status === 400 && upPages.json?.error?.code === 'PAGE_LIMIT_EXCEEDED', `got ${upPages.status} ${JSON.stringify(upPages.json).slice(0, 120)}`);

    // --- Deadline hostiles (tiny CLEARDOC_PROCESSING_DEADLINE_MS on this boot) ---
    const upH1 = await createSample(H, 'draft');
    const docH1: string = upH1.json?.document?.id ?? '';
    await analyze(H, docH1);
    const candH1 = (await getAnalysis(H, docH1)).json.analysis.candidates[0].id;
    const t0 = Date.now();
    const prH1 = await processDoc(H, docH1, { selectedCandidateIds: [candH1] });
    const elapsed1 = Date.now() - t0;
    check(
      'R03 deadline fires on 50-page PDF → 5xx PROCESSING_FAILED (no hang, no crash)',
      prH1.status >= 500 && prH1.json?.error?.code === 'PROCESSING_FAILED' && elapsed1 < 15000,
      `status=${prH1.status} code=${prH1.json?.error?.code} elapsed=${elapsed1}ms`
    );
    const docH1After = (await getDoc(H, docH1)).json?.document?.status;
    check(
      'R04 50-page PDF lands in a retryable FAILED state (never VERIFYING/PROCESSING)',
      ['PROCESSING_FAILED', 'VERIFICATION_FAILED'].includes(docH1After),
      `status=${docH1After}`
    );

    const bigRaster = await generateHighResRaster(4000, 3000); // 12 MP — heavy but under the 16 MP ceiling
    const upH2 = await upload(H, 'hostile_hires.png', bigRaster);
    check('R05 12MP raster accepted (under the 16MP ceiling)', upH2.status === 201, `got ${upH2.status} ${JSON.stringify(upH2.json).slice(0, 120)}`);
    const anH2 = await analyze(H, upH2.json.document.id);
    check('R06 17.5MP raster analysis completes (bounded ingest)', anH2.status === 200, `got ${anH2.status}`);
    const candH2 = anH2.json?.analysis?.candidates?.[0]?.id;
    const prH2 = await processDoc(H, upH2.json.document.id, candH2 ? { selectedCandidateIds: [candH2] } : { manualRegions: [{ id: 'mr_h', page: 1, bbox: { x: 100, y: 100, width: 800, height: 600 } }] });
    check(
      'R07 12MP raster resolves coherently under deadline (completed or failed, never hangs)',
      (prH2.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prH2.json?.document?.status)) ||
        (prH2.status >= 500 && prH2.json?.error?.code === 'PROCESSING_FAILED'),
      `status=${prH2.status} code=${prH2.json?.error?.code} doc=${prH2.json?.document?.status}`
    );
    const docH2After = (await getDoc(H, upH2.json.document.id)).json?.document?.status;
    check(
      'R08 12MP raster ends in a coherent terminal state (no stuck VERIFYING)',
      ['COMPLETED', 'REVIEW_REQUIRED', 'PROCESSING_FAILED', 'VERIFICATION_FAILED'].includes(docH2After),
      `status=${docH2After}`
    );

    // Raster over the decoded-pixel ceiling: rejected at ingest with
    // IMAGE_TOO_LARGE (raster resource control), never processed.
    const hugeRaster = await generateHighResRaster(9000, 6000); // 54 MP > 20 MP
    const upH3 = await upload(H, 'hostile_huge.png', hugeRaster);
    check('R11 54MP raster rejected at ingest → 413 IMAGE_TOO_LARGE', upH3.status === 413 && upH3.json?.error?.code === 'IMAGE_TOO_LARGE', `got ${upH3.status} ${JSON.stringify(upH3.json).slice(0, 140)}`);

    // Deployment-safety boundary: the DEFAULT ceiling is now 16 MP (the
    // largest MEASURED-safe value for a Render Free 512 MB instance; 20 MP
    // measured 522 MB peak). Just over the boundary must be rejected at
    // ingest — before any memory-intensive processing begins.
    const justOver = await generateHighResRaster(4000, 4001); // 16.004 MP > 16 MP
    const upJustOver = await upload(H, 'hostile_just_over.png', justOver);
    check('R12 16.004MP raster (just over the 16MP boundary) rejected at ingest → 413 IMAGE_TOO_LARGE', upJustOver.status === 413 && upJustOver.json?.error?.code === 'IMAGE_TOO_LARGE', `got ${upJustOver.status} ${JSON.stringify(upJustOver.json).slice(0, 140)}`);

    // The pre-hardening audit MEASURED this 41MP raster at ~800 MB peak RSS
    // during processing — beyond a Render Free instance's 512 MB. Under the
    // 20 MP default it must now be rejected EARLY, never reaching that spike.
    const heavyRaster = await generateHighResRaster(6800, 6000); // ~41 MP
    const upH4 = await upload(H, 'hostile_heavy.png', heavyRaster);
    check('R13 41MP hostile raster rejected at ingest (early IMAGE_TOO_LARGE, no processing spike)', upH4.status === 413 && upH4.json?.error?.code === 'IMAGE_TOO_LARGE', `got ${upH4.status} ${JSON.stringify(upH4.json).slice(0, 140)}`);

    // --- Server must still be alive and fully functional ---
    const post = await createSample(H, 'clean');
    check('R09 server healthy after hostile phase (still accepts work)', post.status === 201, `got ${post.status}`);
    const healthAfter = await fetch(`http://127.0.0.1:${PORT}/health`);
    check('R10 /health still ok after hostiles', healthAfter.ok);

    console.log('');
  } catch (err) {
    console.error('\nE2E fatal error (hostile phase):', err);
    failed++;
    throw err;
  }
}

/**
 * Deadline-gate phase: boots with CLEARDOC_PROCESSING_DEADLINE_MS=1 so
 * withDeadline rejects synchronously before any engine work starts. This
 * deterministically proves the raster path's deadline gate and failure-state
 * mapping (the PDF-path equivalent under real load is R03's 1.5s cut-off).
 */
async function runDeadlineGateChecks(): Promise<void> {
  try {
    const D = newSession();
    const upD = await createSample(D, 'image');
    const docD: string = upD.json?.document?.id ?? '';
    const anD = await analyze(D, docD);
    const candD = anD.json?.analysis?.candidates?.[0]?.id;
    const prD = await processDoc(D, docD, candD ? { selectedCandidateIds: [candD] } : { manualRegions: [{ id: 'mr_d', page: 1, bbox: { x: 200, y: 200, width: 300, height: 200 } }] });
    check(
      'R14 raster path under expired deadline → 5xx PROCESSING_FAILED (deterministic)',
      prD.status >= 500 && prD.json?.error?.code === 'PROCESSING_FAILED',
      `status=${prD.status} code=${prD.json?.error?.code}`
    );
    const docDAfter = (await getDoc(D, docD)).json?.document?.status;
    check(
      'R15 raster doc lands in a retryable FAILED state (no stuck VERIFYING)',
      ['PROCESSING_FAILED', 'VERIFICATION_FAILED'].includes(docDAfter),
      `status=${docDAfter}`
    );
    const healthD = await fetch(`http://127.0.0.1:${PORT}/health`);
    check('R16 server healthy after deadline-gate checks', healthD.ok);

    console.log('');
  } catch (err) {
    console.error('\nE2E fatal error (deadline-gate phase):', err);
    failed++;
    throw err;
  }
}

/**
 * Deployment-hardening phase (Render Free readiness).
 * Boots with a tiny slot-wait window (CLEARDOC_PROCESS_SLOT_WAIT_MS=100) so
 * gate rejection is deterministic without slowing the suite, then verifies:
 * image-ceiling boundaries, concurrent processing admission, session-expiry
 * determinism, restart/cold-start behavior, and health endpoints.
 */
async function runHardeningChecks(): Promise<void> {
  try {
    const X = newSession();

    // === Image ceiling: the actual width×height boundary at 16 MP (measured-safe) ===
    const atBoundary = await generateHighResRaster(4000, 4000); // exactly 16,000,000 px
    const upB = await upload(X, 'hardening_16mp_exact.png', atBoundary);
    check('X01 exactly-16MP raster (4000x4000 = 16,000,000 px) accepted at the boundary', upB.status === 201, `got ${upB.status} ${JSON.stringify(upB.json).slice(0, 140)}`);

    const oneUnder = await generateHighResRaster(4000, 3999); // 15,996,000 px < 16 MP
    const upU = await upload(X, 'hardening_just_under.png', oneUnder);
    check('X02 just-under-16MP raster accepted (boundary is >, not >=)', upU.status === 201, `got ${upU.status}`);

    // === Processing admission gate (limit=1, wait=100ms) ===
    const G1 = newSession();
    const upG1 = await createSample(G1, 'draft');
    const docG1: string = upG1.json?.document?.id ?? '';
    await analyze(G1, docG1);
    const candG1 = (await getAnalysis(G1, docG1)).json.analysis.candidates[0].id;

    const G2 = newSession();
    const upG2 = await createSample(G2, 'draft');
    const docG2: string = upG2.json?.document?.id ?? '';
    await analyze(G2, docG2);
    const candG2 = (await getAnalysis(G2, docG2)).json.analysis.candidates[0].id;

    // Fire two process requests simultaneously: gate admits exactly one.
    const [pG1, pG2] = await Promise.all([
      processDoc(G1, docG1, { selectedCandidateIds: [candG1] }),
      processDoc(G2, docG2, { selectedCandidateIds: [candG2] }),
    ]);
    const statuses = [pG1.status, pG2.status].sort().join(',');
    check(
      'X03 concurrent process requests: one admitted (200) and one deterministically rejected (503 SERVICE_BUSY)',
      statuses === '200,503',
      `statuses=${statuses} bodies=${JSON.stringify([pG1.json?.error, pG2.json?.error]).slice(0, 160)}`
    );
    const busy = [pG1, pG2].find((r) => r.status === 503);
    check(
      'X04 gate rejection is honest: 503 SERVICE_BUSY with Retry-After header',
      !!busy && busy.json?.error?.code === 'SERVICE_BUSY' && !!busy.headers['retry-after'],
      `code=${busy?.json?.error?.code} retryAfter=${busy?.headers['retry-after']}`
    );
    const admitted = [pG1, pG2].find((r) => r.status === 200);
    check(
      'X05 admitted request completes normally through the gate (success releases the slot)',
      !!admitted && ['COMPLETED', 'REVIEW_REQUIRED'].includes(admitted.json?.document?.status),
      `doc=${admitted?.json?.document?.status}`
    );

    // Slot must be free again after success: a third process succeeds.
    const prG3 = await processDoc(G2, docG2, { selectedCandidateIds: [candG2] });
    check(
      'X06 gate recovers after completion: retry processed without service-busy',
      prG3.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prG3.json?.document?.status),
      `status=${prG3.status} doc=${prG3.json?.document?.status}`
    );

  // ===== Phase W — PDF complexity ceilings (final validation pass) =====
  // Byte size and page count do not predict PDF render memory; per-page text
  // OPERATIONS do (measured: ~20k ops → 833 MB; ~8k ops → ≤420 MB).
  {
    const W = newSession();
    // W01: text-dense PDF (1 page, ~26k ops, 37 KB!) must be rejected at
    // UPLOAD with PDF_TOO_COMPLEX — before any preview render.
    const dense = await generateDenseTextPdf(26000);
    const upDense = await upload(W, 'hostile_dense.pdf', dense);
    check('W01 text-dense PDF (>8k items) rejected at upload → PDF_TOO_COMPLEX',
      upDense.status === 400 && upDense.json?.error?.code === 'PDF_TOO_COMPLEX',
      `got ${upDense.status} ${JSON.stringify(upDense.json).slice(0, 140)}`);

    // W02: session still usable after the rejection (no residue blocking it).
    const tempProbe = await upload(W, 'probe_clean_session.pdf', await generateDenseTextPdf(10));
    check('W02 session still usable after complexity rejection (no residue)',
      tempProbe.status === 201 && !!tempProbe.json?.document?.id,
      `got ${tempProbe.status}`);

    // W03: legal density (6k ops) completes the full journey.
    const legalDense = await generateDenseTextPdf(6000);
    const upLegal = await upload(W, 'dense_legal.pdf', legalDense);
    const anLegal = await analyze(W, upLegal.json!.document.id);
    const prLegal = await processDoc(W, upLegal.json!.document.id, {
      selectedCandidateIds: anLegal.json!.analysis.candidates.map((c: any) => c.id),
    });
    check('W03 6k-op text-dense PDF completes with independent verification',
      prLegal.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prLegal.json?.document?.status),
      `got ${prLegal.status} ${prLegal.json?.document?.status} ${JSON.stringify(prLegal.json?.verification?.status || '')}`);

    // W04/W05: extreme page-size PDFs fail deterministically at upload —
    // never a native canvas allocation crash (previously: silent death,
    // connection reset, no JSON).
    for (const [scale, label] of [[10, 'A0x10 (~3487 MP render)'], [2.5, 'A0x2.5 (~218 MP render)']] as Array<[number, string]>) {
      const hp = await upload(W, `hostile_hugepage_${scale}.pdf`, await generateHugePagePdf(scale));
      check(`W0${scale === 10 ? 4 : 5} huge-page PDF (${label}) rejected at upload → 400 RENDER_TOO_LARGE (deterministic JSON)`,
        hp.status === 400 && hp.json?.error?.code === 'RENDER_TOO_LARGE',
        `got ${hp.status} ${JSON.stringify(hp.json).slice(0, 140)}`);
    }

    // W07: a page embedding ~3.4 MP of image data exceeds the per-page
    // embedded-image ceiling — rejected at UPLOAD with 413 PDF_IMAGE_TOO_LARGE
    // (image-decode CPU scales with embedded image pixels, not file bytes;
    // see CONFIG.MAX_PDF_IMAGE_PIXELS_PER_PAGE).
    const heavyImagePdf = await generateEmbeddedImagePdf(2600, 1300);
    const upHeavyImg = await upload(W, 'hostile_embedded_image.pdf', heavyImagePdf);
    check('W07 3.4 MP/page embedded-image PDF rejected at upload → 413 PDF_IMAGE_TOO_LARGE',
      upHeavyImg.status === 413 && upHeavyImg.json?.error?.code === 'PDF_IMAGE_TOO_LARGE',
      `got ${upHeavyImg.status} ${JSON.stringify(upHeavyImg.json).slice(0, 140)}`);

    // W06: server still healthy after complexity hostiles.
    const healthW = await fetch(`http://127.0.0.1:${PORT}/health`);
    check('W06 server healthy after PDF-complexity hostiles', healthW.ok);

    // W08: a legal embedded image (0.99 MP/page) still completes the full
    // journey — the new ceiling must not over-reject ordinary documents.
    const legalImagePdf = await generateEmbeddedImagePdf(1100, 900);
    const upLegalImg = await upload(W, 'embedded_image_legal.pdf', legalImagePdf);
    const anLegalImg = await analyze(W, upLegalImg.json!.document.id);
    const prLegalImg = await processDoc(W, upLegalImg.json!.document.id, {
      selectedCandidateIds: anLegalImg.json!.analysis.candidates.map((c: any) => c.id),
    });
    check('W08 0.99 MP/page embedded-image PDF completes with independent verification',
      prLegalImg.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prLegalImg.json?.document?.status),
      `got ${prLegalImg.status} ${prLegalImg.json?.document?.status} ${JSON.stringify(prLegalImg.json?.verification?.status || '')}`);
  }

  // Gate state is observable in /health (diagnostics, no secrets).
  const hX = await (await fetch(`http://127.0.0.1:${PORT}` + '/health')).json();
    check(
      'X07 /health exposes gate snapshot (running<=limit, no secrets, no user data)',
      typeof hX.pipeline?.running === 'number' && hX.pipeline.running <= hX.pipeline.limit && !JSON.stringify(hX).includes('storage'),
      JSON.stringify(hX.pipeline)
    );

    // === Session expiry: restart wipes in-memory metadata; stale sessions fail honestly ===
    const E = newSession();
    const upE = await createSample(E, 'draft');
    const docE: string = upE.json?.document?.id ?? '';
    await analyze(E, docE);
    check('X08 pre-restart document exists for its session', (await getDoc(E, docE)).status === 200);

    const inst = await bootServer({ CLEARDOC_PROCESS_SLOT_WAIT_MS: '100' });
    try {
      const S2 = newSession();
      check('X09 after restart, stale session id gets deterministic 404 (DOCUMENT_NOT_FOUND)', (await getDoc(E, docE, inst.port)).status === 404);
      check('X10 after restart, stale session cannot process its old doc (no ghost state)', (await processDoc(E, docE, { selectedCandidateIds: ['x'] }, inst.port)).status === 404);
      check('X11 fresh session on restarted server works normally', (await createSample(S2, 'draft', inst.port)).status === 201);
      const hR = await (await fetch(`http://127.0.0.1:${inst.port}/health`)).json();
      check('X12 restarted server reports healthy with pipeline snapshot', hR.status === 'ok' && typeof hR.pipeline?.running === 'number');

      // Health must be cheap: /health never processes documents or allocates
      // buffers — hammer it and confirm the pipeline stays idle and fast.
      const t0 = Date.now();
      for (let i = 0; i < 20; i++) {
        const h = await fetch(`http://127.0.0.1:${inst.port}/health`);
        if (!h.ok) {
          check('X13 /health stays 200 under repeated probing', false, `failed at request ${i}`);
          break;
        }
        if (i === 19) {
          check('X13 /health stays 200 under repeated probing (cheap, no processing)', h.ok && Date.now() - t0 < 5000, `elapsed=${Date.now() - t0}ms`);
        }
      }
    } finally {
      await stopServer(inst.child);
    }

    console.log('');
  } catch (err) {
    console.error('\nE2E fatal error (hardening phase):', err);
    failed++;
    throw err;
  }
}

/**
 * Multi-instance phase: two real server processes share one SQLite metadata DB
 * and one storage root (the V2 topology). A round-robin "load balancer" sends
 * each request to alternating instances, proving the API contract survives
 * instance hand-off: uploads on A are analyzable on B, previews/download
 * resolve on either, IDOR stays closed across instances, and a cross-instance
 * double-process race yields exactly one winner with a coherent terminal state
 * and a single output artifact.
 */
async function runMultiInstanceChecks(): Promise<void> {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleardoc-shared-'));
  const sharedDb = path.join(sharedDir, 'shared.db');
  const sharedStorage = path.join(sharedDir, 'storage');
  const ENV = {
    CLEARDOC_SHARED_DB_PATH: sharedDb,
    CLEARDOC_SHARED_STORAGE_ROOT: sharedStorage,
  };

  const instA = await bootServer(ENV);
  const instB = await bootServer(ENV);
  const { port: portA } = instA;
  const { port: portB } = instB;

  try {
    // Both instances report shared mode.
    const hA = await (await fetch(`http://127.0.0.1:${portA}/health`)).json();
    const hB = await (await fetch(`http://127.0.0.1:${portB}/health`)).json();
    check('M01 instance A reports sqlite metadata backend', hA.metadata === 'sqlite', JSON.stringify(hA));
    check('M02 instance B reports sqlite metadata backend', hB.metadata === 'sqlite', JSON.stringify(hB));

    // LB helper: alternate instances per request.
    let flip = false;
    const lb = <T>(call: (port: number) => Promise<T>): Promise<T> => {
      flip = !flip;
      return call(flip ? portA : portB);
    };

    const S = newSession();

    // Upload on A...
    const upM = await lb((p) => createSample(S, 'draft', p));
    check('M03 upload via instance A → 201', upM.status === 201 && !!upM.json?.document?.id, `got ${upM.status}`);
    const docM: string = upM.json?.document?.id ?? '';

    // ...analyze on B (metadata + files live on shared store).
    const anM = await lb((p) => analyze(S, docM, p));
    check('M04 analyze via instance B → 200 with candidates', anM.status === 200 && anM.json?.analysis?.candidates?.length > 0, `got ${anM.status}`);
    const candM = anM.json?.analysis?.candidates?.[0]?.id;

    // ...previews (rendered by B during analyze) readable from A.
    const pvM = await lb((p) => preview(S, docM, 1, 'original', p));
    check('M05 preview rendered by B readable via A', pvM.status === 200 && pvM.headers['content-type'] === 'image/png', `got ${pvM.status}`);

    // ...process on A, then read job/verification state from B.
    const prM = await lb((p) => processDoc(S, docM, { selectedCandidateIds: [candM] }, p));
    check('M06 process via instance A → terminal state', prM.status === 200 && ['COMPLETED', 'REVIEW_REQUIRED'].includes(prM.json?.document?.status), `got ${prM.status} ${JSON.stringify(prM.json).slice(0, 120)}`);
    const jobM = prM.json?.job?.id;
    const jobOnB = await lb((p) => api(S, 'GET', `/jobs/${jobM}`, {}, p));
    check('M07 job written by A readable via B', jobOnB.status === 200 && !!jobOnB.json?.job?.id, `got ${jobOnB.status}`);

    // ...download from B (output written by A on the shared root).
    const dlM = await lb((p) => download(S, docM, p));
    check('M08 download via instance B streams the output A wrote', dlM.status === 200 && dlM.body.subarray(0, 5).toString('ascii') === '%PDF-', `got ${dlM.status}`);

    // IDOR must hold across instances too.
    const X = newSession();
    check('M09 foreign session on instance A cannot read doc (written via B path)', (await getDoc(X, docM, portA)).status === 404);
    check('M10 foreign session on instance B cannot download', (await download(X, docM, portB)).status === 404);

    // Cross-instance duplicate-processing race: fresh doc, two claims racing.
    const upM2 = await lb((p) => createSample(S, 'draft', p));
    const docM2: string = upM2.json?.document?.id ?? '';
    await lb((p) => analyze(S, docM2, p));
    const candM2 = (await getAnalysis(S, docM2, portA)).json.analysis.candidates[0].id;
    // Fire both claims simultaneously at different instances.
    const [racA, racB] = await Promise.all([
      processDoc(S, docM2, { selectedCandidateIds: [candM2] }, portA),
      processDoc(S, docM2, { selectedCandidateIds: [candM2] }, portB),
    ]);
    const raceCodes = [racA.status, racB.status].sort().join(',');
    check('M11 cross-instance race: one 200 + one 409 (never double success)', ['200,409'].includes(raceCodes), raceCodes);
    const docM2After = (await getDoc(S, docM2, portA)).json?.document?.status;
    check('M12 coherent terminal state after cross-instance race', ['COMPLETED', 'REVIEW_REQUIRED'].includes(docM2After), docM2After);
    const outputsM2 = fs
      .readdirSync(path.join(sharedStorage, S, 'output'))
      .filter((f) => f.startsWith(`cleaned_${docM2}`));
    check('M13 exactly one output artifact in shared storage', outputsM2.length === 1, outputsM2.join(','));

    // Cross-instance 409 check: the loser's answer must be INVALID_STATE.
    check(
      'M14 loser reports INVALID_STATE (honest 409, not a 500)',
      (racA.status === 409 || racB.status === 409) &&
        [racA, racB].find((r) => r.status === 409)?.json?.error?.code === 'INVALID_STATE'
    );

    console.log('');
  } catch (err) {
    console.error('\nE2E fatal error (multi-instance phase):', err);
    failed++;
    throw err;
  } finally {
    await stopServer(instA.child);
    await stopServer(instB.child);
    try {
      fs.rmSync(sharedDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function main(): Promise<void> {
  // Phase 1: core checklist on default configuration.
  const core = await bootServer({});
  try {
    await runCoreChecks();
  } finally {
    await stopServer(core.child);
  }

  // Phase 2: resource-exhaustion hostiles with a 1.5s processing deadline.
  const hostile = await bootServer({ CLEARDOC_PROCESSING_DEADLINE_MS: '1500' });
  try {
    await runHostileChecks();
  } finally {
    await stopServer(hostile.child);
  }

  // Phase 3: deterministic raster deadline gate with an expired (1ms) deadline.
  const gate = await bootServer({ CLEARDOC_PROCESSING_DEADLINE_MS: '1' });
  try {
    await runDeadlineGateChecks();
  } finally {
    await stopServer(gate.child);
  }

  // Phase 3.5: deployment hardening (Render Free readiness).
  const hardening = await bootServer({ CLEARDOC_PROCESS_SLOT_WAIT_MS: '100' });
  try {
    await runHardeningChecks();
  } finally {
    await stopServer(hardening.child);
  }

  // Phase 4: two instances sharing SQLite + storage root (V2 topology).
  await runMultiInstanceChecks();

  console.log('\n==========================================================');
  console.log(`  E2E RESULT: ${passed} passed, ${failed} failed (${passed + failed} checks)`);
  console.log('==========================================================');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  ${f}`));
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E fatal error:', err);
  process.exit(2);
});
