createRoot(document.getElementById('root')).render(<App />);
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import * as d3 from 'd3';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './styles.css';

// --- constants (merged: grid constants from tmp3, clearance constants from tmp3, colours from both) ---
const RETURN = '#e52b2f';
const CARRY = '#0037d8';
const DEFAULT_CSV_PATH = '/path_simple.csv';

const TERRAIN_SIZE = 1000;               // metres at planeScale = 1
const TERRAIN_DISPLACEMENT_SCALE = 200;  // metres at zScale = 1
const HEIGHTMAP_PATH = '/Heightmap_Joy2.png';

const GRID_SIZE_METERS = 2600;
const GRID_SPACING_METERS = 10;

const MIN_CLEARANCE_ABOVE_WIREFRAME = 20;
const MAX_CLEARANCE_ABOVE_WIREFRAME = 50;

// --- helper functions (merged: keep tmp3's num, parts from both) ---
function num(v, fallback = 0) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function tagsToString(value) {
  if (Array.isArray(value)) return value.join('; ');
  return String(value ?? '');
}

function makeIncidenceMatrix(n) {
  const B = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    B[i][i] = -1;
    B[(i + 1) % n][i] = 1;
  }
  return B;
}

function strandFromGroup(group) {
  return Number(group) === 1 ? 'Return' : 'Carry';
}

function strandValueFromGroup(group) {
  return Number(group) === 1 ? 1 : -1;
}

function normalizeRow(row, index) {
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v])
  );

  const group = num(lower.group ?? lower.strand ?? 0);
  const z = num(lower.z ?? lower['z (m)'] ?? lower.elevation);

  return {
    id: lower.id ?? lower.node_id ?? index,
    strand: strandFromGroup(group),
    strandValue: strandValueFromGroup(group),
    x: num(lower.x ?? lower['x (m)'] ?? lower.pos_x),
    y: num(lower.y ?? lower['y (m)'] ?? lower.pos_y),
    z,
    originalZ: z,
    group,
    tags: tagsToString(lower.tags ?? lower.tag ?? ''),
    fromCsv: true,
    fittedToWireframe: false,
    wireframeZ: null,
    raw: row
  };
}

function rowsFromCsvText(csvText) {
  const result = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true
  });

  const rows = result.data
    .filter((r) => Object.values(r).some((v) => String(v ?? '').trim()))
    .map(normalizeRow);

  const incidenceMatrix = makeIncidenceMatrix(rows.length);

  return rows.map((row, i) => ({
    ...row,
    incidenceRow: incidenceMatrix[i],
    incidenceMatrix
  }));
}

function parseCsvFile(file, onRows, onError) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (result) => {
      const csvText = Papa.unparse(result.data);
      const rows = rowsFromCsvText(csvText);
      if (!rows.length) {
        onError('No valid rows found. Expected columns: id, x, y, z, group, tags.');
      } else {
        onRows(rows);
      }
    },
    error: (err) => onError(err.message)
  });
}

function strandColor(strand) {
  return String(strand).toLowerCase().includes('return') ? RETURN : CARRY;
}

function sortedByStrand(rows, strand) {
  return rows
    .filter((r) => r.strand === strand)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function distanceHorizontal(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function distance3d(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}


function checkPathSafety(nodes, minRadius = 10.0) {
  const warnings = new Map();

  ['Carry', 'Return'].forEach((strandType) => {
    const strandNodes = sortedByStrand(nodes, strandType);

    for (let i = 0; i < strandNodes.length - 1; i++) {
      const p1 = strandNodes[i];
      const p2 = strandNodes[i + 1];

      const run = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const rise = Math.abs(p2.z - p1.z);
      const gradient = run === 0 ? (rise > 0 ? Infinity : 0) : rise / run;

      if (gradient > 0.18) {
        const gradPercent = (gradient * 100).toFixed(1);
        const msg = `Gradient between ${p1.id} and ${p2.id} is ${gradPercent}% (> 18%)`;
        warnings.set(p1.id, warnings.has(p1.id) ? warnings.get(p1.id) + ' | ' + msg : msg);
        warnings.set(p2.id, warnings.has(p2.id) ? warnings.get(p2.id) + ' | ' + msg : msg);
      }
    }

    for (let i = 0; i < strandNodes.length - 2; i++) {
      const A = strandNodes[i];
      const B = strandNodes[i + 1];
      const C = strandNodes[i + 2];

      const a = distance3d(A, B);
      const b = distance3d(B, C);
      const c = distance3d(A, C);

      const ABx = B.x - A.x, ABy = B.y - A.y, ABz = B.z - A.z;
      const ACx = C.x - A.x, ACy = C.y - A.y, ACz = C.z - A.z;
      const crossX = ABy * ACz - ABz * ACy;
      const crossY = ABz * ACx - ABx * ACz;
      const crossZ = ABx * ACy - ABy * ACx;
      const crossNorm = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);

      let radius = Infinity;
      if (crossNorm !== 0) radius = (a * b * c) / (2 * crossNorm);

      if (radius < minRadius) {
        const msg = `Radius at node ${B.id} is ${radius.toFixed(2)}m (< ${minRadius}m)`;
        warnings.set(B.id, warnings.has(B.id) ? warnings.get(B.id) + ' | ' + msg : msg);
      }
    }
  });

  return warnings;
}

function metrics(rows) {
  if (!rows.length) {
    return { nodes: 0, carry: 0, ret: 0, lengthKm: 0, zMin: 0, zMax: 0 };
  }
  const carry = rows.filter((r) => r.strand === 'Carry').length;
  const ret = rows.filter((r) => r.strand === 'Return').length;
  const zs = rows.map((r) => r.z);
  const length = ['Carry', 'Return'].reduce((sum, s) => {
    const line = sortedByStrand(rows, s);
    return sum + line.slice(1).reduce((acc, p, i) => acc + distance3d(line[i], p), 0);
  }, 0);
  return {
    nodes: rows.length,
    carry,
    ret,
    lengthKm: length / 1000,
    zMin: Math.min(...zs),
    zMax: Math.max(...zs)
  };
}

// Heightmap sampler: returns a function that accepts localX, localY, terrainSize, displacementScale (tmp3 version)
function loadHeightmapSampler(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, img.width, img.height).data;

      function sampleHeight(localX, localY, terrainSize, displacementScale) {
        const half = terrainSize / 2;
        const u = (localX + half) / terrainSize;
        const v = (localY + half) / terrainSize;

        if (u < 0 || u > 1 || v < 0 || v > 1) {
          return null;
        }

        const px = Math.min(
          img.width - 1,
          Math.max(0, Math.floor(u * (img.width - 1)))
        );
        const py = Math.min(
          img.height - 1,
          Math.max(0, Math.floor((1 - v) * (img.height - 1)))
        );
        const idx = (py * img.width + px) * 4;
        const r = imageData[idx];
        const g = imageData[idx + 1];
        const b = imageData[idx + 2];
        const brightness = (r + g + b) / 3 / 255;
        return brightness * displacementScale;
      }

      resolve(sampleHeight);
    };

    img.onerror = reject;
    img.src = src;
  });
}

// --- MiniPlot (from main.jsx but stretched view improved with tmp3's return offset) ---

