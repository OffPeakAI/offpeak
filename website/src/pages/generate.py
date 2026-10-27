"""One-time authoring source for the editable OFFPEAK subpage HTML.
The portable site build copies the resulting HTML; Python/lxml is not a runtime dependency.
"""
from pathlib import Path
from copy import deepcopy
from lxml import html
from html import escape
import json

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
REF = ROOT / 'reference'

def inner(node, value):
    for child in list(node): node.remove(child)
    node.text = None
    for part in html.fragments_fromstring(value):
        if isinstance(part, str): node.text = (node.text or '') + part
        else: node.append(part)

def settext(node, value): inner(node, escape(value))
def getmain(route): return html.parse(str(REF / route / 'index.html')).xpath('//main')[0]
def fragment(value): return html.fragment_fromstring(value)
def p(value): return '<p class="text-body text-pretty text-ink">' + value + '</p>'
def icon(i=0):
    names=['capacity','quote','authorize','meter','withdraw','receipt']
    return f'<img class="pages-small-icon" src="/assets/offpeak-icon-{names[i%6]}.svg" alt="" width="28" height="28">'
def button(label='Read the docs',href='/docs/'):
    return f'<a class="pages-pill" href="{escape(href,quote=True)}">{escape(label)} <span aria-hidden="true">↗</span></a>'
def status(): return '<span class="pages-preview">Product preview · In development</span>'

WORKFLOWS = [
 ('classification','Product classification','Structure','Product descriptions','Return a category and three attributes for this product description.','category: home','attributes: portable, warm, dimmable','Use a reviewed category list and check the model against a labeled sample.'),
 ('extraction','Field extraction','Structure','Unstructured notes','Extract organization, date, and action from the supplied text. Leave unknown fields empty.','organization: North Studio','action: review draft','Choose a precise schema and validate the result in your application.'),
 ('summarization','Document summary','Writing','Longer documents','Summarize the supplied document in three factual bullets. Do not add information.','3 concise points','source: supplied document','Review the summary against the source and enforce an input-size limit.'),
 ('routing','Support routing','Operations','Incoming requests','Choose the most relevant support category from the allowed list. Explain uncertainty briefly.','intent: account help','route: customer operations','Keep consequential decisions with your team and provide an uncertain category.'),
 ('tagging','Content tagging','Structure','A content library','Select up to five tags from this approved vocabulary for the supplied text.','product · tutorial','2 matching tags','Use a fixed vocabulary so similar records receive comparable tags.'),
 ('normalization','Record normalization','Structure','Messy records','Normalize the supplied record to the given schema without inventing missing values.','fields: normalized','unknowns: preserved','Retain the original record and compare any changed fields.'),
 ('entities','Entity collection','Structure','Research notes','List the people, organizations, and places explicitly named in this text.','organizations: 3','places: 2','Treat extracted entities as suggestions until checked against the source.'),
 ('tone','Tone review','Writing','Draft messages','Describe the tone of the supplied message and flag phrases that may be unclear.','tone: direct','review: 2 phrases','Define your editorial rubric; this is an aid to review, not a universal score.'),
 ('faq','FAQ drafting','Writing','Approved reference text','Draft three question-and-answer pairs using only the supplied reference.','3 draft answers','source-grounded review','Verify every answer and keep unsupported questions unanswered.'),
 ('headlines','Headline options','Writing','An approved article','Write three concise headline options that accurately describe this article.','3 draft headlines','facts: unchanged','Have an editor select the final wording and check factual emphasis.'),
 ('duplicate','Duplicate review','Operations','Similar text records','Compare these two records and explain whether they describe the same item.','possible duplicate','human review required','Use model judgments to prioritize a review queue, not to delete records automatically.'),
 ('comparison','Attribute comparison','Structure','Two product descriptions','Compare only the attributes explicitly stated in these two descriptions.','material: stated','dimensions: unknown','Leave unstated values unknown and preserve links to the source records.'),
 ('bullets','Bullet-point conversion','Writing','Dense source text','Convert the supplied paragraph to short bullets without removing material qualifications.','4 clear bullets','qualifications retained','Check that shortening did not remove an exception or change the meaning.'),
 ('feedback','Feedback themes','Operations','A set of comments','Group the supplied comments by recurring theme and cite the source comment identifiers.','themes: 4','source IDs retained','Inspect small or ambiguous groups before using the summary to make decisions.'),
 ('keywords','Keyword suggestions','Structure','An article or note','Suggest keywords grounded in this text. Avoid adding unrelated search terms.','capacity · inference','quotes · receipts','Review suggested keywords before publishing or applying them across a library.'),
 ('validation','Schema review','Operations','A structured draft','Identify fields missing from the required schema. Report issues without guessing replacements.','required fields: 8','2 need attention','Use deterministic schema validation alongside any model-based review.'),
 ('rewrite','Plain-language edit','Writing','A draft paragraph','Rewrite this paragraph in plain language while preserving every factual claim and caveat.','shorter sentences','meaning preserved','Compare the edit with the original before replacing the source.'),
 ('queue','Queue digest','Operations','A batch of task notes','Summarize the supplied task notes by status and list unresolved questions.','open: 6 · review: 3','2 unresolved questions','Use explicit status fields; do not infer that unfinished tasks have been completed.'),
]

