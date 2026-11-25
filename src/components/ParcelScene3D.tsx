import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import type { LandListing, LandType } from '../types';
import { formatInrPrice } from '../api/client';

type CameraPreset = 'aerial' | 'corner' | 'structure' | 'frontage';

interface ParcelScene3DProps {
  listing: LandListing;
  heightClass?: string;
}

const PRESET_OFFSETS: Record<CameraPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  aerial: { pos: [26, 22, 26], target: [0, 1.2, 0] },
  corner: { pos: [-19, 10, 19], target: [0, 1.4, 0] },
  structure: { pos: [12, 8.5, 13], target: [0, 2.2, -1] },
  frontage: { pos: [0, 6.2, 28], target: [0, 1.8, 0] },
};

function createTerrainCanvasTexture(landType: LandType): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const palette: Record<LandType, { base: string; accent: string; line: string }> = {
    AGRICULTURAL: { base: '#4c7542', accent: '#3d6135', line: 'rgba(205, 224, 172, 0.14)' },
    RESIDENTIAL: { base: '#5f8652', accent: '#4f7344', line: 'rgba(232, 240, 220, 0.12)' },
    COMMERCIAL: { base: '#8e968e', accent: '#7a827a', line: 'rgba(255, 255, 255, 0.16)' },
    INDUSTRIAL: { base: '#797f86', accent: '#686e75', line: 'rgba(226, 232, 240, 0.16)' },
  };
  const colors = palette[landType] || palette.RESIDENTIAL;

  ctx.fillStyle = colors.base;
  ctx.fillRect(0, 0, 512, 512);

  // Subtle organic turf / paving grain
  for (let i = 0; i < 1800; i++) {
    const x = (Math.sin(i * 12.9898) * 0.5 + 0.5) * 512;
    const y = (Math.cos(i * 78.233) * 0.5 + 0.5) * 512;
    ctx.fillStyle = colors.accent;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(x, y, 4, 4);
  }
  ctx.globalAlpha = 1;

  // Survey grid lines or agricultural furrows
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.5;
  const step = landType === 'AGRICULTURAL' ? 24 : 64;
  for (let i = 0; i <= 512; i += step) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
    if (landType !== 'AGRICULTURAL') {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 512);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

function createRoadCanvasTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#333a42';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#e2e8f0';
  for (let x = 8; x < 256; x += 48) {
    ctx.fillRect(x, 61, 26, 5);
  }
  ctx.fillStyle = '#64748b';
  ctx.fillRect(0, 0, 256, 6);
  ctx.fillRect(0, 122, 256, 6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(6, 1);
  return tex;
}

/** Composite 5-part survey corner monument beacon */
function buildSurveyBeacon(index: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `Survey Beacon #${index + 1}`;

  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.85, metalness: 0.05 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.78 });
  const tealMat = new THREE.MeshStandardMaterial({
    color: 0x008069,
    emissive: 0x004d3f,
    emissiveIntensity: 0.45,
    roughness: 0.25,
    metalness: 0.2,
  });

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.3, 0.95), concreteMat);
  plinth.position.y = 0.15;
  plinth.castShadow = true;
  plinth.receiveShadow = true;

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 0.28, 12), steelMat);
  collar.position.y = 0.44;
  collar.castShadow = true;

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 12), steelMat);
  post.position.y = 1.25;
  post.castShadow = true;

  const prismRing = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 10, 20), steelMat);
  prismRing.position.y = 1.98;
  prismRing.rotation.x = Math.PI / 2;

  const beaconTip = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), tealMat);
  beaconTip.position.y = 2.02;
  beaconTip.castShadow = true;

  group.add(plinth, collar, post, prismRing, beaconTip);
  group.traverse((obj) => {
    obj.userData.inspectLabel = group.name;
  });
  return group;
}

