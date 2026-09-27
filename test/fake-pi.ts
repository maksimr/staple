#!/usr/bin/env node
// Stands in for `pi` in tests: acts on its wake through the API, like a real agent would.
const { STAPLE_API_URL, STAPLE_API_KEY, STAPLE_AGENT_ID: me, STAPLE_COMPANY_ID: co, STAPLE_TASK_ID: task } = process.env;

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(STAPLE_API_URL + path, {
    method,
    headers: { authorization: `Bearer ${STAPLE_API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const self = await api("GET", "/api/agents/me");
const issue = await api("GET", `/api/issues/${task}`);

if (self.role === "ceo") {
  if (issue.children.length === 0) {
    const team: any[] = await api("GET", `/api/companies/${co}/agents`);
    const eng = team.find((a) => a.reportsTo === me);
    await api("PATCH", `/api/issues/${task}`, { status: "in_progress" });
    await api("POST", `/api/companies/${co}/issues`, { title: `Build: ${issue.title}`, parentId: task, assigneeAgentId: eng.id });
  } else if (issue.children.every((c: any) => c.status === "done")) {
    await api("PATCH", `/api/issues/${task}`, { status: "done", comment: "All children done." });
  }
} else {
  await api("PATCH", `/api/issues/${task}`, { status: "done", comment: `Built it in ${process.cwd()}` });
}

console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: `${self.name} ok` }] }] }));
