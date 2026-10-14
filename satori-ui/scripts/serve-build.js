// Serve the production build. No dependencies — `serve` and `http-server` are not
// installed here and pulling one in at run time is not an option offline.
//
//   node scripts/serve-build.js [port] [dir]
//
// Binds 0.0.0.0 so the machine is reachable over a tailnet. There is no auth on
// this and none is intended: it serves a static bundle, and the bundle is public
// by nature. The tailnet is the boundary.
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 3032);
const root = path.resolve(process.argv[3] || path.join(__dirname, '..', 'build'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`no index.html under ${root} — run a build first`);
  process.exit(1);
}

http.createServer((req, res) => {
  // Strip the query, decode, and resolve INSIDE root. Rejecting anything that
  // escapes matters even for a public bundle: this process can read the repo.
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.resolve(path.join(root, url));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }

  // SPA fallback: an unknown path is a client route, not a 404. Anything with a
  // file extension is a real asset though, and a missing one should say so
  // rather than silently returning the app shell.
  if (!fs.existsSync(file)) {
    if (path.extname(url)) {
      res.writeHead(404).end('not found');
      return;
    }
    file = path.join(root, 'index.html');
  }

  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // The hashed asset filenames CRA emits are safe to cache hard; index.html must
  // never be, or a rebuild is invisible until someone clears their browser.
  const cache = file.endsWith('index.html')
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';

  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => {
  console.log(`serving ${root} on 0.0.0.0:${port}`);
});
