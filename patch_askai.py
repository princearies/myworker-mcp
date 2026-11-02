with open("src/agent.ts", encoding="utf-8") as f:
    s = f.read()
start = s.find("async function askAi")
end = s.find("function promptAi", start)
new = """async function askAi(env, text, system, maxTokens = 900) {
  for (const model of AI_MODELS) {
    try {
      const r = await env?.AI?.run(model, { messages: [{ role: \"system\", content: system }, { role: \"user\", content: text }], max_tokens: maxTokens });
      const out = r?.response;
      if (out && typeof out === \"object\") {
        const s = JSON.stringify(out);
        if (s && s !== \"{}\" && s !== \"[object Object]\") return s;
        continue;
      }
      if (out && typeof out === \"string\") {
        const s = out.trim();
        if (s && s !== \"[object Object]\" && s !== \"undefined\" && s !== \"null\") return s;
        continue;
      }
      if (r && typeof r === \"object\" && typeof r.response === \"string\") {
        const s = r.response.trim();
        if (s && s !== \"[object Object]\") return s;
      }
    } catch {}
  }
  return \"\";
}"""
s2 = s[:start] + new + s[end:]
with open("src/agent.ts", "w", encoding="utf-8") as f:
    f.write(s2)
print("OK askAi patch")