function MiniPlot({ title, mode, rows, selectedIds, onSelect, onDragNode, onDragMultipleNodes }) {
  const svgRef = useRef(null);
  const [stretched, setStretched] = useState(false);
  const dragStartPositions = useRef(new Map());

  const w = 760;
  const h = 255;
  const margin = { top: 32, right: 24, bottom: 40, left: 56 };

  const carryRowsRaw = sortedByStrand(rows, 'Carry');
  const returnRowsRaw = sortedByStrand(rows, 'Return').reverse();

  const visualOffset = (mode === 'side' && !stretched) ? 5.0 : 0;
  const carryRows = carryRowsRaw.map(r => ({ ...r, visualZ: r.z }));
  const returnRows = returnRowsRaw.map(r => ({ ...r, visualZ: r.z - visualOffset }));

  const getArcData = (strandRows, startOffset = 0) => {
    if (strandRows.length === 0) return [];
    let total = startOffset;
    return strandRows.map((r, i) => {
      if (i > 0) total += distanceHorizontal(strandRows[i - 1], r);
      return { ...r, arc: total, visualZ: r.visualZ };
    });
  };

  const carryArc = getArcData(carryRows, 0);
  const totalCarryLength = carryArc.length > 0 ? carryArc[carryArc.length - 1].arc : 0;
  const returnArc = getArcData(returnRows, totalCarryLength);
  const totalReturnLength = returnArc.length > 0 ? returnArc[returnArc.length - 1].arc - totalCarryLength : 0;

  const getDataForDisplay = () => {
    if (mode === 'side' && stretched) {
      return { carry: carryArc, ret: returnArc, all: [...carryArc, ...returnArc] };
    }
    return { carry: carryRows, ret: returnRows, all: [...carryRows, ...returnRows] };
  };

  const displayData = getDataForDisplay();
  const dataByStrand = [
    { strand: 'Carry', rows: displayData.carry },
    { strand: 'Return', rows: displayData.ret }
  ];
  const all = displayData.all;

  const xValue = mode === 'side' && stretched ? (d) => d.arc : (d) => d.x;
  const yValue = mode === 'side' ? (d) => d.visualZ : (d) => d.y;

  const xDomain = d3.extent(all, xValue);
  const yDomain = d3.extent(all, yValue);

  const horizontalPadding = (mode === 'side' && !stretched) ? 20 : 0;

  const x = d3.scaleLinear()
    .domain(xDomain[0] === xDomain[1] ? [xDomain[0] - 1, xDomain[1] + 1] : xDomain)
    .nice()
    .range([margin.left + horizontalPadding, w - margin.right - horizontalPadding]);

  const y = d3.scaleLinear()
    .domain(yDomain[0] === yDomain[1] ? [yDomain[0] - 1, yDomain[1] + 1] : yDomain)
    .nice()
    .range([h - margin.bottom, margin.top]);

  const line = d3.line()
    .x((d) => x(xValue(d)))
    .y((d) => y(yValue(d)))
    .defined(() => true);

  function startDrag(event, d) {
    event.preventDefault();
    const svg = svgRef.current;
    const isMultiDrag = selectedIds && selectedIds.size > 1 && selectedIds.has(d.id);

    if (isMultiDrag) {
      dragStartPositions.current.clear();
      selectedIds.forEach(id => {
        const node = rows.find(r => r.id === id);
        if (node) dragStartPositions.current.set(id, { x: node.x, y: node.y, z: node.z });
      });
    }

    const move = (e) => {
      const pt = d3.pointer(e, svg);

      if (isMultiDrag && onDragMultipleNodes) {
        const startPos = dragStartPositions.current.get(d.id);
        if (!startPos) return;

        const nodeUpdates = new Map();
        if (mode === 'top') {
          const deltaX = x.invert(pt[0]) - startPos.x;
          const deltaY = y.invert(pt[1]) - startPos.y;
          selectedIds.forEach(id => {
            const startNodePos = dragStartPositions.current.get(id);
            if (startNodePos) nodeUpdates.set(id, { x: startNodePos.x + deltaX, y: startNodePos.y + deltaY });
          });
        } else if (mode === 'side') {
          const trueZ = d.strand === 'Return' ? y.invert(pt[1]) + visualOffset : y.invert(pt[1]);
          const deltaZ = trueZ - startPos.z;
          selectedIds.forEach(id => {
            const startNodePos = dragStartPositions.current.get(id);
            if (startNodePos) {
              nodeUpdates.set(id, { z: startNodePos.z + deltaZ });
            }
          });
        }
        onDragMultipleNodes(nodeUpdates);
      } else {
        if (mode === 'top') {
          onDragNode(d.id, { x: x.invert(pt[0]), y: y.invert(pt[1]) });
        }
        if (mode === 'side') {
          const trueZ = d.strand === 'Return' ? y.invert(pt[1]) + visualOffset : y.invert(pt[1]);
          onDragNode(d.id, { z: trueZ });
        }
      }
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  const formatNumber = (value) => {
    if (Math.abs(value) >= 1000) return (value / 1000).toFixed(1) + 'k';
    return value.toFixed(0);
  };

  let headPulleyPath = null;
  let tailPulleyPath = null;
  let headPulleyCircle = null;
  let tailPulleyCircle = null;

  if (mode === 'side' && !stretched && displayData.carry.length > 0 && displayData.ret.length > 0) {
    const firstCarry = displayData.carry[0]; 
    const lastCarry = displayData.carry[displayData.carry.length - 1]; 
    const firstReturn = displayData.ret[displayData.ret.length - 1];
    const lastReturn = displayData.ret[0];

    const headRadius = Math.abs(y(yValue(lastCarry)) - y(yValue(firstReturn))) / 2;
    if (headRadius > 0 && headRadius < 100) {
      const cx = (x(xValue(lastCarry)) + x(xValue(firstReturn))) / 2;
      const cy = (y(yValue(lastCarry)) + y(yValue(firstReturn))) / 2;
      headPulleyCircle = { cx, cy, r: headRadius };
      headPulleyPath = `M ${x(xValue(lastCarry))},${y(yValue(lastCarry))} 
                        A ${headRadius},${headRadius} 0 0,1 
                        ${x(xValue(firstReturn))},${y(yValue(firstReturn))}`;
    }

    const tailRadius = Math.abs(y(yValue(lastReturn)) - y(yValue(firstCarry))) / 2;
    if (tailRadius > 0 && tailRadius < 100) {
      const cx = (x(xValue(firstCarry)) + x(xValue(lastReturn))) / 2;
      const cy = (y(yValue(firstCarry)) + y(yValue(lastReturn))) / 2;
      tailPulleyCircle = { cx, cy, r: tailRadius };
      tailPulleyPath = `M ${x(xValue(lastReturn))},${y(yValue(lastReturn))} 
                        A ${tailRadius},${tailRadius} 0 0,1 
                        ${x(xValue(firstCarry))},${y(yValue(firstCarry))}`;
    }
  }

  return (
    <section className="plot-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', minHeight: '32px' }}>
        <h3 style={{ margin: 0, fontSize: '0.9rem' }}>{title}</h3>
        {mode === 'side' && (
          <button onClick={() => setStretched(!stretched)}
            style={{ padding: '6px 12px', fontSize: '11px', background: stretched ? '#e52b2f' : '#333', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            {stretched ? 'Stretched View' : 'Projected View'}
          </button>
        )}
      </div>

      {mode === 'side' && stretched && (
        <div style={{ fontSize: '15px', color: '#888', marginBottom: '12px', textAlign: 'center', padding: '4px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}>
            Total stretched length: {(totalCarryLength + totalReturnLength).toFixed(0)}m 
            (Carry: {totalCarryLength.toFixed(0)}m, Return: {totalReturnLength.toFixed(0)}m)
             <span style={{marginLeft: '12px', fontSize: '10px'}}>*X-axis shows true belt length*</span>
        </div>
      )}

      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          onClick={(e) => {
            if (e.target === e.currentTarget || e.target.classList.contains('background')) {
              onSelect(null, false);
            }
          }}
        >
          <rect className="background" width={w} height={h} fill="transparent" />

          <g className="gridlines">
            {x.ticks(8).map((t) => <line key={`x${t}`} x1={x(t)} x2={x(t)} y1={margin.top} y2={h - margin.bottom} />)}
            {y.ticks(5).map((t) => <line key={`y${t}`} x1={margin.left} x2={w - margin.right} y1={y(t)} y2={y(t)} />)}
          </g>

          <g className="x-axis-labels" fontSize="10" fill="#999" textAnchor="middle">
            {x.ticks(8).map((t) => <text key={`xtick${t}`} x={x(t)} y={h - margin.bottom + 15}>{formatNumber(t)}</text>)}
          </g>

          <g className="y-axis-labels" fontSize="10" fill="#999" textAnchor="end">
            {y.ticks(5).map((t) => <text key={`ytick${t}`} x={margin.left - 8} y={y(t) + 3}>{formatNumber(t)}</text>)}
          </g>

          <g className="axis-labels">
            <text x={w / 2} y={h - 8} textAnchor="middle" fontSize="12" fill="#888">
              {mode === 'side' ? (stretched ? 'Belt Arc Length (m)' : 'Horizontal Distance X (m)') : 'X (m)'}
            </text>
            <text transform={`translate(12 ${h / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="#888">
              {mode === 'side' ? 'Elevation Z (m)' : 'Y (m)'}
            </text>
          </g>

          {selectedIds && selectedIds.size > 1 && (
            <g className="selection-rectangles">
              {Array.from(selectedIds).map(id => {
                const node = all.find(d => d.id === id);
                if (!node) return null;
                return (
                  <rect key={`sel-${mode}-${id}`} x={x(xValue(node)) - 12} y={y(yValue(node)) - 12} width="24" height="24" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray="4 2" rx="4" />
                );
              })}
            </g>
          )}

          {tailPulleyCircle && (
            <g>
              <circle cx={tailPulleyCircle.cx} cy={tailPulleyCircle.cy} r={tailPulleyCircle.r} fill="#16a34a" stroke="#064e3b" strokeWidth="2" />
              <circle cx={tailPulleyCircle.cx} cy={tailPulleyCircle.cy} r={tailPulleyCircle.r * 0.3} fill="#064e3b" />
            </g>
          )}

          {headPulleyCircle && (
            <g>
              <circle cx={headPulleyCircle.cx} cy={headPulleyCircle.cy} r={headPulleyCircle.r} fill="#ffffff" />
              <path d={`M ${headPulleyCircle.cx},${headPulleyCircle.cy} L ${headPulleyCircle.cx},${headPulleyCircle.cy - headPulleyCircle.r} A ${headPulleyCircle.r},${headPulleyCircle.r} 0 0,1 ${headPulleyCircle.cx + headPulleyCircle.r},${headPulleyCircle.cy} Z`} fill="#f97316" />
              <path d={`M ${headPulleyCircle.cx},${headPulleyCircle.cy} L ${headPulleyCircle.cx},${headPulleyCircle.cy + headPulleyCircle.r} A ${headPulleyCircle.r},${headPulleyCircle.r} 0 0,1 ${headPulleyCircle.cx - headPulleyCircle.r},${headPulleyCircle.cy} Z`} fill="#f97316" />
              <line x1={headPulleyCircle.cx - headPulleyCircle.r} y1={headPulleyCircle.cy} x2={headPulleyCircle.cx + headPulleyCircle.r} y2={headPulleyCircle.cy} stroke="#666" strokeWidth="1" />
              <line x1={headPulleyCircle.cx} y1={headPulleyCircle.cy - headPulleyCircle.r} x2={headPulleyCircle.cx} y2={headPulleyCircle.cy + headPulleyCircle.r} stroke="#666" strokeWidth="1" />
              <circle cx={headPulleyCircle.cx} cy={headPulleyCircle.cy} r={headPulleyCircle.r} fill="none" stroke="#444" strokeWidth="1.5" />
            </g>
          )}

          {dataByStrand.map((strandData) =>
            strandData.rows.length > 1 && (
              <path key={strandData.strand} className={strandData.strand === 'Return' ? 'plot-line return' : 'plot-line carry'} d={line(strandData.rows)} opacity={stretched ? 1 : 0.8} fill="none" stroke="#666" strokeWidth="1.5" />
            )
          )}

          {headPulleyPath && <path d={headPulleyPath} fill="none" stroke="#666" strokeWidth="1.5" opacity={stretched ? 1 : 0.8} />}
          {tailPulleyPath && <path d={tailPulleyPath} fill="none" stroke="#666" strokeWidth="1.5" opacity={stretched ? 1 : 0.8} />}

          {all.map((d) => (
            <circle
              key={`${mode}-${d.id}`}
              className={`plot-dot ${selectedIds && selectedIds.has(d.id) ? 'selected' : ''}`}
              cx={x(xValue(d))} cy={y(yValue(d))} r={selectedIds && selectedIds.has(d.id) ? 8 : 6}
              fill={strandColor(d.strand)}
              onMouseDown={(e) => startDrag(e, d)}
              onClick={(e) => onSelect(d, e.ctrlKey || e.metaKey)}
            />
          ))}
        </svg>
      </div>

      {mode === 'side' && (
        <div style={{ fontSize: '10px', color: '#666', marginTop: '8px', textAlign: 'center' }}>
          Tip: Toggle between Projected actual X vs Z and Stretched true belt length vs Z<br />
          Ctrl/Cmd+Click to multi-select | Alt+A to select all | Delete to remove selected
        </div>
      )}
    </section>
  );
}


// --- Three.js helper components (merged from tmp3 with two-scale support) ---
function addTerrainMesh(planeScale, zScale, heightmapUrl = HEIGHTMAP_PATH) {
  const effectiveTerrainSize = TERRAIN_SIZE * planeScale;
  const effectiveDisplacementScale = TERRAIN_DISPLACEMENT_SCALE * zScale;

  const geometry = new THREE.PlaneGeometry(effectiveTerrainSize, effectiveTerrainSize, 256, 256);
  const textureLoader = new THREE.TextureLoader();

  const material = new THREE.MeshStandardMaterial({
    displacementScale: effectiveDisplacementScale,
    wireframe: false,
    flatShading: true,
    side: THREE.DoubleSide
  });

  textureLoader.load("/textures/moon_01_diff_4k.jpg", (diffuseTex) => {
    diffuseTex.wrapS = diffuseTex.wrapT = THREE.RepeatWrapping;
    diffuseTex.repeat.set(16, 16);
    diffuseTex.colorSpace = THREE.SRGBColorSpace;
    material.map = diffuseTex;
    material.needsUpdate = true;
  });

  textureLoader.load("/textures/moon_01_rough_4k.jpg", (roughTex) => {
    roughTex.wrapS = roughTex.wrapT = THREE.RepeatWrapping;
    roughTex.repeat.set(16, 16);
    roughTex.colorSpace = THREE.NoColorSpace;
    material.roughnessMap = roughTex;
    material.needsUpdate = true;
  });

  const heightmapTexture = textureLoader.load(heightmapUrl, () => {
    material.needsUpdate = true;
  });
  heightmapTexture.wrapS = heightmapTexture.wrapT = THREE.ClampToEdgeWrapping;
  heightmapTexture.repeat.set(1, 1);
  heightmapTexture.colorSpace = THREE.NoColorSpace;
  material.displacementMap = heightmapTexture;

  const terrain = new THREE.Mesh(geometry, material);
  terrain.position.set(0, 0, 0);
  return terrain;
}

function makeTextSprite(text, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 58px Arial';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 64);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(70, 35, 1);
  return sprite;
}


function createConveyorRibbonGeometry(points, width = 22, isTroughed = true) {
  const vertices = [];
  const indices = [];
  const up = new THREE.Vector3(0, 0, 1);
  const centerRatio = 0.4;
  const sideRatio = 0.3;
  const troughAngle = Math.PI / 6;

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(i - 1, 0)];
    const next = points[Math.min(i + 1, points.length - 1)];

    const tangent = new THREE.Vector3().subVectors(next, prev);
    tangent.z = 0;
    if (tangent.length() < 0.001) tangent.set(1, 0, 0);
    tangent.normalize();

    const side = new THREE.Vector3().crossVectors(up, tangent).normalize();
    const centerW = width * centerRatio;
    const sideW = width * sideRatio;

    const leftCenter = points[i].clone().add(side.clone().multiplyScalar(centerW / 2));
    const rightCenter = points[i].clone().sub(side.clone().multiplyScalar(centerW / 2));

    if (isTroughed) {
      const verticalRise = Math.sin(troughAngle) * sideW;
      const horizontalRun = Math.cos(troughAngle) * sideW;

      const farLeft = leftCenter.clone().add(side.clone().multiplyScalar(horizontalRun)).add(new THREE.Vector3(0, 0, verticalRise));
      const farRight = rightCenter.clone().sub(side.clone().multiplyScalar(horizontalRun)).add(new THREE.Vector3(0, 0, verticalRise));

      vertices.push(
        farLeft.x, farLeft.y, farLeft.z + 1.5,
        leftCenter.x, leftCenter.y, leftCenter.z + 1.5,
        rightCenter.x, rightCenter.y, rightCenter.z + 1.5,
        farRight.x, farRight.y, farRight.z + 1.5
      );

      if (i < points.length - 1) {
        const row = i * 4;
        const nextRow = (i + 1) * 4;
        indices.push(row, nextRow, row + 1);
        indices.push(nextRow, nextRow + 1, row + 1);
        indices.push(row + 1, nextRow + 1, row + 2);
        indices.push(nextRow + 1, nextRow + 2, row + 2);
        indices.push(row + 2, nextRow + 2, row + 3);
        indices.push(nextRow + 2, nextRow + 3, row + 3);
      }
    } else {
      const left = points[i].clone().add(side.clone().multiplyScalar(width / 2));
      const right = points[i].clone().sub(side.clone().multiplyScalar(width / 2));

      vertices.push(left.x, left.y, left.z + 1.5);
      vertices.push(right.x, right.y, right.z + 1.5);

      if (i < points.length - 1) {
        const row = i * 2;
        const nextRow = (i + 1) * 2;
        indices.push(row, nextRow, row + 1);
        indices.push(nextRow, nextRow + 1, row + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}


function addTube(scene, points, color, radius = 2.2) {
  if (points.length < 2) return;
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, Math.max(24, points.length * 8), radius, 10, false);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.25 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.dynamicGraph = true;
  scene.add(mesh);
}

function addRoller(scene, position, tangent, width, selected = false) {
  const horizontal = tangent.clone();
  horizontal.z = 0;
  if (horizontal.length() < 0.001) horizontal.set(1, 0, 0);
  horizontal.normalize();
  const side = new THREE.Vector3(-horizontal.y, horizontal.x, 0).normalize();
  const geometry = new THREE.CylinderGeometry(3.5, 3.5, width + 12, 18);
  const material = new THREE.MeshStandardMaterial({
    color: selected ? 0xffff66 : 0xb7b7b7,
    roughness: 0.35,
    metalness: 0.5
  });
  const roller = new THREE.Mesh(geometry, material);
  roller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), side);
  roller.position.copy(position);
  roller.position.z += 0.2;
  roller.userData.dynamicGraph = true;
  scene.add(roller);
}

function addSupport(scene, position) {
  if (Math.abs(position.z) < 0.2) return;
  const height = Math.abs(position.z);
  const centerZ = position.z / 2;
  const geometry = new THREE.CylinderGeometry(2.4, 2.4, height, 12);
  const material = new THREE.MeshStandardMaterial({ color: 0x5c5c5c, roughness: 0.6, metalness: 0.4 });
  const support = new THREE.Mesh(geometry, material);
  support.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));
  support.position.set(position.x, position.y, centerZ);
  support.userData.dynamicGraph = true;
  scene.add(support);
}

function buildConveyor(scene, lineRows, strand, toVec, selectedId) {
  if (lineRows.length < 2) return;
  const color = strand === 'Carry' ? CARRY : RETURN;
  const beltWidth = strand === 'Carry' ? 24 : 20;

  const points = lineRows.map(toVec);
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.2);
  const sampled = [];
  const sampleCount = Math.max(40, points.length * 12);
  for (let i = 0; i <= sampleCount; i++) {
    sampled.push(curve.getPoint(i / sampleCount));
  }

  const isTroughed = strand === 'Carry';
  const beltGeometry = createConveyorRibbonGeometry(sampled, beltWidth, isTroughed);
  const beltMaterial = new THREE.MeshStandardMaterial({
    color: strand === 'Carry' ? 0x111827 : 0x2a1010,
    roughness: 0.65,
    metalness: 0.12,
    side: THREE.DoubleSide
  });
  const belt = new THREE.Mesh(beltGeometry, beltMaterial);
  belt.userData.dynamicGraph = true;
  scene.add(belt);

  const railOffset = beltWidth / 2 + 3;
  const leftRail = [], rightRail = [];
  for (let i = 0; i < sampled.length; i++) {
    const prev = sampled[Math.max(i - 1, 0)];
    const next = sampled[Math.min(i + 1, sampled.length - 1)];
    const tangent = new THREE.Vector3().subVectors(next, prev);
    tangent.z = 0;
    if (tangent.length() < 0.001) tangent.set(1, 0, 0);
    tangent.normalize();
    const side = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize().multiplyScalar(railOffset);
    leftRail.push(sampled[i].clone().add(side).add(new THREE.Vector3(0, 0, 4)));
    rightRail.push(sampled[i].clone().sub(side).add(new THREE.Vector3(0, 0, 4)));
  }
  addTube(scene, leftRail, color, 1.7);
  addTube(scene, rightRail, color, 1.7);

  const rollerEvery = 0.06;
  for (let t = 0; t <= 1; t += rollerEvery) {
    const p = curve.getPointAt(t);
    addRoller(scene, p, curve.getTangentAt(t), beltWidth, false);
    addSupport(scene, p);
  }

  lineRows.forEach((row) => {
    const p = toVec(row);
    const selected = row.id === selectedId;
    const geometry = new THREE.SphereGeometry(selected ? 8 : 5.5, 24, 24);
    const material = new THREE.MeshStandardMaterial({
      color: strandColor(row.strand),
      emissive: strandColor(row.strand),
      emissiveIntensity: selected ? 0.8 : 0.25,
      roughness: 0.45,
      metalness: 0.15
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(p);
    mesh.position.z += 4;
    mesh.userData.dynamicGraph = true;
    mesh.userData.row = row;
    scene.add(mesh);

    if (row.tags && row.tags.trim() !== "") {
      const labelSprite = makeTextSprite(row.tags, "#ffffff");
      labelSprite.position.set(p.x, p.y, p.z + 15);
      labelSprite.scale.set(40, 20, 1);
      labelSprite.userData.dynamicGraph = true;
      scene.add(labelSprite);
    }
  });
}

// --- View3D (merged: grid constants, terrain hint, two-scale, but multi-select from 3D click is single select) ---

function addTerminalPulleys(scene, carryRows, returnRows, toVec, width = 28) {
  if (carryRows.length < 2 || returnRows.length === 0) return;

  const firstCarry = toVec(carryRows[0]);
  const lastCarry = toVec(carryRows[carryRows.length - 1]);
  const firstReturn = toVec(returnRows[returnRows.length - 1]);
  const lastReturn = toVec(returnRows[0]);

  function drawDrum(posTop, posBottom, isDrive, beltDir) {
    const radius = Math.abs(posTop.z - posBottom.z) / 2;
    if (radius < 0.1 || radius > 150) return;

    const center = new THREE.Vector3().addVectors(posTop, posBottom).multiplyScalar(0.5);
    beltDir.z = 0;
    if (beltDir.lengthSq() < 0.001) beltDir.set(1, 0, 0);
    beltDir.normalize();
    const sideVec = new THREE.Vector3(-beltDir.y, beltDir.x, 0).normalize();

    const drumGeo = new THREE.CylinderGeometry(radius, radius, width, 32);
    const drumMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9, metalness: 0.1 });
    const drum = new THREE.Mesh(drumGeo, drumMat);
    drum.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sideVec);
    drum.position.copy(center);
    drum.userData.dynamicGraph = true;
    scene.add(drum);

    const axleRadius = radius * 0.15;
    const axleGeo = new THREE.CylinderGeometry(axleRadius, axleRadius, width + 10, 16);
    const axleMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.4, metalness: 0.8 });
    const axle = new THREE.Mesh(axleGeo, axleMat);
    axle.quaternion.copy(drum.quaternion);
    axle.position.copy(center);
    axle.userData.dynamicGraph = true;
    scene.add(axle);

    if (isDrive) {
      const blueMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.5, metalness: 0.3 });
      const steelMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.3, metalness: 0.9 });

      const gearBoxOffset = (width / 2) + 5;
      const gearBoxCenter = center.clone().add(sideVec.clone().multiplyScalar(gearBoxOffset));

      const boxSize = radius * 1.8;
      const boxWidth = 8;
      const gearBoxGeo = new THREE.BoxGeometry(boxWidth, boxSize, boxSize * 0.8);
      const gearBox = new THREE.Mesh(gearBoxGeo, blueMat);
      gearBox.quaternion.copy(drum.quaternion);
      gearBox.position.copy(gearBoxCenter);
      gearBox.userData.dynamicGraph = true;
      scene.add(gearBox);

      const flangeGeo = new THREE.CylinderGeometry(radius * 0.4, radius * 0.4, 2, 16);
      const flange = new THREE.Mesh(flangeGeo, steelMat);
      flange.quaternion.copy(drum.quaternion);
      flange.position.copy(center).add(sideVec.clone().multiplyScalar((width / 2) + 1));
      flange.userData.dynamicGraph = true;
      scene.add(flange);

      const motorRadius = radius * 0.6;
      const motorLength = radius * 2.5;
      const motorGeo = new THREE.CylinderGeometry(motorRadius, motorRadius, motorLength, 24);
      const motor = new THREE.Mesh(motorGeo, blueMat);
      motor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beltDir.clone().negate());

      const motorPos = gearBoxCenter.clone().add(beltDir.clone().negate().multiplyScalar(motorLength / 2));
      motorPos.z += (boxSize * 0.1); 
      motor.position.copy(motorPos);
      motor.userData.dynamicGraph = true;
      scene.add(motor);

      const finSpacing = 2.5;
      const numFins = Math.floor((motorLength * 0.8) / finSpacing);
      const startOffset = -((numFins * finSpacing) / 2);

      for (let i = 0; i < numFins; i++) {
        const finGeo = new THREE.TorusGeometry(motorRadius, 0.4, 8, 24);
        const fin = new THREE.Mesh(finGeo, blueMat);
        fin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), beltDir.clone().negate());
        const finPos = motorPos.clone().add(beltDir.clone().negate().multiplyScalar(startOffset + (i * finSpacing)));
        fin.position.copy(finPos);
        fin.userData.dynamicGraph = true;
        scene.add(fin);
      }

      const capGeo = new THREE.CylinderGeometry(motorRadius * 0.8, motorRadius, 3, 24);
      const capMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.quaternion.copy(motor.quaternion);
      cap.position.copy(motorPos.clone().add(beltDir.clone().negate().multiplyScalar(motorLength / 2 + 1.5)));
      cap.userData.dynamicGraph = true;
      scene.add(cap);

    } else {
      const capGeo = new THREE.CylinderGeometry(radius * 0.9, radius * 0.9, 1, 32);
      const capMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.6 }); 

      const leftCap = new THREE.Mesh(capGeo, capMat);
      leftCap.quaternion.copy(drum.quaternion);
      leftCap.position.copy(center).sub(sideVec.clone().multiplyScalar((width / 2) + 0.5));
      leftCap.userData.dynamicGraph = true;
      scene.add(leftCap);

      const rightCap = new THREE.Mesh(capGeo, capMat);
      rightCap.quaternion.copy(drum.quaternion);
      rightCap.position.copy(center).add(sideVec.clone().multiplyScalar((width / 2) + 0.5));
      rightCap.userData.dynamicGraph = true;
      scene.add(rightCap);
    }
  }

  const headDir = new THREE.Vector3().subVectors(lastCarry, toVec(carryRows[carryRows.length - 2]));
  const tailDir = new THREE.Vector3().subVectors(toVec(carryRows[1]), firstCarry);

  drawDrum(lastCarry, firstReturn, true, headDir);
  drawDrum(firstCarry, lastReturn, false, tailDir);
}

function View3D({ rows, selectedId, selectedIds, planeScale, zScale, heightmapUrl, onSelect }) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const sceneRef = useRef(null);
  const terrainRef = useRef(null);
  const conveyorGroupRef = useRef(null);
  const savedCameraState = useRef({
    position: new THREE.Vector3(520, -720, 420),
    target: new THREE.Vector3(0, 0, 0)
  });

  // Main scene init – rebuilds only when terrain scales or heightmap change
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (cameraRef.current && controlsRef.current) {
      savedCameraState.current.position.copy(cameraRef.current.position);
      savedCameraState.current.target.copy(controlsRef.current.target);
    }

    while (container.firstChild) container.removeChild(container.firstChild);
    container.innerHTML = '';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030711);
    sceneRef.current = scene;

    const width = container.clientWidth;
    const height = container.clientHeight;
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 1000000);
    camera.position.copy(savedCameraState.current.position);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.copy(savedCameraState.current.target);
    controls.update();
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const sun = new THREE.DirectionalLight(0xfff5e6, 1.2);
    sun.position.set(300, -500, 800);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffd9a0, 0.35);
    fill.position.set(-500, 400, 250);
    scene.add(fill);

    const terrain = addTerrainMesh(planeScale, zScale, heightmapUrl);
    terrainRef.current = terrain;
    scene.add(terrain);

    const gridDivisions = GRID_SIZE_METERS / GRID_SPACING_METERS;
    const grid = new THREE.GridHelper(GRID_SIZE_METERS, gridDivisions, 0x4b4030, 0x2d271f);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.04;
    scene.add(grid);

    function axis(start, end, color) {
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const material = new THREE.LineBasicMaterial({ color });
      scene.add(new THREE.Line(geometry, material));
    }
    axis(new THREE.Vector3(-1100, 0, 0), new THREE.Vector3(1100, 0, 0), 0xff5555);
    axis(new THREE.Vector3(0, -1100, 0), new THREE.Vector3(0, 1100, 0), 0x55ff55);
    axis(new THREE.Vector3(0, 0, -250), new THREE.Vector3(0, 0, 500), 0x66aaff);

    ['X', 'Y', 'Z'].forEach((label, i) => {
      const color = ['#ff6666', '#66ff66', '#66aaff'][i];
      const pos = [new THREE.Vector3(1160, 0, 25), new THREE.Vector3(0, 1160, 25), new THREE.Vector3(0, 0, 540)][i];
      const sprite = makeTextSprite(label, color);
      sprite.position.copy(pos);
      scene.add(sprite);
    });

    const conveyorGroup = new THREE.Group();
    conveyorGroup.name = 'conveyorGroup';
    scene.add(conveyorGroup);
    conveyorGroupRef.current = conveyorGroup;

    if (rows.length > 0) {
      const xs = rows.map(r => r.x), ys = rows.map(r => r.y);
      const xMid = (Math.min(...xs) + Math.max(...xs)) / 2;
      const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
      function toVec(r) { const zOffset = r.strand === 'Return' ? 5.0 : 0; return new THREE.Vector3(r.x - xMid, r.y - yMid, r.z - zOffset); }
      const originalAdd = scene.add.bind(scene);
      scene.add = (obj) => conveyorGroup.add(obj);
      buildConveyor(scene, sortedByStrand(rows, 'Carry'), 'Carry', toVec, selectedId);
      buildConveyor(scene, sortedByStrand(rows, 'Return'), 'Return', toVec, selectedId);
      addTerminalPulleys(scene, sortedByStrand(rows, 'Carry'), sortedByStrand(rows, 'Return'), toVec);
      scene.add = originalAdd;
    }

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    function onClick(event) {
      const clickable = [];
      scene.traverse(obj => { if (obj.userData?.row) clickable.push(obj); });
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(clickable, false);
      if (hits.length > 0) onSelect(hits[0].object.userData.row);
    }
    renderer.domElement.addEventListener('click', onClick);

    function onResize() {
      const w = container.clientWidth, h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    let frameId;
    function animate() {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      renderer.dispose();
      container.innerHTML = '';
    };
  }, [planeScale, zScale, heightmapUrl]);

  // Conveyor update effect
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    let conveyorGroup = scene.getObjectByName('conveyorGroup');
    if (!conveyorGroup) {
      conveyorGroup = new THREE.Group();
      conveyorGroup.name = 'conveyorGroup';
      scene.add(conveyorGroup);
      conveyorGroupRef.current = conveyorGroup;
    }

    while (conveyorGroup.children.length > 0) {
      const obj = conveyorGroup.children[0];
      conveyorGroup.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    }

    if (rows.length === 0) return;

    const xs = rows.map(r => r.x), ys = rows.map(r => r.y);
    const xMid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
    function toVec(r) { const zOffset = r.strand === 'Return' ? 5.0 : 0; return new THREE.Vector3(r.x - xMid, r.y - yMid, r.z - zOffset); }
    const originalAdd = scene.add.bind(scene);
    scene.add = (obj) => conveyorGroup.add(obj);
    buildConveyor(scene, sortedByStrand(rows, 'Carry'), 'Carry', toVec, selectedId);
    buildConveyor(scene, sortedByStrand(rows, 'Return'), 'Return', toVec, selectedId);
      addTerminalPulleys(scene, sortedByStrand(rows, 'Carry'), sortedByStrand(rows, 'Return'), toVec);
    scene.add = originalAdd;
  }, [rows, selectedId]);

  // Terrain texture update
  useEffect(() => {
    if (!terrainRef.current || !heightmapUrl) return;
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(heightmapUrl, (newTexture) => {
      newTexture.wrapS = newTexture.wrapT = THREE.RepeatWrapping;
      newTexture.repeat.set(1, 1);
      terrainRef.current.material.displacementMap = newTexture;
      terrainRef.current.material.needsUpdate = true;
    });
  }, [heightmapUrl]);

  useEffect(() => {
    function handleKeyDown(e) {
      // 1. CTRL + Z (Undo)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }
  
      // 2. Select All (Alt + A)
      if (e.altKey && e.key === 'a') {
        e.preventDefault();
        if (rows.length > 0) {
          const allIds = new Set(rows.map(r => r.id));
          setSelectedIds(allIds);
          setLastSelectedId(rows[rows.length - 1].id);
          setStatus(`Selected all ${rows.length} nodes`);
        }
      }
  
      // 3. Delete / Backspace
      if ((e.key === 'Delete' || e.key === 'Backspace') &&
          e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        if (selectedIds.size > 0) {
          recordHistory(); // Record before deleting
          deleteNode();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [rows, selectedIds, history]); // Added history to deps

  const terrainFootprint = TERRAIN_SIZE * planeScale;
  const terrainHeightRange = TERRAIN_DISPLACEMENT_SCALE * zScale;

  return (
    <section className="view3d">
      <div className="view-head">
        <h3>3D CONVEYOR VIEW</h3>
        <span className="hint">
          1 unit = 1 m · Grid {GRID_SPACING_METERS} m · Terrain {terrainFootprint.toFixed(0)} m × {terrainFootprint.toFixed(0)} m · Height range {terrainHeightRange.toFixed(0)} m
        </span>
      </div>
      <div ref={containerRef} className="three-container" />
    </section>
  );
}

// --- NodeTable with OFFSET column (merged) ---
function NodeTable({ rows, selectedIds, fittedIds, onSelect, onEdit }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>STRAND</th>
            <th>X (m)</th>
            <th>Y (m)</th>
            <th>Z (m)</th>
            <th>OFFSET FROM TERRAIN</th>
            <th>TAGS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const offset = Number.isFinite(r.wireframeZ) && r.wireframeZ !== null
              ? (r.z - r.wireframeZ).toFixed(2) + ' m'
              : '—';

            return (
              <tr
                key={r.id}
                className={[
                  selectedIds?.has(r.id) ? 'selected-row' : '',
                  fittedIds?.has(r.id) ? 'fitted-row' : ''
                ].join(' ')}
                onClick={(e) => onSelect(r, e.ctrlKey || e.metaKey)}
                title={
                  fittedIds?.has(r.id) && r.wireframeZ !== null
                    ? `Adjusted. Wireframe Z = ${Number(r.wireframeZ).toFixed(2)} m`
                    : ''
                }
              >
                <td>{r.id}</td>
                <td><span className={`pill ${r.strand === 'Return' ? 'return' : ''}`}>{r.strand}</span></td>
                {['x', 'y', 'z'].map((k) => (
                  <td key={k}>
                    <input
                      value={Number(r[k]).toFixed(2)}
                      onChange={(e) => onEdit(r.id, { [k]: num(e.target.value, r[k]) })}
                    />
                  </td>
                ))}
                <td>{offset}</td>
                <td>
                  <input value={r.tags} onChange={(e) => onEdit(r.id, { tags: e.target.value })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Main App component (merged: multi-selection, original backup reset, clearance-based FIT, two scales) ---
function App() {
  const [rows, setRows] = useState([]);
  const originalRowsRef = useRef(null);            // for RESET ALL
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [lastSelectedId, setLastSelectedId] = useState(null);
  const [status, setStatus] = useState('Loading path_simple.csv...');
  const [heightmapUrl, setHeightmapUrl] = useState(HEIGHTMAP_PATH);
  const [fittedIds, setFittedIds] = useState(new Set());
  const [heightSampler, setHeightSampler] = useState(null);
  const [planeScale, setPlaneScale] = useState(1);
  const [zScale, setZScale] = useState(1);
  const [history, setHistory] = useState([]);

  // Load default CSV
  useEffect(() => {
    fetch(DEFAULT_CSV_PATH)
      .then((res) => {
        if (!res.ok) throw new Error('Could not load /path_simple.csv.');
        return res.text();
      })
      .then((csvText) => {
        const loadedRows = rowsFromCsvText(csvText);
        originalRowsRef.current = JSON.parse(JSON.stringify(loadedRows));
        setRows(loadedRows);
        setFittedIds(new Set());
        setStatus(`Loaded ${loadedRows.length} nodes from path_simple.csv`);
      })
      .catch((err) => setStatus(err.message));
  }, []);

  // Load heightmap sampler (tmp3 version)
  useEffect(() => {
    loadHeightmapSampler(heightmapUrl)
      .then((sampler) => setHeightSampler(() => sampler))
      .catch(() => setStatus('Could not load heightmap for FIT operation.'));
  }, [heightmapUrl]);

  // Keyboard shortcuts (main.jsx)
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.altKey && e.key === 'a') {
        e.preventDefault();
        if (rows.length > 0) {
          const allIds = new Set(rows.map(r => r.id));
          setSelectedIds(allIds);
          setLastSelectedId(rows[rows.length - 1].id);
          setStatus(`Selected all ${rows.length} nodes`);
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') &&
          e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        deleteNode();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [rows, selectedIds]);

  const m = useMemo(() => metrics(rows), [rows]);
  const selected = rows.find((r) => r.id === lastSelectedId);
  const pathWarnings = useMemo(() => checkPathSafety(rows), [rows]);

  // Multi-select handler (from main.jsx)
  function setSelected(row, ctrlKey = false) {
    if (!row || row.id === null) {
      setSelectedIds(new Set());
      setLastSelectedId(null);
      setStatus('Selection cleared');
      return;
    }
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (ctrlKey) {
        next.has(row.id) ? next.delete(row.id) : next.add(row.id);
      } else {
        next.clear();
        next.add(row.id);
      }
      setLastSelectedId(row.id);
      setStatus(`Selected ${next.size} node(s). Last: ${row.id}`);
      return next;
    });
  }

  // 3D view single select
  function onSelect3D(row) {
    setSelectedIds(new Set([row.id]));
    setLastSelectedId(row.id);
    setStatus(`Selected node ${row.id} (3D view)`);
  }

  // Update multiple nodes (drag)
  function updateMultipleNodes(nodeUpdates) {
    setRows(prev => prev.map(r => nodeUpdates.has(r.id) ? { ...r, ...nodeUpdates.get(r.id) } : r));
  }

  // Update single node
  function updateNode(id, patch) {
    recordHistory();

  const pathWarnings = useMemo(() => checkPathSafety(rows), [rows]);

  // function updateNode(id, patch) {
    setRows((prev) => {
      const targetNode = prev.find((r) => r.id === id);
      if (targetNode) {
        const tags = patch.tags !== undefined ? patch.tags : targetNode.tags;
        const isBeltNode = !tags || tags.trim() === '' || tags.toLowerCase().includes('belt');
        const isMoving = patch.x !== undefined || patch.y !== undefined || patch.z !== undefined;
        if (isBeltNode && isMoving) {
          const currentStrand = targetNode.strand;
          const oppositeStrand = currentStrand === 'Carry' ? 'Return' : 'Carry';
          setStatus(`⚠️ WARNING: Moving ${currentStrand} Belt Node ${id}. Make sure to move the corresponding ${oppositeStrand} node!`);
        }
      }
      return prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
    });

    setFittedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
    setFittedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
  }

  // Scale handlers (from tmp3)
  function updatePlaneScale(value) {
    const next = clamp(num(value, planeScale), 0.05, 20);
    setPlaneScale(next);
    setFittedIds(new Set());
    setStatus(`Plane scale set to ${next.toFixed(2)}x. Press FIT again to resnap nodes.`);
  }

  function updateZScale(value) {
    const next = clamp(num(value, zScale), 0, 20);
    setZScale(next);
    setFittedIds(new Set());
    setStatus(`Z scale set to ${next.toFixed(2)}x. Press FIT again to resnap nodes.`);
  }

  // Reset all: scales + original CSV rows (merged from main.jsx and tmp3)
  function resetAll() {
    setPlaneScale(1);
    setZScale(1);
    setFittedIds(new Set());
    setSelectedIds(new Set());
    setLastSelectedId(null);
    if (originalRowsRef.current) {
      setRows(JSON.parse(JSON.stringify(originalRowsRef.current)));
      setStatus('Reset: wireframe scales to 1.00x and nodes to original CSV values.');
    } else {
      setStatus('Wireframe scales reset. No original data to restore.');
    }
  }

  function recordHistory() {
    // Store a deep copy of the rows to the history stack
    setHistory(prev => [...prev, JSON.parse(JSON.stringify(rows))].slice(-30));
  }

  function undo() {
    if (history.length === 0) {
      setStatus("Nothing to undo.");
      return;
    }
    const previousState = history[history.length - 1];
    setRows(previousState);
    setHistory(prev => prev.slice(0, -1));
    setStatus("Undo successful.");
  }

  function clearAllNodes() {
    if (window.confirm("Delete ALL nodes from the workspace?")) {
      recordHistory();
      setRows([]);
      setSelectedIds(new Set());
      setLastSelectedId(null);
      setFittedIds(new Set());
      setStatus("Workspace cleared.");
    }
  }
  // FIT nodes with clearance rule (tmp3)
  function fitNodesToWireframe() {
    if (!heightSampler || !rows.length) {
      setStatus('Heightmap is not ready yet.');
      return;
    }
    recordHistory();
    const xs = rows.map(r => r.x);
    const ys = rows.map(r => r.y);
    const xMid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
    const effectiveTerrainSize = TERRAIN_SIZE * planeScale;
    const effectiveDisplacementScale = TERRAIN_DISPLACEMENT_SCALE * zScale;
    const adjusted = new Set();

    const fittedRows = rows.map(row => {
      if (!row.fromCsv) return row;
      const localX = row.x - xMid;
      const localY = row.y - yMid;
      const wireframeZ = heightSampler(localX, localY, effectiveTerrainSize, effectiveDisplacementScale);
      const baseZ = Number.isFinite(row.originalZ) ? row.originalZ : row.z;

      if (wireframeZ === null) {
        return { ...row, z: baseZ, fittedToWireframe: false, wireframeZ: null };
      }

      let fittedZ = baseZ;
      if (baseZ < wireframeZ) {
        fittedZ = wireframeZ + MIN_CLEARANCE_ABOVE_WIREFRAME;
      } else {
        fittedZ = Math.min(baseZ, wireframeZ + MAX_CLEARANCE_ABOVE_WIREFRAME);
      }

      const changed = Math.abs(fittedZ - baseZ) > 1e-6;
      if (changed) adjusted.add(row.id);
      return { ...row, z: fittedZ, fittedToWireframe: changed, wireframeZ };
    });

    setRows(fittedRows);
    setFittedIds(adjusted);
    setStatus(
      adjusted.size > 0
        ? `FIT complete: adjusted ${adjusted.size} node(s). Rule: min clearance ${MIN_CLEARANCE_ABOVE_WIREFRAME} m, max ${MAX_CLEARANCE_ABOVE_WIREFRAME} m.`
        : `FIT complete: no nodes needed adjustment.`
    );
  }

  // Add node (main.jsx with template)
  function addNode() {
    recordHistory();
    setRows(currentRows => {
      const maxId = currentRows.reduce((max, r) => Math.max(max, Number(r.id) || 0), -1);
      const newId = maxId + 1;
      const selectedNode = currentRows.find(r => r.id === lastSelectedId);
      const last = currentRows[currentRows.length - 1] ?? { x: 0, y: 0, z: 0 };
      const newNode = {
        id: newId,
        strand: selectedNode ? selectedNode.strand : 'Carry',
        strandValue: selectedNode ? selectedNode.strandValue : -1,
        group: selectedNode ? selectedNode.group : 0,
        x: last.x + 50,
        y: last.y,
        z: last.z,
        originalZ: last.z,
        tags: '',
        fromCsv: false,
        fittedToWireframe: false,
        wireframeZ: null
      };
      setStatus(`Added node ${newId}`);
      return [...currentRows, newNode];
    });
  }

  // Insert after (tmp3/main.jsx)
  function addNodeAfter() {
    if (lastSelectedId === null) {
      setStatus("Select a node first to insert after it!");
      return;
    }
    recordHistory();
    setRows(currentRows => {
      const currentIndex = currentRows.findIndex(r => r.id === lastSelectedId);
      if (currentIndex === -1) return currentRows;
      const selectedNode = currentRows[currentIndex];
      const nextNode = currentRows[currentIndex + 1];
      const newId = Math.max(...currentRows.map(r => Number(r.id) || 0)) + 1;
      const newNode = {
        ...selectedNode,
        id: newId,
        x: nextNode ? (selectedNode.x + nextNode.x) / 2 : selectedNode.x + 25,
        y: nextNode ? (selectedNode.y + nextNode.y) / 2 : selectedNode.y + 25,
        z: nextNode ? (selectedNode.z + nextNode.z) / 2 : selectedNode.z,
        fromCsv: false,
        tags: `Inserted after ${lastSelectedId}`,
        fittedToWireframe: false,
        wireframeZ: null
      };
      const updatedRows = [...currentRows];
      updatedRows.splice(currentIndex + 1, 0, newNode);
      setTimeout(() => {
        setSelectedIds(new Set([newId]));
        setLastSelectedId(newId);
        setStatus(`Inserted Node ${newId} between ${lastSelectedId} and ${nextNode?.id || 'End'}`);
      }, 0);
      return updatedRows;
    });
  }

  // Delete nodes (multi, from main.jsx)
  function deleteNode() {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setRows(r => r.filter(n => !selectedIds.has(n.id)));
    setFittedIds(prev => {
      const next = new Set(prev);
      selectedIds.forEach(id => next.delete(id));
      return next;
    });
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setStatus(`Deleted ${count} node(s)`);
  }

  function toggleStrand() {
    if (selectedIds.size === 0) return;
    recordHistory();
    setRows(prev => prev.map(r => {
      if (selectedIds.has(r.id)) {
        const isCurrentlyCarry = r.strand === 'Carry';
        return {
          ...r,
          strand: isCurrentlyCarry ? 'Return' : 'Carry',
          strandValue: isCurrentlyCarry ? 1 : -1,
          group: isCurrentlyCarry ? 1 : 0
        };
      }
      return r;
    }));
    setStatus(`Switched strand for ${selectedIds.size} node(s)`);
  }

  function exportFile(type) {
    const exportRows = rows.map(r => ({ id: r.id, x: r.x, y: r.y, z: r.z, group: r.group, tags: r.tags }));
    const data = type === 'json' ? JSON.stringify(exportRows, null, 2) : Papa.unparse(exportRows);
    const blob = new Blob([data], { type: type === 'json' ? 'application/json' : 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conveyor-layout.${type === 'json' ? 'json' : 'csv'}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const terrainFootprint = TERRAIN_SIZE * planeScale;
  const terrainHeightRange = TERRAIN_DISPLACEMENT_SCALE * zScale;

  return (
    <main className="editor">
      <header className="topbar">
        <div className="brand">MineSight</div>
        <h1>Conveyor Layout Editor</h1>
        <div className="summary">
          Nodes <b>{m.nodes}</b>
          <span>·</span>
          <span className="carry-text">Carry <b>{m.carry}</b></span>
          <span className="return-text">Return <b>{m.ret}</b></span>
          <span>·</span>
          Belt Length <b>{m.lengthKm.toFixed(2)} km</b>
          <span>·</span>
          Elevation <b>{m.zMin.toFixed(1)} → {m.zMax.toFixed(1)} m</b>
          <span>·</span>
          Plane <b>{planeScale.toFixed(2)}x</b> · Z <b>{zScale.toFixed(2)}x</b>
          Terrain <b>{terrainFootprint.toFixed(0)} m</b>
          <span>·</span>
          Height <b>{terrainHeightRange.toFixed(0)} m</b>
        </div>
      </header>

      <div className="toolbar">
        <label className="tool-btn">
          <input type="file" accept="image/png, image/jpeg" onChange={(e) => {
            if (e.target.files?.[0]) {
              const url = URL.createObjectURL(e.target.files[0]);
              setHeightmapUrl(url);
              setStatus('Loaded custom heightmap');
            }
          }} style={{ display: 'none' }} />
          Upload Heightmap
        </label>
        <label className="tool-btn">
          <input type="file" accept=".csv,text/csv" onChange={(e) =>
            e.target.files?.[0] &&
            parseCsvFile(e.target.files[0], (newRows) => {
              originalRowsRef.current = JSON.parse(JSON.stringify(newRows));
              setRows(newRows);
              setFittedIds(new Set());
              setStatus(`Loaded ${newRows.length} nodes from uploaded CSV`);
            }, setStatus)
          } />
          Upload CSV
        </label>
        <button className="primary" onClick={addNodeAfter} disabled={lastSelectedId === null}
          style={{ backgroundColor: '#2e7d32' }}>
          + Insert After ({lastSelectedId ?? '?'})
        </button>
        <button onClick={toggleStrand} disabled={selectedIds.size === 0}
          style={{ borderLeft: '4px solid #0857f7' }}>
          ⇄ Switch Strand ({selectedIds.size})
        </button>
        <button className="fit-btn" onClick={fitNodesToWireframe}>FIT</button>

        <label className="wire-input">
          Plane Scale
          <input type="number" min="0.05" max="20" step="0.05" value={planeScale}
            onChange={(e) => updatePlaneScale(e.target.value)} />
        </label>
        <label className="wire-input">
          Z Scale
          <input type="number" min="0" max="20" step="0.05" value={zScale}
            onChange={(e) => updateZScale(e.target.value)} />
        </label>
        <button 
        className="danger" 
        onClick={clearAllNodes}
        style={{ marginLeft: '10px' }}
      >
        🗑️ Clear All
      </button>

      <button 
        onClick={undo} 
        disabled={history.length === 0}
      >
        ↩️ Undo (Ctrl+Z)
      </button>
        <button onClick={resetAll}>RESET ALL</button>
        <button className="primary" onClick={addNode}>+ Add Node</button>
        <button className="danger" disabled={selectedIds.size === 0} onClick={deleteNode}>Delete Node</button>
        <button onClick={() => exportFile('csv')}>Export CSV</button>
        <button onClick={() => exportFile('json')}>Export JSON</button>
                <span className="status">{status}</span>
      </div>

      {rows.length > 0 && (
        <>
          <section className="visual-area">
            <div className="left-plots">
              <MiniPlot title="SIDE VIEW" mode="side" rows={rows}
                selectedIds={selectedIds} onSelect={setSelected}
                onDragNode={updateNode} onDragMultipleNodes={updateMultipleNodes} />
              <MiniPlot title="TOP VIEW" mode="top" rows={rows}
                selectedIds={selectedIds} onSelect={setSelected}
                onDragNode={updateNode} onDragMultipleNodes={updateMultipleNodes} />
            </div>
            <View3D rows={rows} selectedId={lastSelectedId} selectedIds={selectedIds} onSelect={onSelect3D}
              planeScale={planeScale} zScale={zScale} heightmapUrl={heightmapUrl} />
          </section>
          {pathWarnings.size > 0 && (
        <div style={{ margin: '12px 16px', padding: '12px', backgroundColor: '#fee2e2', border: '1px solid #ef4444', borderRadius: '6px', color: '#991b1b' }}>
          <h4 style={{ marginTop: 0, marginBottom: '8px', fontSize: '1rem' }}>
            ⚠️ Path Safety Warnings ({pathWarnings.size} nodes affected)
          </h4>
          <ul style={{ margin: 0, paddingLeft: '24px', fontSize: '0.9rem' }}>
            {Array.from(pathWarnings.entries()).map(([id, warning]) => (
              <li key={id} style={{ marginBottom: '4px' }}>
                <strong>Node {id}:</strong> {warning.split(' | ').join(' AND ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      <NodeTable rows={rows} selectedIds={selectedIds} fittedIds={fittedIds}
            onSelect={setSelected} onEdit={updateNode}
        pathWarnings={pathWarnings} />
        </>
      )}

      {selected && (
        <div className="selected-banner">
          {selectedIds.size > 1
            ? `Selected: ${selectedIds.size} nodes · Last: Node ${selected.id} · ${selected.strand}`
            : `Selected: Node ${selected.id} · ${selected.strand} · (${selected.x.toFixed(2)}, ${selected.y.toFixed(2)}, ${selected.z.toFixed(2)}) · ${selected.tags || 'no tags'}`
          }
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);
root.render(<App />);