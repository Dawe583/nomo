"""Original VOID geometry and cinematography. Run with Blender 4.5 LTS.

blender -b --python marketing/teaser/scene.py -- /tmp/void-teaser/frames [start] [end]
"""
import bpy
import math
import random
import sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
OUT = Path(args[0]); OUT.mkdir(parents=True, exist_ok=True)
START, END = (int(args[1]), int(args[2])) if len(args) > 2 else (0, 449)
random.seed(583)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 12
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 3
scene.cycles.device = 'GPU'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = d.type != 'CPU'
except Exception:
    scene.cycles.device = 'CPU'
scene.render.engine = 'CYCLES' if '--cycles' in args else 'BLENDER_EEVEE_NEXT'
scene.eevee.taa_render_samples = 24
scene.render.resolution_x = 1080; scene.render.resolution_y = 1920
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.fps = 30
scene.world.color = (.035, .028, .020)
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.009,.007,.004,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.3
scene.view_settings.view_transform = 'AgX'
scene.render.film_transparent = False

def material(name, color, metallic=0, rough=.3, emit=0):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color, 1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Metallic'].default_value=metallic
    p.inputs['Roughness'].default_value=rough
    p.inputs['Emission Color'].default_value=(*color,1)
    p.inputs['Emission Strength'].default_value=emit
    return m

coal=material('VOID | graphite',(.023,.019,.013),.8,.3)
bronze=material('VOID | burnt copper',(.34,.072,.009),.7,.24)
paper=material('VOID | warm ceramic',(.88,.82,.69),.65,.21)
orange=material('VOID | signal orange',(.95,.16,.014),.65,.22,.15)
signal=material('VOID | amber light',(1,.18,.018),.1,.3,7)
white=material('VOID | ivory light',(.95,.84,.62),.1,.3,4)
city=[]; hero=[]

def box(name,loc,scale,mat,group,bevel=0):
    vertices=[(x*scale[0]/2,y*scale[1]/2,z*scale[2]/2) for x,y,z in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    faces=[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    o=bpy.data.objects.new(name,mesh);scene.collection.objects.link(o);o.location=loc
    o.data.materials.append(mat); group.append(o)
    if bevel:
        mod=o.modifiers.new('Machined edges','BEVEL'); mod.width=bevel; mod.segments=3
        o.modifiers.new('Weighted reflections','WEIGHTED_NORMAL')
    return o

# A purpose-built data canyon; all geometry is original, with no stock footage.
for i in range(580):
    wall=i%4; y=random.uniform(-10,130); lateral=random.uniform(-5.3,5.3)
    depth=random.uniform(.3,1.75); wide=random.uniform(.3,1.15); length=random.uniform(.45,2.6)
    if wall<2:
        s=1 if wall==0 else -1; loc=(s*(5.5-depth/2),y,lateral); dims=(depth,length,wide)
        ploc=(s*(5.5-depth-.012),y,lateral); pdims=(.024,length*.68,wide*.28)
    else:
        s=1 if wall==2 else -1; loc=(lateral,y,s*(5.5-depth/2)); dims=(wide,length,depth)
        ploc=(lateral,y,s*(5.5-depth-.012)); pdims=(wide*.28,length*.68,.024)
    box('Data architecture',loc,dims,bronze if i%7==0 else coal,city)
    if i%3==0: box('Address light',ploc,pdims,white if i%11==0 else signal,city)

# Long copper conductors establish perspective at high speed.
for s in [-1,1]:
    for v in [-3.7,0,3.7]:
        box('Signal rail',(s*5.25,60,v),(.026,150,.026),signal,city)
        box('Signal rail',(v,60,s*5.25),(.026,150,.026),signal,city)

# Join by material to keep render scene evaluation small.
for mat in [coal,bronze,signal,white]:
    objects=[o for o in scene.objects if o.type=='MESH' and o.data.materials[0]==mat]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:o.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]; bpy.ops.object.join()
city=[o for o in bpy.context.scene.objects if o.type=='MESH']

def extrude(name,points,mat,depth=.42):
    n=len(points); verts=[((x-128)/25,(128-y)/25,z) for z in [-depth/2,depth/2] for x,y in points]
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,n*2))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new(name,mesh); scene.collection.objects.link(o);o.data.materials.append(mat)
    mod=o.modifiers.new('Precision bevel','BEVEL');mod.width=.035;mod.segments=4
    o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');hero.append(o);return o

# Same square-capped outer strokes as BrandMark in brand.tsx, not a substitute logo.
corner=[(65.5,65.5),(109.5,65.5),(109.5,80.5),(80.5,80.5),(80.5,109.5),(65.5,109.5)]
for sx,sy in [(1,1),(-1,1),(1,-1),(-1,-1)]:
    pts=[(128+sx*(x-128),128+sy*(y-128)) for x,y in corner]
    if sx*sy<0:pts.reverse()
    extrude('VOID aperture bracket',pts,paper)
