import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade requests for the proxy
server.on("upgrade", (request, socket, head) => {
  const reqUrl = request.url ?? "/";
  const parsed = new URL(reqUrl, `http://localhost`);

  if (parsed.pathname === "/api/proxy/ws") {
    wss.handleUpgrade(request, socket as never, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (clientWs, request) => {
  const reqUrl = request.url ?? "/";
  const parsed = new URL(reqUrl, `http://localhost`);
  const targetUrl = parsed.searchParams.get("url");

  if (!targetUrl) {
    clientWs.close(1008, "Missing url parameter");
    return;
  }

  logger.info({ targetUrl }, "WebSocket proxy connection");

  const origin = new URL(targetUrl).origin;
  const targetWs = new WebSocket(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Origin": origin,
    },
  });

  // Bridge messages both ways
  clientWs.on("message", (data, isBinary) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    }
  });

  targetWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  // Forward close/errors
  clientWs.on("close", (code, reason) => {
    if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
      targetWs.close(code, reason);
    }
  });

  targetWs.on("close", (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      clientWs.close(code, reason);
    }
  });

  clientWs.on("error", (err) => {
    logger.warn({ err }, "Client WebSocket error");
    targetWs.terminate();
  });

  targetWs.on("error", (err) => {
    logger.warn({ err, targetUrl }, "Target WebSocket error");
    clientWs.terminate();
  });
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
