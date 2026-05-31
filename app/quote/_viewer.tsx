"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { OcctMesh } from "./_occt";

export interface PartMetrics {
  /** Axis-aligned bounding box size, in the file's modeling units (mm). */
  size: { x: number; y: number; z: number };
  /** Net solid volume, in mm^3. */
  volume: number;
  /** Triangle count, for a sense of model fidelity. */
  triangles: number;
}

interface ViewerProps {
  meshes: OcctMesh[] | null;
  onMetrics: (metrics: PartMetrics) => void;
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Signed-tetrahedron sum over every triangle gives the enclosed solid volume.
function geometryVolume(geom: THREE.BufferGeometry): number {
  const pos = geom.getAttribute("position");
  const index = geom.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  const triangles = index ? index.count : pos.count;
  for (let i = 0; i < triangles; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    total += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(total);
}

function buildGeometry(mesh: OcctMesh): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3)
  );
  if (mesh.attributes.normal) {
    geom.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3)
    );
  }
  geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(mesh.index.array), 1));
  if (!mesh.attributes.normal) geom.computeVertexNormals();
  return geom;
}

function makeLabel(text: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = "dim-label";
  el.textContent = text;
  return new CSS2DObject(el);
}

export default function Viewer({ meshes, onMetrics }: ViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const controlsRef = useRef<OrbitControls>(null);
  const partRef = useRef<THREE.Group>(null);
  const onMetricsRef = useRef(onMetrics);
  onMetricsRef.current = onMetrics;

  // One-time scene / renderer setup.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      40,
      mount.clientWidth / mount.clientHeight,
      0.1,
      1e7
    );
    camera.position.set(1, 0.8, 1);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(mount.clientWidth, mount.clientHeight);
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.left = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    mount.appendChild(labelRenderer.domElement);

    // Studio reflections for a clean machined-metal read.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.4, 0.8);
    scene.add(key);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 0.6));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.9;
    controls.panSpeed = 0.8;
    controlsRef.current = controls;

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    tick();

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    };
  }, []);

  // Rebuild the part whenever new meshes arrive.
  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls || !meshes) return;

    if (partRef.current) {
      scene.remove(partRef.current);
      partRef.current.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
      });
    }

    const pivot = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: 0xc9ced6,
      metalness: 0.35,
      roughness: 0.42,
    });

    const box = new THREE.Box3();
    let volume = 0;
    let triangles = 0;

    for (const mesh of meshes) {
      const geom = buildGeometry(mesh);
      geom.computeBoundingBox();
      if (geom.boundingBox) box.union(geom.boundingBox);
      volume += geometryVolume(geom);
      triangles += (geom.getIndex()?.count ?? 0) / 3;

      pivot.add(new THREE.Mesh(geom, material));

      // Subtle feature edges read as a real CAD part, not a blob.
      const edges = new THREE.EdgesGeometry(geom, 24);
      const lines = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: 0x4a4f57,
          transparent: true,
          opacity: 0.28,
        })
      );
      pivot.add(lines);
    }

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // Bounding-box wireframe + per-axis dimension callouts.
    const boxGeom = new THREE.BoxGeometry(size.x, size.y, size.z);
    boxGeom.translate(center.x, center.y, center.z);
    const boxEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeom),
      new THREE.LineBasicMaterial({
        color: 0x0a84ff,
        transparent: true,
        opacity: 0.55,
      })
    );
    pivot.add(boxEdges);

    const xLabel = makeLabel(`${fmt(size.x)} mm`);
    xLabel.position.set(center.x, box.min.y, box.max.z);
    const yLabel = makeLabel(`${fmt(size.y)} mm`);
    yLabel.position.set(box.max.x, center.y, box.max.z);
    const zLabel = makeLabel(`${fmt(size.z)} mm`);
    zLabel.position.set(box.max.x, box.min.y, center.z);
    pivot.add(xLabel, yLabel, zLabel);

    // Center the assembly so orbit pivots around the part's middle.
    pivot.position.sub(center);
    scene.add(pivot);
    partRef.current = pivot;

    // Frame the camera to the bounding sphere.
    const radius = size.length() / 2 || 1;
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.4;
    const dir = new THREE.Vector3(0.8, 0.55, 1).normalize();
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    camera.position.copy(dir.multiplyScalar(dist));
    controls.target.set(0, 0, 0);
    controls.update();

    onMetricsRef.current({
      size: { x: size.x, y: size.y, z: size.z },
      volume,
      triangles: Math.round(triangles),
    });
  }, [meshes]);

  return <div ref={mountRef} className="viewer-mount" />;
}
