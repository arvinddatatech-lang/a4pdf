"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";

// A4 at 96 DPI: 794 x 1123 px
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
// 1mm = 3.7795px at 96dpi
const MM_TO_PX = 3.7795;
const RULER_SIZE = 24; // px

type PlacedItem = {
  id: string;
  type: "image" | "pdf-page";
  src: string; // data URL
  x: number;
  y: number;
  width: number;
  height: number;
  // perspective warp: 4 corner points relative to item bounding box
  // [tl, tr, br, bl] each {x, y} offset from the corner
  warpPoints: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number }
  ];
  rotation: number;
  selected: boolean;
  label?: string;
};

type DragState =
  | { type: "move"; itemId: string; startX: number; startY: number; origX: number; origY: number }
  | { type: "resize"; itemId: string; handle: string; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number }
  | { type: "warp"; itemId: string; cornerIndex: number; startX: number; startY: number; origPoints: PlacedItem["warpPoints"] }
  | null;

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function getAbsoluteWarpPoints(item: PlacedItem): { x: number; y: number }[] {
  const corners = [
    { x: item.x, y: item.y },
    { x: item.x + item.width, y: item.y },
    { x: item.x + item.width, y: item.y + item.height },
    { x: item.x, y: item.y + item.height },
  ];
  return corners.map((c, i) => ({
    x: c.x + item.warpPoints[i].x,
    y: c.y + item.warpPoints[i].y,
  }));
}

