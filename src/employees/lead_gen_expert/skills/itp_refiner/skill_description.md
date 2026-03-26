# ITP Refiner

Refines an Ideal Target Profile based on user rejection feedback from target review. Uses AI to adjust the ITP fields, then triggers a new round of target finding.

## Inputs
- `user_details_id` (text) — FK to user_details
- `itp_id` (uuid) — FK to itp, the profile to refine

## Process
1. Load current ITP and all rejected targets with reasons
2. Send to Claude to refine the ITP based on rejection patterns
3. Update ITP in database
4. Trigger target_finder_ten_leads to find new targets matching refined ITP

## Output
Confirmation of refinement with summary of changes
