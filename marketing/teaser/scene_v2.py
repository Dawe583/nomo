"""VOID v2: six animated 3D sets, physical typography and deterministic effects.

Prepare fonts with finish_v2.py --prepare, then run with Blender 4.5 LTS:
blender -b --python marketing/teaser/scene_v2.py -- /tmp/void-teaser-v2/frames
Add --preview to render only the editorial contact-sheet frames.
"""
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector, Matrix

sys.path.insert(0,str(Path(__file__).parent))
import scene as base

S=base.scene; C=base.camera; OUT=base.OUT
S.eevee.taa_render_samples=32
S.render.image_settings.compression=20
base.glow.inputs['Threshold'].default_value=2.2
base.glow.inputs['Strength'].default_value=.22
base.glow.inputs['Size'].default_value=.3
random.seed(20260920)
TAU=math.tau
fonts={k:bpy.data.fonts.load(str(OUT.parent/f'{v}.ttf')) for k,v in [('serif','instrument-serif'),('mono','jetbrains-mono')]}
cream=base.material('Type | illuminated ivory',(.9,.84,.71),.45,.24,.45)
orange=base.material('Type | hot copper',(.88,.20,.025),.4,.25,.6)
# View-dependent bevel shading keeps small 3D copy crisp under every set's lights.
for mat,color in [(cream,(.90,.84,.71,1)),(orange,(.88,.20,.025,1))]:
    nodes=mat.node_tree.nodes;nodes.clear()
    facing=nodes.new('ShaderNodeLayerWeight');facing.inputs['Blend'].default_value=.35
    mix=nodes.new('ShaderNodeMixRGB');mix.inputs[1].default_value=color
    mix.inputs[2].default_value=(color[0]*.24,color[1]*.24,color[2]*.24,1)
    emission=nodes.new('ShaderNodeEmission');emission.inputs['Strength'].default_value=1
    output=nodes.new('ShaderNodeOutputMaterial')
    mat.node_tree.links.new(facing.outputs['Facing'],mix.inputs[0])
    mat.node_tree.links.new(mix.outputs[0],emission.inputs[0])
    mat.node_tree.links.new(emission.outputs[0],output.inputs['Surface'])
dim=base.material('Circuit | low amber',(.46,.14,.025),.6,.3,.5)
signal=base.material('Circuit | pulse',(1,.23,.028),.25,.26,3.5)
steel=base.material('Structure | tungsten',(.13,.12,.105),.8,.22)
sets=[list(base.city),[],[],[],[],list(base.hero)]
roots=[]
for i in range(6):
    o=bpy.data.objects.new(f'SET_{i:02}',None);S.collection.objects.link(o);roots.append(o)
for o in base.hero:o.parent=roots[5]
for o in base.city:o.parent=roots[0]
for o in base.city_lights:o.hide_render=True
for o in base.lights:o.data.energy*=.8

def put(o,group,parent=None):
    sets[group].append(o);o.parent=parent or roots[group];return o

def box(name,pos,size,mat,group,bevel=.025,parent=None):
    o=base.box(name,pos,size,mat,[],bevel);return put(o,group,parent)

def tube(name,points,radius,mat,group,parent=None,closed=False):
    curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.resolution_u=1
    curve.bevel_depth=radius;curve.bevel_resolution=2
    spline=curve.splines.new('POLY');spline.points.add(len(points)-1)
    for p,v in zip(spline.points,points):p.co=(*v,1)
    spline.use_cyclic_u=closed
    ob=bpy.data.objects.new(name,curve);S.collection.objects.link(ob);ob.data.materials.append(mat)
    return put(ob,group,parent)

def ring(name,radius,group,mat=signal,wire=.025,arc=TAU,parent=None):
    n=max(8,int(96*arc/TAU))
    return tube(name,[(radius*math.cos(i*arc/n),radius*math.sin(i*arc/n),0) for i in range(n+1)],wire,mat,group,parent,arc==TAU)

