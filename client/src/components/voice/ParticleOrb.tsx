// src/components/voice/ParticleOrb.tsx
//
// three.js particle orb for voice mode. ~5000 points that MORPH between shapes
// driven by the conversation state, with bloom self-emission:
//
//   idle / listening   → sphere (spikes outward with YOUR mic level)
//   thinking           → rotating ring (torus)
//   speaking           → spectrum waveform ring (driven by the AI voice's FFT)
//   after a reply       → briefly forms a ✓, then dissolves back to a sphere
//
// The body keeps a constant size; volume drives spikes + emissive (bloom). All
// WebGL setup is guarded so the component is a harmless empty div where WebGL
// isn't available (tests).

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { VoiceState } from "../../voice/types";
import { getTtsLevel, getTtsBands } from "../../tutor/tts";

interface Props {
  state: VoiceState;
  /** Mic level 0..1 (drives the listening spikes). */
  level: number;
  size?: number;
}

const N = 5000;
const BANDS = 16;
const FLOURISH_MS = 950;

// ── shape target generators ───────────────────────────────────────────────────
function sphereShape(): Float32Array {
  const a = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    a[i * 3] = Math.cos(phi) * r;
    a[i * 3 + 1] = y;
    a[i * 3 + 2] = Math.sin(phi) * r;
  }
  return a;
}
function ringShape(): Float32Array {
  const a = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const r = 1.15 + (((i * 7919) % 100) / 100 - 0.5) * 0.04;
    a[i * 3] = Math.cos(ang) * r;
    a[i * 3 + 1] = Math.sin(ang) * r;
    a[i * 3 + 2] = (((i * 104729) % 100) / 100 - 0.5) * 0.05;
  }
  return a;
}
function torusShape(): Float32Array {
  const a = new Float32Array(N * 3);
  const R = 0.92,
    rr = 0.32;
  for (let i = 0; i < N; i++) {
    const u = (i / N) * Math.PI * 2 * 9;
    const v = i * 2.399963;
    a[i * 3] = (R + rr * Math.cos(v)) * Math.cos(u);
    a[i * 3 + 1] = rr * Math.sin(v);
    a[i * 3 + 2] = (R + rr * Math.cos(v)) * Math.sin(u);
  }
  return a;
}
function checkShape(): Float32Array {
  // ✓ in the XY plane: short down-stroke then long up-stroke.
  const p1 = [-0.62, 0.05];
  const p2 = [-0.18, -0.42];
  const p3 = [0.66, 0.52];
  const l1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const l2 = Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n1 = Math.floor((N * l1) / (l1 + l2));
  const a = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let x: number, y: number;
    if (i < n1) {
      const t = i / n1;
      x = p1[0] + (p2[0] - p1[0]) * t;
      y = p1[1] + (p2[1] - p1[1]) * t;
    } else {
      const t = (i - n1) / (N - n1);
      x = p2[0] + (p3[0] - p2[0]) * t;
      y = p2[1] + (p3[1] - p2[1]) * t;
    }
    const jx = (((i * 7919) % 100) / 100 - 0.5) * 0.06;
    const jy = (((i * 104729) % 100) / 100 - 0.5) * 0.06;
    a[i * 3] = x + jx;
    a[i * 3 + 1] = y + jy;
    a[i * 3 + 2] = (((i * 1299709) % 100) / 100 - 0.5) * 0.05;
  }
  return a;
}

const NOISE = `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;
vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+2.0*C.xxx;vec3 x3=x0-1.0+3.0*C.xxx;i=mod(i,289.0);
vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
float n_=1.0/7.0;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}`;

const VERT =
  NOISE +
  `
uniform float uTime,uAudio,uDisplace,uSpike,uPointSize;
uniform int uMode;            // 0 sphere/torus spike · 1 ring spectrum · 3 static (✓)
uniform float uBands[${BANDS}];
varying float vB;
void main(){
  vec3 base=position;
  float n=snoise(base*1.4+uTime*0.3);
  vec3 p=base;
  if(uMode==1){
    float ang=atan(base.y,base.x);
    float u=ang*0.1591549+0.5;                 // 0..1 around the ring
    int bi=int(mod(floor(u*float(${BANDS})),float(${BANDS})));
    float band=uBands[bi];
    vec3 dir=normalize(vec3(base.x,base.y,0.0001));
    p+=dir*(band*0.6 + uAudio*0.12 + n*uDisplace*0.3);
    p.z+=n*0.05;
  } else if(uMode==3){
    p+=normalize(base+vec3(0.001))*n*0.012;     // ✓: nearly static, tiny shimmer
  } else {
    vec3 dir=normalize(base);
    p+=dir*(uDisplace*n + uAudio*uSpike*abs(n)); // spike outward with volume
  }
  vB=0.5+0.5*n;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  gl_PointSize=clamp(uPointSize*(1.0+uAudio*0.9)*(3.0/-mv.z),1.0,11.0);
  gl_Position=projectionMatrix*mv;
}`;

