import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../social-dialog.js',import.meta.url),'utf8')).replace(/^export /gm,'');
function setup() {
  const classes=new Set(),properties={},events=[];
  let finish;
  const animation={finished:new Promise(resolve=>{finish=resolve;})};
  const trigger={getBoundingClientRect:()=>({left:20,top:500,width:200,height:80})};
  const dialog={open:false,style:{setProperty:(key,value)=>{properties[key]=value;}},
    classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)},
    closest:()=>({hidden:false}),getBoundingClientRect:()=>({left:100,top:100,width:600,height:500}),
    showModal(){this.open=true;},close(){this.open=false;},getAnimations:()=>[animation]};
  const context=vm.createContext({dialog,trigger,Promise,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    window:{dispatchEvent:event=>events.push(event)},document:{addEventListener(){},querySelector:()=>dialog,querySelectorAll:()=>[]}});
  vm.runInContext(source,context);return {context,dialog,properties,events,finish,classes};
}
test('panels expand from the clicked button and notify lazy content after native modal opens',()=>{
  const {context,dialog,properties,events}=setup();
  vm.runInContext("openSocialPanel('report',trigger)",context);
  assert.equal(dialog.open,true);assert.equal(properties['--social-from-x'],'-280px');assert.equal(properties['--social-from-y'],'190px');
  assert.equal(events[0].type,'study:panel-opened');assert.equal(events[0].detail.kind,'report');
});
test('closing keeps the native modal open until its return animation finishes',async()=>{
  const {context,dialog,finish,classes}=setup();dialog.open=true;
  const closing=vm.runInContext('closeSocialPanel(dialog)',context);
  assert.equal(dialog.open,true);assert.equal(classes.has('is-closing'),true);
  finish();await closing;assert.equal(dialog.open,false);assert.equal(classes.has('is-closing'),false);
});
