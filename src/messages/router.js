// -------------------------------------------------------------------------
// MESSAGES ROUTER
// Receives Supabase database webhooks for new message inserts and routes
// them to the app_message_processor.
// -------------------------------------------------------------------------

import { Router } from 'express';
import { processMessage } from '../intelligence/app_message_processor/index.js';
import { analyseAndGreet } from '../intelligence/welcome_back/index.js';

const router = Router();

// POST /api/messages/process
// Called by Supabase webhook on INSERT to messages table.
router.post('/process', async (req, res) => {
  // Respond immediately so Supabase doesn't time out waiting
  res.json({ received: true });

  try {
    const { record, type } = req.body;
    console.log(`[webhook] type=${type} is_agent=${record?.is_agent} user=${record?.user_details_id}`);
    if (type !== 'INSERT' || !record || record.is_agent) return;
    await processMessage(record);
  } catch (err) {
    console.error('app_message_processor error:', err);
  }
});

// POST /api/messages/welcome-back
// Called by frontend when a signed-up user loads the app.
router.post('/welcome-back', async (req, res) => {
  try {
    const { user_details_id } = req.body;
    if (!user_details_id) return res.status(400).json({ error: 'user_details_id required' });
    const result = await analyseAndGreet(user_details_id);
    if (!result) return res.json({ skip: true });
    return res.json(result);
  } catch (err) {
    console.error('[welcome-back] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