def letters(name,body,pos,size,mat,group,font='mono',parent=None,depth=.02):
    curve=bpy.data.curves.new(name,'FONT');curve.body=body;curve.font=fonts[font]
    curve.size=size;curve.align_x='CENTER';curve.align_y='CENTER'
    curve.extrude=depth;curve.bevel_depth=.0012 if font=='mono' else .003;curve.bevel_resolution=2;curve.resolution_u=8
    ob=bpy.data.objects.new(name,curve);S.collection.objects.link(ob);ob.location=pos;ob.data.materials.append(mat)
    return put(ob,group,parent)

def frame(name,radius,z,group,mat=signal,wire=.035,parent=None):
    return tube(name,[(-radius,-radius,z),(radius,-radius,z),(radius,radius,z),(-radius,radius,z)],wire,mat,group,parent,True)

# 01 / Hyperspace apertures, dimensional terminal ribbons and rolling shutters.
gates=[]
for i in range(28):
    gate=frame('Warp aperture',4.25,0,0,signal,.024)
    gate.rotation_euler.x=math.pi/2;gate.location.y=i*4.3
    gates.append(gate)
glyphs=[]
for i in range(44):
    ob=letters('ASCII data ribbon',''.join(random.choice('01[]:/+#') for _ in range(24)),(random.choice([-3.8,3.8]),i*2.8,random.uniform(-3,3)),.20,dim,0)
    ob.rotation_euler=(math.pi/2,0,random.choice([-.12,.12]));glyphs.append(ob)

# 02 / A gimbal core with asymmetric machining and counter-rotating rings.
gimbals=[]
for i,radius in enumerate([2.0,2.65,3.25,3.7]):
    parent=bpy.data.objects.new('Gimbal axis',None);S.collection.objects.link(parent);parent.parent=roots[1]
    ob=ring('Orbital conductor',radius,1,signal if i%2 else steel,.038 if i%2 else .075,parent=parent)
    for j in range(16):
        a=j*TAU/16
        q=box('Ring tick',(radius*math.cos(a),radius*math.sin(a),0),(.15,.06,.09),cream if j%4==0 else dim,1,.01,parent)
        q.rotation_euler.z=a
    gimbals.append(parent)
core=[]
for original in base.hero:
    ob=original.copy();ob.data=original.data.copy();S.collection.objects.link(ob);ob.parent=roots[1]
    ob.scale=(.46,.46,.46);sets[1].append(ob);core.append(ob)
for i in range(18):
    a=i*TAU/18
    ob=box('Orbiting processor',(4.1*math.cos(a),4.1*math.sin(a),-.5),(.28,.65,.15),base.bronze,1)
    ob.rotation_euler.z=a
ring('Core reticle',1.35,1,dim,.012)

# 03 / A physical policy gate: write packets stop, jaws unlock, packets pass.
jaws=[];packets=[]
for sign in [-1,1]:
    parent=bpy.data.objects.new('Policy gate jaw',None);S.collection.objects.link(parent);parent.parent=roots[2];jaws.append((parent,sign))
    for j in range(8):
        y=(j-3.5)*.7
        box('Shield plate',(sign*2.2,y,-.2),(.85,.62,.65),steel,2,.065,parent)
        box('Plate signal',(sign*1.75,y,.17),(.035,.42,.055),signal,2,.008,parent)
    box('Gate lintel',(sign*1.1,3.1,-.2),(2.3,.4,.65),base.bronze,2,.035,parent)
    box('Gate lintel',(sign*1.1,-3.1,-.2),(2.3,.4,.65),base.bronze,2,.035,parent)
for x in range(-3,4):
    for y in range(-3,4):
        box('Policy force field',(x*.52,y*.62,0),(.026,.38,.026),dim,2,.003)
