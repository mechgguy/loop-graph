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
const CARRY_RETURN_Z_GAP = 10;
const BELT_TAG = 'belt';
const TOP_VIEW_MIN_SPAN_METERS = 500;

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

function appendWarning(warnings, id, message) {
  warnings.set(id, warnings.has(id) ? `${warnings.get(id)} | ${message}` : message);
}

function checkPathSafety(nodes, minRadius = 100.0, maxGradient = 0.18) {
  const warnings = new Map();

  ['Carry', 'Return'].forEach((strandType) => {
    const strandNodes = sortedByStrand(nodes, strandType);

    for (let i = 0; i < strandNodes.length - 1; i++) {
      const p1 = strandNodes[i];
      const p2 = strandNodes[i + 1];
      const run = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const rise = Math.abs(p2.z - p1.z);
      const gradient = run === 0 ? (rise > 0 ? Infinity : 0) : rise / run;

      if (gradient > maxGradient) {
        const gradPercent = (gradient * 100).toFixed(1);
        const limitPercent = (maxGradient * 100).toFixed(0);
        const msg = `Gradient between ${p1.id} and ${p2.id} is ${gradPercent}% (> ${limitPercent}%)`;
        appendWarning(warnings, p1.id, msg);
        appendWarning(warnings, p2.id, msg);
      }
    }

    for (let i = 0; i < strandNodes.length - 2; i++) {
      const A = strandNodes[i];
      const B = strandNodes[i + 1];
      const C = strandNodes[i + 2];

      const a = distance3d(A, B);
      const b = distance3d(B, C);
      const c = distance3d(A, C);

      const ABx = B.x - A.x;
      const ABy = B.y - A.y;
      const ABz = B.z - A.z;
      const ACx = C.x - A.x;
      const ACy = C.y - A.y;
      const ACz = C.z - A.z;

      const crossX = ABy * ACz - ABz * ACy;
      const crossY = ABz * ACx - ABx * ACz;
      const crossZ = ABx * ACy - ABy * ACx;
      const crossNorm = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);

      const radius = crossNorm === 0 ? Infinity : (a * b * c) / (2 * crossNorm);
      if (radius < minRadius) {
        appendWarning(warnings, B.id, `Radius of curvature at node ${B.id} is ${radius.toFixed(2)}m (< ${minRadius}m)`);
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
function MiniPlot({ title, mode, rows, selectedIds, onSelect, onSelectMany, onDragNode, onDragMultipleNodes }) {
  const svgRef = useRef(null);
  const [stretched, setStretched] = useState(false);
  const [selectionBox, setSelectionBox] = useState(null);
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

  // Compute arc data with proper continuation
  const carryArc = getArcData(carryRows, 0);
  const totalCarryLength = carryArc.length > 0 ? carryArc[carryArc.length - 1].arc : 0;
  const returnArc = getArcData(returnRows, 0);
  const totalReturnLength = returnArc.length > 0 ? returnArc[returnArc.length - 1].arc - totalCarryLength : 0;

  const getDataForDisplay = () => {
    if (mode === 'side' && stretched) {
      return {
        carry: carryArc,
        ret: returnArc,
        all: [...carryArc, ...returnArc]
      };
    }
    if (mode === 'side') {
      return {
        carry: carryRows,
        ret: returnRows,
        all: [...carryRows, ...returnRows]
      };
    }
    return {
      carry: carryRows,
      ret: returnRows,
      all: [...carryRows, ...returnRows]
    };
  };

  const displayData = getDataForDisplay();
  const dataByStrand = [
    { strand: 'Carry', rows: displayData.carry },
    { strand: 'Return', rows: displayData.ret }
  ];
  const all = displayData.all;

  const xValue = mode === 'side' && stretched ? (d) => d.arc : (d) => d.x;
  const yValue = mode === 'side' ? (d) => d.visualZ : (d) => d.y;

  const xDomainRaw = d3.extent(all, xValue);
  const yDomainRaw = d3.extent(all, yValue);

  function expandDomain(domain, minSpan) {
    const a = Number.isFinite(domain?.[0]) ? domain[0] : 0;
    const b = Number.isFinite(domain?.[1]) ? domain[1] : 0;
    const center = (a + b) / 2;
    const span = Math.max(Math.abs(b - a), minSpan);
    return [center - span / 2, center + span / 2];
  }

  const minTopSpan = mode === 'top' ? TOP_VIEW_MIN_SPAN_METERS : 1;
  const xDomain = expandDomain(xDomainRaw, minTopSpan);
  const yDomain = expandDomain(yDomainRaw, minTopSpan);

  const x = d3.scaleLinear()
    .domain(xDomain)
    .nice()
    .range([margin.left, w - margin.right]);

  const y = d3.scaleLinear()
    .domain(yDomain)
    .nice()
    .range([h - margin.bottom, margin.top]);

  const line = d3.line()
    .x((d) => x(xValue(d)))
    .y((d) => y(yValue(d)))
    .defined(() => true);

  function startBoxSelect(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const svg = svgRef.current;
    const start = d3.pointer(event, svg);
    setSelectionBox({ x1: start[0], y1: start[1], x2: start[0], y2: start[1] });

    const move = (e) => {
      const pt = d3.pointer(e, svg);
      setSelectionBox({ x1: start[0], y1: start[1], x2: pt[0], y2: pt[1] });
    };

    const up = (e) => {
      const end = d3.pointer(e, svg);
      const [x1, x2] = [Math.min(start[0], end[0]), Math.max(start[0], end[0])];
      const [y1, y2] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])];
      setSelectionBox(null);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);

      if ((x2 - x1) < 4 && (y2 - y1) < 4) {
        onSelect({ id: null }, false);
        return;
      }

      const idsInside = all
        .filter((d) => {
          const px = x(xValue(d));
          const py = y(yValue(d));
          return px >= x1 && px <= x2 && py >= y1 && py <= y2;
        })
        .map((d) => d.id);

      if (onSelectMany) onSelectMany(idsInside, event.ctrlKey || event.metaKey || event.shiftKey);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function startDrag(event, d) {
    event.preventDefault();
    const svg = svgRef.current;
    const isMultiDrag = selectedIds && selectedIds.size > 1 && selectedIds.has(d.id);

    if (isMultiDrag) {
      dragStartPositions.current.clear();
      selectedIds.forEach(id => {
        const node = rows.find(r => r.id === id);
        if (node) {
          dragStartPositions.current.set(id, { x: node.x, y: node.y, z: node.z });
        }
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
            if (startNodePos) {
              nodeUpdates.set(id, { x: startNodePos.x + deltaX, y: startNodePos.y + deltaY });
            }
          });
        }

        if (mode === 'side') {
          const dragStartVisualZ = startPos.z - (d.strand === 'Return' ? visualOffset : 0);
          const deltaZ = y.invert(pt[1]) - dragStartVisualZ;
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

  // Pulleys sit on the matched Carry/Return ends of the CSV-loaded belt path only.
  // Manually added nodes/belt pairs should not recreate pulley logic after CSV nodes are deleted.
  const csvCarryRowsRaw = carryRowsRaw.filter((row) => row.fromCsv);
  const csvReturnRowsRaw = returnRowsRaw.filter((row) => row.fromCsv);
  if (csvCarryRowsRaw.length > 0 && csvReturnRowsRaw.length > 0) {
    const displayById = new Map(all.map((row) => [row.id, row]));

    const startCarry = displayById.get(csvCarryRowsRaw[0].id);
    const endCarry = displayById.get(csvCarryRowsRaw[csvCarryRowsRaw.length - 1].id);
    const startReturn = displayById.get(csvReturnRowsRaw[0].id);
    const endReturn = displayById.get(csvReturnRowsRaw[csvReturnRowsRaw.length - 1].id);

    // Drive motor pulley: end Carry + end Return.
    // Green pulley: start Carry + start Return.
    if (startCarry && endCarry && startReturn && endReturn) {
      if (mode === 'side' && !stretched) {
        const headRadius = Math.abs(y(yValue(endCarry)) - y(yValue(endReturn))) / 2;
        if (headRadius > 0 && headRadius < 100) {
          const cx = (x(xValue(endCarry)) + x(xValue(endReturn))) / 2;
          const cy = (y(yValue(endCarry)) + y(yValue(endReturn))) / 2;
          headPulleyCircle = { cx, cy, r: headRadius };
          headPulleyPath = `M ${x(xValue(endCarry))},${y(yValue(endCarry))} A ${headRadius},${headRadius} 0 0,1 ${x(xValue(endReturn))},${y(yValue(endReturn))}`;
        }

        const tailRadius = Math.abs(y(yValue(startReturn)) - y(yValue(startCarry))) / 2;
        if (tailRadius > 0 && tailRadius < 100) {
          const cx = (x(xValue(startCarry)) + x(xValue(startReturn))) / 2;
          const cy = (y(yValue(startCarry)) + y(yValue(startReturn))) / 2;
          tailPulleyCircle = { cx, cy, r: tailRadius };
          tailPulleyPath = `M ${x(xValue(startReturn))},${y(yValue(startReturn))} A ${tailRadius},${tailRadius} 0 0,1 ${x(xValue(startCarry))},${y(yValue(startCarry))}`;
        }
      }

      if (mode === 'side' && stretched) {
        const headCx = (x(xValue(endCarry)) + x(xValue(endReturn))) / 2;
        const headCy = (y(yValue(endCarry)) + y(yValue(endReturn))) / 2;
        const tailCx = (x(xValue(startCarry)) + x(xValue(startReturn))) / 2;
        const tailCy = (y(yValue(startCarry)) + y(yValue(startReturn))) / 2;
        headPulleyCircle = { cx: headCx, cy: headCy, r: 10 };
        tailPulleyCircle = { cx: tailCx, cy: tailCy, r: 10 };
        headPulleyPath = `M ${x(xValue(endCarry))},${y(yValue(endCarry))} L ${x(xValue(endReturn))},${y(yValue(endReturn))}`;
        tailPulleyPath = `M ${x(xValue(startReturn))},${y(yValue(startReturn))} L ${x(xValue(startCarry))},${y(yValue(startCarry))}`;
      }

      if (mode === 'top') {
        const headCx = (x(xValue(endCarry)) + x(xValue(endReturn))) / 2;
        const headCy = (y(yValue(endCarry)) + y(yValue(endReturn))) / 2;
        const tailCx = (x(xValue(startCarry)) + x(xValue(startReturn))) / 2;
        const tailCy = (y(yValue(startCarry)) + y(yValue(startReturn))) / 2;
        headPulleyCircle = { cx: headCx, cy: headCy, r: 10 };
        tailPulleyCircle = { cx: tailCx, cy: tailCy, r: 10 };
        headPulleyPath = `M ${x(xValue(endCarry))},${y(yValue(endCarry))} L ${x(xValue(endReturn))},${y(yValue(endReturn))}`;
        tailPulleyPath = `M ${x(xValue(startReturn))},${y(yValue(startReturn))} L ${x(xValue(startCarry))},${y(yValue(startCarry))}`;
      }
    }
  }

  return (
    <section className="plot-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', minHeight: '32px' }}>
        <h3 style={{ margin: 0, fontSize: '0.9rem' }}>{title}</h3>
        {mode === 'side' && (
          <button
            onClick={() => setStretched(!stretched)}
            style={{
              padding: '6px 12px', fontSize: '11px', background: stretched ? '#e52b2f' : '#333',
              color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap'
            }}
          >
            {stretched ? '📏 Stretched View' : '🗺️ Projected View'}
          </button>
        )}
      </div>

      {mode === 'side' && stretched && (
        <div style={{ fontSize: '15px', color: '#888', marginBottom: '12px', textAlign: 'center', padding: '4px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}>
          Carry length: {totalCarryLength.toFixed(0)}m
          <span style={{ marginLeft: '12px', fontSize: '10px' }}>(X-axis shows true belt length)</span>
        </div>
      )}

      <svg ref={svgRef} viewBox={`0 0 ${w} ${h}`}>
        <rect className="background" width={w} height={h} fill="transparent" onMouseDown={startBoxSelect} style={{ cursor: 'crosshair' }} />
        <g className="gridlines">
          {x.ticks(8).map((t) => (
            <line key={`x${t}`} x1={x(t)} x2={x(t)} y1={margin.top} y2={h - margin.bottom} />
          ))}
          {y.ticks(5).map((t) => (
            <line key={`y${t}`} x1={margin.left} x2={w - margin.right} y1={y(t)} y2={y(t)} />
          ))}
        </g>

        <g className="x-axis-labels" fontSize="10" fill="#999" textAnchor="middle">
          {x.ticks(8).map((t) => (
            <text key={`xtick${t}`} x={x(t)} y={h - margin.bottom + 15}>{formatNumber(t)}</text>
          ))}
        </g>

        <g className="y-axis-labels" fontSize="10" fill="#999" textAnchor="end">
          {y.ticks(5).map((t) => (
            <text key={`ytick${t}`} x={margin.left - 8} y={y(t) + 3}>{formatNumber(t)}</text>
          ))}
        </g>

        <g className="axis-labels">
          <text x={w / 2} y={h - 8} textAnchor="middle" fontSize="12" fill="#888">
            {mode === 'side' ? (stretched ? 'Belt Arc Length (m) →' : 'Horizontal Distance X (m) →') : 'X (m) →'}
          </text>
          <text transform={`translate(12 ${h / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="#888">
            {mode === 'side' ? '↑ Elevation Z (m)' : '↑ Y (m)'}
          </text>
        </g>

        {tailPulleyCircle && (
          <g pointerEvents="none">
            <circle cx={tailPulleyCircle.cx} cy={tailPulleyCircle.cy} r={tailPulleyCircle.r} fill="#16a34a" stroke="#064e3b" strokeWidth="2" />
            <circle cx={tailPulleyCircle.cx} cy={tailPulleyCircle.cy} r={tailPulleyCircle.r * 0.3} fill="#064e3b" />
          </g>
        )}

        {headPulleyCircle && (
          <g pointerEvents="none">
            <circle cx={headPulleyCircle.cx} cy={headPulleyCircle.cy} r={headPulleyCircle.r} fill="#ffffff" />
            <path d={`M ${headPulleyCircle.cx},${headPulleyCircle.cy} L ${headPulleyCircle.cx},${headPulleyCircle.cy - headPulleyCircle.r} A ${headPulleyCircle.r},${headPulleyCircle.r} 0 0,1 ${headPulleyCircle.cx + headPulleyCircle.r},${headPulleyCircle.cy} Z`} fill="#f97316" />
            <path d={`M ${headPulleyCircle.cx},${headPulleyCircle.cy} L ${headPulleyCircle.cx},${headPulleyCircle.cy + headPulleyCircle.r} A ${headPulleyCircle.r},${headPulleyCircle.r} 0 0,1 ${headPulleyCircle.cx - headPulleyCircle.r},${headPulleyCircle.cy} Z`} fill="#f97316" />
            <line x1={headPulleyCircle.cx - headPulleyCircle.r} y1={headPulleyCircle.cy} x2={headPulleyCircle.cx + headPulleyCircle.r} y2={headPulleyCircle.cy} stroke="#666" strokeWidth="1" />
            <line x1={headPulleyCircle.cx} y1={headPulleyCircle.cy - headPulleyCircle.r} x2={headPulleyCircle.cx} y2={headPulleyCircle.cy + headPulleyCircle.r} stroke="#666" strokeWidth="1" />
            <circle cx={headPulleyCircle.cx} cy={headPulleyCircle.cy} r={headPulleyCircle.r} fill="none" stroke="#444" strokeWidth="1.5" />
          </g>
        )}

        {headPulleyPath && <path d={headPulleyPath} fill="none" stroke="#666" strokeWidth="1.5" opacity={stretched ? 1 : 0.8} pointerEvents="none" />}
        {tailPulleyPath && <path d={tailPulleyPath} fill="none" stroke="#666" strokeWidth="1.5" opacity={stretched ? 1 : 0.8} pointerEvents="none" />}

        {selectionBox && (
          <rect
            x={Math.min(selectionBox.x1, selectionBox.x2)}
            y={Math.min(selectionBox.y1, selectionBox.y2)}
            width={Math.abs(selectionBox.x2 - selectionBox.x1)}
            height={Math.abs(selectionBox.y2 - selectionBox.y1)}
            fill="rgba(255,255,255,0.08)"
            stroke="#fff"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            pointerEvents="none"
          />
        )}

        {selectedIds && selectedIds.size > 1 && (
          <g className="selection-rectangles">
            {Array.from(selectedIds).map(id => {
              const node = all.find(d => d.id === id);
              if (!node) return null;
              return (
                <rect
                  key={`sel-${mode}-${id}`}
                  x={x(xValue(node)) - 12}
                  y={y(yValue(node)) - 12}
                  width={24}
                  height={24}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                  rx={4}
                />
              );
            })}
          </g>
        )}

        {dataByStrand.map((strandData) =>
          strandData.rows.length > 1 && (
            <path
              key={strandData.strand}
              className={strandData.strand === 'Return' ? 'plot-line return' : 'plot-line carry'}
              d={line(strandData.rows)}
              opacity={stretched ? 1 : 0.8}
            />
          )
        )}

        {all.map((d) => (
          <circle
            key={`${mode}-${d.id}`}
            className={`plot-dot ${selectedIds && selectedIds.has(d.id) ? 'selected' : ''}`}
            cx={x(xValue(d))}
            cy={y(yValue(d))}
            r={selectedIds && selectedIds.has(d.id) ? 8 : 6}
            fill={strandColor(d.strand)}
            onMouseDown={(e) => startDrag(e, d)}
            onClick={(e) => onSelect(d, e.ctrlKey || e.metaKey)}
          />
        ))}
      </svg>

      {mode === 'side' && (
        <div style={{ fontSize: '10px', color: '#666', marginTop: '8px', textAlign: 'center' }}>
          💡 Tip: Toggle between Projected actual X vs Z and Stretched true belt length vs Z
          <br />
          Ctrl/Cmd+Click to multi-select · Alt+A to select all · Delete to remove selected
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

function createConveyorRibbonGeometry(points, width = 22) {
  const vertices = [];
  const indices = [];
  const up = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(i - 1, 0)];
    const next = points[Math.min(i + 1, points.length - 1)];
    const tangent = new THREE.Vector3().subVectors(next, prev);
    tangent.z = 0;
    if (tangent.length() < 0.001) tangent.set(1, 0, 0);
    tangent.normalize();
    const side = new THREE.Vector3().crossVectors(up, tangent).normalize().multiplyScalar(width / 2);
    const left = points[i].clone().add(side);
    const right = points[i].clone().sub(side);
    vertices.push(left.x, left.y, left.z + 1.5);
    vertices.push(right.x, right.y, right.z + 1.5);
    if (i < points.length - 1) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      indices.push(a, b, c);
      indices.push(b, d, c);
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

  const beltGeometry = createConveyorRibbonGeometry(sampled, beltWidth);
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
function View3D({ rows, selectedId, onSelect, planeScale, zScale, heightmapUrl }) {
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
      function toVec(r) {
        return new THREE.Vector3(r.x, r.y, r.z);
      }
      const originalAdd = scene.add.bind(scene);
      scene.add = (obj) => conveyorGroup.add(obj);
      buildConveyor(scene, sortedByStrand(rows, 'Carry'), 'Carry', toVec, selectedId);
      buildConveyor(scene, sortedByStrand(rows, 'Return'), 'Return', toVec, selectedId);
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

    function toVec(r) {
      return new THREE.Vector3(r.x, r.y, r.z);
    }
    const originalAdd = scene.add.bind(scene);
    scene.add = (obj) => conveyorGroup.add(obj);
    buildConveyor(scene, sortedByStrand(rows, 'Carry'), 'Carry', toVec, selectedId);
    buildConveyor(scene, sortedByStrand(rows, 'Return'), 'Return', toVec, selectedId);
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
function NodeTable({ rows, selectedIds, fittedIds, onSelect, onEdit, pathWarnings }) {
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
            <th style={{ width: '40px', textAlign: 'center' }}>⚠</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const offset = Number.isFinite(r.wireframeZ) && r.wireframeZ !== null
              ? (r.z - r.wireframeZ).toFixed(2) + ' m'
              : '—';
            const warning = pathWarnings?.get(r.id);
            const warningTitle = warning
              ? `⚠️ PATH WARNING(S):\n• ${warning.split(' | ').join('\n• ')}`
              : '';

            return (
              <tr
                key={r.id}
                className={[
                  selectedIds?.has(r.id) ? 'selected-row' : '',
                  fittedIds?.has(r.id) ? 'fitted-row' : ''
                ].join(' ')}
                onClick={(e) => onSelect(r, e.ctrlKey || e.metaKey)}
                style={warning ? { backgroundColor: 'rgba(229, 43, 47, 0.15)' } : {}}
                title={warningTitle || (
                  fittedIds?.has(r.id) && r.wireframeZ !== null
                    ? `Adjusted. Wireframe Z = ${Number(r.wireframeZ).toFixed(2)} m`
                    : ''
                )}
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
                <td
                  title={warningTitle}
                  style={{
                    textAlign: 'center',
                    fontSize: '1.2em',
                    cursor: warning ? 'help' : 'default'
                  }}
                >
                  {warning ? '⚠️' : ''}
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
  const nextNodeIdRef = useRef(0);

  // Load default CSV
  useEffect(() => {
    fetch(DEFAULT_CSV_PATH)
      .then((res) => {
        if (!res.ok) throw new Error('Could not load /path_simple.csv.');
        return res.text();
      })
      .then((csvText) => {
        const loadedRows = rowsFromCsvText(csvText);
        nextNodeIdRef.current = Math.max(0, ...loadedRows.map(r => Number(r.id) || 0)) + 1;
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
  const pathWarnings = useMemo(() => checkPathSafety(rows), [rows]);
  const selected = rows.find((r) => r.id === lastSelectedId);

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

  function setSelectedMany(ids, additive = false) {
    if (!ids || ids.length === 0) {
      if (!additive) {
        setSelectedIds(new Set());
        setLastSelectedId(null);
        setStatus('Selection cleared');
      }
      return;
    }

    setSelectedIds(prev => {
      const next = additive ? new Set(prev) : new Set();
      ids.forEach(id => next.add(id));
      const lastId = ids[ids.length - 1];
      setLastSelectedId(lastId);
      setStatus(`Rectangle selected ${ids.length} node(s). Total selected: ${next.size}`);
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
  function shouldWarnAboutBeltMove(row, patch) {
    if (!row || !(patch.x !== undefined || patch.y !== undefined || patch.z !== undefined)) return false;
    const tags = patch.tags !== undefined ? patch.tags : row.tags;
    return !tags || tags.trim() === '' || tags.toLowerCase().includes('belt');
  }

  function showBeltMoveWarning(row) {
    const currentStrand = row.strand;
    const oppositeStrand = currentStrand === 'Carry' ? 'Return' : 'Carry';
    setStatus(`⚠️ WARNING: Moving ${currentStrand} Belt Node ${row.id}. Make sure to move the corresponding ${oppositeStrand} node!`);
  }

  function updateMultipleNodes(nodeUpdates) {
    setRows(prev => {
      const movedRows = prev.filter(r => nodeUpdates.has(r.id) && shouldWarnAboutBeltMove(r, nodeUpdates.get(r.id)));
      if (movedRows.length > 0) setStatus(`⚠️ WARNING: Moving ${movedRows.length} belt node(s). Check corresponding Carry/Return nodes.`);
      return prev.map(r => nodeUpdates.has(r.id) ? { ...r, ...nodeUpdates.get(r.id) } : r);
    });
    setFittedIds(prev => {
      const next = new Set(prev);
      nodeUpdates.forEach((_, id) => next.delete(id));
      return next;
    });
  }

  // Update single node
  function updateNode(id, patch) {
    setRows(prev => {
      const target = prev.find(r => r.id === id);
      if (shouldWarnAboutBeltMove(target, patch)) showBeltMoveWarning(target);
      return prev.map(r => r.id === id ? { ...r, ...patch } : r);
    });
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
      nextNodeIdRef.current = Math.max(0, ...originalRowsRef.current.map(r => Number(r.id) || 0)) + 1;
      setRows(JSON.parse(JSON.stringify(originalRowsRef.current)));
      setStatus('Reset: wireframe scales to 1.00x and nodes to original CSV values.');
    } else {
      setStatus('Wireframe scales reset. No original data to restore.');
    }
  }

  function isBeltNode(row) {
    return String(row.tags ?? '').toLowerCase().split(/[;,\s]+/).includes(BELT_TAG) || row.beltPairId !== undefined;
  }

  // FIT nodes with clearance rule.
  // Important: this fits ALL current nodes, including manually added nodes and belt nodes.
  function fitNodesToWireframe() {
    if (!heightSampler) {
      setStatus('Heightmap is not ready yet.');
      return;
    }
    if (!rows.length) {
      setStatus('No nodes to fit. Add or load nodes first.');
      return;
    }


    const effectiveTerrainSize = TERRAIN_SIZE * planeScale;
    const effectiveDisplacementScale = TERRAIN_DISPLACEMENT_SCALE * zScale;
    const adjusted = new Set();

    let fittedRows = rows.map(row => {
      const localX = row.x;
      const localY = row.y;
      const wireframeZ = heightSampler(localX, localY, effectiveTerrainSize, effectiveDisplacementScale);
      const baseZ = Number.isFinite(row.originalZ) ? row.originalZ : row.z;

      if (wireframeZ === null) {
        return { ...row, z: baseZ, fittedToWireframe: false, wireframeZ: null };
      }

      const maxClearance =
        isBeltNode(row) && row.strand === 'Return'
          ? MAX_CLEARANCE_ABOVE_WIREFRAME - CARRY_RETURN_Z_GAP
          : MAX_CLEARANCE_ABOVE_WIREFRAME;

      let fittedZ = baseZ;
      if (baseZ < wireframeZ + MIN_CLEARANCE_ABOVE_WIREFRAME) {
        fittedZ = wireframeZ + MIN_CLEARANCE_ABOVE_WIREFRAME;
      } else {
        fittedZ = Math.min(baseZ, wireframeZ + maxClearance);
      }

      const changed = Math.abs(fittedZ - row.z) > 1e-6;
      if (changed) adjusted.add(row.id);
      return { ...row, z: fittedZ, fittedToWireframe: changed, wireframeZ };
    });

    // Keep every belt pair exactly 10 z-units apart after FIT.
    const byPairId = new Map();
    fittedRows.forEach(row => {
      if (!isBeltNode(row) || row.beltPairId === undefined) return;
      if (!byPairId.has(row.beltPairId)) byPairId.set(row.beltPairId, {});
      const pair = byPairId.get(row.beltPairId);
      if (row.strand === 'Return') pair.returnNode = row;
      if (row.strand === 'Carry') pair.carryNode = row;
    });

    fittedRows = fittedRows.map(row => {
      if (!isBeltNode(row) || row.beltPairId === undefined || row.strand !== 'Carry') return row;
      const pair = byPairId.get(row.beltPairId);
      if (!pair?.returnNode) return row;
      const forcedCarryZ = pair.returnNode.z + CARRY_RETURN_Z_GAP;
      if (Math.abs(forcedCarryZ - row.z) > 1e-6) adjusted.add(row.id);
      return {
        ...row,
        z: forcedCarryZ,
        originalZ: forcedCarryZ,
        fittedToWireframe: true,
        wireframeZ: pair.returnNode.wireframeZ
      };
    });

    setRows(fittedRows);
    setFittedIds(adjusted);
    setStatus(
      adjusted.size > 0
        ? `FIT complete: adjusted ${adjusted.size} node(s). Belt pairs keep Carry exactly ${CARRY_RETURN_Z_GAP} z-units above Return.`
        : `FIT complete: no nodes needed adjustment.`
    );
  }

  // Add node (main.jsx with template)
  function addNode() {
    setRows(currentRows => {
      const newId = nextNodeIdRef.current++;
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
      setTimeout(() => {
        setSelectedIds(new Set([newId]));
        setLastSelectedId(newId);
      }, 0);
      setStatus(`Added node ${newId}`);
      return [...currentRows, newNode];
    });
  }

  function makeBeltNodePair(baseId, x, y, returnZ) {
    const beltPairId = `belt-${baseId}`;
    const safeReturnZ = num(returnZ, 0);
    const shared = {
      x,
      y,
      tags: BELT_TAG,
      fromCsv: false,
      fittedToWireframe: false,
      wireframeZ: null,
      beltPairId
    };

    const returnNode = {
      ...shared,
      id: baseId,
      strand: 'Return',
      strandValue: 1,
      group: 1,
      z: safeReturnZ,
      originalZ: safeReturnZ
    };

    const carryZ = safeReturnZ + CARRY_RETURN_Z_GAP;
    const carryNode = {
      ...shared,
      id: baseId + 1,
      strand: 'Carry',
      strandValue: -1,
      group: 0,
      z: carryZ,
      originalZ: carryZ
    };

    return { returnNode, carryNode };
  }

  // Add Belt Node: adds a Return + Carry pair without changing the normal Add Node button.
  function addBeltNode() {
    setRows(currentRows => {
      const baseId = nextNodeIdRef.current;
      nextNodeIdRef.current += 2;
      const selectedNode = currentRows.find(r => r.id === lastSelectedId);
      const last = currentRows[currentRows.length - 1] ?? { x: 0, y: 0, z: 0, strand: 'Return' };
      const template = selectedNode ?? last;

      const x = num(template.x, 0) + 50;
      const y = num(template.y, 0);
      const templateZ = num(template.z, 0);
      const returnZ = String(template.strand ?? '').toLowerCase().includes('carry')
        ? templateZ - CARRY_RETURN_Z_GAP
        : templateZ;

      const { returnNode, carryNode } = makeBeltNodePair(baseId, x, y, returnZ);

      setTimeout(() => {
        setSelectedIds(new Set([returnNode.id, carryNode.id]));
        setLastSelectedId(carryNode.id);
      }, 0);

      setStatus(`Added belt node pair: Return ${returnNode.id}, Carry ${carryNode.id}. Carry is ${CARRY_RETURN_Z_GAP} z-units above Return.`);
      return [...currentRows, returnNode, carryNode];
    });
  }

  // Insert after: insert directly after the selected node and renumber following nodes.
  // Example: inserting after Node 7 creates a new Node 8, and old 8, 9, ... become 9, 10, ...
  function addNodeAfter() {
    if (lastSelectedId === null) {
      setStatus("Select a node first to insert after it!");
      return;
    }

    setRows(currentRows => {
      const currentIndex = currentRows.findIndex(r => r.id === lastSelectedId);
      if (currentIndex === -1) return currentRows;

      const selectedNode = currentRows[currentIndex];
      const selectedNumericId = Number(selectedNode.id);
      const canRenumberSequentially = Number.isFinite(selectedNumericId);
      const newId = canRenumberSequentially ? selectedNumericId + 1 : nextNodeIdRef.current;

      // Find the next node on the same strand, not just the next table row.
      // This avoids Return nodes midpointing against the paired Carry node at the same x/y position.
      const nextNode = currentRows
        .filter(row => row.strand === selectedNode.strand && Number(row.id) > selectedNumericId)
        .sort((a, b) => Number(a.id) - Number(b.id))[0];
      const oldNextId = nextNode?.id ?? 'End';
      const insertedX = nextNode ? (num(selectedNode.x) + num(nextNode.x)) / 2 : num(selectedNode.x) + 25;
      const insertedY = nextNode ? (num(selectedNode.y) + num(nextNode.y)) / 2 : num(selectedNode.y) + 25;
      const insertedZ = nextNode ? (num(selectedNode.z) + num(nextNode.z)) / 2 : num(selectedNode.z);

      const newNode = {
        ...selectedNode,
        id: newId,
        x: insertedX,
        y: insertedY,
        z: insertedZ,
        originalZ: insertedZ,
        fromCsv: false,
        tags: `Inserted after ${selectedNode.id}`,
        fittedToWireframe: false,
        wireframeZ: null
      };

      const idMap = new Map();
      const updatedRows = currentRows.map((row, index) => {
        if (canRenumberSequentially && index > currentIndex) {
          const numericId = Number(row.id);
          if (Number.isFinite(numericId) && numericId >= newId) {
            const shiftedId = numericId + 1;
            idMap.set(row.id, shiftedId);
            return { ...row, id: shiftedId };
          }
        }
        idMap.set(row.id, row.id);
        return row;
      });

      updatedRows.splice(currentIndex + 1, 0, newNode);
      nextNodeIdRef.current = Math.max(0, ...updatedRows.map(r => Number(r.id) || 0)) + 1;

      setFittedIds(prev => {
        const next = new Set();
        prev.forEach(id => {
          if (idMap.has(id)) next.add(idMap.get(id));
        });
        return next;
      });

      setTimeout(() => {
        setSelectedIds(new Set([newId]));
        setLastSelectedId(newId);
        setStatus(`Inserted Node ${newId} between ${selectedNode.id} and ${oldNextId}. Later node IDs were updated.`);
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
              nextNodeIdRef.current = Math.max(0, ...newRows.map(r => Number(r.id) || 0)) + 1;
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

        <button onClick={resetAll}>RESET ALL</button>
        <button className="primary" onClick={addNode}>+ Add Node</button>
        <button className="primary" onClick={addBeltNode}>+ Add Belt Node</button>
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
                selectedIds={selectedIds} onSelect={setSelected} onSelectMany={setSelectedMany}
                onDragNode={updateNode} onDragMultipleNodes={updateMultipleNodes} />
              <MiniPlot title="TOP VIEW" mode="top" rows={rows}
                selectedIds={selectedIds} onSelect={setSelected} onSelectMany={setSelectedMany}
                onDragNode={updateNode} onDragMultipleNodes={updateMultipleNodes} />
            </div>
            <View3D rows={rows} selectedId={lastSelectedId} onSelect={onSelect3D}
              planeScale={planeScale} zScale={zScale} heightmapUrl={heightmapUrl} />
          </section>
          <NodeTable rows={rows} selectedIds={selectedIds} fittedIds={fittedIds}
            onSelect={setSelected} onEdit={updateNode} pathWarnings={pathWarnings} />
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
