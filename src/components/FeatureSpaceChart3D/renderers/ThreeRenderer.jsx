/* eslint-disable react/no-unknown-property */
/**
 * three.js renderer (react-three-fiber + drei) for the 3D feature-space chart.
 *
 * Two modes:
 *  - scatter: points as a single InstancedMesh (per-instance colour and scale)
 *    with r3f raycast picking via `event.instanceId`.
 *  - profile: per-series centre lines, a translucent ribbon (`along` mode) and
 *    per-sample points, all unlit/flat so colours match the map and deck.gl.
 *
 * KNOWN LIMITATION: there are no built-in labelled axes in three.js. Axis titles
 * and tick labels are rendered with drei's <Html> placing DOM over the WebGL
 * canvas. We deliberately avoid drei <Text> here: troika-three-text resolves its
 * default font through the unicode-font-resolver CDN, which the app's
 * COEP `require-corp` headers block. <Html> needs no font fetch.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { axisTitle, formatValue } from '../attributes';
import { colorToHex, sizeForValue } from '../colorScale';
import { computeAxisDomains, projectToCube } from '../transformPoints';
import { buildProfileFrame, formatTick } from '../profileGeometry';
import { PointTooltip } from '../PointTooltip';
import { ProfileTooltip } from '../ProfileTooltip';

const CUBE = 1;
const AXIS_COLORS = { x: '#d62728', y: '#2ca02c', z: '#1f77b4' };

/** Chart space [x, y, z] -> three.js space with chart Z vertical. */
const toThree = ([x, y, z]) => [x, z, y];

function buildCubeGeometry() {
  const c = CUBE;
  const corners = [
    [-c, -c, -c], [c, -c, -c], [c, c, -c], [-c, c, -c],
    [-c, -c, c], [c, -c, c], [c, c, c], [-c, c, c],
  ];
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const positions = new Float32Array(pairs.length * 6);
  pairs.forEach(([a, b], i) => {
    positions.set(toThree(corners[a]), i * 6);
    positions.set(toThree(corners[b]), i * 6 + 3);
  });
  return positions;
}

function buildAxisGeometry() {
  const c = CUBE;
  const segs = [
    [[-c, -c, -c], [c, -c, -c], AXIS_COLORS.x],
    [[-c, -c, -c], [-c, c, -c], AXIS_COLORS.y],
    [[-c, -c, -c], [-c, -c, c], AXIS_COLORS.z],
  ];
  const positions = new Float32Array(segs.length * 6);
  const colors = new Float32Array(segs.length * 6);
  segs.forEach(([a, b, color], i) => {
    positions.set(toThree(a), i * 6);
    positions.set(toThree(b), i * 6 + 3);
    const c3 = new THREE.Color(color);
    colors.set([c3.r, c3.g, c3.b], i * 6);
    colors.set([c3.r, c3.g, c3.b], i * 6 + 3);
  });
  return { positions, colors };
}

