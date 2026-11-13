import { NodeConnectionTypes, type IDataObject, type INodeProperties, type INodeType, type INodeTypeDescription } from "n8n-workflow";

/**
 * Hectile's API, version 1, as n8n operations (declarative: each operation is one request). Lists answer
 * {data, page, has_more, total}, 100 a page; "Return All" follows the pages.
 */

const only = (resource: string[], operation: string[]) => ({ show: { resource, operation } });

/** Return All and Limit for a list operation of these resources. */
function listing(resource: string[]): INodeProperties[] {
  return [
    {
      displayName: "Return All",
      name: "returnAll",
      type: "boolean",
      default: false,
      description: "Whether to return all results or only up to a given limit",
      displayOptions: only(resource, ["getAll"]),
      routing: { send: { paginate: "={{ $value }}" } },
    },
    {
      displayName: "Limit",
      name: "limit",
      type: "number",
      typeOptions: { minValue: 1, maxValue: 100 },
      default: 50,
      description: "Max number of results to return",
      displayOptions: { show: { resource, operation: ["getAll"], returnAll: [false] } },
      routing: { send: { type: "query", property: "limit" }, output: { maxResults: "={{ $value }}" } },
    },
  ];
}

// n8n works out the next request before every request, the first included, and $request is always the operation's own
// first request, never the one before. So the page comes from the previous answer's own page number (none before the
// first answer: page 1), and the first request's query (search, status, customer) is kept on every page.
const pages = {
  pagination: {
    type: "generic" as const,
    properties: {
      continue: "={{ $response.body.has_more }}",
      // One expression for the whole query (n8n resolves it to an object before each request), so the filters always
      // travel with the page; typed as the object it resolves to.
      request: { qs: "={{ Object.assign({}, $request.qs, { page: ($response.body ? $response.body.page : 0) + 1 }) }}" as unknown as IDataObject },
    },
  },
};

const list = (url: string, qs: Record<string, string> = {}) => ({
  request: { method: "GET" as const, url, qs: { page: 1, ...qs } },
  output: { postReceive: [{ type: "rootProperty" as const, properties: { property: "data" } }] },
  operations: pages,
});

/** Collection options in n8n's order (by label). */
const byLabel = (fields: INodeProperties[]) => [...fields].sort((a, b) => a.displayName.localeCompare(b.displayName));

/**
 * An optional Idempotency-Key for a create, as Hectile's other apps offer (Unique ID in Zapier and Make, Idempotency Key
 * in Pabbly). Hectile keeps a create's answer for 24 hours; a payment keeps its key with no time limit.
 */
function idempotencyKey(payment: boolean): INodeProperties {
  return {
    displayName: "Idempotency Key",
    name: "idempotencyKey",
    type: "string",
    default: "",
    description: payment
      ? "Something unique to this payment, like the trigger's event ID. The same key under the same API key answers with the first payment or a refusal, with no time limit, so each new payment needs a new key. If another step records a payment from the same event, add a word of this step's own, like -deposit."
      : "Something unique to this record's source, like the trigger's event ID. Sent again within 24 hours, it gets the first record back instead of making another; after that, it makes a new one. If another step or workflow creates from the same event, add a word of its own.",
    routing: { request: { headers: { "Idempotency-Key": "={{ $value }}" } } },
  };
}

// ---------------------------------------------------------------------------------------------- customers

const customerFields: INodeProperties[] = [
  { displayName: "Contact Person", name: "contact_person", type: "string", default: "", routing: { send: { type: "body", property: "contact_person" } } },
  { displayName: "Currency", name: "currency", type: "string", default: "", placeholder: "INR", description: "Three letters. Empty: the Organization's currency.", routing: { send: { type: "body", property: "currency" } } },
  { displayName: "Email", name: "email", type: "string", placeholder: "name@email.com", default: "", routing: { send: { type: "body", property: "email" } } },
  { displayName: "Name", name: "name", type: "string", default: "", routing: { send: { type: "body", property: "name" } } },
  { displayName: "Payment Terms (Days)", name: "payment_terms_days", type: "number", default: 15, routing: { send: { type: "body", property: "payment_terms_days" } } },
  { displayName: "Phone", name: "phone", type: "string", default: "", routing: { send: { type: "body", property: "phone" } } },
  {
    displayName: "Type",
    name: "type",
    type: "options",
    options: [
      { name: "Company", value: "company" },
      { name: "Individual", value: "individual" },
    ],
    default: "company",
    routing: { send: { type: "body", property: "type" } },
  },
];

