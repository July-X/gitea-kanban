with open('/tmp/vscode-graph-runtime/web/graph.ts') as f:
    s = f.read()
for c in ['Branch', 'Vertex', 'Graph']:
    s = s.replace('class ' + c + ' {', 'export class ' + c + ' {')
# 也把 getNextParent/getColour/colourUsedAt 等关键内部访问改成 public
open('/tmp/vscode-graph-runtime/web/graph.ts', 'w').write(s)
print('done')