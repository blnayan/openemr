/**
 * OcrService — pixel-accurate text + bbox extraction for rendered pages.
 *
 * The new bbox flow inverts the old VLM-emits-bboxes design: a VLM is
 * still responsible for STRUCTURED extraction (parsing tables, picking
 * out names, labelling abnormal flags), but it no longer emits pixel
 * coordinates. Instead, an OCR pass runs over each rendered page and
 * the BboxLocator anchors each VLM-extracted value against the OCR
 * words that produced it.
 *
 * The interface is small on purpose: hand it RenderedPage[], get back
 * one OcrPage per input. Production uses TesseractOcrService (WASM),
 * tests inject a recording fake with canned word lists.
 *
 * Coordinate space matches the rendered PNG the OCR ran on — i.e. for
 * trimmed image uploads the boxes are in trimmed-frame pixels. The
 * BboxLocator owns the trim-undo translation back into the original
 * frame the browser displays.
 */

import type { RenderedPage } from './types.js';

/** A single recognized word with its pixel-space bounding box. */
export interface OcrWord {
  /** Page index, 0-based. Mirrors RenderedPage.page. */
  page: number;
  /** Verbatim recognized text (no normalization). */
  text: string;
  /** Pixel x of word's top-left, in the rendered image's frame. */
  x: number;
  /** Pixel y of word's top-left. */
  y: number;
  /** Pixel width. */
  w: number;
  /** Pixel height. */
  h: number;
  /** Index of the OcrLine this word belongs to (within the same page). */
  lineIndex: number;
  /** Tesseract's confidence for this word (0..100). */
  confidence: number;
}

/** A line of OCR output, computed by the recognizer. */
export interface OcrLine {
  page: number;
  /** Concatenated text of every word in this line. */
  text: string;
  /** Pixel-space bbox covering every word in the line. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Words in reading order. */
  words: OcrWord[];
}

/** All OCR output for a single rendered page. */
export interface OcrPage {
  page: number;
  /** Width of the image OCR ran on (matches RenderedPage.imageWidth). */
  imageWidth: number;
  /** Height of the image OCR ran on (matches RenderedPage.imageHeight). */
  imageHeight: number;
  lines: OcrLine[];
  /** Convenience: every word, in reading order. */
  words: OcrWord[];
}

export interface OcrService {
  /**
   * Recognize each rendered page. Returns one OcrPage per input page,
   * in the same order. If the recognizer cannot read a page (blank,
   * pure graphics) the OcrPage is still returned with empty lines/
   * words — never null.
   */
  recognize(pages: ReadonlyArray<RenderedPage>): Promise<OcrPage[]>;

  /**
   * Optional teardown hook. Production implementations that hold a
   * persistent worker should release it here. Tests typically no-op.
   */
  shutdown?(): Promise<void>;
}
