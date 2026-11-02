with open("src/agent.ts", encoding="utf-8") as f:
    s = f.read()
start_marker = "if (!obj || typeof obj !== \ object\) {\n  // Patch: cuba ekstrak JSON"
start = s.find(start_marker)
if start == -1:
    print("RALAT: start marker tidak dijumpai")
    exit(1)
end_marker = "  const senarai = (v: any, had: number)"
end = s.find(end_marker, start)
if end == -1:
    print("RALAT: end marker tidak dijumpai")
    exit(1)
inner = s[start + len("if (!obj || typeof obj !== \object\) {\n"):end]
new_text = inner.lstrip()
s2 = s[:start] + new_text + s[end:]
with open("src/agent.ts", "w", encoding="utf-8") as f:
    f.write(s2)
print("OK: servisSentimen dibetulkan")
