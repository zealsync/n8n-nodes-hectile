# n8n-nodes-hectile

This is an n8n community node. It lets you use [Hectile](https://hectile.com), invoicing and estimates software, in your n8n workflows: customers, invoices, estimates, payments and reports, and Hectile's events as a trigger.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `n8n-nodes-hectile`.

## Operations

**Hectile**

- Customer: Create, Get, Get Many (search by name, email or phone), Update
- Invoice: Create (a draft, or issued), Issue a draft (Finalize), Get, Get Many (by status or customer)
- Estimate: Create (a draft, or issued), Issue a draft (Finalize), Get, Get Many (by status or customer)
- Payment: Record against an issued invoice, Get Many (all, or one invoice's)
- Report: Get Summary (invoiced, paid and outstanding by currency), Get Unpaid by Age

Get Many returns up to the limit you set, or every page with Return All. Hectile never emails a document the API creates; send it from Hectile or share its link (`public_url`).

Each Create (customer, invoice, estimate, payment) takes an optional **Idempotency Key** under Additional Fields. Map something unique to the run's source, like the trigger's event ID (`{{ $json.id }}`):

- A customer, invoice or estimate sent again with the same key within 24 hours gets the first record back instead of a second one; after 24 hours the same key makes a new record.
- A payment keeps its key with no time limit: the same key under the same API key answers with the first payment, or refuses one with other details. Each new payment needs a new key.
- The key belongs to the API key, not to the workflow: if two steps or workflows create from the same event with the same API key, give each key a word of its own, like `{{ $json.id }}-deposit`.

This protects Hectile's records from a repeat; it doesn't make a workflow run exactly once. n8n runs the workflow for every message Hectile delivers, and Hectile delivers a message again when n8n doesn't answer it in time, so steps in other apps can run twice.

**Hectile Trigger**

Starts a workflow when any of these happen: Invoice Issued, Invoice Sent, Invoice Paid, Invoice Overdue, Estimate Accepted, Estimate Declined, Payment Received, Payment Refunded, Credit Note Issued, Debit Note Issued, Customer Created, Customer Updated.

When the workflow is activated, the node subscribes its own webhook URL in Hectile with your API key; when it is deactivated, the subscription is removed. Each message is checked against its `Hectile-Signature` (HMAC-SHA256 with the subscription's own secret) and must be less than five minutes old; anything else is refused. The workflow receives Hectile's message as it is: `{id, type, created_at, organization_id, data: {object}}`, where `object` is the record as Hectile's API answers it.

A message can arrive more than once — Hectile sends it again when n8n's answer is late or lost — and every copy carries the same `id`. To run each event once, put n8n's **Remove Duplicates** node right after the trigger: *Remove Items Processed in Previous Executions*, keep items where *Value Is New*, value `{{ $json.id }}`. A copy that arrives later then stops there.

## Credentials

The nodes use an API key from Hectile. API keys are part of Hectile Business, and the Organization's Owner or an Admin makes them.

1. In Hectile, open **Settings → Developers → Create API Key**.
2. Name it (for example, "n8n"), and choose **Read** or **Write** for what your workflows use: Customers, Items, Estimates, Invoices and notes, Payments, Reports. Choose all Brands or one Brand.
3. Copy the key. Hectile shows it only once.
4. In n8n, create a **Hectile API** credential and paste the key. Leave **API Address** as `https://hectile.com/api/v1`.

The key acts within its scopes and Brands. Revoking it in Hectile disconnects n8n at once and pauses the trigger's subscriptions. Requests are limited to 60 a minute per key.

## Compatibility

Built and linted with `@n8n/node-cli` 0.54 against n8n 2.x (`n8nNodesApiVersion` 1). It has no runtime dependencies.

## Usage

- **Paid invoices to a spreadsheet**: Hectile Trigger (Invoice Paid) → Google Sheets (append the number, customer, total and date).
- **Customers from a form**: Form trigger → Hectile (Customer: Create) → Hectile (Invoice: Create, Issue It Now).
- **A weekly overdue summary**: Schedule trigger → Hectile (Report: Get Unpaid by Age) → your team chat.

The trigger answers Hectile's test ping, which Hectile sends when an endpoint is added in Settings → Developers → Webhooks, without starting the workflow.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Hectile: Zapier, Make, Pabbly Connect and n8n](https://hectile.com/help/automation-apps)
- [Hectile: API keys](https://hectile.com/help/api-keys)
- [Hectile: Webhooks](https://hectile.com/help/webhooks)
- The full API reference with an example answer for each request is in Hectile under **Settings → Developers → API Reference**.

## Version history

- 1.0.0: first release.
