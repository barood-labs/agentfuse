"""Render docs/demo.gif from a captured `npm run demo` transcript:
   NO_COLOR=1 npm run demo > t.txt 2>&1; python3 docs/make_gif.py t.txt
The demo runs against a local MOCK API ($0). It is a rendering of real agentfuse output, not a screen recording."""
import re, sys
from PIL import Image, ImageDraw, ImageFont
raw = [l.rstrip('\n') for l in open(sys.argv[1], encoding='utf8')]
lines = [re.sub(r'\x1b\[[0-9;]*m', '', re.sub(r'/tmp/[^ ]*/receipts', '~/.agentfuse/receipts', l)) for l in raw]
lines = [l for l in lines if not l.startswith('>') and 'upstream:' not in l]  # npm banner, mock-upstream notice
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 15)
small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 13)
W, LH, PAD = 1000, 21, 16
prompt = '$ npx github:barood-labs/agentfuse --cap 1 -- node runaway-agent.js'
caption = 'Simulated demo: real agentfuse output against a local mock API (npm run demo). $0 spent.'
H = PAD * 2 + LH * (len(lines) + 4)
BG, FG = (24, 25, 33), (220, 222, 230)
def col(l):
    if 'FUSE BLOWN' in l or 'stopping agent' in l or 'pre-flight' in l: return (255, 95, 95)
    if l.startswith('⚠') or 'unknown price' in l: return (240, 200, 80)
    if l.startswith('⚡'): return (110, 220, 130)
    if l.startswith('agent:'): return (150, 160, 180)
    if 'receipt' in l: return (130, 190, 255)
    return FG
def frame(n):
    im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]): d.ellipse((PAD + i * 20, 10, PAD + i * 20 + 12, 22), fill=c)
    d.text((PAD + 70, 8), caption, font=small, fill=(140, 145, 165))
    y = PAD + 22
    d.text((PAD, y), prompt, font=font, fill=(200, 200, 255)); y += LH * 1.5
    for l in lines[:n]:
        d.text((PAD, y), l, font=font, fill=col(l)); y += LH
    return im
frames, durs = [], []
for n in range(1, len(lines) + 1):
    frames.append(frame(n)); durs.append(1200 if 'FUSE BLOWN' in lines[n-1] else 280)
durs[-1] = 3500
frames[0].save('docs/demo.gif', save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)
frames[-1].save('docs/demo.png')
print('ok', len(frames))
