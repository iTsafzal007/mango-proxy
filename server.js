const http = require('http');
const https = require('https');
const { URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;

// ── Firebase config (আপনার project এর) ──
const FB_URL = 'https://ayebazzar-default-rtdb.asia-southeast1.firebasedatabase.app';

// ── SMM API helper ──
function smmPost(apiUrl, postData) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ error: 'parse error', raw: d }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Firebase REST helper ──
function fbGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(FB_URL + path + '.json');
    https.get(url.href, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

function fbPatch(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(FB_URL + path + '.json');
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── AUTO STATUS SYNC — browser খোলা লাগবে না ──
async function autoStatusSync() {
  try {
    // 1. Settings থেকে API config নাও
    const settings = await fbGet('/settings');
    if (!settings || !settings.apiKey || !settings.apiUrl) return;
    const { apiKey, apiUrl } = settings;

    // 2. Active orders নাও (pending/inprogress/processing)
    const orders = await fbGet('/orders');
    if (!orders) return;

    const active = Object.entries(orders).filter(([, o]) =>
      (o.status === 'inprogress' || o.status === 'pending' || o.status === 'processing')
      && o.apiOrderId && o.apiOrderId !== 'Wait for Confirm'
    );

    if (!active.length) return;

    // 3. Max 100 orders per batch
    const batches = [];
    for (let i = 0; i < active.length; i += 100)
      batches.push(active.slice(i, i + 100));

    const stMap = {
      'pending': 'pending', 'in progress': 'inprogress', 'inprogress': 'inprogress',
      'processing': 'processing', 'completed': 'completed',
      'partial': 'partial', 'canceled': 'canceled', 'cancelled': 'canceled'
    };

    for (const batch of batches) {
      const ids = batch.map(([, o]) => o.apiOrderId).join(',');
      const result = await smmPost(apiUrl, new URLSearchParams({ key: apiKey, action: 'status', orders: ids }).toString());
      if (!result || typeof result !== 'object') continue;

      for (const [ordId, o] of batch) {
        const s = result[o.apiOrderId] || result[String(o.apiOrderId)];
        if (!s) continue;
        const mapped = stMap[(s.status || '').toLowerCase()];
        if (!mapped || mapped === o.status) continue;

        const upd = { status: mapped, remains: +(s.remains || 0), startCount: +(s.start_count || o.startCount || 0) };
        if (mapped === 'completed') upd.remains = 0;
        await fbPatch('/orders/' + ordId, upd);
        console.log(`[SYNC] Order ${ordId}: ${o.status} → ${mapped}`);
      }
    }

    // 4. Wait for Confirm orders — deliver করো
    const waitOrders = Object.entries(orders).filter(([, o]) =>
      o.apiOrderId === 'Wait for Confirm' && o.serviceId && o.link && o.quantity
    );

    for (const [ordId, o] of waitOrders) {
      try {
        const j = await smmPost(apiUrl, new URLSearchParams({
          key: apiKey, action: 'add',
          service: o.serviceId, link: o.link, quantity: o.quantity
        }).toString());
        if (j && j.order) {
          await fbPatch('/orders/' + ordId, { apiOrderId: String(j.order), status: 'inprogress', needBalance: false, apiError: null });
          console.log(`[DELIVER] Order ${ordId} → API #${j.order}`);
        }
      } catch (_) {}
    }

  } catch (e) {
    console.error('[SYNC ERROR]', e.message);
  }
}

// ── HTTP Proxy Server ──
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'Mango Proxy running' }));
    return;
  }

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
  console.log('✅ Mango Proxy running on port ' + PORT);

  // ── Start auto sync — প্রতি ৫ মিনিটে ──
  console.log('🔄 Auto status sync started (every 5 min)');
  autoStatusSync(); // immediately on start
  setInterval(autoStatusSync, 5 * 60 * 1000);
});
