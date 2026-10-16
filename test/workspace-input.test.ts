import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCheckCommands } from "../workspace-input.ts";
test("verification commands preserve quoted arguments, run sequentially, and never evaluate a shell", () => {
  assert.deepEqual(parseCheckCommands('npm test\npython3 -m unittest "tests/test space.py"').map((c) => c.argv), [["npm", "test"], ["python3", "-m", "unittest", "tests/test space.py"]]);
  for (const cmd of ['npm test && echo ok', 'echo $SECRET', 'echo $(id)', 'echo `id`', 'npm test > result', 'A=1 npm test']) assert.throws(() => parseCheckCommands(cmd));
  assert.deepEqual(parseCheckCommands(''), []);
  assert.throws(() => parseCheckCommands(Array(7).fill('npm test').join('\n')));
});

test("Windows verification commands preserve unquoted paths and quoted paths with spaces", () => {
  const commands = [
    String.raw`node test\example.test.ts`,
    String.raw`C:\Tools\node.exe --test`,
    String.raw`"C:\Program Files\nodejs\node.exe" --test "test\example space.test.ts"`,
    String.raw`node \\server\share\test.js`,
    String.raw`node "\\server\shared folder\test.js"`,
    String.raw`node --directory "C:\project\\"`,
  ];
  assert.deepEqual(parseCheckCommands(commands.join("\n"), "win32").map((c) => c.argv), [
    ["node", String.raw`test\example.test.ts`],
    [String.raw`C:\Tools\node.exe`, "--test"],
    [String.raw`C:\Program Files\nodejs\node.exe`, "--test", String.raw`test\example space.test.ts`],
    ["node", String.raw`\\server\share\test.js`],
    ["node", String.raw`\\server\shared folder\test.js`],
    ["node", "--directory", "C:\\project\\"],
  ]);
  assert.deepEqual(parseCheckCommands(String.raw`node -e "console.log(\"ok\")" ''`, "win32")[0].argv, ["node", "-e", 'console.log("ok")', ""]);
});

test("Windows doubled quotes inside quoted arguments remain literal", () => {
  assert.deepEqual(parseCheckCommands('node -e "console.log(""ok"")" "a""b"', "win32")[0].argv, ["node", "-e", 'console.log("ok")', 'a"b']);
  assert.deepEqual(parseCheckCommands(String.raw`node "a\\""b"`, "win32")[0].argv, ["node", 'a\\"b']);
});

test("both platforms reject shell operators, variables, substitutions, comments and globs", () => {
  for (const platform of ["win32", "linux"] as const) {
    for (const command of ['npm test && echo ok', 'npm test | more', 'npm test; echo ok', 'npm test > result', 'npm test < input', 'echo $SECRET', 'echo "$SECRET"', 'echo $(id)', 'echo `id`', 'A=1 npm test', 'node test/*.test.ts', 'node test # comment']) {
      assert.throws(() => parseCheckCommands(command, platform), undefined, `${platform}: ${command}`);
    }
    assert.deepEqual(parseCheckCommands("node -e 'console.log(\"$LITERAL & text\")'", platform)[0].argv, ["node", "-e", 'console.log("$LITERAL & text")']);
  }
  assert.throws(() => parseCheckCommands('node "unterminated path', "win32"));
});

test("POSIX verification commands retain backslash escaping", () => {
  assert.deepEqual(parseCheckCommands(String.raw`node test/example\ space.test.ts --label escaped\ value`, "linux")[0].argv, ["node", "test/example space.test.ts", "--label", "escaped value"]);
});
