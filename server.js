const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const WEB_ROOT = path.join(__dirname, "apps", "web");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function send(res, statusCode, content, contentType) {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(content);
}

function resolveFilePath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(WEB_ROOT, cleanPath));

  if (!filePath.startsWith(WEB_ROOT)) {
    return null;
  }

  return filePath;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const filePath = resolveFilePath(requestUrl.pathname);

  if (!filePath) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        send(res, 404, "Not Found", "text/plain; charset=utf-8");
        return;
      }

      send(res, 500, "Internal Server Error", "text/plain; charset=utf-8");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    send(res, 200, data, contentType);
  });
});

server.listen(PORT, () => {
  console.log(`Chain Reaction Global running at http://localhost:${PORT}`);
});
