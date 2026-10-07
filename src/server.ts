import { createServer } from "http";
import { attachSocketServer } from "./socket/server";

const port = Number(process.env.PORT ?? 5000);
const clientOrigins = ["http://localhost:3000", ...(process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)];

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404);
  res.end();
});

attachSocketServer(server, clientOrigins);

server.listen(port, "0.0.0.0", () => {
  console.log(`> Belote Trix server ready on port ${port}`);
});
