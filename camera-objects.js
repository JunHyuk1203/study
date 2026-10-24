// Pinned COCO-SSD output layout: scores [1,N,90], boxes [1,N,1,4].
// Decode each class independently: a high person score must not hide a phone.
const CLASSES=[['cell phone',76,0],['book',83,.55],['laptop',72,.55]];
function overlap(a,b){
  const area=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*
    Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
  return area/Math.max(.000001,a[2]*a[3]+b[2]*b[3]-area);
}
export function decodeStudyObjects(scores,boxes,width,height){
  const result=[];
  for(const [name,index,minimum] of CLASSES){
    const candidates=[];
    for(let i=0;i<boxes.length/4;i++){
      const score=scores[i*90+index];
      if(!Number.isFinite(score)||score<minimum)continue;
      const [top,left,bottom,right]=Array.from(boxes.slice(i*4,i*4+4));
      const bbox=[left*width,top*height,(right-left)*width,(bottom-top)*height];
      if(bbox.every(Number.isFinite)&&bbox[2]>0&&bbox[3]>0)candidates.push({class:name,score,bbox});
    }
    candidates.sort((a,b)=>b.score-a.score);
    const selected=[];
    for(const candidate of candidates){
      if(selected.every(item=>overlap(item.bbox,candidate.bbox)<.45))selected.push(candidate);
      if(selected.length>=5)break;
    }
    result.push(...selected);
  }
  return result;
}
export async function createStudyObjectDetector(tf,{base='mobilenet_v2'}={}){
  const prefix=base==='lite_mobilenet_v2'?'ssdlite_mobilenet_v2':'ssd_mobilenet_v2';
  const model=await tf.loadGraphModel(`https://storage.googleapis.com/tfjs-models/savedmodel/${prefix}/model.json`);
  return {
    async detect(image){
      const input=tf.tidy(()=>tf.browser.fromPixels(image).expandDims(0));
      let output;
      try{
        output=await model.executeAsync(input);
        const [scores,boxes]=await Promise.all(output.map(tensor=>tensor.data()));
        return decodeStudyObjects(scores,boxes,image.width,image.height);
      }finally{input.dispose();if(output)tf.dispose(output);}
    },
    dispose(){model.dispose();},
  };
}
