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

const TERRAIN_SIZE = 1000;
const TERRAIN_DISPLACEMENT_SCALE = 200;
const HEIGHTMAP_PATH = '/Heightmap_Joy2.png';

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

function loadHeightmapSampler(src, displacementScale) {
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

      function sampleHeight(localX, localY, terrainSize) {
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

function MiniPlot({ title, mode, rows, selectedId, onSelect, onDragNode }) {
  const svgRef = useRef(null);
  const [stretched, setStretched] = useState(false);
  const w = 760;
  const h = 255;
  const margin = { top: 32, right: 24, bottom: 40, left: 56 };

  const carryRows = sortedByStrand(rows, 'Carry');
  const returnRows = sortedByStrand(rows, 'Return').reverse();

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

  const all = displayData.all;

  const xValue = mode === 'side' && stretched ? (d) => d.arc : (d) => d.x;
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
        onDragNode(d.id, {
          x: x.invert(pt[0]),
          y: y.invert(pt[1])
        });
      }

      if (mode === 'side') {
        onDragNode(d.id, {
          z: y.invert(pt[1])
        });
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

  // Calculate total length for display
  const totalCarryLength = carryArc.length > 0 ? carryArc[carryArc.length - 1].arc : 0;
  const totalReturnLength = returnArc.length > 0 ? returnArc[returnArc.length - 1].arc - carryTotalLength : 0;

  return (
    <section className="plot-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
          minHeight: '32px'
        }}
      >
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
        <div
          style={{
            fontSize: '15px',
            color: '#888',
            marginBottom: '12px',
            textAlign: 'center',
            padding: '4px 8px',
            background: 'rgba(0,0,0,0.2)',
            borderRadius: '4px'
          }}>
          {/* Total stretched length: {totalCarryLength.toFixed(0)}m */}
          Carry length: {totalCarryLength.toFixed(0)}m | Return length: {totalReturnLength.toFixed(0)}m
          <span style={{ marginLeft: '12px', fontSize: '10px' }}>
            (X-axis shows true belt length)
          </span>
        </div>
      )}
      <h3>{title}</h3>

      <svg ref={svgRef} viewBox={`0 0 ${w} ${h}`}>
        <g className="gridlines">
          {x.ticks(8).map((t) => (
            <line
              key={`x${t}`}
              x1={x(t)}
              x2={x(t)}
              y1={margin.top}
              y2={h - margin.bottom}
            />
          ))}

          {y.ticks(5).map((t) => (
            <line
              key={`y${t}`}
              x1={margin.left}
              x2={w - margin.right}
              y1={y(t)}
              y2={y(t)}
            />
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
          <text x={w / 2} y={h - 8} textAnchor="middle" fontSize="12" fill="#888">
            {mode === 'side'
              ? stretched
                ? 'Belt Arc Length (m) →'
                : 'Horizontal Distance X (m) →'
              : 'X (m) →'}
          </text>
          
          {/* Y-axis label */}
          <text 
            transform={`translate(12 ${h / 2}) rotate(-90)`}
            textAnchor="middle" 
            fontSize="12" 
            fill="#888"
          >
            {mode === 'side' ? '↑ Elevation Z (m)' : '↑ Y (m)'}
          </text>
        </g>

        {dataByStrand.map(
          (strandData) =>
            strandData.length > 1 && (
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
          💡 Tip: Toggle between Projected actual X vs Z and Stretched true belt length vs Z
        </div>
      )}
    </section>
  );
}

function addTerrainMesh(terrainScale, heightmapUrl) {
  const effectiveTerrainSize = TERRAIN_SIZE * terrainScale;

  const geometry = new THREE.PlaneGeometry(effectiveTerrainSize, effectiveTerrainSize, 1000, 1000);
  const textureLoader = new THREE.TextureLoader();

  const material = new THREE.MeshStandardMaterial({
    color: 0x964b00,
    displacementScale: TERRAIN_DISPLACEMENT_SCALE,
    wireframe: true
  });

  const heightmapTexture = textureLoader.load(heightmapUrl || HEIGHTMAP_PATH, () => {
    material.needsUpdate = true;
  });

  heightmapTexture.wrapS = heightmapTexture.wrapT = THREE.RepeatWrapping;
  heightmapTexture.repeat.set(1, 1);

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

function View3D({ rows, selectedId, onSelect, terrainScale, heightmapUrl }) {
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

    const terrain = addTerrainMesh(terrainScale, heightmapUrl);
    terrainRef.current = terrain;
    scene.add(terrain);

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
  }, [onSelect, terrainScale]);

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
  }, [rows, selectedId, terrainScale]);


  // Update terrain material when heightmapUrl changes
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
          Drag rotate · Scroll zoom · Right-click pan · Click node · Wireframe scale {terrainScale.toFixed(2)}x
        </span>
      </div>

      <div ref={containerRef} className="three-container" />
    </section>
  );
}

