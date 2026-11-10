'use strict';

/*
 * PPC (ΔΕΗ) customer care demo for an AudioCodes Live Hub AI agent. All data is FICTITIOUS.
 *
 * Agent tools (POST, JSON body):
 *   POST /api/customer/lookup     { customer_number, surname, caller_language }
 *   POST /api/bills               { customer_number, supply_type }          supply_type: electricity | gas
 *   POST /api/rewards             { customer_number }
 *   POST /api/rewards/redeem      { customer_number, supply_type, miles }
 *   POST /api/requests            { customer_number, supply_type, request_type, details, new_value }
 *   POST /api/requests/status     { request_id | customer_number }
 *
 * Back office / website:
 *   GET    /api/activity          support requests and miles redemptions, newest first
 *   GET    /api/customers         demo customers with supplies and balances
 *   PATCH  /api/requests/:id      { status }
 *   DELETE /api/activity          reset to the demo history (?mode=empty clears the requests)
 *   GET    /healthz
 *
 * Environment: PORT, DATA_DIR, API_KEY (optional X-API-Key on agent tools),
 *              ADMIN_TOKEN (optional X-Admin-Token on back-office changes), SEED_DEMO (default true).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLANS, SEASON, CUSTOMERS, COUPONS, MILES_ACTIONS, MILES_PER_EURO } = require('./customers');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const API_KEY = process.env.API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SEED_DEMO = (process.env.SEED_DEMO || 'true') !== 'false';
const TZ = 'Europe/Athens';

// ---------- helpers ----------
function clean(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return /^\{\{.*\}\}$/.test(s) || /^\{[a-z_]+\}$/i.test(s) ? '' : s;
}
function norm(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const r2 = (n) => Math.round(n * 100) / 100;
function athensToday() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(d + 'T12:00:00Z');
}
const iso = (d) => d.toISOString().slice(0, 10);
function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
function spoken(d) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(d); }
function monthName(d) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(d); }
function seeded(seedStr) {
  let x = 0;
  for (const ch of seedStr) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}
const SUPPLY_LABEL = { electricity: 'Electricity', gas: 'Natural gas' };
function supplyType(v) {
  const s = norm(v);
  if (!s) return '';
  if (/gas|αερι|αεριο|γκαζ|φυσικ/.test(s)) return 'gas';
  if (/elec|ρευμα|ηλεκτρ|power|ρευ/.test(s)) return 'electricity';
  return '';
}

// ---------- state ----------
let state = null;

function buildBills(cust, sup, today) {
  const plan = PLANS[sup.plan];
  const rnd = seeded(cust.customer_number + sup.type);
  // Latest bill: issued on the 5th of this month (or last month if we are before the 5th).
  let issue = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 5, 12));
  if (issue > today) issue = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 5, 12));
  const bills = [];
  for (let k = 0; k < 6; k++) {
    const iss = new Date(Date.UTC(issue.getUTCFullYear(), issue.getUTCMonth() - k, 5, 12));
    const periodStart = new Date(Date.UTC(iss.getUTCFullYear(), iss.getUTCMonth() - 1, 1, 12));
    const kwh = Math.round(sup.base_kwh * SEASON[sup.type][periodStart.getUTCMonth()] * (0.92 + rnd() * 0.16));
    const amount = r2(plan.fixed_month + kwh * plan.price_kwh);
    const due = addDays(iss, 20);
    const unpaid = k < sup.unpaid_months;
    let status = 'paid';
    if (unpaid) status = due < today ? 'overdue' : 'unpaid';
    if (sup.direct_debit) status = due < today ? 'paid' : 'scheduled_direct_debit';
    bills.push({
      bill_id: `B-${cust.customer_number}-${sup.type === 'gas' ? 'G' : 'E'}-${iso(iss).slice(2, 7).replace('-', '')}`,
      period: monthName(periodStart),
      issue_date: iso(iss), due_date: iso(due),
      consumption_kwh: kwh, amount_eur: amount, amount_due_eur: status === 'paid' ? 0 : amount,
      status, paid_on: status === 'paid' ? iso(addDays(due, -Math.floor(rnd() * 8))) : null,
    });
  }
  return bills;
}

function buildState() {
  const today = athensToday();
  const accounts = {};
  for (const c of CUSTOMERS) {
    accounts[c.customer_number] = {
      billing_address: c.billing_address,
      rewards: { ...c.rewards },
      supplies: c.supplies.map((s) => ({ ...s, credit_eur: 0, bills: buildBills(c, s, today) })),
    };
  }
  const requests = SEED_DEMO ? demoRequests(today) : [];
  return { built_on: iso(today), accounts, requests, redemptions: [] };
}

function demoRequests(today) {
  const at = (daysAgo, h) => { const d = addDays(today, -daysAgo); d.setUTCHours(h, 12, 0, 0); return d.toISOString(); };
  const mk = (id, cust, supply, type, status, daysAgo, h, details, extra = {}) => ({
    id, customer_number: cust, customer_name: CUSTOMERS.find((c) => c.customer_number === cust).name_el,
    supply_type: supply, request_type: type, status, details, new_value: extra.new_value || '',
    channel: extra.channel || 'Voice care line', caller_language: extra.lang || 'Greek', demo_history: true,
    created_at: at(daysAgo, h), updated_at: at(Math.max(0, daysAgo - (extra.took || 0)), h + 1),
  });
  return [
    mk('SR-48210', '300419', 'electricity', 'billing_address_change', 'in_progress', 3, 9, 'Αποστολή λογαριασμών στη Λεωφ. Ικάρου 30 αντί για τη διεύθυνση της παροχής', { new_value: 'Λεωφ. Ικάρου 30, 712 01 Ηράκλειο' }),
    mk('SR-48177', '300552', 'electricity', 'name_change', 'awaiting_documents', 2, 13, 'Νέος υπόχρεος μετά από αλλαγή μισθωτηρίου. Στάλθηκε SMS για τα δικαιολογητικά', { lang: 'English', new_value: 'Emma Miller' }),
    mk('SR-47952', '300248', 'electricity', 'bill_dispute', 'completed', 41, 11, 'Ερώτημα για υψηλή κατανάλωση. Η ένδειξη του μετρητή επιβεβαιώθηκε σωστή', { took: 9, channel: 'myΔΕΗ app' }),
    mk('SR-47731', '300125', 'electricity', 'ebill_activation', 'completed', 63, 8, 'Ενεργοποίηση μηνιαίου e-λογαριασμού. Πιστώθηκαν 500 μίλια Miles+Bonus', { took: 0 }),
    mk('SR-47690', '300376', 'gas', 'direct_debit_activation', 'completed', 96, 10, 'Ενεργοποίηση πάγιας εντολής για την παροχή φυσικού αερίου', { took: 4, channel: 'PPC store' }),
    mk('SR-47512', '300376', 'electricity', 'rewards_linking', 'completed', 120, 15, 'Σύνδεση λογαριασμού Miles+Bonus με το myRewards', { took: 1, channel: 'myΔΕΗ app' }),
    mk('SR-47488', '300552', 'gas', 'meter_reading', 'completed', 34, 12, 'Ο πελάτης έδωσε ένδειξη μετρητή φυσικού αερίου', { lang: 'English', new_value: '04512', took: 0 }),
    mk('SR-47301', '300125', 'gas', 'payment_link', 'completed', 28, 18, 'Στάλθηκε σύνδεσμος πληρωμής με SMS για τον λογαριασμό φυσικού αερίου', { took: 0 }),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) { console.error('Could not load state:', err.message); }
  if (!state || !state.accounts) { state = buildState(); save(); console.log('Built demo state'); }
}
function save() {
  try { const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, DATA_FILE); }
  catch (err) { console.error('Could not save state:', err.message); }
}

function findCustomer(num) {
  const n = String(num || '').replace(/\D/g, '');
  return CUSTOMERS.find((c) => c.customer_number === n) || null;
}
// Speech recognition can add, drop or change one digit ("3 0 0 0 1 2 5"). Accept a number one edit away,
// but ONLY together with a matching surname, so verification still depends on the surname.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function findCustomerFuzzy(num, surname) {
  const n = String(num || '').replace(/\D/g, '');
  if (!n || !clean(surname)) return null;
  const hits = CUSTOMERS.filter((c) => editDistance(n, c.customer_number) <= 1 && surnameMatches(c, surname));
  return hits.length === 1 ? hits[0] : null;
}
function surnameMatches(c, surname) {
  const s = norm(surname);
  if (!s) return false;
  return c.surnames.some((x) => { const y = norm(x); return s.includes(y) || y.includes(s) || (s.length >= 5 && y.slice(0, 5) === s.slice(0, 5)); });
}
function balance(sup) { return r2(Math.max(0, sup.bills.reduce((n, b) => n + b.amount_due_eur, 0) - sup.credit_eur)); }
function rfCode(cust, sup) { return 'RF' + (Number(cust.customer_number) * 7 + (sup.type === 'gas' ? 11 : 3)).toString().padStart(9, '0') + '00' + cust.customer_number; }

function pickSupply(cust, acct, type) {
  const t = supplyType(type);
  if (t) return acct.supplies.find((s) => s.type === t) || null;
  return acct.supplies.length === 1 ? acct.supplies[0] : null;
}
function needSupplyAnswer(acct) {
  return { success: false, needs_supply_type: true,
    message: 'This customer has both electricity and natural gas. Ask the caller which supply they mean, then call again with supply_type electricity or gas.',
    supplies: acct.supplies.map((s) => s.type) };
}

function requireHeader(name, expected) {
  return (req, res, next) => (!expected || req.get(name) === expected ? next() : res.status(401).json({ success: false, error: `Missing or wrong ${name} header.` }));
}
const agentAuth = requireHeader('X-API-Key', API_KEY);
const adminAuth = requireHeader('X-Admin-Token', ADMIN_TOKEN);

function newId(prefix) {
  const all = new Set([...state.requests.map((r) => r.id), ...state.redemptions.map((r) => r.id)]);
  let id; do { id = prefix + (10000 + crypto.randomInt(90000)); } while (all.has(id));
  return id;
}
const digits = (id) => id.replace(/\D/g, '').split('').join(' ');

// ---------- request types ----------
const REQUEST_TYPES = {
  billing_address_change: { label: 'Billing address change', needs: 'new_value (the new postal address for bills)', status: 'received',
    next: 'The new billing address applies from the next bill. Processing usually takes up to 10 days; the customer gets a confirmation by SMS or e-mail. There is no charge.' },
  name_change: { label: 'Name / account holder change', needs: 'new_value (full name of the new holder)', status: 'awaiting_documents',
    next: 'An SMS link was sent to upload the documents: ID of the new holder, tax number (AFM), and proof of right to use the property (title deed or lease). Processing takes up to 10 working days after the documents arrive.' },
  ebill_activation: { label: 'e-bill activation', status: 'completed',
    next: 'Monthly e-bill is active from the next bill; paper bills stop.' },
  direct_debit_activation: { label: 'Standing order (direct debit)', status: 'awaiting_customer',
    next: 'For security, bank details are never taken by phone. An SMS link was sent to enter the IBAN; the standing order starts from the next bill after it is completed.' },
  payment_link: { label: 'Payment link', status: 'completed',
    next: 'A payment link and the RF payment code were sent by SMS. The bill can be paid by card through the link, by e-banking with the RF code, in the myΔΕΗ app or at PPC stores.' },
  payment_arrangement: { label: 'Payment arrangement', needs: 'details (e.g. number of instalments requested)', status: 'received',
    next: 'A payment arrangement request was opened. A specialist reviews it within 3 working days and contacts the customer with the proposed instalments.' },
  bill_dispute: { label: 'Bill query / dispute', needs: 'details (what the customer thinks is wrong)', status: 'received',
    next: 'The bill is being reviewed. The customer is contacted within 15 days. Payment of the disputed bill can wait until the review ends.' },
  meter_reading: { label: 'Meter reading submission', needs: 'new_value (the meter reading digits)', status: 'completed',
    next: 'The reading was recorded and will be used for the next bill.' },
  rewards_linking: { label: 'Link Miles+Bonus to myRewards', status: 'awaiting_customer',
    next: 'An SMS link was sent to connect the AEGEAN Miles+Bonus account to myRewards. After linking, miles from PPC actions are credited automatically.' },
  other: { label: 'Other request', status: 'received', next: 'The request was passed to the customer care team, who will contact the customer within 2 working days.' },
};
function requestType(v) {
  const s = norm(v).replace(/ /g, '_');
  if (REQUEST_TYPES[s]) return s;
  if (/address|διευθυνσ/.test(s)) return 'billing_address_change';
  if (/name|ονομ|holder|υποχρε/.test(s)) return 'name_change';
  if (/ebill|e_bill|electronic|ηλεκτρονικ/.test(s)) return 'ebill_activation';
  if (/debit|standing|παγια/.test(s)) return 'direct_debit_activation';
  if (/link|pay_by|πληρωμ/.test(s)) return 'payment_link';
  if (/arrange|instal|διακανον|δοσ/.test(s)) return 'payment_arrangement';
  if (/dispute|complain|wrong|λαθ|αμφισβ/.test(s)) return 'bill_dispute';
  if (/meter|reading|ενδειξ|μετρητ/.test(s)) return 'meter_reading';
  if (/miles|reward|link_rew/.test(s)) return 'rewards_linking';
  return 'other';
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use('/api', express.text({ type: '*/*', limit: '64kb' }), (req, res, next) => {
  if (typeof req.body === 'string' && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch { return res.status(400).json({ success: false, error: 'Body must be JSON.' }); }
  } else if (typeof req.body !== 'object' || req.body === null) req.body = {};
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, requests: state.requests.length }));