for j in range(35):
    pos=(random.uniform(-1.4,1.4),random.uniform(-1.9,1.9),random.uniform(1.3,7.5))
    ob=box('Write packet',pos,(.18,.18,.18),signal if j%3==0 else base.paper,2,.018)
    packets.append((ob,Vector(pos),j))
hold=letters('Gate decision','HOLD',(0,.2,.6),.8,orange,2,depth=.05)
allow=letters('Gate decision','ALLOW',(0,.2,.6),.8,cream,2,depth=.05)

# 04 / Signed ledger: stacked processors connected by a luminous 3D helix.
nodes=[];chainpoints=[]
for i in range(7):
    a=i*.82;pos=Vector((math.sin(a)*2.25,(i-3)*.91,math.cos(a)*.9))
    chainpoints.append(pos)
    ob=box('Signed ledger block',pos,(1.0,.57,.36),steel,3,.055);ob.rotation_euler=(.08,-.13,a*.05)
    nodes.append(ob)
    frameob=frame('Signature outline',.37,0,3,signal,.02);frameob.location=pos+Vector((0,0,.23));frameob.scale.y=.54
    letters('Ledger signature',f'0{i+1}:SIGNED',pos+Vector((0,0,.255)),.13,cream,3,depth=.004)
    if i:
        p0=chainpoints[i-1];p1=pos
        points=[p0.lerp(p1,j/12)+Vector((math.sin(j/12*math.pi)*.3,0,.12)) for j in range(13)]
        tube('Cryptographic link',points,.035,signal,3)
tracer=box('Hash pulse',chainpoints[0],(.16,.16,.16),base.white,3,.04)
ledger_rings=[]
for i in range(3):
    ob=ring('Verification arc',3.6+i*.35,3,dim,.015,TAU*.75)
    ob.rotation_euler=(.5+i*.45,.2,i*1.2);ledger_rings.append(ob)

# 05 / Reversible fragments: a voxel monolith reconstructs its captured state.
fragments=[]
for x in range(-3,4):
    for y in range(-3,4):
        for z in range(-2,3):
            home=Vector((x*.44,y*.44,z*.44));rng=random.Random((x+4)*701+(y+4)*71+z+3)
            direction=Vector((rng.uniform(-1,1),rng.uniform(-1,1),rng.uniform(-1,1))).normalized()
            travel=direction*rng.uniform(1.6,5)
            ob=box('Captured voxel',home,(.41,.41,.41),base.orange if (x+y+z)%5==0 else steel,4,.023)
            fragments.append((ob,home,travel,Vector((rng.random()*4,rng.random()*4,rng.random()*4))))
restore_rings=[]
for i in range(4):
    ob=ring('Snapshot orbit',2.7+i*.45,4,signal if i==0 else dim,.014,TAU*.82)
    ob.rotation_euler=(i*.4,.5,i*1.6);restore_rings.append(ob)

# 06 / Brand machining, exploded assembly, radial traces and a physical end card.
hero_centers={o:sum((v.co for v in o.data.vertices),Vector())/len(o.data.vertices) for o in base.hero}
hero_rings=[]
for i in range(4):
    ob=ring('Brand halo',3.3+i*.45,5,dim if i%2 else signal,.018,TAU*.83)
    ob.location.z=-1.1-i*.2;hero_rings.append(ob)
for i in range(48):
    a=i*TAU/48;r=4.85
    ob=box('Brand radial fin',(r*math.cos(a),r*math.sin(a),-1.6),(.3,.022,.06),base.bronze if i%3 else signal,5,.008)
    ob.rotation_euler.z=a

# All copy is extruded 3D geometry, lit in camera space. This keeps essential
# reading positions stable while the sets and cameras move aggressively.
copy=[]
def copyline(body,y,size,mat=cream,kind='serif',start=0,end=15,depth=.035):
    ob=letters('Campaign type',body,(0,y,-10),size,mat,0,kind,C,depth)
    sets[0].remove(ob)
    bpy.context.view_layer.update()
    if ob.dimensions.x>6.35:ob.scale*=6.35/ob.dimensions.x
    copy.append((ob,start,end,Vector(ob.location),Vector(ob.scale)))
    return ob

