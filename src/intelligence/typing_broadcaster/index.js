import { getSupabaseAdmin } from '../../config/supabase.js';

export async function broadcastTyping(user_details_id, typing) {
  try {
    const channel = getSupabaseAdmin().channel(`user:${user_details_id}`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('subscribe timeout')), 5000);
      channel.subscribe((status) => {
        clearTimeout(timeout);
        if (status === 'SUBSCRIBED') resolve();
        else reject(new Error(`subscribe status: ${status}`));
      });
    });
    await channel.send({ type: 'broadcast', event: 'agent_typing', payload: { typing } });
    await getSupabaseAdmin().removeChannel(channel);
  } catch (err) {
    console.warn('broadcastTyping failed (non-fatal):', err.message);
  }
}