/** Multi-part composite parcel structure matched to zoning & land type (5-9 parts) */
function buildParcelStructure(landType: LandType): THREE.Group {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.8, metalness: 0.05 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.75 });
  const accentTeal = new THREE.MeshStandardMaterial({ color: 0x008069, roughness: 0.45, metalness: 0.25 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x8ad4e8,
    roughness: 0.12,
    metalness: 0.1,
    transmission: 0.45,
    thickness: 0.2,
  });
  const timber = new THREE.MeshStandardMaterial({ color: 0x8b5a3c, roughness: 0.75, metalness: 0.05 });

  if (landType === 'AGRICULTURAL') {
    group.name = 'Agri Farmhouse & Drip Reservoir';
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.35, 5.2), concrete);
    deck.position.set(-2, 0.18, -1.5);
    deck.castShadow = true;
    deck.receiveShadow = true;

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 3.6), timber);
    cabin.position.set(-2.2, 1.45, -1.5);
    cabin.castShadow = true;

    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.8, 1.25, 4), accentTeal);
    roof.position.set(-2.2, 3.15, -1.5);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;

    const veranda = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 3.6), timber);
    veranda.position.set(0.6, 2.4, -1.5);

    const tankStand = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.8, 8), darkMetal);
    tankStand.position.set(4.5, 0.9, -2.5);
    tankStand.castShadow = true;

    const waterTank = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 1.5, 18), accentTeal);
    waterTank.position.set(4.5, 2.45, -2.5);
    waterTank.castShadow = true;

    group.add(deck, cabin, roof, veranda, tankStand, waterTank);
  } else if (landType === 'COMMERCIAL') {
    group.name = 'Commercial Glazed Podium & Plaza';
    const plaza = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.36, 8.2), concrete);
    plaza.position.set(0, 0.18, -1);
    plaza.receiveShadow = true;

    const podium = new THREE.Mesh(new THREE.BoxGeometry(8.2, 2.4, 5.8), darkMetal);
    podium.position.set(0, 1.55, -1.2);
    podium.castShadow = true;

    const glassCurtain = new THREE.Mesh(new THREE.BoxGeometry(8.35, 1.85, 5.95), glass);
    glassCurtain.position.set(0, 1.6, -1.2);

    const upperMass = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.8, 4.4), concrete);
    upperMass.position.set(-0.8, 4.15, -1.4);
    upperMass.castShadow = true;

    const upperGlass = new THREE.Mesh(new THREE.BoxGeometry(5.72, 2.1, 4.52), glass);
    upperGlass.position.set(-0.8, 4.15, -1.4);

    const crownCanopy = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.25, 4.9), accentTeal);
    crownCanopy.position.set(-0.8, 5.65, -1.4);
    crownCanopy.castShadow = true;

    group.add(plaza, podium, glassCurtain, upperMass, upperGlass, crownCanopy);
  } else if (landType === 'INDUSTRIAL') {
    group.name = 'Logistics Bay & Solar Roof';
    const apron = new THREE.Mesh(new THREE.BoxGeometry(12.2, 0.3, 9.6), concrete);
    apron.position.set(0, 0.15, -0.8);
    apron.receiveShadow = true;

    const hall = new THREE.Mesh(new THREE.BoxGeometry(9.6, 3.6, 6.4), concrete);
    hall.position.set(0, 2.1, -1.5);
    hall.castShadow = true;

    const roof = new THREE.Mesh(new THREE.BoxGeometry(10.0, 0.3, 6.8), darkMetal);
    roof.position.set(0, 4.05, -1.5);
    roof.castShadow = true;

    const solarBank1 = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.12, 2.4), accentTeal);
    solarBank1.position.set(-2.4, 4.35, -1.5);
    solarBank1.rotation.x = 0.22;

    const solarBank2 = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.12, 2.4), accentTeal);
    solarBank2.position.set(2.4, 4.35, -1.5);
    solarBank2.rotation.x = 0.22;

    const dock1 = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.3, 0.18), darkMetal);
    dock1.position.set(-2.2, 1.45, 1.72);
    const dock2 = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.3, 0.18), darkMetal);
    dock2.position.set(2.2, 1.45, 1.72);

    group.add(apron, hall, roof, solarBank1, solarBank2, dock1, dock2);
  } else {
    group.name = 'Residential Villa Envelope';
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.34, 7.0), concrete);
    plinth.position.set(0, 0.17, -1);
    plinth.receiveShadow = true;

    const groundFloor = new THREE.Mesh(new THREE.BoxGeometry(6.6, 2.3, 4.8), concrete);
    groundFloor.position.set(-0.3, 1.48, -1.1);
    groundFloor.castShadow = true;

    const upperSuite = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.0, 3.8), concrete);
    upperSuite.position.set(0.6, 3.6, -1.4);
    upperSuite.castShadow = true;

    const windowBay = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.45, 4.9), glass);
    windowBay.position.set(-0.4, 1.5, -1.1);

    const timberPergola = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.16, 3.2), timber);
    timberPergola.position.set(-2.3, 2.7, 0.5);
    timberPergola.castShadow = true;

    const parapet = new THREE.Mesh(new THREE.BoxGeometry(4.65, 0.22, 4.05), accentTeal);
    parapet.position.set(0.6, 4.68, -1.4);

    group.add(plinth, groundFloor, upperSuite, windowBay, timberPergola, parapet);
  }

  group.traverse((obj) => {
    obj.userData.inspectLabel = group.name;
  });
  return group;
}

