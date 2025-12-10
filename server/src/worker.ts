import 'dotenv/config';
import { startJobWorker } from './jobs/jobWorker';
import { logger } from './logger';

startJobWorker().catch((error) => {
  logger.error('Background worker crashed', error);
  process.exit(1);
});