def sheet(title, rows, cls=''):
    return f'<div class="preview-sheet {cls}"><span class="preview-sheet-title">{escape(title)}</span>'+''.join(f'<div class="preview-row"><i></i><span>{escape(x)}</span></div>' for x in rows)+'</div>'

def scene(index, label=None, variant=None):
    w=WORKFLOWS[index%18]; kind=variant if variant is not None else index%9
    title=label or w[1]
    a=escape(w[5]);b=escape(w[6])
    if kind==0:
        content=sheet(w[3],['Original source text','A bounded text request','Review against the source'],'sheet-left')+f'<div class="preview-classification"><span>CLASSIFY</span><strong>{a.split(":")[-1]}</strong><div class="preview-tags"><b>portable</b><b>warm</b><b>dimmable</b></div></div>'
    elif kind==1:
        content=sheet(w[3],['organization: North Studio','date: supplied value','action: review draft'],'sheet-tilted')+'<div class="preview-table"><div><b>FIELD</b><b>VALUE</b></div><div><span>organization</span><span>North Studio</span></div><div><span>date</span><span>from source</span></div><div><span>action</span><span>review draft</span></div></div>'
    elif kind==2:
        content='<div class="preview-stack"><div></div><div></div>'+sheet(w[3],['Read the source','Keep the key details','Preserve qualifications'])+'</div>'+f'<div class="preview-summary"><span>SUMMARY</span><p>{a}</p><p>{b}</p><i></i><i></i></div>'
    elif kind==3:
        content='<svg class="preview-wires" viewBox="0 0 600 360" aria-hidden="true"><path d="M165 178H275V86H420M275 178H420M275 178V271H420"/></svg>'+f'<div class="preview-source">{icon(index)}<span>{escape(w[3])}</span></div><div class="preview-routes"><span>Ready for review</span><span class="selected">{a}</span><span>Needs a closer look</span></div>'
    elif kind==4:
        content=sheet(w[3],['A short source document','An explicit vocabulary','A reviewable response'],'sheet-center')+f'<div class="preview-tagcloud"><b>{a.split(" · ")[0]}</b><b>{a.split(" · ")[-1]}</b><b>review</b><b>source text</b></div>'
    elif kind==5:
        content='<div class="preview-compare"><div><span>BEFORE</span><strong>Source record</strong><p>Mixed formatting</p><p>Uncertain values</p><p>Original retained</p></div><div><span>AFTER</span><strong>Structured draft</strong><p>Consistent fields</p><p>Unknowns preserved</p><p>Ready for review</p></div></div>'
    elif kind==6:
        content='<div class="preview-network"><span>Organizations</span><span>People</span><span>Places</span><span>Source IDs</span><b>'+icon(index)+'</b></div>'+f'<div class="preview-bottomnote">{a} <span>·</span> {b}</div>'
    elif kind==7:
        content=sheet(w[3],['Keep the original meaning','Identify uncertain wording','Return review notes'],'sheet-left')+'<div class="preview-meter"><span>REVIEW PROFILE</span><div><b>Clear</b><i style="--value:74%"></i></div><div><b>Concise</b><i style="--value:56%"></i></div><div><b>Grounded</b><i style="--value:89%"></i></div><small>Illustrative labels</small></div>'
    else:
        content='<div class="preview-chat"><div><span>SOURCE</span><p>Use only the supplied reference.</p></div><div><span>DRAFT</span><p>'+a+'.</p><p>'+b+'.</p></div><div><span>REVIEW</span><p>Check every answer before use.</p></div></div>'
    return f'<div class="page-scene scene-{index%18}" role="img" aria-label="Illustrative {escape(title.lower(),quote=True)} workflow"><div class="preview-scene-label">{icon(index)}<span>{escape(title)}</span><small>EXAMPLE</small></div><div class="preview-scene-content">{content}</div><span class="preview-footnote">OPEN MODEL · CAPPED REQUEST · HUMAN REVIEW</span></div>'

