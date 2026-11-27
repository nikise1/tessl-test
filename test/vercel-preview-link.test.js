import assert from "node:assert/strict";
import test from "node:test";
import { previewUrls, withPreviewSection } from "../scripts/vercel-preview-link.js";

function vercelComment(projects) {
  const data = Buffer.from(JSON.stringify({ isMonorepo: true, type: "github", projects })).toString("base64");
  return `[vc]: #C+9NuCZN4EuCqkBDq6fmLSGxm2JlqUC5mmbuQQbxzU4=:${data}\nThe latest updates on your projects.`;
}

const comment = vercelComment([
  { name: "tessl-test", previewUrl: "tessl-test-git-tessl-issue-15-nikise1s-projects.vercel.app" },
]);
const url = "https://tessl-test-git-tessl-issue-15-nikise1s-projects.vercel.app";

test("reads the preview link from the Vercel bot comment", () => {
  assert.deepEqual(previewUrls(comment), [url]);
});

test("ignores comments without Vercel data and hosts outside vercel.app", () => {
  assert.deepEqual(previewUrls("Looks good to me"), []);
  assert.deepEqual(previewUrls("[vc]: #abc:not-json"), []);
  assert.deepEqual(previewUrls(vercelComment([{ previewUrl: "evil.example.com" }])), []);
});

test("appends the preview link to the description once", () => {
  const body = withPreviewSection("Fixes the tongue.", [url]);
  assert.match(body, /^Fixes the tongue\.\n\n<!-- vercel-preview-link:start -->/);
  assert.ok(body.includes(`**Vercel preview:** ${url}`));
  assert.equal(withPreviewSection(body, [url]), body);
});

test("replaces an earlier preview link and keeps the rest of the description", () => {
  const before = withPreviewSection("Intro", ["https://old.vercel.app"]) + "\nFooter";
  const after = withPreviewSection(before, [url]);
  assert.ok(!after.includes("old.vercel.app"));
  assert.ok(after.startsWith("Intro\n\n"));
  assert.ok(after.endsWith("\nFooter"));
});

test("fills an empty description", () => {
  assert.ok(withPreviewSection(null, [url]).startsWith("<!-- vercel-preview-link:start -->"));
});
