// src/components/voice/ParticleOrb.tsx
//
// three.js particle orb for voice mode. ~5000 points that ALWAYS form a sphere
// (no shape-morphing), rendered with additive blending on a fully TRANSPARENT
// canvas — no post-processing bloom (that blew the orb out to solid white and
// broke the canvas alpha, leaving a visible dark square). Volume drives the
// outward spike + a mild size pulse; the body keeps a constant size.
//
// `level` = mic RMS (0..1) while the user speaks; during the AI reply the orb
// reacts to the TTS amplitude instead. WebGL setup is guarded so the component
// is a harmless empty div where WebGL isn't available (tests).

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { VoiceState } from "../../voice/types";
import { getTtsLevel } from "../../tutor/tts";

interface Props {
  state: VoiceState;
  /** Mic level 0..1 (drives the listening spikes). */
  level: number;
  size?: number;
}

const N = 5000;

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
varying float vB;
void main(){
  vec3 base=position;
  vec3 dir=normalize(base);
  float n=snoise(base*1.4+uTime*0.3);
  vec3 p=base+dir*(uDisplace*n + uAudio*uSpike*abs(n)); // spike outward with volume
  vB=0.5+0.5*n;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  gl_PointSize=clamp(uPointSize*(1.0+uAudio*0.5)*(4.2/-mv.z),1.0,8.0);
  gl_Position=projectionMatrix*mv;
}`;

const FRAG = `
uniform vec3 uC1,uC2; varying float vB;
void main(){
  vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard;
  float a=smoothstep(0.5,0.0,d)*0.6;   // soft round dot, modest alpha (not blown out)
  gl_FragColor=vec4(mix(uC1,uC2,vB), a);
}`;

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
      // alpha:true + clearAlpha 0 → fully transparent canvas (no dark square).
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return; // no WebGL (e.g. tests)
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = `${size}px`;
    renderer.domElement.style.height = `${size}px`;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.z = 4.2; // far enough that the sphere + spikes leave a margin

    const uniforms = {
      uTime: { value: 0 },
      uAudio: { value: 0 },
      uDisplace: { value: 0.08 },
      uSpike: { value: 0.45 },
      uPointSize: { value: 5.0 },
      uC1: { value: new THREE.Color(0x3f8fe0) }, // sky blue
      uC2: { value: new THREE.Color(0xcfe6ff) }, // soft light blue (not pure white)
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(sphereShape(), 3));
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

    let amp = 0;
    let raf = 0;
    const start = performance.now();

    const frame = () => {
      const t = (performance.now() - start) / 1000;
      const st = stateRef.current;
      let raw = 0;
      if (st === "speaking") raw = getTtsLevel();
      else if (st === "listening") raw = Math.min(1, Math.max(0, levelRef.current));
      else if (st === "thinking" || st === "transcribing") raw = 0.14;
      amp += (raw - amp) * (raw > amp ? 0.35 : 0.12);

      uniforms.uTime.value = t;
      uniforms.uAudio.value = amp;
      points.rotation.y = t * 0.14;
      renderer.render(scene, cam);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
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
