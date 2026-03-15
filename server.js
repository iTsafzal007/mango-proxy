const http = require('http');
const https = require('https');
const { URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const FB_URL = 'https://ayebazzar-default-rtdb.asia-southeast1.firebasedatabase.app';

function smmPost(apiUrl, postData) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: 'parse', raw: d.slice(0,100) }); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function fbGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`${FB_URL}${path}.json`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

function fbPatch(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: new URL(FB_URL).hostname,
      path: path + '.json',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let syncing = false;
async function autoSync() {
  if (syncing) return;
  syncing = true;
  try {
    const settings = await fbGet('/settings');
    if (!settings?.apiKey || !settings?.apiUrl) return;
    const { apiKey, apiUrl } = settings;

    const orders = await fbGet('/orders');
    if (!orders) return;
    const entries = Object.entries(orders);

    // 1. Deliver Wait for Confirm
    const waiting = entries.filter(([, o]) =>
      o.apiOrderId === 'Wait for Confirm' && o.serviceId && o.link && o.quantity
    );
    for (const [id, o] of waiting) {
      try {
        // Use provider if order has one
        let useUrl = apiUrl, useKey = apiKey;
        if (o.providerId) {
          const provSnap = await fbGet(`/apiProviders/${o.providerId}`);
          if (provSnap && provSnap.apiUrl) { useUrl = provSnap.apiUrl; useKey = provSnap.apiKey; }
        }
        const j = await smmPost(useUrl, new URLSearchParams({ key: useKey, action: 'add', service: o.serviceId, link: o.link, quantity: o.quantity }).toString());
        if (j?.order) {
          await fbPatch(`/orders/${id}`, { apiOrderId: String(j.order), status: 'inprogress', needBalance: false, apiError: null });
          console.log(`[DELIVER] ${id} → #${j.order}`);
        } else if (j?.error) {
          await fbPatch(`/orders/${id}`, { apiError: j.error });
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }

    // 2. Sync active statuses
    const active = entries.filter(([, o]) =>
      (o.status === 'inprogress' || o.status === 'pending' || o.status === 'processing')
      && o.apiOrderId && o.apiOrderId !== 'Wait for Confirm'
    );
    if (!active.length) return;

    const stMap = { 'pending':'pending','in progress':'inprogress','inprogress':'inprogress','processing':'processing','completed':'completed','partial':'partial','canceled':'canceled','cancelled':'canceled' };

    for (let i = 0; i < active.length; i += 100) {
      const batch = active.slice(i, i + 100);
      const ids = batch.map(([, o]) => o.apiOrderId).join(',');
      try {
        const result = await smmPost(apiUrl, new URLSearchParams({ key: apiKey, action: 'status', orders: ids }).toString());
        if (!result || typeof result !== 'object') continue;
        for (const [ordId, o] of batch) {
          const s = result[o.apiOrderId] || result[String(o.apiOrderId)];
          if (!s) continue;
          const mapped = stMap[(s.status || '').toLowerCase()];
          if (!mapped || mapped === o.status) continue;

          const newRemains = +(s.remains||0);
          const newSc = +(s.start_count||o.startCount||0);

          // Update order status
          await fbPatch(`/orders/${ordId}`, { status: mapped, remains: newRemains, startCount: newSc });
          console.log(`[STATUS] ${ordId}: ${o.status} → ${mapped}`);

          // ✅ CANCELED → Full refund
          if (mapped === 'canceled' && o.userId && !o.cancelRefund) {
            try {
              const userSnap = await fbGet(`/users/${o.userId}`);
              if (userSnap) {
                const refundAmt = parseFloat((+(o.charge||0)).toFixed(6));
                const newBal = parseFloat((+(userSnap.balance||0) + refundAmt).toFixed(6));
                const newUsed = parseFloat(Math.max(0, +(userSnap.usedBalance||0) - refundAmt).toFixed(6));
                await fbPatch(`/users/${o.userId}`, { balance: newBal, usedBalance: newUsed });
                await fbPatch(`/orders/${ordId}`, { cancelRefund: refundAmt, cancelNote: `Full refund ৳${refundAmt.toFixed(4)} (auto-canceled)` });
                console.log(`[REFUND] Cancel full ৳${refundAmt} → ${o.userId}`);
              }
            } catch(e) { console.error('[CANCEL REFUND]', e.message); }
          }

          // ✅ PARTIAL → remains এর টাকা ফেরত
          if (mapped === 'partial' && o.userId && !o.partialRefund) {
            try {
              const totalQty = +(o.quantity||0);
              const remains = newRemains > 0 ? newRemains : +(o.remains||0);
              if (remains > 0 && totalQty > 0) {
                const userSnap = await fbGet(`/users/${o.userId}`);
                if (userSnap) {
                  const refundRatio = remains / totalQty;
                  const refundAmt = parseFloat((+(o.charge||0) * refundRatio).toFixed(6));
                  const deliveredQty = totalQty - remains;
                  const newBal = parseFloat((+(userSnap.balance||0) + refundAmt).toFixed(6));
                  const newUsed = parseFloat(Math.max(0, +(userSnap.usedBalance||0) - refundAmt).toFixed(6));
                  await fbPatch(`/users/${o.userId}`, { balance: newBal, usedBalance: newUsed });
                  await fbPatch(`/orders/${ordId}`, { partialRefund: refundAmt, partialNote: `${deliveredQty}/${totalQty} delivered. ৳${refundAmt.toFixed(4)} refunded.` });
                  console.log(`[REFUND] Partial ৳${refundAmt} (${deliveredQty}/${totalQty}) → ${o.userId}`);
                }
              }
            } catch(e) { console.error('[PARTIAL REFUND]', e.message); }
          }

          // ✅ Referral commission — completed/partial এ একবার
          if ((mapped === 'completed' || mapped === 'partial') && o.refBy && o.commissionOn && +(o.commission||0) > 0 && !o.commissionPaid) {
            try {
              const refUid = 'tg_' + o.refBy;
              const refUser = await fbGet(`/users/${refUid}`);
              if (refUser) {
                const comm = parseFloat(o.commission||0);
                await fbPatch(`/users/${refUid}`, {
                  balance: parseFloat((+(refUser.balance||0) + comm).toFixed(6)),
                  refEarnings: parseFloat((+(refUser.refEarnings||0) + comm).toFixed(6))
                });
                await fbPatch(`/orders/${ordId}`, { commissionPaid: true });
                console.log(`[COMMISSION] ৳${comm} → ${refUid}`);
              }
            } catch(e) { console.error('[COMMISSION]', e.message); }
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('[SYNC ERROR]', e.message);
  } finally {
    syncing = false;
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method === 'GET') { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) + 's' })); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'POST only' })); return; }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    const params = new URLSearchParams(body);
    const target = params.get('_target') || 'https://motherpanel.com/api/v2';
    params.delete('_target');
    try {
      const result = await smmPost(target, params.toString());
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Mango Proxy on port ${PORT}`);
  autoSync();
  setInterval(autoSync, 30 * 1000); // প্রতি ৩০ সেকেন্ডে
  console.log('🔄 Auto sync: every 30 seconds');
});
