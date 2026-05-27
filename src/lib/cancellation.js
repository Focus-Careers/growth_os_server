// -------------------------------------------------------------------------
// CANCELLATION REGISTRY
// In-process map of AbortControllers for in-flight skill runs, keyed by
// user_details_id. Enables user-initiated "stop".
//
// Tier 1: dispatchSkill registers a controller per run; stopForUser aborts it,
// and dispatchSkill / processSkillOutput consult isAborted() to suppress a
// cancelled run's status, error message, and user-facing output.
//
// Tier 2 (later): skills thread `inputs.signal` into their fetch/LLM calls and
// check `signal.throwIfAborted()` at loop checkpoints so in-flight work halts
// promptly and stops spending Serper/Apollo credits.
//
// NOTE: this is per-process state. If the app is ever scaled to >1 instance, a
// stop request must hit the same instance running the skill — otherwise add a
// DB-backed cancel flag that long loops poll as a fallback.
// -------------------------------------------------------------------------

const controllers = new Map(); // user_details_id -> AbortController

// Start tracking a new run for a user. Aborts any stale controller still held
// for that user before replacing it. Returns the AbortController for the run.
export function registerRun(userDetailsId) {
  const controller = new AbortController();
  if (!userDetailsId) return controller; // untracked run (no user) — still usable
  const existing = controllers.get(userDetailsId);
  if (existing && !existing.signal.aborted) existing.abort();
  controllers.set(userDetailsId, controller);
  return controller;
}

// Abort the in-flight run for a user, if any. Returns true if something was aborted.
export function abortRun(userDetailsId) {
  const controller = controllers.get(userDetailsId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    return true;
  }
  return false;
}

// True if the user's currently-registered run has been aborted.
export function isAborted(userDetailsId) {
  return controllers.get(userDetailsId)?.signal.aborted ?? false;
}

// Stop tracking a run. Only removes the entry if it's still the controller we
// registered, so a newer run for the same user isn't clobbered.
export function clearRun(userDetailsId, controller) {
  if (userDetailsId && controllers.get(userDetailsId) === controller) {
    controllers.delete(userDetailsId);
  }
}
