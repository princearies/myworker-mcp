import re
with open('src/agent.ts', encoding='utf-8') as f:
    s = f.read()
lines = s.split('\n')
start = next(i for i, l in enumerate(lines) if 'async function servisSentimen' in l)
end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == '}' and i > start + 10)
o = c = 0
for i in range(start, end + 1):
    l = lines[i].replace( ", "")
    l = re.sub(r \[^\]*\', '', l)
    l = re.sub(r'/[^/]*\/[gimsuy]*', '', l)
    o += len(re.findall('{', l))
    c += len(re.findall('}', l))
print('Fungsi servisSentimen: baris', start + 1, 'hingga', end + 1)
print('{:', o, '}:', c)
print('Seimbang:', o == c)