copyline('VOID  /  SYSTEM ONLINE',4.72,.18,orange,'mono',0,9.75)
copyline('AI moves',.55,1.4,start=0,end=1.5)
copyline('fast.',-.75,1.95,orange,start=0,end=1.5)
copyline('Keep control.',-2.8,1.28,start=1.5,end=3)
copyline('THE CONTROL LAYER FOR AI AGENTS',-3.75,.26,cream,'mono',1.5,3)
copyline('You approve.',-2.8,1.22,start=3,end=5.25)
copyline('POLICY CHECKS BEFORE TOOL WRITES',-3.77,.26,cream,'mono',3,5.25)
copyline('Signed.',-2.78,1.5,start=5.25,end=7.5)
copyline('EVERY ACTION. ON RECORD.',-3.70,.26,cream,'mono',5.25,7.5)
copyline('VERIFIABLE AUDIT TRAIL',-4.17,.19,orange,'mono',5.25,7.5)
copyline('Undo changes.',-2.80,1.19,start=7.5,end=9.75)
copyline('RESTORE CAPTURED,',-3.65,.26,cream,'mono',7.5,9.75)
copyline('REVERSIBLE ACTIONS',-4.06,.26,cream,'mono',7.5,9.75)
copyline('ENTER THE VOID',-3.5,.34,orange,'mono',9.75,10.5)
copyline('VOID',-2.68,1.75,start=10.5,end=15)
copyline('CONTROL FOR AI AGENTS',-3.80,.25,cream,'mono',10.5,12.375)
copyline('COMING SOON',-3.87,.37,orange,'mono',12.375,15)
copyline('APPROVE  /  AUDIT  /  UNDO',-4.8,.14,dim,'mono',1.5,12.375)

# The light rig for dimensional typography moves with the camera.
type_light=base.area('Typography softbox',(-3,4,-5),60,(1,.83,.60),4,(0,0,-10))
type_light.parent=C
type_rim=base.area('Typography edge',(4,-1,-8),40,(1,.29,.055),2,(0,0,-10))
type_rim.parent=C

# Camera-space particle trajectories give foreground parallax in every set.
particles=[]
for i in range(115):
    ob=base.box('Foreground signal shard',(0,0,0),(.016,.016,random.uniform(.06,.4)),signal if i%3 else base.paper,[],0)
    ob.parent=C
    particles.append((ob,random.uniform(-7,7),random.uniform(-9,9),random.uniform(0,1),random.uniform(.6,1.8)))

# Low-intensity world geometry provides depth behind the four feature sets.
background=[]
backroot=bpy.data.objects.new('Data observatory',None);S.collection.objects.link(backroot)
gridmat=base.material('Observatory grid',(.045,.030,.014),.25,.5,.12)
for x in range(-14,15,2):
    ob=tube('World grid',[(x,-4.3,5),(x,-4.3,-25)],.009,gridmat,1,backroot)
    sets[1].remove(ob);background.append(ob)
for z in range(-24,7,2):
    ob=tube('World grid',[(-14,-4.3,z),(14,-4.3,z)],.009,gridmat,1,backroot)
    sets[1].remove(ob);background.append(ob)
for i in range(64):
    ob=box('Distant processor',(random.uniform(-12,12),random.uniform(-2,10),random.uniform(-24,-8)),(.18,.4,.12),dim if i%6==0 else steel,1,.012,backroot)
    sets[1].remove(ob);background.append(ob)
for i in range(12):
    ob=letters('Spatial ASCII',f'[ {i*583:04X} ]  01:/#',(random.choice([-6,6]),i*.85-3,-6),.23,dim,1,parent=backroot,depth=.004)
    sets[1].remove(ob);background.append(ob)

