"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadModel, modelStats } from "@/lib/models";

type Stats = ReturnType<typeof modelStats>;
type Axis = "x" | "y" | "z";

/** 部品（名前やレイヤーごとにまとめた表示単位） */
type Part = {
  key: string;
  objects: THREE.Object3D[];
  visible: boolean;
  color: string;
};

const asArray = <T,>(v: T | T[]) => (Array.isArray(v) ? v : [v]);

function isDrawable(o: THREE.Object3D) {
  return (o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((o) => {
    if (!isDrawable(o)) return;
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    for (const m of asArray(mesh.material)) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

/** 名前（Rhino はレイヤー名）ごとに部品をまとめる */
function collectParts(object: THREE.Object3D): Part[] {
  const byKey = new Map<string, THREE.Object3D[]>();
  object.traverse((o) => {
    if (!isDrawable(o)) return;
    const key = (o.userData.partName as string) || o.name || o.parent?.name || "名前なし";
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(o);
  });
  return [...byKey].map(([key, objects], i) => ({
    key,
    objects,
    visible: objects.some((o) => o.visible),
    color: `#${new THREE.Color().setHSL((i * 0.618) % 1, 0.6, 0.55).getHexString()}`,
  }));
}

/**
 * モデルを原点付近に移す。
 * 座標が原点から遠いモデル（CAD データなど）を object.position でずらすだけだと、
 * GPU の計算精度が足りずに回転中に形が震えるので、その場合は頂点座標そのものを書き換える。
 */
function recenter(object: THREE.Object3D, offset: THREE.Vector3, radius: number): THREE.Object3D {
  if (offset.length() < radius * 10) {
    object.position.sub(offset);
    return object;
  }
  object.updateMatrixWorld(true);
  const shift = new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z);
  const drawables: THREE.Object3D[] = [];
  object.traverse((o) => {
    if (isDrawable(o) && !(o as THREE.SkinnedMesh).isSkinnedMesh) drawables.push(o);
  });
  const flat = new THREE.Group();
  const oldGeometries = new Set<THREE.BufferGeometry>();
  for (const o of drawables) {
    const mesh = o as THREE.Mesh;
    // 部品一覧で使う名前を、親から外す前に控えておく
    o.userData.partName ||= o.name || o.parent?.name || "";
    const shown = isShown(o);
    oldGeometries.add(mesh.geometry);
    mesh.geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(shift, o.matrixWorld));
    o.removeFromParent();
    o.position.set(0, 0, 0);
    o.quaternion.identity();
    o.scale.set(1, 1, 1);
    o.visible = shown;
    flat.add(o);
  }
  for (const g of oldGeometries) g.dispose();
  return flat;
}

/** 親も含めて表示されているか */
function isShown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
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
    overlay: THREE.Group;
    current: THREE.Object3D | null;
    box: THREE.Box3;
    radius: number;
  } | null>(null);
  // 断面用の平面（全マテリアルで共有し、値だけ書き換える）
  const clipPlane = useRef(new THREE.Plane());
  // 色分け中に退避している元のマテリアル
  const originals = useRef(new Map<THREE.Mesh, THREE.Material | THREE.Material[]>());

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [showParts, setShowParts] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [colorize, setColorize] = useState(false);
  const [clip, setClip] = useState<{ on: boolean; axis: Axis; pos: number; flip: boolean }>({
    on: false,
    axis: "x",
    pos: 50,
    flip: false,
  });
  const [measuring, setMeasuring] = useState(false);
  const [measurePts, setMeasurePts] = useState<THREE.Vector3[]>([]);

  // レンダラーの初期化（1回だけ）
  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
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
    const overlay = new THREE.Group();
    overlay.renderOrder = 999;
    scene.add(overlay);

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

    ctx.current = { scene, camera, controls, grid, overlay, current: null, box: new THREE.Box3(), radius: 1 };
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
      restoreMaterials();
      c.scene.remove(c.current);
      disposeObject(c.current);
      c.current = null;
    }
    setStats(null);
    setParts([]);
    setMeasurePts([]);
    setColorize(false);
    setError("");
    if (!path) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let disposeUrls = () => {};
    setStatus("loading");
    loadModel(path, files)
      .then(({ object: loaded, dispose }) => {
        disposeUrls = dispose;
        if (cancelled) {
          disposeObject(loaded);
          return;
        }
        // 原点に置き、床に接地させてカメラを合わせる
        const box = new THREE.Box3().setFromObject(loaded);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.length() / 2, 1e-6);
        const object = recenter(loaded, new THREE.Vector3(center.x, box.min.y, center.z), radius);

        // 床のグリッドは、モデルの底面とちらつかないよう少しだけ下げる
        c.grid.position.y = -radius * 0.002;

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
        c.box = new THREE.Box3().setFromObject(object);
        c.radius = radius;
        setStats(modelStats(object));
        setParts(collectParts(object));
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

  function restoreMaterials() {
    for (const [mesh, mat] of originals.current) {
      for (const m of asArray(mesh.material)) m.dispose();
      mesh.material = mat;
    }
    originals.current.clear();
  }

  // 色分け: 部品ごとに別の色の材質に差し替える（元の材質は退避して、解除時に戻す）
  useEffect(() => {
    restoreMaterials();
    if (!colorize) return;
    for (const part of parts) {
      for (const o of part.objects) {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) continue;
        originals.current.set(mesh, mesh.material);
        mesh.material = new THREE.MeshStandardMaterial({
          color: part.color,
          roughness: 0.6,
          metalness: 0.05,
          side: THREE.DoubleSide,
        });
      }
    }
  }, [colorize, parts]);

  // ワイヤーフレームと断面を全マテリアルに反映
  useEffect(() => {
    const c = ctx.current;
    if (!c?.current) return;
    const planes = clip.on ? [clipPlane.current] : [];
    c.current.traverse((o) => {
      if (!isDrawable(o)) return;
      for (const m of asArray((o as THREE.Mesh).material)) {
        if ("wireframe" in m) (m as THREE.MeshStandardMaterial).wireframe = wireframe;
        m.clippingPlanes = planes;
        m.needsUpdate = true;
      }
    });
  }, [wireframe, clip.on, colorize, parts]);

  // 断面の位置
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const i = { x: 0, y: 1, z: 2 }[clip.axis];
    const min = c.box.min.getComponent(i);
    const max = c.box.max.getComponent(i);
    const v = min + ((max - min) * clip.pos) / 100;
    const n = new THREE.Vector3().setComponent(i, clip.flip ? 1 : -1);
    // 少しだけ余裕を持たせて、端（0% / 100%）では全体が見えるようにする
    const eps = (max - min) * 1e-4;
    clipPlane.current.set(n, clip.flip ? -v + eps : v + eps);
  }, [clip, stats]);

  // 計測の点と線を描く
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    for (const o of [...c.overlay.children]) {
      c.overlay.remove(o);
      disposeObject(o);
    }
    const mat = { color: 0xff3b30, depthTest: false, transparent: true };
    for (const p of measurePts) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(c.radius * 0.012, 16, 12), new THREE.MeshBasicMaterial(mat));
      dot.position.copy(p);
      c.overlay.add(dot);
    }
    if (measurePts.length === 2) {
      c.overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(measurePts), new THREE.LineBasicMaterial(mat)));
    }
  }, [measurePts]);

  // 計測モード: クリック（ドラッグではない）した位置をモデル表面から拾う
  useEffect(() => {
    const c = ctx.current;
    const el = mountRef.current;
    if (!measuring || !c || !el) return;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !c.current) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, c.camera);
      const hit = ray
        .intersectObject(c.current, true)
        .find(
          (h) =>
            (h.object as THREE.Mesh).isMesh &&
            isShown(h.object) &&
            (!clip.on || clipPlane.current.distanceToPoint(h.point) >= 0),
        );
      if (!hit) return;
      setMeasurePts((prev) => (prev.length >= 2 ? [hit.point.clone()] : [...prev, hit.point.clone()]));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [measuring, clip.on]);

  const setPartVisible = (keys: Set<string> | "all", visible: boolean) => {
    setParts((prev) =>
      prev.map((p) => {
        const v = keys === "all" || keys.has(p.key) ? visible : p.visible;
        for (const o of p.objects) o.visible = v;
        return { ...p, visible: v };
      }),
    );
  };
  const soloPart = (key: string) => {
    setParts((prev) =>
      prev.map((p) => {
        const v = p.key === key;
        for (const o of p.objects) o.visible = v;
        return { ...p, visible: v };
      }),
    );
  };

  const distance = measurePts.length === 2 ? measurePts[0].distanceTo(measurePts[1]) : null;
  const ready = !!stats;

  return (
    <div className="viewer">
      <div ref={mountRef} className={`viewer-canvas ${measuring ? "measuring" : ""}`} />
      {!path && <div className="viewer-overlay">ファイルを選択するとプレビューします</div>}
      {status === "loading" && <div className="viewer-overlay">読み込み中…</div>}
      {status === "error" && <div className="viewer-overlay error">表示できません: {error}</div>}

      {ready && (
        <div className="viewer-tools">
          <button className={showParts ? "on" : ""} onClick={() => setShowParts((v) => !v)} disabled={parts.length < 2}
            title={parts.length < 2 ? "部品が1つだけのモデルです" : "部品ごとに表示・非表示"}>
            部品 {parts.length > 1 && `(${parts.length})`}
          </button>
          <button className={colorize ? "on" : ""} onClick={() => setColorize((v) => !v)} title="部品ごとに色を分けて表示">
            色分け
          </button>
          <button className={clip.on ? "on" : ""} onClick={() => setClip((v) => ({ ...v, on: !v.on }))} title="切断面で中を見る">
            断面
          </button>
          <button
            className={measuring ? "on" : ""}
            onClick={() => {
              setMeasuring((v) => !v);
              setMeasurePts([]);
            }}
            title="モデル上の2点をクリックして距離を測る"
          >
            計測
          </button>
          <button className={wireframe ? "on" : ""} onClick={() => setWireframe((v) => !v)}>
            ワイヤー
          </button>
        </div>
      )}

      {ready && showParts && parts.length > 1 && (
        <div className="parts-panel">
          <div className="parts-head">
            <button className="link" onClick={() => setPartVisible("all", true)}>すべて表示</button>
            <button className="link" onClick={() => setPartVisible("all", false)}>すべて隠す</button>
          </div>
          <ul>
            {parts.map((p) => (
              <li key={p.key}>
                <label title={p.key}>
                  <input type="checkbox" checked={p.visible} onChange={(e) => setPartVisible(new Set([p.key]), e.target.checked)} />
                  {colorize && <span className="swatch" style={{ background: p.color }} />}
                  <span className="part-name">{p.key}</span>
                </label>
                <button className="link small" onClick={() => soloPart(p.key)} title="この部品だけ表示">のみ</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {ready && (
        <div className="viewer-bar">
          {clip.on && (
            <span className="clip-controls">
              断面
              {(["x", "y", "z"] as Axis[]).map((a) => (
                <button key={a} className={clip.axis === a ? "on" : ""} onClick={() => setClip((v) => ({ ...v, axis: a }))}>
                  {a.toUpperCase()}
                </button>
              ))}
              <input type="range" min={0} max={100} step={0.5} value={clip.pos}
                onChange={(e) => setClip((v) => ({ ...v, pos: Number(e.target.value) }))} />
              <label>
                <input type="checkbox" checked={clip.flip} onChange={(e) => setClip((v) => ({ ...v, flip: e.target.checked }))} />
                反対側
              </label>
            </span>
          )}
          {measuring && (
            <span className="measure">
              {distance !== null
                ? `距離 ${distance.toPrecision(4)}（ファイルの単位）`
                : measurePts.length === 1
                  ? "2点目をクリック"
                  : "モデル上の1点目をクリック"}
            </span>
          )}
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
