// apps/api/src/listen.ts — the api's listener: HTTP/1.1 and HTTP/2
// cleartext (h2c) on one port.
//
// Why h2c: a session stream has no server-side EOF, so it ends only when
// its client hangs up, and the loop in routes/sessions.ts polls the store
// until `aborted` says so. Behind a front end that speaks HTTP/1.1 to the
// container, a hang-up may never arrive: Cloud Run holds the request open
// until its timeout (up to an hour), and the loop polls on for nobody,
// holding a slot of the instance's request concurrency. Enough
// reconnecting clients fill every slot and the api stops answering. Over
// h2c (Cloud Run's end-to-end HTTP/2) the hang-up arrives as an
// RST_STREAM; @hono/node-server cancels the response body, and the loop
// stops at its next check.
//
// Why both: health probes, curl, compose and every SDK still speak
// HTTP/1.1. A connection is routed by its first bytes: the h2c preface
// goes to the HTTP/2 server, anything else to the HTTP/1.1 one. Nothing
// changes for a deployment that never sends h2c.

import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";

type Fetch = Parameters<typeof getRequestListener>[0];

// RFC 9113 §3.4: an h2c prior-knowledge connection opens with this.
const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

/** Whether a connection's first bytes are the h2c preface. A first chunk
 *  shorter than the preface is judged on what it has: no HTTP/1 request
 *  line starts "PRI * HTTP/2.0". */
export function isH2cPreface(first: Buffer): boolean {
  const n = Math.min(first.length, PREFACE.length);
  return n > 0 && first.subarray(0, n).equals(PREFACE.subarray(0, n));
}

/** Serve `fetch` on `port` over HTTP/1.1 and h2c. Resolves to the bound
 *  port (port 0 picks one) and a close that stops accepting. */
export function listen(
  fetch: Fetch,
  port: number,
): Promise<{ port: number; close(): Promise<void> }> {
  const handler = getRequestListener(fetch);
  const h1 = http.createServer(handler);
  const h2 = http2.createServer(handler);

  const server = net.createServer((socket) => {
    socket.once("data", (first: Buffer) => {
      if (isH2cPreface(first)) {
        h2.emit("connection", replaying(socket, first));
      } else {
        socket.pause();
        socket.unshift(first);
        h1.emit("connection", socket);
        socket.resume();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** The socket as a plain stream that reads `first` again before the rest.
 *  The HTTP/1.1 server reads what socket.unshift() put back; the HTTP/2
 *  server reads a net.Socket's native handle directly and would miss it,
 *  but it takes any Duplex, so it gets this one. */
function replaying(socket: net.Socket, first: Buffer): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(error, callback) {
      socket.destroy(error ?? undefined);
      callback(error);
    },
  });
  stream.push(first);
  socket.on("data", (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("error", (error) => stream.destroy(error));
  socket.on("close", () => stream.destroy());
  return stream;
}
