import type { ImageComment, ImageMarkup, ImagePoint, ImageRegionStroke } from '@/types/media';

function pointsPath(points: ImagePoint[], width: number, height: number) {
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x * width},${point.y * height}`).join(' ');
  return points.length === 1 ? `${path} L${points[0].x * width},${points[0].y * height}` : path;
}

export function ImageLayers({ width, height, markup, comments, region, mode, maskId }: {
  width: number;
  height: number;
  markup: ImageMarkup[];
  comments: ImageComment[];
  region: ImageRegionStroke[];
  mode: 'preview' | 'markup' | 'mask';
  maskId: string;
}) {
  const scale = Math.min(width, height);
  const regionMask = (selected: boolean) => (
    <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
      <rect width={width} height={height} fill={selected ? 'black' : 'white'} />
      {region.map(stroke => <path key={stroke.id} d={pointsPath(stroke.points, width, height)} stroke={stroke.erase === selected ? 'black' : 'white'} strokeWidth={stroke.width * scale} strokeLinecap="round" strokeLinejoin="round" fill="none" />)}
    </mask>
  );
  if (mode === 'mask') return <><defs>{regionMask(false)}</defs><rect width={width} height={height} fill="white" mask={`url(#${maskId})`} /></>;
  return (
    <>
      {mode === 'preview' && region.length > 0 && <><defs>{regionMask(true)}</defs><rect width={width} height={height} fill="var(--ds-info)" opacity="0.28" mask={`url(#${maskId})`} /></>}
      {markup.map(item => {
        const line = { stroke: item.color, strokeWidth: item.width * scale, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
        if (item.kind === 'pen') return <path key={item.id} d={pointsPath(item.points, width, height)} {...line} />;
        if (item.kind === 'text') return <text key={item.id} x={item.point.x * width} y={item.point.y * height} fill={item.color} fontSize={Math.max(item.width * scale * 5, scale * 0.02)} fontFamily="sans-serif">{item.text}</text>;
        const start = { x: item.start.x * width, y: item.start.y * height };
        const end = { x: item.end.x * width, y: item.end.y * height };
        if (item.kind === 'rectangle') return <rect key={item.id} x={Math.min(start.x, end.x)} y={Math.min(start.y, end.y)} width={Math.abs(end.x - start.x)} height={Math.abs(end.y - start.y)} {...line} />;
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const size = Math.max(item.width * scale * 4, scale * 0.018);
        const left = { x: end.x - size * Math.cos(angle - 0.5), y: end.y - size * Math.sin(angle - 0.5) };
        const right = { x: end.x - size * Math.cos(angle + 0.5), y: end.y - size * Math.sin(angle + 0.5) };
        return <path key={item.id} d={`M${start.x},${start.y} L${end.x},${end.y} M${left.x},${left.y} L${end.x},${end.y} L${right.x},${right.y}`} {...line} />;
      })}
      {comments.map((comment, index) => <g key={comment.id} transform={`translate(${comment.point.x * width} ${comment.point.y * height})`}>
        <circle r={scale * 0.018} fill="#2563eb" stroke="white" strokeWidth={scale * 0.002} />
        <text textAnchor="middle" dominantBaseline="central" fontFamily="sans-serif" fontSize={scale * 0.02} fill="white">{index + 1}</text>
      </g>)}
    </>
  );
}
