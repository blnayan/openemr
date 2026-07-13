/**
 * DocumentCitationModal — opens when a user clicks a `Lab · …` /
 * `Intake · …` chip beneath a Co-Pilot answer. Renders the source
 * PDF/image inline and overlays the bbox of the cited field.
 *
 * Page bytes are fetched from OpenEMR's canonical document-retrieval
 * endpoint (`controller.php?document&retrieve&...`) — same URL pattern
 * the AgentForge inbox already uses (DocumentInboxController.php:660).
 *
 * PDFs are rendered through PDF.js loaded from the same CDN version
 * as the inbox (5.7.x); images are rendered with a native `<img>`. The
 * bbox is given in the original VLM/OCR rendered-image space, so we
 * scale by the actual rendered size / image_w-h to plant the overlay
 * correctly at any zoom.
 */

import { useEffect, useRef, useState } from 'react';

import type { CitationBbox } from './answerSchema';

const PDFJS_VERSION = '5.7.284';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const PDFJS_SRC = `${PDFJS_BASE}/build/pdf.mjs`;
const PDFJS_WORKER = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;

interface DocumentCitationModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly pid: string;
  readonly webroot: string;
  readonly documentId: number;
  readonly documentName: string | null;
  readonly docKind: 'lab' | 'intake';
  /** Null when the chip is a chart-row attribution and carries no bbox. */
  readonly bbox: CitationBbox | null;
}

interface PdfPageViewport {
  readonly width: number;
  readonly height: number;
}

interface PdfPage {
  getViewport(opts: { scale: number }): PdfPageViewport;
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfPageViewport }): {
    promise: Promise<void>;
  };
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: { data: ArrayBuffer; useSystemFonts: false }): { promise: Promise<PdfDocument> };
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'pdf'; doc: PdfDocument }
  | { kind: 'image'; src: string; naturalSize: { w: number; h: number } | null }
  | { kind: 'error'; reason: string };

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;
function loadPdfJs(): Promise<PdfJsModule> {
  // Dynamic-import the ESM bundle from the CDN once per page lifetime.
  // The inbox does the same and the CDN is already pre-warmed.
  if (pdfjsModulePromise === null) {
    pdfjsModulePromise = (import(/* @vite-ignore */ PDFJS_SRC) as Promise<PdfJsModule>).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return mod;
    });
  }
  return pdfjsModulePromise;
}

