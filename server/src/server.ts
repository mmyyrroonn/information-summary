import express from 'express';
import cors from 'cors';
import routes from './routes';
import { logger } from './logger';
import { AiLockUnavailableError } from './errors';

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api', routes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AiLockUnavailableError) {
      logger.warn('AI lock conflict', { message: err.message });
      res.status(409).json({ message: 'AI 分析正在进行，请稍后重试' });
      return;
    }
    logger.error('Unhandled error', err);
    const message = err instanceof Error ? err.message : 'Internal error';
    res.status(500).json({ message });
  });

  return app;
}
