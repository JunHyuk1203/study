import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../navigation.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('every navigation includes AI between study and school and home has no AI promo',async()=>{
  for(const page of ['index','study','school','play','account','ai']) {
    const html=await readFile(new URL(`../${page}.html`,import.meta.url),'utf8');
    const nav=html.match(/<nav class="bottom-nav"[^>]*>(.*?)<\/nav>/s)?.[1];
    assert.ok(nav,`${page} navigation`);
    assert.deepEqual([...nav.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match=>match[1]),['index.html','study.html','ai.html','school.html','play.html']);
    assert.match(nav,/<a class="nav-ai" href="ai.html"/);
    if(page==='ai')assert.match(nav,/<a class="nav-ai" href="ai.html" aria-current="page"/);
    if(page==='index')assert.doesNotMatch(html.match(/<main\b[^>]*>(.*?)<\/main>/s)?.[1]||'',/href="ai.html"/);
  }
});

function navigationUi({desktop=false}={}) {
  const clicks={},events={},requests=[],animations=[],stages=[],history=[],fallbacks=[];
  let currentPage='index.html';
  const activeClasses=new Set();
  const navClasses=new Set();
  const classList={add:value=>activeClasses.add(value),remove:value=>activeClasses.delete(value)};
  const links=['index.html','study.html','school.html','play.html'].map(href=>({
    getAttribute:name=>name==='href'?href:null,setAttribute(){},removeAttribute(){},
  }));
  function node() {
    return {style:{},classList:{add(){},remove(){}},remove(){this.removed=true;},append(...children){this.children=(this.children||[]).concat(children);},setAttribute(){},querySelector:()=>null,
      getBoundingClientRect:()=>({top:700,bottom:desktop?800:52,right:desktop?184:480}),
      animate(frames) {
        let resolve,reject;
        const animation={frames,cancelled:false,finished:new Promise((yes,no)=>{resolve=yes;reject=no;}),
          finish:()=>resolve(),cancel:()=>{animation.cancelled=true;reject(new Error('cancelled'));}};
        animations.push(animation);return animation;
      }};
  }
  function app(page,live=false) {
    const main={page,scrollTop:0,querySelector:()=>null,getBoundingClientRect:()=>({top:52}),
      replaceWith:next=>{currentPage=next.page;liveMain=next;}};
    const nav={...node(),classList:{add:value=>navClasses.add(value),remove:value=>navClasses.delete(value)},querySelectorAll:()=>links,querySelector:()=>page==='account.html'?null:({getAttribute:()=>page})};
    const header=node();
    return {querySelector:selector=>selector==='main'?(live?liveMain:main):selector==='.bottom-nav'?nav:selector==='.header'?header:null,
      cloneNode:()=>app(page)};
  }
  let liveMain={page:'index.html',scrollTop:0,getBoundingClientRect:()=>({top:52}),replaceWith:next=>{currentPage=next.page;liveMain=next;}};
  const currentApp=app('index.html',true);
  const location={href:'http://localhost/index.html',assign:href=>fallbacks.push(href),reload:()=>fallbacks.push('reload')};
  const context=vm.createContext({URL,AbortController,Event,
    document:{querySelector:()=>currentApp,documentElement:{classList},body:{append:stage=>stages.push(stage)},
      createElement:()=>node(),addEventListener:(name,handler)=>{clicks[name]=handler;}},
    window:{location,innerHeight:800,matchMedia:query=>({matches:desktop&&query==='(min-width: 768px)'}),scrollTo(){},dispatchEvent(){},
      history:{pushState:(_state,_title,href)=>{history.push(href);location.href=href;}},
      addEventListener:(name,handler)=>{events[name]=handler;}},
    fetch:(href,options)=>new Promise(resolve=>requests.push({href,signal:options.signal,
      resolve:()=>resolve({ok:true,text:async()=>new URL(href).pathname.slice(1)})})),
    DOMParser:class {parseFromString(page){const next=app(page);return {title:page,querySelector:()=>next};}},
  });
  vm.runInContext(source,context);
  return {requests,animations,stages,history,fallbacks,activeClasses,navClasses,location,events,page:()=>currentPage,main:()=>liveMain,
    click(page) {
      clicks.click({button:0,preventDefault(){},target:{closest:()=>({href:`http://localhost/${page}`,hasAttribute:()=>false})}});
    },
  };
}

