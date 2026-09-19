"""Deterministic edit, ASCII motion graphics, original score and H.264 master.

python finish.py /tmp/void-teaser /path/to/output
Requires Pillow, NumPy, fontTools[brotli], ffmpeg and the Blender frame render.
"""
import math
import subprocess
import sys
import wave
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
from fontTools.ttLib import TTFont

WORK=Path(sys.argv[1]); OUT=Path(sys.argv[2]);OUT.mkdir(parents=True,exist_ok=True)
ROOT=Path(__file__).resolve().parents[2]
W,H,FPS=1080,1920,30
PAPER=(246,240,227); ORANGE=(232,112,44); INK=(18,16,10)
CUTS=[0,.375,.75,1.5,2.25,3,3.75,4.5,5.25,6,6.75,7.5,8.25,9,9.75,10.125,10.5,12.375]
for name in ['inter','instrument-serif','jetbrains-mono']:
    p=ROOT/'site/fonts'/f'{name}-latin-400-normal.woff2'
    f=TTFont(p);f.flavor=None;f.save(WORK/f'{name}.ttf')

@lru_cache(maxsize=128)
def font(size,kind='mono'):
    name={'mono':'jetbrains-mono','serif':'instrument-serif','sans':'inter'}[kind]
    return ImageFont.truetype(str(WORK/f'{name}.ttf'),size)

def text(draw,xy,s,size=30,color=PAPER,kind='mono',center=False,maxwidth=880):
    f=font(size,kind)
    while draw.textlength(s,font=f)>maxwidth:
        size-=1;f=font(size,kind)
    x,y=xy
    if center:x-=draw.textlength(s,font=f)/2
    draw.text((x,y),s,font=f,fill=color,stroke_width=0)

def tracked(draw,s,y,size=29,gap=8,color=PAPER):
    f=font(size);width=sum(draw.textlength(c,font=f) for c in s)+(len(s)-1)*gap
    x=(W-width)/2
    for c in s:
        draw.text((x,y),c,font=f,fill=color);x+=draw.textlength(c,font=f)+gap

def corners(draw,b,color=ORANGE,width=2,length=30):
    x,y,r,bottom=b
    for px,py,sx,sy in [(x,y,1,1),(r,y,-1,1),(x,bottom,1,-1),(r,bottom,-1,-1)]:
        draw.line([(px,py+sy*length),(px,py),(px+sx*length,py)],fill=color,width=width)

def hud(draw,t,section):
    text(draw,(82,240),'[ VOID ]',28,ORANGE)
    text(draw,(810,240),f'{section:02d} / 05',22)
    draw.line((82,292,952,292),fill=(89,70,47),width=1)
    text(draw,(82,1530),'AGENT ACCOUNTABILITY / REDEFINED',19,(171,154,125))
    for i in range(5):
        x=82+i*176
        draw.rectangle((x,1585,x+148,1588),fill=ORANGE if i<section else (69,58,41))
    text(draw,(82,1620),f'VOID_SYSTEM  //  {int(t*30):04d}',16,(125,111,87))
    text(draw,(784,1620),'SIGNAL: LIVE',16,(125,111,87))

