# Changelog

## 1.0.0

- First release: the Hectile node (customers, invoices, estimates, payments, reports) and the Hectile Trigger (12 events, signed).
- Each create takes an optional Idempotency Key; Get Many with Return All reads every page once, from the first, keeping its filters.
- The README says how to run each event once (Remove Duplicates on the event's `id`), since a message can arrive more than once.
