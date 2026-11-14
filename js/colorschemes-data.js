/* The reference program's colour-scheme library, verbatim.
 *
 * Source: 00_原始项目副本/colorschemes.json — the file the shipped exe seeds
 * its library with.  It is kept here as *text* and parsed at load, so the
 * values this program receives are the ones in that file: no transcription
 * step that could round a number or reword a shader.
 *
 * Six entries, in file order:
 *   Iteration                      builtin=1  samples=2  channels=1
 *   Smooth                         builtin=1  samples=2  channels=256
 *   Distance                       builtin=1  samples=2  channels=17   nparam=1
 *   Distance and iteration levels  builtin=1  samples=2  channels=145  nparam=2
 *   Texture                        builtin=1  samples=1  channels=4103 nparam=1
 *                                  aux=D:\微信文档\mandelbrot\appdata\texturesgl.jpg
 *   Iteration (Copy)               builtin=0  samples=2  channels=1
 *
 * `channels` is the shader's channel bitfield (see CHANNEL in gpu.js); `aux` is
 * the Texture scheme's atlas.  That path does not exist on this machine any
 * more, but the same image ships in ui/assets/texturesgl.jpg, which is what the
 * renderer uploads — the field is metadata and is left as the file wrote it.
 *
 * The file carries no colour table: the reference colours these schemes with
 * the program's *current* `params.color` table, so none is invented here.
 */
export const REFERENCE_COLORSCHEMES_JSON = String.raw`[
  {
    "name": "Iteration",
    "codegl": "vec4 color(Data data)\n{\n    vec3 c;\nif(data.iter>=0)\n    c = pal(float(data.iter)+0.5, params.brightnessfinite\/params.brightnessfactor);\nelse\n    c = pal(float(-data.iter)+0.5, params.brightnessinfinite\/params.brightnessfactor);\nreturn vec4(c, 1.0);\n}\n",
    "samples": 2,
    "builtin": 1,
    "channels": 1
  },
  {
    "name": "Smooth",
    "codegl": "vec4 color(Data data)\n{\n   vec3 c;\n   if(data.smoothiter>=0.0)\n       c = pal(data.smoothiter+0.5, params.brightnessfinite\/params.brightnessfactor);\n   else\n       c = pal(-data.smoothiter+0.5, params.brightnessinfinite\/params.brightnessfactor);\n   return vec4(c, 1.0);\n}\n",
    "samples": 2,
    "builtin": 1,
    "channels": 256
  },
  {
    "name": "Distance",
    "codegl": "vec4 color(Data data)\n{\n   vec3 color;\n   if(data.iter<0)\n       color = pal(float(-data.iter)+0.5, params.brightnessinfinite\/params.brightnessfactor);\n   else\n       color = vec3(0.0,0.0,0.0);\n\n   vec3 color2;\n   float rr = data.dist*exp(5.0*params.param[0]);\n   if(rr<1.0&&rr!=0.0)color2 = vec3(1.0-rr, 1.0-rr, 1.0-rr); else color2 = vec3(0.0,0.0,0.0);\n\n   vec3 c = color+color2*params.brightnessfinite;\n\n   return vec4(c, 1.0);\n}\n",
    "nparam": 1,
    "samples": 2,
    "builtin": 1,
    "channels": 17
  },
  {
    "name": "Distance and iteration levels",
    "codegl": "vec4 color(Data data)\n{\n   vec3 color, color2;\n   if(data.iter<0)\n   {\n       color = pal(float(-data.iter)+0.5, params.brightnessinfinite\/params.brightnessfactor);\n   }\n   else\n   {\n       float rr = data.dist2*exp(5.0*params.param[1]-1.5);\n       if(rr<1.0&&rr!=0.0)color = (1.0-rr)*pal(float(data.iter)+0.5, params.brightnessfinite\/params.brightnessfactor); else color = vec3(0.0,0.0,0.0);\n   }\n\n   float rr = data.dist*exp(5.0*params.param[0]);\n   if(rr<1.0&&rr!=0.0)color2 = vec3(1.0-rr, 1.0-rr, 1.0-rr); else color2 = vec3(0.0,0.0,0.0);\n\n   vec3 c = color+color2*params.brightnessfinite;\n\n   return vec4(c, 1.0);\n}\n",
    "nparam": 2,
    "samples": 2,
    "builtin": 1,
    "channels": 145
  },
  {
    "name": "Texture",
    "codegl": "#define NTEXTURE 15\n\nvec4 color(Data data)\n{\n\n    vec3 c;\n    if(data.iter>=0)\n    {\n        vec2 value = data.value;\n        float x1s, y1s, len; int i;\n\n        float limit = exp((-params.param[0]+0.33)*5.0);\n\n        x1s = value.x*value.x; y1s = value.y*value.y;\n        len = x1s+y1s;\n\n        for(i=data.iter;i<data.iter+20;i++)\n        {\n            if(len>limit)break;\n            value.y = value.x*value.y*2.0;\n            value.x = x1s - y1s;\n            value += data.coord;\n\n            x1s = value.x*value.x; y1s = value.y*value.y;\n            len = x1s+y1s;\n        }\n\n        vec2 v; float fi = mod(float(i),float(NTEXTURE));\n        v.y = atan(value.y,value.x)\/M_PI_H*6.0;\n        v.x = -0.5*(log(len)-log(limit))\/M_PI_H*6.0;\n        v.x = fract(v.x); v.y = fract(v.y);\n        v.x = (v.x+mod(fi,4.0))\/4.0;\n        v.y = (v.y+3.0-float(int(fi)\/4))\/4.0;\n\n        c = vec3(texture2D(tex_aux, v).rgb);\n    }\n    else\n        c = pal(float(-data.iter)+0.5, params.brightnessinfinite\/params.brightnessfactor);\n    return vec4(c, 1.0);\n}\n",
    "nparam": 1,
    "samples": 1,
    "builtin": 1,
    "channels": 4103,
    "aux": "D:\\微信文档\\mandelbrot\\appdata\\texturesgl.jpg"
  },
  {
    "name": "Iteration (Copy)",
    "codegl": "vec4 color(Data data)\n{\n    vec3 c;\nif(data.iter>=0)\n    c = pal(float(data.iter)+0.5, params.brightnessfinite\/params.brightnessfactor);\nelse\n    c = pal(float(-data.iter)+0.5, params.brightnessinfinite\/params.brightnessfactor);\nreturn vec4(c, 1.0);\n}\n",
    "samples": 2,
    "builtin": 0,
    "channels": 1
  }
]
`;

export const REFERENCE_COLORSCHEMES = JSON.parse(REFERENCE_COLORSCHEMES_JSON);
