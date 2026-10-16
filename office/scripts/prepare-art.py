"""Crop original generated assets, limit the palette and create integer-pixel atlases.
Run: PYTHONPATH=.cache/python python3 scripts/prepare-art.py (inside office).
Requires Pillow and no network. Source images remain unchanged.
"""
from pathlib import Path
import json
from PIL import Image, ImageFilter
ROOT = Path(__file__).resolve().parents[1] / 'public/assets'
source = Image.open(ROOT / 'source/furniture.png').convert('RGBA')
# Generation preserved object widths rather than equal cells; use reviewed crop bounds.
rows = [
 (0,385,[0,324,490,764,928,1109,1254]),
 (386,696,[0,210,360,638,874,1118,1254]),
 (697,953,[0,188,436,580,890,1120,1254]),
 (953,1254,[0,210,458,680,851,1045,1254]),
]
names = ['desk-pair','chair','window','painting','shelf','water','whiteboard','fridge','kitchen','dining','sofa','pouf','coffee','foosball','vending','meeting','screen','clock','door','reception','tree','palm','shrubs','divider']
widths = [192,32,112,48,48,32,48,40,160,112,144,40,64,80,48,192,128,32,80,144,80,48,80,80]

def clean(im):
 alpha=im.getchannel('A').point(lambda v: 255 if v >= 190 else 0)
 im.putalpha(alpha)
 # Remove the stray red generation border while preserving the orange product palette.
 px=im.load()
 for y in range(im.height):
  for x in range(im.width):
   r,g,b,a=px[x,y]
   if r>180 and g<55 and b<50: px[x,y]=(0,0,0,0)
 box=im.getchannel('A').getbbox()
 return im.crop(box) if box else im

def pixelate(im, width):
 height=round(im.height*width/im.width)
 im=im.resize((width,height), Image.Resampling.NEAREST)
 a=im.getchannel('A'); rgb=im.convert('RGB').quantize(colors=96,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE).convert('RGBA');rgb.putalpha(a)
 return rgb
atlas=Image.new('RGBA',(1024,1664));frames={}
for i,name in enumerate(names):
 row=i//6;col=i%6;y0,y1,xs=rows[row];im=clean(source.crop((xs[col],y0,xs[col+1],y1)));im=pixelate(im,widths[i]);x=(i%4)*256+2;y=(i//4)*128+2
 if name=="window": im=im.resize((112,64),Image.Resampling.NEAREST)
 # Fit the large tree and door inside their cells.
 if im.height>124: im=im.resize((round(im.width*124/im.height),124),Image.Resampling.NEAREST)
 atlas.alpha_composite(im,(x,y));frames[name]={'x':x,'y':y,'w':im.width,'h':im.height}
