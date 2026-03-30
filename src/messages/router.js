// -------------------------------------------------------------------------
// MESSAGES ROUTER
// Receives Supabase database webhooks for new message inserts and routes
// them to the app_message_processor.
// -------------------------------------------------------------------------

import { Router } from 'express';
import { processMessage } from '../intelligence/app_message_processor/index.js';
import { analyseAndGreet } from '../intelligence/welcome_back/index.js';
import { generateDraperSummary } from '../intelligence/draper_summary/index.js';
import { generateBelfortSummary } from '../intelligence/belfort_summary/index.js';
import { generateWarrenSummary } from '../intelligence/warren_summary/index.js';
import { generatePepperSummary } from '../intelligence/pepper_summary/index.js';

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

// POST /api/messages/draper-summary
// Called by frontend when the Draper (Campaigns) tab is opened.
router.post('/draper-summary', async (req, res) => {
  try {
    const { account_id, firstname } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const message = await generateDraperSummary(account_id, firstname);
    return res.json({ message });
  } catch (err) {
    console.error('[draper-summary] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/messages/belfort-summary
router.post('/belfort-summary', async (req, res) => {
  try {
    const { account_id, firstname } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const message = await generateBelfortSummary(account_id, firstname);
    return res.json({ message });
  } catch (err) {
    console.error('[belfort-summary] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/messages/warren-summary
router.post('/warren-summary', async (req, res) => {
  try {
    const { account_id, firstname } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const message = await generateWarrenSummary(account_id, firstname);
    return res.json({ message });
  } catch (err) {
    console.error('[warren-summary] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/messages/pepper-summary
router.post('/pepper-summary', async (req, res) => {
  try {
    const { account_id, firstname, user_details_id } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const message = await generatePepperSummary(account_id, firstname, user_details_id);
    return res.json({ message });
  } catch (err) {
    console.error('[pepper-summary] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
