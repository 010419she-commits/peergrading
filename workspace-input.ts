// Parse user-selected verification commands into argument arrays; no shell evaluation.
import { parse } from "shell-quote";

/** Windows paths use literal backslashes; only backslashes before double quotes escape quoting. */
function parseWindowsArgs(line: string): string[] {
  const args: string[] = [];
  let token = "", started = false, quote: "'" | '"' | undefined;
  const flush = () => { if (started) args.push(token); token = ""; started = false; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = undefined; else token += c;
      continue;
    }
    if (c === "\\") {
      let end = i;
      while (line[end] === "\\") end++;
      const count = end - i;
      if (line[end] === '"') {
        token += "\\".repeat(Math.floor(count / 2));
        if (count % 2) token += '"';
        else if (quote === '"' && line[end + 1] === '"') { token += '"'; end++; }
        else quote = quote === '"' ? undefined : '"';
        i = end;
      } else { token += "\\".repeat(count); i = end - 1; }
      started = true;
      continue;
    }
    if (c === '"') {
      if (quote === '"' && line[i + 1] === '"') { token += '"'; i++; }
      else quote = quote === '"' ? undefined : '"';
      started = true; continue;
    }
    if (!quote && c === "'") { quote = "'"; started = true; continue; }
    if (!quote && /\s/.test(c)) { flush(); continue; }
    // Match the shell-quote restrictions without interpreting Windows paths as escapes.
    if (c === "$" || !quote && /[&;()|<>*?#]/.test(c)) throw new Error("check_shell_not_supported");
    token += c; started = true;
  }
  if (quote) throw new Error("invalid_check_commands");
  flush();
  return args;
}

export function parseCheckCommands(value: unknown, platform: NodeJS.Platform = process.platform): { argv: string[]; timeoutMs: number }[] {
  if (value == null || value === "") return [];
  if (typeof value !== "string" || value.length > 8000) throw new Error("invalid_check_commands");
  const lines = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 6) throw new Error("too_many_check_commands");
  return lines.map((line) => {
    // Variables and shell substitutions are intentionally not evaluated.
    if (/[`\n\r\0]|\$\(/.test(line)) throw new Error("check_shell_not_supported");
    const args = platform === "win32" ? parseWindowsArgs(line) : parse(line, () => { throw new Error("check_shell_not_supported"); });
    if (!args.length || args.length > 64 || args.some((a) => typeof a !== "string") || /^[A-Za-z_][\w]*=/.test(String(args[0]))) throw new Error("check_shell_not_supported");
    const argv = args as string[];
    if (argv.some((a) => a.length > 4096 || a.includes("\0")) || !argv[0]) throw new Error("invalid_check_commands");
    return { argv, timeoutMs: 120_000 };
  });
}