# Apply the existing furniture palette to new pieces, keeping wood,
# outline and ceramic tones consistent across both generations.
palette=atlas.crop((0,0,1024,768)).convert('RGB').quantize(colors=128,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE)
extension=Image.open(ROOT/'source/furniture-a1-5.png').convert('RGBA')
manifest=json.loads((ROOT/'source/furniture-a1-5.json').read_text())
for i,item in enumerate(manifest, start=len(names)):
 sheet=Image.open(ROOT/'source'/item['source']).convert('RGBA') if 'source' in item else extension
 raw=sheet.crop(tuple(item['crop']))
 # Discard the generated sheet’s low-alpha colored background and fringes;
 # preserve the actual object’s transparent cutout.
 alpha=raw.getchannel('A').point(lambda v: 255 if v >= 190 else 0)
 raw.putalpha(alpha);box=alpha.getbbox()
 if not box: raise ValueError(f"Empty source: {item['name']}")
 im=pixelate(raw.crop(box),item['width'])
 if im.height>124: im=im.resize((round(im.width*124/im.height),124),Image.Resampling.NEAREST)
 if item.get('outline'):
  # The large source has a thinner outline; add one dark pixel at atlas
  # scale to match the existing desk outline thickness.
  outlined=Image.new('RGBA',im.size,(47,39,30,255))
  outlined.putalpha(im.getchannel('A').filter(ImageFilter.MaxFilter(3)))
  outlined.alpha_composite(im);im=outlined
 x=(i%4)*256+2;y=(i//4)*128+2
 atlas.alpha_composite(im,(x,y));frames[item['name']]={'x':x,'y':y,'w':im.width,'h':im.height}
 if 'screens' in item:
  sx=im.width/(box[2]-box[0]);sy=im.height/(box[3]-box[1])
  frames[item['name']]['screens']=[{'x':round((s[0]-box[0])*sx),'y':round((s[1]-box[1])*sy),'w':round(s[2]*sx),'h':round(s[3]*sy)} for s in item['screens']]
# Screen boxes use native atlas pixels; each desk places the same
# runtime screen rendering inside its own monitor.
frames['desk-pair']['screens']=[{'x':38,'y':25,'w':34,'h':20},{'x':115,'y':25,'w':34,'h':20}]
alpha=atlas.getchannel('A'); atlas=atlas.convert('RGB').quantize(palette=palette,dither=Image.Dither.NONE).convert('RGBA');atlas.putalpha(alpha)
atlas.save(ROOT/'office-atlas.png')
(ROOT/'office-atlas.json').write_text(json.dumps({'image':'/assets/office-atlas.png','frames':frames},ensure_ascii=False,indent=2)+'\n')
source=Image.open(ROOT/'source/characters.png').convert('RGBA');w,h=source.size
atlas=Image.new('RGBA',(384,576));frames={};masks={}
styles=['kisa','uzun','topuz','kivircik','kel','sapkali'];poses=['down','up','left','right','walk','sit']
for row,style in enumerate(styles):
 for col,pose in enumerate(poses):
  im=clean(source.crop((round(col*w/6),round(row*h/6),round((col+1)*w/6),round((row+1)*h/6))))
  height=40 if pose=='sit' else 48;width=round(im.width*height/im.height)
  im=pixelate(im,width);cell=Image.new('RGBA',(32,48));cell.alpha_composite(im,((32-width)//2,48-height))
  # Separate palette mask: h=hair, s=skin, t=top, p=bottom; keep dark outlines fixed.
  mask=Image.new('RGBA',(32,48));px=cell.load();mp=mask.load()
  for y in range(48):
   for x in range(32):
    r,g,b,a=px[x,y]
    if not a or max(r,g,b)<42:continue
    if r>g*1.14 and r>b*1.4 and r>130: kind=1 # skin
    elif r>g*1.18 and r>b*1.05 and y<35:kind=2 # hair
    elif g>r*1.25 and b>r*1.18:kind=3 # shirt
    elif b>r*1.25 and b>g*1.02:kind=4 # pants
    else:continue
    mp[x,y]=(kind,round((max(r,g,b)/255)*200),0,255)
  # Three distinct frames per direction: fixed torso and mirrored lower body.
  for frame in range(3):
   out=cell.copy();mout=mask.copy()
   if pose in ['left','right','walk','down','up'] and frame==2:
    legs=out.crop((0,35,32,48)).transpose(Image.Transpose.FLIP_LEFT_RIGHT);out.paste(legs,(0,35));mout.paste(mout.crop((0,35,32,48)).transpose(Image.Transpose.FLIP_LEFT_RIGHT),(0,35))
   if frame==1 and pose in ['down','up']:
    bottom=out.crop((0,36,32,48));out.paste((0,0,0,0),(0,36,32,48));out.alpha_composite(bottom,(1,35))
    mb=mout.crop((0,36,32,48));mout.paste((0,0,0,0),(0,36,32,48));mout.alpha_composite(mb,(1,35))
   index=row*18+col*3+frame;x=(index%12)*32;y=(index//12)*64
   atlas.alpha_composite(out,(x,y));masks[f'{style}:{pose}:{frame}']=mout
   frames[f'{style}:{pose}:{frame}']={'x':x,'y':y,'w':32,'h':48}
alpha=atlas.getchannel('A'); atlas=atlas.convert('RGB').quantize(colors=64,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE).convert('RGBA');atlas.putalpha(alpha)
atlas.save(ROOT/'character-atlas.png');maskatlas=Image.new('RGBA',atlas.size)
for name,im in masks.items():maskatlas.alpha_composite(im,(frames[name]['x'],frames[name]['y']))
maskatlas.save(ROOT/'character-masks.png')
(ROOT/'character-atlas.json').write_text(json.dumps({'image':'/assets/character-atlas.png','masks':'/assets/character-masks.png','frames':frames},ensure_ascii=False,indent=2)+'\n')
print(f'{len(names)+len(manifest)} furniture items and 108 character frames ready.')
