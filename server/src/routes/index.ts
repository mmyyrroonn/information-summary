import { Router } from 'express';
import subscriptionsRouter from './subscriptions';
import tasksRouter from './tasks';
import reportsRouter from './reports';
import configRouter from './config';
import tweetsRouter from './tweets';
import devRouter from './tasksDev';

const router = Router();

router.use('/subscriptions', subscriptionsRouter);
router.use('/tasks', tasksRouter);
router.use('/reports', reportsRouter);
router.use('/config', configRouter);
router.use('/tweets', tweetsRouter);
router.use('/dev', devRouter);

export default router;
