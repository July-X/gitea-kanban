import yaml
import sys

with open('.github/workflows/release.yml') as f:
    data = yaml.safe_load(f)

print("jobs:", list(data['jobs'].keys()))
print("build matrix:", len(data['jobs']['build']['strategy']['matrix']['include']), "platforms")
for m in data['jobs']['build']['strategy']['matrix']['include']:
    print(f"  - {m['os']} / {m['platform']}-{m['arch']} → {m['artifact']}")
print()
print("publish needs:", data['jobs']['publish']['needs'])
print("publish steps count:", len(data['jobs']['publish']['steps']))
print()
for i, s in enumerate(data['jobs']['publish']['steps']):
    name = s.get('name', f"<no name: {s.get('uses', s.get('run', '?'))[:50]}>")
    print(f"  [{i}] {name}")
print()
print("syntax: OK")