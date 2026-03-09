const http = require('http');
const https = require('https');
const { URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({error:'POST only'})); return; }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const params = new URLSearchParams(body);
    const target = params.get('_target') || 'https://motherpanel.com/api/v2';
    params.delete('_target');
    const postData = params.toString();
    const url = new URL(target);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', d => data += d);
      apiRes.on('end', () => { res.writeHead(200); res.end(data); });
    });
    apiReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({error:e.message})); });
    apiReq.write(postData);
    apiReq.end();
  });
});

server.listen(PORT, () => console.log('Mango Proxy on port ' + PORT));
