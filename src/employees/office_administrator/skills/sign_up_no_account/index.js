import { getSupabaseAdmin } from '../../../../config/supabase.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// -------------------------------------------------------------------------
// CORE SKILL LOGIC
// Called internally by the mobilisation dispatcher.
// Accepts { firstname, email }, returns a result object.
// -------------------------------------------------------------------------
export async function executeSkill({ firstname, email, messages = [] }) {
  if (!EMAIL_REGEX.test(email)) {
    return { error: 'email_format_incorrect' };
  }

  const admin = getSupabaseAdmin();

  // Check if email already exists in user_details (fast, no pagination issues)
  const { data: existingUser } = await admin.from('user_details').select('id').eq('email', email.toLowerCase()).maybeSingle();
  if (existingUser) return { error: 'user_exists' };

  const { data: newUser, error: createError } = await admin.auth.admin.createUser({
    email: email.toLowerCase(),
    user_metadata: { firstname },
    email_confirm: true,
  });

  if (createError) {
    console.error('sign_up_no_account: createUser error:', createError);
    return { error: 'internal_error' };
  }

  // Create account record
  const { data: newAccount, error: accountError } = await admin
    .from('account')
    .insert({})
    .select('id')
    .single();

  if (accountError) {
    console.error('sign_up_no_account: create account error:', accountError);
    return { error: 'internal_error' };
  }

  // Create user_details record
  const { data: newUserDetails, error: userDetailsError } = await admin
    .from('user_details')
    .insert({
      firstname,
      email: email.toLowerCase(),
      auth_id: newUser.user.id,
      account_id: newAccount.id,
      role: 'admin',
    })
    .select('id')
    .single();

  if (userDetailsError) {
    console.error('sign_up_no_account: create user_details error:', userDetailsError);
    return { error: 'internal_error' };
  }

  // Save messages to database
  if (messages.length > 0) {
    const { error: messagesError } = await admin
      .from('messages')
      .insert(messages.map(msg => ({
        is_agent: msg.is_agent,
        message_body: msg.message_body,
        user_details_id: newUserDetails.id,
        created_at: msg.timestamp,
      })));

    if (messagesError) {
      console.error('sign_up_no_account: insert messages error:', messagesError);
    }
  }

  // Generate magic link (returned to client for direct login)
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: email.toLowerCase(),
    options: { redirectTo: process.env.APP_URL },
  });

  if (linkError) {
    console.error('sign_up_no_account: generateLink error:', linkError);
    return { error: 'internal_error' };
  }

  return {
    firstname,
    email: newUser.user.email,
    user_id: newUser.user.id,
    account_id: newAccount.id,
    user_details_id: newUserDetails.id,
    login_url: linkData.properties.action_link,
  };
}

// -------------------------------------------------------------------------
// HTTP HANDLER
// Wraps executeSkill for direct HTTP calls via the office administrator router.
// -------------------------------------------------------------------------
export async function createUserAndAccount(req, res) {
  const result = await executeSkill(req.body);

  if (result.error === 'email_format_incorrect') return res.status(400).json(result);
  if (result.error === 'user_exists') return res.status(409).json(result);
  if (result.error === 'internal_error') return res.status(500).json({ error: 'Internal server error' });

  return res.status(200).json(result);
}
