import { Router } from 'express';
import subscriptionsRouter from './subscriptions';
import tasksRouter from './tasks';
import reportsRouter from './reports';
import configRouter from './config';

const router = Router();

router.use('/subscriptions', subscriptionsRouter);
router.use('/tasks', tasksRouter);
router.use('/reports', reportsRouter);
router.use('/config', configRouter);

export default router;
