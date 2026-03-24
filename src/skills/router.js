import { Router } from 'express';
import { dispatchSkill } from '../employees/index.js';

const router = Router();

// POST /api/skills/dispatch
// Body: { employee, skill, user_details_id, inputs }
router.post('/dispatch', async (req, res) => {
  try {
    const { employee, skill, user_details_id, inputs = {} } = req.body;
    if (!employee || !skill || !user_details_id) {
      return res.status(400).json({ error: 'employee, skill, and user_details_id are required' });
    }
    res.json({ dispatched: true });
    await dispatchSkill(employee, skill, { ...inputs, user_details_id });
  } catch (err) {
    console.error('skills dispatch error:', err);
  }
});

export default router;
