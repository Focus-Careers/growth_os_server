import { Router } from 'express';
import { getStep, triggerMobilisation, completeMobilisation } from './index.js';
import { getSupabaseAdmin } from '../config/supabase.js';

const router = Router();

// POST /api/mobilisation/step
// Body: { mobilisation: string, step_id: string }
router.post('/step', async (req, res) => {
  try {
    const { mobilisation, step_id, value, user_details_id } = req.body;
    if (!mobilisation || !step_id) {
      return res.status(400).json({ error: 'mobilisation and step_id are required' });
    }
    const step = await getStep(mobilisation, step_id, value, user_details_id);
    return res.json({ step });
  } catch (err) {
    console.error('mobilisation step error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/mobilisation/start
// Body: { mobilisation: string }
// Returns the first step of the mobilisation without going through Claude.
router.post('/start', async (req, res) => {
  try {
    const { mobilisation, user_details_id, start_step } = req.body;
    if (!mobilisation) {
      return res.status(400).json({ error: 'mobilisation is required' });
    }
    const context = { user_details_id: user_details_id ?? null, start_step: start_step ?? null };
    const step = await triggerMobilisation(mobilisation, [], context);
    if (user_details_id && step) {
      await getSupabaseAdmin()
        .from('user_details')
        .update({ active_mobilisation: mobilisation, active_step_id: step.id })
        .eq('id', user_details_id);
    }
    return res.json({ step });
  } catch (err) {
    console.error('mobilisation start error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/mobilisation/complete
// Body: { mobilisation: string, responses: object }
router.post('/complete', async (req, res) => {
  try {
    const { mobilisation, responses, messages, user_details_id } = req.body;
    if (!mobilisation || !responses) {
      return res.status(400).json({ error: 'mobilisation and responses are required' });
    }
    const result = await completeMobilisation(mobilisation, responses, messages, user_details_id);
    if (user_details_id) {
      await getSupabaseAdmin()
        .from('user_details')
        .update({ active_mobilisation: null, active_step_id: null })
        .eq('id', user_details_id);
    }
    return res.json({ result });
  } catch (err) {
    console.error('mobilisation complete error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
