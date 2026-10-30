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

# Pricing keeps two original card slots and a two-state control, with honest example arithmetic.
m=getmain('pricing');outer=m[0];inner(outer,'<header class="mx-auto flex w-full max-w-[680px] flex-col items-center gap-4 text-center">'+status()+'<h1 class="text-h1 text-balance text-ink">A price before you run.</h1><p class="text-body text-pretty text-muted">Capacity-based rates. A request-level ceiling. The numbers below use a mock asset to explain the proposed flow.</p></header><div class="pages-rate-switch" role="group" aria-label="Select illustrative output usage"><button type="button" data-usage="200" aria-pressed="true">200 output tokens</button><button type="button" data-usage="500" aria-pressed="false">500 output tokens</button></div><div class="pages-price-grid"><section class="pages-price-card"><span class="pages-card-eyebrow">BEFORE ACCEPTANCE</span><h2>Maximum hold</h2><div class="pages-price-amount">0.000500 <small>MOCK</small></div><p>For 1,000 input tokens and an output limit of 500 tokens.</p>'+button('Read how billing works','/docs/#billing')+'<ul><li>Input rate: 0.20 MOCK / million tokens</li><li>Output rate: 0.60 MOCK / million tokens</li><li>Quote lifetime: 30 seconds</li><li>Exact model and prompt identity</li><li>Rates fixed on acceptance</li><li>Capacity remains subject to availability</li><li>Wallet-signed spending ceiling</li><li>No reserve until acceptance</li></ul></section><section class="pages-price-card"><span class="pages-card-eyebrow">AFTER A SUCCESSFUL REQUEST</span><h2>Measured charge</h2><div class="pages-price-amount"><span data-example-charge>0.000320</span> <small>MOCK</small></div><p><span data-example-output>200</span> output tokens used. <strong data-example-release>0.000180</strong> MOCK released.</p>'+button('See billing details','/docs/#billing')+'<ul><li>Pay for measured usage on success</li><li>Unused reservation returns to available funds</li><li>Failed pilot requests are unbilled</li><li>Keep a signed billing receipt</li></ul></section></div><p class="pages-price-note">Illustrative six-decimal mock asset fixture from the build brief. These are not production prices or verified settlement-token decimals. Discounts depend on available capacity and a measured cost floor; none are guaranteed.</p><div class="pages-pricing-faq"><h2 class="text-h3">What sets the actual rate?</h2><p class="text-body text-muted">The proposed pricing engine responds to occupied serving slots, subject to a measured cost floor. The production model, settlement asset, benchmarked rates, and paid service are still being validated.</p><h2 class="text-h3">Can I withdraw unused funds?</h2><p class="text-body text-muted">The design returns available, unreserved paid funds to the same wallet, token, and network. OFFPEAK controls the prepaid treasury and processes withdrawals. The preview does not accept deposits.</p></div>')
save('pricing',m,'Pricing and spending limits')

