// Transport investigation — controlled delayed-response server (NOT part of stratum).
// Accepts a request, holds it with ZERO response bytes for ?d=<ms> (default 1200000 = 20 min),
// then returns 200 with a tiny body. Logs every connection phase with ISO timestamps.
import http from 'node:http';

const PORT = 8443;
const t = () => new Date().toISOString();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const delay = Number(url.searchParams.get('d') ?? 1200000);
  const tag = url.searchParams.get('tag') ?? 'anon';
  console.log(`${t()} REQ tag=${tag} delay=${delay}ms remote=${req.socket.remoteAddress} path=${req.url}`);
  const started = Date.now();
  const hold = req.url.includes('hold-body')
    ? new Promise(() => {}) // never resolves: caller declared huge Content-Length, never sends body
    : new Promise(r => setTimeout(r, delay));
  hold.then(() => {
    const dur = Date.now() - started;
    console.log(`${t()} RESP tag=${tag} held=${dur}ms -> 200`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok-after-${dur}ms`);
  });
  req.on('error', e => console.log(`${t()} REQERR tag=${tag} ${e.code ?? e.message}`));
  res.on('close', () => {
    const dur = Date.now() - started;
    if (!res.writableEnded) console.log(`${t()} CLOSED-EARLY tag=${tag} after=${dur}ms (response never sent)`);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`${t()} listening 0.0.0.0:${PORT}`));