/** Ribbon triangle strip between the lo/hi edges of an ordered sample list. */
function buildRibbonGeometry(samples) {
  const n = samples.length;
  if (n < 2) return null;
  const positions = new Float32Array(n * 2 * 3);
  samples.forEach((s, i) => {
    if (!s.ribbon) return;
    positions.set(toThree(s.ribbon.lo), i * 6);
    positions.set(toThree(s.ribbon.hi), i * 6 + 3);
  });
  const indices = [];
  for (let a = 0; a < n - 1; a++) {
    const b0 = 2 * a;
    const t0 = 2 * a + 1;
    const b1 = 2 * a + 2;
    const t1 = 2 * a + 3;
    indices.push(b0, t0, t1, b0, t1, b1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}

/**
 * @param {Object} props
 * @param {Array<import('../transformPoints').FeatureSpacePoint>} props.points
 * @param {import('../attributes').PresetAxes} props.axes
 * @param {ReturnType<import('../colorScale').buildColorScale>} props.colorScale
 * @param {[number, number]} props.sizeDomain
 * @param {[number, number]} props.sizeRange
 * @param {'billboard'|'sphere'} props.markerStyle
 * @param {{mode:'along'|'geo',series:Array<any>}} [props.profile]
 * @param {(id: string|null) => void} props.onHover
 */
export function ThreeRenderer({ points, axes, colorScale, sizeDomain, sizeRange, markerStyle, profile, onHover }) {
  const domains = useMemo(() => computeAxisDomains(points, axes), [points, axes]);
  const [hovered, setHovered] = useState(null);

  const frame = useMemo(() => (profile ? buildProfileFrame(profile, CUBE) : null), [profile]);

  const scatterData = useMemo(
    () =>
      points.map((p) => {
        const radius = sizeForValue(p[axes.size], sizeDomain, sizeRange);
        const t = sizeRange[1] === sizeRange[0] ? 0.5 : (radius - sizeRange[0]) / (sizeRange[1] - sizeRange[0]);
        return {
          point: p,
          position: toThree(projectToCube(p, axes, domains, CUBE)),
          hex: colorToHex(colorScale, p[axes.color]),
          // Billboard circle radius (px) and sphere radius (world units).
          radius,
          worldRadius: 0.018 + t * 0.055,
        };
      }),
    [points, axes, domains, colorScale, sizeDomain, sizeRange],
  );

  const profileData = useMemo(() => {
    if (!frame) return [];
    return frame.series.flatMap((s) =>
      s.samples.map((p) => ({
        point: { id: p.id },
        position: toThree(p.position),
        hex: s.color,
        radius: 4,
        worldRadius: 0.03,
        seriesLabel: s.label,
        color: s.color,
        unit: s.unit,
        value: p.sample?.value ?? null,
        std: p.sample?.std ?? null,
        distance: p.sample?.distance ?? null,
        lon: p.sample?.lon ?? null,
        lat: p.sample?.lat ?? null,
        height: p.sample?.height ?? null,
      })),
    );
  }, [frame]);

  const data = frame ? profileData : scatterData;

  const handlePick = (index) => {
    setHovered(index);
    onHover(index == null ? null : data[index]?.point?.id ?? null);
  };

  return (
    <div style={{ position: 'absolute', inset: 0 }} onMouseLeave={() => handlePick(null)}>
      <Canvas
        camera={{ position: [3, 2.4, 3], fov: 45, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        // r3f defaults to ACES Filmic tone mapping, which shifts hue/saturation
        // of every colour and would make these points disagree with the map,
        // deck.gl and Plotly (none of which tone-map). `flat` disables it.
        flat
      >
        {/* three.js (r155+) scales diffuse by BRDF_Lambert = albedo / PI, and a
            light uniform is just color * intensity, so effective reflectance is
            intensity / PI. Intensities are chosen as target * PI to mirror the
            map's deck.gl sphere material (ambient 0.35, diffuse 0.6 gives about
            0.35 unlit / 0.95 fully lit). */}
        <ambientLight intensity={1.1} />
        <directionalLight position={[5, 8, 6]} intensity={1.9} />
        {frame ? <ProfileAxes frame={frame} /> : <Axes domains={domains} axes={axes} />}
        {frame && <ProfileLines series={frame.series} />}
        {frame && frame.along && <ProfileRibbons series={frame.series} />}
        {markerStyle === 'billboard' ? (
          <BillboardPoints data={data} hovered={hovered} onPick={handlePick} />
        ) : (
          <Points data={data} hovered={hovered} onPick={handlePick} />
        )}
        {hovered != null && data[hovered] && (
          <Html position={data[hovered].position} style={{ pointerEvents: 'none' }} zIndexRange={[4, 0]}>
            <div style={{ transform: 'translate(10px, 10px)' }}>
              {frame ? (
                <ProfileTooltip sample={data[hovered]} />
              ) : (
                <PointTooltip point={data[hovered].point} axes={axes} />
              )}
            </div>
          </Html>
        )}
        <OrbitControls makeDefault enablePan enableZoom enableRotate target={[0, 0, 0]} />
      </Canvas>
    </div>
  );
}

/** Per-series centre polylines (chart-space positions already normalised). */
function ProfileLines({ series }) {
  return series.map((s) => {
    const positions = new Float32Array(s.samples.length * 3);
    s.samples.forEach((p, i) => positions.set(toThree(p.position), i * 3));
    return (
      <line key={s.key}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={s.color} />
      </line>
    );
  });
}

/** Translucent uncertainty ribbons (along mode only), unlit to match the map. */
function ProfileRibbons({ series }) {
  const built = useMemo(
    () =>
      series
        .map((s) => {
          const geometry = buildRibbonGeometry(s.samples);
          return geometry ? { key: s.key, color: s.color, geometry } : null;
        })
        .filter(Boolean),
    [series],
  );

  useEffect(() => () => {
    built.forEach((b) => b.geometry.dispose());
  }, [built]);

  return built.map((b) => (
    <mesh key={b.key} geometry={b.geometry}>
      <meshBasicMaterial color={b.color} transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  ));
}

/**
 * Camera-facing circular sprites (Plotly-style billboards) with per-point size
 * and colour. Uses THREE.Points + a small custom ShaderMaterial, because
 * PointsMaterial.size is a single uniform and cannot vary per point.
 */
function BillboardPoints({ data, hovered, onPick }) {
  const dpr = useThree((s) => s.viewport.dpr);
  const raycaster = useThree((s) => s.raycaster);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uDpr: { value: 1 } },
        transparent: true,
        vertexShader: `
          attribute vec3 aColor;
          attribute float aSize;
          uniform float uDpr;
          varying vec3 vColor;
          void main() {
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = aSize * 2.0 * uDpr;
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          void main() {
            float d = length(gl_PointCoord - vec2(0.5));
            float edge = fwidth(d);
            float alpha = 1.0 - smoothstep(0.5 - edge, 0.5, d);
            if (alpha <= 0.0) discard;
            gl_FragColor = vec4(vColor, alpha);
            // aColor is stored in linear space (THREE.Color converts the sRGB
            // hex on assignment), so run the same output transform the built-in
            // materials use or the discs render too dark/oversaturated.
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      }),
    [],
  );

  const geometry = useMemo(() => {
    const n = data.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const color = new THREE.Color();
    data.forEach((d, i) => {
      positions.set(d.position, i * 3);
      color.set(d.hex);
      colors.set([color.r, color.g, color.b], i * 3);
      sizes[i] = d.radius;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    g.userData = { baseSizes: sizes.slice(), baseColors: colors.slice() };
    return g;
  }, [data]);

  useLayoutEffect(() => {
    material.uniforms.uDpr.value = dpr;
  }, [material, dpr]);

  useLayoutEffect(() => {
    raycaster.params.Points = raycaster.params.Points || {};
    raycaster.params.Points.threshold = 0.06;
  }, [raycaster]);

  const prevHover = useRef(null);
  useLayoutEffect(() => {
    const sizeAttr = geometry.getAttribute('aSize');
    const colorAttr = geometry.getAttribute('aColor');
    const { baseSizes, baseColors } = geometry.userData;
    const restore = (i) => {
      if (i == null) return;
      sizeAttr.setX(i, baseSizes[i]);
      colorAttr.setXYZ(i, baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
    };
    restore(prevHover.current);
    if (hovered != null) {
      sizeAttr.setX(hovered, baseSizes[hovered] * 1.6);
      colorAttr.setXYZ(hovered, 1, 0, 0);
    }
    sizeAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    prevHover.current = hovered;
  }, [geometry, hovered]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return (
    <points
      geometry={geometry}
      material={material}
      frustumCulled={false}
      onPointerMove={(e) => {
        e.stopPropagation();
        onPick(e.index);
      }}
      onPointerOut={() => onPick(null)}
    />
  );
}

function Points({ data, hovered, onPick }) {
  const ref = useRef();

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    data.forEach((d, i) => {
      dummy.position.set(d.position[0], d.position[1], d.position[2]);
      dummy.scale.setScalar(i === hovered ? d.worldRadius * 1.6 : d.worldRadius);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(i === hovered ? '#ff0000' : d.hex);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [data, hovered]);

  return (
    <instancedMesh
      key={data.length}
      ref={ref}
      args={[undefined, undefined, data.length]}
      onPointerMove={(e) => {
        e.stopPropagation();
        onPick(e.instanceId);
      }}
      onPointerOut={() => onPick(null)}
    >
      <sphereGeometry args={[1, 12, 12]} />
      <meshStandardMaterial roughness={0.55} metalness={0.05} />
    </instancedMesh>
  );
}

function Axes({ domains, axes, labels: labelsProp }) {
  const cube = useMemo(() => buildCubeGeometry(), []);
  const axis = useMemo(() => buildAxisGeometry(), []);

  const labels = useMemo(() => {
    if (labelsProp) return labelsProp;
    const c = CUBE;
    const off = c + 0.14;
    const tick = off + 0.05;
    const list = [
      { position: toThree([0, -off, -off]), text: axisTitle(axes.x), color: AXIS_COLORS.x },
      { position: toThree([-off, 0, -off]), text: axisTitle(axes.y), color: AXIS_COLORS.y },
      { position: toThree([-off, -off, 0]), text: axisTitle(axes.z), color: AXIS_COLORS.z },
    ];
    const ticks = [
      ['x', [-c, -tick, -tick], [c, -tick, -tick]],
      ['y', [-tick, -c, -tick], [-tick, c, -tick]],
      ['z', [-tick, -tick, -c], [-tick, -tick, c]],
    ];
    for (const [slot, minPos, maxPos] of ticks) {
      list.push({ position: toThree(minPos), text: formatValue(axes[slot], domains[slot].min), color: '#6e6e6e' });
      list.push({ position: toThree(maxPos), text: formatValue(axes[slot], domains[slot].max), color: '#6e6e6e' });
    }
    return list;
  }, [axes, domains, labelsProp]);

  return (
    <group>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[cube, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#dcdcdc" />
      </lineSegments>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[axis.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[axis.colors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors />
      </lineSegments>
      {labels.map((l, i) => (
        <Html key={i} position={l.position} center style={{ pointerEvents: 'none' }} zIndexRange={[3, 0]}>
          <span
            style={{
              color: l.color,
              fontFamily: 'system-ui, sans-serif',
              fontSize: '10px',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            {l.text}
          </span>
        </Html>
      ))}
    </group>
  );
}

/** Cube + shafts + profile axis titles/ticks (raw units) via drei <Html>. */
function ProfileAxes({ frame }) {
  const labels = useMemo(() => {
    const c = CUBE;
    const off = c + 0.14;
    const tick = off + 0.05;
    const list = [
      { position: toThree([0, -off, -off]), text: frame.titles.x, color: AXIS_COLORS.x },
      { position: toThree([-off, 0, -off]), text: frame.titles.y, color: AXIS_COLORS.y },
      { position: toThree([-off, -off, 0]), text: frame.titles.z, color: AXIS_COLORS.z },
    ];
    const ticks = [
      ['x', [-c, -tick, -tick], [c, -tick, -tick]],
      ['y', [-tick, -c, -tick], [-tick, c, -tick]],
      ['z', [-tick, -tick, -c], [-tick, -tick, c]],
    ];
    for (const [slot, minPos, maxPos] of ticks) {
      list.push({ position: toThree(minPos), text: formatTick(frame.domains[slot][0]), color: '#6e6e6e' });
      list.push({ position: toThree(maxPos), text: formatTick(frame.domains[slot][1]), color: '#6e6e6e' });
    }
    return list;
  }, [frame]);

  return <Axes labels={labels} />;
}

export default ThreeRenderer;
