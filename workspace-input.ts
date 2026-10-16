// Parse user-selected verification commands into argument arrays; no shell evaluation.
import { parse } from "shell-quote";

export function parseCheckCommands(value: unknown): { argv: string[]; timeoutMs: number }[] {
  if (value == null || value === "") return [];
  if (typeof value !== "string" || value.length > 8000) throw new Error("invalid_check_commands");
  const lines = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 6) throw new Error("too_many_check_commands");
  return lines.map((line) => {
    // Variables and shell substitutions are intentionally not evaluated.
    if (/[`\n\r\0]|\$\(/.test(line)) throw new Error("check_shell_not_supported");
    const args = parse(line, () => { throw new Error("check_shell_not_supported"); });
    if (!args.length || args.length > 64 || args.some((a) => typeof a !== "string") || /^[A-Za-z_][\w]*=/.test(String(args[0]))) throw new Error("check_shell_not_supported");
    const argv = args as string[];
    if (argv.some((a) => a.length > 4096 || a.includes("\0")) || !argv[0]) throw new Error("invalid_check_commands");
    return { argv, timeoutMs: 120_000 };
  });
}
