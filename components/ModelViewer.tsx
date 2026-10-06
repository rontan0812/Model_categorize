"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadModel, modelStats } from "@/lib/models";

type Stats = ReturnType<typeof modelStats>;

function disposeObject(object: THREE.Object3D) {
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

export default function ModelViewer({
  path,
  files,
}: {
  path: string | null;
  files: Map<string, File>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    grid: THREE.GridHelper;
    current: THREE.Object3D | null;
  } | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [wireframe, setWireframe] = useState(false);

  // レンダラーの初期化（1回だけ）
  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(2, 1.5, 2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2));
    const dir = new THREE.DirectionalLight(0xffffff, 2);
    dir.position.set(3, 5, 4);
    camera.add(dir);
    scene.add(camera);
    const grid = new THREE.GridHelper(2, 20, 0x888888, 0x555555);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    scene.add(grid);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    ctx.current = { scene, camera, controls, grid, current: null };
    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      if (ctx.current?.current) disposeObject(ctx.current.current);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  // モデルの切り替え
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.current) {
      c.scene.remove(c.current);
      disposeObject(c.current);
      c.current = null;
    }
    setStats(null);
    setError("");
    if (!path) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let disposeUrls = () => {};
    setStatus("loading");
    loadModel(path, files)
      .then(({ object, dispose }) => {
        disposeUrls = dispose;
        if (cancelled) {
          disposeObject(object);
          return;
        }
        // 原点に置き、床に接地させてカメラを合わせる
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
        const radius = Math.max(size.length() / 2, 1e-6);

        c.grid.scale.setScalar(radius * 1.5);
        c.camera.near = radius / 100;
        c.camera.far = radius * 100;
        c.camera.updateProjectionMatrix();
        const dist = (radius / Math.sin(THREE.MathUtils.degToRad(c.camera.fov / 2))) * 1.3;
        c.camera.position.set(dist * 0.6, dist * 0.45 + size.y / 2, dist * 0.6);
        c.controls.target.set(0, size.y / 2, 0);
        c.controls.update();

        c.scene.add(object);
        c.current = object;
        setStats(modelStats(object));
        setStatus("idle");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    return () => {
      cancelled = true;
      disposeUrls();
    };
  }, [path, files]);

  // ワイヤーフレーム表示
  useEffect(() => {
    ctx.current?.current?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) if ("wireframe" in m) (m as THREE.MeshStandardMaterial).wireframe = wireframe;
    });
  }, [wireframe, stats]);

  return (
    <div className="viewer">
      <div ref={mountRef} className="viewer-canvas" />
      {!path && <div className="viewer-overlay">ファイルを選択するとプレビューします</div>}
      {status === "loading" && <div className="viewer-overlay">読み込み中…</div>}
      {status === "error" && <div className="viewer-overlay error">表示できません: {error}</div>}
      {path && (
        <div className="viewer-bar">
          <label>
            <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
            ワイヤーフレーム
          </label>
          {stats && (
            <span className="muted">
              頂点 {stats.vertices.toLocaleString()} / ポリゴン {stats.triangles.toLocaleString()} / サイズ{" "}
              {[stats.size.x, stats.size.y, stats.size.z].map((v) => v.toPrecision(3)).join(" × ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
