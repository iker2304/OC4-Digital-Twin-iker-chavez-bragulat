/**
 * Serves the built app under a subpath, so the exact production URL shape can be
 * tested without nginx.
 *
 *   node scripts/prefix-proxy.mjs [--port 8791] [--prefix /oc4-dt-mobile/] [--target http://127.0.0.1:8790]
 *
 * It does what the nginx `location /oc4-dt-mobile/ { proxy_pass …/; }` block does:
 * strip the prefix, forward everything else untouched (headers included).
 */
import http from 'node:http';

const args = process.argv.slice(2);
const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};

const PORT = Number(value('port', '8791'));
const PREFIX = `/${value('prefix', '/oc4-dt-mobile/').replace(/^\/+|\/+$/g, '')}/`;
const TARGET = new URL(value('target', 'http://127.0.0.1:8790'));

const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    if (!url.startsWith(PREFIX)) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end(`Fuera del subpath ${PREFIX}\n`);
        return;
    }
    const upstream = http.request(
        {
            hostname: TARGET.hostname,
            port: TARGET.port,
            path: `/${url.slice(PREFIX.length)}`,
            method: request.method,
            headers: { ...request.headers, host: TARGET.host },
        },
        (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
        }
    );
    upstream.on('error', (error) => {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(`upstream: ${error.message}\n`);
    });
    request.pipe(upstream);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`http://127.0.0.1:${PORT}${PREFIX} → ${TARGET.origin}/`);
});
