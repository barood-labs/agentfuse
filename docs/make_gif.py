"""Render docs/demo.gif from a captured `npm run demo` transcript (python3 docs/make_gif.py transcript.txt)."""
import sys
from PIL import Image, ImageDraw, ImageFont
lines = [l.rstrip('\n') for l in open(sys.argv[1], encoding='utf8')]
import re
lines = [re.sub(r'\x1b\[[0-9;]*m', '', re.sub(r'/tmp/[^/]+/receipts', '~/.agentfuse/receipts', l)) for l in lines]
for p in ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/dejavu/DejaVuSansMono.ttf']:
    try: font = ImageFont.truetype(p, 15); break
    except OSError: font = None
font = font or ImageFont.load_default()
W, LH, PAD = 980, 21, 16
prompt = '$ npx agentfuse --cap 1 -- node runaway-agent.js'
H = PAD * 2 + LH * (len(lines) + 3)
BG, FG = (24, 25, 33), (220, 222, 230)
def col(l):
    if 'FUSE BLOWN' in l or 'stopping agent' in l: return (255, 95, 95)
    if l.startswith('⚠') or 'unknown price' in l: return (240, 200, 80)
    if l.startswith('⚡'): return (110, 220, 130)
    if l.startswith('agent:'): return (150, 160, 180)
    if '🧾' in l or 'receipt' in l: return (130, 190, 255)
    return FG
def frame(n, typed=None):
    im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]): d.ellipse((PAD + i * 20, 10, PAD + i * 20 + 12, 22), fill=c)
    y = PAD + 22
    d.text((PAD, y), typed if typed is not None else prompt, font=font, fill=(200, 200, 255)); y += LH * 1.5
    for l in lines[:n]:
        clean = l.replace('⚡', '>').replace('⚠️', '!').replace('💥', '*').replace('🧾', '#')
        d.text((PAD, y), clean, font=font, fill=col(l)); y += LH
    return im
frames, durs = [], []
for k in range(0, len(prompt) + 1, 3): frames.append(frame(0, prompt[:k])); durs.append(40)
frames.append(frame(0)); durs.append(500)
for n in range(1, len(lines) + 1):
    frames.append(frame(n)); durs.append(900 if 'FUSE BLOWN' in lines[n-1] else 260)
durs[-1] = 4000
frames[0].save('docs/demo.gif', save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)
frames[-1].save('docs/demo.png')
print('ok', len(frames))