// Draw a warped image onto an offscreen canvas via CSS perspective transform simulation
function drawWarpedImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  pts: { x: number; y: number }[]
) {
  // Use a triangulated mesh warp (bilinear quad subdivision)
  const STEPS = 32;
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  for (let row = 0; row < STEPS; row++) {
    for (let col = 0; col < STEPS; col++) {
      const u0 = col / STEPS;
      const v0 = row / STEPS;
      const u1 = (col + 1) / STEPS;
      const v1 = (row + 1) / STEPS;

      // Bilinear interpolation of destination quad
      function bilerp(u: number, v: number) {
        const tl = pts[0];
        const tr = pts[1];
        const br = pts[2];
        const bl = pts[3];
        return {
          x: (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x,
          y: (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y,
        };
      }

      const p00 = bilerp(u0, v0);
      const p10 = bilerp(u1, v0);
      const p11 = bilerp(u1, v1);
      const p01 = bilerp(u0, v1);

      // Source rectangle
      const sx = u0 * srcW;
      const sy = v0 * srcH;
      const sw = (u1 - u0) * srcW;
      const sh = (v1 - v0) * srcH;

      // Draw two triangles using drawImage + clip
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.clip();

      // Use transform to map src rect to dest quad
      // Approximate with the parallelogram formed by p00, p10, p01
      const dx1 = p10.x - p00.x;
      const dy1 = p10.y - p00.y;
      const dx2 = p01.x - p00.x;
      const dy2 = p01.y - p00.y;

      ctx.transform(
        dx1 / sw, dy1 / sw,
        dx2 / sh, dy2 / sh,
        p00.x - dx1 * (sx / sw) - dx2 * (sy / sh),
        p00.y - dy1 * (sx / sw) - dy2 * (sy / sh)
      );
      ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
      ctx.restore();
    }
  }
}

export default function A4Editor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [items, setItems] = useState<PlacedItem[]>([]);
  const [drag, setDrag] = useState<DragState>(null);
  const [warpMode, setWarpMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rulerUnit, setRulerUnit] = useState<"mm" | "cm" | "in">("cm");
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const animFrameRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load image from src with caching
  const loadImage = useCallback((src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve) => {
      if (imageCache.current.has(src)) {
        resolve(imageCache.current.get(src)!);
        return;
      }
      const img = new Image();
      img.onload = () => {
        imageCache.current.set(src, img);
        resolve(img);
      };
      img.src = src;
    });
  }, []);

  // Render canvas
  const render = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background (A4 page area)
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = 12;
    ctx.fillRect(RULER_SIZE, RULER_SIZE, A4_WIDTH_PX, A4_HEIGHT_PX);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    // Page border
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.strokeRect(RULER_SIZE, RULER_SIZE, A4_WIDTH_PX, A4_HEIGHT_PX);

    // Draw items
    for (const item of items) {
      const img = await loadImage(item.src);
      const pts = getAbsoluteWarpPoints(item).map((p) => ({
        x: p.x + RULER_SIZE,
        y: p.y + RULER_SIZE,
      }));

      ctx.save();
      drawWarpedImage(ctx, img, pts);

      // Selection / hover overlay
      if (item.selected) {
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([6 / zoom, 3 / zoom]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.lineTo(pts[3].x, pts[3].y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);

        if (!warpMode) {
          // Draw resize handles at bounding-box corners
          const bx = item.x + RULER_SIZE;
          const by = item.y + RULER_SIZE;
          const bw = item.width;
          const bh = item.height;
          const handlePos = [
            [bx, by], [bx + bw / 2, by], [bx + bw, by],
            [bx + bw, by + bh / 2],
            [bx + bw, by + bh], [bx + bw / 2, by + bh], [bx, by + bh],
            [bx, by + bh / 2],
          ];
          for (const [hx, hy] of handlePos) {
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = "#3b82f6";
            ctx.lineWidth = 1.5 / zoom;
            ctx.beginPath();
            ctx.arc(hx, hy, 5 / zoom, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        } else {
          // Draw warp corner handles
          for (let i = 0; i < 4; i++) {
            ctx.fillStyle = "#f59e0b";
            ctx.strokeStyle = "#b45309";
            ctx.lineWidth = 1.5 / zoom;
            ctx.beginPath();
            ctx.arc(pts[i].x, pts[i].y, 7 / zoom, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    }

    // Ruler - top
    drawRuler(ctx, "horizontal", rulerUnit);
    // Ruler - left
    drawRuler(ctx, "vertical", rulerUnit);

    // Ruler corner
    ctx.fillStyle = "#f1f5f9";
    ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);
    ctx.strokeStyle = "#cbd5e1";
    ctx.strokeRect(0, 0, RULER_SIZE, RULER_SIZE);
  }, [items, warpMode, zoom, rulerUnit, loadImage]);

  function drawRuler(
    ctx: CanvasRenderingContext2D,
    direction: "horizontal" | "vertical",
    unit: "mm" | "cm" | "in"
  ) {
    const isH = direction === "horizontal";
    const totalPx = isH ? A4_WIDTH_PX : A4_HEIGHT_PX;
    let stepMm = 1;
    let labelEvery = 10;
    let unitPx = MM_TO_PX;
    let totalUnits = 210;

    if (unit === "cm") {
      stepMm = 1;
      labelEvery = 10;
      unitPx = MM_TO_PX;
      totalUnits = 210;
    } else if (unit === "mm") {
      stepMm = 1;
      labelEvery = 5;
      unitPx = MM_TO_PX;
      totalUnits = 210;
    } else {
      // inches: 1in = 25.4mm
      stepMm = 1;
      labelEvery = 25; // ~every inch
      unitPx = MM_TO_PX;
      totalUnits = 210;
    }

    ctx.save();
    // Ruler background
    ctx.fillStyle = "#f8fafc";
    if (isH) {
      ctx.fillRect(RULER_SIZE, 0, totalPx, RULER_SIZE);
      ctx.strokeStyle = "#e2e8f0";
      ctx.strokeRect(RULER_SIZE, 0, totalPx, RULER_SIZE);
    } else {
      ctx.fillRect(0, RULER_SIZE, RULER_SIZE, totalPx);
      ctx.strokeStyle = "#e2e8f0";
      ctx.strokeRect(0, RULER_SIZE, RULER_SIZE, totalPx);
    }

    ctx.fillStyle = "#64748b";
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 0.5;
    ctx.font = `${9}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let mm = 0; mm <= totalUnits; mm += stepMm) {
      const px = mm * unitPx;
      if (px > totalPx) break;
      const isMajor = mm % 10 === 0;
      const isMid = mm % 5 === 0;
      const tickLen = isMajor ? 12 : isMid ? 8 : 4;

      ctx.beginPath();
      if (isH) {
        ctx.moveTo(RULER_SIZE + px, RULER_SIZE - tickLen);
        ctx.lineTo(RULER_SIZE + px, RULER_SIZE);
      } else {
        ctx.moveTo(RULER_SIZE - tickLen, RULER_SIZE + px);
        ctx.lineTo(RULER_SIZE, RULER_SIZE + px);
      }
      ctx.stroke();

      if (isMajor && unit !== "mm") {
        const label = unit === "cm" ? `${mm / 10}` : `${(mm / 25.4).toFixed(1)}`;
        if (isH) {
          ctx.fillText(label, RULER_SIZE + px, RULER_SIZE / 2);
        } else {
          ctx.save();
          ctx.translate(RULER_SIZE / 2, RULER_SIZE + px);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(label, 0, 0);
          ctx.restore();
        }
      } else if (unit === "mm" && mm % 5 === 0) {
        const label = `${mm}`;
        if (isH) {
          ctx.fillText(label, RULER_SIZE + px, RULER_SIZE / 2);
        } else {
          ctx.save();
          ctx.translate(RULER_SIZE / 2, RULER_SIZE + px);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(label, 0, 0);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  useEffect(() => {
    const animate = () => {
      render();
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [render]);

  // Convert screen coords to canvas coords
  function screenToCanvas(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom,
    };
  }

  // Convert canvas coords to A4 space (subtract ruler)
  function canvasToA4(cx: number, cy: number) {
    return { x: cx - RULER_SIZE, y: cy - RULER_SIZE };
  }

  function getSelectedItem(): PlacedItem | undefined {
    return items.find((i) => i.selected);
  }

  // Hit test: warp handles first, then bounding box
  function hitTest(cx: number, cy: number) {
    const a4x = cx - RULER_SIZE;
    const a4y = cy - RULER_SIZE;
    const HANDLE_R = 9 / zoom;

    // Reverse order so topmost items are hit first
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.selected && warpMode) {
        const pts = getAbsoluteWarpPoints(item);
        for (let ci = 0; ci < 4; ci++) {
          const p = pts[ci];
          if (Math.hypot(p.x - a4x, p.y - a4y) <= HANDLE_R) {
            return { type: "warp" as const, itemId: item.id, cornerIndex: ci };
          }
        }
      }
      if (item.selected && !warpMode) {
        // Check resize handles on bounding box
        const bx = item.x;
        const by = item.y;
        const bw = item.width;
        const bh = item.height;
        const handles: [string, number, number][] = [
          ["tl", bx, by], ["tc", bx + bw / 2, by], ["tr", bx + bw, by],
          ["mr", bx + bw, by + bh / 2],
          ["br", bx + bw, by + bh], ["bc", bx + bw / 2, by + bh], ["bl", bx, by + bh],
          ["ml", bx, by + bh / 2],
        ];
        for (const [handle, hx, hy] of handles) {
          if (Math.hypot(hx - a4x, hy - a4y) <= HANDLE_R) {
            return { type: "resize" as const, itemId: item.id, handle };
          }
        }
      }
      // Check inside bbox
      if (a4x >= item.x && a4x <= item.x + item.width && a4y >= item.y && a4y <= item.y + item.height) {
        return { type: "move" as const, itemId: item.id };
      }
    }
    return null;
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x: cx, y: cy } = screenToCanvas(e);
    const hit = hitTest(cx, cy);
    const a4 = canvasToA4(cx, cy);

    if (hit) {
      // Select this item, deselect others
      setItems((prev) =>
        prev.map((item) => ({ ...item, selected: item.id === hit.itemId }))
      );

      if (hit.type === "warp") {
        const item = items.find((i) => i.id === hit.itemId)!;
        setDrag({
          type: "warp",
          itemId: hit.itemId,
          cornerIndex: hit.cornerIndex,
          startX: a4.x,
          startY: a4.y,
          origPoints: JSON.parse(JSON.stringify(item.warpPoints)),
        });
      } else if (hit.type === "resize") {
        const item = items.find((i) => i.id === hit.itemId)!;
        setDrag({
          type: "resize",
          itemId: hit.itemId,
          handle: hit.handle,
          startX: a4.x,
          startY: a4.y,
          origX: item.x,
          origY: item.y,
          origW: item.width,
          origH: item.height,
        });
      } else {
        const item = items.find((i) => i.id === hit.itemId)!;
        setDrag({
          type: "move",
          itemId: hit.itemId,
          startX: a4.x,
          startY: a4.y,
          origX: item.x,
          origY: item.y,
        });
      }
    } else {
      // Deselect all
      setItems((prev) => prev.map((item) => ({ ...item, selected: false })));
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drag) return;
    const { x: cx, y: cy } = screenToCanvas(e);
    const a4 = canvasToA4(cx, cy);
    const dx = a4.x - drag.startX;
    const dy = a4.y - drag.startY;

    if (drag.type === "move") {
      setItems((prev) =>
        prev.map((item) =>
          item.id === drag.itemId
            ? {
                ...item,
                x: Math.max(0, Math.min(A4_WIDTH_PX - item.width, drag.origX + dx)),
                y: Math.max(0, Math.min(A4_HEIGHT_PX - item.height, drag.origY + dy)),
              }
            : item
        )
      );
    } else if (drag.type === "warp") {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== drag.itemId) return item;
          const newPoints = JSON.parse(JSON.stringify(drag.origPoints)) as PlacedItem["warpPoints"];
          newPoints[drag.cornerIndex] = {
            x: drag.origPoints[drag.cornerIndex].x + dx,
            y: drag.origPoints[drag.cornerIndex].y + dy,
          };
          return { ...item, warpPoints: newPoints };
        })
      );
    } else if (drag.type === "resize") {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== drag.itemId) return item;
          let { x, y, width, height } = { x: drag.origX, y: drag.origY, width: drag.origW, height: drag.origH };
          const h = drag.handle;
          if (h.includes("r")) { width = Math.max(20, drag.origW + dx); }
          if (h.includes("l")) { x = drag.origX + dx; width = Math.max(20, drag.origW - dx); }
          if (h.includes("b")) { height = Math.max(20, drag.origH + dy); }
          if (h.includes("t")) { y = drag.origY + dy; height = Math.max(20, drag.origH - dy); }
          // Reset warp points when resizing
          return {
            ...item, x, y, width, height,
            warpPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
          };
        })
      );
    }
  }

  function onMouseUp() {
    setDrag(null);
  }

  // File upload handler
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const src = await fileToDataURL(file);
        const img = await loadImage(src);
        const aspect = img.naturalWidth / img.naturalHeight;
        const maxW = Math.min(400, A4_WIDTH_PX - 40);
        const w = maxW;
        const h = w / aspect;
        const newItem: PlacedItem = {
          id: generateId(),
          type: "image",
          src,
          x: 20,
          y: 20,
          width: w,
          height: h,
          warpPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
          rotation: 0,
          selected: true,
          label: file.name,
        };
        setItems((prev) => prev.map((i) => ({ ...i, selected: false })).concat(newItem));
      } else if (file.type === "application/pdf") {
        await handlePdfUpload(file);
      }
    }
    e.target.value = "";
  }

  async function handlePdfUpload(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Use PDF.js to render pages to canvas
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

    const pdf = await pdfjs.getDocument({ data: uint8Array }).promise;
    const numPages = Math.min(pdf.numPages, 5); // limit to 5 pages

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      const offCanvas = document.createElement("canvas");
      offCanvas.width = viewport.width;
      offCanvas.height = viewport.height;
      const offCtx = offCanvas.getContext("2d")!;
      await page.render({ canvas: offCanvas, canvasContext: offCtx, viewport }).promise;
      const src = offCanvas.toDataURL("image/png");

      const aspect = viewport.width / viewport.height;
      const maxW = Math.min(350, A4_WIDTH_PX - 40);
      const w = maxW;
      const h = w / aspect;
      const offsetX = 20 + (pageNum - 1) * 30;
      const offsetY = 20 + (pageNum - 1) * 30;

      const newItem: PlacedItem = {
        id: generateId(),
        type: "pdf-page",
        src,
        x: Math.min(offsetX, A4_WIDTH_PX - w - 10),
        y: Math.min(offsetY, A4_HEIGHT_PX - h - 10),
        width: w,
        height: h,
        warpPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
        rotation: 0,
        selected: pageNum === 1,
        label: `${file.name} p.${pageNum}`,
      };
      setItems((prev) => prev.map((i) => ({ ...i, selected: false })).concat(newItem));
    }
  }

  function fileToDataURL(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target!.result as string);
      reader.readAsDataURL(file);
    });
  }

  function deleteSelected() {
    setItems((prev) => prev.filter((i) => !i.selected));
  }

  function resetWarp() {
    setItems((prev) =>
      prev.map((item) =>
        item.selected
          ? { ...item, warpPoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] }
          : item
      )
    );
  }

  async function downloadPDF() {
    const { jsPDF } = await import("jspdf");
    // Render A4 canvas to image at high resolution
    const scale = 2;
    const offCanvas = document.createElement("canvas");
    offCanvas.width = A4_WIDTH_PX * scale;
    offCanvas.height = A4_HEIGHT_PX * scale;
    const offCtx = offCanvas.getContext("2d")!;
    offCtx.scale(scale, scale);

    // White background
    offCtx.fillStyle = "#ffffff";
    offCtx.fillRect(0, 0, A4_WIDTH_PX, A4_HEIGHT_PX);

    // Draw all items
    for (const item of items) {
      const img = await loadImage(item.src);
      const pts = getAbsoluteWarpPoints(item);
      drawWarpedImage(offCtx, img, pts);
    }

    const imgData = offCanvas.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
    });
    pdf.addImage(imgData, "PNG", 0, 0, 210, 297);
    pdf.save("a4-document.pdf");
  }

  function bringForward() {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.selected);
      if (idx < 0 || idx === prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }

  function sendBackward() {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.selected);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
      return next;
    });
  }

  const hasSelected = items.some((i) => i.selected);
  const canvasW = A4_WIDTH_PX + RULER_SIZE;
  const canvasH = A4_HEIGHT_PX + RULER_SIZE;

  return (
    <div className="flex flex-col h-screen bg-gray-100 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shadow-sm flex-wrap">
        <span className="font-semibold text-gray-800 text-sm mr-2">A4 Document Editor</span>

        {/* Upload */}
        <label className="cursor-pointer inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Image / PDF
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
        </label>

        <div className="w-px h-5 bg-gray-300" />

        {/* Warp toggle */}
        <button
          onClick={() => setWarpMode((v) => !v)}
          disabled={!hasSelected}
          className={`px-3 py-1.5 text-xs rounded border transition-colors ${
            warpMode
              ? "bg-amber-500 text-white border-amber-600"
              : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {warpMode ? "Warp ON" : "Warp Mode"}
        </button>

        <button
          onClick={resetWarp}
          disabled={!hasSelected}
          className="px-3 py-1.5 text-xs rounded border bg-white text-gray-700 border-gray-300 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Reset Warp
        </button>

        <div className="w-px h-5 bg-gray-300" />

        <button
          onClick={bringForward}
          disabled={!hasSelected}
          className="px-3 py-1.5 text-xs rounded border bg-white text-gray-700 border-gray-300 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Bring Forward"
        >
          ↑ Forward
        </button>

        <button
          onClick={sendBackward}
          disabled={!hasSelected}
          className="px-3 py-1.5 text-xs rounded border bg-white text-gray-700 border-gray-300 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Send Backward"
        >
          ↓ Backward
        </button>

        <button
          onClick={deleteSelected}
          disabled={!hasSelected}
          className="px-3 py-1.5 text-xs rounded border bg-red-50 text-red-600 border-red-200 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Delete
        </button>

        <div className="w-px h-5 bg-gray-300" />

        {/* Ruler unit */}
        <select
          value={rulerUnit}
          onChange={(e) => setRulerUnit(e.target.value as "mm" | "cm" | "in")}
          className="px-2 py-1.5 text-xs rounded border border-gray-300 bg-white text-gray-700"
        >
          <option value="cm">Ruler: cm</option>
          <option value="mm">Ruler: mm</option>
          <option value="in">Ruler: in</option>
        </select>

        {/* Zoom */}
        <select
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          className="px-2 py-1.5 text-xs rounded border border-gray-300 bg-white text-gray-700"
        >
          <option value={0.5}>50%</option>
          <option value={0.75}>75%</option>
          <option value={1}>100%</option>
          <option value={1.25}>125%</option>
          <option value={1.5}>150%</option>
        </select>

        <div className="flex-1" />

        {/* Download PDF */}
        <button
          onClick={downloadPDF}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded transition-colors shadow"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download PDF
        </button>

        {/* Download standalone HTML editor */}
        <a
          href="/api/download-editor"
          download="a4-editor.html"
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded transition-colors shadow"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download Editor
        </a>
      </div>

      {/* Hint bar */}
      <div className="px-4 py-1 bg-blue-50 border-b border-blue-100 text-xs text-blue-700 flex gap-4">
        {!warpMode ? (
          <>
            <span>Click to select &bull; Drag to move &bull; Drag corner handles to resize</span>
            <span className="opacity-60">&bull; Enable Warp Mode to drag corners for perspective warp</span>
          </>
        ) : (
          <span className="font-medium text-amber-700">Warp Mode: Drag the 4 orange corner handles to perspective-warp the selected item</span>
        )}
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-300 p-6 flex items-start justify-center"
      >
        <div
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            width: canvasW,
            height: canvasH,
          }}
        >
          <canvas
            ref={canvasRef}
            width={canvasW}
            height={canvasH}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            style={{
              cursor: drag ? "grabbing" : "default",
              display: "block",
              boxShadow: "0 4px 32px rgba(0,0,0,0.15)",
            }}
          />
        </div>
      </div>

      {/* Item list panel */}
      {items.length > 0 && (
        <div className="border-t border-gray-200 bg-white px-4 py-2 flex gap-3 overflow-x-auto">
          {items.map((item, idx) => (
            <button
              key={item.id}
              onClick={() =>
                setItems((prev) =>
                  prev.map((i) => ({ ...i, selected: i.id === item.id }))
                )
              }
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1 rounded border text-xs transition-colors ${
                item.selected
                  ? "border-blue-500 bg-blue-50 text-blue-800"
                  : "border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
              }`}
            >
              <span className="w-4 h-4 rounded-sm overflow-hidden inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.src} alt="" className="w-full h-full object-cover" />
              </span>
              <span>{idx + 1}. {item.type === "pdf-page" ? "PDF" : "Img"}</span>
              {item.label && <span className="opacity-60 max-w-[80px] truncate">{item.label}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
