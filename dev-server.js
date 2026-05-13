const http = require("http");
const fs = require("fs");
const path = require("path");

const portArgIndex = process.argv.indexOf("--port");
const port =
  portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) || 3001 : 3001;
const root = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
  const routePath =
    requestUrl.pathname === "/"
      ? "index.html"
      : decodeURIComponent(requestUrl.pathname.slice(1));
  const fullPath = path.resolve(root, routePath);

  if (!fullPath.startsWith(root) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = path.extname(fullPath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
  });
  fs.createReadStream(fullPath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Julia CRM dev server: http://127.0.0.1:${port}/`);
});
