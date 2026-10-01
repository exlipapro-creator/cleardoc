/**
 * ClearDoc Full-Stack Server Entry Point
 * Mounts Express API with Vite middlewares in development.
 */
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { CONFIG } from './server/config.js';
import { apiRouter } from './server/routes.js';
import { pipelineGate } from './server/pipeline.js';
import { startCleanupWorker, stopCleanupWorker, runCleanupCycle } from './server/cleanup.js';
import { getMetadataBackendKind, db } from './server/db.js';

async function bootstrap() {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json());

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Mount ClearDoc API routes
  app.use('/api', apiRouter);

  // Honest API boundary: unknown /api paths must never fall through to the SPA
  // shell (which would return 200 HTML for API calls).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
  });

  // Liveness: process is up.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'cleardoc-engine',
      version: '1.0.0',
      engines: CONFIG.ENGINE_VERSIONS,
      metadata: getMetadataBackendKind(),
      multiInstance: CONFIG.SHARED_DB_PATH ? true : false,
      // Admission-gate diagnostics (counts only — no secrets, no paths, no
      // user data). Lets external monitoring and operators see whether the
      // processor is saturated without exposing anything sensitive.
      pipeline: pipelineGate.snapshot(),
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness: the service can actually accept and process documents.
  // Verifies the storage root is usable (cheap existence/writability probe).
  app.get('/ready', async (req, res) => {
    try {
      await fs.promises.mkdir(CONFIG.BASE_STORAGE_DIR, { recursive: true });
      await fs.promises.access(CONFIG.BASE_STORAGE_DIR, fs.constants.W_OK);
      res.json({ status: 'ready', storage: 'ok' });
    } catch (err) {
      console.error('[ClearDoc Readiness] Storage unavailable:', err);
      res.status(503).json({ status: 'not_ready', storage: 'unavailable' });
    }
  });

  // Start background garbage collection (incl. startup sweep of orphaned files)
  startCleanupWorker();

  // Development: Vite middlewares
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production: serve static build
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(CONFIG.PORT, '0.0.0.0', () => {
      console.log(`[ClearDoc Server] Listening on http://0.0.0.0:${CONFIG.PORT} (${process.env.NODE_ENV || 'development'})`);
      resolve();
    });
  });

  // Fail fast on infrastructure signals instead of dying mid-request.
  process.on('unhandledRejection', (reason) => {
    console.error('[ClearDoc] Unhandled promise rejection:', reason);
  });

  // Graceful shutdown: Render sends SIGTERM on every redeploy/restart. Stop
  // accepting new work, close idle keep-alive connections, give in-flight
  // requests a bounded window, run one final GC cycle so already-expired temp
  // artifacts do not linger, then release backend resources and exit — never
  // waiting indefinitely. Processing cut off by the deadline is honest:
  // affected documents never report a false COMPLETED (their metadata is
  // ephemeral and vanishes with the process).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ClearDoc Server] ${signal} received — graceful shutdown (deadline ${CONFIG.SHUTDOWN_DEADLINE_MS}ms)...`);

    const forceExit = setTimeout(() => {
      console.error('[ClearDoc Server] Shutdown deadline exceeded — exiting now.');
      process.exit(1);
    }, CONFIG.SHUTDOWN_DEADLINE_MS);
    if (forceExit.unref) forceExit.unref();

    const closeIdle = (server as any).closeIdleConnections;
    if (typeof closeIdle === 'function') closeIdle.call(server);

    server.close(() => {
      console.log('[ClearDoc Server] HTTP server closed.');
      const finish = () => {
        clearTimeout(forceExit);
        process.exit(0);
      };
      try {
        stopCleanupWorker();
        runCleanupCycle()
          .catch(() => undefined)
          .then(() => {
            try {
              db.close?.();
            } catch {
              /* backend already closed */
            }
          })
          .catch(() => undefined)
          .then(finish, finish);
      } catch {
        finish();
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Windows console-event equivalent of SIGTERM (no-op on POSIX). Render
  // sends SIGTERM; local Windows testing delivers CTRL_BREAK_EVENT.
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

bootstrap().catch((err) => {
  console.error('[ClearDoc Startup Error]:', err);
  process.exit(1);
});