# Five-step developer guide retains the original numbered vertical setup structure.
FLOW={
'quote':{'label':'Quote','title':'Choose the exact request','description':'Select a supported model revision, provide the prompt, and set the maximum output length. The initial catalog is pending validation.','code':'// Planned API pseudocode\nquote = requestQuote(model, prompt, outputLimit)\nreview(quote.rates, quote.maxCharge, quote.expiresAt)','state':'Review the rates and maximum charge','result':'A quote is planned to expire after 30 seconds. A changed prompt requires a fresh quote. Capacity and funds are not reserved yet.','limit':'Accept only while the quote and capacity are valid. An unexpired quote may still encounter unavailable capacity.'},
'authorization':{'label':'Authorize','title':'Approve a specific spending limit','description':'Use the wallet that owns the funded account. A browser session can read account state but cannot authorize spending by itself.','code':'// Illustrative signing flow, not a signable message\nintent = bindRequest(quote, maxSpend, nonce, expiry)\nauthorization = wallet.sign(intent)','state':'Bind the authorization to the request','result':'The signed intent includes its action, wallet, request body digest, maximum charge, nonce, expiry, and intended network.','limit':'The pilot targets EOA wallets. Direct x402 and delegated wallet budgets are future work; this preview never requests a signature.'},
'request':{'label':'Request','title':'Submit once, recover safely','description':'The proposed service atomically reserves funds and a serving slot before dispatch. A stable request ID makes recovery explicit.','code':'// Planned API pseudocode\nresult = submitRequest(quote, authorization)\nif connectionLost:\n    result = recoverRequest(result.requestId)','state':'Keep the result and charge together','result':'Persist the complete encrypted result before charging a successful request. Retries should return the same result without duplicate execution or spending.','limit':'Failed pilot requests are unbilled. Uncertain worker outcomes require reconciliation, not blind resubmission.'},
'receipt':{'label':'Receipt','title':'Keep a record you can check','description':'Download the signed billing receipt. Its batch commitment is published separately, so proof status can remain pending after the response arrives.','code':'// Planned API pseudocode\nbundle = downloadReceipt(result.requestId)\ncheckSignature(bundle)\ncheckFinalizedBatchInclusion(bundle)','state':'Separate integrity from execution truth','result':'A verifier checks the signed record and its inclusion in a finalized commitment. The planned registry holds no customer funds.','limit':'Receipt inclusion does not independently prove GPU execution, truthful token counts, or answer correctness. Preview bundles are examples only.'}}
def guide_markup():
    flow=FLOW['quote'];tabs=''.join(f'<button type="button" role="tab" id="flow-tab-{k}" aria-controls="flow-panel" aria-selected="{str(k=="quote").lower()}" data-flow="{k}">{v["label"]}</button>'for k,v in FLOW.items())
    def step(n,title,content):return f'<li class="relative flex gap-4 '+('pb-10'if n<5 else '')+'"><span class="pages-step-line" aria-hidden="true"></span><span class="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-label text-muted">{n}</span><div class="flex min-w-0 flex-1 flex-col gap-2"><h3 class="text-h3 text-ink">'+title+'</h3>'+content+'</div></li>'
    return '<ol class="flex w-full flex-col pages-flow-guide">'+step(1,'Pick a stage','<p class="text-body text-muted">Explore the request lifecycle. These examples are planned API pseudocode, not a working SDK.</p><div class="pages-flow-tabs" role="tablist" aria-label="Request stages">'+tabs+'</div>')+step(2,'<span data-flow-title>'+flow['title']+'</span>','<p class="text-body text-muted" data-flow-description>'+flow['description']+'</p>')+step(3,'Inspect the example','<div id="flow-panel" role="tabpanel" aria-labelledby="flow-tab-quote" class="pages-code-block"><pre><code data-flow-code>'+escape(flow['code'])+'</code></pre><button type="button" data-copy-flow>Copy example</button></div>')+step(4,'<span data-flow-state>'+flow['state']+'</span>','<p class="text-body text-muted" data-flow-result>'+flow['result']+'</p>')+step(5,'Know the boundary','<p class="text-body text-muted" data-flow-limit>'+flow['limit']+'</p><a class="pages-text-link" href="/docs/">Read the docs ↗</a>')+'</ol>'
m=getmain('mcp');header=m.xpath('.//header')[0];settext(header.xpath('.//h1')[0],'A small, explicit inference flow.');settext(header.xpath('.//p')[0],'Discover a model, review a quote, sign a capped request, and retain a receipt. Paid inference and SDK availability are in development.');header.insert(0,fragment(status()));inner(m.xpath('.//ol')[0].getparent(),guide_markup());save('mcp',m,'Developer flow','<script type="application/json" id="flow-data">'+json.dumps(FLOW).replace('</',r'<\/')+'</script>')