const customer: INodeProperties[] = [
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    displayOptions: { show: { resource: ["customer"] } },
    options: [
      { name: "Create", value: "create", action: "Create a customer", routing: { request: { method: "POST", url: "/customers" } } },
      { name: "Get", value: "get", action: "Get a customer", routing: { request: { method: "GET", url: "=/customers/{{$parameter.customerId}}" } } },
      { name: "Get Many", value: "getAll", action: "Get many customers", routing: list("/customers", { search: "={{$parameter.search || undefined}}" }) },
      { name: "Update", value: "update", action: "Update a customer", routing: { request: { method: "PATCH", url: "=/customers/{{$parameter.customerId}}" } } },
    ],
    default: "create",
  },
  { displayName: "Customer ID", name: "customerId", type: "string", required: true, default: "", displayOptions: only(["customer"], ["get", "update"]) },
  { displayName: "Search", name: "search", type: "string", default: "", description: "Name, email or phone", displayOptions: only(["customer"], ["getAll"]) },
  ...listing(["customer"]),
  { displayName: "Name", name: "name", type: "string", required: true, default: "", displayOptions: only(["customer"], ["create"]), routing: { send: { type: "body", property: "name" } } },
  {
    displayName: "Additional Fields",
    name: "additionalFields",
    type: "collection",
    placeholder: "Add Field",
    default: {},
    displayOptions: only(["customer"], ["create"]),
    options: byLabel([...customerFields.filter((field) => field.name !== "name"), idempotencyKey(false)]),
  },
  { displayName: "Update Fields", name: "updateFields", type: "collection", placeholder: "Add Field", default: {}, displayOptions: only(["customer"], ["update"]), options: customerFields },
];

// ---------------------------------------------------------------------------------------------- invoices and estimates

function documents(resource: "invoice" | "estimate"): INodeProperties[] {
  const path = resource === "invoice" ? "/invoices" : "/estimates";
  const noun = resource === "invoice" ? "an invoice" : "an estimate";
  const many = resource === "invoice" ? "invoices" : "estimates";
  const statuses =
    resource === "invoice"
      ? ["cancelled", "credited", "draft", "issued", "overdue", "paid", "partially_paid", "sent", "viewed", "written_off"]
      : ["accepted", "cancelled", "converted", "declined", "draft", "expired", "issued", "sent", "viewed"];
  const label = (status: string) => status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return [
    {
      displayName: "Operation",
      name: "operation",
      type: "options",
      noDataExpression: true,
      displayOptions: { show: { resource: [resource] } },
      options: [
        { name: "Create", value: "create", action: `Create ${noun}`, routing: { request: { method: "POST", url: path } } },
        { name: "Finalize", value: "finalize", action: `Issue ${noun} draft`, routing: { request: { method: "POST", url: `=${path}/{{$parameter.documentId}}/finalize` } } },
        { name: "Get", value: "get", action: `Get ${noun}`, routing: { request: { method: "GET", url: `=${path}/{{$parameter.documentId}}` } } },
        {
          name: "Get Many",
          value: "getAll",
          action: `Get many ${many}`,
          routing: list(path, { status: "={{$parameter.status || undefined}}", customer_id: "={{$parameter.customerFilter || undefined}}" }),
        },
      ],
      default: "create",
    },
    { displayName: resource === "invoice" ? "Invoice ID" : "Estimate ID", name: "documentId", type: "string", required: true, default: "", displayOptions: only([resource], ["get", "finalize"]) },
    {
      displayName: "Status",
      name: "status",
      type: "options",
      default: "",
      displayOptions: only([resource], ["getAll"]),
      options: [{ name: "Any", value: "" }, ...statuses.map((status) => ({ name: label(status), value: status }))],
    },
    { displayName: "Customer ID", name: "customerFilter", type: "string", default: "", description: `Only this customer's ${many}`, displayOptions: only([resource], ["getAll"]) },
    ...listing([resource]),
    { displayName: "Customer ID", name: "customer_id", type: "string", required: true, default: "", displayOptions: only([resource], ["create"]), routing: { send: { type: "body", property: "customer_id" } } },
    {
      displayName: "Lines",
      name: "lines",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      required: true,
      default: {},
      placeholder: "Add Line",
      displayOptions: only([resource], ["create"]),
      options: [
        {
          displayName: "Line",
          name: "line",
          values: [
            { displayName: "Description", name: "description", type: "string", default: "", description: "Needed unless you give an item ID (the item's name and price are used)" },
            { displayName: "Item ID", name: "item_id", type: "string", default: "" },
            { displayName: "Price", name: "unit_price", type: "string", default: "", description: "In the document's currency, like 1250.00" },
            { displayName: "Quantity", name: "quantity", type: "string", default: "1" },
          ],
        },
      ],
      routing: {
        send: {
          type: "body",
          property: "lines",
          value: "={{ ($value.line || []).map(line => ({ description: line.description || undefined, quantity: line.quantity || '1', unit_price: line.unit_price || undefined, item_id: line.item_id || undefined })) }}",
        },
      },
    },
    {
      displayName: "Issue It Now",
      name: "finalize",
      type: "boolean",
      default: false,
      description: "Whether to give it its number at once; otherwise it stays a draft. Hectile doesn't email it.",
      displayOptions: only([resource], ["create"]),
      routing: { send: { type: "body", property: "finalize" } },
    },
    {
      displayName: "Additional Fields",
      name: "documentFields",
      type: "collection",
      placeholder: "Add Field",
      default: {},
      displayOptions: only([resource], ["create"]),
      options: byLabel([
        idempotencyKey(false),
        { displayName: "Notes", name: "notes", type: "string", typeOptions: { rows: 3 }, default: "", routing: { send: { type: "body", property: "notes" } } },
        ...(resource === "invoice"
          ? [{ displayName: "Payment Terms (Days)", name: "payment_terms_days", type: "number" as const, default: 15, routing: { send: { type: "body" as const, property: "payment_terms_days" } } }]
          : []),
        { displayName: "Reference", name: "reference", type: "string", default: "", description: "Like the customer's PO number", routing: { send: { type: "body", property: "reference" } } },
      ]),
    },
  ];
}

