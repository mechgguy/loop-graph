createRoot(document.getElementById('root')).render(<App />);import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import * as d3 from 'd3';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './styles.css';

const RETURN = '#e52b2f';
const CARRY = '#0037d8';
const DEFAULT_CSV_PATH = '/path_simple.csv';

function num(v, fallback = 0) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
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

  return {
    id: lower.id ?? lower.node_id ?? index,
    strand: strandFromGroup(group),
    strandValue: strandValueFromGroup(group),
    x: num(lower.x ?? lower['x (m)'] ?? lower.pos_x),
    y: num(lower.y ?? lower['y (m)'] ?? lower.pos_y),
    z: num(lower.z ?? lower['z (m)'] ?? lower.elevation),
    group,
    tags: tagsToString(lower.tags ?? lower.tag ?? ''),
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

function makeCumulative(rows) {
  let total = 0;
  return rows.map((r, i) => {
    if (i > 0) total += distanceHorizontal(rows[i - 1], r);
    return { ...r, arc: total };
  });
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

function MiniPlot({ title, mode, rows, selectedId, onSelect, onDragNode }) {
  const svgRef = useRef(null);
  const [stretched, setStretched] = useState(false);
  const w = 760;
  const h = 255;
  const margin = { top: 32, right: 24, bottom: 40, left: 56 };

  const carryRows = sortedByStrand(rows, 'Carry');
  const returnRows = sortedByStrand(rows, 'Return');
  
  // Calculate cumulative arc length for stretched view
  const getArcData = (strandRows, startOffset = 0) => {
    if (strandRows.length === 0) return [];
    let total = startOffset;
    return strandRows.map((r, i) => {
      if (i > 0) total += distanceHorizontal(strandRows[i - 1], r);
      return { ...r, arc: total };
    });
  };
  
  // For stretched view, Return strand should continue from Carry strand's end
  const carryArc = getArcData(carryRows, 0);
  const carryTotalLength = carryArc.length > 0 ? carryArc[carryArc.length - 1].arc : 0;
  const returnArc = getArcData(returnRows, carryTotalLength);
  
  // For stretched side view, use cumulative arc length as X
  const getDataForDisplay = () => {
    if (mode === 'side' && stretched) {
      return {
        carry: carryArc,
        ret: returnArc,
        all: [...carryArc, ...returnArc]
      };
    }
    
    // For projected side view
    if (mode === 'side') {
      // Keep original order for Carry (0->5 ascending X)
      // Keep original order for Return (6->11 descending X)
      return {
        carry: carryRows,
        ret: returnRows,
        all: [...carryRows, ...returnRows]
      };
    }
    
    // For top view, use original order
    return {
      carry: carryRows,
      ret: returnRows,
      all: [...carryRows, ...returnRows]
    };
  };
  
  const displayData = getDataForDisplay();
  
  // For line drawing, use the natural order of each strand
  const getRowsForLine = (strandRows, strandType) => {
    if (mode === 'side' && !stretched) {
      // For projected side view, don't sort! Keep the natural flow order
      // Carry flows left to right (ascending X), Return flows right to left (descending X)
      return strandRows;
    }
    return strandRows;
  };

  const dataByStrand = [
    { strand: 'Carry', rows: displayData.carry },
    { strand: 'Return', rows: displayData.ret }
  ];

//   const dataByStrand = ['Carry', 'Return'].map((s) =>
//     makeCumulative(sortedByStrand(rows, s))
//   );

//   const all = dataByStrand.flat();
  const all = displayData.all;

//   const xValue = mode === 'side' ? (d) => d.arc : (d) => d.x;
  const xValue = (mode === 'side' && stretched) 
    ? (d) => d.arc 
    : (d) => d.x;
  const yValue = mode === 'side' ? (d) => d.z : (d) => d.y;

      // Use the full range of values
  const xDomain = d3.extent(all, xValue);
  const yDomain = d3.extent(all, yValue);

  const x = d3
    .scaleLinear()
    .domain(xDomain[0] === xDomain[1] ? [xDomain[0] - 1, xDomain[1] + 1] : xDomain)
    .nice()
    .range([margin.left, w - margin.right]);

  const y = d3
    .scaleLinear()
    .domain(yDomain[0] === yDomain[1] ? [yDomain[0] - 1, yDomain[1] + 1] : yDomain)
    .nice()
    .range([h - margin.bottom, margin.top]);

  const line = d3
    .line()
    .x((d) => x(xValue(d)))
    .y((d) => y(yValue(d)))
    .defined((d) => true);

  function startDrag(event, d) {
    event.preventDefault();
    const svg = svgRef.current;

    const move = (e) => {
      const pt = d3.pointer(e, svg);

      if (mode === 'top') {
        onDragNode(d.id, { x: x.invert(pt[0]), y: y.invert(pt[1]) });
      }

      if (mode === 'side') {
        onDragNode(d.id, { z: y.invert(pt[1]) });
      }
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  const formatNumber = (num) => {
    if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toFixed(0);
  };

  // Calculate total length for display
  const totalCarryLength = carryArc.length > 0 ? carryArc[carryArc.length - 1].arc : 0;
  const totalReturnLength = returnArc.length > 0 ? returnArc[returnArc.length - 1].arc - carryTotalLength : 0;

  return (
    <section className="plot-card">
        <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '12px',
        minHeight: '32px'
      }}>
        <h3 style={{ margin: 0, fontSize: '0.9rem' }}>{title}</h3>
        {mode === 'side' && (
          <button
            onClick={() => setStretched(!stretched)}
            style={{
              padding: '6px 12px',
              fontSize: '11px',
              background: stretched ? '#e52b2f' : '#333',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 500,
              whiteSpace: 'nowrap'
            }}
          >
            {stretched ? '📏 Stretched View' : '🗺️ Projected View'}
          </button>
        )}
      </div>
      
      {mode === 'side' && stretched && (
        <div style={{ 
          fontSize: '11px', 
          color: '#888', 
          marginBottom: '12px', 
          textAlign: 'center',
          padding: '4px 8px',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: '4px'
        }}>
          Carry length: {totalCarryLength.toFixed(0)}m | Return length: {totalReturnLength.toFixed(0)}m
          <span style={{ marginLeft: '12px', fontSize: '10px' }}>
            (X-axis shows true belt length)
          </span>
        </div>
      )}
      {/* <h3>{title}</h3> */}

      <svg ref={svgRef} viewBox={`0 0 ${w} ${h}`}>
        <g className="gridlines">
          {x.ticks(8).map((t) => (
            <line key={`x${t}`} x1={x(t)} x2={x(t)} y1={margin.top} y2={h - margin.bottom} />
          ))}
          {y.ticks(5).map((t) => (
            <line key={`y${t}`} x1={margin.left} x2={w - margin.right} y1={y(t)} y2={y(t)} />
          ))}
        </g>

        {/* X-axis tick labels */}
        <g className="x-axis-labels" fontSize="10" fill="#999" textAnchor="middle">
          {x.ticks(8).map((t) => (
            <text key={`xtick${t}`} x={x(t)} y={h - margin.bottom + 15}>
              {formatNumber(t)}
            </text>
          ))}
        </g>

        {/* Y-axis tick labels */}
        <g className="y-axis-labels" fontSize="10" fill="#999" textAnchor="end">
          {y.ticks(5).map((t) => (
            <text key={`ytick${t}`} x={margin.left - 8} y={y(t) + 3}>
              {formatNumber(t)}
            </text>
          ))}
        </g>

        <g className="axis-labels">
        {/* X-axis label */} 
          <text x={w / 2} y={h - 8}>
            {mode === 'side' ? 'Cumulative arc length (m)' : 'X (m)'}
          </text>
        {/* Y-axis label */}  
          <text transform={`translate(16 ${h / 2}) rotate(-90)`}>
            {mode === 'side' ? 'Z (m)' : 'Y (m)'}
          </text>
        </g>

        {/* {dataByStrand.map(
          (strandData) =>
            strandData.length > 1 && (
              <path
                key={strandData[0].strand}
                className={strandData[0].strand === 'Return' ? 'plot-line return' : 'plot-line carry'}
                d={line(getRowsForLine(strandData.rows, strandData.strand))}
                opacity={stretched ? 1 : 0.8}
              />
            )
        )} */}

        {dataByStrand.map(
          (lineRows) =>
            lineRows.length > 1 && (
              <path
                key={lineRows[0].strand}
                className={lineRows[0].strand === 'Return' ? 'plot-line return' : 'plot-line carry'}
                d={line(lineRows)}
              />
            )
        )}

        {all.map((d) => (
          <circle
            key={`${mode}-${d.id}`}
            className={`plot-dot ${selectedId === d.id ? 'selected' : ''}`}
            cx={x(xValue(d))}
            cy={y(yValue(d))}
            r={selectedId === d.id ? 8 : 6}
            fill={strandColor(d.strand)}
            onMouseDown={(e) => startDrag(e, d)}
            onClick={() => onSelect(d)}
          />
        ))}
      </svg>

        {mode === 'side' && (
        <div style={{ fontSize: '10px', color: '#666', marginTop: '8px', textAlign: 'center' }}>
            💡 Tip: Toggle between Projected (actual X vs Z) and Stretched (true belt length vs Z)
        </div>
        )}
    </section>
  );
}
function createMineGroundTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;

  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 1024, 1024);
  gradient.addColorStop(0, '#6f5a3a');
  gradient.addColorStop(0.35, '#b5965d');
  gradient.addColorStop(0.7, '#86704a');
  gradient.addColorStop(1, '#51412d');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 1024);

  for (let i = 0; i < 45000; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const r = Math.random() * 1.8 + 0.3;
    const shade = 70 + Math.random() * 120;
    const alpha = 0.12 + Math.random() * 0.25;

    ctx.fillStyle = `rgba(${shade + 45}, ${shade + 25}, ${shade * 0.55}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const w = Math.random() * 28 + 8;
    const h = Math.random() * 9 + 3;
    const rot = Math.random() * Math.PI;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = `rgba(55, 45, 35, ${0.18 + Math.random() * 0.22})`;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);
  texture.anisotropy = 8;

  return texture;
}


function addTerrainMesh(imageUrl = "/Highland_valley.png") {
    // // Add Terrain Mesh
    // const geometry = new THREE.PlaneGeometry(1000, 1000, 128, 128);
    // const material = new THREE.MeshStandardMaterial({
    //   color: 0x964B00,
    //   displacementScale: 200, // Adjust based on your heightmap's contrast
    //   wireframe: true,
    // });
  
    // const terrain = new THREE.Mesh(geometry, material);
    // // terrain.rotation.x = -Math.PI / 2; // Lay on the xz plane by rotating 90 degree
    // terrain.position.set(0, 0, 0);  // Shift under the conveyor belt
      
    // // Loads from the 'public' folder in Vite
    // const textureLoader = new THREE.TextureLoader();
    // textureLoader.load(imageUrl, (texture) => {
    //   texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    //   texture.repeat.set(1, 1);
    //   material.displacementMap = texture;
    //   material.needsUpdate = true;
  
      // Add Terrain Mesh
    const geometry = new THREE.PlaneGeometry(1000, 1000, 128, 128);
    const material = new THREE.MeshStandardMaterial({
      color: 0x964B00,
      displacementScale: 200, // Adjust based on your heightmap's contrast
      wireframe: true,
    });
  
    const terrain = new THREE.Mesh(geometry, material);
    // terrain.rotation.x = -Math.PI / 2; // Lay on the xz plane by rotating 90 degree
    terrain.position.set(0, 0, 0);  // Shift under the conveyor belt
      
    // Loads from the 'public' folder in Vite
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(imageUrl, (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1, 1);
      material.displacementMap = texture;
      material.needsUpdate = true;
    });
  
    return terrain
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
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true
  });

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

    if (tangent.length() < 0.001) {
      tangent.set(1, 0, 0);
    }

    tangent.normalize();

    const side = new THREE.Vector3()
      .crossVectors(up, tangent)
      .normalize()
      .multiplyScalar(width / 2);

    const left = points[i].clone().add(side);
    const right = points[i].clone().sub(side);

    vertices.push(left.x, left.y, left.z + 1.5);
    vertices.push(right.x, right.y, right.z + 1.5);

    if (i < points.length - 1) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = i * 2 + 2;
      const d = i * 2 + 3;

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
  const geometry = new THREE.TubeGeometry(
    curve,
    Math.max(24, points.length * 8),
    radius,
    10,
    false
  );

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.25
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.dynamicGraph = true;
  scene.add(mesh);
}

function addRoller(scene, position, tangent, width, selected = false) {
  const horizontal = tangent.clone();
  horizontal.z = 0;

  if (horizontal.length() < 0.001) {
    horizontal.set(1, 0, 0);
  }

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
  const material = new THREE.MeshStandardMaterial({
    color: 0x5c5c5c,
    roughness: 0.6,
    metalness: 0.4
  });

  const support = new THREE.Mesh(geometry, material);

  support.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)
  );

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
  const leftRail = [];
  const rightRail = [];

  for (let i = 0; i < sampled.length; i++) {
    const prev = sampled[Math.max(i - 1, 0)];
    const next = sampled[Math.min(i + 1, sampled.length - 1)];

    const tangent = new THREE.Vector3().subVectors(next, prev);
    tangent.z = 0;

    if (tangent.length() < 0.001) tangent.set(1, 0, 0);

    tangent.normalize();

    const side = new THREE.Vector3(-tangent.y, tangent.x, 0)
      .normalize()
      .multiplyScalar(railOffset);

    leftRail.push(sampled[i].clone().add(side).add(new THREE.Vector3(0, 0, 4)));
    rightRail.push(sampled[i].clone().sub(side).add(new THREE.Vector3(0, 0, 4)));
  }

  addTube(scene, leftRail, color, 1.7);
  addTube(scene, rightRail, color, 1.7);

  const rollerEvery = 0.06;

  for (let t = 0; t <= 1; t += rollerEvery) {
    const p = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);

    addRoller(scene, p, tangent, beltWidth, false);
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
  });
}

function View3D({ rows, selectedId, onSelect, heightmapUrl}) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const sceneRef = useRef(null);
  const terrainRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = '';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030711);
    scene.fog = new THREE.Fog(0x030711, 900, 2600);
    sceneRef.current = scene;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 10000);
    camera.position.set(420, -720, 420);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));

    const sun = new THREE.DirectionalLight(0xffffff, 1.05);
    sun.position.set(300, -500, 800);
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0xffd9a0, 0.35);
    fill.position.set(-500, 400, 250);
    scene.add(fill);
    // TERRAIN FUNCTION
    const terrain = addTerrainMesh(heightmapUrl);
    terrainRef.current = terrain; 
    scene.add(terrain);

    // TERRAIN FUNCTION
    // const groundGeometry = new THREE.PlaneGeometry(2600, 2600, 120, 120);
    // const groundTexture = createMineGroundTexture();

    // const groundMaterial = new THREE.MeshStandardMaterial({
    //   map: groundTexture,
    //   roughness: 1,
    //   metalness: 0,
    //   color: 0xd1b078,
    //   transparent: true,
    //   opacity: 0.82,
    //   side: THREE.DoubleSide,
    //   depthWrite: false
    // });

    // const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    // ground.position.z = 0;
    // scene.add(ground);

    const grid = new THREE.GridHelper(2600, 65, 0x4b4030, 0x2d271f);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.04;
    scene.add(grid);

    function axis(start, end, color) {
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const material = new THREE.LineBasicMaterial({ color });
      const line = new THREE.Line(geometry, material);
      scene.add(line);
    }

    axis(new THREE.Vector3(-1100, 0, 0), new THREE.Vector3(1100, 0, 0), 0xff5555);
    axis(new THREE.Vector3(0, -1100, 0), new THREE.Vector3(0, 1100, 0), 0x55ff55);
    axis(new THREE.Vector3(0, 0, -250), new THREE.Vector3(0, 0, 500), 0x66aaff);

    const xLabel = makeTextSprite('X', '#ff6666');
    xLabel.position.set(1160, 0, 25);
    scene.add(xLabel);

    const yLabel = makeTextSprite('Y', '#66ff66');
    yLabel.position.set(0, 1160, 25);
    scene.add(yLabel);

    const zLabel = makeTextSprite('Z', '#66aaff');
    zLabel.position.set(0, 0, 540);
    scene.add(zLabel);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function onClick(event) {
      const clickable = scene.children.filter((obj) => obj.userData?.row);

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(clickable, false);

      if (hits.length > 0) {
        onSelect(hits[0].object.userData.row);
      }
    }

    renderer.domElement.addEventListener('click', onClick);

    function onResize() {
      const w = container.clientWidth;
      const h = container.clientHeight;

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
  // }, []);
  }, [onSelect]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !rows.length) return;

    const oldObjects = scene.children.filter((obj) => obj.userData?.dynamicGraph);

    oldObjects.forEach((obj) => {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });

    const xs = rows.map((r) => r.x);
    const ys = rows.map((r) => r.y);

    const xMid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;

    function toVec(r) {
      return new THREE.Vector3(r.x - xMid, r.y - yMid, r.z);
    }

    buildConveyor(scene, sortedByStrand(rows, 'Carry'), 'Carry', toVec, selectedId);
    buildConveyor(scene, sortedByStrand(rows, 'Return'), 'Return', toVec, selectedId);

    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, [rows, selectedId]);

  useEffect(() => {
    if (!terrainRef.current || !heightmapUrl) return;
    
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(heightmapUrl, (newTexture) => {
      newTexture.wrapS = newTexture.wrapT = THREE.RepeatWrapping;
      newTexture.repeat.set(1, 1);
      
      const material = terrainRef.current.material;
      material.displacementMap = newTexture;
      material.needsUpdate = true;
    });
  }, [heightmapUrl]);

  return (
    <section className="view3d">
      <div className="view-head">
        <h3>3D CONVEYOR VIEW</h3>
        <span className="hint">
          Drag rotate · Scroll zoom · Right-click pan · Click node
        </span>
      </div>

      <div ref={containerRef} className="three-container" />
    </section>
  );
}

function NodeTable({ rows, selectedId, onSelect, onEdit }) {
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
            <th>TAGS</th>
          </tr>
        </thead>

        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={selectedId === r.id ? 'selected-row' : ''}
              onClick={() => onSelect(r)}
            >
              <td>{r.id}</td>

              <td>
                <span className={`pill ${r.strand === 'Return' ? 'return' : ''}`}>
                  {r.strand}
                </span>
              </td>

              {['x', 'y', 'z'].map((k) => (
                <td key={k}>
                  <input
                    value={Number(r[k]).toFixed(2)}
                    onChange={(e) => onEdit(r.id, { [k]: num(e.target.value, r[k]) })}
                  />
                </td>
              ))}

              <td>
                <input value={r.tags} onChange={(e) => onEdit(r.id, { tags: e.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function App() {
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState('Loading path_simple.csv...');

  const [heightmapUrl, setHeightmapUrl] = useState('/Heightmap_Joy2.png');

  useEffect(() => {
    fetch(DEFAULT_CSV_PATH)
      .then((res) => {
        if (!res.ok) {
          throw new Error('Could not load /path_simple.csv. Put path_simple.csv inside app/public/.');
        }
        return res.text();
      })
      .then((csvText) => {
        const loadedRows = rowsFromCsvText(csvText);
        setRows(loadedRows);
        setStatus(`Loaded ${loadedRows.length} nodes from path_simple.csv`);
      })
      .catch((err) => setStatus(err.message));
  }, []);

  const m = useMemo(() => metrics(rows), [rows]);
  const selected = rows.find((r) => r.id === selectedId);

  function setSelected(row) {
    setSelectedId(row.id);
    setStatus(`Selected node ${row.id}`);
  }

  function updateNode(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addNode() {
    const id = Math.max(-1, ...rows.map((r) => Number(r.id)).filter(Number.isFinite)) + 1;
    const last = rows[rows.length - 1] ?? { x: 0, y: 0, z: 0 };

    const node = {
      id,
      strand: 'Carry',
      strandValue: -1,
      group: 0,
      x: last.x + 50,
      y: last.y,
      z: last.z,
      tags: ''
    };

    setRows((r) => [...r, node]);
    setSelectedId(id);
    setStatus(`Added node ${id}`);
  }
  
  function addNode() {
    setRows((currentRows) => {
      // 1. Calculate the new ID based on the MOST RECENT state
      const maxId = currentRows.reduce((max, r) => Math.max(max, Number(r.id) || 0), -1);
      const newId = maxId + 1;
  
      // 2. Find the template (selected node) from the MOST RECENT state
      // We use the 'selectedId' from the outer scope
      const selectedNode = currentRows.find(r => r.id === selectedId);
      
      // 3. Find the last node for positioning
      const last = currentRows[currentRows.length - 1] ?? { x: 0, y: 0, z: 0 };
  
      // 4. Build the new node
      const newNode = {
        id: newId,
        strand: selectedNode ? selectedNode.strand : 'Carry',
        strandValue: selectedNode ? selectedNode.strandValue : -1,
        group: selectedNode ? selectedNode.group : 0,
        x: last.x + 50,
        y: last.y,
        z: last.z,
        tags: ''
      };
  
      // 5. Update Status and Selection (Side effects)
      // We use setTimeout to move these out of the render-cycle calculation
      setTimeout(() => {
        setSelectedId(newId);
        setStatus(`Added node ${newId} inheriting ${newNode.strand}`);
      }, 0);
  
      return [...currentRows, newNode];
    });
  }

  function deleteNode() {
    if (selectedId === null) return;
    setRows((r) => r.filter((n) => n.id !== selectedId));
    setSelectedId(null);
    setStatus('Deleted selected node');
  }

  function toggleStrand() {
    if (selectedId === null) return;
    
    setRows((prev) => prev.map((r) => {
      if (r.id === selectedId) {
        const isCurrentlyCarry = r.strand === 'Carry';
        return {
          ...r,
          strand: isCurrentlyCarry ? 'Return' : 'Carry',
          strandValue: isCurrentlyCarry ? 1 : -1, // Carry is -1, Return is 1
          group: isCurrentlyCarry ? 1 : 0         // Assuming group 1 = Return, 0 = Carry
        };
      }
      return r;
    }));

    setStatus(`Switched Node ${selectedId} to ${selected?.strand === 'Carry' ? 'Return' : 'Carry'}`);
}

  function exportFile(type) {
    const exportRows = rows.map((r) => ({
      id: r.id,
      x: r.x,
      y: r.y,
      z: r.z,
      group: r.group,
      tags: r.tags
    }));

    const data = type === 'json' ? JSON.stringify(exportRows, null, 2) : Papa.unparse(exportRows);

    const blob = new Blob([data], {
      type: type === 'json' ? 'application/json' : 'text/csv'
    });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conveyor-layout.${type === 'json' ? 'json' : 'csv'}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

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
        </div>
      </header>

      <div className="toolbar">
        <label className="tool-btn">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) =>
              e.target.files?.[0] && parseCsvFile(e.target.files[0], setRows, setStatus)
            }
          />
          Upload CSV
        </label>

        <button className="primary" onClick={addNode}>+ Add Node</button>
        {/* NEW TOGGLE BUTTON */}
        <button 
            onClick={toggleStrand} 
            disabled={selectedId === null}
            style={{ borderLeft: '4px solid #0857f7' }}
          >
            ⇄ Switch Strand
          </button>

        <button className="danger" disabled={selectedId === null} onClick={deleteNode}>
          Delete Node
        </button>
        <button onClick={() => exportFile('csv')}>Export CSV</button>
        <button onClick={() => exportFile('json')}>Export JSON</button>

        <span className="status">{status}</span>
      </div>

      {rows.length > 0 && (
        <>
          <section className="visual-area">
            <div className="left-plots">
              <MiniPlot
                title="SIDE VIEW (STRETCHED)"
                mode="side"
                rows={rows}
                selectedId={selectedId}
                onSelect={setSelected}
                onDragNode={updateNode}
              />

              <MiniPlot
                title="TOP VIEW (PLAN)"
                mode="top"
                rows={rows}
                selectedId={selectedId}
                onSelect={setSelected}
                onDragNode={updateNode}
              />
            </div>

            <View3D rows={rows} selectedId={selectedId} onSelect={setSelected} />
          </section>

          <NodeTable rows={rows} selectedId={selectedId} onSelect={setSelected} onEdit={updateNode} />
        </>
      )}

      {selected && (
        <div className="selected-banner">
          Selected: Node {selected.id} · {selected.strand} · (
          {selected.x.toFixed(2)}, {selected.y.toFixed(2)}, {selected.z.toFixed(2)})
          · {selected.tags || 'no tags'}
        </div>
      )}
    </main>
  );
}
