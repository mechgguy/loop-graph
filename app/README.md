# Conveyor Layout Editor

A web-based layout editor styled like the provided Voith-style conveyor tool.

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

- Upload CSV, JSON (networkX node link or normal), xls, xlsx, dxf (run backend first)
- Upload heightmap
- Add and delete nodes
- Undo action key
- Export CSV / JSON / PNG image
- Side view: cumulative arc length vs elevation
- Top view: X/Y plan view
- Pseudo-3D conveyor visualization with perspective/ortho toggle
- Editable node table
- Click/select nodes across all panels
- Drag nodes in top view to edit X/Y
- Drag nodes in side view to edit Z
- Object/Node snap
- Scale Z and along plane
- fit nodes as a group to the heightmap
- multiselect nodes to move or delete together
- Clear all button for a blank worksheet
- Warnings when elevation (pitch angle) or yaw (radius of curvature) is high than a preset value  

## Run

```bash
cd loop-graph/app

npm install

chmod +x node_modules/.bin/vite

npm run dev
```

### Run backend for data import

```bash
pip install ezdxf flask_cors openpyxl

python src/backend.py

npm run dev
```

#### Helper functions
1. `src/generate_dfx.py` to generate sample dxf file from csv input for testing.
2. `src/backend.py` python backend to support file import (node link information) for various data types.
