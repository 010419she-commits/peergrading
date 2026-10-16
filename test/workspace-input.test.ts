import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCheckCommands } from "../workspace-input.ts";
test("verification commands preserve quoted arguments, run sequentially, and never evaluate a shell", () => {
  assert.deepEqual(parseCheckCommands('npm test\npython3 -m unittest "tests/test space.py"').map((c) => c.argv), [["npm", "test"], ["python3", "-m", "unittest", "tests/test space.py"]]);
  for (const cmd of ['npm test && echo ok', 'echo $SECRET', 'echo $(id)', 'echo `id`', 'npm test > result', 'A=1 npm test']) assert.throws(() => parseCheckCommands(cmd));
  assert.deepEqual(parseCheckCommands(''), []);
  assert.throws(() => parseCheckCommands(Array(7).fill('npm test').join('\n')));
});