// ---------------------------------------------------------------------------------------------- payments and reports

const payment: INodeProperties[] = [
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    displayOptions: { show: { resource: ["payment"] } },
    options: [
      { name: "Get Many", value: "getAll", action: "Get many payments", routing: list("/payments", { invoice_id: "={{$parameter.invoiceFilter || undefined}}" }) },
      { name: "Record", value: "create", action: "Record a payment", routing: { request: { method: "POST", url: "/payments" } } },
    ],
    default: "create",
  },
  { displayName: "Invoice ID", name: "invoiceFilter", type: "string", default: "", description: "Only this invoice's payments", displayOptions: only(["payment"], ["getAll"]) },
  ...listing(["payment"]),
  { displayName: "Invoice ID", name: "invoice_id", type: "string", required: true, default: "", displayOptions: only(["payment"], ["create"]), routing: { send: { type: "body", property: "invoice_id" } } },
  {
    displayName: "Amount",
    name: "amount",
    type: "string",
    required: true,
    default: "",
    description: "In the invoice's currency, up to what is left to pay",
    displayOptions: only(["payment"], ["create"]),
    routing: { send: { type: "body", property: "amount" } },
  },
  {
    displayName: "Method",
    name: "method",
    type: "options",
    required: true,
    default: "bank_transfer",
    displayOptions: only(["payment"], ["create"]),
    options: [
      { name: "Bank Transfer", value: "bank_transfer" },
      { name: "Card", value: "card" },
      { name: "Cash", value: "cash" },
      { name: "Cheque", value: "cheque" },
      { name: "Digital Wallet", value: "digital_wallet" },
      { name: "Online Payment", value: "online_payment" },
      { name: "Other", value: "other" },
      { name: "UPI", value: "upi" },
    ],
    routing: { send: { type: "body", property: "method" } },
  },
  {
    displayName: "Additional Fields",
    name: "paymentFields",
    type: "collection",
    placeholder: "Add Field",
    default: {},
    displayOptions: only(["payment"], ["create"]),
    options: byLabel([
      { displayName: "Date", name: "date", type: "string", default: "", placeholder: "YYYY-MM-DD", description: "Empty: today in the Organization's time zone", routing: { send: { type: "body", property: "date" } } },
      idempotencyKey(true),
      { displayName: "Note", name: "note", type: "string", default: "", routing: { send: { type: "body", property: "note" } } },
      { displayName: "Reference", name: "reference", type: "string", default: "", description: "Like the bank's transaction number", routing: { send: { type: "body", property: "reference" } } },
    ]),
  },
];

const report: INodeProperties[] = [
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    displayOptions: { show: { resource: ["report"] } },
    options: [
      { name: "Get Summary", value: "summary", action: "Get the summary", description: "Invoiced, paid and outstanding, by currency", routing: { request: { method: "GET", url: "/reports/summary" } } },
      { name: "Get Unpaid by Age", value: "unpaid", action: "Get unpaid invoices by age", routing: { request: { method: "GET", url: "/reports/unpaid" } } },
    ],
    default: "summary",
  },
];

export class Hectile implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Hectile",
    name: "hectile",
    icon: { light: "file:../../icons/hectile.svg", dark: "file:../../icons/hectile.dark.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: "Customers, invoices, estimates, payments and reports in Hectile",
    defaults: { name: "Hectile" },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "hectileApi", required: true }],
    requestDefaults: {
      baseURL: "={{$credentials.baseUrl}}",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    },
    properties: [
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Customer", value: "customer" },
          { name: "Estimate", value: "estimate" },
          { name: "Invoice", value: "invoice" },
          { name: "Payment", value: "payment" },
          { name: "Report", value: "report" },
        ],
        default: "invoice",
      },
      ...customer,
      ...documents("estimate"),
      ...documents("invoice"),
      ...payment,
      ...report,
    ],
  };
}
