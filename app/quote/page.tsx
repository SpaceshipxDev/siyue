"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PartMetrics } from "./_viewer";
import type { OcctMesh } from "./_occt";
import { parseStep } from "./_occt";
import "./quote.css";

const Viewer = dynamic(() => import("./_viewer"), { ssr: false });

type Status = "idle" | "loading" | "ready" | "error";

const group = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 0 });
const dim = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function QuotePage() {
  const [meshes, setMeshes] = useState<OcctMesh[] | null>(null);
  const [metrics, setMetrics] = useState<PartMetrics | null>(null);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFile = useCallback(async (file: File) => {
    const ext = file.name.toLowerCase().split(".").pop();
    if (ext !== "step" && ext !== "stp") {
      setStatus("error");
      setError("这不是 STEP 文件，请拖入 .step 或 .stp 文件。");
      return;
    }
    setStatus("loading");
    setError("");
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseStep(buffer);
      setMeshes(parsed);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "文件读取失败。");
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

  const onMetrics = useCallback((m: PartMetrics) => setMetrics(m), []);

  return (
    <div
      className="stage"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Viewer meshes={meshes} onMetrics={onMetrics} />

      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          STEP&nbsp;模型检视
        </div>
        <button className="open-btn" onClick={() => inputRef.current?.click()}>
          {status === "ready" ? "打开其他文件" : "打开文件"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".step,.stp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = "";
          }}
        />
      </header>

      {status === "idle" && (
        <div className="hero">
          <h1>拖入 STEP 文件</h1>
          <p>三维查看 · 读取净尺寸 · 计算体积（mm³）</p>
        </div>
      )}

      {status === "loading" && (
        <div className="hero">
          <div className="spinner" />
          <p className="loading-name">{fileName}</p>
        </div>
      )}

      {status === "error" && (
        <div className="hero">
          <h1 className="error-title">无法读取该文件</h1>
          <p>{error}</p>
        </div>
      )}

      {status === "ready" && metrics && (
        <section className="panel">
          <div className="panel-name" title={fileName}>
            {fileName}
          </div>

          <div className="metric-block">
            <span className="metric-label">净外形尺寸</span>
            <div className="bbox">
              <Axis tag="X" value={dim(metrics.size.x)} />
              <span className="mul">×</span>
              <Axis tag="Y" value={dim(metrics.size.y)} />
              <span className="mul">×</span>
              <Axis tag="Z" value={dim(metrics.size.z)} />
              <span className="unit">mm</span>
            </div>
          </div>

          <div className="metric-block">
            <span className="metric-label">体积</span>
            <div className="volume">
              {group(metrics.volume)}
              <span className="unit">
                mm<sup>3</sup>
              </span>
            </div>
            <span className="volume-sub">
              {group(metrics.volume / 1000)} cm³
            </span>
          </div>

          <div className="panel-foot">
            {metrics.triangles.toLocaleString("en-US")} 个三角面 · 拖动旋转
          </div>
        </section>
      )}

      {dragging && <div className="drop-veil">松开以载入</div>}
    </div>
  );
}

function Axis({ tag, value }: { tag: string; value: string }) {
  return (
    <span className="axis">
      <span className="axis-tag">{tag}</span>
      {value}
    </span>
  );
}