# Camera-space metal shutters make the major edits physical 3D transitions.
shutters=[]
for side in [-1,1]:
    ob=base.box('Iris transition plate',(side*2,0,-2),(.86,3.1,.05),base.coal,[],.009);ob.parent=C
    edge=base.box('Iris luminous edge',(0,0,0),(.018,3.1,.015),signal,[],0);edge.parent=ob;edge.location=(-side*.42,0,.04)
    shutters.append((ob,edge,side))

def clamp(x):return min(1,max(0,x))
def smooth(x):x=clamp(x);return x*x*(3-2*x)
def aim(pos,target=(0,0,0),roll=0):
    C.location=pos
    forward=(Vector(target)-C.location).normalized()
    world_up=Vector((0,0,1)) if abs(forward.y)>.95 else Vector((0,1,0))
    right=forward.cross(world_up).normalized();up=right.cross(forward)
    C.rotation_euler=Matrix((right,up,-forward)).transposed().to_euler()
    C.rotation_euler.rotate_axis('Z',roll)

def animate(f):
    t=f/30
    group=0 if t<1.5 else 1 if t<3 else 2 if t<5.25 else 3 if t<7.5 else 4 if t<9.75 else 5
    for i,objects in enumerate(sets):
        for ob in objects:ob.hide_render=i!=group
    for i,root in enumerate(roots):
        root.location=(0,0,0);root.rotation_euler=(0,0,0);root.scale=(1,1,1)
    for ob in base.city_lights:ob.hide_render=group!=0
    for ob in base.lights:ob.hide_render=group==0
    for ob in background:ob.hide_render=group in [0,5]
    backroot.rotation_euler.y=.025*math.sin(t)
    C.data.lens=45;C.data.shift_y=0
    beat=int(t/.375);phase=(t%.375)/.375
    pulse=math.exp(-phase*11)
    if group==0:
        travel=12+t*26
        aim((math.sin(t*3)*.8,travel,.7*math.cos(t*2)),(0,travel+15,0),t*.65+int(t/.375)*.27)
        for i,ob in enumerate(gates):ob.rotation_euler.y=t*1.3+i*.13
    elif group==1:
        u=t-1.5;a=u*1.4-.8
        cut=-2.0 if u<.75 else 2.0
        aim((math.sin(a)*2+cut,1.5+math.sin(u*2)*1.1,14+math.cos(u*2)*1.0),(0,-.1,0),.08*math.sin(u*4))
        for i,ob in enumerate(gimbals):ob.rotation_euler=(t*(.5+i*.12),i*.7+t*(.7-i*.3),t*(-.6 if i%2 else .7))
        roots[1].rotation_euler.z=.08*math.sin(t)
    elif group==2:
        u=t-3;gate_open=smooth((u-1.3)/.6)
        cut=[-3.3,3.2,-.7][min(2,int(u/.75))]
        aim((cut+.6*math.sin(u*.7),1.2,15.5-.7*math.sin(u*2)),(0,-.35,0),-.08+.05*math.sin(u*3))
        for ob,sign in jaws:ob.location.x=sign*gate_open*1.4
        hold.hide_render=u>=1.5;allow.hide_render=u<1.5
        for ob,pos,j in packets:
            ob.location=pos+Vector((math.sin(t*2+j)*.04,0,-gate_open*(3.0+(j%5)*.6)))
            ob.rotation_euler=(t+j,t*.5,t*.8)
    elif group==3:
        u=t-5.25
        cut=[2.8,-3.2,1.2][min(2,int(u/.75))]
        aim((cut+math.sin(u*1.2),1,15.8),(0,-.25,0),.10*math.sin(u*2))
        roots[3].rotation_euler.y=-.20+u*.25
        for i,ob in enumerate(ledger_rings):ob.rotation_euler.z=t*(.25+i*.2)
        progress=(u*3)%6;k=int(progress)
        tracer.location=chainpoints[k].lerp(chainpoints[k+1],progress-k)+Vector((0,0,.3))
        tracer.scale=(1+pulse,)*3
    elif group==4:
        u=t-7.5;spread=1-smooth(u/1.8)
        cut=[-3.5,3.2,-1][min(2,int(u/.75))]
        aim((cut+.5*math.sin(u*1.8),1.8,15),(0,-.3,0),-.15*math.cos(u*2))
        roots[4].rotation_euler=(.2+u*.3,u*.65,.2)
        roots[4].location.y=.7;roots[4].scale=(.85,)*3
        for ob,home,travel,spin in fragments:
            ob.location=home+travel*spread
            ob.rotation_euler=spin*spread
            ob.scale=(1-.25*spread,)*3
        for i,ob in enumerate(restore_rings):ob.rotation_euler.z=-u*(1+i*.2)
    else:
        for ob in base.hero:ob.location=(0,0,0);ob.rotation_euler=(0,0,0)
        if t<10.5:
            shot=int((t-9.75)/.1875)
            positions=[(3.7,.7,3),(-2.5,2.8,3.5),(1,-3,3.2),(-3,-.3,3)]
            aim(positions[shot%4],(.35,.15,0),[-.5,.6,-.3,.45][shot%4])
            roots[5].rotation_euler=(.1,t*.4,.1)
        else:
            u=t-10.5;settle=smooth(u/1.7)
            spin=(1-settle)*TAU*.8
            roots[5].rotation_euler=(.22*(1-settle),spin,-.20*(1-settle))
            spread=(1-smooth(u/1.3))*1.0
            for ob,center in hero_centers.items():
                ob.location=center*spread
                ob.location.z+=(1-settle)*(.4 if center.length<.5 else -.3)
            aim((.6*(1-settle),.25,13.7-1.1*settle),(0,-2.0,0),0)
        for i,ob in enumerate(hero_rings):
            ob.rotation_euler=(.03,.06,t*(.3+i*.09)*(-1 if i%2 else 1))
            ob.scale=(1+(.04 if t<12.375 else .012)*math.sin(t*3+i),)*3
    # Type enters in a short depth sweep; subsequent motion is restrained so
    # feature copy remains readable even while the background accelerates.
    for ob,start,end,pos,scale in copy:
        ob.hide_render=not start<=t<end
        age=t-start;entry=1-smooth(age/.20)
        ob.location=pos+Vector((entry*.35,entry*.25,entry*.9))
        ob.rotation_euler=(entry*-.16,entry*.30,.012*math.sin(t*2) if t<9.75 else 0)
        ob.scale=scale*(1+entry*.1)
    for i,(ob,x,y,seed,speed) in enumerate(particles):
        age=(seed+t*speed*.14)%1
        ob.location=(x,y,-18+age*15)
        # Keep foreground shards out of the central reading corridor.
        ob.hide_render=(abs(x)<2.6 and -4.9<y<1.6) or (t>=12.375 and i%5!=0)
        ob.scale=(1,1,1+pulse*2)
    lastcut=max([c for c in [0,1.5,3,5.25,7.5,10.5] if c<=t])
    aperture=smooth((t-lastcut)/.13)
    for ob,edge,side in shutters:
        ob.hide_render=edge.hide_render=aperture>=1 or t<1.5
        ob.location.x=side*(.43+aperture*1.1)

if __name__=='__main__':
    frames=[18,64,111,174,240,287,300,326,350,410] if '--preview' in base.args else range(base.START,base.END+1)
    for f in frames:
        if (OUT/f'{f:04d}.png').exists():continue
        animate(f);S.render.filepath=str(OUT/f'{f:04d}.png')
        bpy.ops.render.render(write_still=True)
        print(f'VOID_V2_FRAME {f}',flush=True)
