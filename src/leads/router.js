import { Router } from 'express';
import { getSupabaseAdmin } from '../config/supabase.js';
import { pushApprovedLeadToCampaign } from '../lib/lead_gen/push_lead_contacts.js';

const router = Router();

// POST /api/leads/:id/approve
// Marks a lead as approved AND pushes its contacts to the active campaign for
// the lead's ITP. This is the manual-approval entry point — the frontend now
// calls this instead of writing directly to Supabase so the campaign push
// fires alongside the approval.
//
// Auto-approve (account.auto_approve_leads) still happens at target_finder_100
// persist time; its contacts get pushed via addContactsToCampaign's in-run
// approval gate, no endpoint hit needed.
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'lead id is required' });

    const admin = getSupabaseAdmin();
    const { data: lead, error } = await admin
      .from('leads')
      .update({ approved: true })
      .eq('id', id)
      .select('id, itp_id, target_id')
      .single();

    if (error || !lead) {
      console.error('[leads/approve] update error:', error?.message);
      return res.status(500).json({ error: 'Failed to approve lead' });
    }

    // Fire-and-forget so the API responds fast. Errors are logged inside the
    // helper; if push fails, the approval still stands and a later
    // 100_leads run / re-approval will pick it up.
    pushApprovedLeadToCampaign(lead.id).catch(err =>
      console.error(`[leads/approve] push error for lead ${lead.id}:`, err.message)
    );

    return res.json({ ok: true, lead });
  } catch (err) {
    console.error('[leads/approve] unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
