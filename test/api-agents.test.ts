import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("saved cloud APIs use exact credentials/models, refresh after edits and stay out of public-server discovery", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-cloud-agents-"));
  try {
    const program = `
      import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
      import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawn = childProcess.execFile = childProcess.execFileSync = () => { throw new Error('Do not execute installed agents'); };
      syncBuiltinESMExports();
      let networkRequests = 0; globalThis.fetch = async () => { networkRequests++; throw new Error('Cloud discovery must not call an API'); };
      const { detectAgents, getCachedAgent, invalidateAgentCache } = await import(${JSON.stringify(new URL("../agents/detect.ts", import.meta.url).href)});
      const { publicAgentInfo } = await import(${JSON.stringify(new URL("../agents/local-connections-routes.ts", import.meta.url).href)});
      const id = '23b7ade0-d228-4d2e-9441-3fd18f1af92f';
      const first = { id, name:'Kimi saved', provider:'kimi', baseUrl:'https://api.moonshot.cn/v1', model:'exact-first-model', apiKey:'fake-first-secret' };
      fs.mkdirSync(process.env.DATA_DIR, {recursive:true});
      const file = path.join(process.env.DATA_DIR, 'api-models.json');
      const write = records => fs.writeFileSync(file, JSON.stringify(records));
      write([first]);
      const cloud = agents => agents.filter(a => a.id.startsWith('cloud-api:'));
      const original = cloud(await detectAgents()); assert.equal(original.length, 1);
      assert.equal(original[0].kind, 'api'); assert.equal(original[0].repository, false); assert.equal(original[0].local, false);
      assert.equal(original[0].status, 'unverified'); assert.equal(original[0].runner.model, first.model);
      assert.equal(getCachedAgent(original[0].id).runner.apiKey, first.apiKey);
      assert.doesNotMatch(JSON.stringify(publicAgentInfo(original[0])), /fake-first-secret|apiKey/);
      write([{...first, name:'DeepSeek saved', provider:'deepseek', baseUrl:'https://api.deepseek.com', model:'exact-second-model', apiKey:'fake-replacement-secret'}]);
      invalidateAgentCache(); assert.equal(getCachedAgent(original[0].id), undefined);
      const changed = cloud(await detectAgents())[0];
      assert.equal(changed.runner.apiKey, 'fake-replacement-secret'); assert.equal(changed.runner.model, 'exact-second-model');
      assert.equal(changed.runner.baseUrl, 'https://api.deepseek.com');
      process.env.LOCAL_MODE = '0'; process.env.NODE_ENV = 'production'; invalidateAgentCache();
      assert.deepEqual(cloud(await detectAgents()), [], 'public server never advertises desktop saved credentials');
      process.env.LOCAL_MODE = '1'; write([]); invalidateAgentCache();
      assert.deepEqual(cloud(await detectAgents()), []); assert.equal(getCachedAgent(changed.id), undefined);
      assert.equal(networkRequests, 0); console.log('Cloud agent integration passed');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { NODE_ENV: "test", LOCAL_MODE: "1", SCAN_MODELS: "0", DATA_DIR: path.join(temporary, "data"),
      HOME: temporary, USERPROFILE: temporary, APPDATA: path.join(temporary, "roaming"), LOCALAPPDATA: path.join(temporary, "local"),
      ProgramFiles: path.join(temporary, "programs"), "ProgramFiles(x86)": path.join(temporary, "programs-x86"), ProgramData: path.join(temporary, "programdata"),
      PATH: path.join(temporary, "bin"), TEMP: temporary, TMP: temporary });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env, encoding: "utf8", timeout: 20000, windowsHide: true });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Cloud agent integration passed/);
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir()); assert.match(path.basename(temporary), /^pg-cloud-agents-/);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
