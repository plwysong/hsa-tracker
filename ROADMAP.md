# Roadmap

What it would take to turn HSA Tracker from a useful personal tool into a great HSA app. This is a plan, not a commitment: phases are ordered by dependency and value, and any phase after 0 can be cut or reordered.

## What a great HSA app has to do

The job is to make a tax-free HSA withdrawal defensible, easy, and eventually effortless. That breaks into five pillars. Each is graded against the app today.

1. **A record that survives decades.** Users lean on this in an audit fifteen years from now. Today: exports and a backup zip exist, but there is no in-app restore, no automatic backup, no integrity check on receipt files, no versioned schema migrations, and no automated tests. This is the biggest gap and it is invisible until the day it matters.
2. **Correct by construction under IRS rules.** A qualified reimbursement needs four things: the expense came after the HSA was established, it was for the account holder or a dependent, it was not paid by insurance or deducted elsewhere, and it is documented. The app only captures the fourth. There is no establishment date, no household member on an expense, no insurance-paid vs patient-responsibility split, and nowhere to attach an Explanation of Benefits or a Letter of Medical Necessity. Reimbursement is all-or-nothing per line.
3. **Effortless capture.** Email forwarding and drag-and-drop work. Missing: a phone path that does not go through email, reminders when the review queue sits idle, and a way to find expenses that were never documented.
4. **The full money loop.** From "what can I withdraw today" to an actual withdrawal with paperwork, then back to the ledger. Today the withdrawal step is manual.
5. **Trust and distribution.** The app is unsigned, so every update re-triggers macOS Gatekeeper, and there is no auto-update.

Deliberately out of scope: FSA or HRA tracking (a different product with plan-year deadlines and a claims workflow), contribution and investment management, cloud sync or a hosted service, bank connections through an aggregator, a native mobile app. Each adds cost and privacy surface without making an HSA withdrawal more defensible.

## Market context (September 2026)

The niche is crowded with small subscription apps, most launched 2024–2026, all cloud-hosted: HSA Tracker (hsatracker.org, unrelated to this project despite the name), Reimbursable, Tripl, HSA Vault, HealthLedger, TrackHSA, Shoebox. Custodians (Lively, HealthEquity, Fidelity) offer free but lock-in tracking.

Where this app already stands apart: local-first with no subscription, line-item splitting with a written rationale, an approval gate with a kept-not-deleted audit trail, and bring-your-own AI key. Where the market is ahead: phone capture with sync, family members, partial reimbursement, Form 8889 help, bank-transaction matching, deductible tracking. All of those are in the phases below.

If the app is ever distributed more widely, rename it first; the current name collides with an established product.

## Phases

Effort assumes part-time work at the pace of the v1.x releases.

### Phase 0 — Foundation (1–2 weeks)

Makes everything after it safe to build. Non-negotiable if any later phase happens.

- Automated test suite covering ingest, triage response parsing, dedup, and every export format.
- Versioned schema migrations (a `schema_version` setting and an ordered migration list) so later phases can change tables safely.
- In-app restore from a backup zip, with a preview of what will be restored and a safety copy of the current data first.
- Scheduled automatic backup to a user-chosen folder (e.g. a synced iCloud Drive or Dropbox folder), with retention.
- Integrity check: verify every receipt file against its stored SHA-256, report missing or altered files, detect orphans.

### Phase 1 — IRS correctness (2–3 weeks)

What makes it an HSA app rather than a receipt filer. Every item maps to a question an auditor would ask.

- ~~HSA establishment date in Settings; expenses dated before it get a hard warning and cannot be approved without an explicit override.~~ Shipped in v1.6.0 (pre-HSA expenses are kept as records only).
- Household members. Each expense is for a person; dependents are eligible, others are not.
- Insurance-paid and patient-responsibility amounts on an expense; only the patient portion counts toward the balance.
- Supporting documents attached to an expense: EOBs, Letters of Medical Necessity, prescriptions. A "needs LMN" item stays low-confidence until one is attached.
- Partial reimbursement: reimburse part of a line, track the remainder.
- A rules-version stamp on every AI verdict, and a dated rules table so old verdicts can be re-checked against newer rules.
- Triage prompt reviewed against current Pub 502, including recent changes (telehealth safe harbor, direct primary care, OTC and menstrual products).

### Phase 2 — Withdrawal loop (1–2 weeks)

Turns the dashboard balance into money in the account, with the paperwork done.

- Withdrawal packet: select expenses, get a PDF bundle with cover sheet, itemized list, and every receipt; mark reimbursed when the withdrawal posts.
- Tax-year packet: everything a preparer needs for one year.
- Form 8889 helper: total distributions, qualified portion, and the numbers to enter.
- Import a custodian distribution CSV and reconcile against reimbursed expenses.

### Phase 3 — Capture (2–3 weeks)

Removes the reasons receipts never make it in.

- Watch folder: photos saved from a phone into a synced folder ingest automatically. Covers the phone without a mobile app.
- Review-queue reminders as macOS notifications.
- Card or bank statement CSV import that flags likely medical charges with no matching ledger entry.
- Email polling hardening: clearer failure states, retry, and a visible "last checked" indicator.

### Phase 4 — Distribution (1 week plus an Apple Developer account)

- Notarized builds, which end the Gatekeeper "Open Anyway" step for everyone.
- Auto-update through the existing GitHub releases flow.
- Intel build if anyone needs it.

## Longer horizon

Ideas that pass the "what can someone actually do with this" test but sit behind phases 0–4. Roughly in order of fit.

**More kinds of eligible expenses**
- Medical mileage and travel: a trip log at the IRS medical mileage rate, plus parking and tolls.
- Qualifying premiums: COBRA, health insurance while receiving unemployment, Medicare premiums after 65, long-term care premiums up to the age-based cap.
- Backlog digitization: a guided mode for the shoebox of old paper receipts, with a nudge that thermal receipts fade.

**The account, not just the expenses**
- Multiple HSAs in one household, each with its own establishment date; a withdrawal records which account it came from.
- Contribution tracking: annual limit by coverage type, catch-up at 55, employer contributions, partial-year proration and the last-month rule, with a warning before over-contributing.
- Deductible and out-of-pocket progress from the same receipts.
- State tax treatment flag on the year-end packet for states that do not recognize HSAs.

**Decisions over time** (present numbers, never recommendations)
- Reimburse now vs later: a plain projection of leaving the balance invested.
- Age-65 and Medicare transition checklist keyed to birthdate.
- Estate packet: a printable list of every unreimbursed expense and where its receipts are, for heirs to claim within the allowed window. Nothing on the market does this.

**The app as an assistant**
- Ask the ledger: natural-language questions over local data.
- Tax-appointment prep: one button that assembles the year.

Not planned: provider-portal scraping, anything requiring a hosted service.

## Costs

| Item | Cost |
|---|---|
| Apple Developer Program (phase 4) | $99 / year |
| AI triage | unchanged, pay per receipt |
| Hosting or services | none |

Total effort for phases 0–4 is roughly eight to eleven weeks part-time, shipped as five or six releases. If only part of it happens, the highest-value slice is phase 0 plus the first half of phase 1: restore, auto-backup, tests, establishment date, household members, and document attachments.
