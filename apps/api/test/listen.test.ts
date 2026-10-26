// The listener over real sockets: HTTP/1.1 and h2c on one port, and the
// reason it serves h2c — a session stream's poll loop stops when its
// client hangs up, on either protocol.
import http2 from "node:http2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Store } from "@funky/agent";
import { buildApp } from "../src/app";
import { isH2cPreface, listen } from "../src/listen";

// A session that exists and never gets an entry: its stream only polls.
// Each poll is one readEntries, so the count says whether the loop runs.
let polls = 0;
const store = {
  getSession: async () => ({ id: "s1", namespace: "default" }),
  readEntries: async () => {
    polls++;
    return [];
  },
} as unknown as Store;

const app = buildApp({
  store,
  secrets: null,
  authToken: null,
  ping: async () => ({}),
  stream: { pollMs: 10, heartbeatMs: 60_000 },
});

let server: Awaited<ReturnType<typeof listen>>;
let base: string;

beforeAll(async () => {
  server = await listen(app.fetch, 0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.close());

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

/** The loop is running: polls keep coming. */
async function polling() {
  const from = polls;
  await until(() => polls >= from + 3);
}

/** The loop has stopped: no poll for several intervals. */
async function stopped() {
  let last = -1;
  await until(() => {
    const quiet = polls === last;
    last = polls;
    return quiet;
  });
  const settled = polls;
  await new Promise((r) => setTimeout(r, 100));
  expect(polls).toBe(settled);
}

describe("isH2cPreface", () => {
  it("knows the h2c preface, whole or cut short, and nothing else", () => {
    expect(isH2cPreface(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\0\0"))).toBe(true);
    expect(isH2cPreface(Buffer.from("PRI * HT"))).toBe(true);
    expect(isH2cPreface(Buffer.from("GET /health HTTP/1.1\r\n"))).toBe(false);
    expect(isH2cPreface(Buffer.alloc(0))).toBe(false);
  });
});

describe("one port, both protocols", () => {
  it("answers HTTP/1.1", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it("answers h2c", async () => {
    const session = http2.connect(base);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = session.request({ ":path": "/health" });
        req.on("response", (headers) => resolve(Number(headers[":status"])));
        req.on("error", reject);
        req.resume();
      });
      expect(status).toBe(200);
    } finally {
      session.close();
    }
  });
});

describe("a client hanging up stops its stream's poll loop", () => {
  it("over h2c: the RST_STREAM", async () => {
    const session = http2.connect(base);
    try {
      const req = session.request({ ":path": "/v1/sessions/s1/stream" });
      req.on("error", () => {});
      await polling();
      req.close(http2.constants.NGHTTP2_CANCEL);
      await stopped();
    } finally {
      session.close();
    }
  });

  it("over HTTP/1.1: the closed connection", async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/v1/sessions/s1/stream`, { signal: abort.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await polling();
    abort.abort();
    await stopped();
  });
});