/** Build North indicator monument */
function buildNorthCompass(): THREE.Group {
  const compass = new THREE.Group();
  compass.name = 'True North Monument';
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 });
  const arrowMat = new THREE.MeshStandardMaterial({ color: 0x075e54, roughness: 0.35, metalness: 0.4 });
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.16, 24), baseMat);
  disc.position.y = 0.08;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.2, 4), arrowMat);
  cone.position.y = 0.22;
  cone.rotation.x = -Math.PI / 2;
  compass.add(disc, cone);
  compass.position.set(-14.5, 0.05, 11.5);
  return compass;
}

export function ParcelScene3D({ listing, heightClass = 'h-[360px]' }: ParcelScene3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const [activePreset, setActivePreset] = useState<CameraPreset>('aerial');
  const [inspectedPart, setInspectedPart] = useState<string>('Parcel Perimeter & Survey Envelope');
  const presetTriggerRef = useRef<{ preset: CameraPreset; version: number }>({
    preset: 'aerial',
    version: 0,
  });

  const cornerMetrics = useMemo(() => {
    const ring = listing.polygon_geojson?.coordinates?.[0] ?? [];
    if (ring.length < 3) return [[-11, -9], [11, -9], [11, 9], [-11, 9]] as Array<[number, number]>;
    const lons = ring.map(([lng]) => lng);
    const lats = ring.map(([, lat]) => lat);
    const minLng = Math.min(...lons);
    const maxLng = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const spanLng = Math.max(0.0005, maxLng - minLng);
    const spanLat = Math.max(0.0005, maxLat - minLat);
    // Normalize parcel footprint cleanly to a ~22x18 meter architectural inspection stage
    const pts = ring.slice(0, -1).map(([lng, lat]): [number, number] => [
      ((lng - (minLng + maxLng) / 2) / spanLng) * 22,
      -(((lat - (minLat + maxLat) / 2) / spanLat) * 18),
    ]);
    return pts.length >= 3 ? pts : ([[-11, -9], [11, -9], [11, 9], [-11, 9]] as Array<[number, number]>);
  }, [listing]);

  const applyPreset = (preset: CameraPreset) => {
    setActivePreset(preset);
    presetTriggerRef.current = { preset, version: presetTriggerRef.current.version + 1 };
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 360;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      setWebglUnavailable(false);
    } catch {
      setWebglUnavailable(true);
      return;
    }

    const gl = renderer.getContext();
    const glRenderer = String(gl.getParameter(gl.RENDERER) || '');
    const isSoftwareGl = /SwiftShader|llvmpipe|Software/i.test(glRenderer);

    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdbe6df);
    scene.fog = new THREE.FogExp2(0xdbe6df, 0.011);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 220);
    camera.position.set(...PRESET_OFFSETS.aerial.pos);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 9;
    controls.maxDistance = 58;
    controls.maxPolarAngle = Math.PI / 2.04;
    controls.target.set(...PRESET_OFFSETS.aerial.target);

    // Outdoor daylight: warm directional sun + cool sky/ground hemisphere
    const hemiLight = new THREE.HemisphereLight(0xb2d8f2, 0x3b4d37, 0.78);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.85);
    sunLight.position.set(22, 32, 18);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(isSoftwareGl ? 1024 : 2048, isSoftwareGl ? 1024 : 2048);
    sunLight.shadow.camera.near = 2;
    sunLight.shadow.camera.far = 90;
    const d = 22;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0002;
    sunLight.shadow.normalBias = 0.025;
    scene.add(sunLight);

    // Disposables tracker
    const texturesToDispose: THREE.Texture[] = [];
    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    // Surrounding contoured terrain base
    const surroundGeo = new THREE.PlaneGeometry(110, 110, 32, 32);
    surroundGeo.rotateX(-Math.PI / 2);
    const posAttr = surroundGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const dist = Math.hypot(x, z);
      const undulation = dist > 16 ? Math.sin(x * 0.09) * Math.cos(z * 0.09) * 0.85 : 0;
      posAttr.setY(i, undulation - 0.12);
    }
    surroundGeo.computeVertexNormals();
    const surroundMat = new THREE.MeshStandardMaterial({
      color: 0xc2d0c2,
      roughness: 0.94,
      metalness: 0.0,
    });
    const surroundMesh = new THREE.Mesh(surroundGeo, surroundMat);
    surroundMesh.receiveShadow = true;
    scene.add(surroundMesh);

    // Parcel plot extruded footprint derived from GeoJSON polygon
    const plotShape = new THREE.Shape();
    cornerMetrics.forEach(([x, z], idx) => {
      if (idx === 0) plotShape.moveTo(x, -z);
      else plotShape.lineTo(x, -z);
    });
    plotShape.closePath();

    const plotGeo = new THREE.ExtrudeGeometry(plotShape, {
      depth: 0.35,
      bevelEnabled: true,
      bevelThickness: 0.06,
      bevelSize: 0.08,
      bevelSegments: 2,
    });
    plotGeo.rotateX(-Math.PI / 2);

    const terrainTex = createTerrainCanvasTexture(listing.land_type);
    terrainTex.anisotropy = maxAniso;
    texturesToDispose.push(terrainTex);

    const plotMat = new THREE.MeshStandardMaterial({
      map: terrainTex,
      roughness: 0.86,
      metalness: 0.04,
    });
    const plotMesh = new THREE.Mesh(plotGeo, plotMat);
    plotMesh.position.y = 0.02;
    plotMesh.receiveShadow = true;
    plotMesh.castShadow = true;
    plotMesh.userData.inspectLabel = `${listing.locality} · ${listing.area_acres} Acres Plot`;
    scene.add(plotMesh);

    // Perimeter boundary line
    const borderPoints = [...cornerMetrics, cornerMetrics[0]].map(
      ([x, z]) => new THREE.Vector3(x, 0.44, z),
    );
    const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
    const borderLine = new THREE.Line(
      borderGeo,
      new THREE.LineBasicMaterial({ color: 0x008069 }),
    );
    scene.add(borderLine);

    // Frontage access road
    const roadTex = createRoadCanvasTexture();
    roadTex.anisotropy = maxAniso;
    texturesToDispose.push(roadTex);
    const roadMesh = new THREE.Mesh(
      new THREE.BoxGeometry(36, 0.14, 4.4),
      new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.78 }),
    );
    roadMesh.position.set(0, 0.06, 12.6);
    roadMesh.receiveShadow = true;
    roadMesh.userData.inspectLabel = 'Access Road Frontage';
    scene.add(roadMesh);

    // Corner Survey Beacons
    const clickableObjects: THREE.Object3D[] = [plotMesh, roadMesh];
    cornerMetrics.slice(0, 6).forEach(([x, z], idx) => {
      const beacon = buildSurveyBeacon(idx);
      beacon.position.set(x, 0.38, z);
      scene.add(beacon);
      clickableObjects.push(beacon);
    });

    // Context Site Structure matched to land type
    const structure = buildParcelStructure(listing.land_type);
    structure.position.set(0, 0.38, 0);
    scene.add(structure);
    clickableObjects.push(structure);

    // North Compass Monument
    const compass = buildNorthCompass();
    scene.add(compass);

    // Instanced trees along road / orchard perimeter (batched draw call)
    const treeCount = listing.land_type === 'AGRICULTURAL' ? 24 : 10;
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 1.5, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.9 });
    const canopyGeo = new THREE.IcosahedronGeometry(0.95, 1);
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x3f7a44, roughness: 0.78 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, treeCount);
    trunks.castShadow = true;
    canopies.castShadow = true;
    const dummy = new THREE.Object3D();

    for (let i = 0; i < treeCount; i++) {
      let tx = -13 + (i % 8) * 3.8;
      let tz = 15.6;
      if (listing.land_type === 'AGRICULTURAL' && i >= 8) {
        const idx = i - 8;
        tx = 4.5 + (idx % 4) * 2.2;
        tz = -6 + Math.floor(idx / 4) * 2.6;
      }
      const scale = 0.8 + ((i * 37) % 10) * 0.04;
      dummy.position.set(tx, 0.75 * scale, tz);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      dummy.position.set(tx, 2.05 * scale, tz);
      dummy.updateMatrix();
      canopies.setMatrixAt(i, dummy.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    scene.add(trunks, canopies);

    // Raycasting on pointer click for inspecting landmarks/beacons
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const handlePointerDown = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(clickableObjects, true);
      if (hits.length > 0 && hits[0].object.userData.inspectLabel) {
        setInspectedPart(String(hits[0].object.userData.inspectLabel));
      }
    };
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);

    // Smooth camera preset damping
    let lastHandledVersion = presetTriggerRef.current.version;
    let animatingPreset = false;
    const goalPos = new THREE.Vector3(...PRESET_OFFSETS.aerial.pos);
    const goalTarget = new THREE.Vector3(...PRESET_OFFSETS.aerial.target);
    const clock = new THREE.Clock();
    let rafId = 0;

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.1);

      if (presetTriggerRef.current.version !== lastHandledVersion) {
        lastHandledVersion = presetTriggerRef.current.version;
        const cfg = PRESET_OFFSETS[presetTriggerRef.current.preset];
        goalPos.set(...cfg.pos);
        goalTarget.set(...cfg.target);
        animatingPreset = true;
      }

      if (animatingPreset) {
        camera.position.x = THREE.MathUtils.damp(camera.position.x, goalPos.x, 5.5, delta);
        camera.position.y = THREE.MathUtils.damp(camera.position.y, goalPos.y, 5.5, delta);
        camera.position.z = THREE.MathUtils.damp(camera.position.z, goalPos.z, 5.5, delta);
        controls.target.x = THREE.MathUtils.damp(controls.target.x, goalTarget.x, 5.5, delta);
        controls.target.y = THREE.MathUtils.damp(controls.target.y, goalTarget.y, 5.5, delta);
        controls.target.z = THREE.MathUtils.damp(controls.target.z, goalTarget.z, 5.5, delta);
        if (camera.position.distanceTo(goalPos) < 0.08) {
          animatingPreset = false;
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 640;
      const h = container.clientHeight || 360;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      controls.dispose();
      envTarget.dispose();
      texturesToDispose.forEach((t) => t.dispose());
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh || (obj as THREE.Line).isLine) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            mesh.material?.dispose();
          }
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [listing.id, listing.land_type, cornerMetrics, expanded]);

  return (
    <div
      className={
        expanded
          ? 'fixed inset-0 h-[100dvh] z-50 bg-[#0F172A] flex flex-col'
          : `relative w-full ${heightClass} min-h-[280px] rounded-xl overflow-hidden border border-slate-200 bg-[#dbe6df]`
      }
    >
      {/* Isolated WebGL canvas container */}
      <div ref={mountRef} className="w-full h-full" aria-label="Interactive 3D Parcel Survey Scene" />

      {webglUnavailable && (
        <div className="absolute inset-0 flex items-center justify-center p-6 bg-[#EBF2EE] text-center">
          <div className="max-w-sm rounded-xl bg-white border border-slate-200 p-5 shadow-sm space-y-2">
            <div className="text-sm font-semibold text-[#111B21]">3D Survey View Unavailable</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              WebGL hardware acceleration is disabled or unsupported in this browser. Switch to Standard Map or Google Maps above to inspect parcel boundaries.
            </p>
            <div className="text-[11px] font-mono tabular-nums text-[#075E54] pt-1">
              {listing.locality} · {listing.area_acres} acres · {formatInrPrice(listing.price_inr)}
            </div>
          </div>
        </div>
      )}

      {/* Top minimal scene caption + Expand/Collapse toggle */}
      <div className="pointer-events-none absolute top-3 left-3 right-3 flex items-start justify-between gap-2">
        <div className="pointer-events-auto max-w-[calc(100%-7.25rem)] rounded-lg bg-[#0F172A]/88 text-white px-2.5 sm:px-3 py-1.5 text-xs shadow-sm border border-white/10">
          <div className="font-semibold truncate">
            {listing.locality} · {formatInrPrice(listing.price_inr)}
          </div>
          <div className="text-[11px] text-slate-300 font-mono tabular-nums truncate">
            {inspectedPart} · {listing.area_acres} ac
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="pointer-events-auto min-h-[44px] sm:min-h-[36px] px-3 py-1.5 rounded-lg bg-[#0F172A]/88 hover:bg-[#0F172A] text-white text-xs font-medium flex items-center gap-1.5 border border-white/10 whitespace-nowrap shrink-0"
          aria-label={expanded ? 'Exit 3D survey full view' : 'Expand 3D survey full view'}
        >
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          <span>{expanded ? 'Exit 3D' : 'Expand 3D'}</span>
        </button>
      </div>

      {/* Collapsible compact bottom camera dock (no backdrop-filter over WebGL) */}
      {!webglUnavailable && (
        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-center">
          {dockCollapsed ? (
            <button
              type="button"
              onClick={() => setDockCollapsed(false)}
              className="min-h-[40px] sm:min-h-[32px] px-3 py-1.5 rounded-lg bg-[#0F172A]/88 text-white text-xs font-medium border border-white/10 whitespace-nowrap"
            >
              Camera Presets
            </button>
          ) : (
            <div className="flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar max-w-full rounded-xl bg-[#0F172A]/88 px-2 sm:px-2.5 py-1.5 border border-white/10 text-xs">
              {(
                [
                  ['aerial', 'Aerial'],
                  ['corner', 'Corner'],
                  ['structure', 'Structure'],
                  ['frontage', 'Frontage'],
                ] as Array<[CameraPreset, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  className={`min-h-[36px] sm:min-h-[28px] px-2.5 py-1 rounded-md font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activePreset === key
                      ? 'bg-[#008069] text-white'
                      : 'text-slate-200 hover:bg-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => applyPreset('aerial')}
                className="min-h-[36px] sm:min-h-[28px] min-w-[36px] sm:min-w-[28px] px-2 py-1 rounded-md text-slate-300 hover:text-white flex items-center justify-center shrink-0"
                title="Reset camera"
                aria-label="Reset 3D camera"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setDockCollapsed(true)}
                className="min-h-[36px] sm:min-h-[28px] px-2 py-1 rounded-md text-slate-400 hover:text-white text-[11px] whitespace-nowrap shrink-0"
              >
                Hide
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
