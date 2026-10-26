// -----------------------------------------------------------------------------
// The fake gateway on loopback: a real HTTP server and a real websocket
// server (the `ws` package) around the in-memory fake, Digest authentication
// included, for the tests of the real transports and of the real clock.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function listen(fake, { maxPayloadTest = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      at: performance.now(),
    });
    fake
      .request({
        method: req.method,
        path: req.url,
        headers: req.headers,
        timeout: 60_000,
      })
      .then(
        (answer) => {
          res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
          res.end(answer.body);
        },
        () => {
          res.destroy();
        },
      );
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  const handshakes = [];
  server.on('upgrade', (req, socket, head) => {
    handshakes.push({ url: req.url, authorization: req.headers.authorization });
    const ok = fake.wsAuthorized ? fake.wsAuthorized(req) : true;
    if (!ok) {
      socket.end(
        `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${fake.wsChallenge()}\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    handshakes,
    sockets,
    send: (text) => {
      for (const ws of sockets) ws.send(text);
    },
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
    maxPayloadTest,
  };
}
