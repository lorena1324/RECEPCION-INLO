// Servidor de archivos mínimo para las pruebas: sirve la raíz del proyecto en 127.0.0.1:5196.
const http = require("http"), fs = require("fs"), path = require("path");
const raiz = path.resolve(process.argv[2]);
const tipos = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };

http.createServer((q, s) => {
    const f = path.join(raiz, decodeURIComponent(q.url.split("?")[0]));
    if (!f.startsWith(raiz)) { s.writeHead(403); return s.end(); }     // nada fuera de la raíz
    try {
        const b = fs.readFileSync(f);
        s.writeHead(200, { "Content-Type": tipos[path.extname(f)] || "application/octet-stream" });
        s.end(b);
    } catch (e) { s.writeHead(404); s.end(); }
}).listen(5196, "127.0.0.1", () => console.log("listo"));
