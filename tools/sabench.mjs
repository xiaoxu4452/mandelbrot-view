import fs from 'node:fs';
import { paletteLUT } from '../js/palettes.js';
import { _internals } from '../js/render.js';
import { buildSeries } from '../js/environment.js';
const W=640,H=400,exp=Number(process.argv[2]||-20),maxIter=Number(process.argv[3]||12000);
const cx='-0.743643887037158704752191506114774', cy='0.131825904205311970493132056385139';
const v=Math.pow(10,exp), e=Math.floor(Math.log2(v));
const span={m:v/Math.pow(2,e),e};
let pm=span.m/W, pe=e; while(Math.abs(pm)>=2){pm/=2;pe++;} while(Math.abs(pm)<1){pm*=2;pe--;}
const ps=pm*Math.pow(2,pe);
const job={viewId:'x',x:0,y:0,w:W,h:H,width:W,height:H,spec:{mode:'m',kind:'mandelbrot',power:2},
  center:{re:cx,im:cy},span,pixelSize:ps,bits:128,maxIter};
const orb=_internals.pickReference(job,128);
const ser=buildSeries(orb,maxIter,false,ps);
const inst=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync('wasm/kernel.wasm')),{env:{abort(){}}});
const ex=inst.exports, mem=ex.memory;
const outCap=W*H*4+64, lut=65536+outCap, par=lut+2048, roots=par+512, orbPtr=roots+1024;
const stride=maxIter+1;
const need=Math.ceil((orbPtr+stride*16+4096)/65536)*65536+65536;
if(mem.buffer.byteLength<need) mem.grow(Math.ceil((need-mem.buffer.byteLength)/65536));
const heap=new Uint8Array(mem.buffer);
heap.set(paletteLUT('ice'),lut);
heap.set(new Uint8Array(orb.re.buffer,orb.re.byteOffset,orb.re.byteLength),orbPtr);
heap.set(new Uint8Array(orb.im.buffer,orb.im.byteOffset,orb.im.byteLength),orbPtr+stride*8);
const P=new Float64Array(mem.buffer,par,64);
[1,0,2,0,0,0,W,H,W,H,parseFloat(cx),parseFloat(cy),ps,0,0,maxIter,8,0,65536,lut,orbPtr,orb.len,orb.refPx,orb.refPy,0.5667,1,3,roots,stride].forEach((val,i)=>{P[i]=val;});
function setSkip(skip){
  P[29]=skip; P[37]=skip?1:0;
  P[30]=skip?ser.Ar[skip]:0; P[31]=skip?ser.Ai[skip]:0;
  P[32]=skip?ser.Br[skip]:0; P[33]=skip?ser.Bi[skip]:0;
  P[34]=skip?ser.Cr[skip]:0; P[35]=skip?ser.Ci[skip]:0;
}
const snap=()=>new Uint8ClampedArray(mem.buffer.slice(65536,65536+W*H*4));
setSkip(0); ex.render(par); ex.render(par); ex.render(par);
const base=snap();
const t0=performance.now(); for(let i=0;i<3;i++) ex.render(par); const baseMs=(performance.now()-t0)/3;
console.log('base', baseMs.toFixed(0)+'ms');
for (const skip of [200,1000,3000,5000,7000]) {
  setSkip(skip); ex.render(par);
  const t=performance.now(); for(let i=0;i<3;i++) ex.render(par); const ms=(performance.now()-t)/3;
  const d=snap();
  let diff=0,bad=0;
  for(let i=0;i<base.length;i+=4){const dd=Math.abs(base[i]-d[i])+Math.abs(base[i+1]-d[i+1])+Math.abs(base[i+2]-d[i+2]);diff+=dd;if(dd>16)bad++;}
  const n=base.length/4;
  console.log(String(skip).padStart(5), ms.toFixed(0)+'ms', 'x'+(baseMs/ms).toFixed(2), 'meandiff',(diff/n).toFixed(2), 'bad',(bad/n*100).toFixed(2)+'%');
}