test('page transitions preserve the outgoing inner scroll and reset the destination',async()=>{
  const ui=navigationUi();ui.main().scrollTop=320;
  ui.click('study.html');ui.requests[0].resolve();await settle();
  const outgoing=ui.stages[0].children[0].children[0].querySelector('main');
  assert.equal(outgoing.scrollTop,320);
  ui.animations.forEach(animation=>animation.finish());await settle();
  assert.equal(ui.main().scrollTop,0);assert.deepEqual(ui.fallbacks,[]);
});

test('desktop transitions start at the viewport top beside the fixed sidebar',async()=>{
  const ui=navigationUi({desktop:true});
  ui.click('account.html');ui.requests[0].resolve();await settle();
  assert.equal(ui.stages[0].style.top,'0px');
  assert.equal(ui.stages[0].style.left,'184px');
  assert.equal(ui.stages[0].style.bottom,'0px');
  ui.animations.forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'account.html');assert.deepEqual(ui.fallbacks,[]);
});

test('a new tab aborts pending loading and ignores a late obsolete response',async()=>{
  const ui=navigationUi();
  ui.click('study.html');ui.click('school.html');ui.click('school.html');
  assert.equal(ui.requests.length,2);assert.equal(ui.requests[0].signal.aborted,true);
  ui.requests[1].resolve();await settle();
  ui.requests[0].resolve();await settle();
  assert.equal(ui.animations.length,2);
  ui.animations.forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'school.html');assert.deepEqual(ui.history,['http://localhost/school.html']);
  assert.deepEqual(ui.fallbacks,[]);
});

test('interrupting a slide uses its visible destination for the next direction',async()=>{
  const ui=navigationUi();
  ui.click('school.html');ui.requests[0].resolve();await settle();
  assert.equal(ui.animations[1].frames[0].transform,'translateX(100%)');
  ui.click('study.html');
  assert.equal(ui.page(),'school.html');assert.equal(ui.stages[0].removed,true);
  assert.equal(ui.animations[0].cancelled,true);
  ui.requests[1].resolve();await settle();
  assert.equal(ui.animations[3].frames[0].transform,'translateX(-100%)');
  assert.equal(ui.activeClasses.has('tab-navigation-active'),true);
  ui.click('play.html');ui.requests[2].resolve();await settle();
  assert.equal(ui.page(),'study.html');
  assert.equal(ui.animations[5].frames[0].transform,'translateX(100%)');
  ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'play.html');assert.deepEqual(ui.history,['http://localhost/play.html']);
  assert.deepEqual(ui.fallbacks,[]);assert.equal(ui.activeClasses.size,0);
});

test('the current tab can cancel loading and browser back can interrupt a slide',async()=>{
  const ui=navigationUi();
  ui.click('school.html');ui.click('index.html');
  assert.equal(ui.requests[0].signal.aborted,true);assert.equal(ui.page(),'index.html');
  ui.requests[0].resolve();await settle();assert.equal(ui.animations.length,0);
  ui.click('account.html');ui.requests[1].resolve();await settle();
  ui.events.popstate();ui.requests[2].resolve();await settle();
  ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'index.html');assert.deepEqual(ui.history,[]);assert.deepEqual(ui.fallbacks,[]);
});

test('returning from account reveals the selected tab in place on mobile and desktop',async()=>{
  for(const desktop of [false,true]) {
    const ui=navigationUi({desktop});
    ui.click('account.html');ui.requests[0].resolve();await settle();
    assert.equal(ui.navClasses.has('selection-reveal'),false);
    ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
    ui.click('school.html');ui.requests[1].resolve();await settle();
    assert.equal(ui.navClasses.has('selection-reveal'),true);
    ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
    assert.equal(ui.page(),'school.html');
    ui.click('study.html');ui.requests[2].resolve();await settle();
    assert.equal(ui.navClasses.has('selection-reveal'),false);
    ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
    assert.deepEqual(ui.fallbacks,[]);
  }
});

test('the account opens vertically and returns downward while AI remains a separate route',async()=>{
  const ui=navigationUi();
  ui.click('account.html');ui.requests[0].resolve();await settle();
  assert.equal(ui.animations[1].frames[0].transform,'translateY(100%)');
  ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'account.html');
  ui.click('index.html');ui.requests[1].resolve();await settle();
  assert.equal(ui.animations[2].frames[1].transform,'translateY(100%)');
  ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'index.html');
  ui.click('account.html');ui.requests[2].resolve();await settle();
  ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
  ui.click('ai.html');assert.equal(ui.requests.length,4);
  ui.requests[3].resolve();await settle();
  assert.equal(ui.animations[7].frames[0].transform,'translateY(100%)');
  ui.animations.slice(-2).forEach(animation=>animation.finish());await settle();
  assert.equal(ui.page(),'ai.html');assert.deepEqual(ui.fallbacks,[]);
});
