export type GarmentComponentQuality = {
  allowedComponents: number;
  componentCount: number;
  foregroundPixels: number;
  significantComponentSizes: number[];
  significantBounds: [number, number, number, number] | null;
  significantPixelThreshold: number;
  status: "pass" | "review";
};

type ComponentMeasurement = {
  size: number;
  bounds: [number, number, number, number];
};

function connectedComponentMeasurements(mask: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const measurements: ComponentMeasurement[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let readIndex = 0;
    let writeIndex = 0;
    let size = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    visited[start] = 1;
    queue[writeIndex++] = start;
    while (readIndex < writeIndex) {
      const index = queue[readIndex++];
      const x = index % width;
      const y = Math.floor(index / width);
      size += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const neighborY = y + offsetY;
        if (neighborY < 0 || neighborY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          if (offsetX === 0 && offsetY === 0) continue;
          const neighborX = x + offsetX;
          if (neighborX < 0 || neighborX >= width) continue;
          const neighbor = neighborY * width + neighborX;
          if (!mask[neighbor] || visited[neighbor]) continue;
          visited[neighbor] = 1;
          queue[writeIndex++] = neighbor;
        }
      }
    }
    measurements.push({ size, bounds: [minX, minY, maxX, maxY] });
  }
  return measurements.sort((left, right) => right.size - left.size);
}

export function allowedGarmentComponents(category: string) {
  // A pair of shoes or earrings is one wardrobe item but naturally contains
  // two disconnected foreground objects in a clean product image.
  return /鞋|首饰/.test(category) ? 2 : 1;
}

export function inspectGarmentComponents(
  sourceMask: Uint8Array,
  width: number,
  height: number,
  category: string,
): GarmentComponentQuality {
  if (sourceMask.length !== width * height || width < 1 || height < 1) {
    throw new Error("衣物前景蒙版尺寸无效");
  }
  const foregroundPixels = sourceMask.reduce((sum, value) => sum + value, 0);
  const significantPixelThreshold = Math.max(
    32,
    Math.ceil(width * height * 0.0015),
    Math.ceil(foregroundPixels * 0.025),
  );
  const thresholdQualified = connectedComponentMeasurements(sourceMask, width, height)
    .filter(component => component.size >= significantPixelThreshold);
  const largestComponent = thresholdQualified[0]?.size || 0;
  // Generated product shots can contain a small detached shadow or metal
  // glint. Ignore it when it is clearly subordinate, while still rejecting
  // missing sleeves or other sizeable separated garment pieces.
  const significantComponents = thresholdQualified
    .filter((component, index) => index === 0 || component.size >= largestComponent * 0.12);
  const significantComponentSizes = significantComponents.map(component => component.size);
  const significantBounds = significantComponents.length
    ? significantComponents.reduce<[number, number, number, number]>((bounds, component) => [
      Math.min(bounds[0], component.bounds[0]),
      Math.min(bounds[1], component.bounds[1]),
      Math.max(bounds[2], component.bounds[2]),
      Math.max(bounds[3], component.bounds[3]),
    ], [...significantComponents[0].bounds])
    : null;
  const allowedComponents = allowedGarmentComponents(category);
  const componentCount = significantComponentSizes.length;
  return {
    allowedComponents,
    componentCount,
    foregroundPixels,
    significantComponentSizes,
    significantBounds,
    significantPixelThreshold,
    status: componentCount >= 1 && componentCount <= allowedComponents ? "pass" : "review",
  };
}