app.post('/api/customer/lookup', agentAuth, (req, res) => {
  const surname = clean(req.body.surname);
  let c = findCustomer(req.body.customer_number);
  let corrected = false;
  if (!c) { c = findCustomerFuzzy(req.body.customer_number, surname); corrected = Boolean(c); }
  if (!c) return res.json({ found: false, message: 'No customer with that number. Read the number back to the caller digit by digit and ask them to confirm or repeat it. Customer numbers have exactly 6 digits.' });
  if (!surname) return res.json({ found: true, verified: false, message: 'Customer number found. Ask for the account holder\'s surname to verify, then call again with surname.' });
  if (!surnameMatches(c, surname)) return res.json({ found: true, verified: false, message: 'The surname does not match this customer number. Ask the caller to repeat the surname or the customer number. Do not share any account details.' });
  const acct = state.accounts[c.customer_number];
  const open = state.requests.filter((r) => r.customer_number === c.customer_number && !['completed', 'rejected'].includes(r.status));
  res.json({
    found: true, verified: true,
    customer_number: c.customer_number,
    ...(corrected ? { note: `The number heard (${String(req.body.customer_number).replace(/\D/g, '')}) was corrected to ${c.customer_number} using the surname. Use ${c.customer_number} in all further tool calls.` } : {}), account_holder: c.name_el, account_holder_latin: c.name_en,
    supplies: acct.supplies.map((s) => ({ supply_type: s.type, label: SUPPLY_LABEL[s.type], address: s.address, plan: s.plan,
      supply_number_last4: s.supply_number.replace(/\s/g, '').slice(-4), balance_due_eur: balance(s) })),
    has_electricity_and_gas: acct.supplies.length > 1,
    myrewards_member: acct.rewards.member,
    open_requests: open.map((r) => ({ request_id: r.id, type: REQUEST_TYPES[r.request_type].label, status: r.status })),
    mobile_last_digits: c.mobile_last3,
  });
});

