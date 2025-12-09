import 'dotenv/config';
import { config } from './config';
import { createServer } from './server';
import { logger } from './logger';
import { startScheduler } from './jobs/scheduler';

async function bootstrap() {
  const app = createServer();
  const port = config.PORT;
  app.listen(port, () => {
    logger.info(`API server listening on port ${port}`);
  });

  startScheduler();
}

bootstrap().catch((error) => {
  logger.error('Failed to bootstrap application', error);
  process.exit(1);
});
