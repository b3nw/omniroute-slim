import test from "node:test";
import assert from "node:assert/strict";

test("Batch request can be JSON stringified and parsed without data loss", () => {
  const inputText = `# MEMORY.md

## Index
- **Tasks**: memory/tasks.md
- Technical notes: See daily logs in \`memory/YYYY-MM-DD.md\` (search with \`memory_search\`)

## Durable preferences
- Running directly on \`bashbitch\` (no SSH required).
- Use \`memory_search\` to locate information.
- **Memory Embeddings**: Use Mistral endpoint (\`https://api.mistral.ai/v1/embeddings\`) with \`MISTRAL_API_KEY\`.
`;

  const originalRequest = {
    custom_id: "0",
    method: "POST",
    url: "/v1/embeddings",
    body: {
      model: "mistral/mistral-embed",
      input: inputText,
    },
  };

  const jsonlLine = JSON.stringify(originalRequest);
  const parsed = JSON.parse(jsonlLine);

  assert.strictEqual(parsed.custom_id, originalRequest.custom_id);
  assert.strictEqual(parsed.body.model, originalRequest.body.model);
  assert.strictEqual(parsed.body.input, originalRequest.body.input);
  assert.ok(parsed.body.input.includes("`"), "Backticks should be preserved");
  assert.ok(parsed.body.input.includes("## Index"), "Markdown should be preserved");
});

