/**
 * AgentForge Document Viewer — browser-side viewer components.
 *
 * Provides two viewer implementations sharing a common surface contract,
 * and a BboxOverlay layer that positions absolutely-positioned citation
 * overlay divs on top of either viewer.
 *
 * Exports (via AgentForge.viewer namespace on window):
 *   PdfPageViewer   — renders a single PDF page onto a <canvas> via PDF.js
 *                     (useSystemFonts:false for parity with server renderer).
 *   ImageViewer     — renders the original document bytes via a native <img>.
 *   BboxOverlay     — draws overlay <div>s scaled by image_w/image_h.
 *
 * Coordinate contract:
 *   displayedScale = canvasWidth / bbox.image_w
 *   overlay.(left, top, width, height) = bbox.(x, y, w, h) × displayedScale
 *   Clamped to [0, canvasWidth] × [0, canvasHeight] to absorb rounding.
 *
 * PHI posture (PRD §"Cache and PHI posture"):
 *   Labels and field paths live only in component state (JS variables).
 *   No data-* attributes are written to the DOM — the overlay div carries
 *   only a numeric index that the component uses to look up the record
 *   from the in-memory array.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

(function (global) {
  'use strict';

  // -------------------------------------------------------------------------
  // BboxOverlay scaling math (mirrors agent/src/viewer/BboxOverlay.ts)
  // -------------------------------------------------------------------------

  /**
   * Compute the CSS-pixel rectangle for a single bbox record given the
   * rendered canvas / image dimensions.
   *
   * @param {Object} bbox        - { x, y, w, h, image_w, image_h }
   * @param {number} canvasWidth  - CSS pixels
   * @param {number} canvasHeight - CSS pixels
   * @returns {{ left, top, width, height } | null}
   */
  // Visual breathing room around each overlay rectangle, in CSS pixels.
  // Tight VLM bboxes hug the printed value; a few pixels of padding keep
  // the rectangle from running through the glyphs themselves.
  var BBOX_PADDING_PX = 2;

  function computeOverlayRect(bbox, canvasWidth, canvasHeight) {
    if (!bbox || bbox.image_w <= 0 || bbox.image_h <= 0) return null;
    if (bbox.w <= 0 || bbox.h <= 0) return null;
    if (canvasWidth <= 0 || canvasHeight <= 0) return null;

    // Independent x/y scales so the overlay handles aspect-mismatched
    // bbox grids (Gemini-3 emits 0-1000 normalized for BOTH axes; the
    // schema preprocess sets image_h := image_w so canvasHeight/image_h
    // gives the correct vertical fraction here).
    var scaleX = canvasWidth  / bbox.image_w;
    var scaleY = canvasHeight / bbox.image_h;
    var rawLeft   = bbox.x * scaleX - BBOX_PADDING_PX;
    var rawTop    = bbox.y * scaleY - BBOX_PADDING_PX;
    var rawRight  = (bbox.x + bbox.w) * scaleX + BBOX_PADDING_PX;
    var rawBottom = (bbox.y + bbox.h) * scaleY + BBOX_PADDING_PX;

    var left   = Math.max(0, rawLeft);
    var top    = Math.max(0, rawTop);
    var right  = Math.min(canvasWidth, rawRight);
    var bottom = Math.min(canvasHeight, rawBottom);

    var width  = right - left;
    var height = bottom - top;

    if (width <= 0 || height <= 0) return null;

    return { left: left, top: top, width: width, height: height };
  }

  // -------------------------------------------------------------------------
  // BboxOverlay — manages a set of overlay divs on top of a viewer
  // -------------------------------------------------------------------------

  /**
   * BboxOverlay manages overlay <div>s positioned on top of a viewer.
   *
   * @param {HTMLElement} container  - The relative-positioned wrapper element.
   * @param {Array}       records    - Array of { bbox, fieldPath, label }.
   * @param {Function}    [onFlash]  - Optional callback(fieldPath) triggered
   *                                   when an overlay is flash-highlighted.
   */
  function BboxOverlay(container, records, onFlash) {
    this._container = container;
    this._records   = records || [];
    this._onFlash   = onFlash || null;
    this._divs      = [];
    this._tooltip   = null;
    this._canvasW   = 0;
    this._canvasH   = 0;
  }

  /**
   * (Re-)render all overlay divs for the current page.
   *
   * @param {number} pageIndex   - 0-based page index being displayed.
   * @param {number} canvasWidth - Current rendered width of the canvas/img.
   * @param {number} canvasHeight - Current rendered height.
   * @param {number} pageCount   - Number of pages the agent processed
   *                               (source_citation.page_count). Pages at
   *                               or beyond this index get the
   *                               "not processed" banner instead of overlays.
   */
  BboxOverlay.prototype.render = function (pageIndex, canvasWidth, canvasHeight, pageCount) {
    this._canvasW = canvasWidth;
    this._canvasH = canvasHeight;
    this._clear();

    // Diagnostic: log render parameters so missing overlays can be
    // traced from DevTools without instrumenting the page.
    console.debug('[AgentForge] BboxOverlay.render', {
      pageIndex: pageIndex,
      pageCount: pageCount,
      canvasWidth: canvasWidth,
      canvasHeight: canvasHeight,
      totalRecords: this._records.length,
      recordsOnThisPage: this._records.filter(function (r) {
        return r.bbox && r.bbox.page === pageIndex;
      }).length,
    });

    // Pages beyond the extraction cap → "not processed" banner.
    if (pageIndex >= pageCount) {
      this._renderNotProcessedBanner();
      return;
    }

    var self = this;
    var pageRecords = this._records.filter(function (r) {
      return r.bbox && r.bbox.page === pageIndex;
    });

    pageRecords.forEach(function (record, idx) {
      var rect = computeOverlayRect(record.bbox, canvasWidth, canvasHeight);
      if (!rect) return;

      var div = document.createElement('div');
      div.className = 'af-bbox-overlay';
      div.style.position  = 'absolute';
      div.style.left      = rect.left + 'px';
      div.style.top       = rect.top + 'px';
      div.style.width     = rect.width + 'px';
      div.style.height    = rect.height + 'px';
      div.style.border    = '2px solid rgba(59, 130, 246, 0.8)';
      div.style.background = 'rgba(59, 130, 246, 0.08)';
      div.style.cursor    = 'pointer';
      div.style.boxSizing = 'border-box';
      div.style.borderRadius = '2px';
      div.style.transition = 'background 0.2s, border-color 0.2s';

      // PHI posture: use a numeric index, not data-* with extracted text.
      div.dataset.overlayIdx = String(idx);

      div.addEventListener('mouseenter', function () {
        self._showTooltip(div, record.label);
      });
      div.addEventListener('mouseleave', function () {
        self._hideTooltip();
      });
      // Overlay click → notify the field panel (issue 32).
      // The _onFlash callback receives the fieldPath so the panel can
      // scroll to and highlight the corresponding field row.
      div.addEventListener('click', function () {
        if (self._onFlash) {
          self._onFlash(record.fieldPath);
        }
      });

      self._container.appendChild(div);
      self._divs.push({ div: div, record: record });
    });
  };

  /**
   * Flash the overlay div for the given fieldPath.  Called by the field
   * panel's click-to-source affordance (issue 32 wires this).
   *
   * @param {string} fieldPath
   */
  BboxOverlay.prototype.flashByFieldPath = function (fieldPath) {
    this._divs.forEach(function (entry) {
      if (entry.record.fieldPath === fieldPath) {
        entry.div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        entry.div.style.background    = 'rgba(250, 204, 21, 0.45)';
        entry.div.style.borderColor   = 'rgba(234, 179, 8, 1.0)';
        setTimeout(function () {
          entry.div.style.background  = 'rgba(59, 130, 246, 0.08)';
          entry.div.style.borderColor = 'rgba(59, 130, 246, 0.8)';
        }, 1200);
      }
    });
  };

  /** Remove all overlay divs and the tooltip. */
  BboxOverlay.prototype._clear = function () {
    this._divs.forEach(function (entry) {
      entry.div.remove();
    });
    this._divs = [];
    this._hideTooltip();
    // Remove any existing "not processed" banner.
    var existing = this._container.querySelector('.af-not-processed-banner');
    if (existing) existing.remove();
  };

  BboxOverlay.prototype._renderNotProcessedBanner = function () {
    var banner = document.createElement('div');
    banner.className = 'af-not-processed-banner';
    banner.style.position   = 'absolute';
    banner.style.inset      = '0';
    banner.style.background = 'rgba(0,0,0,0.55)';
    banner.style.display    = 'flex';
    banner.style.alignItems = 'center';
    banner.style.justifyContent = 'center';
    banner.style.color      = '#fff';
    banner.style.fontSize   = '0.95rem';
    banner.style.fontWeight = '600';
    banner.style.letterSpacing = '0.01em';
    banner.style.pointerEvents = 'none';

    var msg = document.createElement('span');
    msg.textContent = 'This page was not processed by the extractor';
    banner.appendChild(msg);
    this._container.appendChild(banner);
  };

  BboxOverlay.prototype._showTooltip = function (anchorDiv, label) {
    this._hideTooltip();
    var tooltip = document.createElement('div');
    tooltip.className = 'af-bbox-tooltip';
    tooltip.style.position    = 'absolute';
    tooltip.style.zIndex      = '1000';
    tooltip.style.background  = 'rgba(15,23,42,0.92)';
    tooltip.style.color       = '#f8fafc';
    tooltip.style.padding     = '4px 8px';
    tooltip.style.borderRadius = '4px';
    tooltip.style.fontSize    = '0.78rem';
    tooltip.style.maxWidth    = '220px';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.whiteSpace  = 'pre-wrap';
    tooltip.style.wordBreak   = 'break-word';
    tooltip.style.boxShadow   = '0 2px 6px rgba(0,0,0,0.25)';

    // PHI posture: label is the field name (JSON path), not extracted text.
    tooltip.textContent = label;

    // Position just above the overlay div.
    var divTop  = parseFloat(anchorDiv.style.top)  || 0;
    var divLeft = parseFloat(anchorDiv.style.left) || 0;

    tooltip.style.left = divLeft + 'px';
    tooltip.style.top  = Math.max(0, divTop - 28) + 'px';

    this._container.appendChild(tooltip);
    this._tooltip = tooltip;
  };

  BboxOverlay.prototype._hideTooltip = function () {
    if (this._tooltip) {
      this._tooltip.remove();
      this._tooltip = null;
    }
  };

  // -------------------------------------------------------------------------
  // ImageViewer — native <img> viewer
  // -------------------------------------------------------------------------

  /**
   * ImageViewer renders the source document via a native <img> element.
   *
   * Surface contract (same as PdfPageViewer):
   *   mount(container, src)                  — insert the <img> element.
   *   renderPage(pageIndex, onDimensions)     — for images there is always
   *                                             exactly one page (index 0).
   *   setScale(scale)                         — currently a no-op; scale
   *                                             is driven by CSS on the
   *                                             wrapping element.
   *   destroy()                               — remove the element.
   *
   * @param {Object} opts
   * @param {Function} opts.onDimensions  - Called with (width, height) once
   *                                         the image has loaded.
   */
  function ImageViewer(opts) {
    this._onDimensions = (opts && opts.onDimensions) || null;
    this._img = null;
    this._container = null;
  }

  ImageViewer.prototype.mount = function (container, src) {
    this._container = container;
    var self = this;
    var img = document.createElement('img');
    img.style.maxWidth  = '100%';
    img.style.display   = 'block';
    img.setAttribute('alt', '');  // decorative; the panel carries the label

    img.addEventListener('load', function () {
      if (self._onDimensions) {
        // Pass DISPLAYED (CSS-pixel) dimensions, not natural — the
        // <img> has `max-width: 100%` so it gets shrunk to fit its
        // container. The overlay positions in CSS pixels and must
        // scale against the visible image, not the natural pixels.
        requestAnimationFrame(function () {
          var w = img.clientWidth || img.naturalWidth;
          var h = img.clientHeight || img.naturalHeight;
          self._onDimensions(w, h);
        });
      }
    });

    img.src = src;
    container.appendChild(img);
    this._img = img;
  };

  /**
   * For the ImageViewer, renderPage is a no-op because there is only one
   * page and it is already displayed via mount().  The caller can invoke
   * this to query rendered dimensions if onDimensions fired before the
   * overlay is ready.
   *
   * @param {number}   pageIndex
   * @param {Function} onDimensions - Called with (width, height) if known.
   */
  ImageViewer.prototype.renderPage = function (pageIndex, onDimensions) {
    // Image uploads are always page 0.
    if (pageIndex !== 0) return;
    if (this._img && this._img.naturalWidth > 0 && onDimensions) {
      // Use DISPLAYED dimensions for the overlay scale; see mount()
      // for the rationale.
      var w = this._img.clientWidth || this._img.naturalWidth;
      var h = this._img.clientHeight || this._img.naturalHeight;
      onDimensions(w, h);
    }
  };

  ImageViewer.prototype.setScale = function (_scale) {
    // Scale on image viewers is driven by CSS (max-width).
  };

  ImageViewer.prototype.destroy = function () {
    if (this._img) {
      this._img.remove();
      this._img = null;
    }
    this._container = null;
  };

  // -------------------------------------------------------------------------
  // PdfPageViewer — PDF.js client-side viewer
  // -------------------------------------------------------------------------

  /**
   * PdfPageViewer wraps PDF.js and renders individual PDF pages onto a
   * `<canvas>`.  `useSystemFonts:false` is set for parity with the
   * server-side renderer (PageRenderer.ts) so coordinates are consistent.
   *
   * Surface contract (same as ImageViewer):
   *   mount(container, src)                  — load the PDF bytes.
   *   renderPage(pageIndex, onDimensions)     — render page `pageIndex`
   *                                             (0-based) onto the canvas
   *                                             and call onDimensions with
   *                                             the rendered pixel dims.
   *   setScale(scale)                         — change render scale and
   *                                             re-render the current page.
   *   destroy()                               — destroy the PDF doc + canvas.
   *
   * @param {Object} opts
   * @param {number}   [opts.scale=1.5]   - Initial render scale (CSS pixels).
   * @param {Function} [opts.onDimensions] - Called with (width, height) after
   *                                          each page render.
   * @param {string}   [opts.workerSrc]   - URL to pdf.worker.min.mjs.  When
   *                                          omitted the component uses the
   *                                          CDN URL set by the page.
   */
  function PdfPageViewer(opts) {
    this._scale       = (opts && opts.scale)       || 1.5;
    this._onDimensions = (opts && opts.onDimensions) || null;
    this._workerSrc   = (opts && opts.workerSrc)   || null;
    this._pdfDoc      = null;
    this._canvas      = null;
    this._container   = null;
    this._currentPage = 0;
    this._totalPages  = 0;
  }

  /**
   * Load the PDF from `src` (a URL served with Cache-Control: private,
   * no-store) and attach the canvas to `container`.
   *
   * @param {HTMLElement} container
   * @param {string}      src       - URL to the PDF bytes.
   */
  PdfPageViewer.prototype.mount = function (container, src) {
    this._container = container;

    var canvas = document.createElement('canvas');
    canvas.style.maxWidth = '100%';
    canvas.style.display  = 'block';
    container.appendChild(canvas);
    this._canvas = canvas;

    var self = this;
    var pdfjsLib = global.pdfjsLib;
    if (!pdfjsLib) {
      console.error('[AgentForge] PdfPageViewer: pdfjsLib not found on window.');
      return;
    }

    if (this._workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = this._workerSrc;
    }

    pdfjsLib.getDocument({
      url: src,
      useSystemFonts: false,
    }).promise.then(function (pdfDoc) {
      self._pdfDoc    = pdfDoc;
      self._totalPages = pdfDoc.numPages;
      // Auto-render page 0 on load.
      self._renderPageInternal(0, self._onDimensions);
    }).catch(function (err) {
      console.error('[AgentForge] PdfPageViewer failed to load PDF:', err);
    });
  };

  /**
   * Render the given 0-based page index onto the canvas.
   *
   * @param {number}   pageIndex
   * @param {Function} [onDimensions] - Overrides the constructor callback for
   *                                     this single call.
   */
  PdfPageViewer.prototype.renderPage = function (pageIndex, onDimensions) {
    this._currentPage = pageIndex;
    this._renderPageInternal(pageIndex, onDimensions || this._onDimensions);
  };

  /** Change the render scale and re-render the current page. */
  PdfPageViewer.prototype.setScale = function (scale) {
    this._scale = scale;
    this._renderPageInternal(this._currentPage, this._onDimensions);
  };

  PdfPageViewer.prototype.destroy = function () {
    if (this._pdfDoc) {
      this._pdfDoc.destroy();
      this._pdfDoc = null;
    }
    if (this._canvas) {
      this._canvas.remove();
      this._canvas = null;
    }
    this._container   = null;
    this._totalPages  = 0;
    this._currentPage = 0;
  };

  /** @private */
  PdfPageViewer.prototype._renderPageInternal = function (pageIndex, onDimensions) {
    if (!this._pdfDoc || !this._canvas) return;
    // pdfjs page numbers are 1-based.
    if (pageIndex >= this._totalPages) return;

    var self = this;
    var scale = this._scale;

    this._pdfDoc.getPage(pageIndex + 1).then(function (page) {
      var viewport = page.getViewport({ scale: scale });
      var canvas   = self._canvas;
      canvas.width  = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      page.render({
        canvasContext: ctx,
        viewport: viewport,
      }).promise.then(function () {
        if (onDimensions) {
          // Pass DISPLAYED (CSS-pixel) dimensions, not the canvas
          // pixel-buffer size. The canvas has `max-width: 100%`, so the
          // visible canvas is shrunk to fit its container — and the
          // overlay positions in CSS pixels relative to the wrap, so
          // they need to scale against displayed width, not natural.
          // Wait one paint frame so clientWidth/Height are accurate.
          requestAnimationFrame(function () {
            var w = canvas.clientWidth || canvas.width;
            var h = canvas.clientHeight || canvas.height;
            onDimensions(w, h);
          });
        }
        page.cleanup();
      }).catch(function (err) {
        console.error('[AgentForge] PdfPageViewer page render failed:', err);
        page.cleanup();
      });
    }).catch(function (err) {
      console.error('[AgentForge] PdfPageViewer getPage failed:', err);
    });
  };

  // -------------------------------------------------------------------------
  // DocumentReviewViewer — top-level controller wiring viewer + overlay
  // -------------------------------------------------------------------------

  /**
   * DocumentReviewViewer mounts the correct viewer (PDF or image) based on
   * the MIME type of the document, then initialises a BboxOverlay on top.
   * Issue 32 (review panel) calls `flashByFieldPath(path)` to drive
   * click-to-source highlighting.
   *
   * @param {Object} opts
   * @param {HTMLElement} opts.viewerContainer  - Relative-positioned wrapper.
   * @param {string}      opts.docSrc           - Document byte URL.
   * @param {string}      opts.mimeType         - "application/pdf" | "image/*".
   * @param {number}      opts.pageCount        - source_citation.page_count.
   * @param {Array}       opts.records          - BboxRecord array for this job.
   * @param {number}      [opts.pdfScale=1.5]   - PDF.js render scale.
   * @param {string}      [opts.workerSrc]      - PDF.js worker URL.
   */
  function DocumentReviewViewer(opts) {
    this._container  = opts.viewerContainer;
    this._docSrc     = opts.docSrc;
    this._mimeType   = opts.mimeType;
    this._pageCount  = opts.pageCount;
    this._records    = opts.records || [];
    this._pdfScale   = opts.pdfScale || 1.5;
    this._workerSrc  = opts.workerSrc || null;
    this._viewer     = null;
    this._overlay    = null;
    this._pageIndex  = 0;
  }

  DocumentReviewViewer.prototype.mount = function () {
    var self = this;

    // Make the container relative so overlay divs are positioned inside it.
    this._container.style.position = 'relative';

    this._overlay = new BboxOverlay(this._container, this._records);

    if (this._mimeType === 'application/pdf') {
      this._viewer = new PdfPageViewer({
        scale: this._pdfScale,
        workerSrc: this._workerSrc,
        onDimensions: function (w, h) {
          self._overlay.render(self._pageIndex, w, h, self._pageCount);
        },
      });
    } else {
      this._viewer = new ImageViewer({
        onDimensions: function (w, h) {
          self._overlay.render(0, w, h, self._pageCount);
        },
      });
    }

    this._viewer.mount(this._container, this._docSrc);
  };

  /**
   * Navigate to a different PDF page (no-op for single-page image viewers).
   *
   * @param {number} pageIndex 0-based
   */
  DocumentReviewViewer.prototype.goToPage = function (pageIndex) {
    this._pageIndex = pageIndex;
    var self = this;
    this._viewer.renderPage(pageIndex, function (w, h) {
      self._overlay.render(pageIndex, w, h, self._pageCount);
    });
  };

  /**
   * Scroll to and flash the overlay div matching the given JSON field path.
   * Called by the review panel (issue 32) on field-row click.
   *
   * @param {string} fieldPath
   */
  DocumentReviewViewer.prototype.flashByFieldPath = function (fieldPath) {
    if (this._overlay) {
      this._overlay.flashByFieldPath(fieldPath);
    }
  };

  DocumentReviewViewer.prototype.destroy = function () {
    if (this._viewer) {
      this._viewer.destroy();
      this._viewer = null;
    }
    if (this._overlay) {
      this._overlay._clear();
      this._overlay = null;
    }
  };

  // -------------------------------------------------------------------------
  // Namespace export
  // -------------------------------------------------------------------------

  if (!global.AgentForge) {
    global.AgentForge = {};
  }
  global.AgentForge.viewer = {
    computeOverlayRect:       computeOverlayRect,
    BboxOverlay:              BboxOverlay,
    ImageViewer:              ImageViewer,
    PdfPageViewer:            PdfPageViewer,
    DocumentReviewViewer:     DocumentReviewViewer,
  };

}(typeof window !== 'undefined' ? window : globalThis));
