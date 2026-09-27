import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "staple-"));
process.env.PORT = "0";
process.env.PI_BIN = join(import.meta.dirname, "fake-pi.ts");
const { server } = await import("../src/server.ts");
if (!server.listening) await once(server, "listening");

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(process.env.STAPLE_API_URL + path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

test("CEO delegates to engineer, engineer finishes, CEO closes the issue", async () => {
  const co = (await api("POST", "/api/companies", { name: "Acme" })).json;
  const ceo = (await api("POST", `/api/companies/${co.id}/agents`, { name: "Ada", role: "ceo" })).json;
  const eng = (await api("POST", `/api/companies/${co.id}/agents`, { name: "Bob", reportsTo: ceo.id })).json;
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "project-")));
  const project = (await api("POST", `/api/companies/${co.id}/projects`, { name: "Site", cwd })).json;
  const issue = (await api("POST", `/api/companies/${co.id}/issues`, {
    title: "Landing page", assigneeAgentId: ceo.id, projectId: project.id,
  })).json;

  let runs: any[] = [];
  for (let i = 0; i < 100 && (runs.length < 3 || runs.some((r) => ["queued", "running"].includes(r.status))); i++) {
    await new Promise((r) => setTimeout(r, 100));
    runs = (await api("GET", `/api/companies/${co.id}/runs`)).json;
  }
  const ctx = (await api("GET", `/api/issues/${issue.id}`)).json;
  assert.equal(ctx.status, "done");
  assert.equal(ctx.children.length, 1);
  assert.equal(ctx.children[0].status, "done");
  assert.equal(ctx.children[0].assigneeAgentId, eng.id);
  assert.equal(ctx.project.id, project.id);
  const child = (await api("GET", `/api/issues/${ctx.children[0].id}`)).json;
  assert.equal(child.projectId, project.id); // inherited from parent
  assert.equal(child.comments[0].body, `Built it in ${cwd}`); // ran in the project workspace

  assert.deepEqual(runs.map((r: any) => [r.agentId, r.status, r.reason]).reverse(), [
    [ceo.id, "succeeded", "issue_assigned"],
    [eng.id, "succeeded", "issue_assigned"],
    [ceo.id, "succeeded", "child_done"],
  ]);
  assert.ok(runs.every((r: any) => !("token" in r)));
});

test("validation and expired agent tokens", async () => {
  assert.equal((await api("POST", "/api/companies", {})).status, 422);
  const co = (await api("POST", "/api/companies", { name: "X" })).json;
  assert.equal((await api("POST", `/api/companies/${co.id}/issues`, { title: "t", status: "nope" })).status, 400);
  const other = (await api("POST", "/api/companies", { name: "Y" })).json;
  const foreign = (await api("POST", `/api/companies/${other.id}/projects`, { name: "P" })).json;
  assert.equal((await api("POST", `/api/companies/${co.id}/issues`, { title: "t", projectId: foreign.id })).status, 422);
  assert.equal((await api("GET", "/api/companies", undefined, "stale")).status, 401);
  server.close();
});
