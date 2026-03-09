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
        const j = await smmPost(apiUrl, new URLSearchParams({ key: apiKey, action: 'add', service: o.serviceId, link: o.link, quantity: o.quantity }).toString());
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
          await fbPatch(`/orders/${ordId}`, { status: mapped, remains: +(s.remains||0), startCount: +(s.start_count||o.startCount||0) });
          console.log(`[STATUS] ${ordId}: ${o.status} → ${mapped}`);
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
