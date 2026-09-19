"""Validate the delivery contract and decode every frame of the exported master."""
import json
import subprocess
import sys

path=sys.argv[1]
data=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',path]))
video=next(s for s in data['streams'] if s['codec_type']=='video')
audio=next(s for s in data['streams'] if s['codec_type']=='audio')
assert (video['width'],video['height'])==(1080,1920)
assert video['codec_name']=='h264' and video['pix_fmt']=='yuv420p'
assert video['sample_aspect_ratio']=='1:1'
assert all(video[key]=='bt709' for key in ['color_space','color_transfer','color_primaries'])
assert video['r_frame_rate']=='30/1' and int(video['nb_read_frames'])==450
assert abs(float(data['format']['duration'])-15)<.05
assert audio['codec_name']=='aac' and audio['channels']==2 and audio['sample_rate']=='48000'
subprocess.run(['ffmpeg','-v','error','-xerror','-i',path,'-f','null','-'],check=True)
print('PASS: 1080x1920, 30 fps, 450 decoded frames, 15 seconds, H.264, stereo AAC 48 kHz.')
