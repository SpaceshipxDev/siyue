"use client";

import { DragEvent, useEffect, useRef, useState } from "react";

type MatchedDocument = {
  id: string;
  label: string;
  asset: string;
  thumbnail: string;
};

type MatchResult = {
  decision: "match" | "ambiguous" | "no_match";
  best?: {
    page_id: string;
    component_id: string;
    score: number;
    cosine: number;
    inliers: number;
    inlier_ratio: number;
    coverage: number;
  } | null;
  latency_ms: number;
  via?: string;
  stages?: { embed_ms?: number; shortlist_ms?: number; verify_ms?: number };
  matchedDocument?: MatchedDocument | null;
};

type LabStatus = {
  matcher: { online: boolean; stats?: { bank_size?: number } | null };
  manifest: { referenceCount: number };
};

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const apiPath = `${basePath}/api/matcher-lab`;

function assetUrl(asset: string) {
  return `${apiPath}?asset=${encodeURIComponent(asset)}`;
}

function displayId(value?: string | null) {
  return value?.replace("matcher-lab:", "") || "Unknown";
}

export function MatcherLab({ userName }: { userName: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<MatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(apiPath, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Matcher status failed");
        setStatus(payload);
      })
      .catch((reason) => setError(reason.message));
  }, []);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function chooseFile(next: File | null) {
    if (!next) return;
    if (!next.type.startsWith("image/")) {
      setError("Choose a JPG, PNG, HEIC, or other image file.");
      return;
    }
    if (next.size > 30 * 1024 * 1024) {
      setError("The image must be smaller than 30 MB.");
      return;
    }
    setFile(next);
    setPreview(URL.createObjectURL(next));
    setResult(null);
    setError("");
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0] || null);
  }

  async function runMatch() {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body = new FormData();
      body.set("image", file);
      const response = await fetch(apiPath, { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Matching failed");
      setResult(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Matching failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setPreview("");
    setResult(null);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  const online = status?.matcher.online ?? false;
  const bankSize = status?.matcher.stats?.bank_size ?? status?.manifest.referenceCount ?? 0;
  const matched = result?.decision === "match";
  const fast = result ? result.latency_ms <= 1000 : false;
  const reference = result?.matchedDocument;

  return (
    <main className="match-page">
      <header className="match-nav">
        <a href={`${basePath}/backend`}>YINGMA / DOCUMENT MATCH</a>
        <div>
          <span className={`match-live ${online ? "is-online" : ""}`} />
          {status ? `${online ? "ONLINE" : "OFFLINE"} · ${bankSize} ENROLLED` : "CONNECTING"}
          <span className="match-user">{userName}</span>
        </div>
      </header>

      <section className="match-intro">
        <p>UPLOAD / MATCH / RESULT</p>
        <h1>Does this document<br />match anything?</h1>
        <span>Upload one camera photo. The document may be angled, zoomed, rotated, or partly cropped.</span>
      </section>

      <section className="match-workspace">
        <div className="match-input-column">
          <div className="match-step"><span>01</span><strong>Query image</strong></div>
          {!file ? (
            <div
              className={`match-dropzone ${dragging ? "is-dragging" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => chooseFile(event.target.files?.[0] || null)}
              />
              <div className="match-upload-mark"><span /><span /></div>
              <strong>Drop a document photo here</strong>
              <span>or click to choose from your device</span>
              <small>JPG, PNG, HEIC · maximum 30 MB</small>
            </div>
          ) : (
            <div className="match-query-preview">
              <img src={preview} alt={`Uploaded document ${file.name}`} />
              <div>
                <span>{file.name}</span>
                <small>{(file.size / 1024 / 1024).toFixed(2)} MB</small>
                <button type="button" onClick={reset}>Choose another</button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="match-run"
            onClick={runMatch}
            disabled={!file || busy || !online}
          >
            {busy ? <><span className="match-progress" />Matching document…</> : "Run match"}
          </button>
          {!online && status && <p className="match-inline-error">Matcher service is offline on port 8788.</p>}
          {error && <p className="match-inline-error" role="alert">{error}</p>}
        </div>

        <div className="match-output-column">
          <div className="match-step"><span>02</span><strong>Match result</strong></div>
          {!result && !busy && (
            <div className="match-empty-result">
              <span>NO QUERY RUN</span>
              <p>Your matched reference and measured latency will appear here.</p>
            </div>
          )}
          {busy && (
            <div className="match-analyzing" aria-busy="true">
              <div className="match-scan"><span /></div>
              <strong>Comparing against {bankSize} references</strong>
              <span>Embedding, shortlist, geometric verification</span>
            </div>
          )}
          {result && (
            <article className={`match-result ${matched ? "is-match" : "is-no-match"}`}>
              <div className="match-verdict">
                <span>{matched ? "MATCH FOUND" : result.decision === "ambiguous" ? "AMBIGUOUS" : "NO CONFIDENT MATCH"}</span>
                <strong>{matched ? (reference?.label || displayId(result.best?.component_id)) : "Not matched"}</strong>
                <p>{matched ? `Reference ID: ${displayId(result.best?.component_id)}` : "The best candidate did not pass the acceptance threshold."}</p>
              </div>

              {matched && reference && (
                <figure className="match-reference">
                  <figcaption>Matched reference</figcaption>
                  <img src={assetUrl(reference.asset)} alt={`Matched reference ${reference.label}`} />
                </figure>
              )}

              <dl className="match-facts">
                <div className={fast ? "is-fast" : "is-slow"}>
                  <dt>Total latency</dt>
                  <dd>{result.latency_ms.toFixed(0)} ms</dd>
                  <small>{fast ? "UNDER 1 SECOND" : "OVER 1 SECOND"}</small>
                </div>
                <div>
                  <dt>Visual similarity</dt>
                  <dd>{result.best ? `${(result.best.cosine * 100).toFixed(1)}%` : "—"}</dd>
                  <small>{result.via || "LOCAL"}</small>
                </div>
                <div>
                  <dt>Geometry</dt>
                  <dd>{result.best?.inliers ?? "—"}</dd>
                  <small>INLIERS</small>
                </div>
              </dl>

              {result.stages && (
                <div className="match-stages">
                  <span>Prepare + network <strong>{Math.max(0, result.latency_ms - (result.stages.embed_ms || 0) - (result.stages.shortlist_ms || 0) - (result.stages.verify_ms || 0)).toFixed(0)} ms</strong></span>
                  <span>Embedding <strong>{(result.stages.embed_ms || 0).toFixed(0)} ms</strong></span>
                  <span>Verification <strong>{(result.stages.verify_ms || 0).toFixed(0)} ms</strong></span>
                </div>
              )}
              <button type="button" className="match-again" onClick={reset}>Test another image</button>
            </article>
          )}
        </div>
      </section>

      <footer className="match-footer">
        <span>REALISTIC TEST PROFILE</span>
        <p>Clear handheld captures · angle · zoom · rotation · partial crop</p>
        <strong>TARGET ≤ 1,000 MS</strong>
      </footer>
    </main>
  );
}