# Continuous ring mesh prevents overlapping coplanar faces in the square stroke.
verts=[]
for z in [-.22,.22]:
    for radius in [1.04,.56]:
        verts += [(-radius,-radius,z),(radius,-radius,z),(radius,radius,z),(-radius,radius,z)]
faces=[]
for i in range(4):
    j=(i+1)%4
    faces += [(i,j,j+8,i+8),(i+4,i+12,j+12,j+4),(i+8,j+8,j+12,i+12),(i+4,j+4,j,i)]
mesh=bpy.data.meshes.new('Orange ring');mesh.from_pydata(verts,[],faces);mesh.update()
ring=bpy.data.objects.new('VOID centre square',mesh);scene.collection.objects.link(ring);ring.data.materials.append(orange);hero.append(ring)
mod=ring.modifiers.new('Precision bevel','BEVEL');mod.width=.025;mod.segments=4
ring.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.24,depth=.45,location=(0,0,0))
dot=bpy.context.object;dot.name='VOID centre dot';dot.data.materials.append(paper);hero.append(dot)
bev=dot.modifiers.new('Dot bevel','BEVEL');bev.width=.025;bev.segments=3
dot.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
bpy.ops.object.empty_add(); root=bpy.context.object;root.name='VOID logo assembly'
for o in hero:o.parent=root

def area(name,loc,power,color,size,target=(0,0,0)):
    data=bpy.data.lights.new(name,'AREA'); data.energy=power;data.color=color;data.shape='DISK';data.size=size
    o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.location=loc
    o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler();return o
lights=[area('Ivory softbox',(-4,5,7),1300,(1,.85,.65),5),area('Orange rim',(5,1,0),1800,(1,.22,.035),4),area('Top ribbon',(0,-4,4),1100,(1,.74,.40),3)]
city_lights=[]
for y in range(-4,140,9):
    data=bpy.data.lights.new('Data canyon bounce','POINT');data.energy=250;data.color=(1,.32,.09);data.shadow_soft_size=2
    o=bpy.data.objects.new(data.name,data);scene.collection.objects.link(o);o.location=(0,y,0);city_lights.append(o)
bpy.ops.object.camera_add(); camera=bpy.context.object;scene.camera=camera
camera.data.lens=35;camera.data.sensor_width=36
camera.data.sensor_fit='HORIZONTAL'
scene.use_nodes=True
nodes=scene.node_tree.nodes;nodes.clear();rl=nodes.new('CompositorNodeRLayers')
glow=nodes.new('CompositorNodeGlare');glow.glare_type='FOG_GLOW';glow.quality='MEDIUM';glow.threshold=1.4
glow.size=7
comp=nodes.new('CompositorNodeComposite');scene.node_tree.links.new(rl.outputs['Image'],glow.inputs['Image']);scene.node_tree.links.new(glow.outputs['Image'],comp.inputs[0])

def aim(pos,target,roll=0):
    camera.location=pos;camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler();camera.rotation_euler.rotate_axis('Z',roll)

def setup(frame):
    t=frame/30; ishero=t>=9.75
    for o in city:o.hide_render=ishero
    for o in hero:o.hide_render=not ishero
    for o in lights:o.hide_render=not ishero
    for o in city_lights:o.hide_render=ishero
    if not ishero:
        beat=int(t/.375); progress=t*7.8
        if t>=7.5:progress=75-(t-7.5)*13
        camera.data.lens=25 if beat%4 else 18
        bank=.13*math.sin(t*1.4)+math.floor(t/1.5)*.22
        aim((.5*math.sin(t*2),progress,.5*math.cos(t)),(0,progress+14,0),bank)
    else:
        root.rotation_euler=(.08,0,0)
        for o in hero:
            if o.name.startswith('VOID aperture bracket'):
                center=sum((v.co for v in o.data.vertices),Vector())/len(o.data.vertices)
                spread=max(0,1-(t-10.5)/.8)*.7 if t>=10.5 else 0
                o.location=(center.x*spread,center.y*spread,spread*.25)
        camera.data.lens=52
        if t<10.125:
            aim((3.0,-.1,2.6),(1.4,.8,0),-.5)
            root.rotation_euler=(0,t*.6,.1)
        elif t<10.5:
            aim((-2.0,2,3.4),(-1,-.2,0),.65)
            root.rotation_euler=(.1,-.4+(t-10.125),-.1)
        else:
            u=min(1,(t-10.5)/2.0); ease=1-(1-u)**3
            root.rotation_euler=(.18*(1-ease),1.15*(1-ease),-.24*(1-ease))
            aim((.25*(1-ease),.25,10.2+ease*2.7),(0,.1,0),0)
            # Move logo above the end-card copy, preserving vertical social safe area.
            camera.data.shift_y=-.18

if __name__=='__main__':
    for frame in range(START,END+1):
        if (OUT/f'{frame:04d}.png').exists():continue
        setup(frame);scene.render.filepath=str(OUT/f'{frame:04d}.png')
        bpy.ops.render.render(write_still=True)
        print(f'VOID_FRAME {frame}',flush=True)
