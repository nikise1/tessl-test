// Copies the preview link from the Vercel bot's PR comment into the PR description.
// The Vercel comment starts with a `[vc]: #<hash>:<base64 json>` line whose
// projects each carry a `previewUrl` host.

const START = "<!-- vercel-preview-link:start -->";
const END = "<!-- vercel-preview-link:end -->";
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/;

export function previewUrls(commentBody) {
  const line = (commentBody || "").split("\n").find((l) => l.startsWith("[vc]: #"));
  if (!line) return [];
  const encoded = line.slice(line.lastIndexOf(":") + 1).trim();
  let data;
  try {
    data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return [];
  }
  const urls = [];
  for (const project of data.projects || []) {
    const host = project.previewUrl;
    if (typeof host === "string" && HOST.test(host)) {
      const url = `https://${host}`;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

export function withPreviewSection(prBody, urls) {
  const body = prBody || "";
  const lines = urls.map((url) => `**Vercel preview:** ${url}`);
  const section = `${START}\n${lines.join("\n")}\n${END}`;
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start !== -1 && end > start) {
    return body.slice(0, start) + section + body.slice(end + END.length);
  }
  return body.trimEnd() ? `${body.trimEnd()}\n\n${section}\n` : `${section}\n`;
}