function NodeTable({ rows, selectedId, fittedIds, onSelect, onEdit }) {
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
              className={[
                selectedId === r.id ? 'selected-row' : '',
                fittedIds?.has(r.id) ? 'fitted-row' : ''
              ].join(' ')}
              onClick={() => onSelect(r)}
              title={
                fittedIds?.has(r.id) && r.wireframeZ !== null
                  ? `Adjusted to wireframe Z = ${Number(r.wireframeZ).toFixed(2)} m`
                  : ''
              }
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
  const [heightmapUrl, setHeightmapUrl] = useState(HEIGHTMAP_PATH);
  const [fittedIds, setFittedIds] = useState(new Set());
  const [heightSampler, setHeightSampler] = useState(null);
  const [terrainScale, setTerrainScale] = useState(1);

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
        setFittedIds(new Set());
        setStatus(`Loaded ${loadedRows.length} nodes from path_simple.csv`);
      })
      .catch((err) => setStatus(err.message));
  }, []);

  useEffect(() => {
    loadHeightmapSampler(heightmapUrl, TERRAIN_DISPLACEMENT_SCALE)
      .then((sampler) => {
        setHeightSampler(() => sampler);
      })
      .catch(() => {
        setStatus('Could not load heightmap for FIT operation.');
      });
  }, []);

  const m = useMemo(() => metrics(rows), [rows]);
  const selected = rows.find((r) => r.id === selectedId);

  function setSelected(row) {
    setSelectedId(row.id);
    setStatus(`Selected node ${row.id}`);
  }

  function updateNode(id, patch) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              ...patch
            }
          : r
      )
    );

    setFittedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function decreaseWireframeScale() {
    setTerrainScale((prev) => {
      const next = Math.max(0.2, Number((prev - 0.1).toFixed(2)));
      setFittedIds(new Set());
      setStatus(`Wireframe scale decreased to ${next.toFixed(2)}x. Press FIT again to resnap nodes.`);
      return next;
    });
  }

  function increaseWireframeScale() {
    setTerrainScale((prev) => {
      const next = Math.min(5, Number((prev + 0.1).toFixed(2)));
      setFittedIds(new Set());
      setStatus(`Wireframe scale increased to ${next.toFixed(2)}x. Press FIT again to resnap nodes.`);
      return next;
    });
  }

  function resetWireframeScale() {
    setTerrainScale(1);
    setFittedIds(new Set());
    setStatus('Wireframe scale reset to 1.00x. Press FIT again to resnap nodes.');
  }

  function fitNodesToWireframe() {
    if (!heightSampler || !rows.length) {
      setStatus('Heightmap is not ready yet.');
      return;
    }

    const xs = rows.map((r) => r.x);
    const ys = rows.map((r) => r.y);

    const xMid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;

    const effectiveTerrainSize = TERRAIN_SIZE * terrainScale;
    const adjusted = new Set();

    const fittedRows = rows.map((row) => {
      if (!row.fromCsv) {
        return row;
      }

      const localX = row.x - xMid;
      const localY = row.y - yMid;

      const wireframeZ = heightSampler(localX, localY, effectiveTerrainSize);

      if (wireframeZ === null) {
        return {
          ...row,
          fittedToWireframe: false,
          wireframeZ: null
        };
      }

      if (row.z < wireframeZ) {
        adjusted.add(row.id);

        return {
          ...row,
          z: wireframeZ,
          fittedToWireframe: true,
          wireframeZ
        };
      }

      return {
        ...row,
        fittedToWireframe: false,
        wireframeZ
      };
    });

    setRows(fittedRows);
    setFittedIds(adjusted);

    setStatus(
      adjusted.size > 0
        ? `FIT complete: adjusted ${adjusted.size} node${adjusted.size === 1 ? '' : 's'} to wireframe height at ${terrainScale.toFixed(2)}x scale.`
        : `FIT complete: no nodes needed adjustment at ${terrainScale.toFixed(2)}x scale.`
    );
  }
  // OLD ADDNODE
  // function addNode() {
  //   const id = Math.max(-1, ...rows.map((r) => Number(r.id)).filter(Number.isFinite)) + 1;
  //   const last = rows[rows.length - 1] ?? { x: 0, y: 0, z: 0 };

  //   const node = {
  //     id,
  //     strand: 'Carry',
  //     strandValue: -1,
  //     group: 0,
  //     x: last.x + 50,
  //     y: last.y,
  //     z: last.z,
  //     originalZ: last.z,
  //     tags: '',
  //     fromCsv: false,
  //     fittedToWireframe: false,
  //     wireframeZ: null
  //   };

  //   setRows((r) => [...r, node]);
  //   setSelectedId(id);
  //   setStatus(`Added node ${id}`);
  // }

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
      return [...currentRows, newNode];
    });
  }

  function addNodeAfter() {
    if (selectedId === null) {
      setStatus("Select a node first to insert after it!");
      return;
    }

    setRows((currentRows) => {
      // 1. Find where the selected node is in the array
      const currentIndex = currentRows.findIndex(r => r.id === selectedId);
      if (currentIndex === -1) return currentRows;

      const selectedNode = currentRows[currentIndex];
      const nextNode = currentRows[currentIndex + 1];

      // 2. Generate the "Sub-ID" (e.g., 5 becomes 5a)
      // If adding after 5a, it becomes 5aa
      const newId = Math.max(...currentRows.map(r => Number(r.id) || 0)) + 1;

      // 3. Calculate position (midpoint between current and next, or just offset)
      const newNode = {
        ...selectedNode, // Inherit strand, group, strandValue
        id: newId,
        // Place it physically between the current and next node if next exists
        x: nextNode ? (selectedNode.x + nextNode.x) / 2 : selectedNode.x + 25,
        y: nextNode ? (selectedNode.y + nextNode.y) / 2 : selectedNode.y + 25,
        z: nextNode ? (selectedNode.z + nextNode.z) / 2 : selectedNode.z,
        fromCsv: false,
        tags: `Inserted after ${selectedId}`
      };

      // 4. Splice into the array to maintain visual path order
      const updatedRows = [...currentRows];
      updatedRows.splice(currentIndex + 1, 0, newNode);

      // 5. Update Selection/Status
      setTimeout(() => {
        setSelectedId(newId);
        setStatus(`Inserted Node ${newId} between ${selectedId} and ${nextNode?.id || 'End'}`);
      }, 0);

      return updatedRows;
    });
  }

  // 5. Update Status and Selection (Side effects)
  // We use setTimeout to move these out of the render-cycle calculation
  setTimeout(() => {
    setSelectedId(newId);
    setStatus(`Added node ${newId} inheriting ${newNode.strand}`);
  }, 0);


  function deleteNode() {
    if (selectedId === null) return;

    setRows((r) => r.filter((n) => n.id !== selectedId));

    setFittedIds((prev) => {
      const next = new Set(prev);
      next.delete(selectedId);
      return next;
    });

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
          <span className="carry-text">
            Carry <b>{m.carry}</b>
          </span>
          <span className="return-text">
            Return <b>{m.ret}</b>
          </span>
          <span>·</span>
          Belt Length <b>{m.lengthKm.toFixed(2)} km</b>
          <span>·</span>
          Elevation{' '}
          <b>
            {m.zMin.toFixed(1)} → {m.zMax.toFixed(1)} m
          </b>
          <span>·</span>
          Wireframe <b>{terrainScale.toFixed(2)}x</b>
        </div>
      </header>

      <div className="toolbar">
        <label className="tool-btn">
          <input
            type="file"
            accept="image/png, image/jpeg"
            onChange={(e) => {
              if (e.target.files?.[0]) {
                const url = URL.createObjectURL(e.target.files[0]);
                setHeightmapUrl(url);
                setStatus('Loaded custom heightmap');
              }
            }}
            style={{ display: 'none' }}
          />
          Upload Heightmap
        </label>
        <label className="tool-btn">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) =>
              e.target.files?.[0] &&
              parseCsvFile(
                e.target.files[0],
                (newRows) => {
                  setRows(newRows);
                  setFittedIds(new Set());
                  setStatus(`Loaded ${newRows.length} nodes from uploaded CSV`);
                },
                setStatus
              )
            }
          />
          Upload CSV
        </label>
        <button 
          className="primary" 
          onClick={addNodeAfter} 
          disabled={selectedId === null}
          style={{ backgroundColor: '#2e7d32' }} // Darker green to differentiate
        >
          + Insert After ({selectedId ?? '?'})
        </button>
        {/* <button className="primary" onClick={addNode}>+ Add Node</button> */}
        {/* NEW TOGGLE BUTTON */}
        <button 
            onClick={toggleStrand} 
            disabled={selectedId === null}
            style={{ borderLeft: '4px solid #0857f7' }}
          >
            ⇄ Switch Strand
        </button>

        <button className="fit-btn" onClick={fitNodesToWireframe}>
          FIT
        </button>

        <button onClick={decreaseWireframeScale}>WIRE -</button>
        <button onClick={resetWireframeScale}>RESET</button>
        <button onClick={increaseWireframeScale}>WIRE +</button>

        <button className="primary" onClick={addNode}>
          + Add Node
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
                title="SIDE VIEW"
                mode="side"
                rows={rows}
                selectedId={selectedId}
                onSelect={setSelected}
                onDragNode={updateNode}
              />

              <MiniPlot
                title="TOP VIEW"
                mode="top"
                rows={rows}
                selectedId={selectedId}
                onSelect={setSelected}
                onDragNode={updateNode}
              />
            </div>

            <View3D
              rows={rows}
              selectedId={selectedId}
              onSelect={setSelected}
              terrainScale={terrainScale}
              heightmapUrl={heightmapUrl}
            />
          </section>

          <NodeTable
            rows={rows}
            selectedId={selectedId}
            fittedIds={fittedIds}
            onSelect={setSelected}
            onEdit={updateNode}
          />
        </>
      )}

      {selected && (
        <div className="selected-banner">
          Selected: Node {selected.id} · {selected.strand} · ({selected.x.toFixed(2)},{' '}
          {selected.y.toFixed(2)}, {selected.z.toFixed(2)}) · {selected.tags || 'no tags'}
        </div>
      )}
    </main>
  );
}
// createRoot(document.getElementById('root')).render(<App />);
