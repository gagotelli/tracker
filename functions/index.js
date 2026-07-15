/**
 * functions/index.js
 *
 * The only thing in this project that ever sees the PocketSmith developer key.
 * It writes to trackers/{uid}.bank and trackers/{uid}.latitude, which the
 * browser reads through its existing onSnapshot listener. The browser never
 * calls PocketSmith directly.
 *
 * PocketSmith has no concept of "one feed per bank": connecting Latitude just
 * adds more accounts under the same /me and /transaction_accounts calls you
 * already had for CommBank. So this still only ever hits PocketSmith once per
 * sync, then splits the result by account.institution.title into groups
 * before writing. Both the CommBank and Latitude "Sync now" buttons trigger
 * the exact same full refresh, they just read back their own half of it.
 *
 * Deploy:  firebase deploy --only functions
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const PS_KEY = defineSecret("POCKETSMITH_KEY");
const OWNER_UID = defineSecret("OWNER_UID");

const REGION = "australia-southeast1";
const API = "https://api.pocketsmith.com/v2";
const WINDOW_DAYS = 35;      // how far back to pull transactions
const RECENT_COUNT = 12;     // how many to surface on the dashboard

// Both patterns are matched explicitly now. Previously only Latitude was
// matched and *everything else* fell into the CommBank bucket by default,
// which meant any other institution connected in PocketSmith (a savings
// account, a joint account, anything) silently got counted as CommBank
// earning/spending and inflated that panel's numbers. Now anything matching
// neither pattern goes to `other` and gets logged instead of merged in, so
// it's visible in the logs rather than corrupting a named panel.
// If PocketSmith shows a connection under a different title, widen these.
const COMMBANK_MATCH = /commbank|commonwealth/i;
const LATITUDE_MATCH = /latitude/i;

const round2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const pretty = (s) =>
  new Date(s + "T00:00:00").toLocaleDateString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
  });

async function psGet(url, key) {
  const res = await fetch(url, {
    headers: { "X-Developer-Key": key, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`PocketSmith ${res.status} on ${url.replace(/\?.*/, "")}`);
  }
  return res;
}

// Builds the `bank`-shaped payload (accounts/recent/summary) for a subset of
// accounts and the transactions that belong to them. Same shape either group
// ends up with, so the front end's renderFeedPanel can't tell them apart.
function buildFeed(accounts, txnsForGroup, from, to) {
  const earning = txnsForGroup.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const spending = txnsForGroup.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const difference = earning - spending;
  const savingsRate = earning > 0 ? (difference / earning) * 100 : 0;

  const recent = txnsForGroup
    .slice()
    .sort((a, b) => (a.date === b.date ? b.id - a.id : b.date.localeCompare(a.date)))
    .slice(0, RECENT_COUNT)
    .map((t) => ({
      date: t.date,
      payee: t.payee || "",
      amount: Number(t.amount || 0),
      accountId: t.transaction_account ? t.transaction_account.id : null,
    }));

  return {
    accounts,
    recent,
    summary: {
      earning: round2(earning),
      spending: round2(spending),
      difference: round2(difference),
      savingsRate: round2(savingsRate),
      from: pretty(from),
      to: pretty(to),
    },
    txnCount: txnsForGroup.length,
    lastSync: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function syncUser(uid, key) {
  const me = await (await psGet(`${API}/me`, key)).json();

  // ---- balances -----------------------------------------------------------
  const rawAccts = await (
    await psGet(`${API}/users/${me.id}/transaction_accounts`, key)
  ).json();

  // DIAGNOSTIC, remove once due dates are sorted out: dumps every field
  // PocketSmith actually returns for the first account, so we can check the
  // Cloud Functions logs for anything due-date-shaped (current_balance_date
  // is a balance timestamp, not a bill due date, everything else here is
  // unconfirmed). Doesn't touch Firestore or the client, log-only.
  if (rawAccts.length) {
    console.log("PocketSmith transaction_account field dump (first account):",
      JSON.stringify(rawAccts[0], null, 2));
  }

  const accounts = rawAccts.map((a) => ({
    id: a.id,
    name: a.name,
    // stored so the client can show the last four; the client masks the rest
    number: a.number || "",
    type: a.type,
    currency: a.currency_code,
    institution: a.institution ? a.institution.title : null,
    // liabilities arrive negative. Leave the sign alone.
    balance: Number(a.current_balance || 0),
    balanceDate: a.current_balance_date || null,
  }));

  const latitudeAccounts = accounts.filter((a) => LATITUDE_MATCH.test(a.institution || ""));
  const bankAccounts = accounts.filter((a) => COMMBANK_MATCH.test(a.institution || ""));
  const otherAccounts = accounts.filter(
    (a) => !LATITUDE_MATCH.test(a.institution || "") && !COMMBANK_MATCH.test(a.institution || "")
  );
  if (otherAccounts.length) {
    console.warn(
      "Accounts matching neither CommBank nor Latitude, excluded from both feeds:",
      otherAccounts.map((a) => `${a.name} (${a.institution})`)
    );
  }

  const latitudeIds = new Set(latitudeAccounts.map((a) => a.id));
  const bankIds = new Set(bankAccounts.map((a) => a.id));

  // ---- transactions -------------------------------------------------------
  const from = iso(new Date(Date.now() - WINDOW_DAYS * 864e5));
  const to = iso(new Date());

  let url = `${API}/users/${me.id}/transactions?start_date=${from}&end_date=${to}&per_page=100`;
  const all = [];

  while (url) {
    const res = await psGet(url, key);
    const page = await res.json();
    all.push(...page);

    // pagination lives in the Link header, not the body
    const link = res.headers.get("link") || "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  // Full history into a subcollection, keyed on the PocketSmith transaction id
  // with merge:true, so re-running this is idempotent and never duplicates.
  for (let i = 0; i < all.length; i += 450) {
    const batch = db.batch();
    for (const t of all.slice(i, i + 450)) {
      batch.set(
        db.doc(`trackers/${uid}/transactions/${t.id}`),
        {
          id: t.id,
          date: t.date,
          payee: t.payee || "",
          amount: Number(t.amount || 0),
          accountId: t.transaction_account ? t.transaction_account.id : null,
          category: t.category ? t.category.title : null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }

  const latitudeTxns = all.filter(
    (t) => t.transaction_account && latitudeIds.has(t.transaction_account.id)
  );
  const bankTxns = all.filter(
    (t) => t.transaction_account && bankIds.has(t.transaction_account.id)
  );

  // ---- write both feeds in one shot, so they're always in sync with
  // each other and never show two different "last synced" times -----------
  await db.doc(`trackers/${uid}`).set(
    {
      bank: buildFeed(bankAccounts, bankTxns, from, to),
      latitude: buildFeed(latitudeAccounts, latitudeTxns, from, to),
    },
    { merge: true } // only ever touches `bank`/`latitude`, never `store`
  );

  return {
    bankAccounts: bankAccounts.length,
    latitudeAccounts: latitudeAccounts.length,
    otherAccounts: otherAccounts.length,
    transactions: all.length,
  };
}

exports.syncBankScheduled = onSchedule(
  {
    schedule: "every 4 hours",
    timeZone: "Australia/Sydney",
    region: REGION,
    secrets: [PS_KEY, OWNER_UID],
  },
  async () => {
    const r = await syncUser(OWNER_UID.value(), PS_KEY.value());
    console.log("scheduled sync", r);
  }
);

exports.syncBankNow = onCall(
  { region: REGION, secrets: [PS_KEY, OWNER_UID] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    if (request.auth.uid !== OWNER_UID.value()) {
      throw new HttpsError("permission-denied", "Not your tracker.");
    }
    return await syncUser(request.auth.uid, PS_KEY.value());
  }
);

// Same underlying pull as syncBankNow (PocketSmith doesn't separate by
// institution), kept as its own callable so the Latitude "Sync now" button
// has something to call. Either button refreshes both feeds.
exports.syncLatitudeNow = onCall(
  { region: REGION, secrets: [PS_KEY, OWNER_UID] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    if (request.auth.uid !== OWNER_UID.value()) {
      throw new HttpsError("permission-denied", "Not your tracker.");
    }
    return await syncUser(request.auth.uid, PS_KEY.value());
  }
);
