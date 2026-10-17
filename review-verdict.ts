export type ReviewVerdict = "approve" | "revise";

/** Only the reviewer's own final, standalone line can approve a version. */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const lines = text.trimEnd().split(/\r?\n/);
  let fence: { character: string; length: number } | undefined;
  let quotedParagraph = false, htmlComment = false;
  let rawHtml: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Markdown allows a quote to continue without another `>` marker. Require
    // a blank line before accepting a subsequent unquoted verdict.
    if (!line.trim()) quotedParagraph = false;
    else if (/^ {0,3}>/.test(line)) quotedParagraph = true;
    if (!fence) {
      for (const token of line.matchAll(/<!--|-->/g)) htmlComment = token[0] === "<!--";
      const opening = line.match(/^ {0,3}<(pre|code|script|style|textarea)(?:\s|>)/i);
      if (opening) rawHtml = opening[1].toLowerCase();
      if (rawHtml && new RegExp(`</${rawHtml}\\s*>`, "i").test(line)) rawHtml = undefined;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      if (index === lines.length - 1) return "revise";
      continue;
    }
    if (index !== lines.length - 1) continue;
    if (fence || quotedParagraph || htmlComment || rawHtml || /^(?: {4}|\t)/.test(line)) return "revise";
    const final = line.trim();
    return /^(?:【结论】通过|VERDICT: APPROVE)$/i.test(final) ? "approve" : "revise";
  }
  return "revise";
}
