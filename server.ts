/**
 * ClearDoc Full-Stack Server Entry Point
 * Mounts Express API with Vite middlewares in development.
 */
import express from 'express';
import http from 'http';
import path from 'path';
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

  // Service Health & Version
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'cleardoc-engine',
      version: '1.0.0',
      engines: CONFIG.ENGINE_VERSIONS,
      timestamp: new Date().toISOString(),
    });
  });

  // Start background garbage collection
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
    console.log(`[ClearDoc Server] Listening on http://0.0.0.0:${CONFIG.PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[ClearDoc Startup Error]:', err);
  process.exit(1);
});
