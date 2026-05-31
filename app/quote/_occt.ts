"use client";

// Thin wrapper around occt-import-js (OpenCascade compiled to WASM).
// The engine is loaded once as a <script> from /public so the Turbopack
// bundler never tries to resolve its node-only `require("fs")` branch.

export interface OcctMesh {
  name?: string;
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
}

let enginePromise: Promise<OcctEngine> | null = null;

interface OcctEngine {
  ReadStepFile: (
    buffer: Uint8Array,
    params: unknown
  ) => { success: boolean; meshes: OcctMesh[] };
}

function loadEngineScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector("script[data-occt]")) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.occt = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load the STEP engine."));
    document.head.appendChild(script);
  });
}

async function getEngine(): Promise<OcctEngine> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    await loadEngineScript("/occt-import-js.js");
    const factory = (window as unknown as {
      occtimportjs?: (opts: { locateFile: () => string }) => Promise<OcctEngine>;
    }).occtimportjs;
    if (!factory) throw new Error("The STEP engine is unavailable.");
    return factory({ locateFile: () => "/occt-import-js.wasm" });
  })();
  return enginePromise;
}

export async function parseStep(buffer: ArrayBuffer): Promise<OcctMesh[]> {
  const engine = await getEngine();
  const result = engine.ReadStepFile(new Uint8Array(buffer), null);
  if (!result || !result.success || !result.meshes?.length) {
    throw new Error("Could not read any solids from this STEP file.");
  }
  return result.meshes;
}
