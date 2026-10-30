// Optional review tooling. Start the Python preview server before running.
import {chromium, firefox} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.SITE_QA_URL || 'http://127.0.0.1:8770/volparossa-cloud/';
const output = process.env.SITE_QA_OUTPUT || path.join(root, 'qa');
fs.mkdirSync(output, {recursive:true});
const results = {checkedAt:new Date().toISOString(), url:base, responsive:[], accessibility:[], interactions:[]};
async function newPage(browser, options) { const context=await browser.newContext(options); return context.newPage(); }
function assert(value, message) { if(!value) throw Error(message); }
async function inspect(page, label, screenshots = true) {
  const errors=[]; const failed=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400)failed.push(`${response.status()} ${response.url()}`);});
  assert((await page.goto(base,{waitUntil:'networkidle'})).status()===200, 'Page response');
  await page.evaluate(()=>document.fonts.ready);
  const initial=await page.evaluate(()=>({requests:performance.getEntriesByType('resource').map(r=>({url:r.name,bytes:r.transferSize})),bytes:performance.getEntriesByType('resource').reduce((n,r)=>n+r.transferSize,0)}));
  for(const element of await page.locator('main>section').all()) {
    await element.scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    await element.locator('img').evaluateAll(images=>Promise.all(images.filter(i=>i.getClientRects().length).map(i=>i.decode().catch(()=>{}))));
  }
  const geometry=await page.evaluate(()=>({
    width:innerWidth, scroll:document.documentElement.scrollWidth,
    missing:[...document.images].filter(i=>i.getClientRects().length&&(!i.complete||!i.naturalWidth)).map(i=>i.src),
    overlaps:[...document.querySelectorAll('.process-sequence li')].filter(el=>{
      const art=el.querySelector('.process-art').getBoundingClientRect();const h=el.querySelector('h3').getBoundingClientRect();
      const img=el.querySelector('img');const b=img?.getBoundingClientRect();
      return b && (b.bottom>art.bottom+1||b.top<art.top-1||b.left<art.left-1||b.right>art.right+1);
    }).length,
    externalAssets:performance.getEntriesByType('resource').filter(r=>new URL(r.name).origin!==location.origin).map(r=>r.name)
  }));
  assert(geometry.scroll<=geometry.width,`${label}: horizontal overflow`);
  assert(!geometry.missing.length,`${label}: missing visible images ${geometry.missing}`);
  assert(!geometry.overlaps,`${label}: artwork outside its assigned area`);
  assert(!geometry.externalAssets.length,`${label}: external runtime requests`);
  assert(!errors.length&&!failed.length,`${label}: ${[...errors,...failed].join('; ')}`);
  if(screenshots){await page.screenshot({path:path.join(output,`${label}-full.png`),fullPage:true});for(const id of ['top','opencloud','how-it-works','participants','recover','development'])await page.locator('#'+id).screenshot({path:path.join(output,`${label}-${id}.png`)});}
  return {...geometry,initialBytes:initial.bytes,initialRequests:initial.requests.length,errors,failed};
}
const chrome=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--no-sandbox']});
try {
  results.chromiumVersion=chrome.version();
  for(const width of [320,390,768,1440,1920]) {
    const page=await newPage(chrome,{viewport:{width,height:900},reducedMotion:'reduce'});
    const label=`chromium-${width}`;
    results.responsive.push({label,...await inspect(page,label)});
    if([390,1440].includes(width)){
      const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      results.accessibility.push({label,violations:axe.violations});
      assert(!axe.violations.length,`${label}: axe ${axe.violations.map(v=>v.id).join(',')}`);
    }
    assert(await page.locator('[data-play]:visible').count()===0,'Reduced-motion replay controls should be hidden');
    await page.context().close();
  }
  for(const [label,options] of [
    ['no-js',{viewport:{width:390,height:844},javaScriptEnabled:false}],
    ['landscape',{viewport:{width:844,height:390},reducedMotion:'reduce'}],
  ]) {
    const page=await newPage(chrome,options);
    results.responsive.push({label,...await inspect(page,label)});
    if(label==='no-js'){
      await page.locator('.mobile-nav summary').click();
      assert(await page.locator('.mobile-nav').getAttribute('open')!==null,'Native no-JS menu');
      assert(await page.locator('[data-play]:visible').count()===0,'Inert replay control shown without JS');
    }
    await page.context().close();
  }
  const large=await newPage(chrome,{viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await large.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>document.documentElement.style.fontSize='200%'));
  results.responsive.push({label:'text-200-percent',...await inspect(large,'text-200-percent')});await large.context().close();
  const page=await newPage(chrome,{viewport:{width:390,height:844},reducedMotion:'no-preference'});
  await page.goto(base,{waitUntil:'networkidle'});
  await page.keyboard.press('Tab');assert(await page.locator('.skip-link').evaluate(e=>e===document.activeElement),'Skip link first keyboard target');
  await page.keyboard.press('Enter');assert(await page.locator('main').evaluate(e=>e===document.activeElement),'Skip link focuses main');
  await page.locator('.mobile-nav summary').focus();await page.keyboard.press('Enter');assert(await page.locator('.mobile-nav').getAttribute('open')!==null,'Keyboard menu open');
  await page.keyboard.press('Escape');assert(await page.locator('.mobile-nav').getAttribute('open')===null,'Escape closes menu');
  for(const id of ['encrypt-sequence','recover-sequence']){
    const button=page.locator(`[data-play="${id}"]`);await button.scrollIntoViewIfNeeded();await button.click();
    assert(await page.locator('#'+id).evaluate(e=>e.classList.contains('is-playing')),'Replay starts');
    await page.waitForTimeout(3500);assert(await page.locator('#'+id).evaluate(e=>!e.classList.contains('is-playing')),'Replay finishes within five seconds');
    await button.click();await page.locator('.site-footer').scrollIntoViewIfNeeded();await page.waitForTimeout(100);
    assert(await page.locator('#'+id).evaluate(e=>!e.classList.contains('is-playing')),'Offscreen animation stops');
  }
  await page.emulateMedia({reducedMotion:'reduce'});assert(await page.locator('[data-play]:visible').count()===0,'Motion preference changes applied');
  results.interactions.push('Keyboard skip link, menu and Escape; both replays; bounded animation; offscreen cancellation; live reduced-motion change; no-JS native menu');
  await page.context().close();
} finally {await chrome.close();}
const fox=await firefox.launch();
try {
  results.firefoxVersion=fox.version();
  for(const width of [390,1440,1920,2560]){
    const page=await newPage(fox,{viewport:{width,height:1000},reducedMotion:'reduce'});
    results.responsive.push({label:`firefox-${width}`,...await inspect(page,`firefox-${width}`)});await page.context().close();
  }
} finally {await fox.close();}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({responsive:results.responsive.map(({label,width,scroll,initialBytes})=>({label,width,scroll,initialBytes})),accessibility:results.accessibility.map(({label,violations})=>({label,violations:violations.length})),interactions:results.interactions}));