app.post('/api/bills', agentAuth, (req, res) => {
  const c = findCustomer(req.body.customer_number);
  if (!c) return res.status(400).json({ success: false, error: 'Unknown customer number. Verify the customer first.' });
  const acct = state.accounts[c.customer_number];
  const sup = pickSupply(c, acct, req.body.supply_type);
  if (!sup) return res.json(needSupplyAnswer(acct));
  const [latest, ...older] = sup.bills;
  res.json({
    success: true, supply_type: sup.type, supply_label: SUPPLY_LABEL[sup.type], plan: sup.plan, supply_address: sup.address,
    balance_due_eur: balance(sup), credit_from_miles_eur: sup.credit_eur,
    latest_bill: { ...latest, due_spoken: spoken(new Date(latest.due_date + 'T12:00:00Z')) },
    previous_bills: older.slice(0, 3).map((b) => ({ period: b.period, amount_eur: b.amount_eur, status: b.status, consumption_kwh: b.consumption_kwh })),
    overdue_bills: sup.bills.filter((b) => b.status === 'overdue').map((b) => ({ period: b.period, amount_eur: b.amount_due_eur, due_date: b.due_date })),
    direct_debit: sup.direct_debit, ebill: sup.ebill, rf_payment_code: rfCode(c, sup),
    payment_options: 'Card via payment link (SMS), e-banking or bank with the RF code, myΔΕΗ app, PPC stores, standing order.',
  });
});

