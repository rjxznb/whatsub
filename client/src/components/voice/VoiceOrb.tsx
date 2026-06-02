// src/components/voice/VoiceOrb.tsx
//
// Voice-mode orb: a flat 2D glass circle (NOT a 3D sphere) rendered as a
// fragment shader on a transparent canvas. Liquid-glass material (soft top-left
// sheen + bright rim) over a clean duotone "流光" gradient that drifts slowly.
// Palette is a single, restrained slate-blue → near-white family (no rainbow).
//
// Ambient / calm: the gradient flows slowly; speaking flows a touch faster and
// the glass brightens a little. Body size + colors stay constant. WebGL setup
// is guarded so it's a harmless empty div where WebGL isn't available (tests).

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { VoiceState } from "../../voice/types";
import { getTtsLevel } from "../../tutor/tts";

interface Props {
  state: VoiceState;
  /** Mic level 0..1 (the user speaking). */
  level: number;
  size?: number;
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

const VERT = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;

const FRAG =
  NOISE +
  `
uniform float uTime,uAudio;uniform vec3 uC1,uC2;varying vec2 vUv;
// clean duotone: one color family, deep → light
vec3 pal(float t){return mix(uC1,uC2,smoothstep(0.0,1.0,clamp(t,0.0,1.0)));}
void main(){
  vec2 uv=vUv*2.0-1.0;float r=length(uv);
  float rb=0.52;                                  // body radius (margin left for glow)
  vec2 bv=uv/rb;                                   // body-local coords
  // 流光渐变 — clean smooth flowing field drifting inside the body
  float t=uTime*0.08;
  float f1=0.5+0.5*snoise(vec3(bv*0.8,t));
  float f2=0.5+0.5*snoise(vec3(bv*0.75+4.0,t*0.75+2.0));
  float f=f1*0.6+f2*0.4;
  vec3 grad=pal(f*0.9+0.05+0.04*sin(uTime*0.15));
  // ── circle body: even glass, NO inward glow ──
  float body=smoothstep(rb+0.012,rb-0.03,r);
  vec3 col=grad;
  vec2 hp=uv-vec2(-0.18,0.18);
  float hl=smoothstep(0.34,0.0,length(hp));        // soft top-left sheen
  col+=vec3(1.0)*hl*0.30;
  float rim=smoothstep(rb-0.09,rb,r)*smoothstep(rb+0.02,rb-0.05,r);
  col+=mix(uC2,vec3(1.0),0.5)*rim*0.65;            // bright glass rim
  float streak=smoothstep(0.05,0.0,abs(uv.x*0.6+uv.y-sin(uTime*0.25)*0.4))*body;
  col+=vec3(1.0)*streak*0.10;                      // slow liquid specular streak
  vec3 outc=col*body; float a=body*0.95;
  // ── outer glow only: radiates OUTWARD from the rim, range grows with volume ──
  float dist=r-rb;
  float gw=0.13+uAudio*0.16;                       // glow reach grows with volume
  float outside=smoothstep(-0.02,0.02,dist);
  float glow=exp(-pow(max(dist,0.0)/gw,2.0))*outside;
  vec3 glowCol=mix(uC2,vec3(1.0),0.3);
  float gA=glow*(0.42+uAudio*0.55);
  outc+=glowCol*gA; a+=gA;
  gl_FragColor=vec4(outc,clamp(a,0.0,1.0));
}`;

// Per-state flow cadence (≈ seconds, the FRAG re-scales internally). Speaking
// drifts a touch faster; idle is the slowest / most ambient.
function flowSpeed(state: VoiceState): number {
  if (state === "speaking") return 1.25;
  if (state === "thinking" || state === "transcribing") return 1.0;
  if (state === "listening") return 0.8;
  return 0.55; // idle
}

export function VoiceOrb({ state, level, size = 340 }: Props) {
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
      return; // no WebGL (e.g. tests)
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = `${size}px`;
    renderer.domElement.style.height = `${size}px`;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const uniforms = {
      uTime: { value: 0 },
      uAudio: { value: 0 },
      uC1: { value: new THREE.Color(0x5b6bc4) }, // 板岩蓝
      uC2: { value: new THREE.Color(0xdfe6ff) }, // 近白
    };
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(geo, mat));

    let flowT = 0;
    let amp = 0;
    let last = performance.now();
    let raf = 0;

    const frame = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      flowT += dt * flowSpeed(st);

      let raw = 0;
      if (st === "speaking") raw = getTtsLevel();
      else if (st === "listening") raw = Math.min(1, Math.max(0, levelRef.current));
      else if (st === "thinking" || st === "transcribing") raw = 0.14;
      amp += (raw - amp) * (raw > amp ? 0.3 : 0.1);

      uniforms.uTime.value = flowT;
      uniforms.uAudio.value = amp;
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
