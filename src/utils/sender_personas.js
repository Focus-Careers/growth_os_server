/**
 * Realistic sender personas (first + last name pairs) for mailbox creation.
 * Designed to look like genuine business contacts — no AI/sales-y names.
 * Pulled from common UK/US names; balanced gender mix.
 */
const PERSONAS = [
  { first_name: 'Sarah',   last_name: 'Mitchell' },
  { first_name: 'James',   last_name: 'Reynolds' },
  { first_name: 'Emily',   last_name: 'Hughes' },
  { first_name: 'Daniel',  last_name: 'Carter' },
  { first_name: 'Hannah',  last_name: 'Bennett' },
  { first_name: 'Michael', last_name: 'Foster' },
  { first_name: 'Olivia',  last_name: 'Walsh' },
  { first_name: 'Ryan',    last_name: 'Patel' },
  { first_name: 'Sophie',  last_name: 'Brennan' },
  { first_name: 'Thomas',  last_name: 'Whittaker' },
  { first_name: 'Grace',   last_name: 'Sullivan' },
  { first_name: 'Adam',    last_name: 'Holloway' },
];

/**
 * Pick `n` distinct personas for a provisioning order.
 * Uses the order id (or any string seed) to keep selection deterministic within an order.
 * @param {number} n
 * @param {string} [seed]
 * @returns {Array<{first_name:string,last_name:string,prefix:string}>}
 */
export function pickPersonas(n, seed = '') {
  const startIdx = stringSeed(seed) % PERSONAS.length;
  const picks = [];
  for (let i = 0; i < n; i++) {
    const p = PERSONAS[(startIdx + i) % PERSONAS.length];
    picks.push({
      first_name: p.first_name,
      last_name: p.last_name,
      prefix: `${p.first_name}.${p.last_name}`.toLowerCase(),
    });
  }
  return picks;
}

function stringSeed(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export { PERSONAS };