export function DocumentCitationModal({
  open,
  onClose,
  pid,
  webroot,
  documentId,
  documentName,
  docKind,
  bbox,
}: DocumentCitationModalProps) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [renderedSize, setRenderedSize] = useState<{ w: number; h: number } | null>(null);

  // Fetch + classify the document bytes when the modal opens.
  useEffect(() => {
    if (!open) {
      setState({ kind: 'idle' });
      setRenderedSize(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setState({ kind: 'loading' });
      const url = `${webroot}/controller.php?document&retrieve&patient_id=${encodeURIComponent(pid)}&document_id=${documentId}&as_file=true`;
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const contentType = (res.headers.get('Content-Type') ?? '').toLowerCase();
        if (contentType.includes('pdf')) {
          const buffer = await res.arrayBuffer();
          if (cancelled) return;
          const pdfjs = await loadPdfJs();
          if (cancelled) return;
          const doc = await pdfjs.getDocument({ data: buffer, useSystemFonts: false }).promise;
          if (cancelled) return;
          setState({ kind: 'pdf', doc });
        } else if (contentType.startsWith('image/')) {
          const blob = await res.blob();
          if (cancelled) return;
          const src = URL.createObjectURL(blob);
          setState({ kind: 'image', src, naturalSize: null });
        } else {
          // Best-effort: try to treat as PDF first, then fall back.
          const buffer = await res.arrayBuffer();
          if (cancelled) return;
          try {
            const pdfjs = await loadPdfJs();
            const doc = await pdfjs.getDocument({ data: buffer, useSystemFonts: false }).promise;
            if (cancelled) return;
            setState({ kind: 'pdf', doc });
          } catch {
            const blob = new Blob([buffer]);
            const src = URL.createObjectURL(blob);
            setState({ kind: 'image', src, naturalSize: null });
          }
        }
      } catch (err) {
        if (cancelled) return;
        setState({ kind: 'error', reason: err instanceof Error ? err.message : 'unknown' });
      }
    })();

    return () => { cancelled = true; };
  }, [open, pid, webroot, documentId]);

  // Render the cited PDF page into the canvas.
  useEffect(() => {
    if (state.kind !== 'pdf') return;
    const targetPage = (bbox?.page ?? 0) + 1; // bbox.page is 0-indexed; PDF.js is 1-indexed.
    const pageNum = Math.min(Math.max(targetPage, 1), state.doc.numPages);
    let cancelled = false;
    (async () => {
      const page = await state.doc.getPage(pageNum);
      if (cancelled) return;
      const desiredWidth = 800;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = desiredWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled) return;
      setRenderedSize({ w: viewport.width, h: viewport.height });
    })();
    return () => { cancelled = true; };
  }, [state, bbox?.page]);

  // Capture image natural size for bbox scaling.
  function handleImageLoad() {
    const img = imageRef.current;
    if (img === null) return;
    setRenderedSize({ w: img.clientWidth, h: img.clientHeight });
  }

  // Compute the overlay rectangle in CSS pixels (scaled from VLM image
  // space to the rendered surface).
  let overlay: { left: number; top: number; width: number; height: number } | null = null;
  if (bbox && renderedSize !== null) {
    const sx = renderedSize.w / bbox.image_w;
    const sy = renderedSize.h / bbox.image_h;
    overlay = {
      left: bbox.x * sx,
      top: bbox.y * sy,
      width: bbox.w * sx,
      height: bbox.h * sy,
    };
  }

  if (!open) return null;

  const titleLabel = documentName ?? (docKind === 'lab' ? 'Lab document' : 'Intake form');
  const pageLabel = bbox ? ` · page ${bbox.page + 1}` : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${titleLabel}${pageLabel}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      data-testid="document-citation-modal"
    >
      <div
        className="relative max-h-[92vh] max-w-[92vw] overflow-auto rounded-4 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border-soft bg-white/95 px-4 py-2 text-sm font-medium text-ink backdrop-blur">
          <span className="truncate">
            {titleLabel}
            {pageLabel}
            <span className="ml-2 text-ink-muted">#{documentId}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-3 px-2 py-1 text-xs font-medium text-ink-muted hover:bg-bg-rail hover:text-ink"
            aria-label="Close"
            data-testid="document-citation-modal-close"
          >
            Close
          </button>
        </div>

        <div className="relative p-4">
          {state.kind === 'loading' && (
            <div className="flex h-64 w-[800px] items-center justify-center text-ink-muted">
              Loading document…
            </div>
          )}
          {state.kind === 'error' && (
            <div className="flex h-64 w-[800px] items-center justify-center text-severe">
              Could not load document ({state.reason}).
            </div>
          )}
          {state.kind === 'pdf' && (
            <div className="relative inline-block">
              <canvas ref={canvasRef} className="block" />
              {overlay && (
                <div
                  className="pointer-events-none absolute rounded-2 border-2 border-amber-500 bg-amber-300/30"
                  style={overlay}
                  data-testid="document-citation-bbox"
                />
              )}
            </div>
          )}
          {state.kind === 'image' && (
            <div className="relative inline-block">
              <img
                ref={imageRef}
                src={state.src}
                alt={titleLabel}
                onLoad={handleImageLoad}
                className="block max-w-[800px]"
              />
              {overlay && (
                <div
                  className="pointer-events-none absolute rounded-2 border-2 border-amber-500 bg-amber-300/30"
                  style={overlay}
                  data-testid="document-citation-bbox"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