app.post('/api/rewards', agentAuth, (req, res) => {
  const c = findCustomer(req.body.customer_number);
  if (!c) return res.status(400).json({ success: false, error: 'Unknown customer number.' });
  const r = state.accounts[c.customer_number].rewards;
  res.json({
    success: true, myrewards_member: r.member, miles_plus_bonus_linked: r.miles_linked, miles_balance: r.miles_balance,
    miles_value_eur: Math.floor(r.miles_balance / MILES_PER_EURO), redemption_rate: `${MILES_PER_EURO} miles = 1 EUR off a PPC bill`,
    coupons_claimed: r.coupons_claimed, coupons_available: COUPONS.map((x) => x.title),
    ways_to_earn_miles: MILES_ACTIONS.map((a) => `${a.action}: ${a.miles} miles`),
    note: r.member ? (r.miles_linked ? '' : 'Miles+Bonus is not linked yet; offer to send the linking SMS (request_type rewards_linking).')
      : 'Not a myRewards member yet; membership is free in the myΔΕΗ app.',
  });
});

app.post('/api/rewards/redeem', agentAuth, (req, res) => {
  const c = findCustomer(req.body.customer_number);
  if (!c) return res.status(400).json({ success: false, error: 'Unknown customer number.' });
  const acct = state.accounts[c.customer_number];
  const r = acct.rewards;
  if (!r.member || !r.miles_linked) return res.json({ success: false, message: 'Miles+Bonus is not linked for this customer, so miles cannot be redeemed yet.' });
  const sup = pickSupply(c, acct, req.body.supply_type);
  if (!sup) return res.json(needSupplyAnswer(acct));
  let miles = parseInt(String(req.body.miles || '').replace(/\D/g, ''), 10);
  if (!miles || miles >= r.miles_balance) miles = r.miles_balance; // "all my miles"
  const euros = Math.floor(miles / MILES_PER_EURO);
  if (euros < 1) return res.json({ success: false, message: `At least ${MILES_PER_EURO} miles are needed; the customer has ${r.miles_balance}.` });
  const used = euros * MILES_PER_EURO;
  r.miles_balance -= used;
  sup.credit_eur = r2(sup.credit_eur + euros);
  const red = { id: newId('RW-'), kind: 'redemption', customer_number: c.customer_number, customer_name: c.name_el, supply_type: sup.type,
    miles_used: used, credit_eur: euros, miles_left: r.miles_balance, created_at: new Date().toISOString() };
  state.redemptions.unshift(red);
  save();
  res.json({ success: true, redemption_id: red.id, redemption_id_spoken: 'RW ' + digits(red.id), miles_used: used, credit_eur: euros,
    miles_left: r.miles_balance, supply_type: sup.type, new_balance_due_eur: balance(sup),
    message: `${used} miles redeemed for a ${euros} EUR credit on the ${SUPPLY_LABEL[sup.type].toLowerCase()} bill. New balance due: ${balance(sup).toFixed(2)} EUR. Miles left: ${r.miles_balance}.` });
});

