import { Router } from 'express';
import { z } from 'zod';
import { getNotificationConfig, updateNotificationConfig } from '../services/notificationService';

const router = Router();

router.get('/notification', async (_req, res, next) => {
  try {
    const config = await getNotificationConfig();
    res.json(config);
  } catch (error) {
    next(error);
  }
});

router.put('/notification', async (req, res, next) => {
  try {
    const body = z
      .object({
        tgBotToken: z.string().optional().nullable(),
        tgChatId: z.string().optional().nullable()
      })
      .parse(req.body ?? {});
    const updated = await updateNotificationConfig({
      tgBotToken: body.tgBotToken ?? null,
      tgChatId: body.tgChatId ?? null
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

export default router;
