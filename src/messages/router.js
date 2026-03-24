// -------------------------------------------------------------------------
// MESSAGES ROUTER
// Receives Supabase database webhooks for new message inserts and routes
// them to the app_message_processor.
// -------------------------------------------------------------------------

import { Router } from 'express';
import { processMessage } from '../intelligence/app_message_processor/index.js';

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

export default router;
