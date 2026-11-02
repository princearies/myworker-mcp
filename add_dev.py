with open("src/index.ts", encoding="utf-8") as f:
    s = f.read()
dev = "\n// ==== ENDPOINT DEV (SEMENTARA) ====\napp.post(\"/dev/sentimen\", async (c) => {\n  const body = await c.req.json().catch(() => ({}));\n  const teks = String(body.text || c.req.query(\"text\") || \"\");\n  if (!teks) return c.json({ error: \"text diperlukan\" }, 400);\n  const { servisSentimen } = await import(\"./agent\");\n  try {\n    const hasil = await servisSentimen(c.env, teks);\n    return c.json({ ok: true, hasil });\n  } catch (e) {\n    return c.json({ ok: false, error: String(e) }, 500);\n  }\n});\n// ==== TAMAT ====\n"
marker = "const app = new Hono"
idx = s.find(marker)
if idx == -1:
    print("RALAT")
    exit(1)
newline = s.find("\n", idx)
s2 = s[:newline+1] + dev + s[newline+1:]
with open("src/index.ts", "w", encoding="utf-8") as f:
    f.write(s2)
print("OK endpoint dev")
