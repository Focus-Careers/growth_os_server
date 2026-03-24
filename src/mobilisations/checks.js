// -------------------------------------------------------------------------
// VALIDATION CHECKS
// Each check receives the step value and returns true (pass) or false (fail).
// -------------------------------------------------------------------------

import { getSupabaseAdmin } from '../config/supabase.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^(https?:\/\/)?([\w-]+\.)+[\w]{2,}(\/.*)?$/i;

export const checks = {
  email_format: async (value) => {
    return EMAIL_REGEX.test(value);
  },

  url_format: async (value) => {
    return URL_REGEX.test(value?.trim());
  },

  email_exists: async (value) => {
    const { data, error } = await getSupabaseAdmin().auth.admin.listUsers();
    if (error) throw new Error('email_exists check failed: ' + error.message);
    return !data.users.some(u => u.email === value.toLowerCase());
  },
};
