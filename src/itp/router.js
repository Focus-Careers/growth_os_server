import express from 'express';
import { executeSkill } from '../employees/lead_gen_expert/skills/itp_refiner/index.js';

const router = express.Router();

/**
 * POST /api/itp/refine
 * Refines an ITP based on its accumulated rejected leads.
 * Does NOT trigger target_finder — that's deferred to user action.
 * Body: { itp_id, user_details_id }
 */
router.post('/refine', async (req, res) => {
  const { itp_id, user_details_id } = req.body;
  if (!itp_id) return res.status(400).json({ error: 'itp_id required' });

  try {
    const result = await executeSkill({ itp_id, user_details_id, skip_target_finder: true });
    res.json(result);
  } catch (err) {
    console.error('[itp/refine]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
