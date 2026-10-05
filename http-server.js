// Minimal local static file server, implemented with only Node's built-in
// 'http'/'fs'/'path' (no npm dependency — same no-install philosophy as
// relay-server.js). It exists to serve app-src/ (BSP_display.html, the panel
// HTML, and their css/js/assets) over plain HTTP so a Browser Source/Input
// added from a DIFFERENT computer's OBS Studio or vMix can actually load the
// page — loadFile()'s file:// URLs only work for windows this same Electron
// process opens, never for another machine on the network.
//
// Listens on all interfaces, port 5510 (REMOTE_SHOW_DEFAULT_PORT in
// app-src/js/panel/panel-app-core.js and BSP_display.html — both already
// assume a server answering here via getHttpPort()/buildRemoteShowUrl()).
// Windows will prompt for a firewall exception the first time this binds;
// that's expected.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf'
};

function createStaticServer(port, rootDir, { log = () => {} } = {}) {
  const root = path.resolve(rootDir);

  function resolveSafePath(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
    } catch (e) {
      return null;
    }
    // Reject embedded null bytes / control characters outright — fs.stat()
    // throws SYNCHRONOUSLY (before its callback ever runs) on a path
    // containing a null byte, which would otherwise crash the request
    // handler below with no catch around it. This server is reachable from
    // the whole LAN now, so any device sending a crafted URL must get a
    // clean 400, not take down the request handler.
    for (let i = 0; i < decoded.length; i += 1) {
      if (decoded.charCodeAt(i) < 0x20) return null;
    }
    const relative = decoded.replace(/^\/+/, '');
    const resolved = path.resolve(root, relative);
    // Reject anything that escapes root — required now that this server is
    // reachable from the LAN, not just from windows this process opened.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    let filePath;
    try {
      filePath = resolveSafePath(req.url || '/');
    } catch (e) {
      filePath = null;
    }
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      };
      if (req.method === 'HEAD') {
        // Never open a read stream for HEAD — it would just leak an
        // unconsumed file descriptor, since nothing below would ever pipe or
        // destroy it. fs.access() alone confirms the (possibly
        // index.html-appended) path is actually readable.
        fs.access(filePath, fs.constants.R_OK, (accessErr) => {
          if (accessErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
          }
          res.writeHead(200, headers);
          res.end();
        });
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
        }
        res.end('Not found');
      });
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', () => {
      log('static server listening on 0.0.0.0:' + port + ' (' + root + ')');
      resolve({
        port,
        close: () => new Promise((res) => httpServer.close(() => res()))
      });
    });
  });
}

module.exports = { createStaticServer };