# Real journal pages, keeping original article column widths, heading hierarchy, and media slots.
ARTICLES=[
('canvas-ai','Open models. Useful work.','Product',0,'OFFPEAK is being built for text workloads that can use an open model and adapt to available capacity. The first pilot is deliberately narrow: one approved model revision, one region, non-streaming text, and a clear accounting loop.',[
 ('Start with the task','Extraction, classification, and summarization can be useful candidates. Define the expected output and build a representative evaluation set before choosing a model. An open model is suitable only if it meets your workload’s quality threshold.'),
 ('Know which model ran','The proposed service pins the weights revision, tokenizer, and chat template. Model substitution is outside the intended request contract. Licensing and the right to serve the chosen model must be established before paid access.'),
 ('Use capacity deliberately','Available serving slots influence the quote, subject to a cost floor. Spare capacity can reduce the offered price, but no discount or latency outcome is guaranteed. Flexible queues can accommodate variation better than urgent interactive work.'),
 ('Set a limit before execution','A quote binds the prompt, output ceiling, rates, and maximum charge. Wallet authorization carries the spending cap. Acceptance then reserves funds and capacity together, instead of letting dispatch get ahead of accounting.'),
 ('Keep the result and record','A successful response is persisted before final charging. The unused reserve is released, and a signed receipt records the billed usage. Publication of a receipt batch follows separately from response delivery.'),
 ('Start with the complete loop','The initial product must demonstrate deposit, capped call, receipt verification, and withdrawal. The current site is a preview of that product; it is not evidence that the paid service has launched.')]),
('product-design','Does the model fit the work?','Guide',11,'A useful evaluation starts with your actual inputs. General model claims cannot tell you whether an extraction job will preserve missing values or whether a summary will retain the detail your team needs.',[
 ('1. Define an acceptable answer','Write down the output schema, the allowed categories, and what should happen when the source is ambiguous. Keep unknown values explicit. A clear success criterion is more useful than a vague request for a good answer.'),
 ('2. Build a representative sample','Include normal inputs, longer inputs, messy formatting, and genuinely uncertain cases. Keep the evaluation set stable so that model revisions and configuration changes can be compared on the same work.'),
 ('3. Check the failure cases','Inspect unsupported claims, dropped qualifications, inconsistent fields, and invalid structure. If a task has consequential outcomes, keep a qualified reviewer in the decision process. The model output remains a proposal to evaluate.'),
 ('4. Measure the serving profile','Quality is only part of the fit. Measure input and output lengths, throughput, and capacity behavior on authorized hardware. OFFPEAK’s planned cost floor depends on real workload evidence rather than mock performance.'),
 ('5. Decide what can wait','Some queues can pause when capacity is unavailable; other tasks cannot. Plan retry and recovery behavior around the workload. A new quote may be needed after expiry, while a submitted request should be recovered by its stable identity.'),
 ('6. Retain a reviewable record','Keep source references, approved output, request identity, and billing receipts where your team can reconcile them. A billing proof helps verify the record’s integrity; it does not replace evaluation of the model’s answer.')]),
('introducing-mcp','From quote to receipt.','Developers',3,'The proposed OFFPEAK API makes the spending boundary explicit. An application discovers a model, inspects a quote, authorizes a cap, and submits the request. This guide illustrates that flow without inventing a live endpoint or SDK.',[
 ('Explore the planned request flow','The example stages below describe the intended pilot. They use pseudocode and cannot submit a paid request. The initial scope supports non-streaming text and EOA wallet authorization; direct x402 payments and delegated permissions are later work.')]),
('vibe-design','What makes a price off-peak?','Guide',7,'A low headline price is useful only if the model serves the work reliably and the accounting is clear. OFFPEAK’s proposal connects available serving capacity to an expiring, bounded request quote.',[
 ('1. Start with authorized supply','The service must operate the GPU capacity directly or have permission to sell inference on it. Supplier rights, interruption terms, model licensing, and a pinned serving profile are prerequisites, not assumptions.'),
 ('2. Measure occupied capacity','The pilot design uses a smoothed fraction of occupied serving slots. Raw GPU utilization is supplemental telemetry because a low utilization reading alone does not establish sellable spare capacity.'),
 ('3. Respect a measured floor','A quote must account for the cost of successful work, infrastructure, failed work, and payment operations. A discount that ignores those costs does not establish a sustainable offer. No savings percentage is promised in the preview.'),
 ('4. Fix the accepted rates','The quote binds input and output rates, prompt identity, model revision, and output ceiling. Once accepted, those rates remain fixed for that request, so changing capacity does not silently reprice the call.'),
 ('5. Settle actual usage','The maximum charge is reserved before dispatch. On success, measured token usage determines the final charge and the remainder returns to the available balance. Integer asset units avoid ambiguous rounding.'),
 ('6. Re-evaluate with pilot evidence','Workload quality, failure rates, cost, withdrawal recovery, and receipt publication must be measured in the capped pilot. Passing time alone does not establish viable economics or demand.')]),
('about-us','Useful work between the peaks.','About',17,'Not every AI job needs the same model, the same urgency, or the same serving arrangement. OFFPEAK explores a narrower proposition: open models, authorized spare compute, and a request you can price before you run.',[
 ('A deliberate place to start','The proposed P0 service is one complete loop around one model revision and one region. Keeping the initial scope small makes it possible to inspect the actual serving quality, accounting, and recovery behavior.'),
 ('The spending boundary matters','A prepaid balance is custodial in this design. The wallet authorizes each request, the service reserves its maximum charge, and available unreserved funds can be withdrawn to the same wallet and network. Those boundaries should be visible at the point of use.'),
 ('Records with honest limits','A signed receipt and chain commitment can establish a record’s integrity and inclusion. They cannot by themselves prove correct GPU execution, truthful metering, or the quality of an answer. The product should explain that distinction plainly.'),
 ('What comes after the pilot','Streaming, tool calls, direct x402, delegated budgets, and broader supplier access depend on pilot evidence and separate design work. The initial pilot does not require $OFPK. Issuance and utility remain undecided.')]),
('billing-records','What your receipt actually proves.','Billing',15,'A checkable billing record is useful because a team can retain it and verify that it was included in a published commitment. Its value depends on being precise about what is checked and what remains a matter of trust.',[
 ('The private record','The proposed receipt includes request and model identity, measured token counts, and charge information. OFFPEAK signs that record. The prompt is not meant to be published with the receipt batch.'),
 ('The public commitment','Receipts are grouped into a Merkle batch whose root is anchored to the intended registry. A proof bundle allows a verifier to check inclusion after the batch has reached the required finality.'),
 ('Publication is a separate state','Pending, published, and finalized describe different stages. A returned model response does not mean its batch is already finalized. The console should show that distinction rather than presenting every receipt as verified.'),
 ('What verification cannot decide','A valid signature and inclusion proof do not independently establish that a GPU did the work, that usage counts were truthful, or that the answer was correct. Stronger execution attestations belong to future research.'),
 ('The privacy boundary','Registry payloads are designed to exclude customer content and wallet addresses. Token transfers still expose wallet addresses, amounts, and timing. These are not anonymity or confidential-computing guarantees.'),
 ('Keep the full bundle','The planned verifier checks the supplied record, signature, proof path, configured registry, and finalized commitment. Preserve the complete bundle for independent checking. All receipt data in the current console is illustrative.')]),
]
for slug,title,category,index,intro,parts in ARTICLES:
    ref='blog/'+slug if (REF/'blog'/slug/'index.html').exists() else 'blog/product-design'
    m=getmain(ref);article=m.xpath('.//article')[0];top=article[0];header=top.xpath('.//header')[0];settext(header.xpath('.//h1')[0],title);settext(header.xpath('.//p')[0],'OFFPEAK JOURNAL');media=top.xpath('./div[contains(@class,"aspect-video")]')[0];inner(media,scene(index,title))
    body=article[1];meta=body[0];inner(meta,'<div class="flex items-center gap-2.5"><img class="pages-author-mark" src="/assets/offpeak-white-mark.svg" width="24" height="24" alt=""><span class="text-label text-ink">OFFPEAK</span></div><p class="ml-auto text-right text-label text-muted">'+category+' · Product preview</p>')
    content=body[1];value=p(intro)
    for j,(heading,text) in enumerate(parts):
        value+='<h2 class="mt-4 text-h3 text-balance text-ink first:mt-0">'+escape(heading)+'</h2>'+p(escape(text))
        if len(parts)==6 and j in (0,2):
            value+='<figure class="flex flex-col gap-3"><div class="aspect-video w-full overflow-hidden rounded-sm bg-surface">'+scene((index+j+2)%18)+'</div><figcaption class="text-label text-muted">Illustrative product workflow. Paid inference is in development.</figcaption></figure>'
    if slug=='introducing-mcp':value+=guide_markup()
    value+='<p class="pages-article-source">Based on the supplied OFFPEAK version 1.0 product and build briefs. <a href="/documents/OFFPEAK-Overview.pdf">Read the overview ↗</a></p><a class="pages-text-link" href="/blog/">← All articles</a>'
    inner(content,value);extra='<script type="application/json" id="flow-data">'+json.dumps(FLOW).replace('</',r'<\/')+'</script>'if slug=='introducing-mcp'else'';save('blog/'+slug,m,title,extra)

