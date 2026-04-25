# Conveyor Layout Editor

A web-based CSV layout editor styled like the provided Voith-style conveyor tool.

## CSV format

Recommended columns:

```csv
id,strand,x,y,z,tags
0,Carry,0,0,0,tail; feed
1,Carry,50,0,2,
7,Return,360,100,28,
```

Accepted aliases include `x (m)`, `y (m)`, `z (m)`, `type`, `group`, and `elevation`.

## Features

- Upload CSV
- Add and delete nodes
- Export CSV / JSON
- Side view: cumulative arc length vs elevation
- Top view: X/Y plan view
- Pseudo-3D conveyor visualization with perspective/ortho toggle
- Editable node table
- Click/select nodes across all panels
- Drag nodes in top view to edit X/Y
- Drag nodes in side view to edit Z

## Run

```bash
npm install
npm run dev
```
