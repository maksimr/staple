#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-import-text
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiOrchestrator } from "./core/orchestrator.ts";
import { SqliteStore } from "./db/sqlite.ts";
import { ApiServer } from "./server/http.ts";

const env = process.env;
const dataDir = env.DATA_DIR ?? join(homedir(), ".staple");
const store = new SqliteStore(dataDir);
const core = new PiOrchestrator(store, {
  dataDir,
  piBin: env.PI_BIN ?? "pi",
  piArgs: env.PI_ARGS?.split(" ").filter(Boolean) ?? [],
  timeoutMs: Number(env.RUN_TIMEOUT_SEC ?? 1800) * 1000,
});
export const server = new ApiServer(store, core);

const HOST = env.HOST ?? "127.0.0.1";
server.listen(Number(env.PORT ?? 3100), HOST, () => {
  const { port } = server.address() as AddressInfo;
  env.STAPLE_API_URL = `http://${HOST}:${port}`; // inherited by agent processes
  console.log(`staple listening on ${env.STAPLE_API_URL}`);
  core.recover();
});
