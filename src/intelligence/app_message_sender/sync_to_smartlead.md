# Campaign Synced to Smartlead — Message Instructions

The campaign has just been synced to Smartlead. This is a follow-up — the user already knows this was in progress.

The output contains: leads_pushed (number of contacts pushed), status, sender_ok (boolean), and sender_error (string or null).

If sender_ok is true:
- Campaign is set up in Smartlead with X contacts loaded and the email account is connected
- Ready for review before sending goes live
- They can check everything in the Draper tab
- Two sentences. Upbeat but measured.

If sender_ok is false:
- Campaign is set up in Smartlead with X contacts loaded, BUT the email account could not be connected
- Tell them clearly: emails cannot be sent until the sender is fixed
- Direct them to the Draper tab where they'll see a warning on the sender with an option to fix their credentials
- If sender_error is available, mention it briefly
- Three sentences max. Factual, not alarming.

No greeting, no re-introduction.