app.post('/api/requests', agentAuth, (req, res) => {
  const b = req.body;
  const c = findCustomer(b.customer_number);
  if (!c) return res.status(400).json({ success: false, error: 'Unknown customer number. Verify the customer first.' });
  const acct = state.accounts[c.customer_number];
  const type = requestType(b.request_type);
  const def = REQUEST_TYPES[type];
  const sup = pickSupply(c, acct, b.supply_type);
  const accountLevel = ['rewards_linking', 'billing_address_change', 'name_change'].includes(type) && !supplyType(b.supply_type);
  if (!sup && !accountLevel) return res.json(needSupplyAnswer(acct));
  const newValue = clean(b.new_value);
  if (['billing_address_change', 'name_change', 'meter_reading'].includes(type) && !newValue) {
    return res.json({ success: false, message: `For ${def.label} the new_value is required: ${def.needs}. Ask the caller and call again.` });
  }
  const item = { id: newId('SR-'), customer_number: c.customer_number, customer_name: c.name_el,
    supply_type: sup ? sup.type : 'all', request_type: type, status: def.status, details: clean(b.details), new_value: newValue,
    channel: 'Voice care line', caller_language: clean(b.caller_language), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  let extra = {};
  if (type === 'ebill_activation' && sup) {
    sup.ebill = true;
    if (acct.rewards.member && acct.rewards.miles_linked) { acct.rewards.miles_balance += 500; extra.miles_awarded = 500; }
  }
  if (type === 'payment_link' && sup) { extra.amount_eur = balance(sup); extra.rf_payment_code = rfCode(c, sup); extra.sms_to = `mobile ending ${c.mobile_last3}`; }
  if (['name_change', 'direct_debit_activation', 'rewards_linking'].includes(type)) extra.sms_to = `mobile ending ${c.mobile_last3}`;
  state.requests.unshift(item);
  save();
  res.status(201).json({ success: true, request_id: item.id, request_id_spoken: 'SR ' + digits(item.id), request_type: def.label,
    supply_type: item.supply_type, status: item.status, next_steps: def.next, ...extra });
});

app.post('/api/requests/status', agentAuth, (req, res) => {
  const idDigits = clean(req.body.request_id).replace(/\D/g, '');
  let list = idDigits ? state.requests.filter((r) => r.id.replace(/\D/g, '') === idDigits) : [];
  if (!list.length) {
    const c = findCustomer(req.body.customer_number);
    if (c) list = state.requests.filter((r) => r.customer_number === c.customer_number).slice(0, 3);
  }
  if (!list.length) return res.json({ found: false, message: 'No request found for that request number or customer.' });
  res.json({ found: true, requests: list.map((r) => ({ request_id: r.id, request_id_spoken: 'SR ' + digits(r.id), type: REQUEST_TYPES[r.request_type].label,
    supply_type: r.supply_type, status: r.status, opened: r.created_at.slice(0, 10), last_update: r.updated_at.slice(0, 10), details: r.details, next_steps: REQUEST_TYPES[r.request_type].next })) });
});

// ---------- back office ----------
app.get('/api/activity', (req, res) => {
  const reqs = state.requests.map((r) => ({ kind: 'request', label: REQUEST_TYPES[r.request_type].label, ...r }));
  const all = [...reqs, ...state.redemptions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ items: all.slice(0, 300) });
});
app.get('/api/customers', (req, res) => {
  res.json({ customers: CUSTOMERS.map((c) => {
    const a = state.accounts[c.customer_number];
    return { customer_number: c.customer_number, name: c.name_el, name_latin: c.name_en, surname_hint: c.surnames[0], language: c.preferred_language,
      billing_address: a.billing_address, myrewards: a.rewards,
      supplies: a.supplies.map((s) => ({ type: s.type, plan: s.plan, address: s.address, balance_due_eur: balance(s), ebill: s.ebill, direct_debit: s.direct_debit,
        latest_bill: s.bills[0], overdue: s.bills.some((b) => b.status === 'overdue') })) };
  }) });
});
const STATUSES = ['received', 'awaiting_documents', 'awaiting_customer', 'in_progress', 'completed', 'rejected'];
app.patch('/api/requests/:id', adminAuth, (req, res) => {
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ success: false, error: 'Request not found.' });
  const s = clean(req.body.status);
  if (!STATUSES.includes(s)) return res.status(400).json({ success: false, error: 'status must be one of ' + STATUSES.join(', ') });
  r.status = s; r.updated_at = new Date().toISOString();
  if (s === 'completed' && r.request_type === 'billing_address_change' && r.new_value) state.accounts[r.customer_number].billing_address = r.new_value;
  save();
  res.json({ success: true, request: r });
});
app.delete('/api/activity', adminAuth, (req, res) => {
  state = buildState();
  if (req.query.mode === 'empty') state.requests = [];
  save();
  res.json({ success: true, requests: state.requests.length });
});
app.get('/api/config', (req, res) => res.json({ adminTokenRequired: Boolean(ADMIN_TOKEN) }));
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Unknown endpoint.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/backoffice', (req, res) => res.redirect(301, '/backoffice/'));

load();
// Rebuild bills each new day so due dates stay realistic (requests are kept).
if (state.built_on !== iso(athensToday())) { const reqs = state.requests, reds = state.redemptions; state = buildState(); state.requests = reqs.length ? reqs : state.requests; state.redemptions = reds; save(); }
app.listen(PORT, () => console.log(`PPC care demo on :${PORT}`));