def save(route, main, title, extra=''):
    for n in main.xpath('.//*[@style]'):
        if 'visibility:hidden' in n.get('style',''): n.attrib.pop('style',None)
    body=html.tostring(main,encoding='unicode',method='html')
    data=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>{escape(title)} · OFFPEAK</title><meta name="description" content="{escape(title,quote=True)}. Explore the OFFPEAK product preview."><link rel="icon" href="/assets/offpeak-white-mark.svg"><link rel="stylesheet" href="/assets/reference.css"><link rel="stylesheet" href="/assets/reference-home.css"><link rel="stylesheet" href="/assets/faithful.css"><link rel="stylesheet" href="/assets/pages.css"></head><body class="offpeak-page"><!--HEADER-->{body}{extra}<!--FOOTER--><script defer src="/assets/faithful.js"></script><script defer src="/assets/pages.js"></script></body></html>'''
    dest=OUT/route/'index.html';dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(data,encoding='utf-8')

# Three solution pages: preserve the original split hero and three-square feature layout.
solutions={
'founders':('For builders','Build around a clear request.','Choose a model that fits the work, review a quote, and keep spending explicit. OFFPEAK is developing an inference flow for applications that can use open models and spare capacity.','From a useful task to a checkable record.',[(0,'Choose the right work.','Start with repeatable text tasks and a measured quality threshold. The pilot is scoped to one approved model revision.'),(5,'Put a ceiling on each call.','Review an expiring quote and sign a maximum charge. The proposed API makes that limit part of the request.'),(2,'Keep a record of the result.','Reconcile measured usage and retain the signed billing receipt. Receipt inclusion does not prove correct model execution.')]),
'designers':('For product teams','Make routine text work reviewable.','Turn a flexible queue into structured drafts your team can evaluate. Start with source text, keep the original, and review model output before it reaches your product.','A place for every input and outcome.',[(1,'Extract with a schema.','Specify which fields matter and leave unsupported values unknown. Validate the output in your application.'),(11,'Compare with the source.','Use approved examples to judge quality. Model fit depends on the actual workload, not a generic benchmark.'),(15,'Reconcile the work.','Track the accepted limit, actual usage, and resulting receipt for every completed request.')]),
'content-creators':('For content operations','Clear the queue. Keep the context.','Summaries, tags, and editorial drafts are candidate workloads for open-model inference. OFFPEAK is being built for useful text work that can adapt to available serving capacity.','From source material to a reviewed draft.',[(2,'Make longer text easier to scan.','Create short summaries of supplied documents, then check that the material details and caveats remain.'),(4,'Organize the library.','Suggest tags from an approved vocabulary. Keep the source and review ambiguous records.'),(16,'Keep a human in the loop.','Use the output as a draft. Review wording, accuracy, and suitability before publishing or taking action.')])}
for route,(audience,title,description,heading,features) in solutions.items():
    m=getmain(route);sections=m.xpath('./section');grid=sections[0][0];copy=grid[0]
    settext(copy.xpath('.//h1')[0],title);settext(copy.xpath('.//p')[0],description);inner(copy.xpath('.//span')[0],button());copy.insert(0,fragment('<span class="pages-audience">'+audience+' · Product preview</span>'))
    inner(grid[1],scene(features[0][0],audience)+'<p class="pages-scene-caption">Illustrative workflow. Model and service validation are pending.</p>')
    settext(sections[1].xpath('.//h2')[0],heading)
    tiles=sections[1].xpath('.//*[contains(@class,"md:grid-cols-3")]')[0]
    for card,(idx,name,desc) in zip(tiles,features):
        inner(card[0],scene(idx,name));settext(card[1].xpath('.//h3')[0],name);settext(card[1].xpath('.//p')[0],desc)
    save(route,m,title)

# Eighteen unique gallery previews, with a real filter and per-workflow detail state.
m=getmain('templates');head=m.xpath('.//header')[0];ps=head.xpath('./p');settext(ps[0],'18 illustrative text workflows');settext(head.xpath('.//h1')[0],'A starting point for useful work.');settext(ps[-1],'Explore example tasks for open models. Each needs workload evaluation before use; these previews are not a connected model catalog.')
gallery=m.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," gallery ")]')[0]
for a,w,i in zip(gallery,WORKFLOWS,range(18)):
    a.set('href',f'/templates/?workflow={w[0]}#workflow-detail');a.set('data-workflow',w[0]);a.set('data-category',w[2]);a.set('aria-label',f'Explore {w[1].lower()} example');settext(a.xpath('.//*[contains(@class,"gallery-box__toolbar")]/span')[0],w[1]);inner(a.xpath('.//*[contains(@class,"gallery-box__frame")]')[0],scene(i));a.attrib.pop('inert',None)
filters='<div class="pages-gallery-tools"><div class="pages-filter" role="group" aria-label="Filter workflows">'+''.join(f'<button type="button" data-filter="{v}" aria-pressed="{str(i==0).lower()}">{v}</button>' for i,v in enumerate(['All','Structure','Writing','Operations']))+'</div><p data-filter-count aria-live="polite">18 workflows</p></div>'
gallery.addprevious(fragment(filters))
gallery.addnext(fragment('<section id="workflow-detail" class="pages-workflow-detail" tabindex="-1" aria-label="Selected workflow" hidden><div><span class="pages-preview">Illustrative workflow</span><h2 data-workflow-title></h2><p data-workflow-description></p><label for="workflow-prompt">Example prompt</label><textarea id="workflow-prompt" readonly rows="4"></textarea><div class="pages-detail-actions"><button class="pages-pill" data-copy-prompt>Copy prompt</button>'+button('Read the docs','/docs/')+'</div></div><div><h3>Before using this workflow</h3><p data-workflow-review></p><p>Choose a licensed model, test it on representative examples, and review uncertain output. The initial pilot is planned for non-streaming text.</p><a class="pages-text-link" href="/blog/product-design/">Read the workload evaluation guide ↗</a></div></section>'))
payload=[dict(id=w[0],title=w[1],category=w[2],description='Turn '+w[3].lower()+' into a bounded, reviewable request.',prompt=w[4],review=w[7])for w in WORKFLOWS]
save('templates',m,'Workflow gallery','<script type="application/json" id="workflow-data">'+json.dumps(payload).replace('</',r'<\/')+'</script>')

# Restore the original 12-card widget library as useful console/protocol examples.
CAPABILITIES=[
('Capacity snapshot',0,{'example':True,'state':'available','observedAt':'example timestamp','occupiedSlots':12,'totalSlots':16},'Availability is time-sensitive. Stale capacity must be rejected.'),
('Model profile',1,{'example':True,'model':'example-open-model','revision':'demo','mode':'non-streaming text','licenseReview':'pending'},'The pilot model, weights, tokenizer, and template must be pinned.'),
('Expiring quote',7,{'example':True,'lifetimeSeconds':30,'inputTokens':1000,'maxOutputTokens':500,'maxChargeAtoms':'500','asset':'MOCK'},'A quote fixes the request and price but reserves neither funds nor capacity.'),
('Signed spend cap',3,{'example':True,'action':'INFER','maxSpendAtoms':'500','nonce':'example-only','signature':'not-a-signature'},'A wallet must authorize the exact action. This example is not signable.'),
('Balance states',5,{'example':True,'asset':'MOCK','availableAtoms':'1000000','reservedAtoms':'500','withdrawalPendingAtoms':'0'},'Available, reserved, and withdrawal-pending liabilities stay distinct.'),
('Request lifecycle',8,{'example':True,'states':['accepted','running','succeeded'],'requestId':'demo-request'},'A retry should recover the same request rather than create a second charge.'),
('Usage settlement',11,{'example':True,'asset':'MOCK','heldAtoms':'500','chargedAtoms':'320','releasedAtoms':'180'},'Integer arithmetic keeps maximum hold, measured charge, and release balanced.'),
('Withdrawal intent',6,{'example':True,'action':'WITHDRAW','destination':'same owner wallet','asset':'same settlement token','network':'same network'},'Only available unreserved paid funds can enter the withdrawal flow.'),
('Private receipt',15,{'example':True,'requestId':'demo-request','modelRevision':'demo','inputTokens':1000,'outputTokens':200,'signature':'not-a-signature'},'Receipts are billing records. They do not prove execution or metering truth.'),
('Publication state',14,{'example':True,'states':['pending','published','finalized'],'proof':'example only'},'A delivered response can precede receipt-batch publication and finality.'),
('Failure recovery',17,{'example':True,'outcome':'failed','chargeAtoms':'0','reservation':'released after definitive recovery'},'Failed requests are unbilled in the initial pilot design.'),
('Retention controls',2,{'example':True,'responseHours':24,'billingMetadataDays':90,'promptLogging':False},'These are planned controls, not a report of deployed data handling.'),
]
m=getmain('widgets');head=m.xpath('.//header')[0];ps=head.xpath('./p');settext(ps[0],'12 planned console capabilities');settext(head.xpath('.//h1')[0],'Small details. A complete loop.');settext(ps[-1],'Explore the states behind the OFFPEAK console. Copy a sample payload to inspect its shape. Every payload below is an illustrative example.')
tiles=m.xpath('.//section[contains(@class,"gallery")]')[0]
for tile,(name,idx,payload,desc) in zip(tiles,CAPABILITIES):
    toolbar=tile.xpath('.//*[contains(@class,"gallery-box__toolbar")]')[0];settext(toolbar[0],name);b=toolbar.xpath('.//button')[0];inner(b,'Copy example');b.set('data-copy',json.dumps(payload,indent=2));b.set('aria-label','Copy '+name.lower()+' example');b.set('type','button')
    inner(tile.xpath('.//*[contains(@class,"gallery-box__frame")]')[0],scene(idx,name));tile.append(fragment('<p class="pages-widget-description">'+escape(desc)+'</p>'))
save('widgets',m,'Console capabilities')
