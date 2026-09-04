import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Rill web shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ja">/i);
  assert.match(html, /<title>Rill — Medical Literature Workspace<\/title>/i);
  assert.match(html, /class="app-shell"/i);
  assert.match(html, />Overview</i);
  assert.match(html, />Library/i);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);
});

test("keeps the initial library status accessible", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /class="storage-loading" role="status"/i);
  assert.match(html, /ライブラリを読み込んでいます/);
});
