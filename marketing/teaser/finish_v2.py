"""Finish the fully 3D v2 edit; preserve v1 and reuse its original score.

python marketing/teaser/finish_v2.py /tmp/void-teaser-v2 marketing/teaser --prepare
python marketing/teaser/finish_v2.py /tmp/void-teaser-v2 marketing/teaser
"""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw

WORK=Path(sys.argv[1]);WORK.mkdir(parents=True,exist_ok=True)
OUT=Path(sys.argv[2]);OUT.mkdir(parents=True,exist_ok=True)
import finish as first

CUTS=[0,.375,.75,1.125,1.5,2.25,3,3.75,4.5,5.25,6,6.75,7.5,8.25,9,9.75,9.9375,10.125,10.3125,10.5,11.25,12.375]

def score():
    first.CUTS=CUTS;first.audio()
    with wave.open(str(WORK/'score.wav'),'rb') as f:
        rate=f.getframerate();a=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(float).reshape(-1,2)/32768
    rng=np.random.default_rng(2077)
    # Additional micro-edits and stereo impact tails emphasize dimensional cuts.
    for j,t in enumerate(CUTS[1:]):
        n=int(rate*.11);x=np.arange(n)/rate
        s=np.sin(2*np.pi*(320*x+2200*x*x))*np.exp(-x*37)
        s+=rng.normal(0,.13,n)*np.exp(-x*70)
        start=int(t*rate);end=min(len(a),start+n)
        a[start:end,j%2]+=.075*s[:end-start]
    a=np.tanh(a*1.1);a*=.88/np.abs(a).max()
    with wave.open(str(WORK/'score-v2.wav'),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(rate);f.writeframes((a*32767).astype('<i2').tobytes())

def compose(f):
    im=Image.open(WORK/'frames'/f'{f:04d}.png').convert('RGB')
    t=f/30;dt=min(abs(t-cut) for cut in CUTS)
    # Finish only: every scene, glyph and title was already rendered in 3D.
    if dt<.046 and .2<t<10.5:
        for j in range(5):
            y=(f*47+j*367)%1920;h=6+j*4
            crop=im.crop((0,y,1080,min(1920,y+h)))
            im.paste(ImageChops.offset(crop,(1 if j%2 else -1)*(12+j*7),0),(0,y))
    return im

def main():
    if '--prepare' in sys.argv:
        print('Fonts prepared.');return
    if '--stills' in sys.argv:
        frames=[18,64,111,174,240,287,300,326,350,410]
        sheet=Image.new('RGB',(1350,960))
        for i,f in enumerate(frames):sheet.paste(compose(f).resize((270,480)),((i%5)*270,(i//5)*480))
        sheet.save(OUT/'v2-storyboard.jpg',quality=96);return
    score()
    target=OUT/'VOID-TEASER-V2-3D-1080x1920.mp4'
    cmd=['ffmpeg','-y','-hide_banner','-loglevel','warning',
         '-f','rawvideo','-pix_fmt','rgb24','-s','1080x1920','-r','30','-i','-',
         '-i',str(WORK/'score-v2.wav'),'-map','0:v','-map','1:a',
         '-vf','scale=out_color_matrix=bt709:out_range=tv,setsar=1',
         '-c:v','libx264','-preset','slow','-crf','16','-profile:v','high',
         '-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709',
         '-pix_fmt','yuv420p','-c:a','aac','-b:a','320k',
         '-af','loudnorm=I=-14:TP=-1:LRA=8','-ar','48000','-t','15',
         '-movflags','+faststart',str(target)]
    p=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    for f in range(450):
        im=compose(f);p.stdin.write(im.tobytes())
        if f==410:im.save(OUT/'VOID-TEASER-V2-cover.jpg',quality=96)
        if f%30==0:print(f'V2_FINISH {f}/450',flush=True)
    p.stdin.close();assert p.wait()==0,'FFmpeg export failed'

if __name__=='__main__':main()
