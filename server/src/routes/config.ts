import { Router, Response } from 'express';
import { z } from 'zod';
import { getNotificationConfig, updateNotificationConfig } from '../services/notificationService';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

router.use(authMiddleware);

router.get('/notification', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user?.userId;
    const config = await getNotificationConfig(userId);
    res.json(config);
  } catch (error) {
    next(error);
  }
});

router.put('/notification', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user?.userId;
    const body = z
      .object({
        tgBotToken: z.string().optional().nullable(),
        tgChatId: z.string().optional().nullable(),
        tgMessageThreadId: z.string().optional().nullable(),
        tgHighScoreMessageThreadId: z.string().optional().nullable()
      })
      .parse(req.body ?? {});
    const updated = await updateNotificationConfig({
      tgBotToken: body.tgBotToken ?? null,
      tgChatId: body.tgChatId ?? null,
      tgMessageThreadId: body.tgMessageThreadId ?? null,
      tgHighScoreMessageThreadId: body.tgHighScoreMessageThreadId ?? null
    }, userId);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

export default router;
