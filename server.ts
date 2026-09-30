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
import { startCleanupWorker } from './server/cleanup.js';

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

  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`[ClearDoc Server] Listening on http://0.0.0.0:${CONFIG.PORT} (${process.env.NODE_ENV || 'development'})`);
  });

  // Fail fast on infrastructure signals instead of dying mid-request.
  process.on('unhandledRejection', (reason) => {
    console.error('[ClearDoc] Unhandled promise rejection:', reason);
  });
}

bootstrap().catch((err) => {
  console.error('[ClearDoc Startup Error]:', err);
  process.exit(1);
});
