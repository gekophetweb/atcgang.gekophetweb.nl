import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { resetDb, testServices, user, type TestServices } from "./helpers.js";

const s = await testServices();
afterAll(() => s.close());
beforeEach(() => resetDb(s.db));

const BASE = "http://localhost:3000";
const REDIRECT = "http://127.0.0.1:33418/callback";

async function getAccessToken(svc: TestServices, cookie: string) {
  const reg = await svc.app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP Client",
      application_type: "native",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(reg.status, await reg.clone().text()).toBeLessThan(300);
  const client = await reg.json();

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope: "openid profile email offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const authz = await svc.app.request(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie } });
  expect([302, 303]).toContain(authz.status);
  let location = authz.headers.get("location")!;
  expect(location).toContain("/consent");

  const consentQuery = new URL(location, BASE).search.slice(1);
  const consent = await svc.app.request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ accept: true, oauth_query: consentQuery }),
  });
  expect(consent.status, await consent.clone().text()).toBe(200);
  location = (await consent.json()).url;
  const code = new URL(location).searchParams.get("code")!;
  expect(code).toBeTruthy();

  const tok = await svc.app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }).toString(),
  });
  expect(tok.status, await tok.clone().text()).toBe(200);
  return (await tok.json()).access_token as string;
}

let rpcId = 0;
async function rpc(svc: TestServices, token: string, method: string, params: unknown = {}) {
  const res = await svc.app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  const data = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  return { status: res.status, data };
}

const callTool = async (svc: TestServices, token: string, name: string, args: unknown) => {
  const { data } = await rpc(svc, token, "tools/call", { name, arguments: args });
  return data.result as { isError?: boolean; content: { text: string }[] };
};

describe("MCP discovery", () => {
  it("serves protected-resource and authorization-server metadata", async () => {
    const pr = await s.app.request("/.well-known/oauth-protected-resource/mcp");
    expect(pr.status).toBe(200);
    const prm = await pr.json();
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers?.length).toBeGreaterThan(0);

    const asUrl = new URL(prm.authorization_servers[0]);
    const wellKnown = `/.well-known/oauth-authorization-server${asUrl.pathname === "/" ? "" : asUrl.pathname}`;
    const as = await s.app.request(wellKnown);
    expect(as.status).toBe(200);
    const asm = await as.json();
    expect(asm.authorization_endpoint).toContain("/oauth2/authorize");
    expect(asm.registration_endpoint).toBeTruthy();
    expect(asm.code_challenge_methods_supported).toContain("S256");
  });

  it("challenges requests without a token", async () => {
    const res = await s.app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});

describe("MCP tools", () => {
  it("logs in through OAuth and acts as the user with the same access checks", async () => {
    const anna = await user(s, "anna@example.com");
    const bob = await user(s, "bob@example.com");
    const bobs = await (await bob.api.post("/api/concerts", { artist: "Secret Band", startsAt: "2026-01-01T19:00:00Z" })).json();
    const token = await getAccessToken(s, anna.cookie);

    const init = await rpc(s, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);

    const tools = await rpc(s, token, "tools/list");
    const names = tools.data.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_concerts", "get_concert", "add_concert", "update_concert", "delete_concert", "search_photos", "tag_photos", "list_people", "list_labels", "concert_stats"]),
    );

    const added = await callTool(s, token, "add_concert", { artist: "Foo Fighters", startsAt: "2027-06-01T19:00:00Z", venue: "Ziggo Dome" });
    expect(added.isError).toBeFalsy();
    const concert = JSON.parse(added.content[0]!.text);

    const list = JSON.parse((await callTool(s, token, "list_concerts", { when: "upcoming" })).content[0]!.text);
    expect(list.map((c: { artist: string }) => c.artist)).toEqual(["Foo Fighters"]);

    // Same privacy as the website: Bob's concert is invisible.
    const other = await callTool(s, token, "get_concert", { id: bobs.id });
    expect(other.isError).toBe(true);

    const noConfirm = await callTool(s, token, "delete_concert", { id: concert.id, confirm: false });
    expect(noConfirm.isError).toBe(true);
    expect((await anna.api.get(`/api/concerts/${concert.id}`)).status).toBe(200);
    expect((await callTool(s, token, "delete_concert", { id: concert.id, confirm: true })).isError).toBeFalsy();
    expect((await anna.api.get(`/api/concerts/${concert.id}`)).status).toBe(404);
  });

  it("revoking the connection in Settings stops the token working", async () => {
    const anna = await user(s, "anna@example.com");
    const token = await getAccessToken(s, anna.cookie);
    expect((await rpc(s, token, "tools/list")).status).toBe(200);
    const conns = await (await anna.api.get("/api/mcp-connections")).json();
    expect(conns).toHaveLength(1);
    expect(conns[0].clientName).toBe("Test MCP Client");
    expect((await anna.api.del(`/api/mcp-connections/${conns[0].id}`)).status).toBe(204);
    expect((await rpc(s, token, "tools/list")).status).toBe(401);
  });
});
