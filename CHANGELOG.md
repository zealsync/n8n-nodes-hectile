# Changelog

## 1.0.1

- Hectile Trigger: turning a workflow off removes its Hectile subscription and reports a failure instead of hiding it. The
  stored subscription ID and secret are cleared only after Hectile confirms the deletion, or answers that the subscription
  no longer exists (404 with the error code `NOT_FOUND`). For any other answer (401, 403, 429, a server error, a 404 from
  something other than Hectile's API) or a network failure or timeout, they are kept, so turning the workflow off can be
  retried, and the error is shown. The status is read from the error's response, never from its message.
- Payment → Record: **Method** is marked required, as Hectile's API requires it. Its name, options, default (Bank Transfer)
  and routing are unchanged, so saved workflows keep the method or expression they had.

## 1.0.0

- First release: the Hectile node (customers, invoices, estimates, payments, reports) and the Hectile Trigger (12 events, signed).
- Each create takes an optional Idempotency Key; Get Many with Return All reads every page once, from the first, keeping its filters.
- The README says how to run each event once (Remove Duplicates on the event's `id`), since a message can arrive more than once.
