/**
 * Tests for timedFetch.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import http from "http";
import { timedFetch } from "../src/utils/timed-fetch.js";

function startServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("timedFetch", () => {
  test("successful GET", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const res = await timedFetch(`http://localhost:${srv.port}/`, {
        where: "test",
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.ok, true);
    } finally {
      await srv.close();
    }
  });

  test("successful POST with body", async () => {
    const srv = await startServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echo: body }));
      });
    });

    try {
      const res = await timedFetch(`http://localhost:${srv.port}/`, {
        method: "POST",
        body: "hello",
        where: "test-post",
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.echo, "hello");
    } finally {
      await srv.close();
    }
  });

  test("timeout triggers abort", async () => {
    const srv = await startServer((_req, _res) => {
      // Never respond — simulate hang
    });

    try {
      await assert.rejects(
        () =>
          timedFetch(`http://localhost:${srv.port}/`, {
            timeoutMs: 100,
            where: "test-timeout",
          }),
        (err: any) => {
          assert.ok(err.message.includes("fetch timeout"), `Expected timeout error, got: ${err.message}`);
          return true;
        }
      );
    } finally {
      await srv.close();
    }
  });

  test("no timeout when timeoutMs is 0", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    try {
      const res = await timedFetch(`http://localhost:${srv.port}/`, {
        timeoutMs: 0,
        where: "test-no-timeout",
      });
      assert.strictEqual(res.status, 200);
    } finally {
      await srv.close();
    }
  });
});
