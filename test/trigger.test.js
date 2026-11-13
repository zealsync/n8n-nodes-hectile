// The Hectile Trigger node without n8n: its hooks and webhook called with a stand-in `this` (node --test, after the build).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { HectileTrigger } = require("../dist/nodes/HectileTrigger/HectileTrigger.node.js");
const { Hectile } = require("../dist/nodes/Hectile/Hectile.node.js");
// The errors n8n itself raises: its request helpers wrap the HTTP client's AxiosError in a NodeApiError.
const { NodeApiError, NodeHelpers } = require("n8n-workflow");
const { AxiosError } = require("axios");

const node = new HectileTrigger();
const SECRET = "whsec_test0000000000000000000000000000";
const BASE = "https://hectile.example/api/v1";

function hooks({ answers = [], staticData = {}, events = ["invoice.paid"] } = {}) {
  const calls = [];
  return {
    calls,
    staticData,
    getWorkflowStaticData: () => staticData,
    getCredentials: async () => ({ baseUrl: BASE, apiKey: "hk_test_x" }),
    getNodeWebhookUrl: () => "https://n8n.example/webhook/abc",
    getNodeParameter: () => events,
    getNode: () => ({ id: "node-1", name: "Hectile Trigger", type: "n8n-nodes-hectile.hectileTrigger", typeVersion: 1, position: [0, 0], parameters: {} }),
    helpers: {
      httpRequestWithAuthentication: {
        call: async (_self, credential, options) => {
          calls.push({ credential, ...options });
          const answer = answers.shift();
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    },
  };
}

function delivery({ body, header, secret = SECRET }) {
  const raw = JSON.stringify(body);
  const sent = { status: null, text: null };
  return {
    sent,
    getRequestObject: () => ({ rawBody: Buffer.from(raw), body, headers: { "hectile-signature": header ?? sign(raw) } }),
    getResponseObject: () => ({ status(code) { sent.status = code; return this; }, send(text) { sent.text = text; } }),
    getWorkflowStaticData: () => ({ webhookId: "hook-1", secret }),
    helpers: { returnJsonArray: (items) => items.map((json) => ({ json })) },
  };
}

const sign = (raw, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

test("lists every event Hectile sends", () => {
  // The package's own copy of Hectile's event list (test/events.json), so it builds and tests on its own; Hectile's
  // repository checks that copy against its API (tests/unit/developers.test.ts).
  const events = JSON.parse(readFileSync(path.join(__dirname, "events.json"), "utf8")).sort();
  const options = node.description.properties.find((property) => property.name === "events").options.map((option) => option.value).sort();
  assert.equal(events.length, 12);
  assert.deepEqual(options, events);
});

test("subscribes its own URL with the key, keeps the id and secret, and removes the subscription when turned off", async () => {
  const self = hooks({ answers: [{ id: "hook-1", secret: SECRET }] });
  assert.equal(await node.webhookMethods.default.create.call(self), true);
  assert.deepEqual(self.calls[0], { credential: "hectileApi", method: "POST", url: `${BASE}/webhooks`, body: { url: "https://n8n.example/webhook/abc", events: ["invoice.paid"] }, json: true });
  assert.deepEqual(self.staticData, { webhookId: "hook-1", secret: SECRET });

  const exists = hooks({ staticData: self.staticData, answers: [{ data: [{ id: "hook-1", url: "https://n8n.example/webhook/abc" }] }] });
  assert.equal(await node.webhookMethods.default.checkExists.call(exists), true);
  const moved = hooks({ staticData: self.staticData, answers: [{ data: [{ id: "hook-1", url: "https://n8n.example/webhook/other" }] }] });
  assert.equal(await node.webhookMethods.default.checkExists.call(moved), false);

  // Turned off: Hectile removes the subscription, and the stored ID and secret go.
  const off = hooks({ staticData: { ...self.staticData }, answers: [{ id: "hook-1", object: "webhook_endpoint", deleted: true }] });
  assert.equal(await node.webhookMethods.default.delete.call(off), true);
  assert.deepEqual(off.calls, [{ credential: "hectileApi", method: "DELETE", url: `${BASE}/webhooks/hook-1`, json: true }]);
  assert.deepEqual(off.staticData, {});
});

// What n8n throws when Hectile answers with an error (status and body), or when no answer arrives (code only).
function n8nFailure({ status, body, code, message = "Request failed" }) {
  const config = { method: "delete", url: `${BASE}/webhooks/hook-1`, headers: {} };
  const response = status ? { status, statusText: "", data: body, headers: {}, config } : undefined;
  const axios = new AxiosError(message, code ?? (status ? (status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST") : undefined), config, {}, response);
  return new NodeApiError({ id: "node-1", name: "Hectile Trigger", type: "n8n-nodes-hectile.hectileTrigger", typeVersion: 1, position: [0, 0], parameters: {} }, axios);
}
const stored = () => ({ webhookId: "hook-1", secret: SECRET });
const problem = (code, message) => ({ error: { code, message } });

test("turning off with nothing stored makes no request and succeeds", async () => {
  const self = hooks({ staticData: {} });
  assert.equal(await node.webhookMethods.default.delete.call(self), true);
  assert.deepEqual(self.calls, []);
  assert.deepEqual(self.staticData, {});
});

test("a confirmed 404 (Hectile's NOT_FOUND: the subscription is already gone) counts as deleted", async () => {
  const failure = n8nFailure({ status: 404, body: problem("NOT_FOUND", "No webhook endpoint with this ID here.") });
  assert.equal(failure.httpCode, "404"); // n8n's own reading of the status
  const self = hooks({ staticData: stored(), answers: [failure] });
  assert.equal(await node.webhookMethods.default.delete.call(self), true);
  assert.equal(self.calls.length, 1);
  assert.deepEqual(self.staticData, {});
});

test("any other failure keeps the stored ID and secret and reports the error", async (t) => {
  const cases = [
    ["401, key refused or revoked", n8nFailure({ status: 401, body: problem("UNAUTHORIZED", "This API key isn't valid.") }), 401],
    ["403, key without the scope", n8nFailure({ status: 403, body: problem("FORBIDDEN", "This key can't do that.") }), 403],
    ["429, rate limited", n8nFailure({ status: 429, body: problem("RATE_LIMITED", "Too many requests.") }), 429],
    ["500, server error", n8nFailure({ status: 500, body: problem("INTERNAL", "Something went wrong.") }), 500],
    ["502, bad gateway", n8nFailure({ status: 502, body: "<html>Bad Gateway</html>" }), 502],
    ["503, unavailable", n8nFailure({ status: 503, body: problem("UNAVAILABLE", "Try again shortly.") }), 503],
    ["404 that isn't Hectile's NOT_FOUND (a wrong base URL or a proxy)", n8nFailure({ status: 404, body: "<html>Not Found</html>" }), 404],
    ["network failure", n8nFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 203.0.113.10:443" }), undefined],
    ["DNS failure", n8nFailure({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND hectile.example" }), undefined],
    ["timeout", n8nFailure({ code: "ECONNABORTED", message: "timeout of 30000ms exceeded" }), undefined],
    ["socket timeout", n8nFailure({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }), undefined],
    // The old test treated this as proof the subscription was gone; a message is not a status.
    ["a plain Error whose message says 404", new Error("404"), undefined],
  ];
  for (const [label, failure, status] of cases) {
    await t.test(label, async () => {
      const self = hooks({ staticData: stored(), answers: [failure] });
      await assert.rejects(node.webhookMethods.default.delete.call(self), (error) => {
        assert.ok(error instanceof NodeApiError, "reported as a NodeApiError");
        if (status !== undefined) assert.equal(Number(error.httpCode), status);
        return true;
      });
      assert.equal(self.calls.length, 1);
      assert.deepEqual(self.staticData, stored(), "the ID and secret stay, so turning off can be retried");
    });
  }
});

test("after a failed turn-off, trying again deletes the subscription", async () => {
  const staticData = stored();
  await assert.rejects(node.webhookMethods.default.delete.call(hooks({ staticData, answers: [n8nFailure({ status: 503, body: problem("UNAVAILABLE", "Try again shortly.") })] })));
  assert.deepEqual(staticData, stored());
  const retry = hooks({ staticData, answers: [{ id: "hook-1", object: "webhook_endpoint", deleted: true }] });
  assert.equal(await node.webhookMethods.default.delete.call(retry), true);
  assert.equal(retry.calls[0].url, `${BASE}/webhooks/hook-1`);
  assert.deepEqual(staticData, {});
});

test("starts the workflow only for a fresh message Hectile signed with this subscription's secret", async () => {
  const body = { id: "evt-1", type: "invoice.paid", created_at: "2026-10-30T09:15:00.000Z", organization_id: "org", data: { object: { id: "inv-1", object: "invoice" } } };
  const good = await node.webhook.call(delivery({ body }));
  assert.deepEqual(good.workflowData, [[{ json: body }]]);

  for (const header of [sign(JSON.stringify(body), undefined, "whsec_another"), sign(JSON.stringify(body), Math.floor(Date.now() / 1000) - 600), "", "v1=abc"]) {
    const self = delivery({ body, header });
    assert.deepEqual(await node.webhook.call(self), { noWebhookResponse: true });
    assert.equal(self.sent.status, 401);
  }
  const ping = { ...body, type: "endpoint.ping" };
  assert.deepEqual(await node.webhook.call(delivery({ body: ping })), { webhookResponse: "OK" });
});

test("the Hectile node offers each resource's operations and follows the API's pages", () => {
  const description = new Hectile().description;
  const operations = Object.fromEntries(
    description.properties.filter((property) => property.name === "operation").map((property) => [property.displayOptions.show.resource[0], property.options.map((option) => option.value).sort()]),
  );
  assert.deepEqual(operations, {
    customer: ["create", "get", "getAll", "update"],
    estimate: ["create", "finalize", "get", "getAll"],
    invoice: ["create", "finalize", "get", "getAll"],
    payment: ["create", "getAll"],
    report: ["summary", "unpaid"],
  });
  const list = description.properties.find((property) => property.name === "operation" && property.displayOptions.show.resource[0] === "invoice").options.find((option) => option.value === "getAll");
  assert.equal(list.routing.operations.pagination.properties.continue, "={{ $response.body.has_more }}");
  assert.equal(list.routing.request.qs.page, 1);
});

// n8n's generic pagination (n8n-core RoutingNode, 2.x): before every request, the first included, it evaluates
// properties.request with $request = the operation's own first request and $response = the previous answer ({} before
// the first), sends the first request merged with it, and goes on while properties.continue is true.
function paginate(operation, firstQs, answers) {
  const evaluate = (expression, $request, $response) => new Function("$request", "$response", `return (${expression.slice(3, -2)});`)($request, $response);
  const { request, continue: more } = operation.routing.operations.pagination.properties;
  const first = { qs: { ...firstQs } };
  const sent = [];
  let $response = {};
  do {
    const qs = evaluate(request.qs, first, $response);
    sent.push(qs);
    $response = { body: answers(qs) };
  } while (evaluate(more, first, $response) && sent.length < 20);
  return sent;
}

test("Return All asks for each page once, from page 1, and keeps the filters (n8n's own pagination loop)", () => {
  const description = new Hectile().description;
  const op = (resource) => description.properties.find((property) => property.name === "operation" && property.displayOptions.show.resource[0] === resource).options.find((option) => option.value === "getAll");
  // 298 customers, 100 a page, as the API answers: {data, page, has_more, total}.
  const answers = (qs) => ({ data: [], page: qs.page, has_more: qs.page * 100 < 298, total: 298 });
  assert.deepEqual(paginate(op("customer"), { page: 1, search: "Lakeview" }, answers), [
    { page: 1, search: "Lakeview" },
    { page: 2, search: "Lakeview" },
    { page: 3, search: "Lakeview" },
  ]);
  for (const resource of ["invoice", "estimate", "payment"]) {
    assert.deepEqual(paginate(op(resource), { page: 1, status: "overdue" }, answers).map((qs) => qs.page), [1, 2, 3]);
  }
  // One page: one request.
  assert.deepEqual(paginate(op("customer"), { page: 1 }, (qs) => ({ data: [], page: qs.page, has_more: false, total: 3 })), [{ page: 1 }]);
});

test("every create can send an Idempotency-Key header, and nothing else does", () => {
  const description = new Hectile().description;
  const collections = description.properties.filter((property) => property.type === "collection");
  const withKey = collections.filter((collection) => collection.options.some((option) => option.name === "idempotencyKey"));
  const offeredOn = withKey.map((collection) => `${collection.displayOptions.show.resource.join("|")}:${collection.displayOptions.show.operation.join("|")}`).sort();
  assert.deepEqual(offeredOn, ["customer:create", "estimate:create", "invoice:create", "payment:create"]);
  for (const collection of withKey) {
    const option = collection.options.find((entry) => entry.name === "idempotencyKey");
    assert.deepEqual(option.routing, { request: { headers: { "Idempotency-Key": "={{ $value }}" } } });
    // n8n lists a collection's options by label.
    const labels = collection.options.map((entry) => entry.displayName);
    assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
  }
  const payment = withKey.find((collection) => collection.displayOptions.show.resource[0] === "payment").options.find((entry) => entry.name === "idempotencyKey");
  assert.match(payment.description, /no time limit/);
  const customer = withKey.find((collection) => collection.displayOptions.show.resource[0] === "customer").options.find((entry) => entry.name === "idempotencyKey");
  assert.match(customer.description, /24 hours/);
});

test("Payment → Record → Method is required, and saved workflows keep their method", () => {
  const description = new Hectile().description;
  const method = description.properties.find((property) => property.name === "method" && property.displayOptions.show.resource[0] === "payment");
  // Same parameter as 1.0.0: name, options, default and routing unchanged; only `required` is new.
  assert.equal(method.required, true);
  assert.equal(method.type, "options");
  assert.equal(method.default, "bank_transfer");
  assert.deepEqual(method.displayOptions.show, { resource: ["payment"], operation: ["create"] });
  assert.deepEqual(method.options.map((option) => option.value), ["bank_transfer", "card", "cash", "cheque", "digital_wallet", "online_payment", "other", "upi"]);
  assert.deepEqual(method.routing, { send: { type: "body", property: "method" } });
  // n8n's own resolution of a saved node's parameters (what the editor and the executor read).
  const resolve = (saved) => NodeHelpers.getNodeParameters(description.properties, saved, true, false, null, null);
  const base = { resource: "payment", operation: "create", invoice_id: "inv-1", amount: "100" };
  assert.equal(resolve({ ...base, method: "upi" }).method, "upi");
  assert.equal(resolve({ ...base, method: "={{ $json.paymentMethod }}" }).method, "={{ $json.paymentMethod }}");
  // n8n leaves a value equal to the default out of the saved workflow: it still resolves to the same method as before.
  assert.equal(resolve(base).method, "bank_transfer");
  // Other resources never see it.
  assert.equal(resolve({ resource: "invoice", operation: "create" }).method, undefined);
});
