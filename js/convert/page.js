// Page geometry shared by the PDF and DOCX writers. All values are in points.

const SIZES = { A4: [595.28, 841.89], LETTER: [612, 792] };
const MARGINS = { narrow: 36, normal: 64, wide: 90 };

export function pageGeometry(opts = {}) {
  let [width, height] = SIZES[opts.pageSize] || SIZES.A4;
  const landscape = opts.orientation === 'landscape';
  if (landscape) [width, height] = [height, width];
  const margin = MARGINS[opts.margin] ?? MARGINS.normal;
  return { width, height, margin, landscape, contentWidth: width - margin * 2, contentHeight: height - margin * 2 };
}