const FRAG = `
uniform vec3 uC1,uC2; uniform float uAudio; varying float vB;
void main(){
  vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard;
  float a=smoothstep(0.5,0.0,d);
  gl_FragColor=vec4(mix(uC1,uC2,vB)*(1.0+uAudio*1.3), a);  // brighter when loud → bloom
}`;

function modeFor(shape: string): number {
  if (shape === "ring") return 1;
  if (shape === "check") return 3;
  return 0;
}

export function ParticleOrb({ state, level, size = 300 }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return; // no WebGL (e.g. tests) — render nothing
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = `${size}px`;
    renderer.domElement.style.height = `${size}px`;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.z = 3.2;

    const shapes: Record<string, Float32Array> = {
      sphere: sphereShape(),
      ring: ringShape(),
      torus: torusShape(),
      check: checkShape(),
    };
    const cur = shapes.sphere.slice();

    const uniforms = {
      uTime: { value: 0 },
      uAudio: { value: 0 },
      uDisplace: { value: 0.1 },
      uSpike: { value: 0.55 },
      uPointSize: { value: 5.2 },
      uMode: { value: 0 },
      uBands: { value: new Float32Array(BANDS) },
      uC1: { value: new THREE.Color(0x4d9eff) },
      uC2: { value: new THREE.Color(0xffffff) },
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(cur, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    const composer = new EffectComposer(renderer);
    composer.setSize(size, size);
    composer.addPass(new RenderPass(scene, cam));
    const bloom = new UnrealBloomPass(new THREE.Vector2(size, size), 0.9, 0.6, 0.0);
    composer.addPass(bloom);

    const bandsBuf = new Float32Array(BANDS);
    let prev: VoiceState = "idle";
    let flourishUntil = 0;
    let amp = 0;
    let raf = 0;
    const start = performance.now();

    const frame = () => {
      const now = performance.now();
      const t = (now - start) / 1000;
      const st = stateRef.current;
      if (prev === "speaking" && st !== "speaking") flourishUntil = now + FLOURISH_MS;
      prev = st;

      let shape: string;
      if (now < flourishUntil) shape = "check";
      else if (st === "thinking") shape = "torus";
      else if (st === "speaking") shape = "ring";
      else shape = "sphere";

      const target = shapes[shape];
      const ms = shape === "check" ? 0.13 : 0.07;
      for (let i = 0; i < cur.length; i++) cur[i] += (target[i] - cur[i]) * ms;
      geo.attributes.position.needsUpdate = true;

      let raw = 0;
      if (st === "speaking") raw = getTtsLevel();
      else if (st === "listening") raw = Math.min(1, Math.max(0, levelRef.current));
      else if (st === "thinking" || st === "transcribing") raw = 0.16;
      amp += (raw - amp) * (raw > amp ? 0.35 : 0.12);

      if (shape === "ring") getTtsBands(BANDS, bandsBuf);
      else bandsBuf.fill(0);
      const ub = uniforms.uBands.value;
      for (let i = 0; i < BANDS; i++) ub[i] += (bandsBuf[i] - ub[i]) * 0.4;

      uniforms.uTime.value = t;
      uniforms.uAudio.value = amp;
      uniforms.uMode.value = modeFor(shape);
      points.rotation.y = shape === "torus" ? t * 0.9 : t * 0.12;
      bloom.strength = 0.85 + amp * 1.4;
      bloom.radius = 0.55 + amp * 0.25;
      composer.render();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      composer.dispose();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount)
        mount.removeChild(renderer.domElement);
    };
  }, [size]);

  return (
    <div
      ref={mountRef}
      className="pointer-events-none"
      style={{ width: size, height: size }}
    />
  );
}
