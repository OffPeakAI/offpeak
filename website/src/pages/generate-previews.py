"""Create 18 editable SVG workflow boards for the reference gallery footprint."""
from pathlib import Path
from html import escape
from lxml import html
import json

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'template-previews';OUT.mkdir(exist_ok=True)
gallery=html.parse(str(ROOT/'templates/index.html'))
DATA=json.loads(gallery.xpath('//script[@id="workflow-data"]')[0].text)

def text(x,y,value,size=25,color='#67705c',weight=400):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}">{escape(str(value))}</text>'
def rect(x,y,w,h,fill='#ffffff',radius=15,stroke='#e3e7dc',shadow=True):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"'+(' filter="url(#paper)"'if shadow else'')+'/>'
def line(x1,y1,x2,y2,color='#d3dac6',width=3):return f'<path d="M{x1} {y1}L{x2} {y2}" stroke="{color}" stroke-width="{width}" fill="none"/>'
def label(x,y,value):return text(x,y,value,18,'#939d84',600)
def dot(x,y,r=7,color='#cedea4'):return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{color}"/>'
def pill(x,y,value,w=None,fill='#edf3df'):
    w=w or max(90,len(value)*12+34)
    return rect(x,y,w,44,fill,22,'#e3ebd2',False)+text(x+17,y+29,value,20,'#697554')
def lines(x,y,width,rows=4):
    return ''.join(f'<rect x="{x}" y="{y+i*27}" width="{width*[1,.85,.93,.68,.8][i%5]}" height="7" rx="3.5" fill="#e9ede2"/>'for i in range(rows))
def card(x,y,w,h,title,rows=None,caption=None,fill='#fff',rotate=0):
    s=rect(x,y,w,h,fill)+text(x+30,y+57,title,31,'#464f3b',500)
    if caption:s+=label(x+30,y+92,caption)
    if rows:
        for i,row in enumerate(rows):s+=dot(x+36,y+135+i*46,4)+text(x+54,y+143+i*46,row,22)
    return f'<g transform="rotate({rotate} {x+w/2} {y+h/2})">{s}</g>'
def doc(x,y,w,h,title,caption='SOURCE TEXT',rotate=0):
    s=rect(x,y,w,h)+label(x+30,y+43,caption)+text(x+30,y+99,title,31,'#4d5542',500)+lines(x+30,y+138,w-66,7)+pill(x+30,y+h-70,'Original retained',195)
    return f'<g transform="rotate({rotate} {x+w/2} {y+h/2})">{s}</g>'
def arrow(x1,y1,x2,y2):return f'<path d="M{x1} {y1}L{x2} {y2}" stroke="#c2ccad" stroke-width="3" fill="none" marker-end="url(#arrow)"/>'
def table(x,y,w,headers,rows,widths=None):
    h=90+62*len(rows);s=rect(x,y,w,h)
    cols=len(headers);widths=widths or [w/cols]*cols
    at=x
    for col,width in zip(headers,widths):s+=label(at+24,y+44,col);at+=width
    s+=line(x+20,y+70,x+w-20,y+70)
    for j,row in enumerate(rows):
        at=x
        if j%2==0:s+=rect(x+12,y+82+j*62,w-24,55,'#f7f9f0',8,'none',False)
        for cell,width in zip(row,widths):s+=text(at+24,y+119+j*62,cell,21);at+=width
    return s
def checklist(x,y,w,title,rows):
    s=rect(x,y,w,105+53*len(rows))+text(x+27,y+53,title,29,'#48533a',500)
    for i,row in enumerate(rows):
        yy=y+85+i*53;s+=rect(x+27,yy,22,22,'#eef4df',6,'#dce7c8',False)+text(x+63,yy+20,row,21)
    return s

def make(index):
    if index==0:
        return doc(155,225,500,525,'Portable desk lamp',rotate=-4)+arrow(680,505,838,505)+card(890,175,455,190,'Category',['Home / lighting'],fill='#fbfdee',rotate=3)+card(850,425,500,235,'Attributes',['Portable','Warm light','Dimmable'],rotate=1)+pill(935,724,'Review suggested fields',285)
    if index==1:
        return doc(125,225,500,530,'Project notes',rotate=-3)+arrow(651,475,760,475)+table(800,220,660,['FIELD','EXTRACTED VALUE'],[['Organization','North Studio'],['Date','From source text'],['Action','Review the draft'],['Owner','Not specified'],['Next step','Confirm unknowns']])+pill(980,680,'Missing values stay empty',300)
    if index==2:
        return rect(162,203,450,580,'#f7f9f2',15,shadow=True)+rect(190,220,450,580,'#fbfcf8',15,shadow=True)+doc(218,238,450,580,'A longer document')+arrow(700,510,805,510)+card(850,255,570,485,'Three key points',['Use the supplied material','Keep the material details','Preserve every qualification'],caption='REVIEWABLE SUMMARY',fill='#fcfff0',rotate=3)+lines(895,650,375,2)
    if index==3:
        return table(110,235,600,['REQUEST','STATUS'],[['Account question','New'],['Product query','New'],['Delivery detail','New'],['Unclear message','Review']])+line(738,470,845,470)+line(845,290,845,705)+arrow(845,290,955,290)+arrow(845,495,955,495)+arrow(845,705,955,705)+card(1000,215,430,150,'Account support',fill='#f5f9e9')+card(1000,420,430,150,'Product support')+card(1000,630,430,150,'Needs a review')
    if index==4:
        s=''
        names=['Product guide','Release note','Tutorial','Interview','Reference','Announcement'];tags=['product','update','how-to','research','docs','news']
        for i,(name,tag)in enumerate(zip(names,tags)):
            x=120+(i%3)*465;y=175+(i//3)*365;s+=rect(x,y,420,310)+label(x+28,y+42,'CONTENT '+str(i+1).zfill(2))+text(x+28,y+95,name,29,'#4d5640',500)+lines(x+28,y+126,310,3)+pill(x+28,y+238,tag)
        return s
    if index==5:
        return table(105,220,585,['SOURCE','VALUE'],[['Name','desk LAMP'],['Category','Home & light'],['Material','not stated'],['Status','unreviewed']])+arrow(716,482,864,482)+table(915,220,585,['FIELD','NORMALIZED'],[['name','Desk lamp'],['category','home'],['material','unknown'],['review','pending']])+card(430,690,760,135,'Original values retained',caption='COMPARE BEFORE SAVING',fill='#f5f8ed')
    if index==6:
        return doc(555,205,490,570,'Research passage')+line(510,350,300,275)+line(1060,350,1275,275)+line(505,605,265,725)+line(1060,610,1255,725)+card(105,190,380,165,'Organizations',['North Studio'],fill='#f9fcef',rotate=-5)+card(1130,180,355,170,'People',['Named in source'],rotate=4)+card(105,675,370,150,'Places',['2 references'],rotate=-3)+card(1130,675,355,150,'Source IDs',['Keep citations'],fill='#f7faee',rotate=3)
    if index==7:
        s=doc(125,215,595,570,'Draft message',rotate=-2)+rect(812,235,640,475)+label(849,284,'EDITORIAL REVIEW')+text(849,333,'A useful second look.',32,'#4b553d',500)
        for j,(name,width)in enumerate([('Clarity',355),('Brevity',230),('Grounding',405)]):
            yy=382+j*89;s+=text(849,yy,name,23)+rect(849,yy+16,515,14,'#f0f3e8',7,'none',False)+rect(849,yy+16,width,14,'#d5e4ae',7,'none',False)
        return s+pill(889,751,'Illustrative review rubric',300)
    if index==8:
        return card(145,165,555,270,'What does the source say?',['Draft a grounded answer.','Keep the supporting reference.'],caption='QUESTION 01',rotate=-3)+card(825,225,595,295,'What remains unknown?',['Do not invent an answer.','Send uncertain items for review.'],caption='QUESTION 02',fill='#fbfdec',rotate=2)+card(315,590,655,260,'What should be checked?',['Read each answer against its source.','Approve the wording before use.'],caption='QUESTION 03',rotate=-1)+pill(1102,659,'Draft',90)+pill(1140,730,'Review',108)
    if index==9:
        return doc(135,220,515,600,'Approved article',rotate=-3)+arrow(690,525,815,525)+card(860,180,570,180,'A clearer headline',caption='OPTION 01')+card(885,420,570,180,'The detail that matters',caption='OPTION 02',fill='#fcffef',rotate=2)+card(835,655,570,180,'A useful perspective',caption='OPTION 03',rotate=-2)
    if index==10:
        return doc(130,245,450,505,'Record A',rotate=-5)+doc(615,200,450,505,'Record B',rotate=3)+card(1030,510,455,280,'Compare before merging',['Same item? Possibly.','Differences: review source','No automatic deletion'],caption='REVIEW NOTE',fill='#fbfdee',rotate=-2)+line(594,490,634,490)+pill(305,830,'Keep both originals',260)
    if index==11:
        return table(165,190,1270,['ATTRIBUTE','DESCRIPTION A','DESCRIPTION B'],[['Material','Aluminum','Not stated'],['Light source','Warm LED','LED'],['Power','Rechargeable','USB'],['Brightness','Dimmable','Not stated'],['Review','Check source','Check source']],[360,450,460])+card(440,735,735,130,'Unknown means unknown.',caption='ONLY COMPARE STATED ATTRIBUTES',fill='#f6f9ee')
    if index==12:
        return doc(145,210,525,575,'A dense paragraph',rotate=-3)+arrow(715,495,825,495)+''.join(card(870+(j%2)*25,175+j*175,545,135,'• '+v,fill='#fbfdee'if j==1 else'#fff')for j,v in enumerate(['Keep the central fact','Preserve the exception','Use concrete language','Review the final draft']))
    if index==13:
        s=''
        for j,(heading,rows)in enumerate([('Navigation',['Find the model','Read availability']),('Billing',['See the maximum','Track the release','Keep the record']),('Clarity',['Explain the status','Flag uncertainty'])]):
            x=115+j*480;s+=rect(x,175,440,660,'#f4f6ef',18,'#e4e8dc',False)+text(x+25,225,heading,31,'#4c5740',500)+label(x+25,262,str(len(rows))+' SOURCE NOTES')
            for i,row in enumerate(rows):s+=card(x+20,295+i*170,400,140,row,caption='COMMENT '+str(i+1).zfill(2),fill='#fff'if i%2==0 else'#fcffed',rotate=(-1 if i%2 else 1))
        return s
    if index==14:
        cx,cy=800,485;s=''
        nodes=[(220,205,'Capacity'),(1055,185,'Open models'),(1080,695,'Receipts'),(195,695,'Quotes'),(665,145,'Review')]
        for x,y,_ in nodes:s+=line(cx,cy,x+140,y+48)
        s+=card(555,352,490,250,'Keywords from the text',['Ground every suggestion.','Review before applying.'],caption='SOURCE DOCUMENT',fill='#fcfff1')
        for x,y,v in nodes:s+=rect(x,y,280,96,'#fff',15)+text(x+28,y+60,v,30,'#61704b',500)
        return s
    if index==15:
        s=rect(135,205,670,590)+label(175,255,'EXPECTED SCHEMA')
        code=['{','  "category": "string",','  "attributes": ["string"],','  "source_id": "string",','  "unknowns": ["string"]','}']
        for i,row in enumerate(code):s+=f'<text x="175" y="{320+i*59}" font-size="26" fill="#6d795b" font-family="Consolas,monospace">{escape(row)}</text>'
        return s+checklist(920,230,510,'Review the structure',['Required fields present','Types match the schema','Unknowns stay explicit','Review before accepting'])+pill(1000,660,'Example validation',260)
    if index==16:
        return doc(125,210,600,600,'The original paragraph','BEFORE',rotate=-2)+doc(875,210,600,600,'A clearer draft','AFTER',rotate=2)+arrow(755,507,848,507)+pill(585,845,'Meaning preserved · human review',435)
    s=''
    for j,(name,notes)in enumerate([('Queued',['Product descriptions','New support notes','Research records']),('Review',['Summary draft','Missing fields']),('Ready',['Approved tags','Checked categories'])]):
        x=140+j*465;s+=rect(x,215,425,590,'#f3f5ed',18,'#e1e7d6',False)+label(x+28,261,name.upper())+pill(x+320,234,str(len(notes)),58)
        for i,note in enumerate(notes):s+=card(x+20,300+i*152,385,122,note,caption='TASK '+str(i+1).zfill(2),fill='#fff'if j!=2 else'#fbffed')
    return s+pill(560,860,'2 questions need an answer',370)

manifest=[]
for index,w in enumerate(DATA):
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000" role="img" aria-label="Illustrative {escape(w['title'].lower(),quote=True)} workflow"><defs><filter id="paper" x="-15%" y="-15%" width="140%" height="145%"><feDropShadow dx="0" dy="9" stdDeviation="13" flood-color="#344521" flood-opacity=".055"/></filter><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="none" stroke="#b7c4a0" stroke-width="1.4"/></marker><pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".9" fill="#dbe0d0"/></pattern></defs><rect width="1600" height="1000" fill="#eef0e9"/><rect width="1600" height="1000" fill="url(#grid)" opacity=".5"/><g font-family="Manrope,Arial,sans-serif">{dot(64,63,6,'#c4d995')}{label(86,70,'OFFPEAK / '+w['title'].upper())}{label(1325,70,'EXAMPLE FLOW')}{make(index)}{label(60,952,'OPEN-MODEL TEXT · CAPPED REQUEST · HUMAN REVIEW')}{text(1365,952,str(index+1).zfill(2)+' / 18',18,'#99a18d')}</g></svg>'''
    (OUT/(w['id']+'.svg')).write_text(svg,encoding='utf-8')
    manifest.append(dict(id=w['id'],slug=w['id'],file=w['id']+'.svg',title=w['title'],category=w['category'],preview='/template-previews/'+w['id']+'.svg',href='/templates/?workflow='+w['id']+'#workflow-detail',width=1600,height=1000))
for a in gallery.xpath('//*[@data-workflow]'):
    key=a.get('data-workflow');entry=next(v for v in manifest if v['id']==key);frame=a.xpath('.//*[contains(@class,"gallery-box__frame")]')[0]
    for c in list(frame):frame.remove(c)
    image=html.Element('img',src=entry['preview'],alt=entry['title']+' illustrative workflow preview',width='1600',height='1000',loading='lazy',decoding='async');image.set('class','w-full select-none');frame.append(image)
# Keep the explicit shell markers when serializing the edited page.
(ROOT/'templates/index.html').write_text('<!doctype html>\n'+html.tostring(gallery.getroot(),encoding='unicode',method='html'),encoding='utf-8')
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print('Created 18 unique 1600x1000 SVG workflow boards and manifest.json.')