def ascii_layer(base,t,strong=False):
    # Luminance-derived glyphs follow the actual 3D scene, not random static.
    small=np.asarray(base.resize((60,88)).convert('L'))
    layer=Image.new('RGBA',(W,H));d=ImageDraw.Draw(layer);chars=' .:-=+*#%@'
    for y in range(88):
        for x in range(60):
            v=int(small[y,x])
            if v<28 or (not strong and (x*7+y*13+int(t*12))%7):continue
            c=chars[min(9,v*10//256)]
            d.text((x*18,y*22),c,font=font(18),fill=(*ORANGE,min(200,v+25) if strong else 85))
    return layer

def compose(frame):
    t=frame/FPS
    base=Image.open(WORK/'frames'/f'{frame:04d}.png').convert('RGB')
    # Optical speed punches, distinct from the animated camera cuts.
    dt=min(abs(t-c) for c in CUTS)
    if dt<.085 and t<10.5:
        z=1+.10*(1-dt/.085);nw,nh=int(W*z),int(H*z)
        base=base.resize((nw,nh),Image.Resampling.BICUBIC).crop(((nw-W)//2,(nh-H)//2,(nw+W)//2,(nh+H)//2))
        for j in range(6):
            y=(frame*67+j*251)%H;hh=8+j*5
            strip=base.crop((0,y,W,min(H,y+hh)))
            base.paste(ImageChops.offset(strip,(-1 if j%2 else 1)*(30+j*12),0),(0,y))
    base=base.convert('RGBA')
    if t<9.75:
        strong=(t<.3 or (int(t*30)%45 in [0,1,2,3]))
        glyphs=ascii_layer(base,t,strong)
        if strong and t>.3:
            base=Image.alpha_composite(base,Image.new('RGBA',(W,H),(*INK,190)))
        base=Image.alpha_composite(base,glyphs)
    # Quiet zones protect copy against the deliberately busy 3D environment.
    yy=np.arange(H,dtype=np.float32)
    alpha=(np.exp(-((yy-1370)/370)**2)*195+np.exp(-((yy-240)/240)**2)*120).clip(0,220).astype('uint8')
    shade=Image.new('RGBA',(W,H),(18,16,10,0));shade.putalpha(Image.fromarray(np.repeat(alpha[:,None],W,axis=1)))
    base=Image.alpha_composite(base,shade)
    layer=Image.new('RGBA',(W,H));d=ImageDraw.Draw(layer)
    section=1 if t<3 else 2 if t<5.25 else 3 if t<7.5 else 4 if t<9.75 else 5
    hud(d,t,section)
    # Moving measuring ticks and sparse terminal addresses remain in the margins.
    if t<9.75:
        for j in range(12):
            y=370+j*88
            d.line((48,y,59+(j%3)*6,y),fill=(*ORANGE,100),width=1)
        for j in range(6):
            text(d,(86,370+j*27),f'{(frame*117+j*7919)%65536:04X}  /  '+['INTERCEPT','CLASSIFY','POLICY','RECORD','VERIFY','REPLAY'][j],15,(*PAPER,110))
    if t<1.5:
        text(d,(W/2,680),'AI moves',150,kind='serif',center=True)
        text(d,(W/2,825),'fast.',242,ORANGE,kind='serif',center=True)
        tracked(d,'WHO CONTROLS THE WRITE?',1190,24,4)
    elif t<3:
        text(d,(W/2,740),'Keep',184,kind='serif',center=True)
        text(d,(W/2,918),'control.',190,ORANGE,kind='serif',center=True)
        tracked(d,'THE CONTROL LAYER',1210,33,3)
        tracked(d,'FOR AI AGENTS',1260,33,3,ORANGE)
    elif t<5.25:
        corners(d,(220,654,860,966),width=3,length=45)
        text(d,(540,682),'TOOL WRITE / INTERCEPTED',20,center=True)
        tracked(d,'HOLD',757,124,18,ORANGE)
        text(d,(540,917),'[ WAITING FOR YOUR APPROVAL ]',18,center=True)
        text(d,(82,1120),'You approve.',137,kind='serif')
        text(d,(86,1300),'Policy checks before tool writes.',35)
        text(d,(86,1370),'ALLOW  /  HOLD  /  DENY',22,ORANGE)
    elif t<7.5:
        # A signed chain: moving light travels across links on every beat.
        pts=[(250,700),(540,610),(830,740),(640,940),(280,960)]
        for a,b in zip(pts,pts[1:]):d.line((a,b),fill=(*ORANGE,170),width=2)
        for j,(x,y) in enumerate(pts):
            r=27;d.rectangle((x-r,y-r,x+r,y+r),outline=PAPER,width=2)
            if j==int((t-5.25)/.375)%5:d.rectangle((x-17,y-17,x+17,y+17),fill=ORANGE)
            text(d,(x-35,y+44),f'0{j+1}:SIGN',16,ORANGE)
        text(d,(82,1120),'Every action.',128,kind='serif')
        text(d,(82,1250),'On record.',128,ORANGE,kind='serif')
        text(d,(86,1413),'Signed, verifiable audit trail.',35)
    elif t<9.75:
        # Reverse playback in the camera matches the backward time readout.
        text(d,(540,637),'[ SNAPSHOT CAPTURED ]',23,ORANGE,center=True)
        d.line([(740,920),(740,792),(325,792)],fill=PAPER,width=12)
        d.line([(420,697),(325,792),(420,887)],fill=ORANGE,width=12)
        text(d,(540,982),f'REPLAY  /  T-{max(0,99-int((t-7.5)*44)):02d}',27,center=True)
        text(d,(82,1130),'Undo changes.',128,kind='serif')
        text(d,(86,1310),'Restore captured,',35)
        text(d,(86,1356),'reversible actions.',35)
        text(d,(86,1430),'REVIEW  /  RESTORE  /  VERIFY',22,ORANGE)
    elif t<10.5:
        tracked(d,'ENTER THE VOID',1370,36,8)
    else:
        text(d,(540,1142),'VOID',193,kind='serif',center=True)
        if t<12.375:
            tracked(d,'CONTROL FOR AI AGENTS',1390,32,3)
        else:
            tracked(d,'COMING SOON',1400,43,7,ORANGE)
    if dt<.065 and t<10.5:
        layer=ImageChops.offset(layer,18 if frame%2 else -18,0)
    base=Image.alpha_composite(base,layer)
    # Small orange splice flashes, no repetitive full-screen white strobe.
    if dt<.034 and t<10.5:
        splice=Image.new('RGBA',(W,H));sd=ImageDraw.Draw(splice)
        y=430+(frame*83)%950;sd.rectangle((0,y,W,y+16),fill=(*ORANGE,190))
        sd.rectangle((0,y+27,W,y+29),fill=(*PAPER,170));base=Image.alpha_composite(base,splice)
    arr=np.asarray(base.convert('RGB')).copy()
    arr[::4]=(arr[::4].astype(np.float32)*.91).astype('uint8')
    return Image.fromarray(arr)

def audio():
    sr=48000;n=15*sr;rng=np.random.default_rng(583)
    mix=np.zeros((n,2),dtype=np.float64)
    def add(start,sound,gain=1,pan=0):
        i=int(start*sr);end=min(n,i+len(sound))
        if i<0 or end<=i:return
        a=sound[:end-i]*gain
        mix[i:end,0]+=a*math.sqrt((1-pan)/2);mix[i:end,1]+=a*math.sqrt((1+pan)/2)
    def timeline(d):return np.arange(int(sr*d))/sr
    # 160 BPM industrial pulse, synthesized specifically for this edit.
    for beat in range(33):
        at=beat*.375
        x=timeline(.32)
        kick=np.sin(2*np.pi*(46*x+3.2*(1-np.exp(-x*35))))*np.exp(-x*15)
        kick+=rng.normal(0,.12,len(x))*np.exp(-x*160)
        add(at,np.tanh(kick*2.5),.6)
        if beat%2:
            x=timeline(.17);noise=rng.normal(0,1,len(x));noise=np.concatenate(([0],np.diff(noise)))
            add(at,noise*np.exp(-x*32),.10)
        for sub in [0,.1875]:
            x=timeline(.065);noise=rng.normal(0,1,len(x));noise=np.concatenate(([0],np.diff(noise)))
            add(at+sub,noise*np.exp(-x*80),.028,(-.4 if beat%2 else .4))
        x=timeline(.30);freq=[46.249,46.249,55,41.203][(beat//4)%4]
        bass=sum(np.sin(2*np.pi*freq*k*x)/k for k in [1,2,3,5,7])
        add(at+.035,np.tanh(bass*1.6)*np.exp(-x*8)*(1-np.exp(-x*100)),.18)
    for j,c in enumerate(CUTS[1:]):
        x=timeline(.18);noise=rng.normal(0,1,len(x));filtered=np.convolve(noise,np.ones(12)/12,'same')
        add(max(0,c-.16),filtered*np.linspace(0,1,len(x))**2,.38,(-.3 if j%2 else .3))
        x=timeline(.065);add(c,np.sin(2*np.pi*(1500*x+2400*x*x))*np.exp(-x*80),.065)
    # Intro sub swell and final ident impact with a long stereo tail.
    x=timeline(1.5);add(0,np.sin(2*np.pi*32.7*x)*np.sin(np.pi*x/1.5),.17)
    x=timeline(2.625)
    impact=np.sin(2*np.pi*(38*x+2.7*(1-np.exp(-x*12))))*np.exp(-x*2.4)
    add(12.375,impact,.9)
    for freq,pan in [(138.59,-.55),(207.65,.55),(277.18,-.2)]:
        add(12.375,np.sin(2*np.pi*freq*x)*np.exp(-x*1.8)*(1-np.exp(-x*15)),.075,pan)
    mix=np.tanh(mix*1.15)
    fade=np.minimum(1,np.arange(n)/240)*np.minimum(1,np.arange(n)[::-1]/4800)
    mix*=fade[:,None];mix*=.88/max(.001,np.abs(mix).max())
    with wave.open(str(WORK/'score.wav'),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(sr);f.writeframes((mix*32767).astype('<i2').tobytes())

def main():
    if '--stills' in sys.argv:
        frames=[18,65,115,184,255,301,343,418]
        thumbs=[]
        for frame in frames:
            im=compose(frame);im.save(OUT/f'frame-{frame:03}.jpg',quality=94);thumbs.append(im.resize((270,480)))
        sheet=Image.new('RGB',(1080,960))
        for i,im in enumerate(thumbs):sheet.paste(im,((i%4)*270,(i//4)*480))
        sheet.save(OUT/'storyboard.jpg',quality=94);return
    audio()
    cmd=['ffmpeg','-y','-hide_banner','-loglevel','warning','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r','30','-i','-','-i',str(WORK/'score.wav'),'-map','0:v','-map','1:a','-vf','scale=out_color_matrix=bt709:out_range=tv,setsar=1','-c:v','libx264','-preset','slow','-crf','17','-profile:v','high','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','aac','-b:a','320k','-af','loudnorm=I=-14:TP=-1:LRA=8','-ar','48000','-t','15','-movflags','+faststart',str(OUT/'VOID-TEASER-1080x1920.mp4')]
    p=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    for f in range(450):
        im=compose(f);p.stdin.write(im.tobytes())
        if f%30==0:print(f'FINISH {f}/450',flush=True)
        if f==418:im.save(OUT/'VOID-TEASER-cover.jpg',quality=96)
    p.stdin.close();assert p.wait()==0,'FFmpeg export failed'

if __name__=='__main__':main()