m=getmain('blog');head=m.xpath('.//header')[0];settext(head.xpath('.//h1')[0],'Everything behind the request.');settext(head.xpath('.//p')[0],'Notes on open-model work, capacity-based pricing, and the product we are building.');grid=m.xpath('.//section/div')[0];example=deepcopy(grid[0]);inner(grid,'')
for slug,title,category,index,_,_ in ARTICLES:
    a=deepcopy(example);a.set('href','/blog/'+slug+'/');inner(a[0],scene(index,title));settext(a.xpath('.//h3')[0],title);settext(a.xpath('.//p')[0],category+' · Read article');grid.append(a)
save('blog',m,'Journal')

# Keep the original numbered long-form information layouts, without manufacturing legal policies.
PRIVACY=[
('Current status','This page summarizes the proposed data handling in the supplied version 1.0 specification. It is not an adopted privacy policy for a live paid service. The console is an illustrative preview.'),
('Who operates the service','The operating entity, eligible jurisdictions, contact route, and applicable obligations must be resolved before paid access. The supplied materials do not establish those production details.'),
('Prompt processing','The pilot design calls for processing prompts without logging them. Implementation, access controls, and operational verification of that behavior remain part of the build gates.'),
('Response recovery','The proposed service retains encrypted response artifacts for 24 hours so clients can recover results after a connection failure. That retention supports retry behavior without duplicate execution.'),
('Billing metadata','The brief proposes retaining billing metadata and proof bundles for 90 days by default. A documented privacy and accounting decision may change that policy before launch.'),
('Wallet identity','The intended pilot uses an EOA wallet to establish ownership and sign specific actions. Wallet keys must remain outside server and client logs. The preview does not request a real signature.'),
('Public token transfers','Public transfers reveal wallet addresses, amounts, and timing. A private receipt design does not make the funding and withdrawal activity anonymous.'),
('Receipt registry','Registry payloads are designed to contain batch commitments without customer content or customer wallet addresses. The private bundle provides the record and proof needed for checking inclusion.'),
('What a proof means','Receipt verification checks a signature and committed record. It does not independently prove execution correctness, truthful metering, answer quality, confidential serving, or anonymity.'),
('Access and isolation','The proposed implementation requires owner-only reads, tenant isolation, redacted logs, private worker networking, and role-restricted operator controls. These controls require actual implementation and review.'),
('Retention verification','The operations phase includes deletion jobs, content-leak checks, incident drills, and recovery evidence. Planned retention durations should not be presented as verified service behavior before those checks pass.'),
('Provider and region details','The initial scope is one region and vetted authorized workers. The production hosting region, processors, and supplier details must be documented before live customer data is accepted.'),
('Production policy still pending','A production policy must identify the operator, processing purposes, applicable rights, retention rules, and a working contact route. This preview does not invent those legal or operational details.'),
('Source documents','Read the product overview and build brief for the proposed design. Their descriptions are product requirements, not evidence of a deployed service.')]
TERMS=[
('This is a product preview','This page explains the status and proposed boundaries of OFFPEAK. It is not a set of adopted commercial service terms. Paid-service terms remain pending.'),
('No paid access in this preview','The website and console do not connect to live inference, custody, payment, or receipt-verification services. Demo interactions use illustrative records.'),
('Source of the product description','The current product description follows the supplied OFFPEAK version 1.0 overview and build specification dated October 12, 2026.'),
('Initial service scope','The proposed pilot targets one approved open-model revision, one region, vetted GPU capacity, one settlement token, EOA wallets, and non-streaming text.'),
('Model approval','The model license, supplier rights, weights revision, tokenizer, chat template, and workload quality must be established before paid use.'),
('Workload suitability','Extraction, classification, and summarization are candidate workloads. Each application must evaluate quality on representative inputs; no universal model performance is promised.'),
('Capacity and availability','The proposed price responds to available serving capacity with a measured cost floor. A quote is not a guarantee that capacity will remain available until acceptance.'),
('Expiring quotes','The planned quote lifetime is 30 seconds. It binds the prompt, model profile, output limit, rates, wallet, asset, and maximum charge. Changing the prompt requires a new quote.'),
('Wallet authorization','The wallet signs a specific request and spending ceiling. Browser session access alone cannot authorize funds to be spent. The preview does not request wallet signatures.'),
('Prepaid custody','The proposed P0 design uses custodial prepaid balances. OFFPEAK controls the pooled treasury and processes withdrawals; the registry does not hold customer funds.'),
('Reservations','Acceptance reserves funds and capacity before dispatch. Available, reserved, and withdrawal-pending amounts remain separate so the same funds cannot be spent twice.'),
('Successful-request charges','The service is designed to persist a complete result before charging measured usage once. It releases the unused portion of the maximum reserve.'),
('Failure and recovery','Failed requests are unbilled in the initial pilot design. Uncertain worker or chain outcomes require recovery and reconciliation rather than blind retries.'),
('Withdrawals','Available, unreserved paid funds are intended to return to the same owner wallet on the same network in the same token. This is not a bridge or fiat cash-out route.'),
('Settlement asset pending validation','The actual production asset configuration, identity, decimals, transfer behavior, and finality semantics must be verified. Mock examples are not production prices.'),
('Receipt integrity','A signed receipt and committed batch can support independent checks of the billing record. They do not prove GPU execution, metering truth, or model-answer correctness.'),
('Planned data handling','The brief proposes no prompt logging, 24-hour encrypted result retention, and 90-day metadata/proof retention by default. Production policy and evidence remain pending.'),
('Deferred features','Direct x402, streaming, tool calls, delegated budgets, broader suppliers, confidential serving, and stronger execution attestations are outside the initial pilot scope.'),
('Token status','$OFPK is not required for the initial pilot. Issuance, allocation, utility, and launch remain undecided; this preview makes no token, yield, or redemption offer.'),
('Third-party compatibility','Third-party names identify intended technical compatibility only. The website does not imply affiliation or a completed integration.'),
('Gates before live service','The production operator, jurisdictions, custody obligations, supplier rights, signer controls, liability backing, and recovery reviews must be resolved before paid access.'),
('Further information','The product guide and source PDFs describe the intended system. A working contact route and formal service terms must be supplied before commercial launch.')]
for route,title,intro,rows in [('privacy','Planned data handling','A clear view of the proposed privacy boundaries, and the work still required before live access.',PRIVACY),('terms','Product preview information','What this preview describes, what remains in development, and the planned boundaries of the initial pilot.',TERMS)]:
    m=getmain(route);article=m.xpath('.//article')[0];lead=article[0];settext(lead.xpath('.//h1')[0],title);settext(lead.xpath('.//header/p')[0],'Product preview · Formal service policy pending');settext(lead.xpath('./p')[0],intro)
    sections=article.xpath('./section')
    for i,(sec,(heading,text)) in enumerate(zip(sections,rows)):
        inner(sec.xpath('./h2')[0],f'<span class="min-w-10 tabular-nums text-muted">{i+1:02d}</span>'+escape(heading));inner(sec.xpath('./div')[0],'<p class="text-body text-muted">'+escape(text)+'</p>')
    sections[-1][-1].append(fragment('<p class="text-body text-muted"><a class="pages-text-link" href="/docs/">Product guide ↗</a> · <a class="pages-text-link" href="/documents/OFFPEAK-Overview.pdf">Product overview PDF ↗</a> · <a class="pages-text-link" href="/documents/OFFPEAK-Build.pdf">Build specification PDF ↗</a></p>'))
    save(route,m,title)

print('Authored 16 real subpages: all 15 original routes plus billing-records article.')
