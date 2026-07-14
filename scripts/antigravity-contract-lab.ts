/**
 * Synthetic, loopback-only contract probe for studying an Antigravity-shaped exchange.
 * It intentionally accepts no endpoint or credential input and cannot contact Google.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

const endpoint = new URL("http://127.0.0.1/v1internal:generateContent");
assert.equal(endpoint.hostname, "127.0.0.1");

const expected = {
  authorization: "Bearer neko-lab-token",
  userAgent: "neko-antigravity-contract-lab/1",
  body: {
    model: "gemini-lab",
    metadata: { ideType: "NEKO_LAB", ideName: "neko-core", clientVersion: "synthetic" },
    request: { contents: [{ role: "user", parts: [{ text: "contract probe" }] }] },
  },
};

let observed: typeof expected | undefined;
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed = {
      authorization: String(request.headers.authorization ?? ""),
      userAgent: String(request.headers["user-agent"] ?? ""),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "NEKO_LAB_OK" }] } }] } }));
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));

try {
  const address = server.address();
  assert(address && typeof address !== "string");
  endpoint.port = String(address.port);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: expected.authorization,
      "content-type": "application/json",
      "user-agent": expected.userAgent,
    },
    body: JSON.stringify(expected.body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(observed, expected);
  assert.equal(JSON.parse(text).response.candidates[0].content.parts[0].text, "NEKO_LAB_OK");
  console.log("antigravity-contract-lab: PASS (synthetic credentials, loopback only)");
} finally {
  server.close();
  await new Promise<void>((resolve) => server.once("close", resolve));
}
